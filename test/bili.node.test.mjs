/**
 * Node 能力层单测：search / subtitle / comments / whoami / reply / send_message
 * （形状必须与 vendor/bilibili-mcp/mcp_server.py 对应的工具逐字段对齐）
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeBili } from '../src/bili/index.mjs'

const img = (stem) => `https://i0.hdslb.com/bfs/wbi/20241022/${stem}.png`
const NAV = { code: 0, data: { wbi_img: { img_url: img('a'.repeat(32)), sub_url: img('b'.repeat(32)) } } }
const okRes = (body) => (body && body.__raw !== undefined
  ? { ok: true, status: 200, text: async () => body.__raw }
  : { ok: true, status: 200, text: async () => JSON.stringify(body) })

/** 按路径把假响应排成一张表；顺带记住每次请求的 URL / headers */
function setup(routes, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bili-node-'))
  mkdirSync(join(home, '.cache'), { recursive: true })
  writeFileSync(join(home, 'bili_credential.json'), JSON.stringify({ sessdata: 'S', bili_jct: 'J', buvid3: 'B' }), 'utf8')
  const calls = []
  const nowMs = Date.parse('2026-10-22T18:00:00+08:00')
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url))
    const headers = init?.headers || {}
    calls.push({ u, headers, init })
    for (const [match, body] of routes) if (match(u)) return okRes(body)
    if (u.pathname.endsWith('/nav')) return okRes(NAV)
    throw new Error('unexpected URL: ' + u.href)
  }
  const bili = createNodeBili({ home, fetchImpl, now: () => nowMs, sleep: async () => {}, log: () => {}, ...opts })
  return { bili, calls, home }
}

const isView = (u) => u.pathname.endsWith('/view') || u.pathname.endsWith('/wbi/view')

test('search：走 WBI 签名的 wbi/search/type，返回形状与 Python 版一致', async () => {
  const { bili, calls } = setup([
    [isView, { code: 0, data: { bvid: 'x' } }],
    [(u) => u.pathname.endsWith('/wbi/search/type'), {
      code: 0,
      data: { result: [{
        bvid: 'BV1xx411c7mD', aid: 11, title: '<em class="keyword">DSH</em> 插件',
        author: '某UP', play: 1234, review: 5, video_review: 6, duration: '03:21',
        description: '<b>简介</b>',
      }] },
    }],
  ])
  const r = await bili.search({ keyword: 'DSH', num: 5, order: 'click' })
  assert.equal(r.keyword, 'DSH')
  assert.equal(r.count, 1)
  const v = r.videos[0]
  assert.deepEqual(v, {
    bvid: 'BV1xx411c7mD', aid: 11, title: 'DSH 插件', author: '某UP',
    play: 1234, review: 5, danmaku: 6, duration: '03:21', description: '简介',
  })
  const call = calls.find((c) => c.u.pathname.endsWith('/wbi/search/type'))
  const sp = call.u.searchParams
  assert.equal(sp.get('search_type'), 'video')
  assert.equal(sp.get('keyword'), 'DSH')
  assert.equal(sp.get('order'), 'click')
  assert.ok(sp.get('wts'), '要带 wts')
  assert.match(sp.get('w_rid'), /^[0-9a-f]{32}$/, '要带 w_rid')
  assert.match(String(call.headers.cookie), /SESSDATA=S/, '要带登录 cookie')
})

test('search：接口报错要抛（让宿主能退回 MCP），不能返回空列表当"没搜到"', async () => {
  const { bili } = setup([[(u) => u.pathname.endsWith('/wbi/search/type'), { code: -400, message: '请求错误' }]])
  await assert.rejects(bili.search({ keyword: 'x' }), /搜索接口失败 code=-400/)
})

test('comments：先 view 换 aid，再拉热度序；形状与 Python 版一致', async () => {
  const { bili, calls } = setup([
    [isView, { code: 0, data: { bvid: 'BV1xx411c7mD', title: 'T', aid: 42, cid: 9 } }],
    [(u) => u.pathname.endsWith('/x/v2/reply'), {
      code: 0,
      data: { replies: [{
        rpid: 7, member: { uname: '小明' }, content: { message: '你好' }, like: 3, rcount: 1, ctime: 1700000000,
        replies: [{ member: { uname: '阿花' }, content: { message: '+1' }, like: 1 }],
      }] },
    }],
  ])
  const r = await bili.comments({ bvid: 'BV1xx411c7mD', num: 5 })
  assert.equal(r.bvid, 'BV1xx411c7mD')
  assert.equal(r.count, 1)
  assert.deepEqual(r.comments[0], {
    rpid: 7, user: '小明', content: '你好', like: 3, reply_count: 1, time: 1700000000,
    top_replies: [{ user: '阿花', content: '+1', like: 1 }],
  })
  const reply = calls.find((c) => c.u.pathname.endsWith('/x/v2/reply'))
  assert.equal(reply.u.searchParams.get('oid'), '42', 'oid 必须是 aid 不是 BV')
  assert.equal(reply.u.searchParams.get('sort'), '2', 'sort=2 才是热度序')
})

test('subtitle：WBI 版 player/v2 拿轨道 → 下载 → 拼成全文；形状与 Python 版一致', async () => {
  const { bili, calls } = setup([
    [isView, { code: 0, data: { bvid: 'BV1', aid: 1, cid: 9, title: '标题' } }],
    [(u) => u.pathname.endsWith('/x/player/wbi/v2'), {
      code: 0,
      data: { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（AI）', subtitle_url: '//aisubtitle.hdslb.com/sub.json' }] } },
    }],
    [(u) => u.hostname === 'aisubtitle.hdslb.com', { body: [{ content: '你好' }, { content: '世界' }] }],
  ])
  const r = await bili.subtitle({ bvid: 'BV1' })
  assert.equal(r.title, '标题')
  assert.equal(r.language, '中文（AI）')
  assert.equal(r.segments, 2)
  assert.equal(r.text, '你好\n世界')
  const player = calls.find((c) => c.u.pathname.endsWith('/x/player/wbi/v2'))
  assert.equal(player.u.searchParams.get('cid'), '9')
  assert.ok(player.u.searchParams.get('w_rid'), 'player 也要 WBI 签名')
})

test('subtitle：没有字幕时返回 {message}，而不是抛错（那种是正常结果）', async () => {
  const { bili } = setup([
    [isView, { code: 0, data: { bvid: 'BV1', aid: 1, cid: 9, title: '标题' } }],
    [(u) => u.pathname.endsWith('/x/player/wbi/v2'), { code: 0, data: { subtitle: { subtitles: [] } } }],
    [(u) => u.pathname === '/x/v2/subtitle/web/view', { code: 0, data: { subtitle: { subtitles: [] } } }],
  ])
  const r = await bili.subtitle({ bvid: 'BV1' })
  assert.equal(r.message, '该视频没有字幕')
})

test('whoami：nav 登录态映射成 Python 版 bili_check_credential 的形状', async () => {
  const on = setup([[() => true, { code: 0, data: { isLogin: true, mid: 123, uname: '小明' } }]])
  // routes 先匹配 → nav 也走 route（setup 里的默认 NAV 只在没匹配时兜底）
  const a = await on.bili.call('bili_check_credential', {})
  assert.equal(a.logged_in, true)
  assert.equal(a.uid, 123)
  assert.equal(a.username, '小明')

  const off = setup([[() => true, { code: 0, data: { isLogin: false } }]])
  const b = await off.bili.whoami()
  assert.equal(b.logged_in, false)
  assert.match(b.message, /未登录/)
})

test('reply：WBI 签名 + csrf + parent/root 都带上；成功回 rpid，B站 拒了要带 code/error', async () => {
  const { bili, calls } = setup([
    [isView, { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 42, title: 'T' } }],
    [(u) => u.pathname.endsWith('/x/v2/reply/add'), { code: 0, data: { rpid: 99, rpid_str: '99' } }],
  ])
  const r = await bili.call('bili_reply', { bvid: 'BV1xx411c7mD', text: '你好呀', rpid: 7 })
  assert.equal(r.success, true)
  assert.equal(r.rpid, '99')
  const call = calls.find((c) => c.u.pathname.endsWith('/x/v2/reply/add'))
  assert.equal(call.init.method, 'POST')
  assert.ok(call.u.searchParams.get('w_rid'), '要 WBI 签名')
  assert.ok(call.u.searchParams.get('wts'))
  const body = String(call.init.body)
  assert.match(body, /oid=42/)
  assert.match(body, /csrf=J/)
  assert.match(body, /message=%E4%BD%A0%E5%A5%BD/)
  assert.match(body, /parent=7/)
  assert.match(body, /root=7/)
  assert.match(String(call.init.headers.cookie), /SESSDATA=S/)

  // 风控/CSRF 拒绝：不抛，回 success:false + 人话提示
  const bad = setup([
    [isView, { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 42 } }],
    [(u) => u.pathname.endsWith('/x/v2/reply/add'), { code: -111, message: 'csrf 校验失败' }],
  ])
  const r2 = await bad.bili.reply({ bvid: 'BV1xx411c7mD', text: '你好' })
  assert.equal(r2.success, false)
  assert.equal(r2.code, -111)
  assert.match(r2.error, /csrf/)
})

test('sendMessage：nav 取 sender、固定 dev_id、form body 齐全；太长直接拒', async () => {
  const { bili, calls, home } = setup([
    [(u) => u.pathname.endsWith('/nav'), { code: 0, data: { isLogin: true, mid: 123, uname: '她' } }],
    [(u) => u.pathname.endsWith('/web_im/send_msg'), { code: 0, data: { msg_key: 'k1' } }],
  ])
  const r = await bili.call('bili_send_message', { receiver_uid: 9, text: '今天挑了 3 条' })
  assert.equal(r.success, true)
  const call = calls.find((c) => c.u.pathname.endsWith('/web_im/send_msg'))
  const body = String(call.init.body)
  assert.match(body, /msg%5Bsender_uid%5D=123/)
  assert.match(body, /msg%5Breceiver_id%5D=9/)
  assert.match(body, /csrf=J/)
  assert.match(body, /msg%5Bdev_id%5D=WEB-/)
  assert.match(body, /msg%5Bcontent%5D=%7B%22content%22%3A%22/)

  // dev_id 必须固定复用（每次换设备 ID 更容易被风控）
  await bili.sendMessage({ receiver_uid: 9, text: '第二条' })
  const sents = calls.filter((c) => c.u.pathname.endsWith('/web_im/send_msg'))
  const devOf = (b) => /msg%5Bdev_id%5D=([^&]+)/.exec(String(b.init.body))?.[1]
  assert.equal(devOf(sents[0]), devOf(sents[1]), 'dev_id 两次必须一样')
  assert.ok(existsSync(join(home, 'dev_id')), 'dev_id 要落盘复用')

  const tooLong = await bili.sendMessage({ receiver_uid: 9, text: 'x'.repeat(501) })
  assert.equal(tooLong.success, false)
  assert.match(tooLong.error, /太长/)
})

test('danmaku：拉 XML 弹幕，回热区 / 高频梗 / 抽样', async () => {
  const xml = '<?xml version="1.0"?><i><d p="12.5,1,25,16777215,1750000000,0,u1,d1">前排</d>'
    + '<d p="13.0,1,25,16777215,1750000000,0,u2,d2">前排</d>'
    + '<d p="88.2,1,25,16777215,1750000000,0,u3,d3">这段讲得好</d></i>'
  const { bili } = setup([
    [isView, { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 42, cid: 9, title: 'T', duration: 120 } }],
    [(u) => u.pathname.endsWith('/x/v1/dm/list.so'), { __raw: xml }],
  ])
  const r = await bili.call('bili_danmaku', { bvid: 'BV1xx411c7mD' })
  assert.equal(r.title, 'T')
  assert.equal(r.count, 3)
  assert.equal(r.duration, 120)
  assert.equal(r.top[0].text, '前排')
  assert.equal(r.top[0].count, 2)
  assert.ok(r.hot.length >= 1 && r.hot[0].count >= 1)
  assert.equal(r.sample.length, 3)
})

test('frames：有 ffmpeg 就抽帧（URL/参数对），没 ffmpeg 就明确说跳过', async () => {
  const calls = []
  const ff = async (bin, args) => { calls.push({ bin, args }); return { ok: true, code: 0 } }
  const on = setup([
    [isView, { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 42, cid: 9, title: 'T', duration: 100 } }],
    [(u) => u.pathname.endsWith('/x/player/wbi/playurl'), { code: 0, data: { durl: [{ url: 'https://cdn.example/v.mp4' }] } }],
  ], { ffmpegBin: 'ffmpeg-fake', runFfmpeg: ff })
  const r = await on.bili.call('bili_frames', { bvid: 'BV1xx411c7mD', times: [10, 50] })
  assert.equal(r.ok, true)
  assert.equal(r.frames.length, 2)
  assert.equal(r.frames[0].at, 10)
  assert.match(String(r.frames[0].path), /tmp[\\/]frames[\\/]BV1xx411c7mD-10\.jpg$/)
  assert.equal(calls[0].bin, 'ffmpeg-fake')
  assert.ok(calls[0].args.includes('-frames:v'))
  assert.ok(calls[0].args.includes('https://cdn.example/v.mp4'))
  assert.match(String(calls[0].args[calls[0].args.indexOf('-headers') + 1]), /Referer: https:\/\/www\.bilibili\.com/)

  const off = setup([
    [isView, { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 42, cid: 9, title: 'T', duration: 100 } }],
  ], { findFfmpeg: () => null })
  const r2 = await off.bili.frames({ bvid: 'BV1xx411c7mD' })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /没装 ffmpeg/)
})

test('call()：只读与写入都认；未知工具明确拒绝', () => {
  const { bili } = setup([[() => true, { code: 0 }]])
  assert.throws(() => bili.call('bili_diary', {}), /还不支持 bili_diary/)
  assert.throws(() => bili.call('bili_nope', {}), /还不支持 bili_nope/)
})
