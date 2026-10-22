/**
 * 纯 Node 二维码单测（登录用）：形状 / 内容敏感性 / data URI / 空输入
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { qrMatrix, renderQrDataUri, renderQrPng, renderQrSvg } from '../src/bili/qr.mjs'

const LOGIN_URL = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close'
  + '&qrcode_key=ce0af59160090ec55aff68ab151284e4&from=main-fe-header'

test('renderQrSvg：合法 SVG、带 path、有尺寸（能被 <img> 直接吃）', () => {
  const svg = renderQrSvg(LOGIN_URL)
  assert.match(svg, /^<\?xml|^<svg/)
  assert.match(svg, /<svg[\s>]/)
  assert.match(svg, /width="280"/)
  assert.match(svg, /height="280"/)
  assert.match(svg, /<path[^>]+d="M/, '模块要拼成 path（join:true）')
  assert.match(svg, /<\/svg>$/)
})

test('二维码随内容变；登录 URL 这种长度也能画，体积可控', () => {
  const a = renderQrSvg(LOGIN_URL)
  const b = renderQrSvg(LOGIN_URL.replace('ce0af', 'zzzzz'))
  assert.notEqual(a, b)
  assert.ok(a.length < 30000, 'SVG 太大：' + a.length)
  // 二维码本身是"数据越多、格子越多" —— 故意塞一段长内容也得能出
  assert.match(renderQrSvg('x'.repeat(400)), /<path[^>]+d="M/)
})

test('renderQrDataUri：浏览器 <img src> 能直接用的 data URI', () => {
  const uri = renderQrDataUri(LOGIN_URL)
  assert.ok(uri.startsWith('data:image/svg+xml;base64,'))
  const svg = Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
  assert.match(svg, /<svg[\s>]/)
  assert.match(svg, /<\/svg>$/)
})

test('空内容直接抛（别画一张空码让人以为坏了）', () => {
  assert.throws(() => renderQrSvg('   '), /空的/)
  assert.throws(() => renderQrDataUri(''), /空的/)
  assert.throws(() => renderQrPng(''), /空的/)
})

test('renderQrPng：真 PNG（magic/IHDR/IDAT），像素与矩阵逐格一致（不依赖 Python）', () => {
  const png = renderQrPng(LOGIN_URL, { size: 320 })
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic')
  // 解析 chunk：IHDR 宽度/高度 + IDAT 解压后的灰度行
  let off = 8
  let width = 0
  const idat = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.subarray(off + 4, off + 8).toString('ascii')
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); assert.equal(data.readUInt32BE(4), width, '宽高相等') }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  assert.ok(width > 0)
  const raw = inflateSync(Buffer.concat(idat))
  assert.equal(raw.length, width * (width + 1), '每行 1 字节 filter + width 字节灰度')

  // 逐格抽中点对比矩阵（注意 PNG 是灰度：0=黑、255=白）
  const { modules, n, margin } = qrMatrix(LOGIN_URL)
  const box = n + 2 * margin
  const scale = Math.max(1, Math.round(320 / box))
  assert.equal(width, box * scale)
  for (const [x, y] of [[0, 0], [n - 1, n - 1], [Math.floor(n / 2), Math.floor(n / 2)]]) {
    const px = (x + margin) * scale + Math.floor(scale / 2)
    const py = (y + margin) * scale + Math.floor(scale / 2)
    const v = raw[py * (width + 1) + 1 + px]
    assert.equal(v, modules[x][y] ? 0 : 255, `第 (${x},${y}) 格颜色不对`)
  }
})
