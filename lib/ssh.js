/**
 * SSH transport layer for the DSH "remote-ssh" plugin.
 *
 * Pure Node + `ssh2`: no UI, no Cordis, no DSH imports. Every export is async
 * and concurrency-safe (no module-level mutable state). Ordinary network,
 * authentication and remote-command failures are returned as `{ ok: false }`
 * values; only programmer errors (missing/malformed fields) throw a TypeError.
 *
 * @typedef {object} Target
 * @property {string} host              hostname or IP address of the target
 * @property {number} [port=22]         TCP port
 * @property {string} username          SSH user name
 * @property {PasswordAuth | PrivateKeyAuth} auth
 * @property {Target} [jump]            first hop: `host` is reached from inside this connection
 *
 * @typedef {object} PasswordAuth
 * @property {'password'} kind
 * @property {string} password
 *
 * @typedef {object} PrivateKeyAuth
 * @property {'privateKey'} kind
 * @property {string} privateKey        PEM/OpenSSH key material
 * @property {string} [passphrase]
 *
 * @typedef {object} SshErrorInfo
 * @property {string} code
 * @property {string} message
 * @property {'jump' | 'connect' | 'auth' | 'exec' | 'timeout' | 'sftp' | 'local'} stage
 */

import { Client } from 'ssh2';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PORT = 22;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 10_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

/** ssh2 `err.level` -> reported stage, and -> a friendlier code. */
const STAGE_BY_LEVEL = {
  'client-authentication': 'auth',
  'client-timeout': 'timeout',
  'client-socket': 'connect',
  'client-dns': 'connect',
};
const CODE_BY_LEVEL = {
  'client-authentication': 'authentication_failed',
  'client-timeout': 'timeout',
  'client-dns': 'dns_failed',
};

/** Carries a prepared error info object through a rejection. */
class OperationStop {
  /** @param {SshErrorInfo} info */
  constructor(info) {
    this.info = info;
  }
}

const isString = (value) => typeof value === 'string' && value.length > 0;

function requireString(value, name) {
  if (!isString(value)) throw new TypeError(`${name} must be a non-empty string`);
}

function assertTarget(target) {
  if (target === null || typeof target !== 'object') throw new TypeError('target must be an object');
  requireString(target.host, 'target.host');
  requireString(target.username, 'target.username');
  if (target.port !== undefined && !Number.isInteger(target.port)) {
    throw new TypeError('target.port must be an integer');
  }
  const { auth } = target;
  if (!auth || typeof auth !== 'object') throw new TypeError('target.auth is required');
  if (auth.kind === 'password') {
    if (typeof auth.password !== 'string') throw new TypeError('target.auth.password must be a string');
  } else if (auth.kind === 'privateKey') {
    if (typeof auth.privateKey !== 'string') throw new TypeError('target.auth.privateKey must be a string');
    if (auth.passphrase !== undefined && typeof auth.passphrase !== 'string') {
      throw new TypeError('target.auth.passphrase must be a string when given');
    }
  } else {
    throw new TypeError("target.auth.kind must be 'password' or 'privateKey'");
  }
  // A jump host may carry its own `jump`; it is validated but never followed
  // (see openSession), so a stale third level cannot break a call.
  if (target.jump !== undefined && target.jump !== null) assertTarget(target.jump);
}

function normalizeTimeout(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('options.timeoutMs must be a positive number');
  }
  return value;
}

function normalizeMaxOutputBytes(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_OUTPUT_BYTES;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('options.maxOutputBytes must be a positive number');
  }
  return value;
}

/** POSIX single-quote quoting; safe for busybox ash and bash alike. */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

const hostLabel = (target) => `${target.host}:${target.port ?? DEFAULT_PORT}`;

/** ssh2/Node error -> `{ code, message, stage }`. */
function toErrorInfo(err, fallbackStage = 'connect') {
  const source = err && typeof err === 'object' ? err : { message: String(err) };
  const { level } = source;
  const stage = STAGE_BY_LEVEL[level] || source.stage || fallbackStage;
  const code = CODE_BY_LEVEL[level]
    || (typeof source.code === 'string' && source.code)
    || (stage === 'timeout' ? 'timeout' : 'error');
  return {
    code,
    message: isString(source.message) ? source.message : String(err),
    stage,
  };
}

/** Auth object -> the field set `ssh2.Client#connect` expects. */
function authFields(auth) {
  if (auth.kind === 'password') return { password: auth.password };
  const fields = { privateKey: auth.privateKey };
  if (auth.passphrase !== undefined) fields.passphrase = auth.passphrase;
  return fields;
}

function buildConfig(target, { sock, timeoutMs }) {
  const config = {
    host: target.host,
    port: target.port ?? DEFAULT_PORT,
    username: target.username,
    // Host-key pinning is intentionally NOT implemented in this version: the
    // plugin README documents that known_hosts verification is out of scope,
    // so every host key is accepted.
    hostVerifier: () => true,
    readyTimeout: Math.min(MAX_READY_TIMEOUT_MS, Math.max(1, timeoutMs)),
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    ...authFields(target.auth),
  };
  if (sock) config.sock = sock;
  return config;
}

/**
 * Per-call abort/timeout controller covering the WHOLE operation. Its timer is
 * unref'd; `onStop` listeners let each stage tear down its own resources as
 * soon as the deadline or an AbortSignal fires.
 */
function createGuard({ timeoutMs, signal }) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  /** @type {SshErrorInfo | null} */
  let error = null;
  let timer = null;
  let notifyStopped;
  const stopped = new Promise((resolve) => { notifyStopped = resolve; });
  const listeners = new Set();

  const stop = (info) => {
    if (error) return;
    error = info;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    notifyStopped(info);
    for (const listener of listeners) {
      try {
        listener(info);
      } catch {
        // A failing listener must not hide the stop itself.
      }
    }
    listeners.clear();
  };

  timer = setTimeout(() => stop({
    code: 'timeout',
    message: `operation timed out after ${timeoutMs} ms`,
    stage: 'timeout',
  }), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const onAbort = () => stop({
    code: 'aborted',
    message: 'operation aborted by caller',
    stage: 'exec',
  });
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    startedAt,
    timeoutMs,
    get error() {
      return error;
    },
    /** Registers a teardown callback; fires immediately when already stopped. */
    onStop(listener) {
      if (error) {
        listener(error);
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Races a stage promise against the deadline / abort signal. */
    step(promise) {
      return Promise.race([
        promise,
        stopped.then((info) => { throw new OperationStop(info); }),
      ]);
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
      listeners.clear();
    },
  };
}

/** Collects stdout/stderr, stopping at `maxOutputBytes` per stream. */
function createSink(maxOutputBytes) {
  const chunks = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let truncated = false;

  const push = (name, chunk) => {
    if (!chunk || chunk.length === 0) return;
    const room = maxOutputBytes - sizes[name];
    if (room <= 0) {
      truncated = true;
      return;
    }
    if (chunk.length > room) {
      chunks[name].push(chunk.subarray(0, room));
      sizes[name] += room;
      truncated = true;
      return;
    }
    chunks[name].push(chunk);
    sizes[name] += chunk.length;
  };

  return {
    push,
    stdout: () => Buffer.concat(chunks.stdout).toString('utf8'),
    stderr: () => Buffer.concat(chunks.stderr).toString('utf8'),
    truncated: () => truncated,
  };
}

function failureResult(info, sink, startedAt) {
  return {
    ok: false,
    error: {
      code: String(info.code ?? 'error'),
      message: String(info.message ?? 'unknown error'),
      stage: String(info.stage ?? 'connect'),
    },
    stdout: sink ? sink.stdout() : '',
    stderr: sink ? sink.stderr() : '',
    exitCode: null,
    signal: null,
    truncated: sink ? sink.truncated() : false,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Opens one ssh2 connection. Rejects (never throws) with an OperationStop.
 * The 'error' listener stays attached for the connection's whole life so ssh2
 * errors can never surface as unhandled 'error' events, not even after ready.
 */
function connectClient(target, guard, { sock, stage = 'connect', forceStage, label, onBanner } = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let offStop = () => {};

    const fail = (err) => {
      if (settled) return;
      settled = true;
      offStop();
      let info = err instanceof OperationStop ? err.info : toErrorInfo(err, stage);
      if (forceStage && info.stage !== 'timeout' && info.stage !== 'aborted') {
        info = { ...info, stage: forceStage };
      }
      if (label && info.stage === forceStage) {
        info = { ...info, message: `${label}: ${info.message}` };
      }
      try {
        client.destroy();
      } catch {
        // Handshake already failed.
      }
      reject(new OperationStop(info));
    };

    client.on('error', fail);
    client.once('ready', () => {
      if (settled) return;
      settled = true;
      offStop();
      resolve(client);
    });
    if (typeof onBanner === 'function') {
      client.on('banner', (message) => {
        try {
          onBanner(message);
        } catch {
          // Banner collection is informational only.
        }
      });
    }

    offStop = guard.onStop((info) => fail(new OperationStop(info)));
    if (settled) return; // already aborted before connecting
    try {
      client.connect(buildConfig(target, { sock, timeoutMs: guard.timeoutMs }));
    } catch (err) {
      fail(err);
    }
  });
}

/** Opens a TCP channel to the real target from inside the jump connection. */
function forwardOut(jumpClient, jumpTarget, target) {
  const jumpLabel = hostLabel(jumpTarget);
  const dstPort = target.port ?? DEFAULT_PORT;
  return new Promise((resolve, reject) => {
    jumpClient.forwardOut('127.0.0.1', 0, target.host, dstPort, (err, stream) => {
      if (err) {
        reject(new OperationStop({
          code: typeof err.code === 'string' ? err.code : 'jump_forward_failed',
          stage: 'jump',
          message: `jump host ${jumpLabel}: unable to reach ${target.host}:${dstPort} from the jump host: ${err.message}`,
        }));
        return;
      }
      // The forwarded channel doubles as the second connection's socket; it is
      // torn down by closeSession, and read errors during that teardown must
      // not become unhandled 'error' events.
      stream.on('error', () => {});
      resolve(stream);
    });
  });
}

/**
 * Opens a session to `target`, optionally through `target.jump`. Only ONE hop
 * is supported: a jump host's own `jump` is ignored rather than chained, so a
 * mistyped chain cannot silently reach an unintended third host.
 */
async function openSession(target, guard, { onBanner } = {}) {
  let jumpClient = null;
  let jumpSock = null;
  let client = null;
  try {
    if (target.jump) {
      jumpClient = await connectClient(target.jump, guard, {
        stage: 'jump',
        forceStage: 'jump',
        label: `jump host ${hostLabel(target.jump)}`,
        onBanner,
      });
      jumpSock = await guard.step(forwardOut(jumpClient, target.jump, target));
    }
    client = await connectClient(target, guard, { sock: jumpSock ?? undefined, stage: 'connect', onBanner });
    return { ok: true, client, jumpClient, jumpSock };
  } catch (err) {
    closeSession({ client, jumpClient, jumpSock });
    return { ok: false, error: err instanceof OperationStop ? err.info : toErrorInfo(err) };
  }
}

/** Best-effort teardown of every socket/connection a session owns. */
function closeSession(session) {
  if (!session) return;
  for (const member of ['client', 'jumpSock', 'jumpClient']) {
    const handle = session[member];
    if (!handle) continue;
    try {
      // end() is graceful; destroy() guarantees the handle is released even
      // when the peer never answers the disconnect message.
      if (member !== 'jumpSock') handle.end();
      handle.destroy();
    } catch {
      // Already closed or destroyed.
    }
  }
}

/**
 * Runs `command` in the remote shell of `client`.
 * @returns {Promise<{exitCode: number | null, signal: string | null}>}
 */
function runCommand(client, command, { guard, sink, env }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let channel = null;
    let offStop = () => {};
    /** @type {((err: Error) => void) | null} */
    let onClientError = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      offStop();
      if (onClientError) {
        try {
          client.removeListener('error', onClientError);
        } catch {
          // Connection already gone.
        }
      }
      if (err) reject(err instanceof OperationStop ? err : new OperationStop(toErrorInfo(err, 'exec')));
      else resolve(value);
    };

    offStop = guard.onStop((info) => {
      try {
        if (channel) channel.destroy();
        client.destroy();
      } catch {
        // Already torn down.
      }
      finish(new OperationStop(info));
    });

    onClientError = (err) => finish(new OperationStop(toErrorInfo(err, 'exec')));
    client.on('error', onClientError);

    const execOptions = {};
    if (env && typeof env === 'object' && Object.keys(env).length > 0) {
      // ssh2 sends SSH_MSG_CHANNEL_REQUEST "env"; servers that reject env
      // requests (most dropbear builds) silently ignore them.
      execOptions.env = env;
    }

    try {
      client.exec(command, execOptions, (err, stream) => {
        if (err) {
          finish(err);
          return;
        }
        channel = stream;
        let exitCode = null;
        let exitSignal = null;

        stream.on('data', (chunk) => sink.push('stdout', chunk));
        // ssh2 delivers extended data (stderr) on `stream.stderr`, not as a
        // 'stderr' event on the channel; it must be drained explicitly.
        if (stream.stderr) {
          stream.stderr.on('data', (chunk) => sink.push('stderr', chunk));
          stream.stderr.on('error', () => {});
        }
        stream.on('exit', (code, signal) => {
          exitCode = typeof code === 'number' ? code : null;
          exitSignal = typeof signal === 'string' ? signal : null;
        });
        stream.on('error', (streamErr) => finish(streamErr));
        // 'exit' normally arrives first; fall back to the close arguments for
        // servers that only report the status on close.
        stream.on('close', (code, signal) => finish(null, {
          exitCode: exitCode ?? (typeof code === 'number' ? code : null),
          signal: exitSignal ?? (typeof signal === 'string' ? signal : null),
        }));
      });
    } catch (err) {
      finish(err);
    }
  });
}

function sftpErrorInfo(err, action) {
  return {
    code: err && err.code !== undefined && err.code !== null ? String(err.code) : 'sftp_failed',
    message: `${action}: ${(err && err.message) || String(err)}`,
    stage: 'sftp',
  };
}

/** Promisifies one SFTP method call, mapping errors onto an OperationStop. */
function sftpCall(sftp, method, args, action) {
  return new Promise((resolve, reject) => {
    const done = (err, value) => (err
      ? reject(new OperationStop(sftpErrorInfo(err, action)))
      : resolve(value));
    try {
      sftp[method](...args, done);
    } catch (err) {
      done(err);
    }
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    try {
      client.sftp((err, sftp) => {
        if (err) {
          reject(new OperationStop({
            code: typeof err.code === 'string' ? err.code : 'sftp_unavailable',
            message: `unable to open the remote SFTP subsystem: ${err.message}`,
            stage: 'sftp',
          }));
          return;
        }
        // SFTPWrapper is an EventEmitter: late errors while the connection is
        // being torn down must not become unhandled 'error' events.
        sftp.on('error', () => {});
        resolve(sftp);
      });
    } catch (err) {
      reject(new OperationStop(sftpErrorInfo(err, 'unable to open the remote SFTP subsystem')));
    }
  });
}

/**
 * Creates the remote POSIX directory chain `dir` recursively. Existing
 * directories, including ones created by a concurrent call, are accepted.
 */
async function ensureRemoteDir(sftp, dir) {
  const absolute = dir.startsWith('/');
  const segments = dir.split('/').filter((segment) => segment && segment !== '.');
  for (let index = 0; index < segments.length; index += 1) {
    const current = `${absolute ? '/' : ''}${segments.slice(0, index + 1).join('/')}`;
    try {
      await sftpCall(sftp, 'stat', [current], `unable to inspect remote directory ${current}`);
    } catch {
      try {
        await sftpCall(sftp, 'mkdir', [current], `unable to create remote directory ${current}`);
      } catch (mkdirErr) {
        // A concurrent creator may have won the race; verify before failing.
        try {
          await sftpCall(sftp, 'stat', [current], `unable to inspect remote directory ${current}`);
        } catch {
          throw mkdirErr;
        }
      }
    }
  }
}

/**
 * ssh2 records the server's identification string on the client after the
 * handshake but does not expose it publicly, so probe reads it defensively.
 */
function readRemoteVersion(client) {
  try {
    return isString(client && client._remoteVer) ? client._remoteVer : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* exports                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Runs `work(client)` on a connected (jump-aware) session, always tearing the
 * session and the guard down afterwards. Resolves `{ failed: true, error }`
 * when the connection itself could not be established.
 */
async function withSession(target, guard, work, { onBanner } = {}) {
  let session = null;
  try {
    if (guard.error) throw new OperationStop(guard.error);
    session = await openSession(target, guard, { onBanner });
    if (!session.ok) return { failed: true, error: session.error };
    return { failed: false, value: await work(session.client) };
  } finally {
    closeSession(session);
    guard.dispose();
  }
}

/** Local read/`mkdir` failures get `stage: 'local'`, not a transport stage. */
async function localFileSize(localPath) {
  try {
    return (await stat(localPath)).size;
  } catch (err) {
    throw new OperationStop({
      code: err && err.code ? String(err.code) : 'local_read_failed',
      message: `unable to read local file ${localPath}: ${err.message}`,
      stage: 'local',
    });
  }
}

async function ensureLocalDir(dir) {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new OperationStop({
      code: err && err.code ? String(err.code) : 'local_mkdir_failed',
      message: `unable to create local directory ${dir}: ${err.message}`,
      stage: 'local',
    });
  }
}

/**
 * Executes a command over a fresh SSH connection (through the jump host when
 * `target.jump` is set). Resolves with the collected output even when the run
 * failed, so a timeout can report the partial output it did receive.
 *
 * @param {Target} target
 * @param {string} command                      shell command to run
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000]   whole-operation deadline
 * @param {string} [options.cwd]                remote directory (shell-quoted `cd ... &&`)
 * @param {number} [options.maxOutputBytes]     per-stream cap (default 1 MiB)
 * @param {AbortSignal} [options.signal]        resolves `code: 'aborted'` when fired
 * @param {Record<string, string>} [options.env] SSH env requests (server may ignore them)
 * @returns {Promise<{ok: true, stdout: string, stderr: string, exitCode: number | null,
 *   signal: string | null, durationMs: number, truncated: boolean}
 *   | {ok: false, error: SshErrorInfo, stdout: string, stderr: string, truncated: boolean,
 *      durationMs: number, exitCode: null, signal: null}>}
 */
export async function execCommand(target, command, options = {}) {
  assertTarget(target);
  if (typeof command !== 'string' || command.trim() === '') {
    throw new TypeError('execCommand: command must be a non-empty string');
  }
  const guard = createGuard({ timeoutMs: normalizeTimeout(options.timeoutMs), signal: options.signal });
  const sink = createSink(normalizeMaxOutputBytes(options.maxOutputBytes));
  const fullCommand = options.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command;

  try {
    const outcome = await withSession(target, guard, async (client) => {
      const exit = await runCommand(client, fullCommand, { guard, sink, env: options.env });
      return { exitCode: exit.exitCode, signal: exit.signal };
    });
    if (outcome.failed) return failureResult(outcome.error, sink, guard.startedAt);
    return {
      ok: true,
      stdout: sink.stdout(),
      stderr: sink.stderr(),
      ...outcome.value,
      durationMs: Date.now() - guard.startedAt,
      truncated: sink.truncated(),
    };
  } catch (err) {
    const info = err instanceof OperationStop ? err.info : toErrorInfo(err, 'exec');
    return failureResult(info, sink, guard.startedAt);
  }
}

/**
 * Uploads a local file to a remote path over SFTP.
 *
 * @param {Target} target
 * @param {string} localPath
 * @param {string} remotePath                   POSIX path on the remote host
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000]
 * @param {boolean} [options.createDirs=true]   create the remote parent chain
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: true, bytes: number, remotePath: string}
 *   | {ok: false, error: SshErrorInfo}>}
 */
export async function uploadFile(target, localPath, remotePath, options = {}) {
  assertTarget(target);
  requireString(localPath, 'uploadFile: localPath');
  requireString(remotePath, 'uploadFile: remotePath');
  const guard = createGuard({ timeoutMs: normalizeTimeout(options.timeoutMs), signal: options.signal });

  try {
    const localSize = await localFileSize(localPath);
    const outcome = await withSession(target, guard, async (client) => {
      const sftp = await guard.step(openSftp(client));
      if (options.createDirs !== false) {
        await guard.step(ensureRemoteDir(sftp, path.posix.dirname(remotePath)));
      }
      await guard.step(sftpCall(sftp, 'fastPut', [localPath, remotePath], `upload to ${remotePath}`));
      return { ok: true, bytes: localSize, remotePath };
    });
    return outcome.failed ? { ok: false, error: outcome.error } : outcome.value;
  } catch (err) {
    return { ok: false, error: err instanceof OperationStop ? err.info : toErrorInfo(err, 'sftp') };
  }
}

/**
 * Downloads a remote file to a local path over SFTP (`fastGet`).
 *
 * @param {Target} target
 * @param {string} remotePath                   POSIX path on the remote host
 * @param {string} localPath
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000]
 * @param {boolean} [options.createDirs=true]   create the local parent directory
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: true, bytes: number, localPath: string}
 *   | {ok: false, error: SshErrorInfo}>}
 */
export async function downloadFile(target, remotePath, localPath, options = {}) {
  assertTarget(target);
  requireString(remotePath, 'downloadFile: remotePath');
  requireString(localPath, 'downloadFile: localPath');
  const guard = createGuard({ timeoutMs: normalizeTimeout(options.timeoutMs), signal: options.signal });

  try {
    const outcome = await withSession(target, guard, async (client) => {
      const sftp = await guard.step(openSftp(client));
      if (options.createDirs !== false) await guard.step(ensureLocalDir(path.dirname(localPath)));
      await guard.step(sftpCall(sftp, 'fastGet', [remotePath, localPath], `download of ${remotePath}`));
      return { ok: true, bytes: (await stat(localPath)).size, localPath };
    });
    return outcome.failed ? { ok: false, error: outcome.error } : outcome.value;
  } catch (err) {
    return { ok: false, error: err instanceof OperationStop ? err.info : toErrorInfo(err, 'sftp') };
  }
}

/**
 * Connects through the normal (jump-aware) path and reports reachability.
 *
 * `banner` is the SSH identification string reported by the server (for
 * example `OpenSSH_9.2p1`); a userauth banner message, when the server sends
 * one, takes precedence. `uname` is `null` when the remote shell cannot run
 * `uname -a` (non-unix targets), which is not an error.
 *
 * @param {Target} target
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: true, latencyMs: number, banner: string | null, uname: string | null}
 *   | {ok: false, error: SshErrorInfo}>}
 */
export async function probe(target, options = {}) {
  assertTarget(target);
  const guard = createGuard({ timeoutMs: normalizeTimeout(options.timeoutMs), signal: options.signal });
  const banners = [];

  try {
    const outcome = await withSession(target, guard, async (client) => {
      const latencyMs = Date.now() - guard.startedAt;
      const banner = banners.length > 0 ? banners.join('\n') : readRemoteVersion(client);
      let uname = null;
      const sink = createSink(PROBE_OUTPUT_LIMIT);
      try {
        const exit = await runCommand(client, 'uname -a', { guard, sink });
        if (exit.exitCode === 0) uname = sink.stdout().trim() || null;
      } catch (err) {
        // A timeout/abort is a real failure; any other exec error (e.g. an
        // unknown command on a non-unix target) still means the host answered.
        if (err instanceof OperationStop
          && (err.info.stage === 'timeout' || err.info.code === 'aborted')) {
          throw err;
        }
        uname = null;
      }
      return { ok: true, latencyMs, banner, uname };
    }, { onBanner: (message) => banners.push(message) });
    return outcome.failed ? { ok: false, error: outcome.error } : outcome.value;
  } catch (err) {
    return { ok: false, error: err instanceof OperationStop ? err.info : toErrorInfo(err) };
  }
}
