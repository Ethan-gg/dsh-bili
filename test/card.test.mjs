/**
 * 状态卡单测：只放事实、按天过滤、硬截断、缺数据不抛
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusCard, CARD_MAX, CARD_HEAD } from '../src/host/card.mjs'

const at = (s) => new Date(s).getTime()
const NOW = at('2026-10-22T18:05:00')

const cfgNew = () => ({
  feed: { perDay: 6 },
  share: { enabled: true, minScore: 13, sameVideoDays: 7, daily: 3 },
  dm: { mode: 'off', uid: 0 },
  reply: { toComments: true, perRound: 3 },
})

const seenText = (rows) => [
  '| 日期 | bvid | 标题 | UP | 状态 |',
  '| --- | --- | --- | --- | --- |',
  ...rows,
].join('\n')

test('状态卡：今天的账 + 阈值 + 上一轮都在，且只放事实', () => {
  const card = buildStatusCard({
    now: NOW,
    pickedToday: 6,
    cfgNew: cfgNew(),
    state: { lastRunAt: '2026-10-22T04:00:01.078Z', lastWhy: 'noon' },
  })
  assert.match(card, /^===== 状态卡/)
  assert.match(card, /今天 2026-10-22 · 已挑 6\/6 条（还能挑 0 条）/)
  assert.match(card, /今天分享 0\/3 次/)
  assert.match(card, /上一轮 \d{2}:\d{2}（中午窗口）/)
  assert.match(card, /评分 ≥13 才分享/)
  assert.match(card, /同一视频 7 天内只说一次/)
  assert.match(card, /每天分享 ≤3 次/)
  assert.match(card, /每轮 ≤3 条/)
})

test('状态卡：判重摘要只留最近 7 天，旧的不能混进来', () => {
  const card = buildStatusCard({
    now: NOW,
    cfgNew: cfgNew(),
    seenText: seenText([
      '| 2026-10-10 | BV1aaaaaaaaa | 十二天前的旧视频 | 某UP | 挑了 |',
      '| 2026-10-21 | BV1bbbbbbbbb | 昨天那条 | 某UP | 跳过（无字幕） |',
      '| 2026-10-22 | BV1ccccccccc | 今天这条 | 某UP | 挑了（值得看） |',
    ]),
  })
  assert.match(card, /最近 7 天看过/)
  assert.doesNotMatch(card, /BV1aaaaaaaaa/, '超过 7 天的旧记录不该进卡')
  assert.match(card, /BV1bbbbbbbbb · 跳过 · 昨天那条/)
  assert.match(card, /BV1ccccccccc · 挑了 · 今天这条/)
})

test('状态卡：判重摘要有条数上限（别把整张表抄进去）', () => {
  const rows = []
  for (let i = 0; i < 20; i++) {
    rows.push(`| 2026-10-22 | BV1${String(i).padStart(9, '0')} | 第 ${i} 条 | UP | 挑了 |`)
  }
  const card = buildStatusCard({ now: NOW, cfgNew: cfgNew(), seenText: seenText(rows), maxSeen: 3 })
  // 只留最后 3 条（i=17/18/19）；前面的不能出现
  assert.match(card, /BV1000000017/)
  assert.doesNotMatch(card, /BV1000000000/)
  assert.equal((card.match(/^- BV/gm) || []).length, 3)
})

test('状态卡：今天分享几次只数今天的账', () => {
  const card = buildStatusCard({
    now: NOW,
    cfgNew: cfgNew(),
    shares: [
      { at: '2026-10-22T05:00:00.000Z', bvid: 'BV1' },   // 本地 13:00，今天
      { at: '2026-10-21T05:00:00.000Z', bvid: 'BV2' },   // 昨天
    ],
  })
  assert.match(card, /今天分享 1\/3 次/)
})

test('状态卡：她上次给自己写的只放最后三行', () => {
  const card = buildStatusCard({
    now: NOW,
    cfgNew: cfgNew(),
    lastSelfDiary: '第一句\n第二句\n第三句\n第四句',
  })
  assert.match(card, /她上次给自己写的最后三行/)
  assert.match(card, /第二句/)
  assert.match(card, /第三句/)
  assert.match(card, /第四句/)
  assert.doesNotMatch(card, /第一句/)
})

test('状态卡：超长硬截断在 1500 字以内，且截断有标记', () => {
  const rows = []
  for (let i = 0; i < 40; i++) {
    rows.push(`| 2026-10-22 | BV1${String(i).padStart(9, '0')} | ${'很长很长的标题'.repeat(6)} | UP | 挑了 |`)
  }
  const card = buildStatusCard({
    now: NOW,
    cfgNew: cfgNew(),
    seenText: seenText(rows),
    lastSelfDiary: '这一行也很长'.repeat(80),
    maxSeen: 40,
  })
  assert.ok(Array.from(card).length <= CARD_MAX, `超了：${Array.from(card).length}`)
  assert.match(card, /…（截断）$/)
})

test('状态卡：什么数据都没有也照样能拼，不抛', () => {
  const card = buildStatusCard({ now: NOW })
  assert.ok(card.startsWith(CARD_HEAD), '卡头要在')
  assert.match(card, /还没有记录/)
  assert.doesNotMatch(card, /阈值：/, '没有配置就不编阈值')
})
