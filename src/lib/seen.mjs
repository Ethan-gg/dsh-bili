/**
 * src/lib/seen.mjs —— 解析 `seen.md`（判重表）成「它刷过的视频」列表
 *
 * ⭐ 2026-10-23 修真 bug（用户：「有 15 条记录，看不到刷过的历史视频」）：
 *   设置页「它刷过的视频」调 `/api/bili-duty/watched`，那里读的是 `seen.md`。
 *   但解析器只认**老式 Markdown 表格** `| 日期 | bvid | 标题 | UP | 状态 |`，
 *   而 `duty.md` 早就要那一轮按**新的圆点格式**追加：
 *     `- 2026-10-23 · BV1xxx · 标题 · UP · 挑了（值得看）：… · https://…`
 *   ⇒ 一条都匹配不上 ⇒ 列表永远是"这一类还没有记录"。现在两种格式都认。
 */
const BV_RE = /^BV[0-9A-Za-z]{10}$/
const DAY_RE = /^(\d{4}-\d{2}-\d{2})/

/**
 * @param {string} text seen.md 全文
 * @returns {Array<{day:string,bvid:string,title:string,up:string,status:string,picked:boolean,commented:boolean,delivered:boolean,url:string}>}
 */
export function parseSeenTable(text) {
  const out = []
  const seen = new Set()
  const commentedDays = new Map()   // bvid -> day（「评论记录」表里的 BV）

  const push = (day, bvid, title, up, status) => {
    if (!BV_RE.test(bvid) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return
    const key = bvid + '@' + day
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      day, bvid, title, up, status,
      picked: status.includes('挑了'),
      commented: status.includes('评论'),
      delivered: /评论|私信|已发/.test(status),
      url: 'https://www.bilibili.com/video/' + bvid,
    })
  }

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    // ① 表格行：既可能是「评论记录」，也可能是老式「看过的视频」
    if (line.startsWith('|')) {
      const c = line.split('|').map((s) => s.trim()).slice(1, -1)
      if (c.length < 5) continue
      // 评论记录：| BV | rpid | root | 时间 | 正文 |
      if (BV_RE.test(c[0]) && DAY_RE.test(c[3] || '')) {
        commentedDays.set(c[0], (c[3].match(DAY_RE) || [])[1])
        continue
      }
      // 老式看过的视频：| 日期 | bvid | 标题 | UP | 状态 |
      if (DAY_RE.test(c[0] || '') && BV_RE.test(c[1] || '')) {
        push(c[0], c[1], c[2], c[3], c[4])
      }
      continue
    }

    // ② 现在的圆点行：- 日期 · BV · 标题 · UP · 状态 · 链接
    if (!line.startsWith('-')) continue
    const cells = line.replace(/^[-*]\s*/, '').split('·').map((s) => s.trim())
    const m = (cells[0] || '').match(DAY_RE)
    if (!m) continue
    const day = m[1]
    const i = cells.findIndex((x) => BV_RE.test(x))
    if (i < 0) continue                      // 「本轮额度已满…」这种汇总行没有 BV，跳过
    push(day, cells[i], cells[i + 1] || '', cells[i + 2] || '', cells[i + 3] || '')
  }

  // ③ 评论记录里出现过的视频 = 至少发过一次（评论/私信），补进 delivered
  for (const row of out) {
    if (!commentedDays.has(row.bvid)) continue
    row.delivered = true
    row.commented = true
    if (!row.status) row.status = '已评论'
  }

  out.sort((a, b) => (a.day === b.day ? (a.picked === b.picked ? 0 : a.picked ? -1 : 1) : (a.day < b.day ? 1 : -1)))
  return out
}
