/**
 * 日记单测：两本分开、按天分文件、追加不重写头、空/超长拒绝、摘要
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDiary, diaryPath, hasToday, lastEntry, lastEntryAny, listDiaries, readDiary, todayDigest,
} from '../src/host/diary.mjs'

const mem = () => mkdtempSync(join(tmpdir(), 'bili-diary-'))
const at = (s) => new Date(s).getTime()

test('appendDiary：第一次写自动加标题，第二次追加不重复加头', () => {
  const dir = mem()
  const now = at('2026-10-22T21:30:00')
  const a = appendDiary(dir, 'owner', '今天留了三条：都是 DS H 插件。', { now })
  assert.equal(a.ok, true)
  assert.equal(a.created, true)

  const b = appendDiary(dir, 'owner', '晚上又补了一条。', { now: at('2026-10-22T23:10:00') })
  assert.equal(b.ok, true)
  assert.equal(b.created, false)

  const text = readFileSync(a.path, 'utf8')
  assert.equal(text.match(/# 给主人的信/g).length, 1, '标题只出现一次')
  assert.match(text, /## 21:30/)
  assert.match(text, /## 23:10/)
  assert.match(text, /今天留了三条/)
  assert.match(text, /晚上又补了一条/)
})

test('两本日记互不干扰（目录不同、标题不同）', () => {
  const dir = mem()
  const now = at('2026-10-22T21:30:00')
  appendDiary(dir, 'owner', '对外那一版。', { now })
  appendDiary(dir, 'self', '其实今天有点烦。', { now })
  assert.match(readDiary(dir, 'owner', { now }), /给主人的信/)
  assert.match(readDiary(dir, 'self', { now }), /给自己的日记/)
  assert.doesNotMatch(readDiary(dir, 'owner', { now }), /有点烦/, '两本不能串')
  assert.equal(diaryPath(dir, 'self', now).includes('diary-self'), true)
})

test('按天分文件：昨天和今天不是同一个文件', () => {
  const dir = mem()
  appendDiary(dir, 'self', '昨天那条', { now: at('2026-10-21T22:00:00') })
  appendDiary(dir, 'self', '今天这条', { now: at('2026-10-22T22:00:00') })
  const list = listDiaries(dir, 'self')
  assert.equal(list.length, 2)
  assert.equal(list[0].day, '2026-10-22', '倒序，最新在前')
  assert.equal(hasToday(dir, 'self', at('2026-10-22T23:00:00')), true)
  assert.equal(hasToday(dir, 'self', at('2026-10-23T01:00:00')), false)
})

test('空正文 / 超长正文被拒，且不留下空文件', () => {
  const dir = mem()
  const now = at('2026-10-22T21:00:00')
  assert.equal(appendDiary(dir, 'owner', '   ', { now }).ok, false)
  assert.equal(existsSync(diaryPath(dir, 'owner', now)), false)

  const long = appendDiary(dir, 'owner', 'x'.repeat(8001), { now })
  assert.equal(long.ok, false)
  assert.match(long.error, /太长/)

  assert.equal(appendDiary(dir, 'nope', '正文', { now }).ok, false, '未知种类要明确拒绝')
})

test('lastEntry：只取最后一条正文，不带 ## 行', () => {
  const dir = mem()
  const now = at('2026-10-22T21:00:00')
  appendDiary(dir, 'self', '第一条', { now })
  appendDiary(dir, 'self', '第二条，写得长一点，但还没到上限。', { now })
  const last = lastEntry(dir, 'self', { now })
  assert.equal(last, '第二条，写得长一点，但还没到上限。')
  assert.doesNotMatch(last, /##/)
})

test('lastEntry：超长会被截断（状态卡只放一小段）', () => {
  const dir = mem()
  const now = at('2026-10-22T21:00:00')
  appendDiary(dir, 'self', 'y'.repeat(600), { now })
  const last = lastEntry(dir, 'self', { now, max: 100 })
  assert.equal(last.length, 101)     // 100 + 省略号
  assert.match(last, /…$/)
})

test('todayDigest：没写的那本要明说"没写"，不能悄悄留白', () => {
  const dir = mem()
  const now = at('2026-10-22T21:00:00')
  appendDiary(dir, 'owner', '今天写得挺多。', { now })
  const d = todayDigest(dir, now)
  assert.equal(d.day, '2026-10-22')
  assert.equal(d.wrote.owner, true)
  assert.equal(d.wrote.self, false)
  assert.match(d.self, /没写/)
  assert.match(d.owner, /今天写得挺多/)
})

test('读不到就说读不到：空目录返回空串，不抛', () => {
  const dir = mem()
  assert.equal(readDiary(dir, 'owner'), '')
  assert.deepEqual(listDiaries(dir, 'self'), [])
  assert.equal(lastEntry(dir, 'self'), '')
  assert.equal(lastEntryAny(dir, 'self'), '')
  assert.equal(hasToday(dir, 'self'), false)
})

test('lastEntryAny：今天还没写就往前找最近一天的最后一条（状态卡用）', () => {
  const dir = mem()
  appendDiary(dir, 'self', '昨天写的。', { now: at('2026-10-21T21:00:00') })
  assert.equal(lastEntryAny(dir, 'self', { now: at('2026-10-22T12:00:00') }), '昨天写的。')

  appendDiary(dir, 'self', '今天写的。', { now: at('2026-10-22T13:00:00') })
  assert.equal(lastEntryAny(dir, 'self', { now: at('2026-10-22T14:00:00') }), '今天写的。')

  // 另一本没有就是空串；超长照 lastEntry 的规矩截断
  assert.equal(lastEntryAny(dir, 'owner', { now: at('2026-10-22T14:00:00') }), '')
  appendDiary(dir, 'owner', 'z'.repeat(600), { now: at('2026-10-22T14:10:00') })
  assert.match(lastEntryAny(dir, 'owner', { now: at('2026-10-22T14:20:00'), max: 50 }), /…$/)
})
