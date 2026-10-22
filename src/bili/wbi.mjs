/**
 * src/bili/wbi.mjs —— WBI 签名（B站 web 端接口的签名）
 * ============================================================================
 * 来源：[`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale) 的
 * `tools/lib/bili-api.mjs` + 各命令里重复的那份实现（MIT）。
 *
 * 三条实测口径（别改）：
 *   ① 密钥 = nav 返回的 `wbi_img.img_url` / `sub_url` 两个文件名拼起来，再按官方混淆表取 32 位；
 *      **匿名也能拿到 nav 的 wbi_img**，但 AI 字幕 / 搜索结果要登录 cookie 才完整。
 *   ② 参与签名的值要先去掉 `!'()*` 这几个字符，然后按 key 排序、`encodeURIComponent`；
 *      最后追加 `wts`（秒）与 `w_rid = md5(query + 密钥)`。
 *   ③ 密钥会轮换（10 分钟量级）⇒ 调用方要缓存 nav、别每条请求都去换。
 * ============================================================================
 */
import crypto from 'node:crypto'

/** 官方混淆表（从网页 JS 里扒出来的；它变了 ⇒ 所有签名接口一起挂，属于硬编码契约） */
export const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const keyOf = (u) => String(u ?? '').split('/').pop().split('.')[0]
const clean = (v) => String(v ?? '').replace(/[!'()*]/g, '')

/**
 * 从 nav 的 `wbi_img` 折出 32 位密钥。
 * @param {{img_url?: string, sub_url?: string}} wbiImg
 */
export function mixinKey(wbiImg) {
  const raw = keyOf(wbiImg?.img_url) + keyOf(wbiImg?.sub_url)
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失（nav 没返回 wbi_img，或登录态异常）')
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
}

/**
 * 拼一段可直接挂在 URL 后面的签名 query。
 * @param {Record<string, string|number>} params
 * @param {string} key   32 位密钥（`mixinKey()` 的返回值）
 * @param {number} [now] 毫秒时间戳（测试用）
 * @returns {string} `k1=v1&…&wts=…&w_rid=…`（已排序）
 */
export function signQuery(params = {}, key, now = Date.now()) {
  const mixin = String(key ?? '')
  if (mixin.length !== 32) throw new Error('WBI 签名密钥必须 32 位')
  const values = { ...params }
  delete values.w_rid
  delete values.wts
  values.wts = Math.floor(now / 1000)
  const query = Object.keys(values).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(values[k]))}`)
    .join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + mixin).digest('hex')}`
}
