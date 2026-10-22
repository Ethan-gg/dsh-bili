/**
 * 闸门单测：六道闸的边界 + 账本读写
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODES, emptyLedger, evaluateShare, lastShareOf, normalizeLedger, readLedger, recordShare, silenceDays, summary, tally, writeLedger,
} from '../src/host/gate.mjs'

const NOW = new Date('2026-10-22T21:00:00').getTime()
const iso = (s) => new Date(s).toISOString()
const BV_A = 'BV1xx411c7mD'
const BV_B = 'BV1yy411c7mE'
const shareCfg = (over = {}) => ({
  enabled: true, via: 'comment', perRound: 1, daily: 3, minScore: 13,
  sameVideoDays: 7, silenceDays: 3, silenceStopDays: 7, ...over,
})
const okArgs = (over = {}) => ({
  share: shareCfg(), entries: [], now: NOW, bvid: BV_A, score: 15, reason: '讲了 MCP 的超时重试，和你在做的插件直接相关', ...over,
})

test('闸一：总开关关着就拒', () => {
  const r = evaluateShare(okArgs({ share: shareCfg({ enabled: false }) }))
  assert.equal(r.ok, false)
  assert.equal(r.code, CODES.SHARE_OFF)
})

test('闸二：评分必须 0–20 且在门槛之上', () => {
  assert.equal(evaluateShare(okArgs({ score: 21 })).code, CODES.BAD_SCORE)
  assert.equal(evaluateShare(okArgs({ score: -1 })).code, CODES.BAD_SCORE)
  assert.equal(evaluateShare(okArgs({ score: '很高' })).code, CODES.BAD_SCORE)
  assert.equal(evaluateShare(okArgs({ score: 12 })).code, CODES.LOW_SCORE)
  assert.equal(evaluateShare(okArgs({ score: 13 })).ok, true, '正好等于门槛要放行')
})

test('闸三：理由少于 8 个字就拒（说不清为什么留，就别占别人注意力）', () => {
  const r = evaluateShare(okArgs({ reason: '好看' }))
  assert.equal(r.code, CODES.NO_REASON)
  assert.equal(evaluateShare(okArgs({ reason: '  好看  ' })).code, CODES.NO_REASON, '空白要 trim 掉再数')
  assert.equal(evaluateShare(okArgs({ reason: '讲了 MCP 的超时重试，跟你有关' })).ok, true)
})

test('闸四：rank 只认第一；不给就不判', () => {
  assert.equal(evaluateShare(okArgs({ rank: 2 })).code, CODES.BAD_RANK)
  assert.equal(evaluateShare(okArgs({ rank: 1 })).ok, true)
  assert.equal(evaluateShare(okArgs({ rank: undefined })).ok, true)
})

test('闸五：没有合法 BV 号不判重 ⇒ 不敢发', () => {
  assert.equal(evaluateShare(okArgs({ bvid: '' })).code, CODES.BAD_BVID)
  assert.equal(evaluateShare(okArgs({ bvid: 'av123' })).code, CODES.BAD_BVID)
})

test('闸六：同一个视频 7 天内只发一次，第 7 天起放行', () => {
  const entries = [{ at: iso('2026-10-16T20:00:00'), share: true, bvid: BV_A, via: 'comment', kind: 'share', score: 15, note: 'x' }]
  // 10-16 → 10-22 = 6 天，还没到 7 天
  const blocked = evaluateShare(okArgs({ entries }))
  assert.equal(blocked.code, CODES.SAME_VIDEO)
  assert.match(blocked.message, /还差 1 天/)

  // 换成 7 天前（10-15）⇒ 放行
  const fresh = [{ ...entries[0], at: iso('2026-10-15T20:00:00') }]
  assert.equal(evaluateShare(okArgs({ entries: fresh })).ok, true)
})

test('闸七：每天额度用完就拒，第二天自动恢复', () => {
  const entries = [BV_A, BV_B, 'BV1zz411c7mF'].map((b) => ({ at: iso('2026-10-22T10:00:00'), share: true, bvid: b, via: 'comment', kind: 'share' }))
  const r = evaluateShare(okArgs({ entries, bvid: 'BV1ww411c7mG' }))
  assert.equal(r.code, CODES.DAILY_LIMIT)
  assert.deepEqual({ shared: r.shared, daily: r.daily }, { shared: 3, daily: 3 })

  const tomorrow = new Date('2026-10-23T09:00:00').getTime()
  assert.equal(evaluateShare(okArgs({ entries, now: tomorrow, bvid: 'BV1ww411c7mG' })).ok, true)

  // 额度配 0 ⇒ 一条都不发
  assert.equal(evaluateShare(okArgs({ share: shareCfg({ daily: 0 }) })).code, CODES.QUOTA_ZERO)
})

test('闸八：沉默衰减 —— 3 天开始降、7 天归零', () => {
  const warn = evaluateShare(okArgs({ feedback: { lastAt: iso('2026-10-19T12:00:00') } }))   // 3 天前
  assert.equal(warn.ok, true)
  assert.match(warn.warn, /3 天没反应/)

  const stop = evaluateShare(okArgs({ feedback: { lastAt: iso('2026-10-15T12:00:00') } }))    // 7 天前
  assert.equal(stop.code, CODES.SILENCE_STOP)

  // 没有表态记录 ⇒ 不衰减（不能把"新装的用户"当成"沉默了很久"）
  assert.equal(evaluateShare(okArgs({ feedback: null })).ok, true)
  assert.equal(silenceDays(null, NOW), null)
  assert.equal(silenceDays({ lastAt: iso('2026-10-20T12:00:00') }, NOW), 2)
})

test('账本：原子写、读回来一致、坏文件当空账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-gate-'))
  const file = join(dir, 'ledger', 'shares.json')
  assert.deepEqual(readLedger(file), emptyLedger(), '文件不存在 = 空账')

  let l = recordShare(emptyLedger(), { at: iso('2026-10-22T10:00:00'), bvid: BV_A, score: 15, reason: '理由够长够长够长' })
  writeLedger(file, l)
  const back = readLedger(file)
  assert.equal(back.entries.length, 1)
  assert.equal(back.entries[0].bvid, BV_A)
  assert.equal(back.entries[0].score, 15)
  assert.ok(readFileSync(file, 'utf8').trim().endsWith('}'))

  // 坏文件不抛
  writeFileSync(file, '{坏', 'utf8')
  assert.deepEqual(readLedger(file), emptyLedger())
})

test('账本：能读 whale 的老形状 {log:[…]}，也丢掉没有时间的条目', () => {
  const l = normalizeLedger({
    log: [{ at: iso('2026-10-20T20:00:00'), type: 'share', share: true, target: 'BV1', note: 'n' }],
  })
  assert.equal(l.entries.length, 1)
  assert.equal(l.entries[0].share, true)

  assert.equal(normalizeLedger({ entries: [{ at: '', share: true }] }).entries.length, 0)
  assert.equal(normalizeLedger({ entries: [{ at: iso('2026-10-20T20:00:00'), bvid: '不是BV', share: true }] }).entries[0].bvid, null)
  assert.deepEqual(normalizeLedger(null), emptyLedger())
})

test('记账是纯的：不改入参，返回新账本', () => {
  const base = emptyLedger()
  const next = recordShare(base, { bvid: BV_A, score: 16, reason: '理由够长够长够长' })
  assert.equal(base.entries.length, 0)
  assert.equal(next.entries.length, 1)
  assert.notEqual(base, next)
})

test('tally / lastShareOf / summary：按本地日历天算，不按 UTC', () => {
  const entries = [
    { at: iso('2026-10-22T00:30:00'), share: true, bvid: BV_A, via: 'dm', kind: 'share' },   // 本地 10-22
    { at: iso('2026-10-22T23:30:00'), share: true, bvid: BV_B, via: 'comment', kind: 'share' }, // 本地 10-22
    { at: iso('2026-10-21T23:30:00'), share: true, bvid: BV_A, via: 'comment', kind: 'share' }, // 本地 10-21
    { at: iso('2026-10-22T12:00:00'), share: false, bvid: BV_A, kind: 'reply' },               // 不算分享
  ]
  const t = tally(entries, new Date('2026-10-22T22:00:00').getTime())
  assert.equal(t.day, '2026-10-22')
  assert.equal(t.shared, 2)
  assert.equal(t.dms, 1)
  assert.equal(t.total, 3)

  const last = lastShareOf(entries, BV_A)
  assert.equal(last.at, iso('2026-10-22T00:30:00'))

  const s = summary({ v: 1, entries }, shareCfg({ daily: 3 }), new Date('2026-10-22T22:00:00').getTime())
  assert.equal(s.remaining, 1)
  assert.equal(s.silentDays, null)
})
