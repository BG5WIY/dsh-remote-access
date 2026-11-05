/**
 * dsh-remote-access — 带配对验证的 HTTPS 外网入口。
 *
 * 这个文件只做三件事，不依赖 cordis / DSH：
 *   1. 在公网地址上开一个 TLS 监听，把已验证的请求反向代理到本机 DSH Web。
 *   2. 为每个浏览器发放 `dsh_ra` cookie；未确认的 cookie 只能看到等待页，
 *      有效期 `pendingTtlMs`（默认 5 分钟）。
 *   3. 把待确认、已确认的会话暴露给设置页的 Host API（由 index.js 挂载）。
 *
 * 安全约束：
 *   - 未确认的 cookie 一个字节都不会转发到 DSH。
 *   - 代理转发时强制覆盖 `x-dsh-ra-proxy`，Host API 靠它识别"外网"来源。
 *   - cookie 只通过 HTTPS 监听下发，`Secure; HttpOnly; SameSite=Lax`。
 */

import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomBytes, randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const COOKIE_NAME = 'dsh_ra'
export const INTERNAL_PATH = '/__dsh_ra/'
export const PROXY_MARKER_HEADER = 'x-dsh-ra-proxy'
export const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const HSTS_HEADER = 'max-age=15552000'

/** 持久化状态文件的格式版本；不兼容时丢弃旧文件重新开始。 */
const STATE_VERSION = 1

/** 逐跳头：不能跨代理转发，否则连接语义会串。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function parseCookies(header) {
  const cookies = new Map()
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    const name = part.slice(0, at).trim()
    if (name === '' || cookies.has(name)) continue
    cookies.set(name, part.slice(at + 1).trim())
  }
  return cookies
}

function clientAddress(req) {
  const address = req.socket?.remoteAddress ?? ''
  // 去掉 IPv4-mapped 前缀，展示和比较都更直观。
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function shortUserAgent(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'strict-transport-security': HSTS_HEADER,
  })
  res.end(body)
}

function sanitizeHeaders(raw, upstreamHost) {
  const headers = {}
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'cookie' || lower === 'origin' || lower === 'referer') continue
    if (lower === PROXY_MARKER_HEADER) continue
    if (lower === 'expect') continue
    headers[lower] = value
  }
  headers.host = upstreamHost
  headers[PROXY_MARKER_HEADER] = '1'
  return headers
}

function sanitizeResponseHeaders(raw) {
  const headers = {}
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'set-cookie') {
      // 上游的 dsh-auth cookie 属于代理自己的上游身份，不能泄露给外网浏览器。
      const kept = (Array.isArray(value) ? value : [value])
        .filter((cookie) => !String(cookie).startsWith('dsh-auth-'))
      if (kept.length > 0) headers[lower] = kept
      continue
    }
    headers[lower] = value
  }
  headers['strict-transport-security'] = HSTS_HEADER
  return headers
}

/**
 * @param {object} options
 * @param {string} options.listenHost 公网监听地址（0.0.0.0 表示所有接口）。
 * @param {number} options.listenPort TLS 监听端口。
 * @param {{key: string|Buffer, cert: string|Buffer, source: string, selfSigned: boolean}} options.tls
 * @param {string} options.upstreamHost 本机 DSH Web 地址。
 * @param {number} options.upstreamPort 本机 DSH Web 端口。
 * @param {'http:'|'https:'} [options.upstreamProtocol] 本机 DSH Web 的协议。
 * @param {number} [options.pendingTtlMs] 未确认 cookie 的有效期。
 * @param {number} [options.sessionTtlMs] 已确认 cookie 的有效期。
 * @param {string} [options.statePath] 持久化文件路径；省略则只在内存里保存。
 * @param {string} [options.publicHost] 对外域名，仅用于展示和生成公网 URL。
 * @param {() => Promise<string|undefined>} options.getUpstreamCookie 取得代理访问 DSH 所需的 Cookie 头。
 * @param {() => number} [options.now] 可注入时钟（测试用）。
 * @param {(message: string) => void} [options.log]
 */
export function createRemoteAccessProxy(options) {
  const {
    listenHost,
    listenPort,
    tls,
    upstreamHost,
    upstreamPort,
    upstreamProtocol = 'http:',
    pendingTtlMs = DEFAULT_PENDING_TTL_MS,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    statePath,
    publicHost,
    getUpstreamCookie,
    now = () => Date.now(),
    log = () => {},
  } = options

  const upstreamAuthority = `${upstreamHost.includes(':') ? `[${upstreamHost}]` : upstreamHost}:${upstreamPort}`
  const sessions = new Map()
  const server = createServer({ key: tls.key, cert: tls.cert })
  let boundPort = listenPort
  let sweeper

  /**
   * 持久化只保存已确认的会话：cookie 值本身就是凭证，所以文件 0600、目录 0700。
   * 写入走临时文件 + rename，避免进程中断留下半个 JSON。
   */
  function saveState() {
    if (statePath === undefined) return
    try {
      const rows = [...sessions.values()]
        .filter((session) => session.approvedAt !== undefined)
        .map((session) => ({
          id: session.id,
          code: session.code,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          approvedAt: session.approvedAt,
          address: session.address,
          userAgent: session.userAgent,
        }))
      const payload = JSON.stringify({ version: STATE_VERSION, sessions: rows })
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
      const temporary = `${statePath}.${process.pid}.tmp`
      writeFileSync(temporary, payload, { mode: 0o600 })
      renameSync(temporary, statePath)
    } catch (error) {
      log(`failed to persist sessions: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function loadState() {
    if (statePath === undefined) return
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) {
        throw new Error('unsupported session state')
      }
      for (const row of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
        if (typeof row?.id !== 'string' || !Number.isFinite(row?.expiresAt)) continue
        sessions.set(row.id, {
          id: row.id,
          code: String(row.code ?? ''),
          createdAt: Number.isFinite(row.createdAt) ? row.createdAt : now(),
          expiresAt: row.expiresAt,
          approvedAt: Number.isFinite(row.approvedAt) ? row.approvedAt : now(),
          address: String(row.address ?? ''),
          userAgent: String(row.userAgent ?? ''),
        })
      }
    } catch (error) {
      // 文件不存在是首次启动；损坏或版本不符则重新开始，不让旧数据卡住插件。
      if (error?.code !== 'ENOENT') {
        log(`discarded session state: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  loadState()

  function purge() {
    const at = now()
    let changed = false
    for (const session of sessions.values()) {
      if (session.expiresAt <= at) {
        sessions.delete(session.id)
        changed = true
      }
    }
    if (changed) saveState()
  }

  function newSession(req) {
    purge()
    const session = {
      id: randomBytes(24).toString('base64url'),
      code: `${String(randomInt(0, 1_000_000)).padStart(6, '0')}`,
      createdAt: now(),
      expiresAt: now() + pendingTtlMs,
      approvedAt: undefined,
      address: clientAddress(req),
      userAgent: shortUserAgent(req.headers['user-agent']),
    }
    sessions.set(session.id, session)
    return session
  }

  function sessionOf(req) {
    const id = parseCookies(req.headers.cookie).get(COOKIE_NAME)
    if (id === undefined) return undefined
    const session = sessions.get(id)
    if (session === undefined) return undefined
    if (session.expiresAt <= now()) {
      sessions.delete(id)
      saveState()
      return undefined
    }
    return session
  }

  // 浏览器端保存期与已确认会话一致；Session cookie 会被 Safari 在关闭标签页时丢掉。
  const cookieMaxAgeSeconds = Math.max(1, Math.floor(sessionTtlMs / 1000))

  function sessionCookie(id) {
    return `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${cookieMaxAgeSeconds}`
  }

  function setSessionCookie(res, id) {
    res.setHeader('set-cookie', sessionCookie(id))
  }

  /** 只允许通过配置的域名访问；未配置 publicHost 时不做限制。 */
  function hostAllowed(req) {
    if (typeof publicHost !== 'string' || publicHost === '') return true
    const raw = req.headers.host
    if (typeof raw !== 'string' || raw === '') return false
    try {
      return new URL(`https://${raw}`).hostname.toLowerCase() === publicHost.toLowerCase()
    } catch {
      return false
    }
  }

  function rejectHost(res) {
    const url = `https://${publicHost}${boundPort === 443 ? '' : `:${boundPort}`}/`
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>请使用域名访问</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC",sans-serif;background:#0f1115;color:#e6e8ec}.card{max-width:520px;padding:28px;border:1px solid #2a2f3a;border-radius:14px;background:#161a21}h1{margin:0 0 8px;font-size:18px}p{margin:8px 0;color:#a9b0bd}a{color:#7ee0b8;word-break:break-all}</style>
</head><body><main class="card"><h1>请使用域名访问</h1>
<p>这个入口只接受 <b>${escapeHtml(publicHost)}</b> 域名。</p>
<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p></main></body></html>`
    res.writeHead(421, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'strict-transport-security': HSTS_HEADER,
    })
    res.end(html)
  }

  function displayCode(session) {
    return session.code
  }

  function waitingPage(res, session) {
    const remaining = Math.max(0, Math.ceil((session.expiresAt - now()) / 1000))
    const code = escapeHtml(displayCode(session))
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 外网访问 · 等待确认</title>
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e8ec}
.card{max-width:540px;width:calc(100% - 40px);padding:32px;border:1px solid #2a2f3a;border-radius:16px;background:#161a21;box-shadow:0 20px 60px rgba(0,0,0,.35)}
h1{margin:0 0 8px;font-size:19px}
p{margin:8px 0;color:#a9b0bd}
.code{margin:22px 0;padding:16px;border-radius:12px;background:#0f131a;border:1px dashed #3a4252;text-align:center;font:600 30px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.28em;color:#7ee0b8}
.steps{font-size:14px;color:#a9b0bd;padding-left:20px}
.steps li{margin:6px 0}
.state{margin-top:18px;font-size:13px;color:#7b8494}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#e0b25a;margin-right:8px;vertical-align:1px;animation:pulse 1.4s infinite}
@keyframes pulse{50%{opacity:.25}}
</style></head>
<body><main class="card">
<h1>等待内网确认</h1>
<p>这台浏览器还没有获得访问 DSH 的资格。请在 <b>能直接访问本机 DSH 页面</b> 的浏览器里确认下面的配对码。</p>
<div class="code">${code}</div>
<ol class="steps">
<li>打开本机 DSH 页面（例如 http://127.0.0.1:${upstreamPort}）。</li>
<li>进入 <b>设置 → 外网访问</b>。</li>
<li>找到配对码 <b>${code}</b>，点击「确认」。</li>
</ol>
<p class="state"><span class="dot"></span><span id="state">剩余 <span id="left">${remaining}</span> 秒；确认后本页自动进入</span></p>
</main>
<script>
(function(){
  var left = document.getElementById('left');
  var state = document.getElementById('state');
  var deadline = Date.now() + ${remaining} * 1000;
  function tick(){
    fetch('${INTERNAL_PATH}status', { cache: 'no-store' }).then(function(r){ return r.json() }).then(function(info){
      if (info && info.state === 'approved') { location.replace('/'); return; }
      if (info && info.state === 'none') { location.reload(); return; }
      var rest = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (left) left.textContent = String(rest);
      if (rest === 0) { state.textContent = '已过期，正在重新申请…'; location.reload(); return; }
      setTimeout(tick, 2000);
    }).catch(function(){ setTimeout(tick, 3000); });
  }
  setTimeout(tick, 1200);
})();
</script>
</body></html>`
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'referrer-policy': 'no-referrer',
      'strict-transport-security': HSTS_HEADER,
    })
    res.end(html)
  }

  function handleInternal(req, res, session) {
    const path = new URL(req.url ?? '/', 'https://internal.invalid').pathname
    if (path === `${INTERNAL_PATH}status`) {
      if (session === undefined) {
        sendJson(res, 200, { state: 'none' })
        return
      }
      sendJson(res, 200, {
        state: session.approvedAt === undefined ? 'pending' : 'approved',
        code: session.approvedAt === undefined ? displayCode(session) : undefined,
        expiresAt: session.expiresAt,
        pendingTtlMs,
      })
      return
    }
    sendJson(res, 404, { state: 'not-found' })
  }

  async function upstreamCookie() {
    try {
      const cookie = await getUpstreamCookie()
      return typeOfCookie(cookie)
    } catch (error) {
      log(`upstream login failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  function typeOfCookie(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }

  async function forward(req, res) {
    const cookie = await upstreamCookie()
    const headers = sanitizeHeaders(req.headers, upstreamAuthority)
    if (cookie !== undefined) headers.cookie = cookie

    const request = upstreamProtocol === 'https:' ? httpsRequest : httpRequest
    const upstream = request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        if (res.destroyed) {
          response.destroy()
          return
        }
        const headers = sanitizeResponseHeaders(response.headers)
        // 上游可能有自己的 set-cookie；writeHead 会覆盖 setHeader，这里显式合并。
        const ours = res.getHeader('set-cookie')
        if (ours !== undefined) {
          const upstream = headers['set-cookie'] === undefined
            ? []
            : Array.isArray(headers['set-cookie'])
              ? headers['set-cookie']
              : [headers['set-cookie']]
          headers['set-cookie'] = [...upstream, ...(Array.isArray(ours) ? ours : [ours])]
        }
        res.writeHead(response.statusCode ?? 502, headers)
        response.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      log(`upstream request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) {
        sendJson(res, 502, { error: 'upstream-unavailable' })
      } else {
        res.destroy()
      }
    })
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })
    req.pipe(upstream)
  }

  async function handleRequest(req, res) {
    try {
      if (!hostAllowed(req)) {
        rejectHost(res)
        return
      }
      const path = new URL(req.url ?? '/', 'https://internal.invalid').pathname
      let session = sessionOf(req)

      if (path.startsWith(INTERNAL_PATH)) {
        handleInternal(req, res, session)
        return
      }

      if (session === undefined) session = newSession(req)
      // 每次访问都刷新 Max-Age：旧浏览器里的 session cookie 也会升级成持久 cookie。
      setSessionCookie(res, session.id)

      if (session.approvedAt === undefined) {
        waitingPage(res, session)
        return
      }

      await forward(req, res)
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal-error' })
      else res.destroy()
    }
  }

  async function handleUpgrade(req, socket, head) {
    try {
      if (!hostAllowed(req)) {
        socket.write('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      const session = sessionOf(req)
      if (session === undefined || session.approvedAt === undefined) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }

      const cookie = await upstreamCookie()
      const headers = {}
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase()
        if (lower === 'cookie' || lower === 'origin' || lower === 'referer') continue
        if (lower === PROXY_MARKER_HEADER) continue
        headers[lower] = value
      }
      headers.host = upstreamAuthority
      headers[PROXY_MARKER_HEADER] = '1'
      if (cookie !== undefined) headers.cookie = cookie

      const upstream =
        upstreamProtocol === 'https:'
          ? tlsConnect({ host: upstreamHost, port: upstreamPort, rejectUnauthorized: false })
          : netConnect({ host: upstreamHost, port: upstreamPort })
      let settled = false
      const fail = () => {
        if (settled) return
        settled = true
        upstream.destroy()
        socket.destroy()
      }
      upstream.on('error', fail)
      socket.on('error', fail)
      socket.on('close', () => upstream.destroy())

      upstream.on('connect', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`]
        for (const [name, value] of Object.entries(headers)) {
          if (Array.isArray(value)) {
            for (const item of value) lines.push(`${name}: ${item}`)
          } else if (value !== undefined) {
            lines.push(`${name}: ${value}`)
          }
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head !== undefined && head.length > 0) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
    } catch (error) {
      log(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`)
      socket.destroy()
    }
  }

  server.on('request', (req, res) => {
    void handleRequest(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head)
  })

  function listPending() {
    purge()
    return [...sessions.values()]
      .filter((session) => session.approvedAt === undefined)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => ({
        id: session.id,
        code: session.code,
        address: session.address,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      }))
  }

  function listApproved() {
    purge()
    return [...sessions.values()]
      .filter((session) => session.approvedAt !== undefined)
      .sort((a, b) => b.approvedAt - a.approvedAt)
      .map((session) => ({
        id: session.id,
        code: session.code,
        address: session.address,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        approvedAt: session.approvedAt,
        expiresAt: session.expiresAt,
      }))
  }

  function approve(id) {
    purge()
    const session = sessions.get(id)
    if (session === undefined || session.approvedAt !== undefined) return false
    session.approvedAt = now()
    session.expiresAt = now() + sessionTtlMs
    saveState()
    return true
  }

  function deny(id) {
    const session = sessions.get(id)
    if (session === undefined || session.approvedAt !== undefined) return false
    sessions.delete(id)
    saveState()
    return true
  }

  function revoke(id) {
    const session = sessions.get(id)
    if (session === undefined || session.approvedAt === undefined) return false
    sessions.delete(id)
    saveState()
    return true
  }

  function publicUrl() {
    if (typeof publicHost !== 'string' || publicHost === '') return undefined
    return `https://${publicHost}${boundPort === 443 ? '' : `:${boundPort}`}/`
  }

  function status() {
    purge()
    return {
      listenHost,
      listenPort: boundPort,
      upstream: upstreamAuthority,
      tls: { source: tls.source, selfSigned: tls.selfSigned },
      upstreamProtocol,
      publicHost,
      publicUrl: publicUrl(),
      pendingTtlMs,
      sessionTtlMs,
      persisted: statePath !== undefined,
      pendingCount: listPending().length,
      approvedCount: listApproved().length,
    }
  }

  return {
    approve,
    close() {
      if (sweeper !== undefined) clearInterval(sweeper)
      sweeper = undefined
      saveState()
      sessions.clear()
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(() => resolve()))
    },
    deny,
    listApproved,
    listPending,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ port: listenPort, host: listenHost, ipv6Only: false }, () => {
          server.off('error', reject)
          boundPort = server.address().port
          sweeper = setInterval(() => purge(), 30_000)
          sweeper.unref?.()
          resolve(boundPort)
        })
      })
    },
    revoke,
    status,
    get port() {
      return boundPort
    },
  }
}
