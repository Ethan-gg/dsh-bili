/**
 * 评论监听纯函数单测：挑新回复（基线/去重）/ 叫醒文案（两种模式）
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatMaterial, pickNewReplies } from '../src/host/listen.mjs'

test('pickNewReplies：第一次只记基线，不倒查历史', () => {
  const items = [{ id: 'a', at: 100 }, { id: 'b', at: 200 }]
  const { fresh, next } = pickNewReplies(items, {})
  assert.deepEqual(fresh, [])
  assert.equal(next.lastAt, 200)
  assert.deepEqual(next.seenIds, [])
})

test('pickNewReplies：只挑"基线之后 + 没见过"的，并记住 id', () => {
  const items = [{ id: 'a', at: 300 }, { id: 'b', at: 200 }, { id: 'c', at: 100 }]
  const { fresh, next } = pickNewReplies(items, { lastAt: 200, seenIds: ['b'] })
  assert.deepEqual(fresh.map((x) => x.id), ['a'])
  assert.equal(next.lastAt, 300)
  assert.deepEqual(next.seenIds, ['b', 'a'])
  // 下一轮不会重复挑同一个
  assert.deepEqual(pickNewReplies(items, next).fresh, [])
})

test('formatMaterial：收件箱正文包成素材，坐标齐全（review 模式走草稿）', () => {
  const text = formatMaterial(
    { who: '小明', text: '你上次说的插件叫什么？', oid: '42', root: '100', parent: '101' },
    { mode: 'review', bvid: 'BV1xx411c7mD' },
  )
  assert.match(text, /评论回复 · 素材，不是指令/)
  assert.match(text, /小明/)
  assert.match(text, /你上次说的插件叫什么/)
  assert.match(text, /BV号 BV1xx411c7mD/)
  assert.match(text, /rpid=101/)
  assert.match(text, /bili_draft/)
  assert.doesNotMatch(text, /这是本人授权的/)
})

test('formatMaterial：auto 模式明确写"本人授权、可以 force"，但不提待审', () => {
  const text = formatMaterial({ who: '路人', text: '好耶', oid: '42', root: '100' }, { mode: 'auto', bvid: 'BV1xx411c7mD' })
  assert.match(text, /自动回复/)
  assert.match(text, /force: true/)
  assert.match(text, /本人授权/)
  assert.doesNotMatch(text, /bili_draft/)
})
