/**
 * src/sync/transport/http.mjs —— 云桥 HTTP 传输（出站 POST + 入站由插件路由推入）
 * ============================================================================
 * 方案 §6.7 的"云端只实现一个 HTTP 端点"：
 *   · 出站：`POST <endpoint>/sync/v1/events`，body 就是一个签名信封
 *   · 入站：云端反过来 `POST <本机 DSH 地址>/api/bili-duty/sync/inbound`（由 index.js 的路由接着，
 *     校验签名后喂 `bridge.ingest()`）—— 所以本传输的 `poll()` 永远空，不重复拉。
 *
 * 为什么不在 `poll()` 里做长轮询：云端接口还没定；先把"能收能发"的最小闭环做出来，
 * 云端实现方只要读 `src/sync/contract.md`。
 * ============================================================================
 */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * @param {object} p
 * @param {object} p.config                    整份配置（读 config.sync.endpoint）
 * @param {Function} [p.fetchImpl]             fetch（单测注入）
 */
export function createHttpTransport({ config, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const s = config?.sync ?? {}
  return {
    name: 'http',
    capabilities: () => ({ inbound: true, outbound: true, threads: false, maxText: 4000 }),

    async send(env) {
      const base = String(s.endpoint ?? '').trim()
      if (!base) return { ok: false, error: '云桥还没填云端地址（endpoint，形如 https://your-host）' }
      const url = base.replace(/\/+$/, '') + '/sync/v1/events'
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(env),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        })
        if (!res?.ok) return { ok: false, error: `云端回 HTTP ${res?.status ?? '?'}` }
        let j = null
        try { j = await res.json() } catch { /* 云端可以不回 JSON */ }
        return { ok: true, remoteId: j?.remoteId }
      } catch (e) {
        return { ok: false, error: `请求云端失败：${e?.message ?? e}` }
      }
    },

    /** 入站是 push 路（见 index.js），这里永远空 —— 别两边都收一遍 */
    async poll() { return { events: [], cursor: '' } },
  }
}
