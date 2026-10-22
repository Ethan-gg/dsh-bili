/**
 * 云桥参考云端（cloud/server.mjs）单测：验签 / 幂等 / 转发入站 / 坏签名拒绝
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCloud } from '../cloud/server.mjs'
import { makeEvent, TYPES, verifySignature } from '../src/sync/protocol.mjs'

const SECRET = 'a'.repeat(32) + 'b'.repeat(32)

function stubPluginInbound() {
  const got = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      try {
        const list = JSON.parse(data)
        const env = Array.isArray(list) ? list[0] : list
        got.push({ env, raw: data, url: req.url, verified: verifySignature(env, SECRET) })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: 1, received: 1 }))
      } catch (e) {
        res.writeHead(400); res.end('bad')
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port })))
}

test('cloud：收签名事件、id 幂等去重、坏签名拒收、能读回', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bili-cloud-'))
  const stub = await stubPluginInbound()
  const cloud = createCloud({ secret: SECRET, pluginInboundUrl: `http://127.0.0.1:${stub.port}/inbound`, dataDir, port: 0 })
  const port = await cloud.listen()
  try {
    const env = makeEvent({ type: TYPES.QUOTA, payload: { day: '2026-10-22', shared: 1 }, secret: SECRET })
    const r1 = await fetch(`http://127.0.0.1:${port}/sync/v1/events`, { method: 'POST', body: JSON.stringify(env) })
    assert.equal(r1.status, 200)
    assert.equal((await r1.json()).remoteId, env.id)

    // 同一个 id 再发 ⇒ 收下但 dup，不重复落盘
    const r2 = await fetch(`http://127.0.0.1:${port}/sync/v1/events`, { method: 'POST', body: JSON.stringify(env) })
    assert.equal((await r2.json()).dup, true)
    const list = await (await fetch(`http://127.0.0.1:${port}/sync/v1/events`)).json()
    assert.equal(list.count, 1)

    // 坏签名：401，且不落盘
    const bad = makeEvent({ type: TYPES.QUOTA, payload: {}, secret: 'x'.repeat(64) })
    const r3 = await fetch(`http://127.0.0.1:${port}/sync/v1/events`, { method: 'POST', body: JSON.stringify(bad) })
    assert.equal(r3.status, 401)
    const list2 = await (await fetch(`http://127.0.0.1:${port}/sync/v1/events`)).json()
    assert.equal(list2.count, 1)

    // 转发入站：云端签名后 POST 给插件，插件侧能验过
    const r4 = await fetch(`http://127.0.0.1:${port}/sync/v1/inbound`, {
      method: 'POST', body: JSON.stringify({ type: TYPES.MSG_IN, payload: { convId: 'c1', userName: '小明', text: '在吗' } }),
    })
    assert.equal(r4.status, 200)
    assert.equal(stub.got.length, 1)
    assert.equal(stub.got[0].verified, true, '插件收到的必须是云端签过名、能验过的信封')
    assert.equal(stub.got[0].env.type, TYPES.MSG_IN)
    assert.equal(stub.got[0].env.payload.text, '在吗')
  } finally {
    await cloud.close()
    await new Promise((r) => stub.server.close(r))
  }
})

test('cloud：缺密钥 / 缺插件地址时起不来（必须说人话）', () => {
  assert.throws(() => createCloud({ pluginInboundUrl: 'http://x', dataDir: tmpdir() }), /CLOUD_SECRET/)
  assert.throws(() => createCloud({ secret: SECRET, dataDir: tmpdir() }), /PLUGIN_INBOUND_URL/)
})
