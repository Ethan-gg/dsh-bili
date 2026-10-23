/**
 * src/host/wake.mjs —— 叫醒「她」：优先用常驻会话，不行再退回 spawn
 * ============================================================================
 * M3 的核心。为什么值得改：现在每一轮都是 `dsh --profile headless` 起一个**一次性进程**，
 * 而那个 profile 里**没有这个插件** ⇒ 她手里只有 Python MCP 那六个工具，
 * 日记、待审草稿、分享闸门这些宿主工具她一个都看不见。
 * 改成常驻会话之后，她就跑在**插件自己的会话里**，宿主工具全部可用，而她也有了连续性。
 *
 * ⚠️ 三条从 whale 的坑里学来的规矩：
 *
 * ① **绝不把 `sessionController` 声明进 `inject`**。
 *    whale 写的是 `inject: ['sessionController', ...]`，后果是：headless / 精简 profile 里没有这个服务
 *    ⇒ 整条插件永远 `pending (waiting for services: …)`，**设置页 404、插件等于没装**。
 *    这里改成运行时 `ctx.get('sessionController')`：有就用，没有就退回 spawn。
 *
 * ② **`prompt()` 返回的是"提示被收下了"，不是"这一轮跑完了"**。
 *    接口签名是 `Promise<SessionPromptValue>`，注释写的是 acknowledgement。
 *    ⇒ 收尾（数条数、复核、推送）不能挂在它的 then 上，必须由**她自己报告收工**（`bili_done`），
 *      再加一个**看门狗**兜底（她在里面卡住时至少不会把锁永远拿着）。
 *
 * ③ **失败要能退回 spawn**：常驻会话叫不醒（会话被删 / 宿主版本对不上）时，
 *    这一轮不该白丢 —— 退回老路跑完，比什么都不发生好。
 * ============================================================================
 */

/** 会话默认 id。固定值是有意的：跨天保留上下文，她才有"昨天" */
export const SESSION_ID = 'bili'

/** 她能"被叫醒"吗（不抛异常，只回答有没有） */
export function hasSession(sc) {
  return Boolean(sc && typeof sc.prompt === 'function')
}

/**
 * 把一段话投进她的会话。
 * **只保证"被收下"**，不保证跑完 —— 调用方必须自己安排收尾（见文件头 ②）。
 *
 * @param {object} p
 * @param {object} p.sessionController 宿主服务（拿不到就返回 `{ok:false}`）
 * @param {string} [p.sessionId]
 * @param {string} p.cwd                会话工作目录（= 插件家，沙箱内只写得了这里）
 * @param {string} p.text               这一轮要她做的事
 * @param {number} [p.now]
 * @returns {Promise<{ok:boolean, mode:'session', requestId?:string, error?:string}>}
 */
export async function deliverToSession({ sessionController: sc, sessionId = SESSION_ID, cwd, text, now = Date.now() } = {}) {
  if (!hasSession(sc)) return { ok: false, mode: 'session', error: '没有 sessionController（退回 spawn）' }
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, mode: 'session', error: '这一轮的话是空的' }

  // 会话可能还没建过（第一次跑 / 用户清过 sessions）—— 建失败不算错：
  // 同名会话已存在时 create 会抛，那时候直接 prompt 就对了。
  if (typeof sc.create === 'function') {
    try { await sc.create({ sessionId, cwd }) } catch { /* 已存在 / 宿主不认这个参数，都继续往下试 */ }
  }

  const requestId = `bili-${now}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await sc.prompt(
      { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: body }] },
      new AbortController().signal,
    )
    return { ok: true, mode: 'session', requestId }
  } catch (e) {
    return { ok: false, mode: 'session', requestId, error: String(e?.message ?? e) }
  }
}

/**
 * 收尾看门狗：她要是卡在里面没报告收工，至少让锁别一直被占着。
 * 返回 `stop()`。**回调只该跑一次**（正常报告收工后会先 stop）。
 */
export function createWatchdog({ ms, onTimeout }) {
  let done = false
  const timer = setTimeout(() => {
    if (done) return
    done = true
    try { onTimeout?.() } catch { /* 兜底回调自己出错不该再抛出去 */ }
  // 不设下限：下限只会让测试没法用小值验证（真实调用方自己给 15 分钟这种大数）
  }, Math.max(0, Number(ms) || 0))
  timer.unref?.()
  return () => { done = true; try { clearTimeout(timer) } catch { /* ignore */ } }
}
