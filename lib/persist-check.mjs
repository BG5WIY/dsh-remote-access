// 可执行自检：node lib/persist-check.mjs
//
// 验证持久化与定期全清：
//   1. 已确认会话写入 0600 状态文件，重启后旧 cookie 仍可访问；
//   2. 未确认会话不落盘，重启后重新配对；
//   3. 到达 clearAllIntervalMs 后全部会话作废，并把新的清理时间写回文件。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteAccessProxy } from './proxy.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-ra-persist-'))
const certPath = join(dir, 'cert.pem')
const keyPath = join(dir, 'key.pem')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-keyout', keyPath, '-out', certPath,
], { stdio: 'ignore' })
const tls = { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8'), source: certPath, selfSigned: true }

const statePath = join(dir, 'state', 'sessions.json')
const clock = { t: 1_800_000_000_000 }
const DAY = 24 * 60 * 60 * 1000

const upstream = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('upstream:' + req.url)
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

function makeProxy() {
  return createRemoteAccessProxy({
    clearAllIntervalMs: 7 * DAY,
    getUpstreamCookie: async () => 'dsh-auth-test=proxy',
    listenHost: '127.0.0.1',
    listenPort: 0,
    log: () => {},
    now: () => clock.t,
    pendingTtlMs: 5 * 60 * 1000,
    sessionTtlMs: 30 * DAY,
    statePath,
    tls,
    upstreamHost: '127.0.0.1',
    upstreamPort,
  })
}

function fetchProxy(port, path, cookie) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false,
      headers: cookie === undefined ? {} : { cookie },
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
  const match = /^dsh_ra=([^;]+)/u.exec(response.headers['set-cookie']?.[0] ?? '')
  assert.ok(match !== null, 'expected a dsh_ra cookie')
  return `dsh_ra=${match[1]}`
}

function codeFrom(response) {
  const match = /<div class="code">(\d{6})<\/div>/u.exec(response.body)
  assert.ok(match !== null, 'expected a pairing code')
  return match[1]
}

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

let first
try {
  // A：批准一个会话，同时留下一个未确认会话。
  const a = makeProxy()
  const aPort = await a.listen()
  const firstPage = await fetchProxy(aPort, '/')
  const approvedCookie = cookieFrom(firstPage)
  const approvedCode = codeFrom(firstPage)
  assert.equal(a.approve(a.listPending().find((item) => item.code === approvedCode).id), true)
  const pendingPage = await fetchProxy(aPort, '/')
  const pendingCookie = cookieFrom(pendingPage)
  assert.equal(a.listApproved().length, 1)
  assert.equal(a.listPending().length, 1)
  await a.close()

  // 状态文件：0600，只含已确认会话。
  assert.equal(statSync(statePath).mode & 0o777, 0o600)
  const stored = readState()
  assert.equal(stored.version, 1)
  assert.equal(stored.sessions.length, 1)
  assert.equal(stored.clearedAt, clock.t)

  // B：重启后旧 cookie 直接可用；未确认的 cookie 需重新配对。
  const b = makeProxy()
  const bPort = await b.listen()
  assert.equal(b.listApproved().length, 1)
  assert.equal(b.listPending().length, 0)
  assert.equal((await fetchProxy(bPort, '/persisted', approvedCookie)).body, 'upstream:/persisted')
  assert.match((await fetchProxy(bPort, '/', pendingCookie)).body, /等待内网确认/u)

  // 定期全清：跳过 7 天后全部作废。
  clock.t += 8 * DAY
  assert.equal(b.listApproved().length, 0)
  assert.match((await fetchProxy(bPort, '/', approvedCookie)).body, /等待内网确认/u)
  const cleared = readState()
  assert.equal(cleared.sessions.length, 0)
  assert.equal(cleared.clearedAt, clock.t)
  await b.close()

  // C：全清结果持久化，重启后仍为空。
  const c = makeProxy()
  await c.listen()
  assert.equal(c.listApproved().length, 0)
  assert.equal(c.listPending().length, 0)
  await c.close()

  console.log('persist-check: all assertions passed')
} finally {
  await new Promise((resolve) => upstream.close(resolve))
  rmSync(dir, { recursive: true, force: true })
}
