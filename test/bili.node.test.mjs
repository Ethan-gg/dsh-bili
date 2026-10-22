/**
 * Node 只读能力层单测：search / subtitle / comments 的 URL、签名、返回形状
 * （形状必须与 vendor/bilibili-mcp/mcp_server.py 那三个工具逐字段对齐）
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeBili } from '../src/bili/index.mjs'

const img = (stem) => `https://i0.hdslb.com/bfs/wbi/20241022/${stem}.png`
const NAV = { code: 0, data: { wbi_img: { img_url: img('a'.repeat(32)), sub_url: img('b'.repeat(32)) } } }
const okRes = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

/** 按路径把假响应排成一张表；顺带记住每次请求的 URL / headers */
function setup(routes) {
  const home = mkdtempSync(join(tmpdir(), 'bili-node-'))
  mkdirSync(join(home, '.cache'), { recursive: true })
  writeFileSync(join(home, 'bili_credential.json'), JSON.stringify({ sessdata: 'S', bili_jct: 'J', buvid3: 'B' }), 'utf8')
  const calls = []
  const nowMs = Date.parse('2026-10-22T18:00:00+08:00')
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url))
    const headers = init?.headers || {}
    calls.push({ u, headers })
    for (const [match, body] of routes) if (match(u)) return okRes(body)
    if (u.pathname.endsWith('/nav')) return okRes(NAV)
    throw new Error('unexpected URL: ' + u.href)
  }
  const bili = createNodeBili({ home, fetchImpl, now: () => nowMs, sleep: async () => {}, log: () => {} })
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

test('call()：只认只读三件；写入类明确拒绝（那条仍走 Python）', () => {
  const { bili } = setup([[() => true, { code: 0 }]])
  assert.throws(() => bili.call('bili_reply', {}), /还不支持 bili_reply/)
  assert.throws(() => bili.call('bili_diary', {}), /还不支持 bili_diary/)
})
