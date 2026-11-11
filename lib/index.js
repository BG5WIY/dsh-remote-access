/**
 * dsh-remote-access — Host 入口。
 *
 * 组合三块：
 *   1. `proxy.js`：公网 HTTPS 监听 + cookie 配对 + 反向代理到本机 DSH Web。
 *   2. 上游认证：复用 DSH 自己的浏览器 launch token，换一个代理专用的 dsh-auth
 *      cookie；外网浏览器永远不会拿到它。
 *   3. 设置页 Host API：`/api/remote-access/*`，只有内网/本机来源能确认 cookie。
 *
 * 外网请求经代理转发时会带上 `x-dsh-ra-proxy: 1`，Host API 据此判定"非内网"，
 * 即使 TCP 来源是 127.0.0.1（代理就在本机）也拒绝任何确认操作。
 */

import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { promisify } from 'node:util'
import {
  COOKIE_NAME,
  PROXY_MARKER_HEADER,
  createRemoteAccessProxy,
} from './proxy.js'

const execFileAsync = promisify(execFile)

const SERVICE = 'dsh-remote-access'
const API_PREFIX = '/api/remote-access'
const UPSTREAM_COOKIE_TTL_MS = 12 * 60 * 60 * 1000

export const name = 'dsh-remote-access'
export const inject = ['webServer', 'connection']

function log(message) {
  try {
    process.stderr.write(`[${SERVICE}] ${message}\n`)
  } catch {
    /* stderr 不可写时静默 */
  }
}

function dshHome() {
  const explicit = process.env.DSH_HOME
  return explicit !== undefined && explicit.trim() !== '' ? explicit.trim() : join(homedir(), '.dsh')
}

function isPrivateAddress(raw) {
  if (typeof raw !== 'string' || raw === '') return false
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  if (address === '::1') return true
  if (/^127\./u.test(address)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address)
  if (v4 !== null) {
    const first = Number(v4[1])
    const second = Number(v4[2])
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    )
  }
  const lower = address.toLowerCase()
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
}

/** 请求是否来自内网直连。代理转发的请求一定带标记头，不参与判断。 */
function isInternalRequest(req) {
  if (req.headers[PROXY_MARKER_HEADER] !== undefined) return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      // 同源请求才接受；浏览器跨站请求的 Origin 指向别的站点，直接拒绝。
      if (new URL(origin).host !== req.headers.host) return false
    } catch {
      return false
    }
  }
  const address = req.socket?.remoteAddress ?? ''
  return isPrivateAddress(address)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sanEntries(config) {
  const entries = ['DNS:localhost', 'IP:127.0.0.1']
  const extra = Array.isArray(config.certNames) ? config.certNames : []
  for (const raw of extra) {
    const value = String(raw).trim()
    if (value === '') continue
    entries.push(/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value) || value.includes(':') ? `IP:${value}` : `DNS:${value}`)
  }
  return [...new Set(entries)].join(',')
}

async function readPair(certPath, keyPath) {
  const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')])
  return { cert, key }
}

/**
 * 证书来源：显式配置优先；否则在 $DSH_HOME/remote-access/tls 下自签一张
 * （仅当首次使用）。自签证书的 SAN 默认覆盖 localhost/127.0.0.1，可用
 * `certNames` 追加公网域名或 IP。TLS 材料不可用时插件直接加载失败，不会回退 HTTP。
 */
async function resolveTls(config) {
  if (config.tlsCertFile !== undefined && config.tlsKeyFile !== undefined) {
    const { cert, key } = await readPair(config.tlsCertFile, config.tlsKeyFile)
    return { cert, key, source: config.tlsCertFile, selfSigned: false }
  }

  const dir = join(dshHome(), 'remote-access', 'tls')
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  try {
    const { cert, key } = await readPair(certPath, keyPath)
    return { cert, key, source: certPath, selfSigned: true }
  } catch {
    /* 首次使用，生成自签证书 */
  }

  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-subj', '/CN=dsh-remote-access',
      '-addext', `subjectAltName=${sanEntries(config)}`,
      '-keyout', keyPath,
      '-out', certPath,
    ])
    await chmod(keyPath, 0o600)
  } catch (error) {
    throw new Error(
      `dsh-remote-access: 无法生成 TLS 自签证书（${error instanceof Error ? error.message : String(error)}）。` +
        ' 请配置 tlsCertFile / tlsKeyFile，或安装 openssl。',
    )
  }
  const { cert, key } = await readPair(certPath, keyPath)
  log(`generated self-signed TLS certificate at ${certPath}`)
  return { cert, key, source: certPath, selfSigned: true }
}

/** 用一个外部可见的地址登录本机 DSH，换回代理专用的 dsh-auth cookie。 */
async function exchangeLaunchCookie(connection, origin) {
  const target = new URL(connection.authenticatedUrl(new URL('/', origin).href))
  const secure = target.protocol === 'https:'
  const request = secure ? httpsRequest : httpRequest
  const setCookies = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname.replace(/^\[|\]$/gu, ''),
        port: target.port !== '' ? Number(target.port) : secure ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { host: target.host },
        rejectUnauthorized: false,
        timeout: 10_000,
      },
      (res) => {
        res.resume()
        resolve(res.headers['set-cookie'] ?? [])
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('upstream login timed out')))
    req.end()
  })

  const cookies = setCookies
    .map((cookie) => String(cookie).split(';')[0])
    .filter((cookie) => cookie.startsWith('dsh-auth-'))
  if (cookies.length === 0) {
    throw new Error('DSH did not issue a browser cookie for the proxy login')
  }
  return cookies.join('; ')
}

export async function apply(ctx, config = {}) {
  const listenHost = typeof config.listenHost === 'string' && config.listenHost !== '' ? config.listenHost : '::'
  const listenPort = Number.isInteger(config.listenPort) ? config.listenPort : 8443
  const host = cfgHost(ctx)
  const port = cfgPort(ctx)
  const tempSessionTtlMs = positiveInt(config.tempSessionTtlMs, 12 * 60 * 60 * 1000)
  const tls = await resolveTls(config)

  let cachedCookie
  let cachedAt = 0
  let loginInFlight

  async function freshUpstreamCookie() {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') {
      throw new Error('dsh connection service is unavailable; cannot authenticate the proxy upstream')
    }
    const cookie = await exchangeLaunchCookie(connection, ctx.webServer.getOrigin())
    cachedCookie = cookie
    cachedAt = Date.now()
    return cookie
  }

  async function getUpstreamCookie() {
    if (cachedCookie !== undefined && Date.now() - cachedAt < UPSTREAM_COOKIE_TTL_MS) return cachedCookie
    loginInFlight ??= freshUpstreamCookie().finally(() => {
      loginInFlight = undefined
    })
    return loginInFlight
  }

  const proxy = createRemoteAccessProxy({
    getUpstreamCookie,
    listenHost,
    listenPort,
    log,
    publicHost: typeof config.publicHost === 'string' && config.publicHost.trim() !== '' ? config.publicHost.trim() : undefined,
    pendingTtlMs: positiveInt(config.pendingTtlMs, 5 * 60 * 1000),
    sessionTtlMs: positiveInt(config.sessionTtlMs, 30 * 24 * 60 * 60 * 1000),
    tempSessionTtlMs,
    statePath:
      typeof config.statePath === 'string' && config.statePath !== ''
        ? config.statePath
        : join(dshHome(), 'remote-access', 'sessions.json'),
    tls,
    upstreamHost: host,
    upstreamPort: port,
    upstreamProtocol: ctx.webServer.protocol,
  })

  async function handleApi(req, res) {
    const internal = isInternalRequest(req)
    const path = new URL(req.url ?? '/', 'https://internal.invalid').pathname.slice(API_PREFIX.length) || '/'

    if (req.method === 'GET' && path === '/status') {
      sendJson(res, 200, {
        ok: true,
        internal,
        ...proxy.status(),
        upstreamWeb: { host, port, protocol: ctx.webServer.protocol },
      })
      return
    }

    if (req.headers['x-dsh-ra'] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing-request-header' })
      return
    }

    if (!internal) {
      sendJson(res, 403, { ok: false, error: 'internal-only' })
      return
    }

    if (req.method === 'GET' && path === '/pending') {
      sendJson(res, 200, { ok: true, internal, pending: proxy.listPending(), pendingTtlMs: proxy.status().pendingTtlMs })
      return
    }

    if (req.method === 'GET' && path === '/sessions') {
      sendJson(res, 200, { ok: true, internal, sessions: proxy.listApproved(), sessionTtlMs: proxy.status().sessionTtlMs })
      return
    }

    if (req.method === 'GET' && path === '/key') {
      sendJson(res, 200, { ok: true, internal, configured: proxy.hasFixedKey() })
      return
    }

    if (req.method === 'POST' && path === '/key') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad-request' })
        return
      }
      const key = typeof body.key === 'string' ? body.key : ''
      if (!proxy.setFixedKey(key)) {
        sendJson(res, 400, { ok: false, error: 'invalid-key-length' })
        return
      }
      log('updated fixed access key')
      sendJson(res, 200, { ok: true, configured: true })
      return
    }

    if (req.method === 'POST' && path === '/key/clear') {
      proxy.clearFixedKey()
      log('cleared fixed access key')
      sendJson(res, 200, { ok: true, configured: false })
      return
    }

    if (req.method === 'POST' && (path === '/approve' || path === '/deny' || path === '/revoke')) {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad-request' })
        return
      }
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        sendJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const changed =
        path === '/approve' ? proxy.approve(id) : path === '/deny' ? proxy.deny(id) : proxy.revoke(id)
      if (!changed) {
        sendJson(res, 404, { ok: false, error: 'not-found' })
        return
      }
      log(`${path.slice(1)}d session ${id.slice(0, 8)}… from ${req.socket?.remoteAddress ?? 'unknown'}`)
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not-found' })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: (req, res) => void handleApi(req, res) }),
    'remote-access: api routes',
  )

  const boundPort = await proxy.listen()
  log(
    `HTTPS ${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${boundPort} -> ${host}:${port}` +
      (tls.selfSigned ? ` (self-signed: ${tls.source})` : ` (certificate: ${tls.source})`),
  )

  ctx.effect(() => () => proxy.close(), 'remote-access: proxy listener')
}

function cfgHost(ctx) {
  const host = ctx.webServer.host
  return typeof host === 'string' && host !== '' ? host : '127.0.0.1'
}

function cfgPort(ctx) {
  const port = ctx.webServer.port
  if (!Number.isInteger(port)) throw new Error('dsh-remote-access: the DSH web server has no listening port yet')
  return port
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}


export { COOKIE_NAME }
