/**
 * src/host/review.mjs —— 草稿队列：陌生人的回复，先给你看，你点头才发
 * ============================================================================
 * 来源：[`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale) 的 `reply-draft`（MIT）。
 *
 * 为什么要有这一层：评论一旦发出去，是**用你的号、在公开场合**说的。她答对了没人夸，
 * 答偏了是你的名声。所以对陌生人默认"先写草稿"，而不是"先发了再说"。
 * 主人自己的消息不进来（那条直接回，见 duty 里的规则）。
 *
 * 三个必须的语义：
 *   ① **`take` 是原子的取走**：批准流程是「取走 → 真发 → 失败就放回」。
 *      不取走就发，会连点两次发两条；发失败不放回，草稿就悄悄丢了。
 *   ② **幂等**：同一条回复（同 oid + 同父评论 + 同样正文）只入队一次。
 *   ③ **过期**：没人理的草稿超过 N 天自动失效 —— 三天前该回的话，第四天回不如不回。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { parseTime } from '../lib/time.mjs'

export const MAX_QUEUE = 200
export const DEFAULT_TTL_HOURS = 72
const BV_RE = /^BV[0-9A-Za-z]{10}$/

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const str = (v, n = 500) => String(v ?? '').slice(0, n)

/** 同一条回复 → 同一个 id（幂等入队靠它） */
export function draftId({ kind = 'reply', oid, root, parent, message }) {
  const h = createHash('sha256')
    .update([kind, String(oid ?? ''), String(root ?? ''), String(parent ?? ''), String(message ?? '')].join('\u0000'))
    .digest('hex')
  return 'd_' + h.slice(0, 16)
}

export function emptyQueue() { return { v: 1, items: [] } }

/** 坏文件 / 老形状都当空队列 —— 队列读不出来时宁可"少回"，不要崩。 */
export function normalizeQueue(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw) ? raw : [])
  return {
    v: 1,
    items: items
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({
        id: typeof x.id === 'string' && x.id ? x.id : draftId(x),
        kind: x.kind === 'share' ? 'share' : 'reply',
        at: String(x.at ?? ''),
        oid: num(x.oid),
        bvid: typeof x.bvid === 'string' && BV_RE.test(x.bvid) ? x.bvid : null,
        root: num(x.root),
        parent: num(x.parent),
        who: num(x.who),
        src: str(x.src, 40),
        message: str(x.message, 1000),
        note: str(x.note, 200),
      }))
      .filter((x) => x.message && parseTime(x.at) !== null),
  }
}

export function readQueue(file) {
  try {
    if (!existsSync(file)) return emptyQueue()
    return normalizeQueue(JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, '')))
  } catch { return emptyQueue() }
}

/** 原子写 + 0600（草稿里可能有他的原话，不该给别的用户读） */
export function writeQueue(file, queue) {
  const next = normalizeQueue(queue)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  return next
}

/** 顺手把过期的清掉（在内存里算，调用方决定要不要落盘） */
export function pruneExpired(queue, { now = Date.now(), ttlHours = DEFAULT_TTL_HOURS } = {}) {
  const q = normalizeQueue(queue)
  const ttl = Math.max(1, Number(ttlHours) || DEFAULT_TTL_HOURS) * 3600_000
  const kept = q.items.filter((x) => {
    const t = parseTime(x.at)
    return t !== null && now - t <= ttl
  })
  return { v: 1, items: kept, dropped: q.items.length - kept.length }
}

/**
 * 入队。重复的直接返回 `{ ok:true, dup:true, id }`（不报错 —— 重复是很正常的情况）。
 * 队列满了丢最旧的：新草稿比三天前的旧草稿更值得你花三秒钟看。
 */
export function addDraft(queue, draft, { now = Date.now(), ttlHours } = {}) {
  const q = pruneExpired(queue, { now, ttlHours })
  const item = normalizeQueue({ items: [{ ...draft, at: draft?.at ?? new Date(now).toISOString() }] }).items[0]
  if (!item) return { queue: { v: 1, items: q.items }, ok: false, error: '草稿缺正文或时间' }
  if (q.items.some((x) => x.id === item.id)) return { queue: { v: 1, items: q.items }, ok: true, dup: true, id: item.id }
  const items = [...q.items, item].slice(-MAX_QUEUE)
  const droppedFull = Math.max(0, q.items.length + 1 - items.length)
  return { queue: { v: 1, items }, ok: true, id: item.id, dropped: droppedFull || undefined }
}

/** 列表（顺便告状：有几条已经过期被跳过了） */
export function listDrafts(queue, { now = Date.now(), ttlHours } = {}) {
  const q = pruneExpired(queue, { now, ttlHours })
  return { items: q.items.slice().sort((a, b) => (a.at < b.at ? 1 : -1)), expired: q.dropped }
}

/**
 * 取走（批准时用）。**取走之后队列里就没有它了** —— 发失败一定要 `addDraft` 放回去，
 * 否则用户以为批准了、其实什么都没发。
 */
export function takeDraft(queue, id) {
  const q = normalizeQueue(queue)
  const item = q.items.find((x) => x.id === String(id)) ?? null
  if (!item) return { queue: q, item: null }
  return { queue: { v: 1, items: q.items.filter((x) => x.id !== item.id) }, item }
}

/** 否掉（不取走也行：直接删，并留一句"为什么不要"给她学） */
export function dropDraft(queue, id) {
  const q = normalizeQueue(queue)
  const before = q.items.length
  const items = q.items.filter((x) => x.id !== String(id))
  return { queue: { v: 1, items }, removed: before - items.length }
}
