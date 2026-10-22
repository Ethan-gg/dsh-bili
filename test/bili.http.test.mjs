/**
 * HTTP 底座单测：缓存 / 节流 / 风控熔断（注入 fetch 与时钟，不碰真网络、不真等 300ms）
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBiliHttp } from '../src/bili/http.mjs'

const img = (stem) => `https://i0.hdslb.com/bfs/wbi/20241022/${stem}.png`
const NAV = { code: 0, data: { wbi_img: { img_url: img('a'.repeat(32)), sub_url: img('b'.repeat(32)) } } }
const VIEW = { code: 0, data: { bvid: 'BV1xx411c7mD', title: '一条视频', aid: 1, cid: 2 } }

const okRes = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

function setup({ viewStatus = 200, viewBody = VIEW } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bili-http-'))
  mkdirSync(join(home, '.cache'), { recursive: true })
  const calls = []
  const sleeps = []
  let nowMs = Date.parse('2026-10-22T18:00:00+08:00')
  const fetchImpl = async (url) => {
    const u = new URL(String(url))
    calls.push(u.href)
    if (u.pathname.endsWith('/nav')) return okRes(NAV)
    if (u.pathname.includes('/view')) {
      if (viewStatus !== 200) return { ok: false, status: viewStatus, text: async () => '' }
      return okRes(viewBody)
    }
    throw new Error('unexpected URL: ' + u.href)
  }
  const http = createBiliHttp({
    home, fetchImpl,
    now: () => nowMs,
    sleep: async (ms) => { sleeps.push(ms) },
    log: () => {},
  })
  return { home, http, calls, sleeps, tick: (ms) => { nowMs += ms } }
}

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD'

test('http：24 小时内同一份元信息只问一次 B站（第二次走缓存）', async () => {
  const { http, calls } = setup()
  const a = await http.get(VIEW_URL)
  const b = await http.get(VIEW_URL)
  assert.equal(a.code, 0)
  assert.equal(b._cached, true)
  assert.equal(calls.length, 2, '一次 nav + 一次 view')
})

test('http：两次请求之间至少隔 300ms（节流真的调了等待）', async () => {
  const { http, sleeps } = setup()
  await http.get(VIEW_URL)
  await http.get('https://api.bilibili.com/x/web-interface/view?bvid=BV1yy411c7mE')
  assert.ok(sleeps.length >= 1 && sleeps.every((ms) => ms === 300), '应出现 300ms 等待：' + JSON.stringify(sleeps))
})

test('http：撞到 HTTP 412 就熔断 —— 之后的请求不再打网络，直接说明等多久', async () => {
  const { http, calls } = setup({ viewStatus: 412 })
  const first = await http.get(VIEW_URL)
  assert.equal(first.code, -412)
  const n = calls.length
  const second = await http.get('https://api.bilibili.com/x/web-interface/view?bvid=BV1zz411c7mF')
  assert.match(second.message, /限流|风控|412/)
  assert.equal(calls.length, n, '熔断期间不该再打网络')
})

test('http：熔断期间有旧缓存就吃缓存（标 _stale），不让整轮直接瞎', async () => {
  const { http, home, calls } = setup()
  await http.get(VIEW_URL)                       // 先成功一次，写进缓存
  const n = calls.length
  writeFileSync(join(home, '.cache', 'api-ban.json'), JSON.stringify({ until: Date.now() + 5 * 60_000, why: 'test' }), 'utf8')
  const hit = await http.get(VIEW_URL)
  assert.equal(hit._cached, true)
  assert.equal(hit._stale, true)
  assert.equal(calls.length, n)
})

test('http：state() 能说清"熔断中 / 缓存几条"（诊断用）', async () => {
  const { http } = setup({ viewStatus: 429 })
  await http.get(VIEW_URL)
  const st = http.state()
  assert.equal(st.banned, true)
  assert.ok(st.banMinutesLeft >= 1)
  assert.ok(st.cacheEntries >= 1, 'nav 那一条会进缓存；这里只要求"能数出来"')
})

test('http：非 JSON 响应不抛，回一句人话（风控/接口变更）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bili-http-'))
  mkdirSync(join(home, '.cache'), { recursive: true })
  const http = createBiliHttp({
    home,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html> blocked </html>' }),
    now: () => Date.parse('2026-10-22T18:00:00+08:00'),
    sleep: async () => {},
  })
  // 用 nav 走非 JSON
  const r = await http.get('https://api.bilibili.com/x/web-interface/nav')
  assert.equal(r.code, -1)
  assert.match(r.message, /非 JSON|风控|接口/)
})
