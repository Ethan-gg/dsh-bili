/**
 * src/lib/time.mjs —— 本地日历时间的两个小工具
 * ============================================================================
 * 为什么单独一个文件：`dayOf` 原来在生物钟里，闸门也要用同一套口径 ——
 * 两边各写一份的话，迟早出现"闸门按 UTC 算、生物钟按本地算"，跨午夜那天额度会多算或少算。
 *
 * 一律用**本地日历时间**（`toLocaleDateString('sv-SE')` 恰好就是 `YYYY-MM-DD`）。
 * 不用 `toISOString().slice(0,10)` —— 那是 UTC，东八区晚上 8 点以后会变成"明天"。
 * ============================================================================
 */

/** 本地日期 `YYYY-MM-DD` */
export const dayOf = (value = Date.now()) => new Date(value).toLocaleDateString('sv-SE')

/** 两个时刻相差几个**日历天**（今天 vs 昨天 = 1；同一天 = 0；未来为负） */
export function daysBetween(a, b = Date.now()) {
  const ta = Date.parse(a)
  const tb = typeof b === 'number' ? b : Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  const da = new Date(ta)
  const db = new Date(tb)
  // 抹掉时分秒，只比日历天（跨夏令时也不会差一小时）
  const ma = new Date(da.getFullYear(), da.getMonth(), da.getDate()).getTime()
  const mb = new Date(db.getFullYear(), db.getMonth(), db.getDate()).getTime()
  return Math.round((mb - ma) / 86_400_000)
}

/** ISO 时间安全解析：拿不到就 null（别用 `new Date(x)` 到处埋 NaN） */
export const parseTime = (v) => {
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}
