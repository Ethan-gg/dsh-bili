/**
 * src/bili/qr.mjs —— 纯 Node 画二维码（登录用），**不再依赖 Python**
 * ============================================================================
 * 为什么要这一步（M2 第二刀）：扫码登录原来靠 venv 里的 Python `qrcode` 画 PNG，
 * 干净机器（没装 Python）就卡在"出码"这一步 —— 而"装完即用"正是 M2 的目标。
 *
 * 做法：vendor 一份 **qrcode-svg**（MIT，纯 JS、零依赖）只借它算出的**矩阵**，
 * 渲染自己写：
 *   · `renderQrSvg()`  → SVG 字符串（设置页 `<img src>` 用 data URI，矢量、小）
 *   · `renderQrPng()`  → PNG Buffer（`bili_login_start` 工具里落成文件给 `present` 用；
 *                         PNG 容器 + zlib 压缩都是 Node 内置的，不引第三方）
 * 两条都不成时，调用方会退回 venv 里的 Python 画 PNG —— 老路保底。
 *
 * ⚠️ 独立验证过（不是"看起来像"）：生成的 SVG / 矩阵用 jsQR（Apache-2.0，仅 dev 临时用，
 *    不进仓库）解码回来，内容与原始 URL 逐字一致。
 * ============================================================================
 */
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'

const require = createRequire(import.meta.url)

let QRCode = null
// ⚠️ 必须是 .cjs：本包是 `"type":"module"`，同目录下的 `.js` 会被 Node 当成 ESM —
//    而这份 vendor 代码是 CJS（`module.exports = QRCode`），用 .js 会 require 出一个空对象 ✗
try { QRCode = require('../../vendor/qrcode/qrcode.cjs') } catch { QRCode = null }

/**
 * 算矩阵（对外只给本文件与单测用）。
 * @returns {{modules:boolean[][], n:number, margin:number}} `modules[x][y]`
 */
export function qrMatrix(text, { margin = 4, ecl = 'M' } = {}) {
  const content = String(text ?? '').trim()
  if (!content) throw new Error('二维码内容是空的')
  if (!QRCode) throw new Error('二维码库没找到（vendor/qrcode/qrcode.cjs）')
  const qr = new QRCode({ content, padding: margin, width: 280, height: 280, ecl, join: true, pretty: false })
  const modules = qr?.qrcode?.modules
  const n = Array.isArray(modules) ? modules.length : 0
  if (!n) throw new Error('二维码矩阵没生成（库版本不兼容？）')
  return { modules, n, margin }
}

/**
 * 画一张二维码 SVG（字符串）。
 * SVG 自己写：整数坐标 + 每行合并连续黑块 —— 比库自带 `svg()` 小一个量级
 * （它会给每个模块写带小数的 5 段路径）。
 * @param {string} text
 * @param {{size?:number, margin?:number, ecl?:'L'|'M'|'Q'|'H'}} [opts]
 * @returns {string} 以 `<?xml` 开头、`</svg>` 结尾
 */
export function renderQrSvg(text, { size = 280, margin = 4, ecl = 'M' } = {}) {
  const { modules, n, margin: m } = qrMatrix(text, { margin, ecl })
  let d = ''
  for (let y = 0; y < n; y++) {
    let x = 0
    while (x < n) {
      if (!modules[x]?.[y]) { x += 1; continue }
      let run = 1
      while (x + run < n && modules[x + run]?.[y]) run += 1
      d += `M${x + m},${y + m}h${run}v1h-${run}z`
      x += run
    }
  }
  const box = n + 2 * m
  return '<?xml version="1.0" standalone="yes"?>'
    + `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${size}" height="${size}" viewBox="0 0 ${box} ${box}">`
    + `<rect width="${box}" height="${box}" fill="#ffffff"/>`
    + `<path fill="#000000" shape-rendering="crispEdges" d="${d}"/>`
    + '</svg>'
}

/** 画成 `<img src>` 直接能用的 data URI（设置页用这个） */
export function renderQrDataUri(text, opts = {}) {
  const svg = renderQrSvg(text, opts)
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
}

/* ─────────────────────────── PNG（工具落文件用）─────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xFFFFFFFF
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

/**
 * 画一张二维码 PNG（Buffer，8-bit 灰度、无调色板）。
 * 用 Node 内置 `zlib.deflateSync` 压 IDAT —— 不引第三方依赖。
 * @param {string} text
 * @param {{size?:number, margin?:number, ecl?:'L'|'M'|'Q'|'H'}} [opts]
 * @returns {Buffer}
 */
export function renderQrPng(text, { size = 320, margin = 4, ecl = 'M' } = {}) {
  const { modules, n, margin: m } = qrMatrix(text, { margin, ecl })
  const box = n + 2 * m
  const scale = Math.max(1, Math.round(size / box))
  const px = box * scale
  const raw = Buffer.alloc(px * (px + 1))       // 每行 1 字节 filter(0) + px 字节灰度
  for (let y = 0; y < px; y++) raw[y * (px + 1)] = 0
  raw.fill(255, 0, raw.length)
  for (let y = 0; y < px; y++) raw[y * (px + 1)] = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[x]?.[y]) continue
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + m) * scale + dy) * (px + 1)
        for (let dx = 0; dx < scale; dx++) raw[row + 1 + (x + m) * scale + dx] = 0
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(px, 0)
  ihdr.writeUInt32BE(px, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
