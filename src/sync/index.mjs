/**
 * src/sync/index.mjs —— 云桥的装配点
 * ============================================================================
 * **这是"预留接口"的实体**。它做三件事：
 *   ① 按配置挑一个传输实现（现在只有 `file`）
 *   ② 没有传输实现就给一句**人话错误**，而不是 "undefined is not a function"
 *   ③ 把 `~/.dsh/bili/sync/` 那几份状态文件接上
 *
 * 加一个新的云端传输，只要两步：
 *   1. 写 `transport/<名字>.mjs`，导出 `create<名字>Transport({ config, paths })`，
 *      返回 `{ name, capabilities(), send(event), poll(cursor) }`
 *   2. 在下面 `TRANSPORTS` 里登记一行
 * 业务代码（host 半端）完全不用动 —— 它只认 `bridge.emit()` / `bridge.pump()`。
 * ============================================================================
 */
import { createFileTransport } from './transport/file.mjs'
import { createBridge, ensureSecret } from './bridge.mjs'

export const TRANSPORTS = {
  file: ({ paths }) => createFileTransport({ outbox: paths.outbox, inbox: paths.inbox }),
  // M4 才实现。先占位，报错要说清"差什么"，别让用户以为插件坏了。
  dshim: () => { throw new Error('dshim 传输还没接（M4）：先把 transport=file 用着，出站走「消息推送」') },
  http: () => { throw new Error('http 传输还没接（M4）：云端端点还没开发，先用 transport=file 做本地回环') },
}

/**
 * 没开就是 `null`（调用方到处判空，别返回一个"假桥"）。
 * 开了但传输不可用 → 抛错，让设置页能如实显示"云桥没起来"。
 */
export function createSync({ paths, config, log = () => {} }) {
  if (!config?.sync?.enabled) return null
  const kind = String(config.sync.transport || 'file')
  const build = TRANSPORTS[kind]
  if (!build) throw new Error(`未知的同步方式：${kind}`)
  const transport = build({ paths, config })
  ensureSecret(paths.secret)
  return createBridge({
    paths,
    transport,
    replayWindowMin: Number(config.sync.replayWindowMin) || 10,
    maxInboundPerMinute: Number(config.sync.maxInboundPerMinute) || 0,
    log,
  })
}

export { createBridge, ensureSecret }
