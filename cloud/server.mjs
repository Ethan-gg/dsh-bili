#!/usr/bin/env node
/**
 * cloud/server.mjs —— 云桥参考云端（协议 v1，零依赖）
 * ============================================================================
 * 方案 §6.7：「云端只实现一个 HTTP 端点」。这个文件就是那个端点的一份**参考实现**，
 * 给两种人用：
 *   ① 想自己搭云端的人：照它接协议（`src/sync/contract.md`），不用读插件代码；
 *   ② 调试插件的人：本机起一个，`sync.transport='http'` 指过来，就能把"出站→云端→入站→叫醒她"
 *      整条链跑通（不用真的 IM 机器人）。
 *
 * 它只做三件事：
 *   · `POST /sync/v1/events`   —— 收插件出站事件：验 HMAC、按 id 幂等去重、落 `data/events.jsonl`
 *   · `POST /sync/v1/inbound`  —— 运维/IM 桥接方把消息**推进来**：用同一把密钥签名后转发给插件
 *                                 的 `/api/bili-duty/sync/inbound`（方案里的"推模式"）
 *   · `GET  /sync/v1/events`   —— 排障用：按时间读回已收事件
 *
 * 环境变量：
 *   CLOUD_SECRET          必填，与插件 `~/.dsh/bili/sync/secret` 里那把**完全一样**
 *   PLUGIN_INBOUND_URL    必填，插件的入站地址，例如 http://127.0.0.1:5803/api/bili-duty/sync/inbound
 *   PORT                  监听端口，默认 8791（只绑 127.0.0.1）
 *   DATA_DIR              落盘目录，默认 ./data
 *
 * ⚠️ 这是**参考实现，不是生产服务**：没有鉴权后台、没有 TLS、没有多租户。
 *    真要对外，放在反代后面，别把 CLOUD_SECRET 写进前端。
 * ============================================================================
 */
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEvent, validateEnvelope, verifySignature } from '../src/sync/protocol.mjs'

const MAX_BODY = 1_000_000

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > MAX_BODY) { data = ''; req.destroy() } })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}
const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * @param {{secret:string, pluginInboundUrl:string, dataDir?:string, port?:number, host?:string}}
 */
export function createCloud({ secret, pluginInboundUrl, dataDir = join(process.cwd(), 'data'), port = 8791, host = '127.0.0.1' } = {}) {
  if (!secret || secret.length < 32) throw new Error('CLOUD_SECRET 必填（至少 32 字符，跟插件 sync/secret 一致）')
  if (!pluginInboundUrl) throw new Error('PLUGIN_INBOUND_URL 必填（插件的 /api/bili-duty/sync/inbound）')
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'events.jsonl')

  /** id → 收下时间（幂等去重；这份是内存索引，重启从文件重建） */
  const seen = new Map()
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const x = JSON.parse(line); if (x?.event?.id) seen.set(x.event.id, x.receivedAt) } catch { /* 坏行跳过 */ }
    }
  }

  let server
  const handle = async (req, res) => {
    const url = new URL(req.url, `http://${host}`)
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, seen: seen.size })

    // 收插件出站
    if (req.method === 'POST' && url.pathname === '/sync/v1/events') {
      const env = await readBody(req)
      if (!env) return json(res, 400, { ok: false, error: 'body 不是 JSON' })
      const shape = validateEnvelope(env, { now: new Date(), replayWindowMin: 10 })
      if (!shape.ok) return json(res, 400, { ok: false, error: '信封形状不对：' + shape.reason })
      if (!verifySignature(env, secret)) return json(res, 401, { ok: false, error: '签名不对（CLOUD_SECRET 和插件那把不一致？）' })
      if (seen.has(env.id)) return json(res, 200, { ok: true, remoteId: env.id, dup: true })
      const receivedAt = new Date().toISOString()
      seen.set(env.id, receivedAt)
      appendFileSync(file, JSON.stringify({ receivedAt, event: env }) + '\n', 'utf8')
      return json(res, 200, { ok: true, remoteId: env.id })
    }

    // 把消息推进插件（IM 桥接方 / 运维手工调用都走这里）
    if (req.method === 'POST' && url.pathname === '/sync/v1/inbound') {
      const body = await readBody(req)
      if (!body || !body.type) return json(res, 400, { ok: false, error: '需要 {type, payload}' })
      const env = makeEvent({ type: String(body.type), payload: body.payload ?? {}, secret, from: 'cloud' })
      let r
      try {
        const res2 = await fetch(pluginInboundUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([env]),
          signal: AbortSignal.timeout(10_000),
        })
        const text = await res2.text()
        let parsed = null
        try { parsed = JSON.parse(text) } catch { /* 插件可能回非 JSON */ }
        r = { ok: res2.ok, status: res2.status, plugin: parsed }
      } catch (e) {
        r = { ok: false, error: String(e?.message ?? e) }
      }
      return json(res, r.ok ? 200 : 502, { ...r, eventId: env.id })
    }

    // 排障：读回事件
    if (req.method === 'GET' && url.pathname === '/sync/v1/events') {
      const since = url.searchParams.get('since') || ''
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      const out = []
      if (existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            const x = JSON.parse(line)
            if (!since || String(x.receivedAt) > since) out.push(x)
            if (out.length >= limit) break
          } catch { /* 坏行跳过 */ }
        }
      }
      return json(res, 200, { ok: true, count: out.length, events: out })
    }

    return json(res, 404, { ok: false, error: '没有这个端点' })
  }

  server = createServer((req, res) => {
    handle(req, res).catch((e) => { try { json(res, 500, { ok: false, error: String(e?.message ?? e) }) } catch { /* 已经关了 */ } })
  })

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => resolve(server.address().port))
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    get port() { return server.address()?.port ?? null },
    file,
  }
}

/* ── CLI：node cloud/server.mjs ─────────────────────────────────────────── */
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  try {
    const secret = String(process.env.CLOUD_SECRET ?? '').trim()
    const pluginInboundUrl = String(process.env.PLUGIN_INBOUND_URL ?? '').trim()
    const dataDir = String(process.env.DATA_DIR ?? join(process.cwd(), 'data'))
    const port = Number(process.env.PORT ?? 8791)
    const cloud = createCloud({ secret, pluginInboundUrl, dataDir, port })
    const p = await cloud.listen()
    console.log(`云桥参考云端已开：http://127.0.0.1:${p}`)
    console.log(`  收事件：POST /sync/v1/events   推入站：POST /sync/v1/inbound   排障：GET /sync/v1/events`)
    console.log(`  插件入站地址：${pluginInboundUrl}`)
    console.log(`  落盘：${cloud.file}`)
  } catch (e) {
    console.error('起不来：' + String(e?.message ?? e))
    process.exit(1)
  }
}
