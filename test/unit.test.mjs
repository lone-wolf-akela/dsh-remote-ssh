/**
 * Offline tests for the Remote SSH bundle.
 *
 * No SSH host and no running Harness are needed: these cover the durable grant
 * document, the delegation-chain inheritance rule, the exact command line sudo
 * runs behind, and a render of both browser surfaces through a miniature React
 * harness — which is what catches a typo in client.js without opening the app.
 *
 * Run with:  node test/unit.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { buildSudoCommand } from '../lib/ssh.js'
import { createStore } from '../lib/state.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const results = []

async function test(name, fn) {
  const startedAt = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('PASS  ' + name + ' (' + (Date.now() - startedAt) + ' ms)')
  } catch (error) {
    results.push({ name, ok: false, error })
    const detail = String(error && error.stack ? error.stack : error).split('\n').slice(0, 4).join('\n        ')
    console.log('FAIL  ' + name + ' (' + (Date.now() - startedAt) + ' ms)\n        ' + detail)
  }
}

/** Create an isolated $DSH_HOME for one case. */
async function withHome(fn) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-rssh-unit-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

async function writeState(home, document) {
  const directory = path.join(home, 'state', 'dsh-remote-ssh')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'state.json')
  await writeFile(file, JSON.stringify(document, null, 2), 'utf8')
  return file
}

const SERVERS = [
  { id: 'srv-alpha', name: 'Alpha', host: '10.0.0.1', port: 22, username: 'root', auth: 'password' },
  { id: 'srv-beta', name: 'Beta', host: '10.0.0.2', port: 22, username: 'deploy', auth: 'key', keyPath: '~/.ssh/id_ed25519' },
]

/* ------------------------------------------------------------------------ */
/* durable grants                                                           */
/* ------------------------------------------------------------------------ */

await test('state: a version 1 grant document still loads (bare ids, sudo off)', async () => {
  await withHome(async (home) => {
    await writeState(home, { version: 1, servers: SERVERS, sessions: { 'session-1': ['srv-alpha'] } })
    const store = createStore()
    assert.deepEqual(store.grantsFor('session-1'), [{ id: 'srv-alpha', sudo: false }])
    assert.deepEqual(store.effectiveGrants('session-1'), [{ id: 'srv-alpha', sudo: false }])
  })
})

await test('state: setGrants persists { id, sudo } as version 2 and reloads', async () => {
  await withHome(async (home) => {
    await writeState(home, { version: 1, servers: SERVERS, sessions: {} })
    const store = createStore()
    const stored = store.setGrants('session-1', [{ id: 'srv-alpha', sudo: true }, { id: 'srv-beta' }])
    assert.deepEqual(stored, [{ id: 'srv-alpha', sudo: true }, { id: 'srv-beta', sudo: false }])
    const document = JSON.parse(await readFile(path.join(home, 'state', 'dsh-remote-ssh', 'state.json'), 'utf8'))
    assert.equal(document.version, 2)
    assert.deepEqual(document.sessions['session-1'], [{ id: 'srv-alpha', sudo: true }, { id: 'srv-beta', sudo: false }])
    const reloaded = createStore()
    assert.deepEqual(reloaded.grantsFor('session-1'), [{ id: 'srv-alpha', sudo: true }, { id: 'srv-beta', sudo: false }])
  })
})

await test('state: unknown server ids and empty lists are dropped', async () => {
  await withHome(async (home) => {
    await writeState(home, { version: 2, servers: SERVERS, sessions: { 'session-1': { grants: [{ id: 'srv-gone', sudo: true }] } } })
    const store = createStore()
    assert.deepEqual(store.grantsFor('session-1'), [])
    assert.deepEqual(store.setGrants('session-1', [{ id: 'srv-gone' }]), [])
  })
})

await test('state: removing a server prunes every grant that named it', async () => {
  await withHome(async (home) => {
    await writeState(home, {
      version: 2,
      servers: SERVERS,
      sessions: { 'session-1': { grants: [{ id: 'srv-alpha', sudo: true }, { id: 'srv-beta' }] } },
    })
    const store = createStore()
    assert.equal(store.removeServer('srv-alpha'), true)
    assert.deepEqual(store.grantsFor('session-1'), [{ id: 'srv-beta', sudo: false }])
  })
})

await test('inherit: a subagent with no grants of its own inherits its parent', async () => {
  await withHome(async (home) => {
    await writeState(home, { version: 2, servers: SERVERS, sessions: { parent: { grants: [{ id: 'srv-beta', sudo: true }] } } })
    const store = createStore()
    const chain = { child: 'parent', parent: undefined }
    const parentOf = (id) => chain[id]
    assert.deepEqual(store.effectiveGrants('child', parentOf), [{ id: 'srv-beta', sudo: true }])
    assert.deepEqual(store.grantsFor('child'), [])
    assert.equal(store.grantFor('child', 'srv-beta', parentOf).sudo, true)
    assert.equal(store.hasAnyGrant('child', parentOf), true)
    assert.equal(store.hasAnyGrant('stranger', parentOf), false)
  })
})

await test('inherit: walks past a grantless ancestor, and a cycle terminates empty', async () => {
  await withHome(async (home) => {
    await writeState(home, { version: 2, servers: SERVERS, sessions: { root: { grants: [{ id: 'srv-alpha' }] } } })
    const store = createStore()
    const chain = { leaf: 'middle', middle: 'root', loopA: 'loopB', loopB: 'loopA' }
    assert.deepEqual(store.effectiveGrants('leaf', (id) => chain[id]), [{ id: 'srv-alpha', sudo: false }])
    assert.deepEqual(store.effectiveGrants('loopA', (id) => chain[id]), [])
  })
})

await test('inherit: a session with its own grants ignores the ancestor', async () => {
  await withHome(async (home) => {
    await writeState(home, {
      version: 2,
      servers: SERVERS,
      sessions: {
        parent: { grants: [{ id: 'srv-alpha', sudo: true }] },
        child: { grants: [{ id: 'srv-beta', sudo: false }] },
      },
    })
    const store = createStore()
    const parentOf = (id) => (id === 'child' ? 'parent' : undefined)
    assert.deepEqual(store.effectiveGrants('child', parentOf), [{ id: 'srv-beta', sudo: false }])
  })
})

/* ------------------------------------------------------------------------ */
/* sudo command line                                                        */
/* ------------------------------------------------------------------------ */

await test('sudo: the passwordless attempt never touches stdin', () => {
  const line = buildSudoCommand('echo hi && uname -a', { interactive: false })
  assert.equal(line, "sudo -n -p '' -- /bin/sh -c 'echo hi && uname -a' < /dev/null")
})

await test('sudo: the password attempt uses -S and keeps the command in sh -c', () => {
  const line = buildSudoCommand("cd '/tmp/x' && echo 'a b'", { interactive: true })
  assert.equal(line, "sudo -S -p '' -- /bin/sh -c 'cd '\\''/tmp/x'\\'' && echo '\\''a b'\\'''")
  assert.equal(line.includes('< /dev/null'), false)
})

await test('sudo: quotes in the command cannot break out of the wrapper', () => {
  const line = buildSudoCommand("echo it's a test", { interactive: true })
  assert.equal(line, "sudo -S -p '' -- /bin/sh -c 'echo it'\\''s a test'")
})

/* ------------------------------------------------------------------------ */
/* browser half                                                             */
/* ------------------------------------------------------------------------ */

/**
 * A miniature React for this bundle's components.
 *
 * It implements the four hooks they use, runs an effect when its dependency
 * list changes, re-renders while state settles, and returns a plain element
 * tree. Enough to prove a surface builds its rows and fields without a browser.
 */
function createHarness() {
  const instances = new Map()
  const stack = []
  const seenProps = new Map()
  let pendingEffects = []
  let dirty = false

  const React = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      const merged = { ...(props || {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const instance = stack[stack.length - 1]
      const index = instance.cursor++
      if (instance.hooks[index] === undefined) {
        instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = instance.hooks[index]
      const setValue = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        dirty = true
      }
      return [slot.value, setValue]
    },
    useEffect(callback, deps) {
      const instance = stack[stack.length - 1]
      const index = instance.cursor++
      const slot = instance.hooks[index] || { deps: undefined }
      instance.hooks[index] = slot
      const changed = slot.deps === undefined
        || deps === undefined
        || deps.length !== slot.deps.length
        || deps.some((value, position) => value !== slot.deps[position])
      if (!changed) return
      slot.deps = deps
      pendingEffects.push(callback)
    },
    useRef(initial) {
      const instance = stack[stack.length - 1]
      const index = instance.cursor++
      if (instance.hooks[index] === undefined) instance.hooks[index] = { value: { current: initial } }
      return instance.hooks[index].value
    },
    useCallback(callback, deps) {
      const instance = stack[stack.length - 1]
      const index = instance.cursor++
      const slot = instance.hooks[index]
      if (slot === undefined) {
        instance.hooks[index] = { deps, fn: callback }
        return callback
      }
      const changed = slot.deps === undefined
        || deps === undefined
        || deps.length !== slot.deps.length
        || deps.some((value, position) => value !== slot.deps[position])
      if (changed) {
        slot.deps = deps
        slot.fn = callback
      }
      return slot.fn
    },
  }

  const label = (type) => (type.name || 'anonymous')

  const mount = (type, props, position) => {
    const key = position + '>' + label(type)
    let instance = instances.get(key)
    if (instance === undefined) {
      instance = { key: label(type), hooks: [], cursor: 0 }
      instances.set(key, instance)
    }
    instance.cursor = 0
    stack.push(instance)
    seenProps.set(label(type), props)
    let element
    try {
      element = type(props)
    } finally {
      stack.pop()
    }
    return expand(element, position + '>' + label(type))
  }

  const expand = (node, position) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) {
      return node.map((child, index) => expand(child, position + '/' + index)).filter((child) => child !== null)
    }
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node.type === 'function') return mount(node.type, node.props || {}, position)
    const props = { ...(node.props || {}) }
    delete props.children
    const tag = typeof node.type === 'string' ? node.type : 'unknown'
    return { type: node.type, props, children: expand((node.props || {}).children, position + '/' + tag) }
  }

  return {
    React,
    propsOf(name) {
      return seenProps.get(name)
    },
    async pump(RootComponent, props) {
      let tree = null
      for (let pass = 0; pass < 25; pass += 1) {
        dirty = false
        tree = expand({ type: RootComponent, props }, 'root')
        const effects = pendingEffects
        pendingEffects = []
        for (const effect of effects) {
          const cleanup = effect()
          if (typeof cleanup === 'function') cleanup()
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!dirty) return tree
      }
      throw new Error('the surface did not settle')
    },
  }
}

/** Copy a value out of the client sandbox realm so deepEqual compares values, not prototypes. */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  texts(node.children, out)
  return out
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') return out
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

/** Load client.js in a sandbox, apply it to a fake plugin context, return its slots. */
async function loadClient() {
  const harness = createHarness()
  const slots = []
  const window = {
    __ModuleLoader__: { load(spec) { window.loaded = spec } },
    innerWidth: 1280,
    innerHeight: 800,
  }
  const document = {
    createElement: () => ({ dataset: {}, remove() {}, textContent: '' }),
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout })
  vm.runInContext(clientSource, context)

  const response = {
    bootstrap: (payload) => ({
      servers: [
        { id: 'srv-alpha', name: 'Alpha', host: '10.0.0.1', port: 22, username: 'root', auth: 'password', keyPath: '', keySource: 'none', resolvedKeyPath: '', keyExists: false, jumpId: '', jumpName: '', note: '', hasPassword: true, hasPassphrase: false, hasSudoPassword: true },
        { id: 'srv-beta', name: 'Beta', host: '10.0.0.2', port: 22, username: 'deploy', auth: 'key', keyPath: '', keySource: 'default', resolvedKeyPath: '~/.ssh/id_ed25519', keyExists: true, jumpId: '', jumpName: '', note: 'staging', hasPassword: false, hasPassphrase: false, hasSudoPassword: false },
      ],
      grants: payload && payload.sessionId === 'session-1' ? [{ id: 'srv-alpha', sudo: true }] : [],
      allowed: payload && payload.sessionId === 'session-1' ? ['srv-alpha'] : [],
      inherited: true,
      sessionId: payload ? payload.sessionId : '',
    }),
    'session.set': (payload) => ({ grants: payload.grants, allowed: payload.grants.map((grant) => grant.id), sessionId: payload.sessionId }),
  }

  const calls = []
  const connection = {
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ endpoint, payload })
        const handler = response[endpoint]
        if (handler === undefined) return { ok: false, error: { code: 'unknown-endpoint', message: endpoint } }
        return { ok: true, value: handler(payload) }
      },
    },
  }

  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: { register() {} },
    get(name) {
      return name === 'connection' ? connection : undefined
    },
    slots: {
      inject(_name, fn) {
        fn()
      },
      register(spec, Component) {
        slots.push({ spec, Component })
      },
    },
  }

  const plugin = window.loaded.factory((name) => {
    if (name === 'react') return harness.React
    return {}
  })
  plugin.apply(ctx)
  return { harness, slots, calls }
}

await test('client: the settings page renders the sudo password field and badge', async () => {
  const { harness, slots } = await loadClient()
  const settings = slots.find((entry) => entry.spec.name === 'settings.section')
  assert.ok(settings, 'no settings.section slot was registered')
  const t = (key) => key
  let tree = await harness.pump(settings.Component, { t })

  // The catalog row for a server with a saved sudo password carries the badge.
  assert.ok(texts(tree).includes('settings.badgeSudo'), 'the sudo badge is missing from the server row')

  const addButton = findAll(tree, (node) => node.type === 'button' && texts(node.children).includes('settings.add'))[0]
  assert.ok(addButton, 'the add-server button is missing')
  addButton.props.onClick()
  tree = await harness.pump(settings.Component, { t })

  const all = texts(tree)
  assert.ok(all.includes('settings.sudo'), 'the sudo password label is missing from the form')
  assert.ok(all.includes('settings.sudoHint'), 'the sudo password hint is missing from the form')
  const passwordInputs = findAll(tree, (node) => node.type === 'input' && node.props.type === 'password')
  assert.ok(passwordInputs.length >= 1, 'no password input was rendered')
})

await test('client: the conversation menu renders a sudo pill per open server', async () => {
  const { harness, slots } = await loadClient()
  const t = (key) => key
  const settings = slots.find((entry) => entry.spec.name === 'settings.section')
  await harness.pump(settings.Component, { t })
  const menuStore = harness.propsOf('SettingsSection').menuStore
  assert.ok(menuStore, 'the shared menu store was not passed down')
  menuStore.open({ top: 40, right: 320, bottom: 68, left: 120 }, 'session-1')

  const overlay = slots.find((entry) => entry.spec.name === 'shell.overlay')
  assert.ok(overlay, 'no shell.overlay slot was registered')
  const tree = await harness.pump(overlay.Component, { t })

  const all = texts(tree)
  assert.ok(all.includes('Alpha') && all.includes('Beta'), 'the server rows are missing')
  assert.ok(all.includes('menu.sudo'), 'the sudo pill is missing')
  assert.ok(all.includes('menu.inherited'), 'the inherited-grant note is missing for an inherited menu')
  const pills = findAll(tree, (node) => node.type === 'button' && node.props.className === 'rssh-sudo')
  assert.equal(pills.length, 1, 'exactly the open server should offer a sudo pill')
  assert.equal(pills[0].props['data-on'], 'true')
})

await test('client: opening a server and toggling sudo write the expected grants', async () => {
  const { harness, slots, calls } = await loadClient()
  const t = (key) => key
  const settings = slots.find((entry) => entry.spec.name === 'settings.section')
  await harness.pump(settings.Component, { t })
  const menuStore = harness.propsOf('SettingsSection').menuStore
  menuStore.open({ top: 40, right: 320, bottom: 68, left: 120 }, 'session-1')
  const overlay = slots.find((entry) => entry.spec.name === 'shell.overlay')
  let tree = await harness.pump(overlay.Component, { t })

  const rowOf = (node) => findAll(node, (candidate) => candidate.type === 'div' && candidate.props.className === 'rssh-optrow')
  // Alpha starts open with sudo, Beta starts closed: the bootstrap answer.
  let rows = rowOf(tree)
  assert.equal(findAll(rows[0], (node) => node.props.className === 'rssh-sudo').length, 1)
  assert.equal(findAll(rows[1], (node) => node.props.className === 'rssh-sudo').length, 0)

  // Open Beta: it joins the grant list with sudo off.
  findAll(rows[1], (node) => node.props.role === 'menuitemcheckbox')[0].props.onClick()
  tree = await harness.pump(overlay.Component, { t })
  const afterOpen = calls.filter((call) => call.endpoint === 'session.set').at(-1)
  assert.deepEqual(plain(afterOpen.payload.grants), [{ id: 'srv-alpha', sudo: true }, { id: 'srv-beta', sudo: false }])
  assert.deepEqual(plain(afterOpen.payload.allowed), ['srv-alpha', 'srv-beta'])
  assert.equal(afterOpen.payload.sessionId, 'session-1')

  // Turn sudo on for Beta.
  rows = rowOf(tree)
  findAll(rows[1], (node) => node.props.className === 'rssh-sudo')[0].props.onClick()
  tree = await harness.pump(overlay.Component, { t })
  const afterSudo = calls.filter((call) => call.endpoint === 'session.set').at(-1)
  assert.deepEqual(plain(afterSudo.payload.grants), [{ id: 'srv-alpha', sudo: true }, { id: 'srv-beta', sudo: true }])
  assert.equal(findAll(rowOf(tree)[1], (node) => node.props.className === 'rssh-sudo')[0].props['data-on'], 'true')

  // Closing Alpha takes its grant — and its sudo permission — away.
  findAll(rowOf(tree)[0], (node) => node.props.role === 'menuitemcheckbox')[0].props.onClick()
  await harness.pump(overlay.Component, { t })
  const afterClose = calls.filter((call) => call.endpoint === 'session.set').at(-1)
  assert.deepEqual(plain(afterClose.payload.grants), [{ id: 'srv-beta', sudo: true }])
})

/* ------------------------------------------------------------------------ */
/* sudo over a real SSH channel, against an in-process ssh2 server           */
/* ------------------------------------------------------------------------ */

/**
 * A local ssh2 server that emulates the three sudo behaviours worth testing:
 * a password-protected rule, a NOPASSWD rule, and a wrong password.
 *
 * The important part is what it records: the exact command line and the bytes
 * that arrived on stdin. That is how the tests prove the saved password never
 * appears in the command.
 */
async function startSudoServer({ passwordRule }) {
  const ssh2 = await import('ssh2')
  const { Server } = ssh2.default ?? ssh2
  const { generateKeyPairSync } = await import('node:crypto')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const seen = []
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.password === 'login-secret') context.accept()
      else context.reject()
    })
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('exec', (acceptExec, _rejectExec, info) => {
          const command = info.command
          const record = { command, stdin: '' }
          seen.push(record)
          const stream = acceptExec()
          let finished = false
          const finish = (code, stdout, stderr) => {
            if (finished) return
            finished = true
            if (stdout !== '') stream.write(stdout)
            if (stderr !== '') stream.stderr.write(stderr)
            stream.exit(code)
            stream.end()
          }
          stream.on('data', (chunk) => {
            record.stdin += chunk.toString('utf8')
          })
          const decide = () => {
            if (command.includes('sudo -S')) {
              const supplied = record.stdin.split(/[\r\n]/)[0]
              if (supplied === passwordRule.sudo) finish(0, 'uid=0(root) gid=0(root)\n', '')
              else finish(1, '', 'Sorry, try again.\nsudo: 1 incorrect password attempt\n')
              return
            }
            if (command.includes('sudo -n')) {
              if (passwordRule.nopasswd === true) {
                // sudo authenticated (or needed no password) and ran the command:
                // its own outcome is the answer, whatever that outcome is.
                const outcome = passwordRule.nopasswdResult ?? { code: 0, stdout: 'uid=0(root) gid=0(root)\n', stderr: '' }
                finish(outcome.code, outcome.stdout ?? '', outcome.stderr ?? '')
                return
              }
              // The wording differs per sudo implementation and locale, which is
              // exactly what the transport must not depend on.
              finish(1, '', passwordRule.denial ?? 'sudo: a password is required\n')
              return
            }
            finish(0, 'plain:' + command + '\n', '')
          }
          if (command.includes('sudo -S')) {
            stream.on('end', decide)
            stream.on('close', decide)
          } else {
            decide()
          }
        })
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const SUDO_PASSWORD = 'sd0-p@ss word'

await test('sudo: a password-protected host runs through -S and the password only on stdin', async () => {
  const { execCommand } = await import('../lib/ssh.js')
  const fake = await startSudoServer({ passwordRule: { sudo: SUDO_PASSWORD } })
  try {
    const target = { host: '127.0.0.1', port: fake.port, username: 'root', auth: { kind: 'password', password: 'login-secret' } }
    const result = await execCommand(target, 'id -u', { timeoutMs: 10_000, sudo: { password: SUDO_PASSWORD } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.elevated, true)
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /uid=0/)
    assert.equal(fake.seen.length, 2, 'expected the passwordless probe then the password run')
    assert.match(fake.seen[0].command, /sudo -n/)
    assert.match(fake.seen[1].command, /sudo -S/)
    for (const record of fake.seen) {
      assert.equal(record.command.includes(SUDO_PASSWORD), false, 'the password reached the command line')
    }
    assert.equal(fake.seen[0].stdin, '', 'the passwordless probe must not receive the password')
    assert.equal(fake.seen[1].stdin, SUDO_PASSWORD + '\n')
  } finally {
    await fake.close()
  }
})

await test('sudo: a NOPASSWD rule runs once, with no password written anywhere', async () => {
  const { execCommand } = await import('../lib/ssh.js')
  const fake = await startSudoServer({ passwordRule: { sudo: SUDO_PASSWORD, nopasswd: true } })
  try {
    const target = { host: '127.0.0.1', port: fake.port, username: 'root', auth: { kind: 'password', password: 'login-secret' } }
    const result = await execCommand(target, 'id -u', { timeoutMs: 10_000, sudo: { password: SUDO_PASSWORD } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.elevated, true)
    assert.match(result.stdout, /uid=0/)
    assert.equal(fake.seen.length, 1)
    assert.equal(fake.seen[0].command.includes(SUDO_PASSWORD), false)
    assert.equal(fake.seen[0].stdin, '')
  } finally {
    await fake.close()
  }
})

await test('sudo: no saved password fails cleanly without writing anything', async () => {
  const { execCommand } = await import('../lib/ssh.js')
  const fake = await startSudoServer({ passwordRule: { sudo: SUDO_PASSWORD } })
  try {
    const target = { host: '127.0.0.1', port: fake.port, username: 'root', auth: { kind: 'password', password: 'login-secret' } }
    const result = await execCommand(target, 'id -u', { timeoutMs: 10_000, sudo: true })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'sudo-password-missing')
    assert.equal(fake.seen.length, 1)
    assert.equal(fake.seen[0].command.includes('sudo -S'), false)
  } finally {
    await fake.close()
  }
})

await test('sudo: a wrong password reports sudo stderr and leaks nothing', async () => {
  const { execCommand } = await import('../lib/ssh.js')
  const fake = await startSudoServer({ passwordRule: { sudo: SUDO_PASSWORD } })
  try {
    const target = { host: '127.0.0.1', port: fake.port, username: 'root', auth: { kind: 'password', password: 'login-secret' } }
    const result = await execCommand(target, 'id -u', { timeoutMs: 10_000, sudo: { password: 'wrong-password' } })
    assert.equal(result.ok, true)
    assert.equal(result.elevated, true)
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /incorrect password/)
    assert.equal(result.stdout.includes('wrong-password'), false)
    assert.equal(result.stderr.includes('wrong-password'), false)
    for (const record of fake.seen) assert.equal(record.command.includes('wrong-password'), false)
  } finally {
    await fake.close()
  }
})

for (const [label, denial] of [
  ['classic sudo in a Chinese locale', 'sudo: 需要密码\n'],
  ['sudo-rs', 'sudo: interactive authentication is required\n'],
  ['classic sudo with no tty', 'sudo: no tty present and no askpass program specified\n'],
]) {
  await test(`sudo: a refusal from ${label} still reaches the password path`, async () => {
    const { execCommand } = await import('../lib/ssh.js')
    const fake = await startSudoServer({ passwordRule: { sudo: SUDO_PASSWORD, denial } })
    try {
      const target = { host: '127.0.0.1', port: fake.port, username: 'root', auth: { kind: 'password', password: 'login-secret' } }
      const result = await execCommand(target, 'id -u', { timeoutMs: 10_000, sudo: { password: SUDO_PASSWORD } })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.elevated, true)
      assert.match(result.stdout, /uid=0/)
      assert.equal(fake.seen.length, 2, 'expected the probe and then the password run')
      assert.match(fake.seen[1].command, /sudo -S/)
      for (const record of fake.seen) assert.equal(record.command.includes(SUDO_PASSWORD), false)
      assert.equal(fake.seen[1].stdin, SUDO_PASSWORD + '\n')
    } finally {
      await fake.close()
    }
  })
}

await test('sudo: a command that ran and failed is not retried', async () => {
  const { execCommand } = await import('../lib/ssh.js')
  const fake = await startSudoServer({
    passwordRule: {
      sudo: SUDO_PASSWORD,
      nopasswd: true,
      nopasswdResult: { code: 1, stdout: '', stderr: 'boom\n' },
    },
  })
  try {
    const target = { host: '127.0.0.1', port: fake.port, username: 'root', auth: { kind: 'password', password: 'login-secret' } }
    const result = await execCommand(target, 'ls /missing', { timeoutMs: 10_000, sudo: { password: SUDO_PASSWORD } })
    assert.equal(result.ok, true)
    assert.equal(result.elevated, true)
    assert.equal(result.exitCode, 1)
    assert.equal(result.stderr, 'boom\n')
    assert.equal(fake.seen.length, 1, 'sudo ran the command, so there is nothing to retry')
    assert.equal(fake.seen[0].stdin, '')
  } finally {
    await fake.close()
  }
})

await test('sudo: a plain command is untouched (no elevation, one exec)', async () => {
  const { execCommand } = await import('../lib/ssh.js')
  const fake = await startSudoServer({ passwordRule: { sudo: SUDO_PASSWORD } })
  try {
    const target = { host: '127.0.0.1', port: fake.port, username: 'root', auth: { kind: 'password', password: 'login-secret' } }
    const result = await execCommand(target, 'echo hi', { timeoutMs: 10_000 })
    assert.equal(result.ok, true)
    assert.equal(result.elevated, false)
    assert.equal(fake.seen.length, 1)
    assert.equal(fake.seen[0].command, 'echo hi')
  } finally {
    await fake.close()
  }
})


/* ------------------------------------------------------------------------ */
/* host half, end to end: apply -> tool gate -> ssh_exec with sudo -> RPC    */
/* ------------------------------------------------------------------------ */

/**
 * Drive the real host half: a fake Cordis context, a fake credential store,
 * fake session headers for the delegation chain, and the in-process SSH server.
 *
 * This is the test that covers the wiring the browser and the model actually
 * hit: tool registration and its per-step gate, grant inheritance, the sudo
 * password travelling from the credential store to the SSH channel, and the
 * RPC endpoints the page calls.
 */
async function startHost({ home }) {
  const { apply } = await import('../index.js')
  const registered = []
  const records = new Map()
  const headers = { 'session-child': { parentSession: 'session-1' } }

  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined && next !== null) records.set(key, next)
      return next
    },
    async deleteRecord(key) { records.delete(key) },
  }
  const sessions = {
    get(id) {
      const header = headers[id]
      return header === undefined ? undefined : { header: { id, ...header } }
    },
  }
  let handler = null
  const ctx = {
    // The plugin injects `webServer` and then reads it as a property.
    webServer: {
      register: (spec) => {
        // Resolve once the plugin actually replies, so the test can read the body.
        handler = (req, res) => new Promise((resolve) => {
          const finish = res.end.bind(res)
          res.end = (body) => {
            finish(body)
            resolve()
          }
          spec.handler(req, res)
        })
        return () => {}
      },
    },
    effect(fn) { return fn() },
    inject(_names, fn) {
      fn(ctx)
    },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'sessions') return sessions
      if (name === 'connection') return { admit: () => ({}) }
      if (name === 'webServer') {
        return { register: (spec) => { handler = spec.handler; return () => {} } }
      }
      return undefined
    },
    tools: {
      register(definition, options) {
        registered.push({ definition, options })
        return () => {}
      },
    },
  }
  apply(ctx)

  const callRpc = async (endpoint, payload) => {
    const listeners = new Map()
    const req = {
      method: 'POST',
      url: '/remote-ssh/' + endpoint,
      headers: { 'content-type': 'application/json' },
      on(event, fn) { listeners.set(event, fn); return req },
      destroy() {},
    }
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(body) { this.body = body },
    }
    const running = handler(req, res)
    listeners.get('data')(Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload }), 'utf8'))
    listeners.get('end')()
    await running
    return res.body === '' ? null : JSON.parse(res.body)
  }

  return {
    registered,
    callRpc,
    tool(name) { return registered.find((entry) => entry.definition.name === name) },
  }
}

await test('host: the gate follows the grant and the delegation chain', async () => {
  await withHome(async (home) => {
    const host = await startHost({ home })
    const exec = host.tool('ssh_exec')
    assert.ok(exec, 'ssh_exec is not registered')
    assert.equal(exec.options.when({ agent: { id: 'session-1' } }), false, 'a session with no grant sees the tool')

    const saved = await host.callRpc('servers.save', {
      server: { name: 'Alpha', host: '127.0.0.1', port: 22, username: 'root', auth: 'password' },
      password: 'login-secret',
      sudoPassword: 'sd0-p@ss word',
    })
    assert.equal(saved.result.ok, true, JSON.stringify(saved))
    const savedId = saved.result.value.savedId
    assert.equal(saved.result.value.servers[0].hasSudoPassword, true)
    assert.equal(saved.result.value.servers[0].hasPassword, true)

    const granted = await host.callRpc('session.set', { sessionId: 'session-1', grants: [{ id: savedId, sudo: true }] })
    assert.deepEqual(granted.result.value.grants, [{ id: savedId, sudo: true }])

    // The conversation itself now sees the tools.
    assert.equal(exec.options.when({ agent: { id: 'session-1' } }), true)
    // Its subagent has no grants of its own but inherits them.
    assert.equal(exec.options.when({ agent: { id: 'session-child' } }), true)
    // An unrelated conversation still sees nothing.
    assert.equal(exec.options.when({ agent: { id: 'session-other' } }), false)

    const bootstrap = await host.callRpc('bootstrap', { sessionId: 'session-child' })
    assert.deepEqual(bootstrap.result.value.grants, [{ id: savedId, sudo: true }])
    assert.equal(bootstrap.result.value.inherited, true)
    const own = await host.callRpc('bootstrap', { sessionId: 'session-1' })
    assert.equal(own.result.value.inherited, false)
  })
})

await test('host: ssh_exec runs a subagent command as root without exposing the password', async () => {
  const fake = await startSudoServer({ passwordRule: { sudo: 'sd0-p@ss word' } })
  try {
    await withHome(async (home) => {
      const host = await startHost({ home })
      const saved = await host.callRpc('servers.save', {
        server: { name: 'Alpha', host: '127.0.0.1', port: fake.port, username: 'root', auth: 'password' },
        password: 'login-secret',
        sudoPassword: 'sd0-p@ss word',
      })
      const savedId = saved.result.value.savedId
      await host.callRpc('session.set', { sessionId: 'session-1', grants: [{ id: savedId, sudo: true }] })

      const listed = await host.tool('ssh_servers').definition.execute({}, { agent: { id: 'session-child' } })
      assert.equal(listed.servers.length, 1, JSON.stringify(listed))
      assert.equal(listed.servers[0].sudo, true)
      assert.match(listed.summary, /sudo: enabled/)

      const elevated = await host.tool('ssh_exec').definition.execute(
        { server: 'Alpha', command: 'id -u', sudo: true },
        { agent: { id: 'session-child' } },
      )
      assert.equal(elevated.ok, true, JSON.stringify(elevated))
      assert.equal(elevated.sudo, true)
      assert.match(elevated.stdout, /uid=0/)
      assert.match(elevated.summary, /sudo/)
      assert.equal(JSON.stringify(elevated).includes('sd0-p@ss word'), false, 'the sudo password leaked into the tool result')
      assert.equal(fake.seen.length, 2)
      assert.equal(fake.seen[1].stdin, 'sd0-p@ss word\n')
      for (const record of fake.seen) assert.equal(record.command.includes('sd0-p@ss word'), false)

      // The same conversation, but with sudo off: the model cannot elevate.
      await host.callRpc('session.set', { sessionId: 'session-1', grants: [{ id: savedId, sudo: false }] })
      const refused = await host.tool('ssh_exec').definition.execute(
        { server: 'Alpha', command: 'id -u', sudo: true },
        { agent: { id: 'session-child' } },
      )
      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'sudo-not-allowed')
    })
  } finally {
    await fake.close()
  }
})

await test('host: a sudo password cannot contain a newline', async () => {
  await withHome(async (home) => {
    const host = await startHost({ home })
    const rejected = await host.callRpc('servers.save', {
      server: { name: 'Alpha', host: '127.0.0.1', port: 22, username: 'root', auth: 'password' },
      password: 'login-secret',
      sudoPassword: 'two\nlines',
    })
    assert.equal(rejected.result.ok, false)
    assert.equal(rejected.result.error.code, 'sudo-password-invalid')
  })
})

/* ------------------------------------------------------------------------ */

const passed = results.filter((result) => result.ok).length
const failed = results.length - passed
console.log('\n' + passed + '/' + results.length + ' passed')
for (const result of results) {
  if (!result.ok) console.log('  failed: ' + result.name)
}
process.exitCode = failed === 0 ? 0 : 1
