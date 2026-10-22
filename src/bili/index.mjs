/**
 * src/bili/index.mjs —— M2 只读能力层（纯 Node，不需要 Python）
 * ============================================================================
 * 目标（方案 M2 第一刀）：把B站鱼娘**只读**要用的三件事搬出 Python MCP ——
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createBiliHttp, USER_AGENT } from './http.mjs'
import { mixinKey, signQuery } from './wbi.mjs'
import { parseDanmakuXml, summarizeDanmaku } from './danmaku.mjs'
import { findFfmpeg, runFfmpeg } from './ffmpeg.mjs'

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
 * @param {string} [p.ffmpegBin]              ffmpeg 路径（默认自动找；找不到就看画面这步跳过）
 * @param {Function} [p.runFfmpeg]            跑 ffmpeg（单测注入）
 * @param {Function} [p.findFfmpeg]           找 ffmpeg（单测注入；返回 null = 没装）
 * @param {(m:string)=>void} [p.log]
 */
export function createNodeBili({ home, fetchImpl, now, sleep, ffmpegBin, runFfmpeg: runFfmpegImpl, findFfmpeg: findFfmpegImpl, log = () => {} } = {}) {
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

  /* ───────────────────────── 写操作（M2 收尾）─────────────────────────
   * 发评论 / 发私信。形状与 Python MCP 对齐：成功 `{success:true,…}`、被 B站 拒 `{success:false,error,code}`。
   * 两条规矩：
   *   ① **网络/意外异常要往外抛**（宿主据此退回 Python MCP）；B站 明确的业务拒绝不抛（换 Python 也一样发不出去）
   *   ② 失败必须带 error，绝不允许"静默成功" —— 写操作最坏的不是发不出，是以为发出了
   */
  const REPLY_HINTS = {
    '-101': '账号未登录：cookie 失效', '-102': '账号被封停',
    '-111': 'csrf 校验失败：bili_jct 不对或与 SESSDATA 不是同一个号', '-509': '请求过于频繁',
    12015: '需要评论验证码（被风控盯上了，停手）', 12016: '内容含敏感信息',
    12035: '被 UP 主列入评论黑名单', 12051: '重复评论被判刷屏', 12002: '评论区已关闭',
  }
  const DM_HINTS = {
    '-101': '账号未登录', '-111': 'csrf 校验失败', '-509': '请求过于频繁',
    21007: '私信太长被拒（控制在 500 字符内）', 25004: '对方拒收 / 未互关',
  }
  const hintOf = (map, code) => map[String(code)] ?? ''

  /** 私信设备 ID：真浏览器里这个值是固定的；每次随机换等于"反复换设备"，反而更容易被风控 */
  function stableDevId() {
    const file = join(home, 'dev_id')
    try {
      const v = readFileSync(file, 'utf8').trim()
      if (/^WEB-[0-9A-F-]{20,}$/i.test(v)) return v
    } catch { /* 没有就造一个 */ }
    const v = 'WEB-' + randomUUID().toUpperCase()
    try { mkdirSync(home, { recursive: true }); writeFileSync(file, v + '\n', 'utf8') } catch (e) {
      throw new Error('无法保存私信设备 ID，已停止发送：' + String(e?.message ?? e))
    }
    return v
  }

  /** 发评论 / 回复评论（对应 Python 的 bili_reply） */
  async function reply({ bvid, text, rpid = 0, root = 0 } = {}) {
    const id = String(bvid ?? '').trim()
    const msg = String(text ?? '').trim()
    if (!msg) return { success: false, error: '评论正文是空的' }
    if (msg.length > 1000) return { success: false, error: `评论太长（${msg.length} 字，上限 1000）` }
    const c = cred()
    if (!c?.bili_jct) return { success: false, error: '没登录或缺 bili_jct：先扫码登录再发' }

    const info = await videoView(id)
    const aid = Number(info?.aid) || 0
    if (!aid) return { success: false, error: '拿不到 aid（视频信息没取到）' }
    const params = { type: 1, oid: String(aid), message: msg, plat: 1, csrf: String(c.bili_jct) }
    if (Number(rpid)) { params.parent = String(Number(rpid)); params.root = String(Number(root) || Number(rpid)) }
    const key = await wbiKey()
    const body = new URLSearchParams(params)
    // 签名只放 query（w_rid/wts），参数本体走 form body —— 这是实测能过的发法
    const d = await http.post(`${API}/x/v2/reply/add?${signQuery(params, key, clock())}`, body, headers(videoRef(id)))
    if (Number(d?.code) === -1) throw new Error(d?.message ?? '网络失败')     // 交给宿主退回 MCP
    if (Number(d?.code) === 0) {
      const rpidOut = d?.data?.rpid_str ?? d?.data?.rpid ?? ''
      return { success: true, message: '评论发送成功', ...(rpidOut ? { rpid: String(rpidOut) } : {}) }
    }
    const hint = hintOf(REPLY_HINTS, d?.code)
    return {
      success: false,
      code: d?.code,
      error: hint ? `${hint}（code=${d?.code}）` : `发送失败 code=${d?.code} ${d?.message ?? ''}`.trim(),
    }
  }

  /** 发私信（对应 Python 的 bili_send_message） */
  async function sendMessage({ receiver_uid, text } = {}) {
    const toMid = Number(receiver_uid) || 0
    const msg = String(text ?? '').trim()
    if (!toMid) return { success: false, error: 'receiver_uid 无效' }
    if (!msg) return { success: false, error: 'text 不能为空' }
    if (msg.length > 500) return { success: false, error: `私信太长（${msg.length} 字，B站 约 500 字符上限，会被 code 21007 拒）` }
    const c = cred()
    if (!c?.bili_jct) return { success: false, error: '没登录或缺 bili_jct：先扫码登录再发' }

    const nav = await http.get(`${API}/x/web-interface/nav`, headers('https://www.bilibili.com/'))
    const sender = Number(nav?.data?.mid) || 0
    if (Number(nav?.code) !== 0 || !nav?.data?.isLogin || !sender) {
      return { success: false, error: '登录态无效（nav 说没登录，或凭证已过期）' }
    }
    const body = new URLSearchParams()
    body.set('msg[sender_uid]', String(sender))
    body.set('msg[receiver_id]', String(toMid))
    body.set('msg[receiver_type]', '1')
    body.set('msg[msg_type]', '1')
    body.set('msg[msg_status]', '0')
    body.set('msg[timestamp]', String(Math.floor(clock() / 1000)))
    body.set('msg[dev_id]', stableDevId())
    body.set('msg[content]', JSON.stringify({ content: msg }))
    body.set('csrf', String(c.bili_jct))
    const d = await http.post('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', body, headers('https://www.bilibili.com/'))
    if (Number(d?.code) === -1) throw new Error(d?.message ?? '网络失败')
    if (Number(d?.code) === 0) return { success: true, message: `私信已发送给UID:${toMid}`, data: d?.data ?? null }
    const hint = hintOf(DM_HINTS, d?.code)
    return {
      success: false,
      code: d?.code,
      error: hint ? `${hint}（code=${d?.code}）` : `发送失败 code=${d?.code} ${d?.message ?? ''}`.trim(),
    }
  }

  /* ───────────────────── 评论监听用的只读接口 ───────────────────── */

  /**
   * 「回复我的」收件箱（只读）：评论监听的数据源。
   * ⚠️ 收件箱字段语义不可靠（whale 实测：`item.title` 不总是新回复正文）——
   * 这里把 target/source/title 依次兜底，正文只当"摘要"，真判断前让 agent 自己读楼层。
   */
  async function replyFeed({ pages = 2 } = {}) {
    const out = []
    let cursor = ''
    let lastViewAt = 0
    for (let p = 0; p < Math.max(1, Math.min(3, Number(pages) || 2)); p += 1) {
      const u = `${API}/x/msgfeed/reply?platform=web&build=0&mobi_app=web` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
      const j = await http.get(u, headers('https://www.bilibili.com/'))
      if (Number(j?.code) !== 0) throw new Error(`回复收件箱拉取失败 code=${j?.code} ${j?.message ?? ''}`)
      if (p === 0) lastViewAt = Number(j?.data?.last_view_at ?? 0)
      const items = j?.data?.items ?? []
      for (const it of items) {
        out.push({
          id: String(it?.id ?? ''),
          at: Number(it?.reply_time ?? it?.at_time ?? 0),
          who: String(it?.user?.nickname ?? ''),
          mid: String(it?.user?.mid ?? ''),
          business: Number(it?.item?.business_id ?? 1),
          oid: String(it?.item?.subject_id ?? ''),
          root: String(it?.item?.root_id ?? ''),
          parent: String(it?.item?.source_id ?? ''),
          text: String(it?.item?.target_reply_content || it?.item?.source_content || it?.item?.title || '').slice(0, 500),
        })
      }
      cursor = String(j?.data?.cursor ?? '')
      if (!cursor || items.length === 0) break
    }
    const seen = new Set()
    return { items: out.filter((x) => x.id && (seen.has(x.id) ? false : (seen.add(x.id), true))), lastViewAt }
  }

  /** aid → bvid（评论监听拿到 oid 后要用 bvid 调 bili_reply / bili_draft） */
  async function bvidByAid(aid) {
    const a = Number(aid)
    if (!a) return ''
    const j = await http.get(`${API}/x/web-interface/view?aid=${a}`, headers('https://www.bilibili.com/'))
    return String(j?.data?.bvid ?? '')
  }

  /* ───────────────────── 看弹幕 / 看画面（M2 最后一块）───────────────────── */

  /** 弹幕：热区 + 高频梗 + 抽样（只读；没有弹幕就返回 count=0，不是错） */
  async function danmaku({ bvid } = {}) {
    const id = String(bvid ?? '').trim()
    if (!id) throw new Error('bvid 是空的')
    const info = await videoView(id)
    const cid = Number(info?.cid) || Number(info?.pages?.[0]?.cid) || 0
    if (!cid) return { bvid: id, count: 0, error: '无法获取cid' }
    const r = await http.getText(`${API}/x/v1/dm/list.so?oid=${cid}`, headers(videoRef(id)))
    if (!r.ok) {
      return { bvid: id, title: String(info?.title ?? ''), count: 0, heat: [], top: [], sample: [], error: `弹幕拉取失败：${r.error}` }
    }
    const list = parseDanmakuXml(r.text)
    return {
      bvid: id,
      title: String(info?.title ?? ''),
      duration: Number(info?.duration) || 0,
      ...summarizeDanmaku(list, { duration: Number(info?.duration) || 0 }),
    }
  }

  /**
   * 抽帧看画面（纯画面/无声视频用）。**ffmpeg 可选**：没装就直接说跳过，不算错。
   * @param {{bvid:string, times?:number[], max?:number}} args
   */
  async function frames({ bvid, times, max = 4 } = {}) {
    const id = String(bvid ?? '').trim()
    if (!id) throw new Error('bvid 是空的')
    const info = await videoView(id)
    const title = String(info?.title ?? '')
    const bin = ffmpegBin || (findFfmpegImpl || findFfmpeg)()
    if (!bin) return { ok: false, bvid: id, title, message: '这台机器没装 ffmpeg —— 看画面这步跳过（只用字幕/弹幕判断就行）' }

    const cid = Number(info?.cid) || Number(info?.pages?.[0]?.cid) || 0
    if (!cid) return { ok: false, bvid: id, title, error: '无法获取cid' }
    const key = await wbiKey()
    const q = signQuery({ bvid: id, cid, qn: 64, fnval: 1, fourk: 0, platform: 'pc' }, key, clock())
    const pu = await http.get(`${API}/x/player/wbi/playurl?${q}`, headers(videoRef(id)))
    if (Number(pu?.code) !== 0) return { ok: false, bvid: id, title, error: `拿不到播放地址 code=${pu?.code} ${pu?.message ?? ''}`.trim() }
    const url = pu?.data?.durl?.[0]?.url
      || pu?.data?.dash?.video?.[0]?.baseUrl
      || pu?.data?.dash?.video?.[0]?.base_url
      || ''
    if (!url) return { ok: false, bvid: id, title, error: '播放地址里没有可抽帧的 url' }

    const dur = Number(info?.duration) || 0
    const wanted = Array.isArray(times) && times.length
      ? times.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      : [Math.max(1, Math.round(dur * 0.15)), Math.max(1, Math.round(dur * 0.5)), Math.max(1, Math.round(dur * 0.85))]
    const list = wanted.slice(0, Math.max(1, Math.min(6, Number(max) || 4)))
    const dir = join(home, 'tmp', 'frames')
    mkdirSync(dir, { recursive: true })
    const out = []
    for (const t of list) {
      const file = join(dir, `${id}-${Math.round(t)}.jpg`)
      const args = [
        '-y', '-ss', String(t),
        '-headers', `Referer: ${videoRef(id)}\r\nUser-Agent: ${USER_AGENT}\r\n`,
        '-i', url, '-frames:v', '1', '-q:v', '3', file,
      ]
      const r = await (runFfmpegImpl || runFfmpeg)(bin, args)
      out.push({ at: Math.round(t), ok: Boolean(r?.ok), path: r?.ok ? file : null, ...(r?.ok ? {} : { error: String(r?.stderr ?? '').slice(-200) }) })
    }
    return { ok: out.some((x) => x.ok), bvid: id, title, frames: out }
  }

  const METHODS = {
    bili_search: search,
    bili_subtitle: subtitle,
    bili_comments: comments,
    bili_check_credential: whoami,
    bili_reply: reply,
    bili_send_message: sendMessage,
    bili_danmaku: danmaku,
    bili_frames: frames,
  }

  return {
    search,
    subtitle,
    comments,
    whoami,
    reply,
    sendMessage,
    danmaku,
    frames,
    replyFeed,
    bvidByAid,
    /** 宿主按工具名统一路由（和 MCP 的 `call(name, args)` 对得上） */
    call(name, args = {}) {
      const fn = METHODS[name]
      if (!fn) throw new Error(`Node 能力层还不支持 ${name}（这条仍走 Python MCP）`)
      return fn(args)
    },
    state: () => http.state(),
  }
}
