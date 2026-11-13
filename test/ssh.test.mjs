/**
 * End-to-end tests for lib/ssh.js against a real SSH host.
 *
 * Run with:
 *
 *   RSSH_TEST_HOST=192.0.2.1 RSSH_TEST_USER=root RSSH_TEST_PASSWORD=secret node test/ssh.test.mjs
 *
 * Optional: RSSH_TEST_PORT (default 22) and RSSH_TEST_JUMP_HOST — a second
 * address reached only THROUGH the first one, used for the jump-host case
 * (defaults to 127.0.0.1, which is the first host's own loopback and therefore
 * reachable only from inside it).
 *
 * The target is read from the environment so no credential is stored in this
 * repository. Prints one PASS/FAIL line per case, a final `N/M passed` summary,
 * and exits non-zero when any case fails. Local scratch files live in a temp
 * directory under os.tmpdir() which the script creates and removes itself.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadFile, execCommand, probe, uploadFile } from '../lib/ssh.js';

const HOST = process.env.RSSH_TEST_HOST ?? '';
const PASSWORD = process.env.RSSH_TEST_PASSWORD ?? '';

if (HOST === '' || PASSWORD === '') {
  console.error(
    'Set RSSH_TEST_HOST, RSSH_TEST_USER and RSSH_TEST_PASSWORD (optionally RSSH_TEST_PORT, RSSH_TEST_JUMP_HOST) before running this file.',
  );
  process.exit(2);
}

const ROUTER = {
  host: HOST,
  port: Number(process.env.RSSH_TEST_PORT ?? 22),
  username: process.env.RSSH_TEST_USER ?? 'root',
  auth: { kind: 'password', password: PASSWORD },
};

/** Address reached only through ROUTER, for the jump-host case. */
const JUMP_TARGET_HOST = process.env.RSSH_TEST_JUMP_HOST ?? '127.0.0.1';

const results = [];
const startedAt = Date.now();
let tmpDir = null;
let remoteTestFile = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function describe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function test(name, fn) {
  const caseStarted = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - caseStarted });
    console.log(`PASS  ${name} (${Date.now() - caseStarted} ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - caseStarted, error: err });
    const detail = err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : String(err);
    console.log(`FAIL  ${name} (${Date.now() - caseStarted} ms)\n        ${detail}`);
  }
}

async function main() {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'dsh-ssh-test-'));
  console.log(`# target ${ROUTER.host}:${ROUTER.port}  temp ${tmpDir}\n`);

  await test('1. probe succeeds and reports a latency', async () => {
    const res = await probe(ROUTER, { timeoutMs: 20000 });
    assert(res.ok, `probe failed: ${describe(res.error)}`);
    assert(typeof res.latencyMs === 'number' && res.latencyMs >= 0, 'latencyMs is missing');
    assert(res.banner === null || typeof res.banner === 'string', 'banner has an unexpected type');
    console.log(`        latency=${res.latencyMs}ms banner=${res.banner} uname=${res.uname}`);
  });

  await test("2. execCommand 'echo hello' returns hello with exitCode 0", async () => {
    const res = await execCommand(ROUTER, 'echo hello', { timeoutMs: 20000 });
    assert(res.ok, `exec failed: ${describe(res.error)}`);
    assert(res.stdout.trim() === 'hello', `unexpected stdout: ${describe(res.stdout)}`);
    assert(res.exitCode === 0, `unexpected exitCode: ${res.exitCode}`);
  });

  await test('3. failing command yields non-zero exitCode and stderr', async () => {
    const res = await execCommand(ROUTER, 'ls /definitely-not-here', { timeoutMs: 20000 });
    assert(res.ok, `transport failed instead of the command: ${describe(res.error)}`);
    assert(typeof res.exitCode === 'number' && res.exitCode !== 0,
      `expected non-zero exitCode, got ${res.exitCode}`);
    assert(res.stderr.trim().length > 0, 'expected non-empty stderr');
  });

  await test("4. cwd '/tmp' makes pwd print /tmp", async () => {
    const res = await execCommand(ROUTER, 'pwd', { cwd: '/tmp', timeoutMs: 20000 });
    assert(res.ok, `exec failed: ${describe(res.error)}`);
    assert(res.stdout.trim() === '/tmp', `unexpected pwd output: ${describe(res.stdout)}`);
  });

  await test('5. timeoutMs(1500) vs sleep 30 resolves as timeout without hanging', async () => {
    const caseStarted = Date.now();
    const res = await execCommand(ROUTER, 'sleep 30', { timeoutMs: 1500 });
    const elapsed = Date.now() - caseStarted;
    assert(!res.ok, 'expected a timeout failure, got success');
    assert(res.error && res.error.stage === 'timeout',
      `expected stage 'timeout', got ${describe(res.error)}`);
    assert(elapsed < 10000, `took ${elapsed} ms: the timeout did not cut the command short`);
  });

  await test('6. upload -> cat -> download round trip, then delete remote file', async () => {
    const content = `dsh ssh test ${new Date().toISOString()}\nline two\n`;
    const localSource = path.join(tmpDir, 'upload-source.txt');
    const localDownload = path.join(tmpDir, 'downloaded.txt');
    remoteTestFile = '/tmp/dsh-ssh-test.txt';
    await writeFile(localSource, content, 'utf8');

    const up = await uploadFile(ROUTER, localSource, remoteTestFile, { timeoutMs: 30000 });
    assert(up.ok, `upload failed: ${describe(up.error)}`);
    assert(up.bytes === Buffer.byteLength(content), `unexpected uploaded bytes: ${up.bytes}`);
    assert(up.remotePath === remoteTestFile, 'upload did not echo remotePath');

    const cat = await execCommand(ROUTER, 'cat /tmp/dsh-ssh-test.txt', { timeoutMs: 20000 });
    assert(cat.ok, `cat failed: ${describe(cat.error)}`);
    assert(cat.stdout === content, `remote content mismatch: ${describe(cat.stdout)}`);

    const down = await downloadFile(ROUTER, remoteTestFile, localDownload, { timeoutMs: 30000 });
    assert(down.ok, `download failed: ${describe(down.error)}`);
    assert(down.bytes === Buffer.byteLength(content), `unexpected downloaded bytes: ${down.bytes}`);
    const downloaded = await readFile(localDownload, 'utf8');
    assert(downloaded === content, `local content mismatch: ${describe(downloaded)}`);

    const del = await execCommand(ROUTER, 'rm -f /tmp/dsh-ssh-test.txt', { timeoutMs: 20000 });
    assert(del.ok && del.exitCode === 0, `delete failed: ${describe(del)}`);
    remoteTestFile = null;
  });

  await test(`7. jump-host chain (${HOST} -> ${JUMP_TARGET_HOST}:22 -> shell) runs the command`, async () => {
    // The module forwards from inside the jump connection to `target.host`, so
    // the target is addressed as loopback of the jump host by default.
    const target = {
      host: JUMP_TARGET_HOST,
      port: 22,
      username: ROUTER.username,
      auth: ROUTER.auth,
      jump: ROUTER,
    };
    const res = await execCommand(target, 'echo jumped', { timeoutMs: 30000 });
    assert(res.ok, `jump chain failed: ${describe(res.error)}`);
    assert(res.stdout.trim() === 'jumped', `unexpected stdout: ${describe(res.stdout)}`);
  });

  await test('8. downloadFile of a missing remote path fails with a stage, not a hang', async () => {
    const caseStarted = Date.now();
    const res = await downloadFile(
      ROUTER,
      '/tmp/dsh-ssh-definitely-missing-file.txt',
      path.join(tmpDir, 'missing.txt'),
      { timeoutMs: 20000 },
    );
    const elapsed = Date.now() - caseStarted;
    assert(!res.ok, 'expected a failure for a missing remote file');
    assert(res.error && typeof res.error.stage === 'string' && res.error.stage.length > 0,
      `expected an error stage, got ${describe(res.error)}`);
    assert(elapsed < 15000, `took ${elapsed} ms: download did not fail promptly`);
  });
}

async function cleanup() {
  // Best-effort remote cleanup in case test 6 aborted halfway through.
  if (remoteTestFile) {
    try {
      await execCommand(ROUTER, `rm -f ${remoteTestFile}`, { timeoutMs: 10000 });
    } catch {
      // Best effort only.
    }
    remoteTestFile = null;
  }
  if (tmpDir) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort only.
    }
    tmpDir = null;
  }
}

// Hard watchdog: if anything (including the module) leaves the run hanging,
// fail loudly instead of waiting forever. Unref'd, so it never keeps Node alive.
const watchdog = setTimeout(() => {
  console.error(`\nWATCHDOG: test run still active after 180 s, aborting`);
  process.exit(2);
}, 180_000);
if (typeof watchdog.unref === 'function') watchdog.unref();

try {
  await main();
} finally {
  await cleanup();
  clearTimeout(watchdog);
}

const passed = results.filter((result) => result.ok).length;
const total = results.length;
const failed = total - passed;
console.log(`\n${passed}/${total} passed (${Date.now() - startedAt} ms total)`);
for (const result of results) {
  if (!result.ok) console.log(`  failed: ${result.name}`);
}
process.exitCode = failed === 0 ? 0 : 1;
