/**
 * Plugin-owned durable state for the Remote SSH bundle.
 *
 * Two things are stored here, and nothing secret:
 *
 *   servers   the SSH server catalog the user maintains in Settings
 *   sessions  which server ids each conversation has been granted, and for
 *             which of them that conversation may also run commands as root
 *             through sudo
 *
 * Passwords, key passphrases and sudo passwords never enter this file. They live
 * in `ctx.credentials` as one `<owner>/<id>` record per server (see
 * `secrets.js`), so the state file stays safe to read, copy, and show in
 * diagnostics.
 *
 * A grant is inherited down the delegation chain: a subagent session has no UI
 * to choose servers, so when it holds no grant of its own the nearest ancestor
 * that has one answers for it (see `effectiveGrants`). The caller supplies
 * the ancestry walk, which keeps this module free of Harness imports.
 *
 * The file is plain JSON under `$DSH_HOME/state/dsh-remote-ssh/`, written with
 * a temporary file plus rename so a crash mid-write cannot truncate the catalog.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Format version of `state.json`.
 *
 * 1 stored a session grant as a bare array of server ids. 2 stores an array of
 * `{ id, sudo }` entries under the same key, so one conversation can allow sudo
 * on some of its servers and not on others. A version 1 document is read
 * through {@link normalizeGrants}, which accepts both spellings, so an upgrade
 * needs no migration step: the next write simply restamps the file.
 */
const STATE_VERSION = 2

/** Lowest and highest TCP port accepted for a server entry. */
export const PORT_MIN = 1
export const PORT_MAX = 65535

/** Authentication kinds a server entry may declare. */
export const AUTH_KINDS = ['password', 'key']

/**
 * Mint a server id.
 *
 * Deliberately not a bare UUID: an id is also the readable half of the on-disk
 * credential address, and DSH only accepts lowercase hyphenated segments there.
 * `lib/secrets.js` still hashes the id, so this is readability, not the safety
 * mechanism — but a state document full of `srv-3f9a…` is far easier to reason
 * about than one full of UUIDs.
 * @returns the new id.
 */
function mintServerId() {
  return `srv-${randomBytes(6).toString('hex')}`
}

/**
 * Resolve this Harness home the same way the rest of the product does.
 * @returns the absolute `$DSH_HOME`-equivalent directory.
 */
function resolveHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/** Directory holding every file this bundle owns. */
export function stateDirectory() {
  return join(resolveHome(), 'state', 'dsh-remote-ssh')
}

/** Absolute path of the state document. */
export function statePath() {
  return join(stateDirectory(), 'state.json')
}

/**
 * Clamp and shape one raw server entry into the canonical record.
 * Unknown fields are dropped so a hand-edited file cannot smuggle state in.
 * @param input - untrusted entry, from disk or from a browser request.
 * @param id - identity to use, or undefined to mint one.
 * @returns the canonical server record.
 */
export function normalizeServer(input, id) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const port = Number(raw.port)
  return {
    id: typeof id === 'string' && id !== '' ? id : mintServerId(),
    name: text(raw.name),
    host: text(raw.host),
    port: Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX ? port : 22,
    username: text(raw.username),
    auth: AUTH_KINDS.includes(raw.auth) ? raw.auth : 'password',
    keyPath: text(raw.keyPath),
    jumpId: text(raw.jumpId),
    note: text(raw.note),
  }
}

/**
 * Shape one grant entry.
 *
 * Accepts the version 1 spelling (a bare server id) as well as the current
 * `{ id, sudo }` object, so an old document loads without a migration pass.
 * @param entry - untrusted grant, from disk or from a browser request.
 * @returns the canonical grant, or undefined when it names no server.
 */
export function normalizeGrant(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim()
    return id === '' ? undefined : { id, sudo: false }
  }
  if (entry === null || typeof entry !== 'object') return undefined
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id === '') return undefined
  return { id, sudo: entry.sudo === true }
}

/**
 * Shape one session's stored grant list.
 *
 * Accepts every on-disk spelling: a version 1 array of ids, the current array
 * of `{ id, sudo }` objects, and a `{ grants: [...] }` wrapper. Duplicates
 * collapse; when the same server appears twice, sudo wins.
 * @param value - untrusted session entry.
 * @returns canonical grants in first-seen order.
 */
export function normalizeGrants(value) {
  const raw = Array.isArray(value) ? value : Array.isArray(value?.grants) ? value.grants : []
  const byId = new Map()
  for (const entry of raw) {
    const grant = normalizeGrant(entry)
    if (grant === undefined) continue
    const existing = byId.get(grant.id)
    if (existing === undefined) byId.set(grant.id, grant)
    else if (grant.sudo) byId.set(grant.id, { id: grant.id, sudo: true })
  }
  return [...byId.values()]
}

/**
 * Read the state document, tolerating a missing or unreadable file.
 * A corrupt file is reported through `warning` instead of failing activation:
 * the plugin stays usable and the next write replaces the bad document.
 * @returns the loaded state and an optional warning message.
 */
function readState() {
  const path = statePath()
  const empty = { version: STATE_VERSION, servers: [], sessions: {} }
  if (!existsSync(path)) return { state: empty, warning: undefined }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const servers = Array.isArray(parsed?.servers) ? parsed.servers.map((entry) => normalizeServer(entry, entry?.id)) : []
    const sessions = {}
    if (parsed?.sessions !== null && typeof parsed?.sessions === 'object') {
      for (const [sessionId, value] of Object.entries(parsed.sessions)) {
        const grants = normalizeGrants(value)
        if (grants.length > 0) sessions[sessionId] = grants
      }
    }
    return { state: { version: STATE_VERSION, servers, sessions }, warning: undefined }
  } catch (error) {
    return { state: empty, warning: `state.json could not be read and was ignored: ${String(error?.message ?? error)}` }
  }
}

/**
 * Create the in-memory view of the plugin's durable state.
 *
 * The catalog is small (a handful of servers) and is read entirely at
 * activation, so every reader is synchronous: the tool-visibility gate runs
 * once per model step and must not wait on I/O.
 * @returns the store handle used by the host half.
 */
export function createStore() {
  const loaded = readState()
  let servers = loaded.state.servers
  let sessions = loaded.state.sessions
  const warning = loaded.warning

  /** Persist the current state, replacing the document atomically. */
  function flush() {
    const path = statePath()
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: STATE_VERSION, servers, sessions }, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  }

  /** Drop grants that name a server which no longer exists. */
  function liveGrants(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const stored = sessions[sessionId]
    if (!Array.isArray(stored)) return []
    return stored.filter((grant) => servers.some((server) => server.id === grant.id))
  }

  return {
    /** Warning produced while loading, or undefined. */
    warning,

    /** Every server, in catalog order. */
    servers() {
      return servers
    },

    /**
     * Resolve one server by id, or by its display name when the name is unique.
     * @param reference - id or name typed by a user or the model.
     * @returns the matching server, or undefined.
     */
    findServer(reference) {
      if (typeof reference !== 'string') return undefined
      const wanted = reference.trim()
      if (wanted === '') return undefined
      const byId = servers.find((server) => server.id === wanted)
      if (byId !== undefined) return byId
      const lowered = wanted.toLowerCase()
      const byName = servers.filter((server) => server.name.toLowerCase() === lowered)
      return byName.length === 1 ? byName[0] : undefined
    },

    /** The server a jump chain points at, or undefined. */
    jumpOf(server) {
      if (server === undefined || server.jumpId === '') return undefined
      return servers.find((candidate) => candidate.id === server.jumpId && candidate.id !== server.id)
    },

    /**
     * Insert or replace one server.
     * @param input - canonical or raw fields; `id` selects the replaced entry.
     * @returns the stored record.
     */
    upsertServer(input) {
      const id = typeof input?.id === 'string' && input.id !== '' ? input.id : undefined
      const next = normalizeServer(input, id)
      const index = id === undefined ? -1 : servers.findIndex((server) => server.id === id)
      if (index === -1) servers = [...servers, next]
      else servers = servers.map((server, position) => (position === index ? next : server))
      flush()
      return next
    },

    /**
     * Remove one server and every session grant that named it.
     * @param id - server id.
     * @returns true when an entry was removed.
     */
    removeServer(id) {
      const before = servers.length
      servers = servers.filter((server) => server.id !== id)
      if (servers.length === before) return false
      servers = servers.map((server) => (server.jumpId === id ? { ...server, jumpId: '' } : server))
      const nextSessions = {}
      for (const [sessionId, grants] of Object.entries(sessions)) {
        const kept = grants.filter((grant) => grant.id !== id)
        if (kept.length > 0) nextSessions[sessionId] = kept
      }
      sessions = nextSessions
      flush()
      return true
    },

    /**
     * The grants recorded for one conversation itself, ignoring inheritance.
     * @param sessionId - session identity, or undefined for "no session".
     * @returns the recorded grants that still name an existing server.
     */
    grantsFor(sessionId) {
      return liveGrants(sessionId).map((grant) => ({ id: grant.id, sudo: grant.sudo === true }))
    },

    /**
     * Replace one conversation's own grants.
     * @param sessionId - session identity.
     * @param input - grants as `{ id, sudo }` objects or bare ids; unknown ids are
     *   dropped and an empty list removes the session entry entirely.
     * @returns the stored grants.
     */
    setGrants(sessionId, input) {
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error('a session id is required')
      const known = normalizeGrants(input).filter((grant) => servers.some((server) => server.id === grant.id))
      if (known.length === 0) delete sessions[sessionId]
      else sessions = { ...sessions, [sessionId]: known }
      flush()
      return known
    },

    /**
     * The grants that actually answer for one conversation.
     *
     * A session's own grants always win. When it has none — every subagent left
     * to itself, since a subagent has no UI to choose servers — the nearest
     * ancestor with a grant answers, walking upwards through the delegation
     * chain. The walk stops on a repeat to survive a hand-edited cycle.
     * @param sessionId - session identity.
     * @param parentOf - resolves one session's creating session, when known.
     * @returns the effective grants, possibly empty.
     */
    effectiveGrants(sessionId, parentOf) {
      if (typeof sessionId !== 'string' || sessionId === '') return []
      const own = liveGrants(sessionId)
      if (own.length > 0) return own.map((grant) => ({ id: grant.id, sudo: grant.sudo === true }))
      if (typeof parentOf !== 'function') return []
      const visited = new Set([sessionId])
      let cursor = parentOf(sessionId)
      while (typeof cursor === 'string' && cursor !== '' && !visited.has(cursor)) {
        visited.add(cursor)
        const inherited = liveGrants(cursor)
        if (inherited.length > 0) return inherited.map((grant) => ({ id: grant.id, sudo: grant.sudo === true }))
        cursor = parentOf(cursor)
      }
      return []
    },

    /**
     * One effective grant, by server id.
     * @param sessionId - session identity.
     * @param serverId - server id.
     * @param parentOf - resolves one session's creating session.
     * @returns the grant, or undefined when that server is not open here.
     */
    grantFor(sessionId, serverId, parentOf) {
      return this.effectiveGrants(sessionId, parentOf).find((grant) => grant.id === serverId)
    },

    /**
     * Whether one conversation may reach any server; the tool gate for this session.
     * @param sessionId - session identity.
     * @param parentOf - resolves one session's creating session.
     * @returns true when at least one effective grant exists.
     */
    hasAnyGrant(sessionId, parentOf) {
      return this.effectiveGrants(sessionId, parentOf).length > 0
    },
  }
}
