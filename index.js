/**
 * Remote SSH — host half.
 *
 * What this bundle adds to a Harness profile:
 *
 *   1. a durable catalog of SSH servers the user maintains in Settings,
 *   2. a per-conversation grant that says which of those servers the agent may
 *      touch in that conversation,
 *   3. three model tools — list, execute, transfer — that are visible only
 *      while the conversation still has at least one granted server,
 *   4. one authenticated RPC channel (`/remote-ssh`) the browser halves use to
 *      read and write the same data.
 *
 * The grant is the security boundary. Nothing here relies on the model asking
 * politely: a tool call re-checks the grant for its own session, and a session
 * without a grant sees no tools at all.
 *
 * Persistence is split by sensitivity: addresses and usernames live in
 * `$DSH_HOME/state/dsh-remote-ssh/state.json` (`lib/state.js`), passwords and
 * passphrases live in the Harness credential store (`lib/secrets.js`).
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { createStore, stateDirectory } from './lib/state.js'
import { deleteSecret, expandHome, writeSecret } from './lib/secrets.js'
import { buildTarget, describeAll, describeServer, ServerError } from './lib/targets.js'
import { downloadFile, execCommand, probe, uploadFile } from './lib/ssh.js'

/**
 * Browser RPC channel path.
 *
 * The page posts the Connection request envelope here (`<path>/<endpoint>`), so
 * one prefix route carries every endpoint. It is registered on the Web carrier
 * directly and authenticated with the Connection service's own `admit`, which
 * applies the Host/Origin fence plus the browser credential.
 */
const CHANNEL = '/remote-ssh'

/** Grammar for one endpoint name, matching the transport's own allowlist. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

/** Largest accepted request body, in bytes: this channel carries small JSON. */
const MAX_BODY_BYTES = 1_000_000

/** Longest command or transfer the tools allow, in milliseconds. */
const MAX_TIMEOUT_MS = 600_000

/** Default command timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Characters of stdout or stderr forwarded to the model.
 * The transport already caps a stream at 1 MiB; this is the context budget.
 */
const MODEL_OUTPUT_LIMIT = 12_000

/** Append one diagnostic line to this bundle's own log, never throwing. */
function logDebug(message) {
  try {
    mkdirSync(stateDirectory(), { recursive: true })
    appendFileSync(join(stateDirectory(), 'host.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // A missing or read-only state directory must never break activation.
  }
}

/** Clip one text block for the model, marking the omission explicitly. */
function clip(text, limit = MODEL_OUTPUT_LIMIT) {
  if (typeof text !== 'string' || text.length <= limit) return text ?? ''
  const kept = text.slice(0, limit)
  return `${kept}\n… ${text.length - limit} more characters omitted`
}

/** Build the single text content block a tool result renders. */
function textBlock(lines) {
  return [{ type: 'text', text: lines.filter((line) => line !== undefined && line !== '').join('\n') }]
}

/**
 * One-line identity of a server for tool results.
 * @param view - a described server.
 * @returns `name (user@host:port)`.
 */
function serverLabel(view) {
  return `${view.name} (${view.username}@${view.host}:${view.port})`
}

/** Schema shared by the tools: which server to act on. */
const SERVER_PARAMETER = {
  type: 'string',
  description: 'Server name or id from ssh_servers. Only servers shared with this conversation are accepted.',
}

/** Schema shared by the tools: an optional timeout. */
const TIMEOUT_PARAMETER = {
  type: 'integer',
  description: `Milliseconds before the operation is abandoned. Default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
}

/**
 * Register one tool so it exists only while its session has a granted server.
 *
 * The gate is evaluated per model step, which is what makes a mid-conversation
 * grant change take effect on the very next step in both directions.
 * @param ctx - plugin context.
 * @param definition - tool definition.
 */
function registerGatedTool(ctx, store, definition) {
  ctx.effect(
    () =>
      ctx.tools.register(definition, {
        when: (activation) => store.hasAnyAllowed(activation?.agent?.id),
      }),
    `remote-ssh: ${definition.name}`,
  )
}

/**
 * Resolve the server one tool call may use, enforcing the conversation grant.
 * @param store - the state store.
 * @param sessionId - the calling session.
 * @param reference - server name or id from the call arguments.
 * @returns the granted server record.
 * @throws ServerError when the reference is unknown, ungranted, or nothing is granted.
 */
function requireGrantedServer(store, sessionId, reference) {
  const granted = store.allowedFor(sessionId)
  if (granted.length === 0) {
    throw new ServerError(
      'no-servers',
      'no SSH server is shared with this conversation; the user enables servers from the menu at the top right of the conversation',
    )
  }
  const server = store.findServer(reference)
  const names = store
    .servers()
    .filter((candidate) => granted.includes(candidate.id))
    .map((candidate) => candidate.name)
    .join(', ')
  if (server === undefined) {
    throw new ServerError('unknown-server', `no server matches "${reference}"; shared with this conversation: ${names}`)
  }
  if (!granted.includes(server.id)) {
    throw new ServerError('not-allowed', `server "${server.name}" exists but is not shared with this conversation; shared: ${names}`)
  }
  return server
}

/**
 * Convert a thrown value into a tool result object with a stable code.
 * @param error - the thrown value.
 * @returns `{ ok: false, error }` shaped for the output schema.
 */
function failure(error) {
  const code = error instanceof ServerError ? error.code : typeof error?.code === 'string' ? error.code : 'remote-ssh/failed'
  return { ok: false, error: { code, message: String(error?.message ?? error) } }
}

/**
 * Resolve a local path argument: `~` expansion, then the session's working
 * directory for relative paths.
 * @param ctx - plugin context, for the working-directory service.
 * @param exec - the running tool call.
 * @param input - the path as the model typed it.
 * @returns an absolute local path.
 */
async function resolveLocalPath(ctx, exec, input) {
  const expanded = expandHome(input)
  if (expanded === '') throw new ServerError('bad-request', 'a local path is required')
  if (isAbsolute(expanded)) return expanded
  let base = process.cwd()
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined && exec?.agent !== undefined) {
    try {
      base = await workingDirectory.ensure(exec.agent, exec?.signal)
    } catch {
      // Fall back to the process directory when the session has none.
    }
  }
  return resolve(base, expanded)
}

/**
 * Normalize a timeout argument.
 * @param value - the model-supplied value.
 * @returns a clamped millisecond count.
 */
function normalizeTimeout(value) {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(value)))
}

/** Output definition shared by the three tools: JSON-serializable value, rendered as text. */
const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    if (value !== null && typeof value === 'object' && typeof value.summary === 'string') {
      return textBlock([value.summary])
    }
    return textBlock([JSON.stringify(value, null, 2)])
  },
}

/**
 * The three model tools. Each is registered only while the conversation has a
 * granted server, and each re-checks that grant when it runs.
 * @param ctx - plugin context.
 * @param store - the state store.
 * @param credentialsOf - accessor for the optional credential service.
 */
function registerTools(ctx, store, credentialsOf) {
  registerGatedTool(ctx, store, {
    name: 'ssh_servers',
    description:
      'List the SSH servers shared with this conversation: name, address, user, how it authenticates, and its jump host. Set probe to also connect to each one and report whether it is reachable, with its latency and uname.',
    parameters: {
      type: 'object',
      properties: {
        probe: {
          type: 'boolean',
          description: 'Connect to each listed server and report reachability, latency and uname. Costs one SSH handshake per server. Default false.',
        },
        server: {
          ...SERVER_PARAMETER,
          description: 'Limit the listing, and the probe, to one server by name or id. Omit for every shared server.',
        },
      },
      additionalProperties: false,
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id
      try {
        const granted = store.allowedFor(sessionId)
        if (granted.length === 0) {
          throw new ServerError('no-servers', 'no SSH server is shared with this conversation')
        }
        const wanted = typeof args?.server === 'string' && args.server.trim() !== '' ? args.server.trim() : undefined
        const selected = wanted === undefined ? store.servers().filter((server) => granted.includes(server.id)) : [requireGrantedServer(store, sessionId, wanted)]
        const credentials = credentialsOf()
        const probes = args?.probe === true
        const rows = []
        for (const server of selected) {
          const view = await describeServer(store, credentials, server)
          const row = {
            id: view.id,
            name: view.name,
            address: `${view.username}@${view.host}:${view.port}`,
            auth: view.auth === 'password' ? 'password' : `key (${view.resolvedKeyPath || 'no key found'})`,
            jump: view.jumpName === '' ? null : view.jumpName,
            note: view.note === '' ? null : view.note,
          }
          if (probes) {
            try {
              const target = await buildTarget(store, credentials, server)
              const result = await probe(target, { timeoutMs: 20_000 })
              row.reachable = result.ok === true
              if (result.ok === true) {
                row.latencyMs = result.latencyMs
                row.uname = result.uname ?? null
              } else {
                row.error = result.error?.message ?? 'connection failed'
              }
            } catch (error) {
              row.reachable = false
              row.error = String(error?.message ?? error)
            }
          }
          rows.push(row)
        }
        const lines = [`${rows.length} server${rows.length === 1 ? '' : 's'} shared with this conversation:`]
        for (const row of rows) {
          const parts = [`- ${row.name}: ${row.address}`, `auth: ${row.auth}`]
          if (row.jump !== null) parts.push(`via jump: ${row.jump}`)
          if (row.note !== null) parts.push(row.note)
          if (row.reachable === true) parts.push(`reachable (${row.latencyMs} ms)${row.uname === null ? '' : ` — ${row.uname}`}`)
          else if (row.reachable === false) parts.push(`unreachable: ${row.error}`)
          lines.push(parts.join(' · '))
        }
        return { summary: lines.join('\n'), servers: rows }
      } catch (error) {
        const result = failure(error)
        return { ...result, summary: result.error.message }
      }
    },
  })

  registerGatedTool(ctx, store, {
    name: 'ssh_exec',
    description:
      'Run a shell command on an SSH server shared with this conversation and return its exit code, stdout and stderr. The command runs through the remote shell, so pipes and redirects behave as they do there; use cwd rather than a leading cd.',
    parameters: {
      type: 'object',
      properties: {
        server: SERVER_PARAMETER,
        command: {
          type: 'string',
          description: 'Shell command line to run on the remote host.',
        },
        cwd: {
          type: 'string',
          description: "Directory to run in. Defaults to the remote user's home directory.",
        },
        timeoutMs: TIMEOUT_PARAMETER,
      },
      required: ['server', 'command'],
      additionalProperties: false,
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id
      try {
        const server = requireGrantedServer(store, sessionId, args?.server)
        const command = typeof args?.command === 'string' ? args.command : ''
        if (command.trim() === '') throw new ServerError('bad-request', 'command must not be empty')
        const target = await buildTarget(store, credentialsOf(), server)
        const result = await execCommand(target, command, {
          timeoutMs: normalizeTimeout(args?.timeoutMs),
          ...(typeof args?.cwd === 'string' && args.cwd.trim() !== '' ? { cwd: args.cwd.trim() } : {}),
        })
        const header = result.ok === true
          ? `${serverLabel(server)} · exit ${result.exitCode} · ${result.durationMs} ms`
          : `${server.name} · ${result.error?.stage ?? 'failed'}: ${result.error?.message ?? 'the command did not run'}`
        const lines = [header]
        if ((result.stdout ?? '') !== '') lines.push('', clip(result.stdout))
        if ((result.stderr ?? '') !== '') lines.push('', 'stderr:', clip(result.stderr))
        if (result.truncated === true) lines.push('', '(output was truncated by the output limit)')
        return {
          ok: result.ok === true,
          summary: lines.join('\n'),
          server: server.name,
          exitCode: result.exitCode ?? null,
          stdout: clip(result.stdout ?? ''),
          stderr: clip(result.stderr ?? ''),
          truncated: result.truncated === true,
          durationMs: result.durationMs ?? null,
          ...(result.ok === true ? {} : { error: result.error }),
        }
      } catch (error) {
        const result = failure(error)
        return { ...result, summary: result.error.message }
      }
    },
  })

  registerGatedTool(ctx, store, {
    name: 'ssh_transfer',
    description:
      'Copy one file between this machine and an SSH server shared with this conversation, in either direction. Missing parent directories are created on both ends.',
    parameters: {
      type: 'object',
      properties: {
        server: SERVER_PARAMETER,
        direction: {
          type: 'string',
          enum: ['upload', 'download'],
          description: "upload copies localPath to the server; download copies remotePath from the server.",
        },
        localPath: {
          type: 'string',
          description:
            'Path on this machine. `~` expands to the local home; a relative path resolves against the session working directory.',
        },
        remotePath: {
          type: 'string',
          description: "Path on the server. Relative paths resolve against the remote user's home directory.",
        },
        timeoutMs: TIMEOUT_PARAMETER,
      },
      required: ['server', 'direction', 'localPath', 'remotePath'],
      additionalProperties: false,
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const sessionId = exec?.agent?.id
      try {
        const server = requireGrantedServer(store, sessionId, args?.server)
        const direction = args?.direction
        if (direction !== 'upload' && direction !== 'download') {
          throw new ServerError('bad-request', "direction must be 'upload' or 'download'")
        }
        const localPath = await resolveLocalPath(ctx, exec, args?.localPath)
        const remotePath = typeof args?.remotePath === 'string' ? args.remotePath.trim() : ''
        if (remotePath === '') throw new ServerError('bad-request', 'a remote path is required')
        const target = await buildTarget(store, credentialsOf(), server)
        const timeoutMs = normalizeTimeout(args?.timeoutMs)
        const result = direction === 'upload'
          ? await uploadFile(target, localPath, remotePath, { timeoutMs })
          : await downloadFile(target, remotePath, localPath, { timeoutMs })
        const summary = result.ok === true
          ? `${direction === 'upload' ? 'Uploaded' : 'Downloaded'} ${result.bytes} bytes ${direction === 'upload' ? `to ${server.name}:${remotePath}` : `from ${server.name}:${remotePath}`}${direction === 'upload' ? '' : ` to ${localPath}`}`
          : `${server.name} · ${result.error?.stage ?? 'failed'}: ${result.error?.message ?? 'the transfer did not run'}`
        return {
          ok: result.ok === true,
          summary,
          direction,
          server: server.name,
          localPath,
          remotePath,
          bytes: result.bytes ?? null,
          ...(result.ok === true ? {} : { error: result.error }),
        }
      } catch (error) {
        const result = failure(error)
        return { ...result, summary: result.error.message }
      }
    },
  })
}

/**
 * Answer one browser request. Every endpoint returns the RPC envelope's value;
 * a failure carries a stable code so the page can show a useful sentence.
 * @param deps - store and service accessors.
 * @param endpoint - dotted endpoint name.
 * @param payload - request payload.
 * @returns the endpoint value.
 */
async function handleRpc(deps, endpoint, payload) {
  const { store, credentialsOf } = deps
  const body = payload !== null && typeof payload === 'object' ? payload : {}

  if (endpoint === 'bootstrap') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    return {
      servers: await describeAll(store, credentialsOf()),
      allowed: store.allowedFor(sessionId),
      sessionId,
    }
  }

  if (endpoint === 'servers.save') {
    const input = body.server !== null && typeof body.server === 'object' ? body.server : {}
    const candidate = {
      id: typeof input.id === 'string' && input.id !== '' ? input.id : undefined,
      name: typeof input.name === 'string' ? input.name : '',
      host: typeof input.host === 'string' ? input.host : '',
      port: input.port,
      username: typeof input.username === 'string' ? input.username : '',
      auth: input.auth,
      keyPath: typeof input.keyPath === 'string' ? input.keyPath : '',
      jumpId: typeof input.jumpId === 'string' ? input.jumpId : '',
      note: typeof input.note === 'string' ? input.note : '',
    }
    const missing = []
    if (candidate.name.trim() === '') missing.push('name')
    if (candidate.host.trim() === '') missing.push('address')
    if (candidate.username.trim() === '') missing.push('user name')
    if (missing.length > 0) throw new ServerError('bad-request', `fill in: ${missing.join(', ')}`)
    if (candidate.jumpId !== '') {
      const jump = store.findServer(candidate.jumpId)
      if (jump === undefined) throw new ServerError('jump-missing', 'the chosen jump host no longer exists')
      if (jump.id === candidate.id) throw new ServerError('jump-cycle', 'a server cannot jump through itself')
      if (jump.jumpId !== '' && jump.jumpId === candidate.id) {
        throw new ServerError('jump-cycle', `"${jump.name}" already jumps through this server`)
      }
    }
    const saved = store.upsertServer(candidate)
    const credentials = credentialsOf()
    if (body.clearSecret === true) {
      await deleteSecret(credentials, saved.id)
    } else if (typeof body.password === 'string' || typeof body.passphrase === 'string') {
      await writeSecret(credentials, saved.id, {
        ...(typeof body.password === 'string' ? { password: body.password } : {}),
        ...(typeof body.passphrase === 'string' ? { passphrase: body.passphrase } : {}),
      })
    }
    logDebug(`saved server ${saved.id} (${saved.auth})`)
    return { servers: await describeAll(store, credentials), savedId: saved.id }
  }

  if (endpoint === 'servers.delete') {
    const id = typeof body.id === 'string' ? body.id : ''
    const removed = store.removeServer(id)
    if (removed) await deleteSecret(credentialsOf(), id)
    logDebug(`removed server ${id}: ${String(removed)}`)
    return { servers: await describeAll(store, credentialsOf()), removed }
  }

  if (endpoint === 'servers.test') {
    const server = store.findServer(typeof body.id === 'string' ? body.id : '')
    if (server === undefined) throw new ServerError('no-server', 'that server no longer exists')
    try {
      const target = await buildTarget(store, credentialsOf(), server)
      const result = await probe(target, { timeoutMs: 20_000 })
      if (result.ok === true) {
        return { ok: true, latencyMs: result.latencyMs, uname: result.uname ?? '', banner: result.banner ?? '' }
      }
      return { ok: false, error: { code: result.error?.code ?? 'probe-failed', message: result.error?.message ?? 'the connection failed', stage: result.error?.stage ?? 'connect' } }
    } catch (error) {
      return failure(error)
    }
  }

  if (endpoint === 'session.set') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') throw new ServerError('bad-request', 'a session id is required')
    const allowed = store.setAllowed(sessionId, body.allowed)
    logDebug(`session ${sessionId} granted ${allowed.length} server(s)`)
    return { allowed, sessionId }
  }

  throw new ServerError('unknown-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`)
}

/** Wrap one handler result into the channel's envelope. */
function envelope(value) {
  return { ok: true, value }
}

/** Wrap one thrown value into the channel's failure envelope. */
function envelopeFailure(error) {
  const code = error instanceof ServerError ? error.code : typeof error?.code === 'string' ? error.code : 'remote-ssh/failed'
  const message = String(error?.message ?? error)
  logDebug(`rpc failure ${code}: ${message}`)
  return { ok: false, error: { code, message, details: {} } }
}

/** Reply with a short plain-text body. */
function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** Reply with one JSON document. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read and parse a small JSON request body.
 * @param req - the incoming request.
 * @returns the parsed body, or a rejection when it is not JSON or is too large.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? null : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Extract the endpoint name from a request path.
 * @param pathname - the request path.
 * @returns the endpoint, or undefined when the path is not this channel's.
 */
function endpointOf(pathname) {
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(CHANNEL.length + 1)
  if (endpoint === '') return undefined
  const segments = endpoint.split('/')
  return segments.every((segment) => isEndpointSegment(segment)) ? endpoint : undefined
}

/** Whether one path segment is an acceptable endpoint segment. */
function isEndpointSegment(segment) {
  return segment !== '' && segment !== '.' && segment !== '..' && ENDPOINT_SEGMENT.test(segment)
}

/**
 * Serve one browser request: authenticate, unwrap the envelope, dispatch, reply.
 * @param deps - store and service accessors.
 * @param ctx - plugin context, for the Connection service.
 * @param req - incoming request.
 * @param res - response to own.
 */
async function serveRpc(deps, ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const endpoint = endpointOf(url.pathname)
  if (req.method !== 'POST' || endpoint === undefined) {
    sendText(res, 404, 'not found')
    return
  }
  const connection = ctx.get('connection')
  if (connection === undefined) {
    sendText(res, 401, 'unauthorized')
    return
  }
  const admission = connection.admit({ headers: req.headers })
  if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
    sendText(res, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    sendText(res, 415, 'content type must be application/json')
    return
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    sendText(res, 400, 'body is not JSON')
    return
  }
  if (body === null || typeof body !== 'object') {
    sendText(res, 400, 'body is not an envelope')
    return
  }
  const rpcId = typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
  const method = typeof body.method === 'string' && body.method !== '' ? body.method : endpoint
  let result
  try {
    result = envelope(await handleRpc(deps, method, body.payload))
  } catch (error) {
    result = envelopeFailure(error)
  }
  sendJson(res, 200, { type: 'server-response', rpcId, result })
}

/**
 * Host half entry point.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const store = createStore()
  const credentialsOf = () => ctx.get('credentials')
  if (store.warning !== undefined) logDebug(store.warning)

  const deps = { store, credentialsOf }

  // The browser channel needs the Web carrier; a composition without it keeps
  // the model tools and skips the page-facing half.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: CHANNEL,
          handler: (req, res) => {
            serveRpc(deps, ctx, req, res).catch((error) => {
              logDebug(`rpc bridge failed: ${String(error?.message ?? error)}`)
              try {
                sendText(res, 500, 'internal error')
              } catch {
                // The socket may already be gone.
              }
            })
          },
        }),
      'remote-ssh: rpc route',
    )
    logDebug('rpc channel registered')
  } else {
    logDebug('no web carrier; the browser settings page is unavailable in this composition')
  }

  registerTools(ctx, store, credentialsOf)
  logDebug(`activated with ${store.servers().length} server(s)`)
}

/**
 * Hard dependencies.
 *
 * `tools` carries the model tools. The browser half reaches the Web carrier and
 * the Connection service through `ctx.get(...)`, so a composition without them
 * (headless, ACP) still loads this plugin with its tools only.
 */
export const inject = ['tools']
