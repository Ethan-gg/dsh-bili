/**
 * M4 云桥传输单测：dshim 出站 / http 出站 / bridge.ingest（push 入站同一套安检）
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDshimTransport, renderOutbound } from '../src/sync/transport/dshim.mjs'
import { createHttpTransport } from '../src/sync/transport/http.mjs'
import { createSync } from '../src/sync/index.mjs'
import { makeEvent, TYPES } from '../src/sync/protocol.mjs'

const quiet = () => {}
const tmpPaths = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-sync-transport-'))
  mkdirSync(join(dir, 'sync'), { recursive: true })
  return {
    dir,
    outbox: join(dir, 'sync', 'outbox.jsonl'),
    inbox: join(dir, 'sync', 'inbox.jsonl'),
    cursor: join(dir, 'sync', 'cursor.json'),
    secret: join(dir, 'sync', 'secret'),
    seenIds: join(dir, 'sync', 'seen-ids.json'),
  }
}

/* ────────────── dshim 出站 ────────────── */

test('renderOutbound：只把 message.out / approval.request 变成人话，别的返回空', () => {
  assert.equal(renderOutbound(makeEvent({ type: TYPES.MSG_OUT, payload: { text: ' 你好 ' }, secret: 'x' })), '你好')
  assert.match(renderOutbound(makeEvent({ type: TYPES.APPROVAL_REQ, payload: { text: '回一句', target: 'BV1' }, secret: 'x' })), /待审草稿[\s\S]*回一句[\s\S]*BV1/)
  assert.equal(renderOutbound(makeEvent({ type: TYPES.QUOTA, payload: { shared: 1 }, secret: 'x' })), '', '配额这类不该刷群')
})

test('dshim：没配 botId/targetId、宿主没 dsh-im 都要给人话错误，不抛', async () => {
  const bare = createDshimTransport({ config: { sync: { enabled: true } }, getService: () => null })
  const r1 = await bare.send(makeEvent({ type: TYPES.MSG_OUT, payload: { text: 'hi' }, secret: 'x' }))
  assert.equal(r1.ok, false)
  assert.match(r1.error, /botId|targetId/)

  const noSvc = createDshimTransport({ config: { sync: { botId: 'b', targetId: 't' } }, getService: () => null })
  const r2 = await noSvc.send(makeEvent({ type: TYPES.MSG_OUT, payload: { text: 'hi' }, secret: 'x' }))
  assert.equal(r2.ok, false)
  assert.match(r2.error, /dsh-im/)
})

test('dshim：真发的时候走 ctx.dshIm.send(botId, targetId, text, {format})', async () => {
  const calls = []
  const svc = { send: async (...args) => { calls.push(args); return { sent: true, id: 'm1' } } }
  const t = createDshimTransport({ config: { sync: { botId: 'bot_1', targetId: 'daily' } }, getService: () => svc })
  const r = await t.send(makeEvent({ type: TYPES.MSG_OUT, payload: { text: '今天挑了 3 条' }, secret: 'x' }))
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [['bot_1', 'daily', '今天挑了 3 条', { format: 'plain' }]])
  // 非推送类事件：直接 skipped，不算失败、也不调服务
  const r2 = await t.send(makeEvent({ type: TYPES.QUOTA, payload: {}, secret: 'x' }))
  assert.equal(r2.ok, true)
  assert.equal(r2.skipped, true)
  assert.equal(calls.length, 1)
})

/* ────────────── http 出站 ────────────── */

test('http：出站 POST <endpoint>/sync/v1/events，body 就是签名信封', async () => {
  const calls = []
  const t = createHttpTransport({
    config: { sync: { endpoint: 'https://cloud.example/' } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ remoteId: 'r1' }) }
    },
  })
  const env = makeEvent({ type: TYPES.MSG_OUT, payload: { text: 'hi' }, secret: 'x' })
  const r = await t.send(env)
  assert.equal(r.ok, true)
  assert.equal(r.remoteId, 'r1')
  assert.equal(calls[0].url, 'https://cloud.example/sync/v1/events')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(JSON.parse(calls[0].init.body).id, env.id)
})

test('http：没填 endpoint / 云端 500 都要给人话错误', async () => {
  const noEp = createHttpTransport({ config: { sync: {} }, fetchImpl: async () => ({ ok: true }) })
  const r1 = await noEp.send(makeEvent({ type: TYPES.MSG_OUT, payload: {}, secret: 'x' }))
  assert.equal(r1.ok, false)
  assert.match(r1.error, /endpoint/)

  const bad = createHttpTransport({
    config: { sync: { endpoint: 'https://cloud.example' } },
    fetchImpl: async () => ({ ok: false, status: 502 }),
  })
  const r2 = await bad.send(makeEvent({ type: TYPES.MSG_OUT, payload: {}, secret: 'x' }))
  assert.equal(r2.ok, false)
  assert.match(r2.error, /502/)
})

test('http：poll 永远空（入站是 push 路，别重复收）', async () => {
  const t = createHttpTransport({ config: { sync: { endpoint: 'https://x' } } })
  assert.deepEqual(await t.poll('0'), { events: [], cursor: '' })
})

/* ────────────── bridge.ingest（push 入站） ────────────── */

test('bridge.ingest：签名合法就收下并交给 handler；重复 id 丢掉', async () => {
  const paths = tmpPaths()
  const bridge = createSync({ paths, config: { sync: { enabled: true, transport: 'file' } }, log: quiet })
  const secret = readFileSync(paths.secret, 'utf8').trim()
  const seen = []
  const handlers = { [TYPES.MSG_IN]: async (env) => seen.push(env.payload.text) }
  const env = makeEvent({ type: TYPES.MSG_IN, from: 'cloud', payload: { convId: 'c1', text: '在吗' }, secret })

  const r1 = await bridge.ingest([env], handlers)
  assert.equal(r1.accepted, 1)
  assert.deepEqual(seen, ['在吗'])

  const r2 = await bridge.ingest([env], handlers)
  assert.equal(r2.accepted, 0)
  assert.equal(r2.dropped.dup, 1)
  assert.deepEqual(seen, ['在吗'], '重复消息不许再交一次')
})

test('bridge.ingest：签名不对 / 形状不对都进不来（跟 pump 同一套安检）', async () => {
  const paths = tmpPaths()
  const bridge = createSync({ paths, config: { sync: { enabled: true, transport: 'file' } }, log: quiet })
  const seen = []
  const handlers = { [TYPES.MSG_IN]: async () => seen.push(1) }

  const bad = makeEvent({ type: TYPES.MSG_IN, from: 'cloud', payload: { convId: 'c1', text: 'x' }, secret: 'wrong-secret-wrong-secret-wrong' })
  const r = await bridge.ingest([bad], handlers)
  assert.equal(r.accepted, 0)
  assert.equal(r.dropped.badSig, 1)
  assert.equal(seen.length, 0)

  const r2 = await bridge.ingest([{ v: 1, id: 'evt_x', type: 'message.in', payload: {} }], handlers)
  assert.equal(r2.accepted, 0)
  assert.ok(r2.dropped.badShape >= 1)
  assert.equal(seen.length, 0)
})
