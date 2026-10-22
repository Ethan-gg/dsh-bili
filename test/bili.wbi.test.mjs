/**
 * WBI 签名单测：密钥折取 / 排序 / 清洗字符 / md5 结构
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { MIXIN_TAB, mixinKey, signQuery } from '../src/bili/wbi.mjs'

const img = (stem) => `https://i0.hdslb.com/bfs/wbi/20241022/${stem}.png`
const IMGS = { img_url: img('a'.repeat(32)), sub_url: img('b'.repeat(32)) }

test('mixinKey：两个文件名各取 32 位、按官方混淆表折成 32 位密钥', () => {
  const raw = 'a'.repeat(32) + 'b'.repeat(32)
  const expected = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  assert.equal(mixinKey(IMGS), expected)
  assert.equal(mixinKey(IMGS).length, 32)
  assert.throws(() => mixinKey({ img_url: img('x') }), /WBI 签名密钥缺失/)
})

test('signQuery：wts + 排序 + md5( query + 密钥 )，形状与官方一致', () => {
  const key = mixinKey(IMGS)
  const now = Date.parse('2026-10-22T18:01:00+08:00')
  const params = { bvid: 'BV1xx411c7mD', cid: 42 }
  const values = { ...params, wts: Math.floor(now / 1000) }
  const q = Object.keys(values).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const expected = q + '&w_rid=' + crypto.createHash('md5').update(q + key).digest('hex')
  assert.equal(signQuery(params, key, now), expected)
  assert.match(signQuery(params, key, now), /&wts=\d+&w_rid=[0-9a-f]{32}$/)
})

test('signQuery：值里的 !\'()* 先洗掉再编码；传进来的 wts/w_rid 会被重算', () => {
  const key = mixinKey(IMGS)
  const now = 1_792_648_000_000
  const q = signQuery({ keyword: "a!b(c'd)*", wts: 1, w_rid: 'deadbeef' }, key, now)
  assert.ok(!/['!()*]/.test(q.split('&w_rid=')[0]), '签名串里不该出现那几个字符')
  assert.match(q, new RegExp(`wts=${Math.floor(now / 1000)}(&|$)`), 'wts 必须是现在这个时间')
  assert.match(q, /&w_rid=[0-9a-f]{32}$/)
  assert.equal(signQuery({ keyword: 'x' }, key, now).startsWith('keyword=x&wts='), true, 'key 按字母序排')
})

test('signQuery：密钥长度不对直接抛（别拿半截密钥签一堆废请求）', () => {
  assert.throws(() => signQuery({ a: 1 }, 'short'), /32 位/)
})
