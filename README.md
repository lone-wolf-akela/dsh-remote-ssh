# dsh-remote-ssh

A DeepSeek Harness bundle that gives the agent SSH: a catalog of servers you
maintain in Settings, a per-conversation switch for which of them that
conversation may use — and on which of those it may run commands as root through
sudo — plus three model tools that appear only while something is switched on.

Agents a conversation delegates to inherit its switches, so a teammate created
with `subagent` can use exactly the servers its parent was given.

## What you get

| Surface | Where | What it does |
|---|---|---|
| Settings page | Settings → **Remote SSH** | Add, edit, test and remove SSH servers: name, address, port, user, password **or** private key, optional jump host, an optional **sudo password**, and a note for the agent. |
| Server button | Top right of a conversation's header — and, before its first message, at the right end of the New Session row | Opens a small menu of checkboxes that chooses which servers **this conversation** may use. Each open row also carries a **sudo** pill. The button shows how many are open. |
| `ssh_servers` | model tool | Lists the servers shared with the conversation, sudo included; `probe: true` also connects to each and reports latency and `uname`. |
| `ssh_exec` | model tool | Runs a shell command on a shared server and returns exit code, stdout and stderr. `sudo: true` runs it as root on a server where sudo was enabled. |
| `ssh_transfer` | model tool | Copies one file up or down over SFTP. |

The three tools are **invisible to the model until the conversation has at least
one server open**, and they disappear again when you close the last one — the
tool list is re-resolved on every model step, so a change takes effect on the
very next step of a long conversation in both directions.

**Delegation inherits the switches.** A subagent — a teammate from
`subagent`, a `workflow` agent, an Agent Team member — has no button of its
own, so when a session has no selection of its own the nearest ancestor that has
one answers for it. Opening a teammate's session in the UI shows the inherited
list; changing anything there gives that session its own list, which then
shadows the inherited one.

## Install

Install the bundle straight from the repository:

```
plugin_manager install_bundle github:lone-wolf-akela/dsh-remote-ssh
```

A clone works too — point `install_bundle` at the directory. The bundle is a
package-root Host plugin plus a `dsh.client` browser half, so one Loader row
serves both. It depends on `ssh2`, which is installed with the package; pnpm asks
whether to run two optional build scripts that cannot succeed under Electron, and
the plugin works without them — see [Native dependencies](#native-dependencies-why-ssh2-runs-pure-javascript-here).
Tested on DSH 0.2.2-rc.3 (and 0.2.2-rc.1 before it); the credential-key handling
below is what changed between those two, and `scripts/repair-credentials.mjs`
upgrades records written by 0.1.0.

## Use

1. **Settings → Remote SSH → Add server.** Fill in the name shown to you and to
   the agent, the address, the user name, and either a password or a private key.
   - *Password*: stored as a Harness credential record, never in the plugin's
     state file and never sent back to the browser.
   - *Private key*: leave the path empty to use the usual `~/.ssh` identity
     (`id_ed25519`, `id_ecdsa`, `id_rsa`, `id_dsa`, first one found); type a path
     to override. An optional passphrase is stored like the password.
   - *Jump host*: pick another catalog entry to reach this server through it.
     One hop is supported.
   - *Sudo password* (optional): the password this host's `sudo` asks for. It is
     stored like the login password and is never sent to the model. Leave it
     empty on hosts whose sudo needs no password — passwordless sudo works
     without it.
   - **Test** runs a real connection and reports the round-trip time.
2. **Open a conversation** and press the button at the top right. Check the
   servers the agent may use there. Each conversation keeps its own selection.
   A conversation that has not sent its first message yet has no header chrome
   at all, so the same button waits in its New Session row, right after the
   workspace and agent-preset controls; it moves up into the header with the
   first message.
   For each server you opened, the **sudo** pill next to it decides whether the
   agent may run commands as root there. Off by default; turning it on is a
   per-conversation, per-server decision.
3. Ask the agent to do something on the machine, for example "check the disk
   usage on the router" or "copy this file to /tmp on the router".

## Security model

- **The conversation grant is the boundary.** A tool call re-checks it when it
  runs, so a stale tool schema cannot reach a server you closed.
- **Nothing is shared by default.** A new conversation starts with no servers,
  and a conversation with none sees no SSH tools at all.
- **Secrets stay in the credential store.** `$DSH_HOME/.credentials.yaml` holds
  one `remote-ssh/srv-<hex>` grant record per server with a password; the
  plugin's own state file (`$DSH_HOME/state/dsh-remote-ssh/state.json`) holds only
  addresses, user names and which servers each conversation may use.
  The record id is a **hash of the server id**, never the server id itself: DSH
  validates each credential-key segment against `/^[a-z][a-z0-9-]*$/` when it
  loads the document, so a UUID-shaped id would fail the load and take the whole
  Harness startup with it.
- **The browser calls back through the Harness connection.** The page talks to
  the Host over a `/remote-ssh` route admitted by the Connection service, so it
  carries the same browser credential as the rest of the UI — the plugin adds no
  unauthenticated local endpoint.
- **The grant is inherited, not copied.** A subagent with no selection of its own
  resolves through its creating session, and only a live session in the chain can
  answer — the walk stops at the first ancestor that has a selection, or at the
  top of the chain.
- **Privilege is a second permission inside the grant.** A command runs as the
  configured user unless the model explicitly asks for `sudo` *and* the
  conversation has sudo enabled for that particular server. Both the model's
  choice and the stored grant are re-checked when the call runs, so an
  out-of-date tool schema cannot elevate anything.
- **The model never sees the sudo password.** It is not part of the tool schema,
  never appears in an argument, and is not echoed in a result. See
  [How sudo runs](#how-sudo-runs).

### How sudo runs

When an `ssh_exec` call asks for sudo, the transport does this inside the one
SSH session, and the password exists only on that channel's stdin:

1. **First attempt: `sudo -n` with stdin on `/dev/null`.** On a host with a
   NOPASSWD rule, or one where sudo's timestamp is still cached, the command
   simply runs. Because sudo was told never to prompt, the saved password cannot
   end up in the command's own input.
2. **When sudo itself refuses, a second attempt uses `sudo -S`**, writes the
   saved password plus a newline to stdin, and closes the write side straight
   after. The command itself then sees end-of-file, not the password.
   A refusal is recognised by the diagnostic sudo writes under its own program
   name, which is never translated: `sudo: a password is required`,
   `sudo: 需要密码` and `sudo: interactive authentication is required` (sudo-rs)
   all take the same path, so a localized or sudo-rs host works like any other.
3. **A command that ran and failed is the answer already** — it is never re-run,
   and its own stderr goes back to the model. sudo either authenticates and
   execs, or refuses before the command starts.

The command is wrapped as `sudo ... -- /bin/sh -c '<your command>'` so that pipes
and redirections inside it also run as root. The wrapper is therefore what sudo
authorizes: a host whose sudoers grants specific *binaries* (rather than `ALL`)
will not match, while `ALL=(ALL:ALL) ALL` — the usual case — works. A wrong sudo
password is reported as such, without ever printing the password.

### Known limits

- **Host keys are not verified.** This version accepts any host key
  (`hostVerifier: () => true`). Use it on networks you trust, or pin hosts with
  your own `known_hosts` tooling outside the plugin.
- **One jump hop.** A jump host that itself declares a jump is refused.
- **Command output is capped.** The transport keeps 1 MiB per stream; the model
  sees at most 12 000 characters per stream with an explicit truncation marker.
- **No SFTP for `~`.** Relative remote paths resolve against the remote user's
  home directory; `~/x` is normalized to `x`.
- **Sudo is a shell wrapper.** Only `ssh_exec` can elevate; SFTP transfers always
  run as the login user. Hosts that refuse a tty-less sudo (`requiretty`) or
  grant only named binaries in `sudoers` cannot be elevated this way.
- **`ssh2` serves the connection.** Servers with strict `Match`/`ForceCommand`
  policies or unusual authentication (hardware tokens, keyboard-interactive
  challenge chains) may not work.

## Native dependencies (why ssh2 runs pure JavaScript here)

`ssh2` declares two optional native accelerators. Neither is required — the
transport falls back to pure JavaScript and everything works — but installing from
a git URL surfaces both, and the first error is misleading.

1. **pnpm refuses the build scripts.** `install_bundle` answers
   `ERR_PNPM_IGNORED_BUILDS: cpu-features@0.0.10, ssh2@1.17.0` and rolls the
   install back. Approve them (`approvedBuilds`); the approval is remembered for
   the profile.
2. **Both builds then fail with**
   `gyp: name 'enable_thin_lto' is not defined while evaluating condition 'enable_thin_lto=="true"'`.
   Root cause, confirmed on DSH 0.2.2-rc.3 (Electron 44.7.0):
   - Node 24's `common.gypi` evaluates `enable_thin_lto` inside its
     `msvc_settings` block, and gyp hard-fails on an undefined variable in a
     condition — which is why this only breaks Windows.
   - The variable is defined only by the headers' own `config.gypi`.
   - node-gyp reads that file only when `--nodedir`/`--dist-url` is given;
     otherwise it generates the project's `config.gypi` from the `process.config`
     of the process running node-gyp — here Electron, whose `variables` carry
     `enable_lto` but no `enable_thin_lto`/`lto_jobs`.
   - Proof: the same `node-gyp configure` with `--nodedir=<node-gyp cache>/24.21.0`
     succeeds.
3. **A successful build must also match Electron's ABI.** Electron 44.7.0 is
   `NODE_MODULE_VERSION` 149, while the downloaded Node headers are a different
   ABI, so `cpu-features` loads only when it is compiled against *Electron*
   headers:

   ```
   node-gyp configure build --dist-url=https://artifacts.electronjs.org/headers/dist \
     --target=44.7.0 --arch=x64        # target = process.versions.electron
   ```

   That works, and still buys nothing: `ssh2` consults `cpu-features` only when
   its native crypto binding is available (`lib/protocol/constants.js`).
4. **The crypto binding cannot be built for Electron at all.** Its
   `src/binding.cc` includes `<openssl/evp.h>`, `<openssl/hmac.h>` and
   `<openssl/err.h>`. Electron's header bundle ships no `openssl/` directory
   (Electron uses BoringSSL), so the compile stops at
   `C1083: cannot open include file: 'openssl/configuration.h'`. Node's headers do
   ship `openssl/`, so building against them compiles — but that produces a
   Node-ABI module (the binding uses NAN, not N-API, so it is ABI-bound), and
   Electron's BoringSSL is not ABI-compatible with the OpenSSL it was compiled
   against. There is no ABI-stable route around this.

**The expected state under Electron is therefore pure-JS crypto.** It is what this
plugin is tested with: correctness is unaffected, and only large transfers pay a
CPU cost. A pnpm log line saying `Failed to build optional crypto binding` is this,
and it is harmless.

**Silencing the noise.** Approving the scripts (`true` in the profile's
`pnpm-workspace.yaml` under `allowBuilds`) makes pnpm *run* them on every install
pass that touches the package, so the same gyp failure reappears whenever another
plugin is installed. Declare them declined instead: pnpm then skips them without
building and without the ignored-builds error.

```yaml
# <profile>/pnpm-workspace.yaml
allowBuilds:
  cpu-features@0.0.10: false
  ssh2@1.17.0: false
```

The keys are version-pinned, so a dependency bump brings the gate back once;
setting the new version to `false` settles it again.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Harness will not start after an upgrade: `startup failed: 1 required plugin did not activate`, `Failed plugins: credentials`, `credential key segment "…" must match /^[a-z][a-z0-9-]*$/` | A record written by version 0.1.0 is still on disk. Quit DSH, run `node scripts/repair-credentials.mjs` (dry run), then `--write`; it re-keys those records to the new `remote-ssh/srv-<hex>` form, keeps the passwords, and backs the file up first. See [Upgrading](#upgrading) below. |
| The server button is missing | The plugin row must be active; check Plugins → Installed. In a Session that has not sent a message yet it is in the New Session row, not the header — the Harness hides the whole header chrome while a Session is blank. |
| "No password is saved for this server" | Edit the server and enter a password; **Test** reports the same failure. |
| "No usable private key was found" | The settings row shows a *key file missing* badge; set the key path explicitly. |
| Unexpected RPC errors | `$DSH_HOME/state/dsh-remote-ssh/host.log` records activation, saved servers and RPC failures. |
| Install stops at `ERR_PNPM_IGNORED_BUILDS` and rolls back | pnpm is waiting for build-script approval; approve `ssh2` and `cpu-features` when asked. See [Native dependencies](#native-dependencies-why-ssh2-runs-pure-javascript-here). |
| pnpm log shows `enable_thin_lto is not defined` or `Failed to build optional crypto binding` | Expected on Windows under Electron, and harmless: the plugin runs with pure-JS crypto. See [Native dependencies](#native-dependencies-why-ssh2-runs-pure-javascript-here). |

## Upgrading

Version 0.2.0 changes how a password is addressed in the credential store, because
DSH 0.2.2-rc.3 began validating every credential-key segment while loading
`.credentials.yaml`. Records written by 0.1.0 (`remote-ssh/<uuid>`) make the
credential provider fail, which makes `connection` fail, which refuses the whole
startup:

```
dsh: startup failed: 1 required plugin did not activate
Failed plugins: credentials (@deepseek-ai/dsh-credentials-local)
TypeError: credential key segment "024bd1a5-…" must match /^[a-z][a-z0-9-]*$/
```

Repair with DSH quit:

```bash
node scripts/repair-credentials.mjs           # report only: what would be re-keyed
node scripts/repair-credentials.mjs --write   # back up .credentials.yaml, then migrate
```

Version 0.3.0 adds the sudo password and the per-server sudo flag. There is
nothing to migrate: a version 1 `state.json` loads unchanged and is rewritten as
version 2 on the next save, and the credential record simply gains an optional
`sudoPassword` field beside `password`/`passphrase`.

The script maps each old record onto the id the plugin now derives from its own
`state.json` (`sha256(serverId)` → `srv-<16 hex>`), preserves the payload verbatim,
reports records whose server no longer exists instead of guessing, and prints the
backup path. `--delete-unknown` drops those orphans instead of re-keying them.
Nothing in `state.json` or in a conversation's selection needs to change.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: tool registration and gating, the `/remote-ssh` RPC route, endpoint dispatch. |
| `lib/state.js` | Durable catalog and per-conversation grants (atomic JSON). |
| `lib/secrets.js` | Credential records (legal `srv-<hex>` slot derivation), `~` expansion, private-key resolution. |
| `lib/targets.js` | Catalog record → connection target (secrets, key file, jump chain). |
| `lib/ssh.js` | `ssh2` transport: exec, upload, download, probe, jump host, timeouts, abort. |
| `client.js` | Browser half: settings page, the server button in both of its seats, popover. |
| `scripts/repair-credentials.mjs` | Migrates 0.1.0 credential records after the DSH upgrade. |
| `test/ssh.test.mjs` | Transport tests against a real host (`node test/ssh.test.mjs`). |
| `test/unit.test.mjs` | Offline tests: the grant document, delegation inheritance, the sudo command line, sudo over an in-process `ssh2` server, and a render of both browser surfaces (`node test/unit.test.mjs`). |
