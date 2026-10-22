/**
 * src/bili/http.mjs —— 只读能力层的 HTTP 底座：缓存 / 节流 / 风控熔断
 * ============================================================================
 * 来源：[`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale) 的
 * `tools/lib/bili-api.mjs`（MIT），搬过来时做了三件事：
 *   ① 路径从 `~/.bili-ai/` 改成**插件家目录**（`<home>/.cache/`）；
 *   ② fetch / 时钟 / sleep 可注入（单测不碰真网络、不真等 300ms）；
 *   ③ 只保留我们把 B站 当"数据源"时需要的那部分（不碰写入、不碰登录流程）。
 *
 * 为什么必须有这三样（社区实测，不是洁癖）：
 *   · B站 的 **412 是 IP 级限流**，换接口救不了 ⇒ 撞到就熔断一段时间，别硬闯；
 *   · 同一份元信息 24 小时内只问一次 B站（一轮里 view 会被好几处各查一遍）；
 *   · 两次请求至少隔 300ms —— 贴脸连打正是被限流的典型特征。
 * ============================================================================
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import crypto from 'node:crypto'
import { mixinKey, signQuery } from './wbi.mjs'

/** 统一 UA：不带 UA 的裸请求更容易被风控盯上 */
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const CACHE_TTL_MS = 24 * 3600 * 1000
const NAV_TTL_MS = 10 * 60 * 1000
const STALE_MAX_MS = 7 * CACHE_TTL_MS
const THROTTLE_MS = 300
/** 这些 code 是"平台级风控"，撞到就熔断 */
const BAN_CODES = new Set([-412, -352, -799, -509, -10403])
/** 只缓存"静态一点的元信息"；评论 / 字幕下载地址绝不能缓存 */
const CACHEABLE = [
  /^\/x\/web-interface\/(wbi\/)?view$/,
  /^\/x\/web-interface\/nav$/,
  /^\/x\/space\/wbi\/acc\/info$/,
]
/** 这两个端点上的 -412 是"这条内容受限"（大会员/地区），不是限流 ⇒ 不熔断 */
const CONTENT_RESTRICTED = [/^\/x\/player\/(wbi\/)?playurl$/]

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return fallback } }
const writeJson = (f, v) => {
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v)) } catch { /* 写不进缓存不致命 */ }
}

/**
 * @param {object} p
 * @param {string} p.home                        插件家目录（缓存/熔断状态放 `<home>/.cache/`）
 * @param {Function} [p.fetchImpl]               fetch 实现（单测注入）
 * @param {() => number} [p.now]                 时钟（单测注入）
 * @param {(ms:number)=>Promise<void>} [p.sleep] 等待（单测注入，避免真等）
 * @param {(m:string)=>void} [p.log]
 */
export function createBiliHttp({
  home,
  fetchImpl = (...a) => globalThis.fetch(...a),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  if (!home) throw new Error('createBiliHttp 需要 home（插件家目录）')
  const cacheFile = join(home, '.cache', 'api-cache.json')
  const banFile = join(home, '.cache', 'api-ban.json')

  // 只在测试/排障时用：BILI_NO_CACHE=1 关掉缓存与熔断（每次调用现读，测试会中途设）
  const noCache = () => process.env.BILI_NO_CACHE === '1'

  let lastRequestAt = 0
  let queue = Promise.resolve()
  const throttle = () => {
    const turn = queue.then(async () => {
      const gap = now() - lastRequestAt
      if (gap < THROTTLE_MS) await sleep(THROTTLE_MS - gap)
      lastRequestAt = now()
    })
    queue = turn.catch(() => {})
    return turn
  }

  const bannedUntil = () => {
    const b = readJson(banFile, {})
    return Number(b.until ?? 0) > now() ? Number(b.until) : 0
  }
  const setBan = (ms, why, extra = {}) => writeJson(banFile, { until: now() + ms, why, at: new Date(now()).toISOString(), ...extra })
  const banLeftMinutes = (until) => Math.max(1, Math.round((until - now()) / 60000))

  /** 缓存键：去掉每次都会变的 wts / w_rid，并把 cookie 折成哈希（不落明文） */
  function cacheKey(url, headers) {
    const u = new URL(url)
    if (u.pathname === '/x/web-interface/view') u.pathname = '/x/web-interface/wbi/view'
    const params = [...u.searchParams.entries()]
      .filter(([k]) => k !== 'wts' && k !== 'w_rid')
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || String(av).localeCompare(String(bv)))
    const h = new Headers(headers)
    const account = crypto.createHash('sha256').update(h.get('cookie') ?? '').update('\0').update(h.get('authorization') ?? '').digest('hex')
    return account + ':' + u.hostname + u.pathname + '?' + new URLSearchParams(params).toString()
  }
  const cacheable = (url) => {
    const u = new URL(url)
    return u.hostname === 'api.bilibili.com' && CACHEABLE.some((re) => re.test(u.pathname))
  }
  const isNav = (url) => {
    const u = new URL(url)
    return u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/nav'
  }
  const isBili = (url) => {
    const u = new URL(url)
    return u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com')
  }

  /**
   * GET 一个 B站 接口。
   * **不抛**：失败也返回 `{ code, message }`，让调用方自己决定"必需还是可选"
   * （cookie 与响应正文永远不进日志 / 不进缓存键明文）。
   */
  async function get(input, headers = {}, opts = {}) {
    const url = new URL(input)
    const ttl = Number(opts.ttlMs) || CACHE_TTL_MS
    const key = cacheKey(url.href, headers)
    const canCache = cacheable(url.href) || isNav(url.href)
    const stale = () => {
      if (noCache() || !cacheable(url.href)) return null
      const hit = readJson(cacheFile, {})[key]
      return hit?.data?.code === 0 && now() - Number(hit.at ?? 0) < STALE_MAX_MS
        ? { ...hit.data, _cached: true, _stale: true } : null
    }

    // ① 熔断中：不打网络；有缓存就吃，没有就明确说"等多久"
    const banned = noCache() || !isBili(url.href) ? 0 : bannedUntil()
    if (banned) {
      const hit = stale()
      if (hit) return hit
      return { code: -412, message: `HTTP 412 —— 本机被 B站 限流了，约 ${banLeftMinutes(banned)} 分钟后自动恢复（期间用缓存过日子）` }
    }

    // ② 缓存命中
    if (!noCache() && canCache) {
      const hit = readJson(cacheFile, {})[key]
      const useTtl = isNav(url.href) ? NAV_TTL_MS : ttl
      if (hit && now() - Number(hit.at ?? 0) < useTtl) return { ...hit.data, _cached: true }
    }

    try {
      // ③ view / playurl 自动换到 wbi 路径并签名（调用方不用记这两个特例）
      const signedPaths = { '/x/web-interface/view': '/x/web-interface/wbi/view', '/x/player/playurl': '/x/player/wbi/playurl' }
      if (url.hostname === 'api.bilibili.com' && signedPaths[url.pathname]) {
        const nav = await get('https://api.bilibili.com/x/web-interface/nav', headers)
        if (!nav?.data?.wbi_img) return { code: -1, message: `WBI 签名不可用：${nav?.message || 'nav 未返回密钥'}` }
        url.pathname = signedPaths[url.pathname]
        url.search = '?' + signQuery(Object.fromEntries(url.searchParams), mixinKey(nav.data.wbi_img), now())
      }

      // ④ 节流
      await throttle()
      const response = await fetchImpl(url.href, { headers, signal: AbortSignal.timeout(30000) })

      if (isBili(url.href) && (response.status === 412 || response.status === 429)) {
        const prev = readJson(banFile, {})
        const streak = Number(prev.streak ?? 0) + 1
        const mins = Math.min(30, 5 * 2 ** (streak - 1))
        if (!noCache()) setBan(mins * 60_000, `HTTP ${response.status}`, { streak, endpoint: url.pathname })
        const hit = stale()
        if (hit) return hit
        return { code: -412, message: `HTTP ${response.status}（B站 风控）—— 已熔断 ${mins} 分钟，别再打了` }
      }
      if (!response.ok) return { code: -1, message: `HTTP ${response.status}（B站 风控或接口异常，请稍后重试；见 README 排障）` }

      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
        if (!data || typeof data !== 'object') throw new Error('invalid JSON payload')
      } catch {
        return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更；见 README 排障` }
      }

      // 接口层风控码（HTTP 200 但 code 是风控）
      if (isBili(url.href) && BAN_CODES.has(Number(data.code))) {
        if (Number(data.code) === -412 && CONTENT_RESTRICTED.some((re) => re.test(url.pathname))) {
          return { ...data, message: `${data.message ?? ''}（这条播放地址受限：大会员专属/地区限制，不是限流）` }
        }
        const prev = readJson(banFile, {})
        const streak = Number(prev.streak ?? 0) + 1
        const mins = Math.min(30, 5 * 2 ** (streak - 1))
        if (!noCache()) writeJson(banFile, { until: now() + mins * 60_000, why: `code=${data.code}`, at: new Date(now()).toISOString(), streak, endpoint: url.pathname })
        return { ...data, message: `${data.message ?? ''}（B站 风控 ${data.code}）—— 已熔断 ${mins} 分钟` }
      }

      if (Number(data.code) === 0) {
        const b = readJson(banFile, {})
        if (!noCache() && b.streak && b.endpoint === url.pathname) writeJson(banFile, { ...b, streak: 0 })
        if (!noCache() && canCache) {
          const store = readJson(cacheFile, {})
          store[key] = { at: now(), data }
          const keys = Object.keys(store)
          if (keys.length > 400) {
            keys.sort((a, b2) => Number(store[a]?.at ?? 0) - Number(store[b2]?.at ?? 0))
            for (const k of keys.slice(0, keys.length - 400)) delete store[k]
          }
          writeJson(cacheFile, store)
        }
      }
      return data
    } catch (error) {
      const msg = error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message))
        ? '请求超时（30 秒）'
        : '请求失败（网络异常或 WBI 签名密钥无效）'
      log(`B站 请求失败：${url.pathname} —— ${error?.message ?? error}`)
      return { code: -1, message: msg }
    }
  }

  /**
   * POST 一个 B站 写接口（发评论 / 发私信）。
   * **不缓存、不重试**（写操作重试就是发两遍）；节流与风控熔断跟 GET 共用，
   * 撞到 HTTP 412/429 或风控 code 同样进熔断 —— 写操作被风控时继续硬闯最危险。
   * 返回解析后的 JSON（code 由调用方解释）；网络/解析失败返回 `{ code: -1, message }`。
   */
  async function post(input, body, headers = {}, opts = {}) {
    const url = new URL(input)
    const timeoutMs = Number(opts.timeoutMs) || 30000
    const banned = noCache() || !isBili(url.href) ? 0 : bannedUntil()
    if (banned) {
      return { code: -412, message: `HTTP 412 —— 本机被 B站 限流了，约 ${banLeftMinutes(banned)} 分钟后自动恢复（写操作先别硬闯）` }
    }
    try {
      await throttle()
      const payload = body instanceof URLSearchParams || typeof body === 'string' ? body.toString() : JSON.stringify(body ?? {})
      const headersOut = { ...headers, 'content-type': 'application/x-www-form-urlencoded' }
      const response = await fetchImpl(url.href, { method: 'POST', headers: headersOut, body: payload, signal: AbortSignal.timeout(timeoutMs) })
      if (isBili(url.href) && (response.status === 412 || response.status === 429)) {
        const prev = readJson(banFile, {})
        const streak = Number(prev.streak ?? 0) + 1
        const mins = Math.min(30, 5 * 2 ** (streak - 1))
        if (!noCache()) setBan(mins * 60_000, `HTTP ${response.status}`, { streak, endpoint: url.pathname })
        return { code: -412, message: `HTTP ${response.status}（B站 风控）—— 已熔断 ${mins} 分钟` }
      }
      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
        if (!data || typeof data !== 'object') throw new Error('invalid JSON payload')
      } catch {
        return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能被风控；别重试，先停手` }
      }
      if (isBili(url.href) && BAN_CODES.has(Number(data.code))) {
        const prev = readJson(banFile, {})
        const streak = Number(prev.streak ?? 0) + 1
        const mins = Math.min(30, 5 * 2 ** (streak - 1))
        if (!noCache()) writeJson(banFile, { until: now() + mins * 60_000, why: `code=${data.code}`, at: new Date(now()).toISOString(), streak, endpoint: url.pathname })
        return { ...data, message: `${data.message ?? ''}（B站 风控 ${data.code}）—— 已熔断 ${mins} 分钟` }
      }
      return data
    } catch (error) {
      const msg = error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message))
        ? '请求超时（30 秒）'
        : '请求失败（网络异常）'
      log(`B站 写请求失败：${url.pathname} —— ${error?.message ?? error}`)
      return { code: -1, message: msg }
    }
  }

  /** 取一段**非 JSON** 的原文（弹幕 XML 这种）：同样节流 + 熔断，不缓存 */
  async function getText(input, headers = {}, opts = {}) {
    const url = new URL(input)
    const banned = noCache() || !isBili(url.href) ? 0 : bannedUntil()
    if (banned) return { ok: false, status: 412, text: '', error: `HTTP 412 —— 本机被 B站 限流了，约 ${banLeftMinutes(banned)} 分钟后自动恢复` }
    try {
      await throttle()
      const res = await fetchImpl(url.href, { headers, signal: AbortSignal.timeout(Number(opts.timeoutMs) || 30000) })
      if (isBili(url.href) && (res.status === 412 || res.status === 429)) {
        const prev = readJson(banFile, {})
        const streak = Number(prev.streak ?? 0) + 1
        const mins = Math.min(30, 5 * 2 ** (streak - 1))
        if (!noCache()) setBan(mins * 60_000, `HTTP ${res.status}`, { streak, endpoint: url.pathname })
        return { ok: false, status: res.status, text: '', error: `HTTP ${res.status}（B站 风控）—— 已熔断 ${mins} 分钟` }
      }
      if (!res.ok) return { ok: false, status: res.status, text: '', error: `HTTP ${res.status}` }
      return { ok: true, status: res.status, text: await res.text() }
    } catch (e) {
      log(`B站 原文请求失败：${url.pathname} —— ${e?.message ?? e}`)
      return { ok: false, status: 0, text: '', error: `请求失败：${e?.message ?? e}` }
    }
  }

  /** 给诊断/排障看：现在是不是被熔断、缓存了几条 */
  function state() {
    const ban = readJson(banFile, {})
    const until = Number(ban.until ?? 0)
    return {
      banned: until > now(),
      banMinutesLeft: until > now() ? banLeftMinutes(until) : 0,
      banWhy: ban.why ?? null,
      cacheEntries: Object.keys(readJson(cacheFile, {})).length,
    }
  }

  return { get, post, getText, state, files: { cacheFile, banFile } }
}
