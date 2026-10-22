/**
 * src/sync/protocol.mjs —— 云桥协议 v1 的编解码、签名、校验
 * ============================================================================
 * 这一层的职责只有一个：**让两份"她"能安全地交换事件**，并且坏数据进不来。
 * 它不认识 B 站、不认识 DSH、不认识群聊平台 —— 换了云端实现，这个文件一行都不用改。
 *
 * 三条设计原则（别在实现时"顺手放宽"）：
 *   ① **信封是数据，不是指令**：任何 payload 里的文本都只当素材（见 contract.md §5）
 *   ② **签名覆盖全部语义字段**：加字段要同步到 `canonical()`，否则签了等于没签
 *   ③ **时间戳参与校验**：太旧的入站直接丢（重放防护），但允许时钟偏差
 * ============================================================================
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export const PROTOCOL_VERSION = 1

/** 允许的时间偏差（分钟）。跨机器时钟不会完全一致，但也不需要容忍一天。 */
export const CLOCK_SKEW_MIN = 5

/** 事件类型表。新增类型必须同时在 contract.md 里写清楚 payload 形状。 */
export const TYPES = {
  PERSONA: 'persona.sync',
  MEMORY: 'memory.append',
  QUOTA: 'quota.state',
  MSG_IN: 'message.in',
  MSG_OUT: 'message.out',
  APPROVAL_REQ: 'approval.request',
  APPROVAL_RES: 'approval.result',
  PRESENCE: 'presence',
}
export const TYPE_LIST = Object.values(TYPES)

/** 边（哪一端） */
export const SIDES = ['local', 'cloud']

export const newId = () => 'evt_' + randomUUID().replace(/-/g, '')

/**
 * 稳定序列化：键按字典序排。
 * 不加这个，两端 JSON.stringify 的顺序不一致 ⇒ 签名必然对不上（而且 debug 很久）。
 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}

/** 签名输入：只覆盖语义字段（不含 sig 自身，也不含两端各自生成的 id 之外的元数据） */
export function canonical(env) {
  return stableStringify({
    v: Number(env?.v),
    id: String(env?.id ?? ''),
    at: String(env?.at ?? ''),
    from: String(env?.from ?? ''),
    type: String(env?.type ?? ''),
    payload: env?.payload ?? {},
  })
}

export function sign(env, secret) {
  return 'hmac-sha256:' + createHmac('sha256', String(secret)).update(canonical(env), 'utf8').digest('hex')
}

/** 定长比较，避免时序侧信道（本地插件也一样，习惯成自然） */
export function verifySignature(env, secret) {
  const got = String(env?.sig ?? '')
  if (!got.startsWith('hmac-sha256:')) return false
  const want = sign(env, secret)
  const a = Buffer.from(got, 'utf8')
  const b = Buffer.from(want, 'utf8')
  if (a.length !== b.length) return false
  try { return timingSafeEqual(a, b) } catch { return false }
}

/** 造一个已签名的事件（本地发出去的都走这里） */
export function makeEvent({ type, payload = {}, from = 'local', source = 'dsh-bili-scroll', at = new Date(), secret = '' } = {}) {
  if (!TYPE_LIST.includes(type)) throw new Error(`未知事件类型：${type}`)
  if (!SIDES.includes(from)) throw new Error(`未知发出方：${from}`)
  const env = {
    v: PROTOCOL_VERSION,
    id: newId(),
    at: new Date(at).toISOString(),
    from,
    source: String(source).slice(0, 64),
    type,
    payload,
  }
  if (secret) env.sig = sign(env, secret)
  return env
}

/**
 * 结构校验（不含签名）。返回 `{ ok, error }`，不抛 —— 入站路径上抛异常等于给对方一个 DoS 口子。
 */
export function validateEnvelope(env, { now = new Date(), replayWindowMin = 10 } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { ok: false, error: 'not-an-object' }
  if (Number(env.v) !== PROTOCOL_VERSION) return { ok: false, error: `bad-version:${env.v}` }
  if (typeof env.id !== 'string' || !/^evt_[0-9a-f]{32}$/.test(env.id)) return { ok: false, error: 'bad-id' }
  if (typeof env.at !== 'string' || Number.isNaN(Date.parse(env.at))) return { ok: false, error: 'bad-time' }
  if (!SIDES.includes(env.from)) return { ok: false, error: 'bad-from' }
  if (!TYPE_LIST.includes(env.type)) return { ok: false, error: `bad-type:${env.type}` }
  if (!env.payload || typeof env.payload !== 'object' || Array.isArray(env.payload)) return { ok: false, error: 'bad-payload' }

  const ageMs = new Date(now).getTime() - Date.parse(env.at)
  if (ageMs > replayWindowMin * 60_000) return { ok: false, error: 'too-old' }
  if (ageMs < -CLOCK_SKEW_MIN * 60_000) return { ok: false, error: 'too-new' }
  return { ok: true, error: null }
}

export const encode = (env) => JSON.stringify(env)
export function decode(line) {
  try {
    const v = JSON.parse(String(line))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

/** 单行 JSONL 追加用 */
export const line = (env) => encode(env) + '\n'
