# dsh-remote-ssh

A DeepSeek Harness bundle that gives the agent SSH: a catalog of servers you
maintain in Settings, a per-conversation switch for which of them that
conversation may use, and three model tools that appear only while something is
switched on.

## What you get

| Surface | Where | What it does |
|---|---|---|
| Settings page | Settings → **Remote SSH** | Add, edit, test and remove SSH servers: name, address, port, user, password **or** private key, optional jump host, and a note for the agent. |
| Header button | Top right of every conversation | Opens a small menu of checkboxes that chooses which servers **this conversation** may use. The button shows how many are open. |
| `ssh_servers` | model tool | Lists the servers shared with the conversation; `probe: true` also connects to each and reports latency and `uname`. |
| `ssh_exec` | model tool | Runs a shell command on a shared server and returns exit code, stdout and stderr. |
| `ssh_transfer` | model tool | Copies one file up or down over SFTP. |

The three tools are **invisible to the model until the conversation has at least
one server open**, and they disappear again when you close the last one — the
tool list is re-resolved on every model step, so a change takes effect on the
very next step of a long conversation in both directions.

## Install

Install the bundle straight from the repository:

```
plugin_manager install_bundle github:lone-wolf-akela/dsh-remote-ssh
```

A clone works too — point `install_bundle` at the directory. The bundle is a
package-root Host plugin plus a `dsh.client` browser half, so one Loader row
serves both. It depends on `ssh2`, which is installed with the package.
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
   - **Test** runs a real connection and reports the round-trip time.
2. **Open a conversation** and press the button at the top right. Check the
   servers the agent may use there. Each conversation keeps its own selection.
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
- **Every command runs as the configured user.** There is no privilege
  escalation, no shell wrapper, and no rewriting of what you ask for.

### Known limits

- **Host keys are not verified.** This version accepts any host key
  (`hostVerifier: () => true`). Use it on networks you trust, or pin hosts with
  your own `known_hosts` tooling outside the plugin.
- **One jump hop.** A jump host that itself declares a jump is refused.
- **Command output is capped.** The transport keeps 1 MiB per stream; the model
  sees at most 12 000 characters per stream with an explicit truncation marker.
- **No SFTP for `~`.** Relative remote paths resolve against the remote user's
  home directory; `~/x` is normalized to `x`.
- **`ssh2` serves the connection.** Servers with strict `Match`/`ForceCommand`
  policies or unusual authentication (hardware tokens, keyboard-interactive
  challenge chains) may not work.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Harness will not start after an upgrade: `startup failed: 1 required plugin did not activate`, `Failed plugins: credentials`, `credential key segment "…" must match /^[a-z][a-z0-9-]*$/` | A record written by version 0.1.0 is still on disk. Quit DSH, run `node scripts/repair-credentials.mjs` (dry run), then `--write`; it re-keys those records to the new `remote-ssh/srv-<hex>` form, keeps the passwords, and backs the file up first. See [Upgrading](#upgrading) below. |
| The header button is missing | The plugin row must be active; check Plugins → Installed. |
| "No password is saved for this server" | Edit the server and enter a password; **Test** reports the same failure. |
| "No usable private key was found" | The settings row shows a *key file missing* badge; set the key path explicitly. |
| Unexpected RPC errors | `$DSH_HOME/state/dsh-remote-ssh/host.log` records activation, saved servers and RPC failures. |

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
| `client.js` | Browser half: settings page, header button, popover. |
| `scripts/repair-credentials.mjs` | Migrates 0.1.0 credential records after the DSH upgrade. |
| `test/ssh.test.mjs` | Transport tests against a real host (`node test/ssh.test.mjs`). |
