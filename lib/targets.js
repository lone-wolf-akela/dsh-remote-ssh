/**
 * Turning a stored server entry into something the SSH transport can dial.
 *
 * This is the one place that knows how a catalog record becomes a connection:
 * which secret applies, which identity file backs a `key` server, and how a
 * jump host nests. Browser views and the model's tool results both derive from
 * here, so the settings page can never show a different address than the one
 * that gets dialled.
 */

import { readFile } from 'node:fs/promises'
import { readSecret, resolveKeyPath } from './secrets.js'

/** Marker on errors that cross the RPC boundary as a stable code. */
export class ServerError extends Error {
  /**
   * @param code - stable machine code, such as `no-server` or `key-missing`.
   * @param message - human sentence shown in the UI or the tool result.
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Resolve a jump chain, refusing cycles and runaway nesting.
 * @param store - the state store.
 * @param server - the server being dialled.
 * @param depth - how many hops are already being followed.
 * @returns the server acting as this hop's jump host, or undefined.
 */
function jumpServerOf(store, server, depth) {
  if (server.jumpId === '') return undefined
  const jump = store.jumpOf(server)
  if (jump === undefined) {
    throw new ServerError('jump-missing', `server "${server.name}" is configured to jump through a server that no longer exists`)
  }
  if (depth >= 1 && jump.jumpId !== '') {
    throw new ServerError('jump-too-deep', 'only one jump host is supported; a jump host cannot itself jump')
  }
  return jump
}

/**
 * Build the connection target for one server, resolving its secrets.
 * @param store - the state store.
 * @param credentials - the `credentials` service, or undefined.
 * @param server - the server record to dial.
 * @param depth - recursion depth; internal.
 * @returns a transport target, with `jump` filled when configured.
 */
export async function buildTarget(store, credentials, server, depth = 0) {
  if (server === undefined) throw new ServerError('no-server', 'that server does not exist')
  const secret = await readSecret(credentials, server.id)
  let auth
  if (server.auth === 'password') {
    if (secret.password === undefined) {
      throw new ServerError('no-password', `server "${server.name}" uses password authentication but no password is saved for it`)
    }
    auth = { kind: 'password', password: secret.password }
  } else {
    const key = resolveKeyPath(server.keyPath)
    if (!key.exists) {
      throw new ServerError(
        'key-missing',
        key.path === ''
          ? `server "${server.name}" uses key authentication but no private key was found (no ~/.ssh identity and no key path configured)`
          : `server "${server.name}" uses key authentication but the private key ${key.path} does not exist`,
      )
    }
    let privateKey
    try {
      privateKey = await readFile(key.path, 'utf8')
    } catch (error) {
      throw new ServerError('key-unreadable', `private key ${key.path} could not be read: ${String(error?.message ?? error)}`)
    }
    auth = {
      kind: 'privateKey',
      privateKey,
      ...(secret.passphrase === undefined ? {} : { passphrase: secret.passphrase }),
    }
  }
  const target = { host: server.host, port: server.port, username: server.username, auth }
  const jump = jumpServerOf(store, server, depth)
  if (jump !== undefined) {
    const jumpTarget = await buildTarget(store, credentials, jump, depth + 1)
    // A jump host that itself declares a jump is refused above, so the nesting
    // stops at one hop: drop the inner `jump` field rather than following it.
    const { jump: _nested, ...flatJump } = jumpTarget
    target.jump = flatJump
  }
  return target
}

/**
 * Project one server for the browser: no secret values, presence only.
 * @param store - the state store.
 * @param credentials - the `credentials` service, or undefined.
 * @param server - the server record.
 * @returns the view rendered by the settings page.
 */
export async function describeServer(store, credentials, server) {
  const secret = await readSecret(credentials, server.id)
  const key = resolveKeyPath(server.keyPath)
  const jump = store.jumpOf(server)
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    auth: server.auth,
    keyPath: server.keyPath,
    keySource: key.source,
    resolvedKeyPath: key.path,
    keyExists: key.exists,
    jumpId: jump === undefined ? '' : jump.id,
    jumpName: jump === undefined ? '' : jump.name,
    note: server.note,
    hasPassword: secret.password !== undefined,
    hasPassphrase: secret.passphrase !== undefined,
  }
}

/**
 * Project every server in catalog order.
 * @param store - the state store.
 * @param credentials - the `credentials` service, or undefined.
 * @returns all views, in catalog order.
 */
export async function describeAll(store, credentials) {
  return Promise.all(store.servers().map((server) => describeServer(store, credentials, server)))
}
