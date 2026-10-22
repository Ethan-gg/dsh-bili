/**
 * src/host/clock.mjs —— 生物钟：她什么时候醒
 * ============================================================================
 * 移植自 [`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale) 的
 * `tools/lib/night-plan.mjs`（MIT）。**逻辑近乎原样保留** —— 它是纯函数、有测试、
 * 而且里面每一条"为什么这么写"都是被真实使用磨出来的；重写一遍只会把那些坑再踩一遍。
 *
 * 它解决的问题：固定整点跑太像打卡。这里要的是"在允许的时段里，**随机一个时刻**醒，
 * 而且有 30% 的概率**今天不想看**" —— 后者不是摆烂，是让"分享"这件事有分量。
 *
 * 五条规则（都在下面有对应代码）：
 *   ① 窗口内**均匀随机**取一个时刻，不是整点，也不是"窗口开始就醒"
 *   ② 两次醒来之间**硬间隔** ≥ minGapMin；窗口挤不下就少醒一次，不自动压缩间隔
 *   ③ 每天总次数有上限；`skip`（不想看）**也占一次机会** —— 但不拉黑整个窗口
 *   ④ 计划**先落盘再唤醒**：进程重启、跨午夜、改配置都不重新掷骰子
 *   ⑤ 历史只留 3 天，按"日期化的窗口"记账（`2026-10-22|20:00–24:00`）
 *
 * ⚠️ 全部用**本地日历时间**比较（不是 UTC 偏移），跨午夜与夏令时都按本地算。
 * ============================================================================
 */
import { hhmm } from '../lib/config.mjs'
import { dayOf } from '../lib/time.mjs'

/** 本地日期 `YYYY-MM-DD`（统一在 `src/lib/time.mjs`，闸门也要用同一套口径） */
export { dayOf }

const pad = (n) => String(n).padStart(2, '0')
const stamp = (day, minutes) => {
  const d = new Date(`${day}T00:00:00`)
  d.setMinutes(minutes)
  return d.getTime()
}

/** `HH:MM` → 当天第几分钟。非法直接抛：作息配错了要当场知道，不要静默排一个奇怪的时刻。 */
const minutesOf = (s) => {
  const v = hhmm(s)
  if (!v) throw new Error(`无效作息时间：${s}`)
  const [h, m] = v.split(':').map(Number)
  return h * 60 + m
}

/**
 * 把配置里的窗口展开成"分钟区间"。`end <= start` 视为跨午夜（+24h）。
 * 空配置返回 `[]` —— **不在这里替调用方猜默认窗口**（谷时窗口是另一套口径，由调用方决定）。
 */
export function windowsOf(schedule = {}) {
  const list = Array.isArray(schedule?.windows) ? schedule.windows : []
  return list.map((w) => {
    const start = minutesOf(w?.start)
    const rawEnd = minutesOf(w?.end)
    const end = rawEnd <= start ? rawEnd + 1440 : rawEnd
    const wakes = Math.min(12, Math.max(0, Math.floor(Number(w?.wakes ?? 1) || 0)))
    return { start, end, wrap: end > 1440, label: `${w.start}–${w.end}`, wakes }
  })
}

/** 一天最多醒几次（所有窗口加起来，硬上限 12） */
export const maxWakes = (schedule) => Math.min(12, windowsOf(schedule).reduce((n, w) => n + w.wakes, 0))

/**
 * 当前还能用的"窗口实例"。跨午夜的窗口会展开成「昨天那一次 + 今天那一次」两个，
 * 并且只保留 `endsAt > now` 的（已经过去的窗口不再参与排队）。
 */
export function occurrences(schedule, now = Date.now()) {
  const today = dayOf(now)
  const y = new Date(`${today}T00:00:00`)
  y.setDate(y.getDate() - 1)
  return windowsOf(schedule)
    .flatMap((w) => (w.wrap ? [dayOf(y), today] : [today]).map((day) => ({
      ...w,
      key: `${day}|${w.label}`,
      startsAt: stamp(day, w.start),
      endsAt: stamp(day, w.end),
    })))
    .filter((w) => w.endsAt > now)
}

/** 现在正好落在某个窗口里吗（状态卡里说"你醒了，现在在窗口 X 的第 n/m 次"） */
export const inScheduleWindow = (schedule, now = Date.now()) =>
  occurrences(schedule, now).some((w) => w.startsAt <= now)

/**
 * 把历史整理成 schema 2，并**迁移 schema 1**。
 * 为什么值得留：老版本"先预约、后投递"，重启时会把没投递的那次算作已用 ⇒ 少醒一次。
 * 这里只释放那一次**预约**，不是清空历史。
 */
export function historyOf(state = {}, now = Date.now()) {
  const usedCount = { ...(state.usedCount ?? {}) }
  const skippedWindows = new Set(state.skippedWindows ?? [])
  if (state.schema !== 2 && state.date) {
    for (const [label, count] of Object.entries(usedCount)) {
      if (!label.includes('|')) {
        const reserved = state.action === 'wake' && !state.fired && !state.woke && label === state.window ? 1 : 0
        usedCount[`${state.date}|${label}`] = Math.max(0, Number(count) - reserved)
        delete usedCount[label]
      }
    }
    if (state.action === 'skip' && state.fired && state.window) skippedWindows.add(`${state.date}|${state.window}`)
  }
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 3)
  for (const key of Object.keys(usedCount)) if (key.slice(0, 10) < dayOf(cutoff)) delete usedCount[key]
  return {
    schema: 2,
    date: dayOf(now),
    wakes: state.date === dayOf(now) ? Number(state.wakes ?? 0) : 0,
    wokeAt: state.wokeAt ?? null,
    usedCount,
    skippedWindows: [...skippedWindows].filter((key) => key.slice(0, 10) >= dayOf(cutoff)),
  }
}

/** 已经排好、还没投递、时间还没过 ⇒ 不重新掷骰子 */
export function isPending(state, now = Date.now()) {
  return state?.schema === 2 && ['wake', 'skip'].includes(state.action) && !state.fired && !state.woke &&
    Number.isFinite(state.atMs) && Number.isFinite(state.endsAt) && state.endsAt > now
}

/**
 * 算下一次：返回一个**计划对象**（它自己就是下一份持久化状态）。
 * `action` 三态：`wake`（到点叫她）/ `skip`（到点告诉她"今天不想看"，仍写日记）/ `done`（今天不再排了）。
 * `random` 可注入 —— 测试要能复现"掷到了跳过"。
 */
export function makePlan(schedule, state = {}, now = Date.now(), random = Math.random, maxVideos = 5) {
  // ① 已有计划且还没到点 ⇒ 原样返回（**不重掷**，这是"跨午夜/重启"能对上的前提）
  if (isPending(state, now)) return state
  const history = historyOf(state, now)
  const done = (reason) => ({ ...history, action: 'done', done: true, reason })

  const total = maxWakes(schedule)
  if (total <= 0) return done('没有配置作息窗口（或每个窗口都是 0 次）')
  if (history.wakes >= total) return done('今天醒来次数已用完')

  // ② 候选：这个窗口**还剩几次机会**（跳过一次只减一次机会，不整段作废）
  const pool = occurrences(schedule, now)
    .filter((w) => w.wakes > (history.usedCount[w.key] ?? 0))
    .sort((a, b) => a.endsAt - b.endsAt || a.startsAt - b.startsAt)
  if (!pool.length) return done('今天可用窗口已结束或已经处理')

  // ③ 硬间隔：离上次醒来太近就往后推；推不进窗口就换下一个窗口
  const lastWoke = Number.isFinite(Date.parse(state.wokeAt ?? '')) ? Date.parse(state.wokeAt) : 0
  const minGapMs = Math.max(60_000, Math.floor((Number(schedule?.minGapMin) || 10) * 60_000))
  let picked = null
  for (const cand of pool) {
    const earliest = Math.max(now, cand.startsAt, lastWoke + minGapMs)
    if (earliest >= cand.endsAt - 30_000) continue    // 这个窗口放不下下一次了
    picked = { cand, earliest }
    break
  }
  if (!picked) return done('今天可用窗口里已经排不下下一次（间隔不够）')

  // ④ 窗口内均匀随机（不是整点）
  const w = picked.cand
  const atMs = picked.earliest + Math.floor(random() * Math.max(1, w.endsAt - picked.earliest))
  const atDate = new Date(atMs)

  // ⑤ 今天想不想看（概率来自配置，默认 0.3）
  const skipChance = Math.min(1, Math.max(0, Number(schedule?.skipChance ?? 0.3)))
  const skip = random() < skipChance

  return {
    ...history,
    action: skip ? 'skip' : 'wake',
    fired: false,
    atMs,
    at: atDate.getHours() * 60 + atDate.getMinutes(),
    atText: `${dayOf(atMs)} ${pad(atDate.getHours())}:${pad(atDate.getMinutes())}`,
    window: w.label,
    windowKey: w.key,
    startsAt: w.startsAt,
    endsAt: w.endsAt,
    withinWindow: `${w.label} 第 ${(history.usedCount[w.key] ?? 0) + 1}/${w.wakes} 次`,
    maxVideos: Number(maxVideos) || 5,
    createdAt: new Date(now).toISOString(),
    ...(skip ? { reason: '这次不看了，日记照写' } : { roll: 'watch' }),
  }
}

/**
 * 投递成功之后记账（**必须先投递再记账**：记早了，进程崩在投递前就白丢一轮）。
 * `skip` 也占一次机会 —— 否则"跳过"会让窗口永远可用，等于没有上限。
 */
export function completePlan(state, now = Date.now()) {
  if (state.fired) return state
  const h = historyOf(state, now)
  if (!state.windowKey) throw new Error('计划缺少窗口标识，请重新 plan')
  if (state.action === 'skip' || state.action === 'wake') {
    h.usedCount[state.windowKey] = (h.usedCount[state.windowKey] ?? 0) + 1
    h.wakes += 1
  }
  return { ...state, ...h, fired: true, woke: state.action === 'wake', wokeAt: new Date(now).toISOString() }
}
