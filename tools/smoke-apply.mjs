/**
 * 冒烟：在**假宿主**里真跑一次 apply()
 * 用法：DSH_HOME=<临时目录> node .tmp/smoke-apply.mjs
 * 目的：抓"导入炸了 / apply 一进来就抛 / 迁移失败"这类单测覆盖不到的问题。
 */
import path from 'node:path'
import fs from 'node:fs'

const DSH_HOME = process.env.DSH_HOME
if (!DSH_HOME) { console.error('要设 DSH_HOME'); process.exit(2) }

const tools = []
const routes = []
const effects = []
const logs = []

const ctx = {
  get(k) {
    if (k === 'dshHomePath') return (...seg) => path.join(DSH_HOME, ...seg)
    if (k === 'agentDefaultModel') return null
    return null
  },
  tools: { register: (t) => { tools.push(t?.name ?? '?'); return () => {} } },
  webServer: { register: (r) => { routes.push(r?.path ?? '?'); return () => {} } },
  settings: { describe: () => [], update: async () => {} },
  logger: { info: (m) => logs.push(String(m)) },
  effect: (fn) => {
    effects.push(fn)
    // 真的跑一遍：路由是注册在 effect 里的（`ctx.effect(() => ctx.webServer.register(...))`），
    // 不调用就看不出 HTTP 面到底挂没挂上
    try { return fn() ?? (() => {}) } catch (e) { logs.push('effect 抛了：' + (e?.message ?? e)); return () => {} }
  },
}

const mod = await import('../index.js')
console.log('导出：', Object.keys(mod).join(', '))
console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject))
console.log('Config =', mod.Config ? '有' : '无')

try {
  mod.apply(ctx, {})
  console.log('✓ apply() 没抛')
} catch (e) {
  console.error('✗ apply() 抛了：', e?.stack ?? e)
  process.exit(1)
}

const home = path.join(DSH_HOME, 'bili')
console.log('工具（' + tools.length + '）：', tools.join(', '))
console.log('HTTP 路由（' + routes.length + '）：', routes.join(', '))
console.log('effect（' + effects.length + '）：', effects.length ? '已注册清理函数' : '无')
console.log('家目录存在 =', fs.existsSync(home))
for (const f of ['config.json', 'ledger', 'memory', 'sync', 'persona.md', 'MIGRATION.md', '.migrated-v1']) {
  console.log('  ', f, '=', fs.existsSync(path.join(home, f)))
}
if (fs.existsSync(path.join(home, 'config.json'))) {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
  console.log('config 版本 =', cfg.version, '| 账户.mentionName =', cfg.account?.mentionName, '| 日程窗口 =', JSON.stringify(cfg.schedule?.windows))
}
console.log('启动日志前 8 条：')
for (const l of logs.slice(0, 8)) console.log('  ·', l)
