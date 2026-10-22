/**
 * src/lib/migrate.mjs —— 一次性搬迁：把两个老家的东西并到 `$DSH_HOME/bili/`
 * ============================================================================
 * 三条规矩（每一条都是为了"错了还能退回去"）：
 *   ① **幂等**：搬完写 `.migrated-v1`，之后每次启动只看这个标记，不做任何事。
 *   ② **不删老东西**：能 rename 就 rename（同盘、O(1)、连 .venv 一起走）；
 *      rename 不了就只拷小文件，`.venv*` / `bin` / `uv-cache` 这类大目录跳过并记日志。
 *   ③ **老配置留一份原文**：`config.json` 被新形状覆盖前，先存成 `config.legacy.json`。
 *
 * 为什么敢 rename：老的 `bili-duty/` 里全是插件自己的产物（报告、判重表、venv），
 * 没有用户手写的东西 —— 唯一例外是 `duty.md`（章程），它照原样跟着走，不重新生成。
 * ============================================================================
 */
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { fromLegacy, readConfig, writeConfig } from './config.mjs'
import { homePaths, legacyPaths, resolveBiliHome } from './paths.mjs'

/** 拷贝时跳过的大目录：几 GB 的 Python 环境不值得复制一份 */
const HEAVY = new Set(['.venv', '.venv-asr', 'bin', 'uv-cache', 'uv-tools', 'uv-python', '.hf-cache', 'tmp', 'node_modules'])

const readJson = (f, def = null) => {
  try { return JSON.parse(String(readFileSync(f, 'utf8')).replace(/^\uFEFF/, '')) } catch { return def }
}
const readText = (f, def = '') => { try { return readFileSync(f, 'utf8') } catch { return def } }
const mk = (d) => { try { mkdirSync(d, { recursive: true }) } catch { /* 建不了让调用方报 */ } }

/**
 * 解析 scroll 的判重表（`| 日期 | bvid | 标题 | UP | 状态 |`）。
 * 导出来是为了单测：这段正则和 2.0 里 `index.js:1587` 那三处必须口径一致。
 */
export function parseSeenTable(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((s) => s.trim())
    const c = cells.slice(1, cells.length - 1)
    if (c.length < 5) continue
    const [day, bvid, title, up, status] = c
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const key = bvid + '@' + day
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      day, bvid, title, up, status,
      picked: status.includes('挑了'),
      delivered: /评论|私信|已发/.test(status),
      url: 'https://www.bilibili.com/video/' + bvid,
    })
  }
  return out
}

/** whale 的发言账 `{log:[{at,type,auto,share,target,note}]}` → 统一账本 */
export function convertWhaleQuota(quota) {
  const log = Array.isArray(quota?.log) ? quota.log : []
  return {
    v: 1,
    source: 'whale',
    entries: log.map((x) => ({
      at: String(x?.at ?? ''),
      kind: String(x?.type ?? ''),
      share: Boolean(x?.share),
      target: x?.target == null ? null : String(x.target),
      note: String(x?.note ?? ''),
    })),
  }
}

/**
 * 老配置里的**绝对路径**要跟着家一起搬。
 * 例：`bili-duty/` 整体 rename 成 `bili/` 之后，老的
 * `C:\Users\Y\.dsh\bili-duty\.venv\Scripts\python.exe` 已经不存在了 ——
 * 原样抄进新 config 的话，升级后第一轮 MCP 直接 `spawn ... ENOENT`（真机踩到过）。
 * 只改「就在老家里面」的值；`python`、别的盘、用户自己装的解释器一律不动。
 * 分隔符风格跟着原值走（Windows 反斜杠 / POSIX 斜杠都行）。
 */
export function rewriteMovedPath(value, oldRoot, newRoot) {
  const s = String(value ?? '')
  if (!s) return s
  const asPosix = (x) => String(x ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const oldPosix = asPosix(oldRoot)
  const newPosix = asPosix(newRoot)
  if (!oldPosix || !newPosix || oldPosix === newPosix) return s
  const v = asPosix(s)
  const oldLower = oldPosix.toLowerCase()
  const vLower = v.toLowerCase()
  if (vLower !== oldLower && !vLower.startsWith(oldLower + '/')) return s
  const moved = newPosix + v.slice(oldPosix.length)
  return s.includes('\\') ? moved.replace(/\//g, '\\') : moved
}

/** 只拷贝浅层的小文件（重目录整个跳过） */
function copySmallTree(from, to, log) {
  if (!existsSync(from)) return 0
  mk(`${to}`)
  let n = 0
  for (const name of readdirSync(from)) {
    if (HEAVY.has(name)) { log?.(`跳过重目录：${join(from, name)}`); continue }
    const src = join(from, name)
    const dst = join(to, name)
    let st
    try { st = statSync(src) } catch { continue }
    try {
      if (st.isDirectory()) { cpSync(src, dst, { recursive: true, force: false, errorOnExist: false }); n += 1 }
      else if (!existsSync(dst)) { copyFileSync(src, dst); n += 1 }
    } catch (e) { log?.(`拷贝失败 ${src}：${e?.message ?? e}`) }
  }
  return n
}

/**
 * 生成搬迁计划（不落盘）。诊断接口与测试用它回答"这次启动会动什么"。
 */
export function planMigration(env = process.env) {
  const p = homePaths(resolveBiliHome(env))
  const L = legacyPaths(env)
  return {
    home: p.home,
    alreadyDone: existsSync(p.migratedMarker),
    renameScrollDir: !existsSync(p.home) && existsSync(L.scrollDir),
    scrollConfig: existsSync(L.scrollConfig),
    whaleConfig: existsSync(L.whaleConfig),
    whaleNight: existsSync(L.whaleNight),
    whalePersona: existsSync(join(L.whaleAiDir, 'persona.md')),
    whaleQuota: existsSync(join(L.whaleAiDir, 'quota.json')),
    whaleReplied: existsSync(join(L.whaleAiDir, 'replied.json')),
    scrollSeen: existsSync(join(L.scrollDir, 'seen.md')),
  }
}

/**
 * 真正搬。返回 `{ ok, skipped, home, moved, imported, warnings }`。
 * 任何一步失败都只是记 warning，不让插件起不来 —— 迁不动就用旧的，也比装不上强。
 */
export function migrateIfNeeded({ env = process.env, log = () => {}, dryRun = false } = {}) {
  const L = legacyPaths(env)
  const p = homePaths(resolveBiliHome(env))
  const warnings = []
  const imported = []
  const moved = []

  if (existsSync(p.migratedMarker)) return { ok: true, skipped: true, home: p.home, moved, imported, warnings }

  const plan = planMigration(env)
  if (dryRun) return { ok: true, dryRun: true, home: p.home, plan, moved, imported, warnings }

  /* ① 老家：优先整体 rename（连 .venv 一起走，不复制几 GB）
     ⚠️ 顺序要紧：**先 rename 再建目录** —— 先 mkdir 会让 rename 撞上非空目录（单测逮到的） */
  if (plan.renameScrollDir) {
    try {
      renameSync(L.scrollDir, p.home)
      moved.push(`rename ${L.scrollDir} → ${p.home}`)
      // 留一个说明：老版本的插件还会往这个路径写，别让它看起来像"数据丢了"
      mk(L.scrollDir)
      writeFileSync(join(L.scrollDir, 'MOVED.md'), [
        '# 这个目录已经搬走了',
        '',
        `新的家在 \`${p.home}\`（dsh-bili-scroll 2.1 起）。`,
        '',
        '- 老的报告、判重表、Python 环境都在新家，没有丢。',
        '- 如果你还装着 2.0 或更早的版本，它会把这里当成空目录重新建环境 —— 升级到 2.1 就不会了。',
        '- 确认新版本一切正常之后，这个目录可以整个删掉。',
        '',
      ].join('\n'), 'utf8')
    } catch (e) {
      warnings.push(`rename 失败，改为拷贝小文件：${e?.message ?? e}`)
      copySmallTree(L.scrollDir, p.home, (m) => warnings.push(m))
    }
  } else if (existsSync(L.scrollDir) && !existsSync(p.config)) {
    // 已经存在新家但没有配置文件（比如上次中途失败）→ 补拷
    copySmallTree(L.scrollDir, p.home, (m) => warnings.push(m))
  }

  mk(p.home)

  for (const d of [p.out, p.digest, p.reports, p.ledgerDir, p.memoryDir, p.diaryOwner, p.diarySelf, p.syncDir]) mk(d)

  /* ② 老配置：原文留底，再写新形状
     ⚠️ 老家已经被 rename 过来了 ⇒ 旧配置**现在在新家里**（`p.config`），
        再去读 `$DSH_HOME/bili-duty/config.json` 只会读到空（单测逮到的） */
  const scrollRaw = readJson(p.config, null) ?? readJson(L.scrollConfig, {}) ?? {}
  const whaleRaw = readJson(L.whaleConfig, {}) ?? {}
  const whaleNightRaw = readJson(L.whaleNight, {}) ?? {}

  if (existsSync(p.config)) {
    try { copyFileSync(p.config, join(p.home, 'config.legacy.json')); imported.push('config.legacy.json') } catch { /* 已经有一份就不覆盖 */ }
  } else if (Object.keys(scrollRaw).length) {
    try {
      writeFileSync(join(p.home, 'config.legacy.json'), JSON.stringify(scrollRaw, null, 2) + '\n', 'utf8')
      imported.push('config.legacy.json')
    } catch (e) { warnings.push(`留底老配置失败：${e?.message ?? e}`) }
  }

  const built = fromLegacy(scrollRaw, whaleRaw, whaleNightRaw)
  // ⭐ 2026-10-22：家是 rename 过来的 ⇒ 老配置里的绝对路径（主要是 run.pythonPath）还指着旧位置。
  //    不跟着改的话，升级后第一轮 MCP 起不来（`spawn ...bili-duty\.venv... ENOENT`）—— 真机上撞到过。
  const rewritten = []
  const oldPy = built.config.run.pythonPath
  const newPy = rewriteMovedPath(oldPy, L.scrollDir, p.home)
  if (newPy !== oldPy) { built.config.run.pythonPath = newPy; rewritten.push(`run.pythonPath：${oldPy} → ${newPy}`) }
  try {
    writeConfig(p.config, built.config)
    imported.push('config.json')
  } catch (e) { warnings.push(`写 config.json 失败：${e?.message ?? e}`) }
  if (built.conflicts.length) warnings.push(`有 ${built.conflicts.length} 个字段两边不一致，按 scroll 的保留：` + built.conflicts.map((c) => c.field).join(', '))

  /* ③ 人设：whale 的 persona.md 是唯一真相源，搬过来；老的 personaPrompt 留在配置里当兜底 */
  const whalePersona = join(L.whaleAiDir, 'persona.md')
  if (existsSync(whalePersona) && !existsSync(p.persona)) {
    try { copyFileSync(whalePersona, p.persona); imported.push('persona.md') } catch (e) { warnings.push(`搬人设失败：${e?.message ?? e}`) }
  }

  /* ④ 凭据：两个项目字段名一样（sessdata/bili_jct/buvid3），直接搬两份（Python 侧认老名字） */
  const legacyCred = join(p.home, 'bili_credential.json')
  const whaleCred = join(L.whaleAiDir, 'credentials.json')
  if (!existsSync(legacyCred) && existsSync(whaleCred)) {
    try { copyFileSync(whaleCred, legacyCred); imported.push('bili_credential.json（来自 whale）') } catch (e) { warnings.push(`搬凭据失败：${e?.message ?? e}`) }
  }
  if (existsSync(legacyCred) && !existsSync(p.credential)) {
    try { copyFileSync(legacyCred, p.credential); imported.push('credential.json') } catch (e) { warnings.push(`复制凭据失败：${e?.message ?? e}`) }
  }

  /* ⑤ 账本：判重表 → jsonl（表本身保留，老的列表代码还在读它） */
  const seenText = readText(p.seen, '')
  if (seenText && !existsSync(p.seenLedger)) {
    try {
      const rows = parseSeenTable(seenText)
      writeFileSync(p.seenLedger, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
      imported.push(`ledger/seen.jsonl（${rows.length} 条）`)
    } catch (e) { warnings.push(`转判重表失败：${e?.message ?? e}`) }
  }

  /* ⑥ whale 的两本账 */
  const whaleQuota = readJson(join(L.whaleAiDir, 'quota.json'))
  if (whaleQuota && !existsSync(p.shares)) {
    try { writeFileSync(p.shares, JSON.stringify(convertWhaleQuota(whaleQuota), null, 2) + '\n', 'utf8'); imported.push('ledger/shares.json') } catch (e) { warnings.push(`转发言账失败：${e?.message ?? e}`) }
  }
  const whaleReplied = readJson(join(L.whaleAiDir, 'replied.json'))
  if (whaleReplied?.byUid && !existsSync(p.replies)) {
    try { writeFileSync(p.replies, JSON.stringify({ v: 1, byUid: whaleReplied.byUid }, null, 2) + '\n', 'utf8'); imported.push('ledger/replies.json') } catch (e) { warnings.push(`转回复账失败：${e?.message ?? e}`) }
  }

  /* ⑦ whale 的两本日记：原样搬进 memory/，不猜格式（它本来就没有格式） */
  const wd1 = join(L.scrollDir, '..', 'whale-diary.md')
  const wd2 = join(L.scrollDir, '..', 'whale-diary-private.md')
  if (existsSync(wd1) && !existsSync(join(p.diaryOwner, 'legacy-whale.md'))) {
    try { copyFileSync(wd1, join(p.diaryOwner, 'legacy-whale.md')); imported.push('memory/diary-owner/legacy-whale.md') } catch (e) { warnings.push(`搬日记失败：${e?.message ?? e}`) }
  }
  if (existsSync(wd2) && !existsSync(join(p.diarySelf, 'legacy-whale.md'))) {
    try { copyFileSync(wd2, join(p.diarySelf, 'legacy-whale.md')); imported.push('memory/diary-self/legacy-whale.md') } catch (e) { warnings.push(`搬私日记失败：${e?.message ?? e}`) }
  }

  /* ⑧ 落标记 + 一份人能看懂的报告 */
  const report = {
    at: new Date().toISOString(),
    from: { scroll: L.scrollDir, whaleAi: L.whaleAiDir, whaleConfig: L.whaleConfig },
    to: p.home,
    moved, imported, warnings, rewritten,
    mapped: built.mapped, conflicts: built.conflicts, dropped: built.dropped,
  }
  try {
    writeFileSync(p.migratedMarker, JSON.stringify(report, null, 2) + '\n', 'utf8')
    writeFileSync(join(p.home, 'MIGRATION.md'), [
      '# 这次搬迁做了什么',
      '',
      `- 新家：\`${p.home}\``,
      `- 从：\`${L.scrollDir}\`、\`${L.whaleAiDir}\``,
      ...(moved.length ? ['', '## 整体搬过来的', ...moved.map((m) => `- ${m}`)] : []),
      ...(imported.length ? ['', '## 逐项合并的', ...imported.map((m) => `- ${m}`)] : []),
      ...(rewritten.length ? ['', '## 跟着家一起改掉的路径', ...rewritten.map((m) => `- ${m}`)] : []),
      ...(warnings.length ? ['', '## 没搬成 / 需要注意的', ...warnings.map((m) => `- ${m}`)] : []),
      '',
      '> 老位置的东西**一个都没删**。确认新版一切正常后可以手动清掉。',
      '',
    ].join('\n'), 'utf8')
  } catch (e) { warnings.push(`写搬迁报告失败：${e?.message ?? e}`) }

  for (const m of imported) log(`搬进来：${m}`)
  for (const m of rewritten) log(`路径已改到新家：${m}`)
  for (const w of warnings) log(`注意：${w}`)
  return { ok: warnings.length === 0, skipped: false, home: p.home, moved, imported, warnings, report }
}

/** 供测试与诊断：算出某个 env 下会用的家目录，不制造任何副作用 */
export function homeOf(env = process.env) {
  return resolveBiliHome(env)
}

export const _internal = { isHeavy: (n) => HEAVY.has(n), basename }
