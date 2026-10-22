/**
 * 草稿队列单测：幂等、原子取走、过期、队列上限、坏文件
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_QUEUE, addDraft, draftId, dropDraft, emptyQueue, listDrafts, normalizeQueue, pruneExpired, readQueue, takeDraft, writeQueue,
} from '../src/host/review.mjs'

const NOW = new Date('2026-10-22T21:00:00').getTime()
const iso = (s) => new Date(s).toISOString()
const draft = (over = {}) => ({
  kind: 'reply', oid: 12345, bvid: 'BV1xx411c7mD', root: 111, parent: 222,
  who: 999, src: 'msgfeed', message: '你这个插件在哪装的？', at: iso('2026-10-22T20:00:00'), ...over,
})

test('draftId：同一条回复永远同一个 id（幂等的基础）', () => {
  assert.equal(draftId(draft()), draftId(draft()))
  assert.notEqual(draftId(draft()), draftId(draft({ message: '换一句话' })))
  assert.notEqual(draftId(draft()), draftId(draft({ parent: 333 })))
  assert.match(draftId(draft()), /^d_[0-9a-f]{16}$/)
})

test('入队：正常入队一次；同一条再来是 dup，不重复占位', () => {
  const a = addDraft(emptyQueue(), draft(), { now: NOW })
  assert.equal(a.ok, true)
  assert.equal(a.queue.items.length, 1)

  const b = addDraft(a.queue, draft(), { now: NOW })
  assert.equal(b.ok, true)
  assert.equal(b.dup, true)
  assert.equal(b.queue.items.length, 1)
})

test('入队：缺正文的不收（一条空草稿比没有更糟）', () => {
  const r = addDraft(emptyQueue(), { ...draft(), message: '' }, { now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.queue.items.length, 0)
})

test('takeDraft：取走之后队列里就没有了；再取一次拿不到', () => {
  const a = addDraft(emptyQueue(), draft(), { now: NOW })
  const id = a.queue.items[0].id
  const t1 = takeDraft(a.queue, id)
  assert.ok(t1.item)
  assert.equal(t1.item.message, '你这个插件在哪装的？')
  assert.equal(t1.queue.items.length, 0)

  const t2 = takeDraft(t1.queue, id)
  assert.equal(t2.item, null, '已经取走的不能再取（防连点发两条）')
})

test('发失败要能放回去：取走 → 重新 addDraft（这条流程成立）', () => {
  const a = addDraft(emptyQueue(), draft(), { now: NOW })
  const id = a.queue.items[0].id
  const { queue, item } = takeDraft(a.queue, id)
  assert.equal(queue.items.length, 0)
  const back = addDraft(queue, item, { now: NOW })
  assert.equal(back.ok, true)
  assert.equal(back.dup, undefined)
  assert.equal(back.queue.items.length, 1)
  assert.equal(back.queue.items[0].id, id, '放回去还是同一个 id（不会变成两条）')
})

test('dropDraft：删掉并告诉调用方删没删到', () => {
  const a = addDraft(emptyQueue(), draft(), { now: NOW })
  const id = a.queue.items[0].id
  assert.equal(dropDraft(a.queue, id).removed, 1)
  assert.equal(dropDraft(a.queue, '没有这个').removed, 0)
})

test('过期：超过 72 小时的草稿不再出现（并如实报告丢掉几条）', () => {
  let q = emptyQueue()
  q = addDraft(q, draft({ at: iso('2026-10-22T20:00:00') }), { now: NOW }).queue
  q = addDraft(q, draft({ message: '三天前那条', at: iso('2026-10-18T20:00:00') }), { now: NOW }).queue

  const listed = listDrafts(q, { now: NOW })
  assert.equal(listed.items.length, 1, '只留新鲜的那条')
  assert.equal(listed.expired, 1)

  // TTL 可调：放宽到 200 小时，两条都在
  assert.equal(listDrafts(q, { now: NOW, ttlHours: 200 }).items.length, 2)
})

test('队列有上限：新的进来，最旧的出去', () => {
  let q = emptyQueue()
  for (let i = 0; i < MAX_QUEUE + 3; i += 1) {
    q = addDraft(q, draft({ message: `第 ${i} 条草稿`, parent: i }), { now: NOW }).queue
  }
  assert.equal(q.items.length, MAX_QUEUE)
  assert.equal(q.items.at(-1).message, `第 ${MAX_QUEUE + 2} 条草稿`)
  assert.equal(q.items[0].message, '第 3 条草稿', '最旧的三条被挤掉')
})

test('写盘：原子写 + 读回来一致；坏文件当空队列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-review-'))
  const file = join(dir, 'pending.json')
  assert.deepEqual(readQueue(file), emptyQueue())

  const q = addDraft(emptyQueue(), draft(), { now: NOW }).queue
  writeQueue(file, q)
  const back = readQueue(file)
  assert.equal(back.items.length, 1)
  assert.equal(back.items[0].oid, 12345)
  assert.equal(back.items[0].bvid, 'BV1xx411c7mD')

  writeFileSync(file, '这不是 json', 'utf8')
  assert.deepEqual(readQueue(file), emptyQueue())
})

test('normalizeQueue：老形状（裸数组 / 缺 id / 脏字段）都能收', () => {
  const q = normalizeQueue([
    { oid: 1, message: '没有 id 的草稿', at: iso('2026-10-22T20:00:00') },
    { oid: 2, message: '', at: iso('2026-10-22T20:00:00') },
    { oid: 3, message: '没有时间的', at: '' },
  ])
  assert.equal(q.items.length, 1)
  assert.match(q.items[0].id, /^d_/)
  assert.equal(q.items[0].kind, 'reply')
})

test('pruneExpired 不改入参（返回新对象，方便"先算再决定写不写"）', () => {
  const q = addDraft(emptyQueue(), draft(), { now: NOW }).queue
  const before = JSON.stringify(q)
  const pruned = pruneExpired(q, { now: NOW + 999 * 3600_000 })
  assert.equal(JSON.stringify(q), before, '原队列不能被就地改掉')
  assert.equal(pruned.items.length, 0)
  assert.equal(pruned.dropped, 1)
})
