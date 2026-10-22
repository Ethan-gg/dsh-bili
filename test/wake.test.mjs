/**
 * 叫醒（常驻会话）单测：接口约定、失败语义、看门狗
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_ID, createWatchdog, deliverToSession, hasSession } from '../src/host/wake.mjs'

const fakeSC = (over = {}) => {
  const calls = { create: [], prompt: [] }
  const sc = {
    create: async (req) => { calls.create.push(req); return { sessionId: req.sessionId } },
    prompt: async (req, signal) => { calls.prompt.push({ req, hasSignal: Boolean(signal) }); return { accepted: true } },
    ...over,
  }
  return { sc, calls }
}

test('hasSession：只认 prompt，不认"看着像"', () => {
  assert.equal(hasSession(null), false)
  assert.equal(hasSession({}), false)
  assert.equal(hasSession({ create: () => {} }), false)
  assert.equal(hasSession({ prompt: () => {} }), true)
})

test('deliverToSession：先建会话（失败也继续），再按 queue 模式投递', async () => {
  const { sc, calls } = fakeSC()
  const r = await deliverToSession({ sessionController: sc, cwd: 'C:/home', text: '今天刷一轮', now: 123 })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'session')
  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].sessionId, SESSION_ID)
  assert.equal(calls.create[0].cwd, 'C:/home')
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].req.mode, 'queue')
  assert.equal(calls.prompt[0].req.content[0].text, '今天刷一轮')
  assert.match(calls.prompt[0].req.requestId, /^bili-123-/)
  assert.equal(calls.prompt[0].hasSignal, true, '要传 AbortSignal')
})

test('deliverToSession：会话已存在（create 抛）不该拦着投递', async () => {
  const { sc, calls } = fakeSC({ create: async () => { throw new Error('already exists') } })
  const r = await deliverToSession({ sessionController: sc, cwd: 'C:/home', text: 'x' })
  assert.equal(r.ok, true)
  assert.equal(calls.prompt.length, 1)
})

test('deliverToSession：prompt 失败要把原因带出来（好让调用方退回 spawn）', async () => {
  const { sc } = fakeSC({ prompt: async () => { throw new Error('session archived') } })
  const r = await deliverToSession({ sessionController: sc, cwd: 'C:/home', text: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /archived/)
})

test('deliverToSession：没有 sessionController / 空正文 → ok:false，不抛', async () => {
  assert.equal((await deliverToSession({ sessionController: null, text: 'x' })).ok, false)
  assert.match((await deliverToSession({ sessionController: null, text: 'x' })).error, /退回 spawn/)
  const { sc, calls } = fakeSC()
  assert.equal((await deliverToSession({ sessionController: sc, cwd: 'c', text: '   ' })).ok, false)
  assert.equal(calls.prompt.length, 0, '空正文不该投递')
})

test('看门狗：到点只触发一次；正常收工后再到点也不触发', async () => {
  const fired = []
  const stop = createWatchdog({ ms: 5, onTimeout: () => fired.push('timeout') })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(fired, ['timeout'])

  const fired2 = []
  const stop2 = createWatchdog({ ms: 5, onTimeout: () => fired2.push('timeout') })
  stop2()                                   // 正常收工
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(fired2, [], '正常收工后不许再触发')
})

test('看门狗：兜底回调自己抛错不会炸出去', async () => {
  const stop = createWatchdog({ ms: 5, onTimeout: () => { throw new Error('兜底也坏了') } })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(typeof stop, 'function')
})
