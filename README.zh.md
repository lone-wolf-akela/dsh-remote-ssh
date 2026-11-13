# dsh-remote-ssh

给 DeepSeek Harness 里的 AI 装上 SSH：在设置里维护一份服务器清单，按对话决定把哪几台开放给它，配套的三个工具只在你开放了服务器之后才出现。

## 功能一览

| 位置 | 在哪 | 做什么 |
|---|---|---|
| 设置页 | 设置 → **远程 SSH** | 增删改查 SSH 服务器：名称、地址、端口、用户名、密码**或**私钥、可选跳板机、以及一句给 AI 的备注；还可以一键「测试连接」。 |
| 标题栏按钮 | 每个对话右上角 | 点开一个小菜单，勾选**本对话**可以访问哪些服务器，按钮上显示已开放的数量。 |
| `ssh_servers` | 模型工具 | 列出本对话可用的服务器；加 `probe: true` 会逐台真实连接，报告延迟与 `uname`。 |
| `ssh_exec` | 模型工具 | 在指定服务器上执行一条 shell 命令，返回退出码、stdout、stderr。 |
| `ssh_transfer` | 模型工具 | 通过 SFTP 在本地与远端之间上传或下载单个文件。 |

这三个工具在**本对话没有任何已开放服务器时对模型完全不可见**；关掉最后一台后它们会再次消失。工具列表在模型的每一步都会重新解析，所以对话进行到一半再改开放列表，下一步就生效（打开、关闭都是）。

## 安装

直接从仓库安装：

```
plugin_manager install_bundle github:lone-wolf-akela/dsh-remote-ssh
```

也可以把 `install_bundle` 指向本地 clone 的目录。这是一个「包根插件」：Host 半边加一个 `dsh.client` 浏览器半边，一个 Loader 条目同时提供两者。它依赖 `ssh2`，随包一起安装。已在 DSH 0.2.2-rc.3（以及之前的 0.2.2-rc.1）上验证；两版之间变的是下面这段凭据键处理，`scripts/repair-credentials.mjs` 可以把 0.1.0 写下的记录迁移过来。

## 使用

1. **设置 → 远程 SSH → 添加服务器**。填写显示给你和 AI 的名称、地址、用户名，然后选密码或私钥：
   - **密码**：作为 Harness 凭据记录保存，不写入插件的状态文件，也不会回传给浏览器。
   - **私钥**：路径留空就自动使用 `~/.ssh` 下的默认私钥（`id_ed25519`、`id_ecdsa`、`id_rsa`、`id_dsa`，取第一个存在的）；也可以手动指定。私钥口令同样按凭据保存。
   - **跳板机**：从清单里选另一台服务器作为跳板，最多一跳。
   - **测试连接**：真实发起一次连接并报告耗时。
2. **打开一个对话**，点右上角的按钮，勾选这个对话允许 AI 使用的服务器。每个对话的勾选互相独立。
3. 直接让 AI 干活，例如「看看路由器磁盘占用」「把这个文件拷到路由器的 /tmp 下」。

## 安全模型

- **「对话级授权」就是边界。** 每次工具调用都会重新校验一次，所以过期的工具描述也没法碰到你已经关掉的服务器。
- **默认什么都不开放。** 新对话一开始没有任何服务器，自然也就没有这些工具。
- **密码只进凭据库。** `$DSH_HOME/.credentials.yaml` 里每台服务器一条 `remote-ssh/srv-<hex>` 记录；插件自己的状态文件 `$DSH_HOME/state/dsh-remote-ssh/state.json` 只有地址、用户名和各对话的授权列表。
  记录的 id 是**服务器 id 的哈希**，而不是服务器 id 本身：DSH 载入凭据文件时会逐段校验 `<scope>/<id>` 是否匹配 `/^[a-z][a-z0-9-]*$/`，UUID 形状的 id 会让整个文档载入失败，并连带把 Harness 启动一起拖垮。
- **浏览器走 Harness 自己的连接层。** 页面通过 `/remote-ssh` 这条由 Connection 服务鉴权的路由访问主进程，和 UI 其余部分使用同一份浏览器凭据，插件没有额外开一个无需鉴权的本地端口。
- **命令以你配置的用户身份执行。** 没有提权，没有额外的 shell 包装，也不改写你写下的命令。

### 已知限制

- **不校验主机密钥。** 当前版本接受任何 host key（`hostVerifier: () => true`）。请只在可信网络里使用，或自行在外部用 `known_hosts` 管控。
- **只支持一级跳板。** 跳板机本身再配置跳板会被拒绝。
- **输出有上限。** 传输层每条流保留 1 MiB，模型最多看到 12 000 字符，并明确标注被截断。
- **远端相对路径相对于家目录。** `~/x` 会被规范成 `x`。
- **依赖 `ssh2`。** 使用严格 `Match`/`ForceCommand` 策略或特殊认证（硬件令牌、多轮键盘交互）的服务器可能不适用。

## 排查

| 现象 | 检查 |
|---|---|
| 升级后 Harness 起不来：`startup failed: 1 required plugin did not activate`、`Failed plugins: credentials`、`credential key segment "…" must match /^[a-z][a-z0-9-]*$/` | 磁盘上还留着 0.1.0 写的记录。**退出 DSH**，先 `node scripts/repair-credentials.mjs` 看报告，再 `--write` 执行；它会把旧记录改成新的 `remote-ssh/srv-<hex>` 形式、保留密码、并先备份文件。详见下面「升级」。 |
| 看不到标题栏按钮 | 插件条目需要处于启用状态，见「插件 → 已安装」。 |
| 提示「这台服务器还没有保存密码」 | 编辑该服务器补充密码；「测试连接」会报同样的错。 |
| 提示「没有找到可用的私钥」 | 该行会显示「私钥缺失」标记，请显式填写私钥路径。 |
| 其他 RPC 报错 | `$DSH_HOME/state/dsh-remote-ssh/host.log` 记录了激活、保存和 RPC 失败。 |

## 升级

0.2.0 改了密码在凭据库里的寻址方式：DSH 0.2.2-rc.3 开始在载入 `.credentials.yaml` 时逐段校验凭据键。0.1.0 写下的 `remote-ssh/<uuid>` 会让 credentials 插件激活失败，进而让依赖它的 `connection` 一直 pending，最终整个启动被判定失败：

```
dsh: startup failed: 1 required plugin did not activate
Failed plugins: credentials (@deepseek-ai/dsh-credentials-local)
TypeError: credential key segment "024bd1a5-…" must match /^[a-z][a-z0-9-]*$/
```

退出 DSH 后修复：

```bash
node scripts/repair-credentials.mjs           # 只报告：哪些会被改名
node scripts/repair-credentials.mjs --write   # 先备份 .credentials.yaml，再迁移
```

脚本按插件现在自己的推导规则（对 `state.json` 里的 serverId 取 `sha256` → `srv-<16 hex>`）把旧记录映射到新键，payload 原样保留；服务器已不存在的记录只报告、不猜也不丢，`--delete-unknown` 才会删掉这些孤儿记录。`state.json` 和各对话的授权都不需要改。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：工具注册与可见性门控、`/remote-ssh` 路由与端点分发。 |
| `lib/state.js` | 服务器清单与各对话的授权（原子写 JSON）。 |
| `lib/secrets.js` | 凭据记录（合法的 `srv-<hex>` 槽位推导）、`~` 展开、私钥解析。 |
| `lib/targets.js` | 清单记录 → 连接目标（凭据、私钥、跳板链）。 |
| `lib/ssh.js` | `ssh2` 传输层：exec、上传、下载、探测、跳板、超时、取消。 |
| `client.js` | 浏览器半边：设置页、标题栏按钮、弹出菜单。 |
| `scripts/repair-credentials.mjs` | DSH 升级后迁移 0.1.0 写下的凭据记录。 |
| `test/ssh.test.mjs` | 针对真实主机的传输层测试（`node test/ssh.test.mjs`）。 |
