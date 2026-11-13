/**
 * Remote SSH — browser half.
 *
 * Three surfaces, all reading and writing the Host half through the
 * authenticated `/remote-ssh` RPC channel:
 *
 *   1. `settings.section`  the settings page that maintains the server catalog,
 *   2. `conversation.session.header.utilities`  the compact button at the top
 *      right of a conversation,
 *   3. `shell.overlay`  the popover that button opens. It lives in the overlay
 *      slot because the header clips its own overflow; that slot is
 *      click-through and this entry opts back into pointer events only while
 *      the popover is open.
 *
 * Everything is styled with host theme tokens and follows the row, button and
 * input metrics measured from the shipped Settings panel, so the plugin reads as
 * part of the product rather than as a page bolted onto it.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-remote-ssh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Runtime locale namespace owned by this bundle. */
    const NS = 'remote-ssh'

    /** RPC channel registered by the host half. */
    const CHANNEL = '/remote-ssh'

    const DICTIONARIES = {
      en: {
        'nav.title': 'Remote SSH',
        'settings.lead':
          'These servers can be opened to the agent. In a conversation, the button at the top right chooses which of them that conversation may use.',
        'settings.empty': 'No servers yet. Add one to let the agent run commands and move files over SSH.',
        'settings.add': 'Add server',
        'settings.test': 'Test',
        'settings.testing': 'Testing…',
        'settings.edit': 'Edit',
        'settings.delete': 'Remove',
        'settings.save': 'Save',
        'settings.cancel': 'Cancel',
        'settings.saving': 'Saving…',
        'settings.newTitle': 'New server',
        'settings.editTitle': 'Edit server',
        'settings.name': 'Name',
        'settings.namePlaceholder': 'Home router',
        'settings.host': 'Address',
        'settings.hostPlaceholder': '192.168.1.1',
        'settings.port': 'Port',
        'settings.username': 'User name',
        'settings.auth': 'Sign in with',
        'settings.authPassword': 'Password',
        'settings.authKey': 'Private key',
        'settings.password': 'Password',
        'settings.passwordKeep': 'Saved — leave empty to keep it',
        'settings.passwordNew': 'Password for this host',
        'settings.passphrase': 'Key passphrase',
        'settings.passphraseKeep': 'Saved — leave empty to keep it',
        'settings.keyPath': 'Private key file',
        'settings.keyPlaceholder': 'Leave empty for the usual ~/.ssh identity',
        'settings.keyAuto': 'Automatic: {path}',
        'settings.keyMissing': 'No key found in ~/.ssh — choose a file',
        'settings.keyBroken': 'key file missing',
        'settings.keyHint': 'Leave empty to use the usual ~/.ssh identity.',
        'settings.jump': 'Jump host',
        'settings.jumpNone': 'Direct connection',
        'settings.note': 'Note for the agent',
        'settings.notePlaceholder': 'Optional, for example what this host is for',
        'settings.deleteYes': 'Remove',
        'settings.connected': 'Connected in {ms} ms',
        'settings.badgeJump': 'via {name}',
        'settings.badgePassword': 'password',
        'settings.badgeKey': 'key',
        'settings.loadError': 'Could not load servers: {message}',
        'menu.title': 'Servers for this conversation',
        'menu.empty': 'No servers are configured yet. Add one in Settings → Remote SSH.',
        'menu.none': 'None — the agent sees no SSH tools in this conversation.',
        'menu.count': '{count} open to the agent',
        'menu.loading': 'Loading…',
        'menu.open': 'SSH servers for this conversation',
        'error.bad-request': 'Some fields are missing or invalid.',
        'error.no-servers': 'No SSH server is shared with this conversation.',
        'error.unknown-server': 'That server no longer exists.',
        'error.not-allowed': 'That server is not shared with this conversation.',
        'error.jump-missing': 'The chosen jump host no longer exists.',
        'error.jump-cycle': 'A server cannot jump through itself.',
        'error.jump-too-deep': 'Only one jump host is supported.',
        'error.no-password': 'No password is saved for this server.',
        'error.key-missing': 'No usable private key was found for this server.',
        'error.key-unreadable': 'The private key could not be read.',
        'error.unknown-endpoint': 'This Harness version does not support that request.',
        'error.offline': 'Not connected to the Harness host.',
      },
      zh: {
        'nav.title': '远程 SSH',
        'settings.lead': '这些服务器可以开放给 AI 使用。在对话中，用右上角的按钮选择该对话可以访问哪些服务器。',
        'settings.empty': '还没有服务器。添加一台，AI 就能通过 SSH 执行命令、传输文件。',
        'settings.add': '添加服务器',
        'settings.test': '测试连接',
        'settings.testing': '测试中…',
        'settings.edit': '编辑',
        'settings.delete': '删除',
        'settings.save': '保存',
        'settings.cancel': '取消',
        'settings.saving': '保存中…',
        'settings.newTitle': '添加服务器',
        'settings.editTitle': '编辑服务器',
        'settings.name': '名称',
        'settings.namePlaceholder': '家里的路由器',
        'settings.host': '地址',
        'settings.hostPlaceholder': '192.168.1.1',
        'settings.port': '端口',
        'settings.username': '用户名',
        'settings.auth': '登录方式',
        'settings.authPassword': '密码',
        'settings.authKey': '私钥',
        'settings.password': '密码',
        'settings.passwordKeep': '已保存，留空则不修改',
        'settings.passwordNew': '这台机器的密码',
        'settings.passphrase': '私钥口令',
        'settings.passphraseKeep': '已保存，留空则不修改',
        'settings.keyPath': '私钥文件',
        'settings.keyPlaceholder': '留空则自动使用 ~/.ssh 下的默认私钥',
        'settings.keyAuto': '自动使用：{path}',
        'settings.keyMissing': '~/.ssh 里没有找到私钥，请手动选择',
        'settings.keyBroken': '私钥缺失',
        'settings.keyHint': '留空则自动使用 ~/.ssh 下的默认私钥。',
        'settings.jump': '跳板机',
        'settings.jumpNone': '直接连接',
        'settings.note': '给 AI 的备注',
        'settings.notePlaceholder': '可选，例如这台机器是做什么的',
        'settings.deleteYes': '删除',
        'settings.connected': '已连接，{ms} ms',
        'settings.badgeJump': '经 {name}',
        'settings.badgePassword': '密码',
        'settings.badgeKey': '密钥',
        'settings.loadError': '无法读取服务器列表：{message}',
        'menu.title': '本对话可用的服务器',
        'menu.empty': '还没有配置服务器。先到「设置 → 远程 SSH」添加。',
        'menu.none': '没有开放任何服务器，AI 在本对话中看不到 SSH 工具。',
        'menu.count': '已开放 {count} 台',
        'menu.loading': '加载中…',
        'menu.open': '本对话的 SSH 服务器',
        'error.bad-request': '有必填项缺失或填写有误。',
        'error.no-servers': '本对话没有可用服务器。',
        'error.unknown-server': '这台服务器已不存在。',
        'error.not-allowed': '这台服务器没有开放给本对话。',
        'error.jump-missing': '所选跳板机已不存在。',
        'error.jump-cycle': '服务器不能把自己当作跳板机。',
        'error.jump-too-deep': '最多只支持一级跳板机。',
        'error.no-password': '这台服务器还没有保存密码。',
        'error.key-missing': '没有找到可用的私钥。',
        'error.key-unreadable': '私钥文件无法读取。',
        'error.unknown-endpoint': '当前 Harness 版本不支持该请求。',
        'error.offline': '未连接到 Harness 主进程。',
      },
    }

    const CSS = [
      /* page shell */
      '.rssh-root{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);--rssh-muted:var(--dsw-alias-label-secondary)}',
      '.rssh-lead{font-size:12px;line-height:18px;color:var(--rssh-muted);padding:2px 0 14px;max-width:46em}',
      '.rssh-empty{padding:18px 0;color:var(--rssh-muted);font-size:13px}',
      /* rows */
      '.rssh-rows{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.rssh-row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.rssh-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.rssh-row-title{display:flex;align-items:center;gap:6px;min-width:0;font-weight:500}',
      '.rssh-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rssh-row-sub{font-size:12px;line-height:18px;color:var(--rssh-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rssh-actions{display:flex;align-items:center;gap:2px;flex:none}',
      /* badges */
      '.rssh-badge{flex:none;font-size:11px;line-height:16px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--rssh-muted);white-space:nowrap}',
      '.rssh-badge[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.rssh-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
      /* buttons */
      '.rssh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid transparent;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.rssh-btn:disabled{opacity:.5;cursor:default}',
      '.rssh-btn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.rssh-btn[data-variant="quiet"]{background:transparent}',
      '.rssh-btn[data-variant="quiet"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.rssh-btn[data-variant="danger"]{background:transparent;color:var(--dsw-alias-state-error-primary)}',
      '.rssh-btn[data-variant="danger"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.rssh-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.rssh-iconbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.rssh-iconbtn:disabled{opacity:.45;cursor:default}',
      /* form */
      '.rssh-form{margin:12px 0 4px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:12px}',
      '.rssh-form-head{font-weight:500}',
      '.rssh-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 12px}',
      '.rssh-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.rssh-field[data-span="2"]{grid-column:1 / -1}',
      '.rssh-field > label{font-size:12px;line-height:18px;color:var(--rssh-muted)}',
      '.rssh-input,.rssh-selectbox{box-sizing:border-box;width:100%;height:36px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}',
      '.rssh-input:focus,.rssh-selectbox:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.rssh-input::placeholder{color:var(--rssh-muted)}',
      '.rssh-hint{font-size:11px;line-height:16px;color:var(--rssh-muted)}',
      '.rssh-seg{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '.rssh-seg > button{height:32px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '.rssh-seg > button[data-on="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.rssh-form-actions{display:flex;align-items:center;gap:8px}',
      '.rssh-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.rssh-notice{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-top:4px}',
      /* header button */
      '.rssh-headbtn{position:relative;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.rssh-headbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.rssh-headbtn[data-on="true"]{color:var(--dsw-alias-label-primary)}',
      '.rssh-headbtn-count{font-variant-numeric:tabular-nums;font-size:12px;line-height:16px;padding:0 4px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}',
      '.rssh-headbtn[data-on="true"] .rssh-headbtn-count{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      /* popover */
      '.rssh-backdrop{position:fixed;inset:0;z-index:60}',
      '.rssh-pop{position:fixed;z-index:61;box-sizing:border-box;width:280px;padding:6px;border-radius:16px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2),0 10px 28px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.rssh-pop-head{padding:6px 8px 8px;font-size:11px;line-height:16px;color:var(--rssh-muted)}',
      '.rssh-pop-list{display:flex;flex-direction:column;gap:1px;max-height:280px;overflow:auto}',
      '.rssh-opt{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.rssh-opt:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.rssh-opt-box{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;color:var(--dsw-alias-bg-base)}',
      '.rssh-opt[aria-checked="true"] .rssh-opt-box{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.rssh-opt-text{flex:1;min-width:0;display:flex;flex-direction:column}',
      '.rssh-opt-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rssh-opt-sub{font-size:11px;line-height:15px;color:var(--rssh-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rssh-pop-note{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--rssh-muted)}',
      '.rssh-pop-empty{padding:4px 8px 10px;font-size:12px;line-height:18px;color:var(--rssh-muted)}',
    ].join('')

    // ---------------------------------------------------------------------
    // Localization and RPC helpers
    // ---------------------------------------------------------------------

    /**
     * Translate one dictionary key and interpolate `{name}` placeholders.
     *
     * Interpolation happens here rather than in the slot translator so both the
     * slot-provided `t` and this bundle's fallback behave identically.
     * @param t - translator: slot prop or the bundle fallback.
     * @param key - dictionary key.
     * @param params - interpolation values.
     * @returns the localized sentence.
     */
    function translate(t, key, params) {
      const raw = typeof t === 'function' ? t(key) : key
      if (typeof raw !== 'string') return String(raw)
      if (params === undefined) return raw
      return raw.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    }

    /**
     * Build the fallback translator used when a slot does not hand one down.
     * @param ctx - client plugin context.
     * @returns a translate function bound to this bundle's namespace.
     */
    function createFallbackTranslator(ctx) {
      return (key) => {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale === undefined || typeof locale.bind !== 'function') return key
        try {
          const bound = locale.bind(NS)
          return typeof bound === 'function' ? bound(key) : key
        } catch {
          return key
        }
      }
    }

    /**
     * Create the thin RPC facade both surfaces use.
     *
     * The transport is the Harness connection service: `rpc.call` posts the
     * request envelope to the channel the host half registered, authenticated by
     * the page's own browser credential.
     * @param ctx - client plugin context.
     * @returns `{ call }`, which rejects with an error carrying `code`.
     */
    function createRpc(ctx) {
      let connection
      return {
        async call(endpoint, payload) {
          if (connection === undefined) connection = ctx.get('connection')
          if (connection === undefined || connection.rpc === undefined) {
            const error = new Error('not connected to the Harness host')
            error.code = 'offline'
            throw error
          }
          const result = await connection.rpc.call(CHANNEL, endpoint, payload ?? null)
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            const failure = result !== null && typeof result === 'object' ? result.error : undefined
            const error = new Error(typeof failure?.message === 'string' ? failure.message : 'the request failed')
            error.code = typeof failure?.code === 'string' ? failure.code : 'failed'
            throw error
          }
          return result.value
        },
      }
    }

    /**
     * Turn a rejected RPC call into one localized sentence.
     * @param t - translator.
     * @param error - the rejection.
     * @returns display text.
     */
    function describeFailure(t, error) {
      const code = typeof error?.code === 'string' ? error.code : 'failed'
      const known = translate(t, `error.${code}`)
      return known === `error.${code}` ? String(error?.message ?? error) : known
    }

    /**
     * Render one host icon from the shared sprite.
     * @param props - `name` (sprite id) and `size`.
     * @returns the svg element.
     */
    function Icon({ name, size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('use', { href: `#${name}` }),
      )
    }

    /**
     * Subscribe to an external store without requiring React 18 APIs.
     * @param store - object with `get()` and `subscribe(fn)`.
     * @returns the current value, re-rendering on change.
     */
    function useStoreValue(store) {
      const [value, setValue] = useState(() => store.get())
      useEffect(() => store.subscribe(() => setValue(store.get())), [store])
      return value
    }

    /**
     * Shared popover state.
     *
     * The header button and the overlay entry are separate slot entries, so the
     * anchor rectangle and the open session travel through this store, and its
     * revision wakes the button's count badge after a toggle.
     * @returns the store handle.
     */
    function createMenuStore() {
      let state = { open: false, anchor: null, sessionId: null, revision: 0 }
      const listeners = new Set()
      const publish = (next) => {
        state = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[remote-ssh] menu listener failed', error)
          }
        }
      }
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        open(anchor, sessionId) {
          publish({ ...state, open: true, anchor, sessionId })
        },
        close() {
          if (!state.open) return
          publish({ ...state, open: false, anchor: null, sessionId: null })
        },
        grantsChanged() {
          publish({ ...state, revision: state.revision + 1 })
        },
      }
    }

    // ---------------------------------------------------------------------
    // Settings page
    // ---------------------------------------------------------------------

    /** Draft for a brand-new server. */
    function emptyDraft() {
      return { id: '', name: '', host: '', port: '22', username: '', auth: 'password', keyPath: '', jumpId: '', note: '' }
    }

    /**
     * Turn one server view into an editable draft, keeping the port a string so
     * the field stays editable while the user types.
     * @param view - described server.
     * @returns the draft.
     */
    function draftOf(view) {
      return {
        id: view.id,
        name: view.name,
        host: view.host,
        port: String(view.port),
        username: view.username,
        auth: view.auth,
        keyPath: view.keyPath,
        jumpId: view.jumpId,
        note: view.note,
      }
    }

    /**
     * One row of the server list with its test, edit and remove actions.
     * @param props - view, handlers, per-row status and translator.
     * @returns the row.
     */
    function ServerRow({ view, t, onEdit, onDelete, onTest, testing, testResult, busy }) {
      const [confirming, setConfirming] = useState(false)
      const subtitle = `${view.username}@${view.host}:${view.port}${view.note === '' ? '' : ` · ${view.note}`}`
      const resultLine =
        testResult === undefined || testResult === null
          ? null
          : h(
              'div',
              {
                className: 'rssh-row-sub',
                style: {
                  color: testResult.ok
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-state-error-primary)',
                },
              },
              testResult.ok ? translate(t, 'settings.connected', { ms: testResult.latencyMs }) : testResult.message,
            )
      const actions = confirming
        ? [
            h(
              'button',
              {
                key: 'confirm',
                type: 'button',
                className: 'rssh-btn',
                'data-variant': 'danger',
                onClick: () => onDelete(view),
                disabled: busy,
              },
              translate(t, 'settings.deleteYes'),
            ),
            h(
              'button',
              {
                key: 'cancel',
                type: 'button',
                className: 'rssh-btn',
                'data-variant': 'quiet',
                onClick: () => setConfirming(false),
              },
              translate(t, 'settings.cancel'),
            ),
          ]
        : [
            h(
              'button',
              {
                key: 'test',
                type: 'button',
                className: 'rssh-btn',
                'data-variant': 'quiet',
                onClick: () => onTest(view),
                disabled: testing || busy,
              },
              translate(t, testing ? 'settings.testing' : 'settings.test'),
            ),
            h(
              'button',
              {
                key: 'edit',
                type: 'button',
                className: 'rssh-iconbtn',
                title: translate(t, 'settings.edit'),
                'aria-label': translate(t, 'settings.edit'),
                onClick: () => onEdit(view),
                disabled: busy,
              },
              h(Icon, { name: 'dsw-icon-edit-outline-regular' }),
            ),
            h(
              'button',
              {
                key: 'remove',
                type: 'button',
                className: 'rssh-iconbtn',
                title: translate(t, 'settings.delete'),
                'aria-label': translate(t, 'settings.delete'),
                onClick: () => setConfirming(true),
                disabled: busy,
              },
              h(Icon, { name: 'dsw-icon-trash-outline-regular' }),
            ),
          ]

      return h(
        'div',
        { className: 'rssh-row' },
        h(
          'div',
          { className: 'rssh-row-main' },
          h(
            'div',
            { className: 'rssh-row-title' },
            h('span', { className: 'rssh-row-name' }, view.name),
            h('span', { className: 'rssh-badge' }, translate(t, view.auth === 'password' ? 'settings.badgePassword' : 'settings.badgeKey')),
            view.jumpName === ''
              ? null
              : h('span', { className: 'rssh-badge' }, translate(t, 'settings.badgeJump', { name: view.jumpName })),
            view.auth === 'key' && view.keyExists !== true
              ? h('span', { className: 'rssh-badge', 'data-tone': 'error' }, translate(t, 'settings.keyBroken'))
              : null,
          ),
          h('div', { className: 'rssh-row-sub' }, subtitle),
          resultLine,
        ),
        h('div', { className: 'rssh-actions' }, actions),
      )
    }

    /**
     * The inline create/edit form.
     * @param props - draft, its setters, secret fields, jump candidates, handlers.
     * @returns the form.
     */
    function ServerForm(props) {
      const { draft, setDraft, password, setPassword, passphrase, setPassphrase, servers, t, error, saving, onSubmit, onCancel } = props
      const editing = draft.id !== ''
      const editingView = editing ? servers.find((view) => view.id === draft.id) : undefined
      const usesKey = draft.auth === 'key'
      const jumpOptions = servers.filter((view) => view.id !== draft.id)

      const field = (key, label, control, span) =>
        h(
          'div',
          { key, className: 'rssh-field', ...(span === 2 ? { 'data-span': '2' } : {}) },
          h('label', null, label),
          control,
        )

      const keyHint = (() => {
        if (editingView === undefined || editingView.resolvedKeyPath === '') return translate(t, 'settings.keyHint')
        if (editingView.keySource === 'default') return translate(t, 'settings.keyAuto', { path: editingView.resolvedKeyPath })
        return editingView.keyExists === true ? editingView.resolvedKeyPath : translate(t, 'settings.keyMissing')
      })()

      const children = [
        h('div', { key: 'head', className: 'rssh-form-head' }, translate(t, editing ? 'settings.editTitle' : 'settings.newTitle')),
        h(
          'div',
          { key: 'fields', className: 'rssh-fields' },
          field(
            'name',
            translate(t, 'settings.name'),
            h('input', {
              className: 'rssh-input',
              value: draft.name,
              placeholder: translate(t, 'settings.namePlaceholder'),
              onChange: (event) => setDraft({ ...draft, name: event.target.value }),
            }),
          ),
          field(
            'user',
            translate(t, 'settings.username'),
            h('input', {
              className: 'rssh-input',
              value: draft.username,
              autoComplete: 'off',
              placeholder: 'root',
              onChange: (event) => setDraft({ ...draft, username: event.target.value }),
            }),
          ),
          field(
            'host',
            translate(t, 'settings.host'),
            h('input', {
              className: 'rssh-input',
              value: draft.host,
              placeholder: translate(t, 'settings.hostPlaceholder'),
              onChange: (event) => setDraft({ ...draft, host: event.target.value }),
            }),
          ),
          field(
            'port',
            translate(t, 'settings.port'),
            h('input', {
              className: 'rssh-input',
              value: draft.port,
              inputMode: 'numeric',
              onChange: (event) => setDraft({ ...draft, port: event.target.value.replace(/[^0-9]/g, '') }),
            }),
          ),
          field(
            'auth',
            translate(t, 'settings.auth'),
            h(
              'div',
              { className: 'rssh-seg', role: 'radiogroup' },
              h(
                'button',
                {
                  type: 'button',
                  'data-on': String(!usesKey),
                  'aria-pressed': String(!usesKey),
                  onClick: () => setDraft({ ...draft, auth: 'password' }),
                },
                translate(t, 'settings.authPassword'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-on': String(usesKey),
                  'aria-pressed': String(usesKey),
                  onClick: () => setDraft({ ...draft, auth: 'key' }),
                },
                translate(t, 'settings.authKey'),
              ),
            ),
            2,
          ),
        ),
      ]

      const secretFields = usesKey
        ? [
            field(
              'keyPath',
              translate(t, 'settings.keyPath'),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h('input', {
                  className: 'rssh-input',
                  value: draft.keyPath,
                  placeholder: translate(t, 'settings.keyPlaceholder'),
                  onChange: (event) => setDraft({ ...draft, keyPath: event.target.value }),
                }),
                h('div', { className: 'rssh-hint' }, keyHint),
              ),
              2,
            ),
          ]
        : [
            field(
              'password',
              translate(t, 'settings.password'),
              h('input', {
                className: 'rssh-input',
                type: 'password',
                value: password,
                autoComplete: 'new-password',
                placeholder:
                  editingView?.hasPassword === true
                    ? translate(t, 'settings.passwordKeep')
                    : translate(t, 'settings.passwordNew'),
                onChange: (event) => setPassword(event.target.value),
              }),
              2,
            ),
          ]

      if (editingView?.hasPassphrase === true) {
        secretFields.push(
          field(
            'passphrase',
            translate(t, 'settings.passphrase'),
            h('input', {
              className: 'rssh-input',
              type: 'password',
              value: passphrase,
              autoComplete: 'new-password',
              placeholder: translate(t, 'settings.passphraseKeep'),
              onChange: (event) => setPassphrase(event.target.value),
            }),
            2,
          ),
        )
      }

      children.push(h('div', { key: 'secret', className: 'rssh-fields' }, secretFields))
      children.push(
        h(
          'div',
          { key: 'extra', className: 'rssh-fields' },
          field(
            'jump',
            translate(t, 'settings.jump'),
            h(
              'select',
              {
                className: 'rssh-selectbox',
                value: draft.jumpId,
                onChange: (event) => setDraft({ ...draft, jumpId: event.target.value }),
              },
              h('option', { value: '' }, translate(t, 'settings.jumpNone')),
              jumpOptions.map((view) => h('option', { key: view.id, value: view.id }, `${view.name} (${view.host})`)),
            ),
          ),
          field(
            'note',
            translate(t, 'settings.note'),
            h('input', {
              className: 'rssh-input',
              value: draft.note,
              placeholder: translate(t, 'settings.notePlaceholder'),
              onChange: (event) => setDraft({ ...draft, note: event.target.value }),
            }),
          ),
        ),
      )
      if (error !== null) children.push(h('div', { key: 'error', className: 'rssh-error' }, error))
      children.push(
        h(
          'div',
          { key: 'actions', className: 'rssh-form-actions' },
          h(
            'button',
            { type: 'submit', className: 'rssh-btn', 'data-variant': 'primary', disabled: saving },
            translate(t, saving ? 'settings.saving' : 'settings.save'),
          ),
          h(
            'button',
            { type: 'button', className: 'rssh-btn', 'data-variant': 'quiet', onClick: onCancel, disabled: saving },
            translate(t, 'settings.cancel'),
          ),
        ),
      )

      return h(
        'form',
        {
          className: 'rssh-form',
          onSubmit: (event) => {
            event.preventDefault()
            onSubmit()
          },
        },
        children,
      )
    }

    /**
     * The settings section: the server catalog and its editor.
     * @param props - slot props plus this bundle's RPC facade.
     * @returns the section body.
     */
    function SettingsSection(props) {
      const { rpc, t: providedT } = props
      const t = typeof providedT === 'function' ? providedT : props.fallbackT
      const tRef = useRef(t)
      tRef.current = t

      const [servers, setServers] = useState([])
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState(null)
      const [draft, setDraft] = useState(null)
      const [password, setPassword] = useState('')
      const [passphrase, setPassphrase] = useState('')
      const [formError, setFormError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [busyId, setBusyId] = useState(null)
      const [testingId, setTestingId] = useState(null)
      const [testResults, setTestResults] = useState({})

      const refresh = useCallback(async () => {
        try {
          const value = await rpc.call('bootstrap', { sessionId: '' })
          setServers(Array.isArray(value?.servers) ? value.servers : [])
          setLoadError(null)
        } catch (error) {
          setLoadError(describeFailure(tRef.current, error))
        } finally {
          setLoading(false)
        }
      }, [rpc])

      useEffect(() => {
        refresh()
      }, [refresh])

      const closeForm = useCallback(() => {
        setDraft(null)
        setPassword('')
        setPassphrase('')
        setFormError(null)
      }, [])

      const submit = useCallback(async () => {
        if (draft === null || saving) return
        setSaving(true)
        setFormError(null)
        try {
          const port = Number(draft.port)
          const value = await rpc.call('servers.save', {
            server: {
              id: draft.id,
              name: draft.name,
              host: draft.host,
              port: Number.isFinite(port) && port > 0 ? port : 22,
              username: draft.username,
              auth: draft.auth,
              keyPath: draft.keyPath,
              jumpId: draft.jumpId,
              note: draft.note,
            },
            ...(password === '' ? {} : { password }),
            ...(passphrase === '' ? {} : { passphrase }),
          })
          setServers(Array.isArray(value?.servers) ? value.servers : [])
          closeForm()
        } catch (error) {
          setFormError(describeFailure(tRef.current, error))
        } finally {
          setSaving(false)
        }
      }, [draft, saving, rpc, password, passphrase, closeForm])

      const remove = useCallback(
        async (view) => {
          setBusyId(view.id)
          try {
            const value = await rpc.call('servers.delete', { id: view.id })
            setServers(Array.isArray(value?.servers) ? value.servers : [])
            if (draft !== null && draft.id === view.id) closeForm()
          } catch (error) {
            setTestResults((current) => ({ ...current, [view.id]: { ok: false, message: describeFailure(tRef.current, error) } }))
          } finally {
            setBusyId(null)
          }
        },
        [rpc, draft, closeForm],
      )

      const test = useCallback(
        async (view) => {
          setTestingId(view.id)
          setTestResults((current) => {
            const next = { ...current }
            delete next[view.id]
            return next
          })
          try {
            const value = await rpc.call('servers.test', { id: view.id })
            setTestResults((current) => ({
              ...current,
              [view.id]:
                value?.ok === true
                  ? { ok: true, latencyMs: value.latencyMs }
                  : { ok: false, message: value?.error?.message ?? describeFailure(tRef.current, { code: 'failed' }) },
            }))
          } catch (error) {
            setTestResults((current) => ({ ...current, [view.id]: { ok: false, message: describeFailure(tRef.current, error) } }))
          } finally {
            setTestingId(null)
          }
        },
        [rpc],
      )

      const startNew = useCallback(() => {
        setDraft(emptyDraft())
        setPassword('')
        setPassphrase('')
        setFormError(null)
      }, [])

      const startEdit = useCallback((view) => {
        setDraft(draftOf(view))
        setPassword('')
        setPassphrase('')
        setFormError(null)
      }, [])

      const children = [h('div', { key: 'lead', className: 'rssh-lead' }, translate(t, 'settings.lead'))]
      if (loadError !== null) {
        children.push(
          h(
            'div',
            { key: 'loadError', className: 'rssh-error', style: { paddingBottom: '12px' } },
            translate(t, 'settings.loadError', { message: loadError }),
          ),
        )
      }
      if (draft !== null) {
        children.push(
          h(ServerForm, {
            key: 'form',
            draft,
            setDraft,
            password,
            setPassword,
            passphrase,
            setPassphrase,
            servers,
            t,
            error: formError,
            saving,
            onSubmit: submit,
            onCancel: closeForm,
          }),
        )
      }
      if (!loading && draft === null) {
        children.push(
          servers.length === 0
            ? h('div', { key: 'empty', className: 'rssh-empty' }, translate(t, 'settings.empty'))
            : h(
                'div',
                { key: 'rows', className: 'rssh-rows' },
                servers.map((view) =>
                  h(ServerRow, {
                    key: view.id,
                    view,
                    t,
                    testing: testingId === view.id,
                    testResult: testResults[view.id],
                    busy: busyId === view.id,
                    onEdit: startEdit,
                    onDelete: remove,
                    onTest: test,
                  }),
                ),
              ),
        )
      }
      if (draft === null) {
        children.push(
          h(
            'div',
            { key: 'add', className: 'rssh-notice' },
            h(
              'button',
              { type: 'button', className: 'rssh-btn', onClick: startNew },
              h(Icon, { name: 'dsw-icon-plus-outline-regular' }),
              translate(t, 'settings.add'),
            ),
          ),
        )
      }

      return h('div', { className: 'rssh-root' }, children)
    }

    // ---------------------------------------------------------------------
    // Conversation surfaces
    // ---------------------------------------------------------------------

    /**
     * The compact header button: reports how many servers this conversation has
     * open and toggles the popover. Every write happens in the popover.
     * @param props - slot props plus the menu store, RPC facade and translator.
     * @returns the button.
     */
    function HeaderButton(props) {
      const t = typeof props.t === 'function' ? props.t : props.fallbackT
      const { menuStore, rpc, sessionId } = props
      const menu = useStoreValue(menuStore)
      const [count, setCount] = useState(0)

      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        let cancelled = false
        rpc
          .call('bootstrap', { sessionId })
          .then((value) => {
            if (!cancelled) setCount(Array.isArray(value?.allowed) ? value.allowed.length : 0)
          })
          .catch(() => {
            if (!cancelled) setCount(0)
          })
        return () => {
          cancelled = true
        }
      }, [rpc, sessionId, menu.revision])

      return h(
        'button',
        {
          type: 'button',
          className: 'rssh-headbtn',
          'data-on': String(count > 0),
          title: translate(t, 'menu.open'),
          'aria-label': translate(t, 'menu.open'),
          'aria-expanded': String(menu.open),
          onClick: (event) => {
            if (menu.open) {
              menuStore.close()
              return
            }
            const rect = event.currentTarget.getBoundingClientRect()
            menuStore.open({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }, sessionId)
          },
        },
        h(Icon, { name: 'dsw-icon-browse-outline-regular' }),
        count > 0 ? h('span', { className: 'rssh-headbtn-count' }, String(count)) : null,
      )
    }

    /**
     * The overlay entry: the popover that chooses this conversation's servers.
     * Registered for the page lifetime and rendering nothing while closed, so
     * opening it costs one state change instead of a slot registration.
     * @param props - slot props plus the menu store, RPC facade and translator.
     * @returns the popover, or null.
     */
    function OverlayMenu(props) {
      const t = typeof props.t === 'function' ? props.t : props.fallbackT
      const tRef = useRef(t)
      tRef.current = t
      const { menuStore, rpc } = props
      const menu = useStoreValue(menuStore)
      const [servers, setServers] = useState([])
      const [allowed, setAllowed] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [pending, setPending] = useState(false)
      const requestRef = useRef(0)
      const sessionId = menu.sessionId

      useEffect(() => {
        if (menu.open !== true || typeof sessionId !== 'string' || sessionId === '') return undefined
        const token = requestRef.current + 1
        requestRef.current = token
        setLoading(true)
        setError(null)
        rpc
          .call('bootstrap', { sessionId })
          .then((value) => {
            if (requestRef.current !== token) return
            setServers(Array.isArray(value?.servers) ? value.servers : [])
            setAllowed(Array.isArray(value?.allowed) ? value.allowed : [])
          })
          .catch((failure) => {
            if (requestRef.current === token) setError(describeFailure(tRef.current, failure))
          })
          .finally(() => {
            if (requestRef.current === token) setLoading(false)
          })
        return undefined
      }, [menu.open, sessionId, rpc])

      useEffect(() => {
        if (menu.open !== true) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') menuStore.close()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [menu.open, menuStore])

      const toggle = useCallback(
        async (view) => {
          if (pending || typeof sessionId !== 'string' || sessionId === '') return
          const previous = allowed
          const next = allowed.includes(view.id) ? allowed.filter((id) => id !== view.id) : [...allowed, view.id]
          setAllowed(next)
          setPending(true)
          try {
            const value = await rpc.call('session.set', { sessionId, allowed: next })
            setAllowed(Array.isArray(value?.allowed) ? value.allowed : next)
            setError(null)
          } catch (failure) {
            setAllowed(previous)
            setError(describeFailure(tRef.current, failure))
          } finally {
            setPending(false)
            menuStore.grantsChanged()
          }
        },
        [allowed, pending, rpc, sessionId, menuStore],
      )

      if (menu.open !== true) return null
      const anchor = menu.anchor ?? { top: 0, right: 0, bottom: 0 }
      const width = 280
      const margin = 8
      const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight
      const left = Math.max(margin, Math.min(anchor.right - width, viewportWidth - width - margin))
      const top = Math.min(anchor.bottom + 6, Math.max(margin, viewportHeight - 160))

      const rows = servers.map((view) =>
        h(
          'button',
          {
            key: view.id,
            type: 'button',
            className: 'rssh-opt',
            role: 'menuitemcheckbox',
            'aria-checked': String(allowed.includes(view.id)),
            onClick: () => toggle(view),
          },
          h(
            'span',
            { className: 'rssh-opt-box' },
            allowed.includes(view.id) ? h(Icon, { name: 'dsw-icon-check-outline-regular', size: 12 }) : null,
          ),
          h(
            'span',
            { className: 'rssh-opt-text' },
            h('span', { className: 'rssh-opt-name' }, view.name),
            h('span', { className: 'rssh-opt-sub' }, `${view.username}@${view.host}:${view.port}`),
          ),
        ),
      )

      return [
        h('div', {
          key: 'backdrop',
          className: 'rssh-backdrop',
          role: 'presentation',
          onMouseDown: () => menuStore.close(),
        }),
        h(
          'div',
          {
            key: 'panel',
            className: 'rssh-pop rssh-root',
            role: 'menu',
            'aria-label': translate(t, 'menu.title'),
            style: { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` },
            onMouseDown: (event) => event.stopPropagation(),
          },
          h('div', { className: 'rssh-pop-head' }, translate(t, 'menu.title')),
          loading
            ? h('div', { className: 'rssh-pop-empty' }, translate(t, 'menu.loading'))
            : servers.length === 0
              ? h('div', { className: 'rssh-pop-empty' }, translate(t, 'menu.empty'))
              : h('div', { className: 'rssh-pop-list' }, rows),
          error === null ? null : h('div', { className: 'rssh-pop-note rssh-error' }, error),
          servers.length === 0
            ? null
            : h(
                'div',
                { className: 'rssh-pop-note' },
                allowed.length === 0 ? translate(t, 'menu.none') : translate(t, 'menu.count', { count: allowed.length }),
              ),
        ),
      ]
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'remote-ssh: dictionaries')

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-remote-ssh'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'remote-ssh: styles')

        const rpc = createRpc(ctx)
        const menuStore = createMenuStore()
        const fallbackT = createFallbackTranslator(ctx)
        /** Wrap a slot component so it always receives this bundle's facilities. */
        const withFacilities = (Component) => (props) =>
          h(Component, { ...props, rpc, menuStore, fallbackT })

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'remote-ssh.menu', order: 40, locale: NS },
            withFacilities(OverlayMenu),
          ),
        )

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'remote-ssh', order: 30, locale: NS },
            withFacilities(HeaderButton),
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'remote-ssh',
              order: 25,
              label: () => translate(fallbackT, 'nav.title'),
              locale: NS,
            },
            withFacilities(SettingsSection),
          ),
        )
      },
    }
  },
})
