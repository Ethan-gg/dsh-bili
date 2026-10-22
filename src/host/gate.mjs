/**
 * src/host/gate.mjs —— 闸门：到底该不该说这句话
 * ============================================================================
 * 移植自 [`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale) 的
 * `tools/lib/share-policy.mjs` + `tools/commands/quota.mjs` 的判定部分（MIT）。
 *
 * 设计上刻意分成两半：
 *   · **判断是纯函数**（`evaluateShare`）—— 给它一份账本和几个参数，它说行或不行。
 *     这样才测得出"连续第 4 条会被拦""同一个视频第 8 天放行"这种边界。
 *   · **记账是读写**（`readLedger` / `recordShare`）—— 原子写，坏了当空账，不把插件带崩。
 *
 * 为什么闸门必须在**宿主**这一层，而不是写在提示词里：
 *   "别发太多"写在提示词里，模型只是**尽量**遵守；写在这里是**发不出去**。
 *   用户拿自己的号说话，这个区别是有代价的。
 *
 * 六道闸，按顺序（顺序有意义：先说清"这事儿能不能做"，再说"这个能不能做"）：
 *   ① 总开关关着 ⇒ 拒
 *   ② 评分不在 0–20、或低于门槛 ⇒ 拒
 *   ③ 理由不到 8 个字 ⇒ 拒（说不清为什么留，就别占人家的注意力）
 *   ④ `rank` 给了但不是第 1 ⇒ 拒（只推最好的那条）
 *   ⑤ 同一个视频 N 天内已经说过 ⇒ 拒
 *   ⑥ 今天已经说了 N 条 ⇒ 拒
 *   ⑦ 沉默衰减：你 N 天没任何表态 ⇒ 降额；更久 ⇒ 直接归零
 * ============================================================================
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dayOf, daysBetween, parseTime } from '../lib/time.mjs'

/** 拒绝原因码。给日志和设置页用，**不要**把 raw code 直接念给用户看。 */
export const CODES = {
  SHARE_OFF: 'share-off',
  QUOTA_ZERO: 'quota-zero',
  BAD_SCORE: 'bad-score',
  LOW_SCORE: 'low-score',
  NO_REASON: 'no-reason',
  BAD_RANK: 'bad-rank',
  SAME_VIDEO: 'same-video',
  DAILY_LIMIT: 'daily-limit',
  SILENCE_STOP: 'silence-stop',
  BAD_BVID: 'bad-bvid',
}

const MIN_REASON = 8
const BV_RE = /^BV[0-9A-Za-z]{10}$/

/* ───────────────────────── 账本读写 ───────────────────────── */

export const emptyLedger = () => ({ v: 1, entries: [] })

/** 坏文件当空账 —— 账本读不出来时宁可"少发"，也不要让整个插件起不来。 */
export function normalizeLedger(raw) {
  if (!raw || typeof raw !== 'object') return emptyLedger()
  // 兼容 whale 的老形状 `{log:[…]}`（迁移器一般已经转过了，这里是二道保险）
  const src = Array.isArray(raw.entries) ? raw.entries : (Array.isArray(raw.log) ? raw.log.map((x) => ({
    at: String(x?.at ?? ''), kind: String(x?.type ?? ''), share: Boolean(x?.share),
    bvid: null, via: null, score: null, note: String(x?.note ?? ''),
  })) : [])
  const entries = src
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      at: String(e.at ?? ''),
      kind: String(e.kind ?? ''),
      share: Boolean(e.share),
      bvid: typeof e.bvid === 'string' && BV_RE.test(e.bvid) ? e.bvid : null,
      via: typeof e.via === 'string' ? e.via : null,
      score: Number.isFinite(Number(e.score)) ? Number(e.score) : null,
      note: String(e.note ?? '').slice(0, 200),
    }))
    // 没有时间的条目留着也没用（永远算不出"几天前"），直接丢
    .filter((e) => parseTime(e.at) !== null)
  return { v: 1, entries }
}

export function readLedger(file) {
  try {
    if (!existsSync(file)) return emptyLedger()
    return normalizeLedger(JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, '')))
  } catch { return emptyLedger() }
}

/** 原子写（临时文件 + rename）：写坏一半比没写更糟，用户会看到"账本空了"然后被重复打扰。 */
export function writeLedger(file, ledger) {
  const next = normalizeLedger(ledger)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch { /* Windows 上可能不生效 */ }
  return next
}

/* ───────────────────────── 查询 ───────────────────────── */

/** 某一天的账：`{ day, shared, total, dms }` */
export function tally(entries = [], now = Date.now()) {
  const day = dayOf(now)
  let shared = 0
  let dms = 0
  let total = 0
  for (const e of entries) {
    if (dayOf(parseTime(e.at) ?? 0) !== day) continue
    total += 1
    if (e.share) shared += 1
    if (e.via === 'dm') dms += 1
  }
  return { day, shared, dms, total }
}

/** 这个视频最近一次被分享是什么时候（没有就 null） */
export function lastShareOf(entries = [], bvid) {
  let best = null
  for (const e of entries) {
    if (!e.share || e.bvid !== bvid) continue
    const t = parseTime(e.at)
    if (t === null) continue
    if (!best || t > best.t) best = { t, at: e.at }
  }
  return best
}

/** 主人最后一次表态离今天几天（没有表态记录就是 null，不当成"沉默了很久"） */
export function silenceDays(feedback, now = Date.now()) {
  const last = feedback?.lastAt ?? feedback?.last ?? null
  if (!last) return null
  const d = daysBetween(last, now)
  return d === null ? null : Math.max(0, d)
}

/* ───────────────────────── 判断（纯函数） ───────────────────────── */

/**
 * 这一条能不能说。**不抛异常** —— 返回 `{ ok, code, message, warn }`，
 * 让调用方决定是"跳过这条"还是"整轮收工"。
 *
 * @param {object} p
 * @param {object} p.share      config.share
 * @param {Array}  p.entries    账本条目
 * @param {object} [p.feedback] `{ lastAt }` 主人上次表态（没有就不做沉默衰减）
 * @param {number} [p.now]
 * @param {string} p.bvid
 * @param {number} p.score      0–20 自评
 * @param {string} p.reason     为什么值得（≥8 字）
 * @param {number} [p.rank]     1 表示"本轮第一"
 * @param {string} [p.via]      comment | dm
 */
export function evaluateShare({
  share = {}, entries = [], feedback = null, now = Date.now(),
  bvid, score, reason, rank, via = 'comment',
} = {}) {
  const deny = (code, message, extra = {}) => ({ ok: false, code, message, via, ...extra })
  const allow = (extra = {}) => ({ ok: true, code: null, message: '', via, ...extra })

  // ① 总开关
  if (share.enabled !== true) return deny(CODES.SHARE_OFF, '分享总开关关着（设置 → 互动 → 自动分享）')

  // ② 视频号
  if (!BV_RE.test(String(bvid ?? ''))) return deny(CODES.BAD_BVID, '没有合法的 BV 号就没法判重，不敢发')

  // ③ 评分
  const s = Number(score)
  if (!Number.isFinite(s) || s < 0 || s > 20) return deny(CODES.BAD_SCORE, `评分必须是 0–20 的整数（收到 ${JSON.stringify(score)}）`)
  const min = Number.isFinite(Number(share.minScore)) ? Number(share.minScore) : 13
  if (s < min) return deny(CODES.LOW_SCORE, `评分 ${s} 低于门槛 ${min} —— 不够好就不发`, { score: s, min })

  // ④ 理由
  const why = String(reason ?? '').trim()
  if (why.length < MIN_REASON) return deny(CODES.NO_REASON, `理由至少 ${MIN_REASON} 个字（收到 ${why.length} 个）—— 说不清为什么留，就别占他的注意力`)

  // ⑤ 名次（可以不传；传了就必须是第一）
  if (rank !== undefined && rank !== null && Number(rank) !== 1) return deny(CODES.BAD_RANK, '只发本轮第一名')

  // ⑥ 同视频 N 天内一次（按 BV 号算，不按"发给谁"算）
  const sameDays = Number.isFinite(Number(share.sameVideoDays)) ? Number(share.sameVideoDays) : 7
  const last = lastShareOf(entries, bvid)
  if (last) {
    const gap = daysBetween(last.at, now)
    if (gap !== null && gap < sameDays) {
      return deny(CODES.SAME_VIDEO, `这个视频 ${sameDays} 天内已经说过了（${last.at.slice(0, 10)}，还差 ${sameDays - gap} 天）`, { lastAt: last.at })
    }
  }

  // ⑦ 当天额度
  const daily = Number.isFinite(Number(share.daily)) ? Number(share.daily) : 3
  if (daily <= 0) return deny(CODES.QUOTA_ZERO, '每天允许分享的条数是 0（设置里改成 ≥1 才会发）')
  const t = tally(entries, now)
  if (t.shared >= daily) return deny(CODES.DAILY_LIMIT, `今天已经说过 ${t.shared} 条，额度 ${daily} 条用完了`, { shared: t.shared, daily })

  // ⑧ 沉默衰减：不是"惩罚"，是"你没反应，我就少说点"
  const quiet = silenceDays(feedback, now)
  const stopAfter = Number.isFinite(Number(share.silenceStopDays)) ? Number(share.silenceStopDays) : 7
  const lowAfter = Number.isFinite(Number(share.silenceDays)) ? Number(share.silenceDays) : 3
  if (quiet !== null && quiet >= stopAfter) {
    return deny(CODES.SILENCE_STOP, `你已经 ${quiet} 天没有过任何反应 —— 按设置先不分享了（日记照写）`, { silentDays: quiet })
  }
  if (quiet !== null && quiet >= lowAfter) {
    return allow({ warn: `你已经 ${quiet} 天没反应了，我少说一点`, silentDays: quiet, remaining: daily - t.shared })
  }

  return allow({ remaining: daily - t.shared })
}

/**
 * 记一笔（不判断，只记账）。返回**新账本**，不改入参 —— 纯一点，方便并发时看谁赢。
 */
export function recordShare(ledger, { at = new Date().toISOString(), bvid = null, via = 'comment', score = null, reason = '', kind = 'share', share = true } = {}) {
  const base = normalizeLedger(ledger)
  const entry = {
    at: new Date(at).toISOString(),
    kind: String(kind),
    share: Boolean(share),
    bvid: typeof bvid === 'string' && BV_RE.test(bvid) ? bvid : null,
    via: typeof via === 'string' ? via : null,
    score: Number.isFinite(Number(score)) ? Number(score) : null,
    note: String(reason ?? '').slice(0, 200),
  }
  return { v: 1, entries: [...base.entries, entry] }
}

/** 顺手给设置页/状态卡用的摘要 */
export function summary(ledger, share = {}, now = Date.now()) {
  const entries = normalizeLedger(ledger).entries
  const t = tally(entries, now)
  const daily = Number.isFinite(Number(share.daily)) ? Number(share.daily) : 3
  return {
    ...t,
    daily,
    remaining: Math.max(0, daily - t.shared),
    silentDays: silenceDays(share.feedback, now),
    lastShareAt: entries.filter((e) => e.share).map((e) => e.at).sort().pop() ?? null,
  }
}
