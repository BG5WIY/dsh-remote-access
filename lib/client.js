// dsh-remote-access client half（DSH ModuleLoader 格式）。
//
// 在「设置」里注册「外网访问」分区，并把设置面板在手机端改成全屏列表：
//   - DSH 内置设置面板是 800px 固定双栏（188px 导航 + 内容），没有媒体查询；
//     这里注入 CSS，在 ≤640px 时改成全屏 + 顶部标题 + 横向分类标签。
//   - 分区本身用类名 + CSS：桌面是卡片/网格，手机端是 chat.deepseek.com
//     风格的整行列表和全宽按钮。
//
// bundle 注册 id 必须与 package.json 的 name 完全一致。

window.__ModuleLoader__.load({ id: 'dsh-remote-access', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')
  var h = React.createElement

  var API = '/api/remote-access'
  var STYLE_ID = 'dsh-remote-access-style'

  // 只使用 DSH 主题变量，并给每个变量留兜底色，避免换主题时整块不可读。
  var CSS = [
    '.dsh-ra-section{display:flex;flex-direction:column;gap:16px}',
    '.dsh-ra-head{display:flex;flex-direction:column;gap:4px}',
    '.dsh-ra-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
    '.dsh-ra-desc{margin:0;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.9))}',
    '.dsh-ra-error{margin:0;font-size:13px;color:var(--dsw-alias-state-error-primary,#d9534f)}',
    '.dsh-ra-status{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;overflow:hidden}',
    '.dsh-ra-status-row{display:flex;flex-direction:column;gap:2px;padding:12px 14px}',
    '.dsh-ra-status-label{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
    '.dsh-ra-status-value{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}',
    '.dsh-ra-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;padding:2px 16px}',
    '.dsh-ra-card-title{margin:14px 0 2px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
    '.dsh-ra-card-hint{margin:0 0 8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
    '.dsh-ra-item{padding:14px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
    '.dsh-ra-item:first-of-type{border-top:0}',
    '.dsh-ra-item-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
    '.dsh-ra-code{font:700 17px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
    '.dsh-ra-left{font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
    '.dsh-ra-meta{margin-top:6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
    '.dsh-ra-meta span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-ra-actions{display:flex;gap:8px;margin-top:10px}',
    '.dsh-ra-btn{box-sizing:border-box;height:34px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;cursor:pointer}',
    '.dsh-ra-btn:disabled{opacity:.5;cursor:default}',
    '.dsh-ra-btn-primary{border-color:var(--dsw-alias-label-primary,currentColor)}',
    '.dsh-ra-btn-danger{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f)}',
    '.dsh-ra-empty{margin:0;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
    '.dsh-ra-footnote{margin:0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));font-size:12px;line-height:1.65;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
    '@media (max-width:768px){',
    '.dsh-ra-status{grid-template-columns:1fr}',
    '.dsh-ra-status-row{flex-direction:row;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
    '.dsh-ra-status-row:first-child{border-top:0}',
    '.dsh-ra-status-value{text-align:right}',
    '.dsh-ra-card{padding:2px 14px}',
    '.dsh-ra-actions .dsh-ra-btn{flex:1;height:40px}',
    '}',
  ].join('\n')

  function fmtTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '00:00'
    var total = Math.ceil(ms / 1000)
    var m = Math.floor(total / 60)
    var s = total % 60
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
  }

  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return '-'
    try { return new Date(ms).toLocaleString() } catch (e) { return String(ms) }
  }

  async function call(path, init) {
    var headers = { 'x-dsh-ra': '1' }
    if (init && init.body !== undefined) headers['content-type'] = 'application/json'
    var res = await fetch(API + path, Object.assign({ cache: 'no-store', headers: headers }, init || {}))
    var data = {}
    try { data = await res.json() } catch (e) { data = {} }
    if (!res.ok || data.ok === false) {
      var error = new Error(data.error || ('HTTP ' + res.status))
      error.code = data.error
      throw error
    }
    return data
  }

  function StatusList(props) {
    var status = props.status
    var rows = [
      ['公网地址', status.publicUrl || status.listenHost + ':' + status.listenPort],
      ['本机 DSH', status.upstream],
      ['TLS', status.tls.selfSigned ? '自签证书' : '已配置证书'],
      ['未确认', String(status.pendingCount) + ' 个'],
      ['已确认', String(status.approvedCount) + ' 个'],
      ['会话有效期', Math.round(status.sessionTtlMs / 86400000) + ' 天'],
      ['持久化', status.persisted ? '已保存到磁盘' : '仅内存'],
    ]
    return h('div', { className: 'dsh-ra-status' }, rows.map(function (row) {
      return h('div', { key: row[0], className: 'dsh-ra-status-row' },
        h('span', { className: 'dsh-ra-status-label' }, row[0]),
        h('span', { className: 'dsh-ra-status-value' }, row[1]),
      )
    }))
  }

  function Item(props) {
    var item = props.item
    var left = item.expiresAt - props.now
    var pending = props.mode === 'pending'
    return h('div', { className: 'dsh-ra-item' },
      h('div', { className: 'dsh-ra-item-head' },
        h('span', { className: 'dsh-ra-code' }, item.code),
        pending
          ? h('span', {
              className: 'dsh-ra-left',
              style: left < 60000 ? { color: 'var(--dsw-alias-state-error-primary,#d9534f)' } : null,
            }, '剩余 ' + fmtTime(left))
          : h('span', { className: 'dsh-ra-left' }, '有效至 ' + fmtClock(item.expiresAt)),
      ),
      h('div', { className: 'dsh-ra-meta' },
        h('span', null, item.address || '未知地址'),
        h('span', null, pending ? (item.userAgent || '未知客户端') : ('确认于 ' + fmtClock(item.approvedAt))),
      ),
      h('div', { className: 'dsh-ra-actions' },
        pending
          ? [
              h('button', {
                key: 'approve', type: 'button', disabled: props.disabled,
                className: 'dsh-ra-btn dsh-ra-btn-primary',
                onClick: function () { props.onAction('approve', item.id) },
              }, props.busy === item.id + 'approve' ? '确认中…' : '确认'),
              h('button', {
                key: 'deny', type: 'button', disabled: props.disabled,
                className: 'dsh-ra-btn dsh-ra-btn-danger',
                onClick: function () { props.onAction('deny', item.id) },
              }, props.busy === item.id + 'deny' ? '处理中…' : '拒绝'),
            ]
          : h('button', {
              type: 'button', disabled: props.disabled,
              className: 'dsh-ra-btn dsh-ra-btn-danger',
              onClick: function () { props.onAction('revoke', item.id) },
            }, props.busy === item.id + 'revoke' ? '撤销中…' : '撤销'),
      ),
    )
  }

  function RemoteAccessSection() {
    var [status, setStatus] = React.useState(null)
    var [pending, setPending] = React.useState([])
    var [sessions, setSessions] = React.useState([])
    var [error, setError] = React.useState('')
    var [busy, setBusy] = React.useState('')
    var [now, setNow] = React.useState(Date.now())

    async function refresh() {
      try {
        var next = await call('/status')
        setStatus(next)
        setError('')
        if (next.internal) {
          var results = await Promise.all([call('/pending'), call('/sessions')])
          setPending(results[0].pending || [])
          setSessions(results[1].sessions || [])
        } else {
          setPending([])
          setSessions([])
        }
      } catch (e) {
        setError(e && e.message ? e.message : String(e))
      }
    }

    React.useEffect(function () {
      refresh()
      var poll = setInterval(refresh, 2500)
      var clock = setInterval(function () { setNow(Date.now()) }, 1000)
      return function () { clearInterval(poll); clearInterval(clock) }
    }, [])

    async function act(action, id) {
      setBusy(id + action)
      try {
        await call('/' + action, { method: 'POST', body: JSON.stringify({ id: id }) })
      } catch (e) {
        setError(e && e.message ? e.message : String(e))
      } finally {
        setBusy('')
        await refresh()
      }
    }

    var body
    if (status === null) {
      body = h('p', { className: 'dsh-ra-empty' }, error ? '无法读取状态：' + error : '正在读取状态…')
    } else if (!status.internal) {
      body = h('div', { className: 'dsh-ra-card', style: { borderColor: 'var(--dsw-alias-state-warning-primary,#c98a1b)' } },
        h('p', { className: 'dsh-ra-card-title' }, '当前不是内网访问'),
        h('p', { className: 'dsh-ra-card-hint' }, '确认或拒绝 cookie 只能在局域网 / 本机直接访问 DSH 时进行。请在内网浏览器打开设置页完成确认。'),
        h(StatusList, { status: status }),
      )
    } else {
      body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        h(StatusList, { status: status }),
        h('div', { className: 'dsh-ra-card' },
          h('p', { className: 'dsh-ra-card-title' }, '等待确认'),
          h('p', { className: 'dsh-ra-card-hint' }, '外网浏览器打开后 5 分钟内有效。让对方读出页面上的配对码，与这里核对后确认。'),
          pending.length === 0
            ? h('p', { className: 'dsh-ra-empty' }, '当前没有等待确认的连接。')
            : pending.map(function (item) {
                return h(Item, {
                  key: item.id, item: item, mode: 'pending', now: now, busy: busy,
                  disabled: busy !== '', onAction: act,
                })
              }),
        ),
        h('div', { className: 'dsh-ra-card' },
          h('p', { className: 'dsh-ra-card-title' }, '已确认的会话'),
          h('p', { className: 'dsh-ra-card-hint' }, '撤销后该浏览器立即失去访问权，需要重新配对。重启 DSH 不会影响这里的会话，直到各自的有效期结束。'),
          sessions.length === 0
            ? h('p', { className: 'dsh-ra-empty' }, '尚无已确认的外网会话。')
            : sessions.map(function (item) {
                return h(Item, {
                  key: item.id, item: item, mode: 'session', now: now, busy: busy,
                  disabled: busy !== '', onAction: act,
                })
              }),
        ),
      )
    }

    return h('div', { className: 'dsh-ra-section' },
      h('div', { className: 'dsh-ra-head' },
        h('h3', { className: 'dsh-ra-title' }, '外网访问'),
        h('p', { className: 'dsh-ra-desc' }, '通过 HTTPS 把 DSH 开放到外网；每个新浏览器都要在本机确认 cookie 后才能访问。未确认的 cookie 5 分钟后自动失效；已确认会话会持久化，重启 DSH 后仍然有效，到期后自动清理。'),
      ),
      error && status !== null ? h('p', { className: 'dsh-ra-error' }, error) : null,
      body,
      h('p', { className: 'dsh-ra-footnote' }, '公网端口需要在路由器/防火墙放行。证书续期后覆盖 ~/.dsh/remote-access/tls/ 下的 fullchain.pem 与 privkey.pem，然后重载插件。'),
    )
  }

  function injectStyles() {
    if (typeof document === 'undefined' || document.head === undefined) return undefined
    if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID) !== null) return undefined
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
    return function () {
      if (style.parentNode) style.parentNode.removeChild(style)
    }
  }

  function apply(ctx) {
    var removeStyles = injectStyles()
    if (removeStyles !== undefined && typeof ctx.effect === 'function') {
      ctx.effect(function () { return removeStyles })
    }
    var slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', function () {
      return slots.register(
        { name: 'settings.section', id: 'remote-web-access', order: 40, label: '外网访问' },
        function () { return h(RemoteAccessSection, {}) },
      )
    })
  }

  exports.apply = apply
  exports.inject = ['slots']
  return module.exports
}})
