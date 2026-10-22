/**
 * src/sync/transport/file.mjs —— 文件传输（默认实现，零依赖）
 * ============================================================================
 * 它存在的意义：**云端还没开发，但我们不想等它**。
 *
 *   · 出站 → 追加一行到 `sync/outbox.jsonl`
 *   · 入站 → 从 `sync/inbox.jsonl` 按**行偏移**读（游标 = 已消费行数）
 *
 * 于是今天就能做端到端测试：手写一行进 inbox，看她会不会被叫醒；
 * 她写出来的东西落在 outbox，人工看一眼就知道对不对。
 * 云端开发完之后，只要再写一个 `http.mjs` 实现同样的三个方法，别的代码一个字都不用改。
 *
 * 为什么游标用"行号"而不是时间戳/事件 id：
 *   行号是文件里唯一**单调且不重复**的东西；时间戳会撞（同一毫秒两条），
 *   事件 id 又不能定位"从哪儿继续读"。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { decode, line } from '../protocol.mjs'

const ensureDir = (f) => { try { mkdirSync(dirname(f), { recursive: true }) } catch { /* 交给 append 报 */ } }

/** 只算"完整的行"：末尾没有换行的那半行是别人正在写，不算数 */
export function completeLines(text) {
  const s = String(text)
  const cut = s.lastIndexOf('\n')
  if (cut < 0) return []
  return s.slice(0, cut).split('\n')
}

export function createFileTransport({ outbox, inbox, cap = 5000 } = {}) {
  if (!outbox || !inbox) throw new Error('file transport 需要 outbox 与 inbox 路径')
  return {
    name: 'file',

    capabilities() {
      return { inbound: true, outbound: true, threads: false, maxText: 4000 }
    },

    /** 落一行。失败要把原因带出去 —— 静默丢消息比报错糟得多。 */
    async send(event) {
      try {
        ensureDir(outbox)
        appendFileSync(outbox, line(event), 'utf8')
        return { ok: true, remoteId: event.id }
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) }
      }
    },

    /**
     * 从游标处往后读。`cursor` 是"已经消费了多少条完整行"。
     * 返回 `{ events, cursor, bad }`：`bad` 是解析不了的行数（诊断用，别当成"没有新消息"）。
     */
    async poll(cursor = 0) {
      const from = Math.max(0, Number(cursor) || 0)
      let text = ''
      try {
        if (!existsSync(inbox)) return { events: [], cursor: String(from), bad: 0 }
        text = readFileSync(inbox, 'utf8')
      } catch (e) {
        return { events: [], cursor: String(from), bad: 0, error: String(e?.message ?? e) }
      }
      const lines = completeLines(text)
      const total = lines.length
      // 文件被截断/换了 → 游标越界时从 0 重来，而不是永远读不到
      const start = from > total ? 0 : from
      const slice = lines.slice(start, start + Math.max(1, cap))
      const events = []
      let bad = 0
      for (const raw of slice) {
        if (!raw.trim()) continue
        const env = decode(raw)
        if (!env) { bad += 1; continue }
        events.push(env)
      }
      return { events, cursor: String(start + slice.length), bad }
    },
  }
}
