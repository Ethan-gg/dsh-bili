/**
 * 配置层单测：钳制、旧配置映射、新老形状互转
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS, applyFlat, clamp, flatView, fromLegacy, isNewShape, merge,
} from '../src/lib/config.mjs'

test('clamp：越界值被夹回，非法枚举回默认', () => {
  const c = clamp({
    feed: { perDay: 999, maxVideosPerWake: 0 },
    schedule: { skipChance: 2, minGapMin: -5, windows: [{ start: '99:99', end: 'oops', wakes: 99 }] },
    share: { daily: -1, minScore: 40 },
    dm: { mode: 'whatever' },
    listen: { commentIntervalSec: 1 },
    notify: { type: 'telegram' },
    sync: { maxInboundPerMinute: 999 },
  })
  assert.equal(c.feed.perDay, 50)
  assert.equal(c.feed.maxVideosPerWake, 1)
  assert.equal(c.schedule.skipChance, 0.95)
  assert.equal(c.schedule.minGapMin, 1)
  assert.equal(c.schedule.windows[0].start, '20:00')     // 非法时间回落默认
  assert.equal(c.schedule.windows[0].wakes, 12)
  assert.equal(c.share.daily, 0)
  assert.equal(c.share.minScore, 20)
  assert.equal(c.dm.mode, 'off')
  assert.equal(c.listen.commentIntervalSec, 60)
  assert.equal(c.notify.type, 'none')
  assert.equal(c.sync.maxInboundPerMinute, 60)
})

test('clamp：silenceStopDays 不会小于 silenceDays', () => {
  const c = clamp({ share: { silenceDays: 10, silenceStopDays: 3 } })
  assert.equal(c.share.silenceStopDays, 10)
})

test('merge：未知键丢掉，类型不符的不覆盖', () => {
  const m = merge(DEFAULTS, { evil: 1, feed: { perDay: '7', keywords: ['a', 3, ''] } })
  assert.equal('evil' in m, false)
  assert.equal(m.feed.perDay, 7)                                  // 数字字符串转数字
  assert.deepEqual(m.feed.keywords, ['a', 3, ''])                  // 数组交给 clamp 再清
  assert.equal(merge(DEFAULTS, { feed: { perDay: 'abc' } }).feed.perDay, DEFAULTS.feed.perDay)
})

test('fromLegacy：scroll 扁平配置逐字段落到新形状', () => {
  const { config, mapped } = fromLegacy({
    perDay: 6, keywords: ['DSH'], peakValley: true, noon: false, night: true,
    autoComment: true, commentPerRound: 2, mentionName: 'Gmnnm', dmMode: 'only', dmUid: 42,
    dmWatch: true, dmWatchMinutes: 3, transcribe: true, asrModel: 'base',
    personaPrompt: '你叫小鲸', pythonPath: 'C:/py/python.exe', headlessProfile: 'headless',
    reportLevel: 'brief', replyToComments: true, replyPerRound: 3, favFolderId: 7,
  })
  assert.equal(config.feed.perDay, 6)
  assert.deepEqual(config.feed.keywords, ['DSH'])
  assert.equal(config.schedule.enabled, true)
  assert.equal(config.schedule.noon, false)
  assert.equal(config.share.enabled, true)
  assert.equal(config.share.perRound, 2)
  assert.equal(config.account.mentionName, 'Gmnnm')
  assert.equal(config.dm.mode, 'only')
  assert.equal(config.dm.uid, 42)
  assert.equal(config.listen.dm, true)
  assert.equal(config.listen.dmIntervalSec, 180)          // 3 分钟 → 秒
  assert.equal(config.asr.enabled, true)
  assert.equal(config.asr.model, 'base')
  assert.equal(config.persona.prompt, '你叫小鲸')
  assert.equal(config.run.pythonPath, 'C:/py/python.exe')
  assert.equal(config.report.level, 'brief')
  assert.equal(config.reply.perRound, 3)
  assert.equal(config.fav.folderId, 7)
  assert.ok(mapped.length > 20)
})

test('fromLegacy：whale 分组配置也能落到同一处', () => {
  const { config } = fromLegacy({}, {
    owner: { mid: '123', name: '我' },
    self: { mid: '456', name: '鲸' },
    persona: { name: '小鲸', ownerTitle: '主人', selfClaim: '我' },
    preferences: { like: ['猫'], dislike: ['带货'], keywords: ['DSH'] },
    quota: { shareDaily: 2 },
    share: { via: 'dm', minScore: 15, silentAfterDays: 4 },
    listen: { comment: true, commentIntervalSec: 600, scope: 'reply', oncePerPerson: true, live: true, liveRoom: '12345' },
    night: { maxVideos: 3, skipChance: 0.5, minGapMin: 20, windows: [{ start: '21:00', end: '23:00', wakes: 2 }] },
    notify: { type: 'webhook', url: 'https://x/y', template: 'markdown' },
  })
  assert.equal(config.account.ownerUid, 123)
  assert.equal(config.account.selfUid, 456)
  assert.equal(config.persona.name, '小鲸')
  assert.deepEqual(config.feed.like, ['猫'])
  assert.equal(config.feed.maxVideosPerWake, 3)
  assert.equal(config.share.daily, 2)
  assert.equal(config.share.via, 'dm')
  assert.equal(config.share.minScore, 15)
  assert.equal(config.listen.comments, true)
  assert.equal(config.listen.commentIntervalSec, 600)
  assert.equal(config.listen.liveRoom, '12345')
  assert.equal(config.schedule.skipChance, 0.5)
  assert.deepEqual(config.schedule.windows, [{ start: '21:00', end: '23:00', wakes: 2 }])
  assert.equal(config.notify.type, 'webhook')
})

test('fromLegacy：两边都设了同一个字段 → 保留 scroll 的，并记进 conflicts', () => {
  const { config, conflicts } = fromLegacy({ autoComment: true }, { share: { enabled: false } })
  assert.equal(config.share.enabled, true)
  assert.ok(conflicts.some((c) => c.field === 'share.enabled'))
})

test('fromLegacy：whale 的旧作息文件会盖过它的新配置（它当年就这么干的）', () => {
  const { config } = fromLegacy({}, { night: { skipChance: 0.1 } }, { skipChance: 0.8 })
  assert.equal(config.schedule.skipChance, 0.8)
})

test('fromLegacy：没有落点 / 不再使用的键被记进 dropped，不静默吞掉', () => {
  const { dropped } = fromLegacy({ _set: ['perDay'] }, { aliases: ['旧名'], toolsPath: 'x' })
  assert.ok(dropped.includes('scroll:_set'))
  assert.ok(dropped.includes('whale:aliases'))
  assert.ok(dropped.includes('whale:toolsPath'))
})

test('flatView / applyFlat：往返后关键字段一致（老代码还在用扁平视图）', () => {
  const cfg = clamp({
    feed: { perDay: 8, keywords: ['a', 'b'] },
    schedule: { enabled: true, noon: false },
    share: { enabled: true, perRound: 2 },
    dm: { mode: 'both', uid: 9 },
    listen: { dm: true, dmIntervalSec: 120 },
    report: { level: 'off' },
    persona: { prompt: '人设' },
  })
  const flat = flatView(cfg)
  assert.equal(flat.perDay, 8)
  assert.equal(flat.peakValley, true)
  assert.equal(flat.dmWatchMinutes, 2)
  const back = applyFlat(DEFAULTS, flat)
  assert.equal(back.feed.perDay, 8)
  assert.deepEqual(back.feed.keywords, ['a', 'b'])
  assert.equal(back.schedule.noon, false)
  assert.equal(back.share.perRound, 2)
  assert.equal(back.dm.uid, 9)
  assert.equal(back.listen.dmIntervalSec, 120)
  assert.equal(back.report.level, 'off')
  assert.equal(back.persona.prompt, '人设')
})

test('applyFlat：只改传进来的那几个键，其余不动', () => {
  const base = clamp({ feed: { perDay: 9 }, account: { mentionName: '甲' } })
  const next = applyFlat(base, { perDay: 3 })
  assert.equal(next.feed.perDay, 3)
  assert.equal(next.account.mentionName, '甲')
})

test('isNewShape：认得新形状，也认得老扁平形状', () => {
  assert.equal(isNewShape({ version: 1 }), true)
  assert.equal(isNewShape({ feed: {} }), true)
  assert.equal(isNewShape({ perDay: 5, mentionName: 'x' }), false)
  assert.equal(isNewShape(null), false)
  assert.equal(isNewShape([]), false)
})

test('_set 能随配置一起落盘、读回（面板"本地优先"的账本）', () => {
  const c = clamp({ _set: ['perDay', 'mentionName'] })
  assert.deepEqual(c._set, ['perDay', 'mentionName'])
})
