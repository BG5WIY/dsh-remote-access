// 可执行自检：node lib/self-check.mjs
//
// 不依赖 DSH / cordis，只验证代理核心：
//   1. 未确认 cookie 只看到等待页，请求不会到达上游；
//   2. 内网确认后，同一 cookie 才被转发，且 Host 被重写、带上代理标记；
//   3. 未确认 cookie 到期后自动换新，确认状态不延续；
//   4. 撤销后立即失去访问权；
//   5. WebSocket/upgrade 与普通请求遵守同一套 cookie 规则。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteAccessProxy } from './proxy.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-ra-check-'))
const certPath = join(dir, 'cert.pem')
const keyPath = join(dir, 'key.pem')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-keyout', keyPath, '-out', certPath,
], { stdio: 'ignore' })
const tls = { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8'), source: certPath, selfSigned: true }

const upstreamHits = []
const upgradeHits = []
const upstream = createServer((req, res) => {
  upstreamHits.push({ url: req.url, headers: req.headers })
  if (req.url === '/with-cookie') {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'upstream=1; Path=/' })
    res.end('with-cookie')
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('upstream:' + req.url)
})
upstream.on('upgrade', (req, socket) => {
  upgradeHits.push({ url: req.url, headers: req.headers })
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n')
  socket.end('ws-ok')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

const proxy = createRemoteAccessProxy({
  getUpstreamCookie: async () => 'dsh-auth-test=proxy',
  listenHost: '127.0.0.1',
  listenPort: 0,
  log: () => {},
  pendingTtlMs: 400,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  tls,
  upstreamHost: '127.0.0.1',
  upstreamPort,
})
const port = await proxy.listen()

function fetchProxy(path, cookie, method = 'GET', hostHeader, targetPort = port) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1', port: targetPort, path, method, rejectUnauthorized: false,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(hostHeader === undefined ? {} : { host: hostHeader }),
      },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function cookieFrom(response) {
  const value = response.headers['set-cookie']?.[0] ?? ''
  const match = /^dsh_ra=([^;]+)/u.exec(value)
  assert.ok(match !== null, 'expected a dsh_ra cookie')
  return `dsh_ra=${match[1]}`
}

function codeFrom(response) {
  const match = /<div class="code">(\d{6})<\/div>/u.exec(response.body)
  assert.ok(match !== null, 'expected a pairing code in the waiting page')
  return match[1]
}

function pendingByCode(code) {
  const item = proxy.listPending().find((entry) => entry.code === code)
  assert.ok(item !== undefined, `pending session with code ${code} not found`)
  return item
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function postJson(path, cookie, payload, targetPort = port) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = httpsRequest({
      host: '127.0.0.1', port: targetPort, path, method: 'POST', rejectUnauthorized: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(cookie === undefined ? {} : { cookie }),
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

try {
  // 1. 新访客：拿到 pending cookie 和等待页，上游零请求。
  const first = await fetchProxy('/')
  assert.equal(first.status, 200)
  assert.match(first.body, /等待内网确认/u)
  // 持久 cookie：没有 Max-Age 时 Safari 关闭标签页就丢弃，会反复要求配对。
  assert.match(first.headers['set-cookie'][0], /Max-Age=2592000/u)
  assert.match(first.headers['set-cookie'][0], /HttpOnly/u)
  assert.match(first.headers['set-cookie'][0], /Secure/u)
  const pendingCookie = cookieFrom(first)
  assert.equal(upstreamHits.length, 0, 'unapproved request must not reach upstream')

  // 2. 待确认状态下反复访问：仍不转发，配对码稳定。
  const second = await fetchProxy('/api/session', pendingCookie)
  assert.equal(second.status, 200)
  assert.equal(upstreamHits.length, 0)
  const statusBefore = JSON.parse((await fetchProxy('/__dsh_ra/status', pendingCookie)).body)
  assert.equal(statusBefore.state, 'pending')
  assert.match(statusBefore.code, /^\d{6}$/u)

  // 3. 内网确认后：同一 cookie 被转发；Host 重写、代理标记存在、上游 cookie 注入。
  const [item] = proxy.listPending()
  assert.ok(item !== undefined)
  assert.equal(item.code, statusBefore.code)
  assert.equal(proxy.approve(item.id), true)
  assert.equal(proxy.approve(item.id), false, 'double approval must not re-extend')

  const forwarded = await fetchProxy('/api/session', pendingCookie)
  assert.equal(forwarded.status, 200)
  assert.equal(forwarded.body, 'upstream:/api/session')
  assert.match(forwarded.headers['set-cookie'][0], /Max-Age=2592000/u)

  // 上游自己的 set-cookie 不能覆盖 dsh_ra。
  const merged = await fetchProxy('/with-cookie', pendingCookie)
  assert.equal(merged.body, 'with-cookie')
  const mergedCookies = merged.headers['set-cookie'].join('\n')
  assert.match(mergedCookies, /dsh_ra=/u)
  assert.match(mergedCookies, /upstream=1/u)
  assert.equal(upstreamHits.length, 2)
  const seen = upstreamHits[0]
  assert.equal(seen.headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(seen.headers['x-dsh-ra-proxy'], '1')
  assert.equal(seen.headers.cookie, 'dsh-auth-test=proxy')
  assert.equal(seen.headers.origin, undefined)

  // 4. 状态接口告诉等待页：已确认。
  const approvedStatus = JSON.parse((await fetchProxy('/__dsh_ra/status', pendingCookie)).body)
  assert.equal(approvedStatus.state, 'approved')

  // 5. 已确认会话出现在列表里，撤销后立即失效（下次访问变成新的 pending）。
  assert.equal(proxy.listApproved().length, 1)
  assert.equal(proxy.revoke(item.id), true)
  const afterRevoke = await fetchProxy('/api/session', pendingCookie)
  assert.match(afterRevoke.body, /等待内网确认/u)
  const revokedStatus = JSON.parse((await fetchProxy('/__dsh_ra/status', pendingCookie)).body)
  assert.equal(revokedStatus.state, 'none')
  assert.equal(upstreamHits.length, 2)

  // 6. 未确认 cookie 到期：旧会话被清理、换新 cookie，永远到不了上游。
  const hitsBefore = upstreamHits.length
  const expiring = await fetchProxy('/')
  const shortCookie = cookieFrom(expiring)
  const shortCode = codeFrom(expiring)
  await sleep(450)
  const expired = await fetchProxy('/x', shortCookie)
  assert.match(expired.body, /等待内网确认/u)
  const renewedCookie = cookieFrom(expired)
  assert.notEqual(renewedCookie, shortCookie)
  assert.ok(!proxy.listPending().some((entry) => entry.code === shortCode), 'expired pending session must be purged')
  assert.equal(upstreamHits.length, hitsBefore, 'expired cookie must not be forwarded')

  // 7. upgrade：未确认 → 401；确认后 → 上游 101。
  const unapproved = await new Promise((resolve) => {
    const req = httpsRequest({
      host: '127.0.0.1', port, path: '/ws', rejectUnauthorized: false,
      headers: { connection: 'Upgrade', upgrade: 'test' },
    })
    req.on('response', (res) => { res.resume(); resolve(res.statusCode) })
    req.on('upgrade', () => resolve(101))
    req.on('error', () => resolve('error'))
    req.end()
  })
  assert.notEqual(unapproved, 101, 'unapproved upgrade must not reach upstream')
  assert.equal(upgradeHits.length, 0)

  const wsPage = await fetchProxy('/')
  const wsCookie = cookieFrom(wsPage)
  proxy.approve(pendingByCode(codeFrom(wsPage)).id)
  const upgraded = await new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1', port, path: '/ws', rejectUnauthorized: false,
      headers: { connection: 'Upgrade', upgrade: 'test', cookie: wsCookie },
    })
    req.on('upgrade', (res, socket, head) => {
      let data = head === undefined ? '' : head.toString('utf8')
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => { data += chunk })
      socket.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('response', (res) => { res.resume(); reject(new Error('unexpected response ' + res.statusCode)) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(upgraded.status, 101)
  assert.equal(upgraded.data, 'ws-ok')
  assert.equal(upgradeHits.length, 1)
  assert.equal(upgradeHits[0].headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(upgradeHits[0].headers.cookie, 'dsh-auth-test=proxy')
  assert.equal(upgradeHits[0].headers['x-dsh-ra-proxy'], '1')

  // 8. 固定密钥：用户设置；登录后是 session cookie，新浏览器会话仍要重新输入。
  const keyPage = await fetchProxy('/')
  const keyCookie = cookieFrom(keyPage)
  assert.equal(proxy.hasFixedKey(), false)
  assert.equal(proxy.setFixedKey('short'), false, 'key shorter than 8 chars must be rejected')
  assert.equal(proxy.setFixedKey('correct-horse-battery'), true)
  assert.equal(proxy.hasFixedKey(), true)
  const used = await postJson('/__dsh_ra/key', keyCookie, { key: 'correct-horse-battery' })
  assert.equal(used.status, 200)
  assert.ok(!/Max-Age/u.test(String(used.headers['set-cookie'][0])), 'key session must be a session cookie')
  assert.equal((await fetchProxy('/via-key', keyCookie)).body, 'upstream:/via-key')

  // 同一固定密钥可给另一个浏览器会话用，但新会话本身仍是等待页。
  const secondPage = await fetchProxy('/')
  const secondCookie = cookieFrom(secondPage)
  assert.match(secondPage.body, /等待内网确认/u)
  assert.equal((await postJson('/__dsh_ra/key', secondCookie, { key: 'correct-horse-battery' })).status, 200)
  assert.equal((await fetchProxy('/via-key-2', secondCookie)).body, 'upstream:/via-key-2')

  assert.equal((await postJson('/__dsh_ra/key', undefined, { key: 'wrong-key-123' })).status, 403)
  assert.equal(proxy.clearFixedKey(), true)
  assert.equal(proxy.hasFixedKey(), false)
  assert.equal((await postJson('/__dsh_ra/key', undefined, { key: 'correct-horse-battery' })).status, 403)

  // 连续错误触发按来源限流。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await postJson('/__dsh_ra/key', undefined, { key: 'wrong-key-123' })
  }
  assert.equal((await postJson('/__dsh_ra/key', undefined, { key: 'wrong-key-123' })).status, 429)

  // 9. 配置 publicHost 后只接受该域名；IP / 其他域名一律 421。
  const hostProxy = createRemoteAccessProxy({
    getUpstreamCookie: async () => 'dsh-auth-test=proxy',
    listenHost: '127.0.0.1',
    listenPort: 0,
    log: () => {},
    pendingTtlMs: 400,
    publicHost: 'dsh.example.test',
    sessionTtlMs: 60_000,
    tls,
    upstreamHost: '127.0.0.1',
    upstreamPort,
  })
  const hostPort = await hostProxy.listen()
  const byDomain = await fetchProxy('/', undefined, 'GET', 'dsh.example.test', hostPort)
  assert.equal(byDomain.status, 200)
  assert.match(byDomain.body, /等待内网确认/u)
  for (const badHost of [`127.0.0.1:${hostPort}`, 'www.dsh.example.test', '']) {
    const rejected = await fetchProxy('/', undefined, 'GET', badHost, hostPort)
    assert.equal(rejected.status, 421, `host ${JSON.stringify(badHost)} must be rejected`)
  }
  await hostProxy.close()

  console.log('self-check: all assertions passed')
} finally {
  await proxy.close()
  await new Promise((resolve) => upstream.close(resolve))
  rmSync(dir, { recursive: true, force: true })
}
