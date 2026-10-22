/**
 * src/bili/index.mjs —— M2 只读能力层（纯 Node，不需要 Python）
 * ============================================================================
 * 目标（方案 M2 第一刀）：把刷B站**只读**要用的三件事搬出 Python MCP ——
 *   `bili_search` / `bili_subtitle` / `bili_comments`。
 * 写入类（发评论 / 私信）**故意不搬**：风控风险高，仍走 Python MCP。
 *
 * 返回形状**逐字段对齐** `vendor/bilibili-mcp/mcp_server.py` 里那三个工具 ——
 * 这样提示词、状态卡、报告模板一个字都不用改（模型看到的还是同一份 JSON）。
 *
 * 三条从 whale 那边学来的实测口径：
 *   ① 搜索必须走 WBI 签名的 `/x/web-interface/wbi/search/type`（不签名会被拦）；
 *   ② AI 字幕必须走 WBI 版 `/x/player/wbi/v2` —— 旧端点给的 subtitle_url 缺 auth_key，
 *      下载会 403；而且 auth_key 是分钟级有效，拿到就得马上拉；
 *   ③ 评论接口的 `oid` 是 **aid** 不是 BV ⇒ 先用 `view?bvid=` 换一次。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBiliHttp, USER_AGENT } from './http.mjs'
import { mixinKey, signQuery } from './wbi.mjs'

const API = 'https://api.bilibili.com'
/** 搜索排序：只认这几种（认不出就退回综合） */
const SEARCH_ORDERS = new Set(['totalrank', 'click', 'pubdate', 'dm'])
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').trim()

/**
 * @param {object} p
 * @param {string} p.home                     插件家目录（凭证也在这儿）
 * @param {Function} [p.fetchImpl]            fetch（单测注入）
 * @param {() => number} [p.now]              时钟（单测注入）
 * @param {Function} [p.sleep]                节流等待（单测注入）
 * @param {(m:string)=>void} [p.log]
 */
export function createNodeBili({ home, fetchImpl, now, sleep, log = () => {} } = {}) {
  if (!home) throw new Error('createNodeBili 需要 home（插件家目录）')
  const clock = now || (() => Date.now())
  const http = createBiliHttp({ home, fetchImpl, now: clock, sleep, log })

  /** 读登录凭证（登录接口写的四个字段）；读不到就当匿名 */
  const cred = () => {
    try { return JSON.parse(readFileSync(join(home, 'bili_credential.json'), 'utf8')) } catch { return null }
  }
  const cookie = () => {
    const c = cred()
    if (!c?.sessdata) return ''
    return `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct ?? ''}; buvid3=${c.buvid3 ?? ''}`
  }
  const headers = (referer) => ({
    'user-agent': USER_AGENT,
    ...(referer ? { referer } : {}),
    ...(cookie() ? { cookie: cookie() } : {}),
  })
  const videoRef = (bvid) => `https://www.bilibili.com/video/${bvid}/`

  /** WBI 密钥缓存（9 分钟；nav 自己也会被 http 层缓存 10 分钟） */
  let keyCache = { at: 0, key: '' }
  async function wbiKey() {
    const t = clock()
    if (keyCache.key && t - keyCache.at < 9 * 60_000) return keyCache.key
    const nav = await http.get(`${API}/x/web-interface/nav`, headers('https://www.bilibili.com/'))
    if (Number(nav?.code) !== 0 || !nav?.data?.wbi_img) {
      throw new Error(`拿不到 WBI 密钥：${nav?.message ?? 'nav 请求失败'}`)
    }
    keyCache = { at: t, key: mixinKey(nav.data.wbi_img) }
    return keyCache.key
  }

  /** 登录态检查（形状同 Python 的 bili_check_credential） */
  async function whoami() {
    const nav = await http.get(`${API}/x/web-interface/nav`, headers('https://www.bilibili.com/'))
    if (Number(nav?.code) !== 0) throw new Error(`登录检查失败：${nav?.message ?? 'nav 请求失败'}`)
    const d = nav?.data ?? {}
    if (!d.isLogin) return { logged_in: false, message: '未登录（或凭证已过期）' }
    return { logged_in: true, uid: Number(d.mid) || 0, username: String(d.uname ?? ''), message: '凭证有效' }
  }

  /** 视频元信息（顺便拿到 aid / cid） */
  async function videoView(bvid) {
    const v = await http.get(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, headers(videoRef(bvid)))
    if (Number(v?.code) !== 0) throw new Error(`取视频信息失败 code=${v?.code} ${v?.message ?? ''}`.trim())
    return v.data ?? {}
  }

  /** 搜索（形状同 Python 的 bili_search） */
  async function search({ keyword, num = 10, order = 'totalrank' } = {}) {
    const kw = String(keyword ?? '').trim()
    if (!kw) throw new Error('关键词是空的')
    const n = Math.max(1, Math.min(Number(num) || 10, 50))
    const key = await wbiKey()
    const q = signQuery(
      { search_type: 'video', keyword: kw, page: 1, order: SEARCH_ORDERS.has(String(order)) ? String(order) : 'totalrank' },
      key, clock(),
    )
    const d = await http.get(`${API}/x/web-interface/wbi/search/type?${q}`, headers('https://search.bilibili.com/'))
    if (Number(d?.code) !== 0) throw new Error(`搜索接口失败 code=${d?.code} ${d?.message ?? ''}`.trim())
    const list = d?.data?.result ?? d?.data?.results ?? []
    const videos = (Array.isArray(list) ? list : []).slice(0, n).map((r) => ({
      bvid: String(r?.bvid ?? ''),
      aid: Number(r?.aid ?? 0),
      title: stripTags(r?.title),
      author: String(r?.author ?? ''),
      play: Number(r?.play ?? 0),
      review: Number(r?.review ?? 0),
      danmaku: Number(r?.video_review ?? 0),
      duration: String(r?.duration ?? ''),
      description: stripTags(r?.description).slice(0, 200),
    }))
    return { keyword: kw, count: videos.length, videos }
  }

  /** 热门评论（形状同 Python 的 bili_comments；抓取失败带 error，别伪装成"0 条评论"） */
  async function comments({ bvid, num = 30 } = {}) {
    const id = String(bvid ?? '').trim()
    if (!id) throw new Error('bvid 是空的')
    const n = Math.max(1, Math.min(Number(num) || 30, 50))
    const info = await videoView(id)
    const aid = info?.aid
    const rep = await http.get(`${API}/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${n}&pn=1`, headers(videoRef(id)))
    if (Number(rep?.code) !== 0) {
      return { bvid: id, count: 0, comments: [], error: `reply 失败 code=${rep?.code} ${rep?.message ?? ''}`.trim() }
    }
    const list = Array.isArray(rep?.data?.replies) ? rep.data.replies : []
    const out = list.slice(0, n).map((r) => {
      const c = {
        rpid: r?.rpid ?? 0,
        user: String(r?.member?.uname ?? ''),
        content: String(r?.content?.message ?? ''),
        like: Number(r?.like ?? 0),
        reply_count: Number(r?.rcount ?? 0),
        time: Number(r?.ctime ?? 0),
      }
      const subs = (Array.isArray(r?.replies) ? r.replies : []).slice(0, 2)
        .map((s) => ({ user: String(s?.member?.uname ?? ''), content: String(s?.content?.message ?? ''), like: Number(s?.like ?? 0) }))
      if (subs.length) c.top_replies = subs
      return c
    })
    return { bvid: id, count: out.length, comments: out }
  }

  /** 下载字幕 JSON（subtitle_url 带分钟级 auth_key，拿到就拉） */
  async function fetchSubtitleJson(url, bvid) {
    const f = fetchImpl || globalThis.fetch
    const res = await f(url, { headers: { 'user-agent': USER_AGENT, referer: videoRef(bvid) }, signal: AbortSignal.timeout(30000) })
    if (!res?.ok) throw new Error(`下载字幕失败 HTTP ${res?.status ?? '?'}（auth_key 分钟级过期，重试一次即可）`)
    const text = await res.text()
    try { return JSON.parse(text) } catch { return null }
  }

  /** 字幕（形状同 Python 的 bili_subtitle） */
  async function subtitle({ bvid } = {}) {
    const id = String(bvid ?? '').trim()
    if (!id) throw new Error('bvid 是空的')
    const info = await videoView(id)
    const cid = Number(info?.cid) || Number(info?.pages?.[0]?.cid) || 0
    if (!cid) return { error: '无法获取cid' }

    const key = await wbiKey()
    const p1 = await http.get(`${API}/x/player/wbi/v2?${signQuery({ bvid: id, cid }, key, clock())}`, headers(videoRef(id)))
    let subs = p1?.data?.subtitle?.subtitles ?? []
    if (!Array.isArray(subs) || !subs.length) {
      // 兜底：播放器实际调的那个端点（同样要登录 cookie）
      const ext = encodeURIComponent(JSON.stringify({ video_type: 1 }))
      const p2 = await http.get(`${API}/x/v2/subtitle/web/view?oid=${info?.aid}&pid=${info?.aid}` +
        `&context_ext=${ext}&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`, headers(videoRef(id)))
      subs = p2?.data?.subtitle?.subtitles ?? []
    }
    if (!Array.isArray(subs) || !subs.length) {
      return { bvid: id, title: String(info?.title ?? ''), message: '该视频没有字幕' }
    }
    const pick = subs.find((s) => s?.lan === 'ai-zh')
      ?? subs.find((s) => s?.lan === 'zh-CN')
      ?? subs.find((s) => String(s?.lan ?? '').startsWith('zh'))
      ?? subs[0]
    let url = String(pick?.subtitle_url ?? '')
    if (!url) return { bvid: id, title: String(info?.title ?? ''), message: '该视频没有字幕' }
    if (url.startsWith('//')) url = 'https:' + url
    const body = await fetchSubtitleJson(url, id)
    const texts = (Array.isArray(body?.body) ? body.body : []).map((x) => String(x?.content ?? '')).filter(Boolean)
    if (!texts.length) return { bvid: id, title: String(info?.title ?? ''), message: '该视频没有字幕' }
    return {
      bvid: id,
      title: String(info?.title ?? ''),
      language: String(pick?.lan_doc ?? pick?.lan ?? ''),
      segments: texts.length,
      text: texts.join('\n'),
    }
  }

  const METHODS = {
    bili_search: search,
    bili_subtitle: subtitle,
    bili_comments: comments,
    bili_check_credential: whoami,
  }

  return {
    search,
    subtitle,
    comments,
    whoami,
    /** 宿主按工具名统一路由（和 MCP 的 `call(name, args)` 对得上） */
    call(name, args = {}) {
      const fn = METHODS[name]
      if (!fn) throw new Error(`Node 能力层还不支持 ${name}（这条仍走 Python MCP）`)
      return fn(args)
    },
    state: () => http.state(),
  }
}
