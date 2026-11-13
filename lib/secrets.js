/**
 * Secret handling for the Remote SSH bundle.
 *
 * Passwords and private-key passphrases are the only secrets this plugin owns.
 * They live in the Harness credential store as one `grant` record per server,
 * addressed as `remote-ssh/<slot>`; the state document and every browser
 * response carry presence flags instead of values.
 *
 * **The slot is derived, never the server id.** A credential key is
 * `<scope>/<id>` and DSH validates BOTH segments against
 * `/^[a-z][a-z0-9-]*$/` while loading the credential document — a single
 * offending record fails `dsh-credentials-local` activation, which fails
 * `connection`, which fails the whole Harness startup. Server ids here are
 * UUIDs (or whatever a hand-edited `state.json` holds), and a UUID starting
 * with a digit is not a legal segment. So the id is hashed into a stable
 * `srv-<hex>` slot: legal by construction, independent of the id's shape, and
 * requiring no migration of the state document or of per-conversation grants.
 *
 * The same module resolves which private key file a `key` server will use. The
 * user may name one, otherwise the machine's usual `~/.ssh` identities are
 * tried in order, which is what "just use the key I already have" means in
 * practice.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Record scope: the `<owner>` half of the `<owner>/<id>` credential key. */
export const CREDENTIAL_SCOPE = 'remote-ssh'

/**
 * Grammar DSH applies to each credential-key segment. Mirrored here so this
 * bundle can refuse a bad key at the write boundary instead of persisting one
 * that bricks the next startup.
 */
export const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/** Version of the record payload written by this bundle. */
const RECORD_VERSION = 1

/** Identity files tried, in order, when the user names none. */
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa']

/**
 * Derive the legal credential-id segment for one server.
 *
 * Pure and stable: the same server id always maps to the same slot, so a
 * password written today is found after a restart, after a state-document
 * rewrite, and by `scripts/repair-credentials.mjs`.
 * @param serverId - the server's own identity, in any shape.
 * @returns a segment matching {@link KEY_SEGMENT_PATTERN}.
 */
export function credentialSlot(serverId) {
  const digest = createHash('sha256').update(String(serverId)).digest('hex')
  return `srv-${digest.slice(0, 16)}`
}

/**
 * Whether a joined `<scope>/<id>` string is a legal credential key.
 * @param key - candidate key.
 * @returns true when both segments match the DSH grammar.
 */
export function isLegalCredentialKey(key) {
  if (typeof key !== 'string') return false
  const segments = key.split('/')
  if (segments.length !== 2) return false
  return segments.every((segment) => KEY_SEGMENT_PATTERN.test(segment))
}

/**
 * Credential key for one server.
 * @param serverId - server identity.
 * @returns the `<owner>/<id>` record key.
 * @throws TypeError when the composed key would be rejected by DSH at startup.
 */
export function credentialRecordKey(serverId) {
  const key = `${CREDENTIAL_SCOPE}/${credentialSlot(serverId)}`
  if (!isLegalCredentialKey(key)) {
    throw new TypeError(`remote-ssh: refusing to build the credential key ${JSON.stringify(key)}; it does not match <scope>/<id> with ${String(KEY_SEGMENT_PATTERN)}`)
  }
  return key
}

/**
 * The key an earlier version of this bundle wrote for one server.
 *
 * Kept only so `scripts/repair-credentials.mjs` can recognise and re-key those
 * records: writing one is illegal in the current DSH, and reading one is
 * impossible because the credential provider refuses to load the document.
 * @param serverId - server identity.
 * @returns the historical `remote-ssh/<serverId>` spelling.
 */
export function legacyCredentialKey(serverId) {
  return `${CREDENTIAL_SCOPE}/${serverId}`
}

/**
 * Expand a leading `~` against the current user's home directory.
 * @param path - possibly `~`-prefixed path.
 * @returns the expanded path, or '' for empty input.
 */
export function expandHome(path) {
  if (typeof path !== 'string') return ''
  const trimmed = path.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * Resolve the private key file a `key` server uses.
 *
 * A configured path wins even when the file is missing: reporting the broken
 * path is more useful than silently authenticating as a different identity.
 * @param configuredPath - the path stored on the server entry, possibly empty.
 * @returns the chosen path, its source, and whether it exists.
 */
export function resolveKeyPath(configuredPath) {
  const explicit = expandHome(configuredPath)
  if (explicit !== '') return { path: explicit, source: 'configured', exists: existsSync(explicit) }
  for (const name of DEFAULT_KEY_NAMES) {
    const candidate = join(homedir(), '.ssh', name)
    if (existsSync(candidate)) return { path: candidate, source: 'default', exists: true }
  }
  return { path: '', source: 'none', exists: false }
}

/**
 * Read the stored secrets of one server.
 * @param credentials - the `credentials` service, or undefined in a composition without it.
 * @param serverId - server identity.
 * @returns the password and passphrase that are present, or an empty object.
 */
export async function readSecret(credentials, serverId) {
  if (credentials === undefined || credentials === null) return {}
  const record = await credentials.readRecord(credentialRecordKey(serverId))
  const payload = record?.payload
  if (payload === null || typeof payload !== 'object') return {}
  return {
    password: typeof payload.password === 'string' && payload.password !== '' ? payload.password : undefined,
    passphrase: typeof payload.passphrase === 'string' && payload.passphrase !== '' ? payload.passphrase : undefined,
  }
}

/**
 * Whether one server has a stored secret, without loading its value.
 * @param credentials - the `credentials` service, or undefined.
 * @param serverId - server identity.
 * @returns presence flags for the settings page.
 */
export async function describeSecret(credentials, serverId) {
  const secret = await readSecret(credentials, serverId)
  return { hasPassword: secret.password !== undefined, hasPassphrase: secret.passphrase !== undefined }
}

/**
 * Write one server's secrets.
 *
 * A field that is absent from `input` keeps its current value; a field present
 * as an empty string clears it. Removing every field deletes the record instead
 * of leaving an empty grant behind.
 * @param credentials - the `credentials` service.
 * @param serverId - server identity.
 * @param input - `{ password?, passphrase? }` where '' means "clear".
 */
export async function writeSecret(credentials, serverId, input) {
  if (credentials === undefined || credentials === null) {
    throw new Error('this Harness has no credential store, so a password cannot be saved')
  }
  const key = credentialRecordKey(serverId)
  const nextPassword = typeof input?.password === 'string' ? input.password : undefined
  const nextPassphrase = typeof input?.passphrase === 'string' ? input.passphrase : undefined
  if (nextPassword === undefined && nextPassphrase === undefined) return
  await credentials.modifyRecord(key, async (current) => {
    const payload = {}
    if (current?.payload !== null && typeof current?.payload === 'object') {
      if (typeof current.payload.password === 'string') payload.password = current.payload.password
      if (typeof current.payload.passphrase === 'string') payload.passphrase = current.payload.passphrase
    }
    if (nextPassword !== undefined) {
      if (nextPassword === '') delete payload.password
      else payload.password = nextPassword
    }
    if (nextPassphrase !== undefined) {
      if (nextPassphrase === '') delete payload.passphrase
      else payload.passphrase = nextPassphrase
    }
    if (payload.password === undefined && payload.passphrase === undefined) return undefined
    return { kind: 'grant', payload: { version: RECORD_VERSION, ...payload } }
  })
  // `modifyRecord` returning undefined leaves the record untouched, so the
  // explicit delete below is what actually clears a fully emptied record.
  const remaining = await readSecret(credentials, serverId)
  if (remaining.password === undefined && remaining.passphrase === undefined) {
    await credentials.deleteRecord(key)
  }
}

/**
 * Forget one server's secrets, called when the server is removed.
 * @param credentials - the `credentials` service, or undefined.
 * @param serverId - server identity.
 */
export async function deleteSecret(credentials, serverId) {
  if (credentials === undefined || credentials === null) return
  await credentials.deleteRecord(credentialRecordKey(serverId))
}
