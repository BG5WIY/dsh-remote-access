// dsh-remote-access client half（DSH ModuleLoader 格式）。
//
// 在「设置」里注册一个「外网访问」分区：列出等待确认的 cookie、已确认的会话，
// 并提供确认 / 拒绝 / 撤销。确认按钮只在 `status.internal === true` 时渲染，
// 服务端对非内网来源同样会拒绝，界面限制只是第一道。
//
// bundle 注册 id 必须与 package.json 的 name 完全一致，否则 DSH 会报
// "loaded without registering ... via __ModuleLoader__.load"。

window.__ModuleLoader__.load({ id: 'dsh-remote-access', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')
  var h = React.createElement

  var API = '/api/remote-access'

  var COLORS = {
    border: 'rgba(127,127,127,0.28)',
    soft: 'rgba(127,127,127,0.12)',
    faint: 'rgba(127,127,127,0.65)',
    danger: '#d9534f',
    ok: '#2f9e6e',
    warn: '#c98a1b',
  }

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

  var sectionStyle = { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' }
  var cardStyle = { border: '1px solid ' + COLORS.border, borderRadius: '10px', padding: '14px 16px' }
  var titleStyle = { margin: '0 0 6px', fontSize: '14px', fontWeight: 600 }
  var hintStyle = { margin: '0', color: COLORS.faint, fontSize: '13px', lineHeight: 1.65 }
  var rowStyle = {
    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
    padding: '10px 0', borderTop: '1px solid ' + COLORS.soft,
  }
  var codeStyle = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '17px', fontWeight: 700, letterSpacing: '0.14em',
    padding: '2px 8px', borderRadius: '6px', background: COLORS.soft,
  }
  var buttonStyle = {
    border: '1px solid ' + COLORS.border, background: 'transparent', color: 'inherit',
    borderRadius: '7px', padding: '5px 12px', fontSize: '13px', cursor: 'pointer',
  }

  function PrimaryButton(props) {
    return h('button', {
      type: 'button',
      disabled: props.disabled,
      onClick: props.onClick,
      style: Object.assign({}, buttonStyle, {
        borderColor: props.danger ? COLORS.danger : COLORS.ok,
        color: props.danger ? COLORS.danger : COLORS.ok,
        opacity: props.disabled ? 0.5 : 1,
      }),
    }, props.label)
  }

  function StatusGrid(props) {
    var status = props.status
    var items = [
      ['公网地址', status.publicUrl || status.listenHost + ':' + status.listenPort],
      ['本机 DSH', status.upstream],
      ['TLS', status.tls.selfSigned ? '自签证书' : '已配置证书'],
      ['未确认', String(status.pendingCount) + ' 个'],
      ['已确认', String(status.approvedCount) + ' 个'],
      ['定期清理', status.nextClearAt ? fmtClock(status.nextClearAt) : '已关闭'],
      ['持久化', status.persisted ? '已保存到磁盘' : '仅内存'],
    ]
    return h('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' },
    }, items.map(function (item, i) {
      return h('div', { key: String(i), style: Object.assign({}, cardStyle, { padding: '10px 12px' }) },
        h('div', { style: { fontSize: '11px', color: COLORS.faint, marginBottom: '3px' } }, item[0]),
        h('div', { style: { fontSize: '13px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' } }, item[1]),
      )
    }))
  }

  function PendingList(props) {
    var pending = props.pending
    if (pending.length === 0) {
      return h('p', { style: hintStyle }, '当前没有等待确认的连接。')
    }
    return h('div', null, pending.map(function (item) {
      var left = item.expiresAt - props.now
      return h('div', { key: item.id, style: rowStyle },
        h('span', { style: codeStyle }, item.code),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 220px', minWidth: 0 } },
          h('span', { style: { fontSize: '13px' } }, (item.address || '未知地址')),
          h('span', { style: { fontSize: '12px', color: COLORS.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.userAgent || '未知客户端'),
        ),
        h('span', { style: { fontSize: '12px', color: left < 60000 ? COLORS.danger : COLORS.faint } }, '剩余 ' + fmtTime(left)),
        h(PrimaryButton, { label: props.busy === item.id + 'approve' ? '确认中…' : '确认', disabled: props.busy !== '', onClick: function () { props.onApprove(item.id) } }),
        h(PrimaryButton, { label: '拒绝', danger: true, disabled: props.busy !== '', onClick: function () { props.onDeny(item.id) } }),
      )
    }))
  }

  function SessionList(props) {
    var sessions = props.sessions
    if (sessions.length === 0) {
      return h('p', { style: hintStyle }, '尚无已确认的外网会话。')
    }
    return h('div', null, sessions.map(function (item) {
      return h('div', { key: item.id, style: rowStyle },
        h('span', { style: codeStyle }, item.code),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 220px', minWidth: 0 } },
          h('span', { style: { fontSize: '13px' } }, (item.address || '未知地址')),
          h('span', { style: { fontSize: '12px', color: COLORS.faint } }, '确认于 ' + fmtClock(item.approvedAt) + ' · 有效至 ' + fmtClock(item.expiresAt)),
        ),
        h(PrimaryButton, { label: props.busy === item.id + 'revoke' ? '撤销中…' : '撤销', danger: true, disabled: props.busy !== '', onClick: function () { props.onRevoke(item.id) } }),
      )
    }))
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

    async function act(path, id) {
      setBusy(id + path)
      try {
        await call('/' + path, { method: 'POST', body: JSON.stringify({ id: id }) })
      } catch (e) {
        setError(e && e.message ? e.message : String(e))
      } finally {
        setBusy('')
        await refresh()
      }
    }

    var body
    if (status === null) {
      body = h('p', { style: hintStyle }, error ? '无法读取状态：' + error : '正在读取状态…')
    } else if (!status.internal) {
      body = h('div', { style: Object.assign({}, cardStyle, { borderColor: COLORS.warn }) },
        h('p', { style: titleStyle }, '当前不是内网访问'),
        h('p', { style: hintStyle }, '确认或拒绝 cookie 只能在局域网 / 本机直接访问 DSH 时进行。请在内网浏览器打开设置页完成确认。'),
        h(StatusGrid, { status: status }),
      )
    } else {
      body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        h(StatusGrid, { status: status }),
        h('div', { style: cardStyle },
          h('p', { style: titleStyle }, '等待确认'),
          h('p', { style: hintStyle }, '外网浏览器打开后 5 分钟内有效。让对方读出页面上的配对码，与这里核对后确认。'),
          h(PendingList, { pending: pending, now: now, busy: busy, onApprove: function (id) { act('approve', id) }, onDeny: function (id) { act('deny', id) } }),
        ),
        h('div', { style: cardStyle },
          h('p', { style: titleStyle }, '已确认的会话'),
          h('p', { style: hintStyle }, '撤销后该浏览器立即失去访问权，需要重新配对。重启 DSH 不会影响这里的会话，直到有效期满或定期清理。'),
          h(SessionList, { sessions: sessions, busy: busy, onRevoke: function (id) { act('revoke', id) } }),
        ),
      )
    }

    return h('div', { style: sectionStyle },
      h('div', null,
        h('h3', { style: { margin: '0 0 6px', fontSize: '16px' } }, '外网访问'),
        h('p', { style: hintStyle }, '通过 HTTPS 把 DSH 开放到外网；每个新浏览器都要在本机确认 cookie 后才能访问。未确认的 cookie 5 分钟后自动失效；已确认会话会持久化，重启 DSH 后仍然有效，并按周期全部作废。'),
      ),
      error && status !== null ? h('p', { style: { margin: 0, color: COLORS.danger, fontSize: '13px' } }, error) : null,
      body,
      h('p', { style: Object.assign({}, hintStyle, { borderTop: '1px solid ' + COLORS.soft, paddingTop: '12px' }) },
        '公网端口需要在路由器/防火墙放行。自签证书首次访问会有浏览器警告；生产使用请在插件配置里填 tlsCertFile / tlsKeyFile。',
      ),
    )
  }

  function apply(ctx) {
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
