/**
 * 生物钟单测：窗口展开、跨午夜、随机时刻、硬间隔、跳过、持久化、记账
 * 跑法：node --test "test/*.test.mjs"
 *
 * 时间一律用**本地**日期构造（`new Date('2026-10-22T21:00:00')`），
 * 因为这个模块的语义就是"本地日历时间"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  completePlan, dayOf, historyOf, inScheduleWindow, isPending, makePlan, maxWakes, occurrences, windowsOf,
} from '../src/host/clock.mjs'

const at = (s) => new Date(s).getTime()
const S = (windows, extra = {}) => ({ windows, minGapMin: 10, skipChance: 0.3, ...extra })
const NOV = S([{ start: '20:00', end: '24:00', wakes: 1 }])

test('windowsOf：分钟换算、跨午夜、次数钳制', () => {
  const [w] = windowsOf(NOV)
  assert.equal(w.start, 20 * 60)
  assert.equal(w.end, 24 * 60)
  assert.equal(w.wrap, false)
  assert.equal(w.label, '20:00–24:00')

  const [cross] = windowsOf(S([{ start: '23:00', end: '02:00', wakes: 3 }]))
  assert.equal(cross.start, 23 * 60)
  assert.equal(cross.end, 26 * 60)          // 02:00 第二天 = 26:00
  assert.equal(cross.wrap, true)

  assert.equal(windowsOf(S([{ start: '20:00', end: '22:00', wakes: 99 }]))[0].wakes, 12)
  assert.equal(windowsOf(S([{ start: '20:00', end: '22:00', wakes: -5 }]))[0].wakes, 0)
  assert.deepEqual(windowsOf({ windows: [] }), [])
  assert.deepEqual(windowsOf({}), [])
})

test('windowsOf：配错的时间当场抛，不静默排一个奇怪的时刻', () => {
  assert.throws(() => windowsOf(S([{ start: '99:99', end: '24:00' }])), /无效作息时间/)
  assert.throws(() => windowsOf(S([{ start: '20:00', end: '25:00' }])), /无效作息时间/)
})

test('maxWakes：所有窗口加起来，硬上限 12', () => {
  assert.equal(maxWakes(NOV), 1)
  assert.equal(maxWakes(S([{ start: '12:00', end: '14:00', wakes: 2 }, { start: '20:00', end: '24:00', wakes: 3 }])), 5)
  assert.equal(maxWakes(S([{ start: '00:00', end: '24:00', wakes: 12 }, { start: '00:00', end: '24:00', wakes: 12 }])), 12)
})

test('occurrences：只留还没结束的窗口；跨午夜会展开成昨天+今天两个', () => {
  const now = at('2026-10-22T21:00:00')
  const occ = occurrences(NOV, now)
  assert.equal(occ.length, 1)
  assert.equal(occ[0].key, '2026-10-22|20:00–24:00')
  assert.equal(occ[0].endsAt, at('2026-10-23T00:00:00'))

  // 凌晨 1 点：今天这个还没开始，昨天那个还没结束 ⇒ 两个都在
  const early = at('2026-10-22T01:00:00')
  const cross = occurrences(S([{ start: '23:00', end: '02:00', wakes: 2 }]), early)
  assert.equal(cross.length, 2)
  assert.equal(cross[0].key, '2026-10-21|23:00–02:00')
  assert.equal(cross[1].key, '2026-10-22|23:00–02:00')
  assert.equal(inScheduleWindow(S([{ start: '23:00', end: '02:00', wakes: 2 }]), early), true)
})

test('makePlan：窗口内随机取时刻，不是整点也不是窗口一开始', () => {
  const now = at('2026-10-22T20:30:00')
  const p = makePlan(NOV, {}, now, () => 0.5, 5)
  assert.equal(p.action, 'wake')
  assert.equal(p.windowKey, '2026-10-22|20:00–24:00')
  // earliest = max(now, 20:00, lastWoke+gap) = now；随机 0.5 ⇒ 大约在 now 与 24:00 的中点
  assert.ok(p.atMs > now, '不能立刻就到点')
  assert.ok(p.atMs < at('2026-10-23T00:00:00'), '不能超出窗口')
  assert.match(p.atText, /^2026-10-22 \d{2}:\d{2}$/)
  assert.equal(p.withinWindow, '20:00–24:00 第 1/1 次')
})

test('makePlan：掷到跳过就是 skip，但仍然占一个计划位', () => {
  const now = at('2026-10-22T20:30:00')
  const p = makePlan(NOV, {}, now, () => 0, 5)
  assert.equal(p.action, 'skip')
  assert.ok(p.reason)
  assert.equal(p.roll, undefined)
})

test('makePlan：已有计划且没到点 ⇒ 原样返回，不重掷（重启/跨午夜靠这个）', () => {
  const now = at('2026-10-22T20:30:00')
  const p1 = makePlan(NOV, {}, now, () => 0.5)
  assert.equal(isPending(p1, now), true)
  const p2 = makePlan(NOV, p1, now + 60_000, () => 0.1)   // 换一个"随机数"也不该变
  assert.deepEqual(p2, p1)
})

test('makePlan：两次醒来之间至少有 minGapMin，推不进窗口就换窗口/收工', () => {
  const now = at('2026-10-22T21:00:00')
  const shifted = makePlan(NOV, { schema: 2, date: '2026-10-22', wakes: 0, wokeAt: new Date(now).toISOString(), usedCount: {} }, now, () => 0, 5)
  assert.ok(shifted.atMs >= now + 10 * 60_000, '间隔不够时要往后推')

  // 窗口只剩 5 分钟，而离上次醒来才过 1 分钟 ⇒ 硬间隔 10 分钟塞不下 ⇒ 这个窗口放弃
  const tight = S([{ start: '20:00', end: '20:05', wakes: 2 }], { minGapMin: 10 })
  const now2 = at('2026-10-22T20:01:00')
  const busyYesterday = {
    schema: 2, date: '2026-10-22', wakes: 1,
    wokeAt: new Date(at('2026-10-22T20:00:00')).toISOString(),
    usedCount: { '2026-10-22|20:00–20:05': 1 },
  }
  const p = makePlan(tight, busyYesterday, now2, () => 0, 5)
  assert.equal(p.action, 'done')
  assert.match(p.reason, /间隔不够/)
})

test('makePlan：没有窗口 / 次数用完 / 窗口全过期 → done，并且说清为什么', () => {
  const now = at('2026-10-22T21:00:00')
  assert.match(makePlan({ windows: [] }, {}, now).reason, /没有配置作息窗口/)

  const used = { schema: 2, date: '2026-10-22', wakes: 1, usedCount: { '2026-10-22|20:00–24:00': 1 } }
  assert.match(makePlan(NOV, used, now).reason, /次数已用完/)

  // 今天的窗口已经过完了（18:00–20:00，现在 21:00）
  const late = at('2026-10-22T21:00:00')
  assert.match(makePlan(S([{ start: '18:00', end: '20:00', wakes: 1 }]), {}, late).reason, /已结束或已经处理/)

  // 而 01:00 时，昨晚那个窗口过了、**今晚那个还没开始** ⇒ 该照常排今晚（不是"过期"）
  const early = at('2026-10-23T01:00:00')
  assert.equal(makePlan(NOV, {}, early, () => 0.9).action, 'wake')
})

test('completePlan：投递后记账；skip 也占一次机会（不拉黑整段窗口）', () => {
  const now = at('2026-10-22T21:00:00')
  const wake = makePlan(NOV, {}, now, () => 0.9)
  const done = completePlan(wake, now)
  assert.equal(done.fired, true)
  assert.equal(done.woke, true)
  assert.equal(done.wakes, 1)
  assert.equal(done.usedCount['2026-10-22|20:00–24:00'], 1)
  assert.deepEqual(completePlan(done, now), done, '记过一次就不能再记')

  // 一个窗口 2 次：跳过第一次之后，第二次仍然可以排
  const two = S([{ start: '20:00', end: '24:00', wakes: 2 }])
  const skip1 = completePlan(makePlan(two, {}, now, () => 0), now)
  assert.equal(skip1.action, 'skip')
  const next = makePlan(two, skip1, now + 15 * 60_000, () => 0.9)
  assert.equal(next.action, 'wake')
  assert.match(next.withinWindow, /第 2\/2 次/)
})

test('historyOf：只留最近 3 天；旧 schema 的"预约"会被释放', () => {
  const now = at('2026-10-22T21:00:00')
  const h = historyOf({
    schema: 1,
    date: '2026-10-22',
    action: 'wake',
    fired: false,        // 预约了但没投递 ⇒ 那一次不算
    window: '20:00–24:00',
    usedCount: { '20:00–24:00': 1, '2026-10-10|20:00–24:00': 3 },
  }, now)
  assert.equal(h.schema, 2)
  assert.equal(h.usedCount['2026-10-22|20:00–24:00'], 0)
  assert.equal('20:00–24:00' in h.usedCount, false)
  assert.equal('2026-10-10|20:00–24:00' in h.usedCount, false, '太旧的要清掉')
})

test('completePlan：没有窗口标识的计划拒绝记账（宁可报错，也不写一笔糊涂账）', () => {
  assert.throws(() => completePlan({ action: 'wake', fired: false }, at('2026-10-22T21:00:00')), /窗口标识/)
})

test('dayOf 用的是本地日期（跨午夜判断依赖它）', () => {
  assert.equal(dayOf(at('2026-10-22T23:59:00')), '2026-10-22')
  assert.equal(dayOf(at('2026-10-23T00:01:00')), '2026-10-23')
})
