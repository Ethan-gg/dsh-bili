/**
 * src/sync/transport/dshim.mjs —— 出站：走宿主已装的 `@xmanrui/dsh-im`
 * ============================================================================
 * 方案 §6.4：出站不用等云端。用户在设置页填 `{ botId, targetId }`（从 IM 设置页复制），
 * 她分享完 / 有草稿待审时，直接把一句话推到微信群 / 飞书群 / 企微……
 *
 * 为什么在**运行时** `ctx.get('dshIm')` 而不是写进 `inject`：
 * 跟 `sessionController` 同一个理由 —— 没装 dsh-im 的精简 profile 里写进 inject 会让整条插件
 * 永远 pending（设置页 404、插件等于没装）。这里拿不到就返回一句人话错误。
 *
 * 入站：**没有**。dsh-im 的群消息入站目前只对飞书/Lark 且要 external-consumer 模式，
 * 不通用（方案 §6.4 的"事实"）—— 入站走 `http` 传输 + 插件自己的签名路由。
 * ============================================================================
 */
import { TYPES } from '../protocol.mjs'

/** 把事件渲染成"人看的话"；返回空串 = 这类事件不往群里发（只落盘/给云端） */
export function renderOutbound(env) {
  const p = env?.payload ?? {}
  switch (env?.type) {
    case TYPES.MSG_OUT:
      return String(p.text ?? '').trim()
    case TYPES.APPROVAL_REQ:
      return `【待审草稿】${String(p.text ?? '').trim()}` + (p.target ? `\n目标：${p.target}` : '')
        + '\n\n（在刷B站设置页「互动」里批准 / 否掉）'
    default:
      return ''
  }
}

/**
 * @param {object} p
 * @param {object} p.config           整份配置（读 config.sync）
 * @param {() => object|null} [p.getService]  运行时取 `ctx.get('dshIm')`
 */
export function createDshimTransport({ config, getService } = {}) {
  const s = config?.sync ?? {}
  return {
    name: 'dshim',
    capabilities: () => ({ inbound: false, outbound: true, threads: false, maxText: 2000 }),

    async send(env) {
      const text = renderOutbound(env)
      if (!text) return { ok: true, skipped: true }          // 不是"发失败"，只是这类事件不推群
      const botId = String(s.botId ?? '').trim()
      const targetId = String(s.targetId ?? '').trim()
      if (!botId || !targetId) return { ok: false, error: '云桥还没填 botId / targetId（设置页「高级」→ 云桥）' }
      const svc = typeof getService === 'function' ? getService() : null
      if (!svc || typeof svc.send !== 'function') {
        return { ok: false, error: '宿主里没有 dsh-im 服务（没装 @xmanrui/dsh-im，或它没启用）' }
      }
      try {
        const r = await svc.send(botId, targetId, text, { format: 'plain' })
        return { ok: r?.sent !== false, remoteId: r?.id }
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) }
      }
    },

    /** dsh-im 没有通用入站 ⇒ 永远空（入站走 http 推模式） */
    async poll() { return { events: [], cursor: '' } },
  }
}
