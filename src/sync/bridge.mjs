/**
 * src/sync/bridge.mjs —— 云桥的"管子"：发出去、收进来、别重复、别被灌爆
 * ============================================================================
 * 它只管**搬运与安检**，不管"收到消息之后她要回什么" ——
 * 后者是 `onEvent` 回调（由 host 半端注进来），免得协议层学会业务。
 *
 * 一道重要的取舍：**收到坏事件时只记数，不抛异常**。
 * 云端是外部输入，抛出来就是一个让对面一条坏数据打挂本机的口子。
 * ============================================================================
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { makeEvent, validateEnvelope, verifySignature } from './protocol.mjs'

const SEEN_TTL_MS = 7 * 24 * 3600 * 1000

const readJson = (f, def) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return def } }
function writeJsonAtomic(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch { /* 落盘失败不致命：下一条还会再写 */ }
}

/** 密钥：没有就现造一个 32 字节的，0600。**只在设置页展示一次**（见 contract.md §6） */
export function ensureSecret(file) {
  try {
    const cur = readFileSync(file, 'utf8').trim()
    if (cur.length >= 32) return cur
  } catch { /* 没有就造 */ }
  const secret = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, secret + '\n', { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* Windows 上可能不生效 */ }
  } catch { /* 写不进去就只活这一次 */ }
  return secret
}

export function createBridge({
  paths, transport, now = () => Date.now(), replayWindowMin = 10, maxInboundPerMinute = 2, log = () => {},
}) {
  const secretFile = paths.secret
  let secret = ''
  let cursor = String(readJson(paths.cursor, {})?.cursor ?? '0')
  const seen = { ...(readJson(paths.seenIds, {})?.ids ?? {}) }
  /** convId → 最近一分钟的入站时间戳 */
  const rate = new Map()
  const stats = { emitted: 0, sendFailed: 0, received: 0, accepted: 0, dup: 0, badSig: 0, badShape: 0, rateLimited: 0 }

  const saveSeen = () => {
    const cutoff = now() - SEEN_TTL_MS
    for (const [id, ts] of Object.entries(seen)) if (Number(ts) < cutoff) delete seen[id]
    writeJsonAtomic(paths.seenIds, { ids: seen, at: new Date(now()).toISOString() })
  }
  const saveCursor = () => writeJsonAtomic(paths.cursor, { cursor, at: new Date(now()).toISOString() })

  function allowedByRate(convId) {
    if (!(maxInboundPerMinute > 0)) return true
    const key = String(convId ?? '')
    const t = now()
    const list = (rate.get(key) ?? []).filter((x) => t - x < 60_000)
    if (list.length >= maxInboundPerMinute) { rate.set(key, list); return false }
    list.push(t)
    rate.set(key, list)
    return true
  }

  return {
    get capabilities() { return transport.capabilities() },
    get cursor() { return cursor },
    status: () => ({ ...stats, cursor, hasSecret: Boolean(secret || existsSync(secretFile)) }),

    /** 发一条事件出去（已经签好名）。失败只记数并回 `{ok:false}`，调用方决定要不要重试。 */
    async emit(type, payload = {}, extra = {}) {
      secret = secret || ensureSecret(secretFile)
      const env = makeEvent({ type, payload, secret, ...extra })
      let r
      try { r = await transport.send(env) } catch (e) { r = { ok: false, error: String(e?.message ?? e) } }
      if (r?.ok) stats.emitted += 1
      else { stats.sendFailed += 1; log(`云桥发送失败（${type}）：${r?.error ?? '未知'}`) }
      return { ...r, event: env }
    },

    /**
     * 收一轮。`handlers[type](event)` 返回什么都会被忽略（除非它抛错 → 只记日志）。
     * 调用方拿到 `{ accepted, dropped, cursor }` 就能决定下一步（比如"没新消息就继续睡"）。
     */
    async pump(handlers = {}) {
      secret = secret || ensureSecret(secretFile)
      const dropped = { badSig: 0, badShape: 0, dup: 0, rate: 0 }
      let accepted = 0
      let res
      try { res = await transport.poll(cursor) } catch (e) {
        log(`云桥拉取失败：${e?.message ?? e}`)
        return { accepted: 0, dropped, cursor, error: String(e?.message ?? e) }
      }
      for (const env of res?.events ?? []) {
        stats.received += 1
        const shape = validateEnvelope(env, { now: new Date(now()), replayWindowMin })
        if (!shape.ok) { dropped.badShape += 1; continue }
        if (!verifySignature(env, secret)) { dropped.badSig += 1; continue }
        if (seen[env.id]) { dropped.dup += 1; continue }
        const convId = env?.payload?.convId ?? env?.payload?.conversationId ?? ''
        if (!allowedByRate(convId)) { dropped.rate += 1; continue }
        seen[env.id] = now()
        accepted += 1
        const fn = handlers[env.type]
        if (typeof fn === 'function') {
          try { await fn(env) } catch (e) { log(`处理 ${env.type} 失败：${e?.message ?? e}`) }
        }
      }
      stats.accepted += accepted
      stats.dup += dropped.dup
      stats.badSig += dropped.badSig
      stats.badShape += dropped.badShape
      stats.rateLimited += dropped.rate
      if (typeof res?.cursor === 'string') { cursor = res.cursor; saveCursor() }
      if (accepted || dropped.dup) saveSeen()
      return { accepted, dropped, cursor, badLines: res?.bad ?? 0 }
    },

    /** 让她被叫醒时能说清"云端有没有人找过她"（状态卡用） */
    pendingInbound() {
      let text = ''
      try { text = existsSync(paths.inbox) ? readFileSync(paths.inbox, 'utf8') : '' } catch { return 0 }
      const total = (text.match(/\n/g) ?? []).length
      return Math.max(0, total - Number(cursor ?? 0))
    },
  }
}
