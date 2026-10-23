/**
 * 找 dsh CLI 的**唯一实现**（2026-10-23 从 index.js 抽出来 —— 抽出来才能被 `test/` 直接验）
 * ============================================================================
 * 背景（2026-10-19 主人："改一下，让他的 dsh 直接弄好不行吗"）：桌面版（Electron）不是 npm -g 装的，
 * `dsh` 也不在 PATH 上 ⇒ 只猜几个固定位置会漏，漏了就让用户手填 `dshBin` ✗
 *
 * ⭐⭐ 2026-10-23 本机诊断（版本 2.1.1）又抓到一个漏：
 *   `dsh Desktop.exe` 所在的**应用根目录**下有 `node_modules/@deepseek-ai/dsh/lib/bin.js`，
 *   而 `resources/` 下只有 `app.asar` / `app.asar.unpacked` —— portable 构建的依赖放在**根目录**，
 *   老逻辑只从 `resources` 往下搜 ⇒ 永远搜不到 ⇒ 自检里写着「dsh：没找到」✗
 *   ⇒ 现在把**应用根目录**也算进来；并且先按"固定落点 / Node 解析器"直接命中，
 *     有界递归只当最后兜底（省得每 5 秒把几万个目录翻一遍）。
 *
 * ⭐⭐ 2026-10-23 第二轮（用户重启后依旧是"dsh：没找到"，查了真实进程树才明白为什么）：
 *   **插件跑的那个宿主进程不是 Electron 主进程，而是桌面版拉起来的 `node.exe` 子进程**：
 *     `D:\Software\nodejs\node.exe  "…\DS Harness\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web …`
 *   ⇒ `process.execPath` 是 `node.exe`，它的 `dirname` 是 `D:\Software\nodejs`，
 *     **根本指不到 dsh 装在哪**（Electron 主进程里那套 appRoot 逻辑在这儿无效）。
 *   ⇒ 真正可靠的是 **`process.argv[1]`：就是正在跑的 `…/@deepseek-ai/dsh/lib/bin.js` 本身**。
 *     现在先认 argv 里的那个路径，再用它当解析器起点；execPath 那套继续留着（Electron 主进程里仍可能命中）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

/** dsh 包入口的两个解析目标（`@deepseek-ai/dsh` 本身可能没有 exports main，失败就换下一个） */
export const DSH_SPECS = ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']

/** 长得像 dsh 的 CLI 入口：`<任意前缀>/@deepseek-ai/dsh/lib/bin.js` */
export const looksLikeDshBin = (p) => /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i.test(String(p || ''))

/**
 * 有界递归：只认 `<任意目录>/dsh/lib/bin.js`，深度 ≤ 7、最多翻 4000 个目录。
 * （桌面版应用目录不小，但真正要的 `dsh` 一般就在 `node_modules/@deepseek-ai/` 下，2~3 层）
 */
export const scanForDsh = (dir, depth = 0, budget = { n: 0 }, limits = {}) => {
  const maxDepth = limits.maxDepth ?? 7
  const maxDirs = limits.maxDirs ?? 4000
  if (depth > maxDepth || budget.n > maxDirs) return ''
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
  for (const d of ents) {
    if (!d.isDirectory() || d.isSymbolicLink()) continue      // 不跟链接，免得绕圈
    if (++budget.n > maxDirs) return ''
    const p = join(dir, d.name)
    if (d.name === 'dsh') {
      const bin = join(p, 'lib', 'bin.js')
      if (existsSync(bin)) return bin
    }
    const hit = scanForDsh(p, depth + 1, budget, limits)
    if (hit) return hit
  }
  return ''
}

/** 把一个候选目录摊成 `<base>/node_modules/@deepseek-ai/dsh/lib/bin.js` */
const nmBin = (base) => join(base, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/**
 * 候选路径（按"最可能命中"排序，去重、去掉空值）。
 * 不碰文件系统 —— 纯拼路径，方便测试和打印。
 */
export const dshCandidates = ({
  explicit = '',
  execPath = process.execPath,
  env = process.env,
} = {}) => {
  const appRoot = (() => { try { return dirname(execPath) } catch { return '' } })()
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(String(explicit || '').trim())
  // 桌面版：依赖在应用根目录（portable 构建）；也兼容两种 asar 解包形状
  if (appRoot) {
    push(nmBin(appRoot))
    push(join(appRoot, 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    push(nmBin(join(appRoot, 'resources', 'app')))
  }
  // npm 全局 / 常见安装位置
  if (env.APPDATA) push(nmBin(join(env.APPDATA, 'npm')))
  if (env.ProgramFiles) push(nmBin(join(env.ProgramFiles, 'nodejs')))
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
  return out
}

/** 有界递归要搜的根：应用根目录优先，然后是 resources（老桌面版/打包形状） */
export const dshScanRoots = ({ execPath = process.execPath, resourcesPath = process.resourcesPath } = {}) => {
  const appRoot = (() => { try { return dirname(execPath) } catch { return '' } })()
  const roots = []
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p) }
  push(appRoot)
  push(resourcesPath)
  if (appRoot) push(join(appRoot, 'resources'))
  return roots.filter((p) => existsSync(p))
}

/**
 * 找 dsh CLI：命中返回 bin.js 的绝对路径，找不到返回 ''（调用方负责"找不到就出声"）。
 * ⭐ 顺序：用户填的 → **进程自己的 argv（宿主就是这么起的：node <bin.js>）** →
 *          Node 解析器（插件树 / 桌面版应用包 / argv 那个路径）→ 固定落点 → 有界递归兜底
 */
export const findDshCli = ({
  explicit = '',
  execPath = process.execPath,
  env = process.env,
  selfUrl = import.meta.url,
  resourcesPath = process.resourcesPath,
  argv = process.argv,
  scanLimits = {},
} = {}) => {
  // ① 用户显式填的（存在才算，填错不硬用）
  const ex = String(explicit || '').trim()
  if (ex && existsSync(ex)) return ex

  // ② 宿主自己的 argv：node.exe 跑的就是 `…/@deepseek-ai/dsh/lib/bin.js`
  //    （桌面版把 dsh 当子进程起，process.execPath 只是 node.exe，指不到安装位置 —— 这条才是关键）
  const argPaths = (Array.isArray(argv) ? argv : []).filter((a) => typeof a === 'string' && a)
  for (const a of argPaths) {
    if (looksLikeDshBin(a) && existsSync(a)) return a
  }

  const appRoot = (() => { try { return dirname(execPath) } catch { return '' } })()
  // ③ 让 Node 的解析器替我们找：插件自己那棵树 + 桌面版应用包 + argv 所在的那棵树
  const reqFrom = [selfUrl, ...argPaths.filter((a) => /\.(?:js|mjs|cjs)$/i.test(a))]
  if (appRoot) reqFrom.push(join(appRoot, 'package.json'))
  for (const from of reqFrom) {
    if (!from) continue
    try {
      const req = createRequire(from)
      for (const spec of DSH_SPECS) {
        try {
          const p = req.resolve(spec)
          if (p && existsSync(p)) return p
        } catch { /* 换下一个 */ }
      }
    } catch { /* 解析器不可用 / 那个 package.json 不存在就跳过 */ }
  }
  // ④ 固定落点
  for (const p of dshCandidates({ explicit: '', execPath, env })) {
    if (existsSync(p)) return p
  }
  // ⑤ 兜底：在应用目录里做一次有界递归
  for (const root of dshScanRoots({ execPath, resourcesPath })) {
    const hit = scanForDsh(root, 0, { n: 0 }, scanLimits)
    if (hit) return hit
  }
  return ''
}

/** PATH 里到底有没有 dsh（有些用户手动配过 PATH 的 npm 全局） */
export const hasDshOnPath = (env = process.env, platform = process.platform) => {
  const exts = platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.ps1'] : ['']
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')
  for (const d of dirs) {
    const dir = d.replace(/^"|"$/g, '').trim()
    if (!dir) continue
    for (const e of exts) {
      try { if (existsSync(join(dir, 'dsh' + e))) return true } catch { /* 忽略坏路径 */ }
    }
  }
  return false
}
