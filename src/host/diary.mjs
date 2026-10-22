/**
 * src/host/diary.mjs —— 两本日记
 * ============================================================================
 * 来源：[`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale) 的 `diary` 设计（MIT）。
 * 一本给主人看（"今天为什么留这三条"），一本给自己（不加滤镜，写砸了也写）。
 *
 * ⚠️ 移植时发现的一个真问题：**whale 那两个文件只有提示词在要求 agent 写，代码里没有写入者。**
 *    表现是"日记功能看起来存在，但可能永远没有文件"。所以这里的定位不一样：
 *    `appendDiary()` 是**唯一写入口**，宿主必须主动调；agent 想写就调工具，不写就由宿主兜底记一行。
 *    —— 宁可日记朴素，也不要"这个功能其实是空的"。
 *
 * 格式：每个文件一天一份，`# 标题 · 日期` 开头，之后每条一个 `## HH:MM` 小节。
 * 为什么不是一个大文件：一天一份才好翻、好删、好同步（云桥只传摘要，不传全文）。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dayOf } from '../lib/time.mjs'

export const KINDS = {
  owner: { key: 'owner', title: '给主人的信', dir: 'diary-owner' },
  self: { key: 'self', title: '给自己的日记', dir: 'diary-self' },
}

const MAX_ENTRY = 8000
const MAX_FILE = 512 * 1024

const pad2 = (n) => String(n).padStart(2, '0')
const clockOf = (now) => `${pad2(new Date(now).getHours())}:${pad2(new Date(now).getMinutes())}`

/** 某一天某个本的路径 */
export function diaryPath(memoryDir, kind, now = Date.now()) {
  const k = KINDS[kind]
  if (!k) throw new Error(`未知的日记种类：${kind}`)
  return join(memoryDir, k.dir, `${dayOf(now)}.md`)
}

/**
 * 写一条。
 * @returns `{ ok, path, created }`；正文为空 / 太长 / 文件太大 → `{ ok:false, error }`（不抛）
 */
export function appendDiary(memoryDir, kind, text, { now = Date.now(), at } = {}) {
  const k = KINDS[kind]
  if (!k) return { ok: false, error: `未知的日记种类：${kind}` }
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: '日记正文是空的 —— 宁可写一句"今天没什么可写的"，也别写空条目' }
  if (body.length > MAX_ENTRY) return { ok: false, error: `单条日记太长（${body.length} 字，上限 ${MAX_ENTRY}）` }

  const path = diaryPath(memoryDir, kind, now)
  let created = false
  try {
    mkdirSync(join(memoryDir, k.dir), { recursive: true })
    const fresh = !existsSync(path)
    if (fresh) {
      created = true
      appendFileSync(path, `# ${k.title} · ${dayOf(now)}\n`, 'utf8')
    } else {
      try { if (statSync(path).size > MAX_FILE) return { ok: false, error: '今天的日记文件太长了（>512KB），先归档再写' } } catch { /* 读不到就照写 */ }
    }
    appendFileSync(path, `\n## ${at || clockOf(now)}\n${body}\n`, 'utf8')
    return { ok: true, path, created }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 读某一天（没有就空串，不抛） */
export function readDiary(memoryDir, kind, { now = Date.now() } = {}) {
  try { return readFileSync(diaryPath(memoryDir, kind, now), 'utf8') } catch { return '' }
}

/** 最近 N 天有哪些日记（倒序）。给设置页与状态卡用。 */
export function listDiaries(memoryDir, kind, limit = 14) {
  const k = KINDS[kind]
  if (!k) return []
  try {
    return readdirSync(join(memoryDir, k.dir))
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((n) => ({ day: n.replace(/\.md$/, ''), path: join(memoryDir, k.dir, n) }))
  } catch { return [] }
}

/**
 * 取最后一条正文（不含 `## HH:MM` 那行）。
 * 用途：她说"我昨天给自己写了什么"——状态卡只放这一小段，不放大整份。
 */
export function lastEntry(memoryDir, kind, { now = Date.now(), max = 400 } = {}) {
  const text = readDiary(memoryDir, kind, { now })
  if (!text) return ''
  const blocks = text.split(/\n## /).slice(1)
  if (!blocks.length) return ''
  const body = blocks[blocks.length - 1].split('\n').slice(1).join('\n').trim()
  return body.length > max ? body.slice(0, max) + '…' : body
}

/**
 * 最近几天里**最后一条正文**（今天还没动笔就往前找）。
 * 与 `lastEntry` 的差别：那个只看"今天"；而一轮醒来常在当天她还没写日记之前，
 * 状态卡要的是"她上次写的什么"，所以这里跨天找。找不到返回空串（不抛）。
 */
export function lastEntryAny(memoryDir, kind, { now = Date.now(), days = 7, max = 400 } = {}) {
  for (const d of listDiaries(memoryDir, kind, days)) {
    let text = ''
    try { text = readFileSync(d.path, 'utf8') } catch { continue }
    const blocks = text.split(/\n## /).slice(1)
    if (!blocks.length) continue
    const body = blocks[blocks.length - 1].split('\n').slice(1).join('\n').trim()
    if (!body) continue
    return body.length > max ? body.slice(0, max) + '…' : body
  }
  return ''
}

/** 今天写了没（"日记照写"是 skip 那档的硬要求，得能核对） */
export function hasToday(memoryDir, kind, now = Date.now()) {
  try { return existsSync(diaryPath(memoryDir, kind, now)) } catch { return false }
}

/**
 * 给通知用的摘要：今天两本各取一句。
 * 没写的那本**明说没写** —— 悄悄留白会让人以为"她今天什么都没想"。
 */
export function todayDigest(memoryDir, now = Date.now(), max = 200) {
  const one = (kind) => {
    const t = lastEntry(memoryDir, kind, { now, max })
    return t || '（今天没写）'
  }
  return { day: dayOf(now), owner: one('owner'), self: one('self'), wrote: { owner: hasToday(memoryDir, 'owner', now), self: hasToday(memoryDir, 'self', now) } }
}
