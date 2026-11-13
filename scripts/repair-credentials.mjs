#!/usr/bin/env node
/**
 * Repair credential records written by an earlier version of this bundle.
 *
 * Version 0.1.0 addressed each server's secret as `remote-ssh/<serverId>`, and
 * the server id was a bare UUID. DSH 0.2.2-rc.3 validates every credential key
 * while loading `.credentials.yaml` and requires both segments to match
 * `/^[a-z][a-z0-9-]*$/`; a UUID starting with a digit is rejected, the local
 * credential provider fails to activate, `connection` (which depends on it)
 * stays pending, and Harness refuses to start:
 *
 *   dsh: startup failed: 1 required plugin did not activate
 *   Failed plugins: credentials (@deepseek-ai/dsh-credentials-local)
 *   TypeError: credential key segment "024bd1a5-…" must match /^[a-z][a-z0-9-]*$/
 *
 * The plugin now derives a legal `remote-ssh/srv-<hex>` slot from the server id
 * and refuses to write anything else. This script migrates the records already
 * on disk, so a bricked installation starts again with its passwords intact
 * instead of being repaired by hand.
 *
 * Run it with DSH QUIT: it edits the credential document, and a running
 * instance could overwrite the result.
 *
 *   node scripts/repair-credentials.mjs                # dry run: report only
 *   node scripts/repair-credentials.mjs --write        # back up, then rewrite
 *   node scripts/repair-credentials.mjs --home D:\dsh  # another Harness home
 *   node scripts/repair-credentials.mjs --file <path>  # an explicit document
 *   node scripts/repair-credentials.mjs --delete-unknown --write
 *       drop records whose server id is no longer in state.json instead of
 *       re-keying them as orphans
 *
 * Exit codes: 0 nothing to do or repair applied, 1 work remains (a conflict or
 * an illegal key this script does not own), 2 usage or IO problem.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { credentialSlot, isLegalCredentialKey, KEY_SEGMENT_PATTERN, CREDENTIAL_SCOPE } from '../lib/secrets.js'

const say = (message = '') => process.stdout.write(`${message}\n`)
const fail = (message) => {
  process.stderr.write(`repair-credentials: ${message}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { write: false, deleteUnknown: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value`)
      i += 1
      return next
    }
    if (arg === '--write') options.write = true
    else if (arg === '--delete-unknown') options.deleteUnknown = true
    else if (arg === '--home') options.home = value()
    else if (arg === '--file') options.file = value()
    else if (arg === '--help' || arg === '-h') {
      const source = readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]
      process.stdout.write(source.replace(/^#![^\n]*\n/, '').replace(/^\/\*\*?/, '').replace(/^\s*\* ?/gm, '') + '\n')
      process.exit(0)
    } else fail(`unknown argument ${arg} (try --help)`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const file = options.file ?? join(home, '.credentials.yaml')
const statePath = join(home, 'state', 'dsh-remote-ssh', 'state.json')

if (!existsSync(file)) fail(`${file} does not exist — nothing to repair (is --home right?)`)

/** Records are `<scope>/<id>`; the scope escapes are trivial but keep this honest. */
const SCOPE_PATTERN = CREDENTIAL_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A record-key line: indentation, optional quotes, `<scope>/<id>`, colon, end of line. */
const KEY_LINE = new RegExp(`^(\\s*)(["']?)(${SCOPE_PATTERN}/[^"'\\s:]+)\\2\\s*:\\s*$`)

/** Server ids this plugin knows about, so a record can be reported as orphaned. */
function knownServerIds() {
  if (!existsSync(statePath)) return new Set()
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const ids = new Set()
    for (const server of Array.isArray(state?.servers) ? state.servers : []) {
      if (typeof server?.id === 'string' && server.id !== '') ids.add(server.id)
    }
    return ids
  } catch {
    say(`! ${statePath} could not be read; every unknown id will be treated as an orphan`)
    return new Set()
  }
}

const ids = knownServerIds()
const original = readFileSync(file, 'utf8')
const lines = original.split(/\r?\n/)
const newline = original.includes('\r\n') ? '\r\n' : '\n'
const present = new Set()
for (const line of lines) {
  const match = KEY_LINE.exec(line)
  if (match !== null) present.add(match[3])
}

const rekeys = []
const deletions = []
const blocked = []
const output = []

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index]
  const match = KEY_LINE.exec(line)
  if (match === null) {
    output.push(line)
    continue
  }
  const [, indent, quote, key] = match
  if (isLegalCredentialKey(key)) {
    output.push(line)
    continue
  }
  const legacyId = key.slice(key.indexOf('/') + 1)
  const known = ids.has(legacyId)
  if (!known && options.deleteUnknown) {
    rekeys.push({ kind: 'delete', key, legacyId, known })
    // Drop the record's own body: deeper-indented lines that are not another key.
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1]
      if (nextLine.trim() === '') break
      const nextIndent = /^(\s*)/.exec(nextLine)[1].length
      if (nextIndent <= indent.length && KEY_LINE.test(nextLine)) break
      if (nextIndent <= indent.length) break
      index += 1
    }
    continue
  }
  const slot = credentialSlot(legacyId)
  if (!KEY_SEGMENT_PATTERN.test(slot)) {
    blocked.push({ key, reason: `the derived slot ${JSON.stringify(slot)} is not a legal segment` })
    output.push(line)
    continue
  }
  const nextKey = `${CREDENTIAL_SCOPE}/${slot}`
  if (present.has(nextKey)) {
    blocked.push({ key, reason: `the record ${nextKey} already exists; merge or drop one by hand` })
    output.push(line)
    continue
  }
  rekeys.push({ kind: 'rekey', key, nextKey, legacyId, known })
  output.push(`${indent}${quote}${nextKey}${quote}:`)
}

const edited = output.join(newline)

/**
 * Every `<x>/<y>`-shaped key still in the document, so the caller can prove the
 * next startup will parse. Anchored on `: end-of-line` so plain values such as
 * `issuer: https://…` never match.
 * @param text - candidate document text.
 * @returns illegal keys, in document order.
 */
function illegalKeys(text) {
  const found = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:["']?)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:["']?)\s*:\s*$/.exec(line)
    if (match === null) continue
    if (!isLegalCredentialKey(match[1])) found.push(match[1])
  }
  return found
}

say(`credentials: ${file}`)
say(`servers:     ${ids.size} known id(s)${existsSync(statePath) ? '' : ' (no state document)'}`)
for (const item of rekeys) {
  say('')
  if (item.kind === 'delete') {
    say(`delete  ${item.key}`)
    say('        server not in state.json; the secret is dropped')
  } else {
    say(`rekey   ${item.key}`)
    say(`    ->  ${item.nextKey}`)
    say(`        ${item.known ? 'server found in state.json' : 'server NOT in state.json (orphan; the secret is kept)'}`)
  }
}
for (const item of blocked) {
  say('')
  say(`! keep  ${item.key}`)
  say(`        ${item.reason}`)
}

const remaining = illegalKeys(edited)
if (remaining.length > 0) {
  say('')
  say('! illegal keys remain; Harness will still refuse to start:')
  for (const key of remaining) say(`    ${key}`)
}

if (rekeys.length === 0) {
  say('')
  say(blocked.length === 0 && remaining.length === 0 ? 'OK: every credential key is legal; nothing to repair.' : 'nothing this script can change.')
  process.exit(blocked.length > 0 || remaining.length > 0 ? 1 : 0)
}

if (!options.write) {
  say('')
  say(`dry run: ${rekeys.filter((item) => item.kind === 'rekey').length} rekey, ${rekeys.filter((item) => item.kind === 'delete').length} delete.`)
  say('Re-run with --write to apply, after quitting DSH.')
  process.exit(remaining.length > 0 || blocked.length > 0 ? 1 : 0)
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
const backup = `${file}.bak-${stamp}`
copyFileSync(file, backup)
const temporary = `${file}.repair.tmp`
writeFileSync(temporary, edited, 'utf8')
renameSync(temporary, file)
say('')
say(`applied: ${rekeys.filter((item) => item.kind === 'rekey').length} rekey, ${rekeys.filter((item) => item.kind === 'delete').length} delete`)
say(`backup:  ${backup}`)
say('start DSH again; the migrated records are read under their new keys.')
process.exit(remaining.length > 0 || blocked.length > 0 ? 1 : 0)
