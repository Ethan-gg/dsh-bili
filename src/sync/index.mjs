/**
 * src/sync/index.mjs —— 云桥的装配点
 * ============================================================================
 * 它做三件事：
 *   ① 按配置挑一个传输实现（`file` / `dshim` / `http`）
 *   ② 没有传输实现就给一句**人话错误**，而不是 "undefined is not a function"
 *   ③ 把 `~/.dsh/bili/sync/` 那几份状态文件接上
 *
 * 加一个新的云端传输，只要两步：
 *   1. 写 `transport/<名字>.mjs`，导出 `create<名字>Transport({ config, deps })`，
 *      返回 `{ name, capabilities(), send(event), poll(cursor) }`
 *   2. 在下面 `TRANSPORTS` 里登记一行
 * 业务代码（host 半端）完全不用动 —— 它只认 `bridge.emit()` / `bridge.pump()` / `bridge.ingest()`。
 *
 * 三个现成实现（方案 §6.4）：
 *   · file  —— 本地 JSONL 回环；M0 起就在，端到端测试靠它
 *   · dshim —— 出站走宿主 `ctx.dshIm.send()`（九个 IM 渠道）；无入站
 *   · http  —— 出站 POST 云端 `/sync/v1/events`；入站由插件签名路由 push 进来
 * ============================================================================
 */
import { createFileTransport } from './transport/file.mjs'
import { createDshimTransport } from './transport/dshim.mjs'
import { createHttpTransport } from './transport/http.mjs'
import { createBridge, ensureSecret } from './bridge.mjs'

export const TRANSPORTS = {
  file: ({ paths }) => createFileTransport({ outbox: paths.outbox, inbox: paths.inbox }),
  dshim: ({ config, deps }) => createDshimTransport({ config, getService: deps.getDshIm }),
  http: ({ config, deps }) => createHttpTransport({ config, fetchImpl: deps.fetchImpl }),
}

/**
 * 没开就是 `null`（调用方到处判空，别返回一个"假桥"）。
 * 开了但传输不可用 → 抛错，让设置页能如实显示"云桥没起来"。
 *
 * @param {object} p
 * @param {object} p.paths     homePaths(...) 里的 sync 那几个路径
 * @param {object} p.config    整份配置（读 config.sync）
 * @param {object} [p.deps]    `getDshIm`（运行时取 ctx.get('dshIm')）/ `fetchImpl`（单测）
 */
export function createSync({ paths, config, log = () => {}, deps = {} } = {}) {
  if (!config?.sync?.enabled) return null
  const kind = String(config.sync.transport || 'file')
  const build = TRANSPORTS[kind]
  if (!build) throw new Error(`未知的同步方式：${kind}`)
  const transport = build({ paths, config, deps })
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
