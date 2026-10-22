/**
 * src/bili/danmaku.mjs —— 视频弹幕（只读）：热区 + 高频梗 + 抽样
 * ============================================================================
 * 「看弹幕」是判断"这条值不值得看"的第二双眼睛：字幕看说了什么，弹幕看**大家在哪一段兴奋**
 * （一门课 6 分钟没人发弹幕 vs 全程高能，结论完全不同）。
 *
 * 接口用老 XML 端点（实测 2026-10-22 还能用、且 Node fetch 会自动解 deflate）：
 *   `GET https://api.bilibili.com/x/v1/dm/list.so?oid=<cid>`
 * 返回 `<d p="出现秒,模式,字号,颜色,时间戳,池,uid,dmid">正文</d>`。
 * 不用 `/x/v2/dm/web/seg.so`（protobuf，得为它写解码器；XML 足够做热区统计）。
 * ============================================================================
 */

const ENTITIES = [
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&apos;', "'"],
]
const unescape = (s) => ENTITIES.reduce((acc, [a, b]) => acc.split(a).join(b), String(s ?? ''))

/**
 * 解析 list.so 的 XML。
 * @param {string} xml
 * @returns {{at:number, text:string, mode:number, color:number}[]}
 */
export function parseDanmakuXml(xml) {
  const out = []
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(String(xml ?? ''))) !== null) {
    const parts = m[1].split(',')
    const at = Number(parts[0])
    if (!Number.isFinite(at) || at < 0) continue
    const text = unescape(m[2]).replace(/\s+/g, ' ').trim()
    if (!text) continue
    out.push({ at, text, mode: Number(parts[1]) || 0, color: Number(parts[3]) || 0 })
  }
  return out
}

/**
 * 把弹幕列表压成"热区 + 高频梗 + 抽样"。
 * @param {{at:number,text:string}[]} list
 * @param {{duration?:number, buckets?:number, topN?:number, sampleN?:number, windowSec?:number}} [opts]
 */
export function summarizeDanmaku(list, { duration = 0, buckets = 24, topN = 10, sampleN = 12 } = {}) {
  const items = Array.isArray(list) ? list : []
  const total = items.length
  const dur = Number(duration) > 0 ? Number(duration) : Math.max(1, ...items.map((x) => Number(x.at) || 0))
  const n = Math.max(1, Math.min(120, Math.floor(Number(buckets) || 24)))
  const step = Math.max(1, Math.ceil(dur / n))
  const heat = Array.from({ length: n }, (_, i) => ({ from: i * step, to: Math.min(dur, (i + 1) * step), count: 0 }))
  for (const x of items) {
    const i = Math.min(n - 1, Math.max(0, Math.floor(Number(x.at) / step)))
    heat[i].count += 1
  }
  const freq = new Map()
  for (const x of items) freq.set(x.text, (freq.get(x.text) ?? 0) + 1)
  const top = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, topN))
    .map(([text, count]) => ({ text, count }))
  const hot = [...heat].sort((a, b) => b.count - a.count).slice(0, 3).filter((x) => x.count > 0)
  const sample = [...items].sort((a, b) => b.at - a.at).slice(0, Math.max(0, sampleN))
    .map((x) => ({ at: Math.round(x.at), text: x.text.slice(0, 80) }))
  return { count: total, duration: dur, heat, hot, top, sample }
}
