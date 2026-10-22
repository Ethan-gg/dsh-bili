/**
 * src/lib/home.mjs —— 插件启动时"把家准备好"的唯一入口
 * ============================================================================
 * 顺序很重要，别调换：
 *   ① 先问宿主 DSH 家在哪（`dshHomePath` 是**函数**，不是字符串 —— 2.0 踩过一次）
 *   ② 再决定搬迁（幂等，只看 `.migrated-v1`）
 *   ③ 最后建目录
 *
 * 任何一步失败都不许把插件带崩：拿不到宿主家就用 `$DSH_HOME` / `~/.dsh`，
 * 迁不动就原地用 —— 一个报告插件不值得为了搬家让整个 DSH 起不来。
 * ============================================================================
 */
import { mkdirSync } from 'node:fs'
import { homePaths, resolveBiliHome, resolveDshHome } from './paths.mjs'
import { migrateIfNeeded } from './migrate.mjs'

const DIRS = (p) => [p.home, p.out, p.digest, p.reports, p.ledgerDir, p.memoryDir, p.diaryOwner, p.diarySelf, p.syncDir]

/**
 * 把宿主的家目录信息折算成一份 env。
 * `dshHomePath(...segments)` 是函数形态（`dshHomePath()` = DSH 家根）。
 * 拿不到就当没有 —— 让 paths.mjs 那套 env 兜底生效。
 */
export function effectiveEnv(ctx, env = process.env) {
  let dsh = ''
  try {
    const f = ctx?.get?.('dshHomePath')
    if (typeof f === 'function') { const v = f(); if (v) dsh = String(v) }
    else if (typeof f === 'string' && f) dsh = f
  } catch { /* 宿主没这服务：用 env */ }
  return dsh ? { ...env, DSH_HOME: dsh } : env
}

/**
 * 准备好家。返回 `{ home, paths, env, migrated }`。
 * `migrate: false` 只建目录不搬（自检/测试用）。
 */
export function ensureHome({ ctx = null, env = process.env, log = () => {}, migrate = true } = {}) {
  const e = effectiveEnv(ctx, env)
  let migrated = { ok: true, skipped: true, home: resolveBiliHome(e), warnings: [] }

  if (migrate) {
    try {
      migrated = migrateIfNeeded({ env: e, log })
    } catch (err) {
      // 搬不动不是致命错：老数据还在老位置，插件照样能跑（只是看不见历史）
      migrated = { ok: false, skipped: false, home: resolveBiliHome(e), warnings: [String(err?.message ?? err)] }
      log('搬迁失败，先按老样子跑：' + String(err?.message ?? err))
    }
  }

  const home = migrated.home || resolveBiliHome(e)
  const paths = homePaths(home)
  for (const d of DIRS(paths)) {
    try { mkdirSync(d, { recursive: true }) } catch (err) { log(`建目录失败 ${d}：${err?.message ?? err}`) }
  }
  return { home, paths, env: e, migrated, dshHome: resolveDshHome(e) }
}

export { homePaths, resolveBiliHome, resolveDshHome }
