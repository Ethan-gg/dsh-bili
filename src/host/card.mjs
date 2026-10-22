/**
 * src/host/card.mjs —— 状态卡：每轮唤醒时，宿主把账本压成一张 ≤1500 字的卡
 * ============================================================================
 * 为什么要有（方案 5.4）：常驻会话里，"她"的上下文会一轮一轮长下去；而她要判断
 * "今天还该不该发、这条是不是看过、上次我给自己写了什么"，靠的是**账本**而不是记性。
 * 所以每轮唤醒时，宿主先按磁盘上的事实拼一张卡塞进提示词 —— 她不用自己去翻
 * 判重表 / state.json / 日记，也不会被"上下文里早就过期的那一版"误导。
 *
 * 三条规矩：
 *   ① 卡**硬截断**在 1500 字（一次截断比把 prompt 撑爆强）；
 *   ② 卡里只放事实（数字 / 结论 / 标题），不放"建议她怎么做"—— 那是章程的活；
 *   ③ 拼不出来不许拦着一轮：调用方包 try/catch，这里只负责拼。
 *
 * 判重表的解析**复用迁移器那份 `parseSeenTable`**：口径必须跟宿主数配额时一致，
 * 各写一份迟早出现"卡上 3 条、闸门算 5 条"。
 * ============================================================================
 */
import { dayOf, daysBetween } from '../lib/time.mjs'
import { parseSeenTable } from '../lib/migrate.mjs'

/** 卡的上限（字，按码点算；中文一个字一个码点） */
export const CARD_MAX = 1500
/** 卡的头：告诉模型"这是事实，不用自己再翻文件" */
export const CARD_HEAD = '===== 状态卡（宿主按账本生成，是事实；不用自己再翻文件）====='

/** 上一轮为什么跑 —— 只用来把原因翻成人话 */
const WHY = { noon: '中午窗口', night: '晚上窗口', window: '定时窗口', manual: '手动', tick: '定时' }

const clean = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const clock = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * 拼一张状态卡。
 *
 * @param {object} p
 * @param {number}  [p.now]          当前时刻（测试用；默认 Date.now()）
 * @param {string}  [p.today]        今天的本地日期 YYYY-MM-DD（默认按 now 算）
 * @param {number}  [p.pickedToday]  今天已经挑了几条（宿主从报告里数出来的）
 * @param {object}  [p.cfgNew]       新形状配置（阈值都在这里：feed.* / share.* / dm.* / reply.*）
 * @param {object}  [p.state]        state.json（lastRunAt / lastWhy）
 * @param {string}  [p.seenText]     seen.md 原文
 * @param {Array}   [p.shares]       ledger/shares.json 的 entries
 * @param {string}  [p.lastSelfDiary] 她上次给自己写的一段（宿主用 lastEntryAny 取好）
 * @param {number}  [p.days]         判重摘要看最近几天（默认 7）
 * @param {number}  [p.maxSeen]      判重摘要最多几条（默认 12）
 * @returns {string}
 */
export function buildStatusCard({
  now = Date.now(),
  today = dayOf(now),
  pickedToday = 0,
  cfgNew = {},
  state = {},
  seenText = '',
  shares = [],
  lastSelfDiary = '',
  days = 7,
  maxSeen = 12,
} = {}) {
  const lines = []
  const feed = cfgNew.feed || {}
  const share = cfgNew.share || {}
  const dm = cfgNew.dm || {}
  const reply = cfgNew.reply || {}

  const perDay = Math.max(0, Number(feed.perDay) || 0)
  const picked = Math.max(0, Number(pickedToday) || 0)
  const left = Math.max(0, perDay - picked)
  const daily = Math.max(0, Number(share.daily) || 0)
  const todayShares = (Array.isArray(shares) ? shares : []).filter((e) => {
    const t = Date.parse(e?.at ?? '')
    return Number.isFinite(t) && dayOf(t) === today
  }).length

  /* ① 今天的账 + 上一轮 */
  let head = `今天 ${today} · 已挑 ${picked}/${perDay} 条（还能挑 ${left} 条）`
  if (daily > 0) head += ` · 今天分享 ${todayShares}/${daily} 次`
  const last = Date.parse(state?.lastRunAt ?? '')
  if (Number.isFinite(last) && dayOf(last) === today) {
    head += ` · 上一轮 ${clock(last)}（${WHY[state.lastWhy] || state.lastWhy || '定时'}）`
  }
  lines.push(head)

  /* ② 阈值（事实，不是建议） */
  const th = []
  const minScore = Number(share.minScore) || 0
  const sameDays = Number(share.sameVideoDays) || 0
  if (minScore > 0) th.push(`评分 ≥${minScore} 才分享`)
  if (sameDays > 0) th.push(`同一视频 ${sameDays} 天内只说一次`)
  if (daily > 0) th.push(`每天分享 ≤${daily} 次`)
  if (reply.toComments) th.push(`同一话题 / 同一个人只回一次（每轮 ≤${Number(reply.perRound) || 1} 条）`)
  if (dm.mode && dm.mode !== 'off') th.push(`私信投递：${dm.mode}${dm.uid ? `（UID ${dm.uid}）` : '（UID 靠昵称查）'}`)
  if (th.length) lines.push('阈值：' + th.join('；'))

  /* ③ 最近 N 天的判重摘要 */
  let rows = []
  try { rows = parseSeenTable(seenText) } catch { rows = [] }
  const recent = rows.filter((r) => {
    const d = daysBetween(r.day, today)
    return d !== null && d >= 0 && d <= Math.max(1, days) - 1
  }).slice(-Math.max(1, maxSeen))
  lines.push(`最近 ${days} 天看过（${recent.length ? 'BV · 结论 · 标题' : '还没有记录'}）：`)
  for (const r of recent) {
    lines.push(`- ${r.bvid} · ${r.picked ? '挑了' : '跳过'} · ${clean(r.title, 26)}`)
  }

  /* ④ 她上次给自己写的（状态卡只放最后三行，不放大整份） */
  const dlines = String(lastSelfDiary || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-3)
  if (dlines.length) {
    lines.push('她上次给自己写的最后三行：')
    for (const s of dlines) lines.push('  ' + clean(s, 120))
  }

  /* ⑤ 云端未读：云桥还没接（M4），这一段先不加；接上之后在这里补一行 */

  let out = CARD_HEAD + '\n' + lines.join('\n')
  const chars = Array.from(out)
  if (chars.length > CARD_MAX) {
    const tail = '…（截断）'
    out = chars.slice(0, CARD_MAX - Array.from(tail).length).join('') + tail
  }
  return out
}
