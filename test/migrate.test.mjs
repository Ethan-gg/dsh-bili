/**
 * 迁移器单测：两个老家 → 一个家，幂等，不删东西
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertWhaleQuota, migrateIfNeeded, parseSeenTable, planMigration, rewriteMovedPath } from '../src/lib/migrate.mjs'
import { fromLegacy } from '../src/lib/config.mjs'
import { homePaths } from '../src/lib/paths.mjs'

/** 造一个"装过 2.0 + 装过 whale"的假机器 */
function fakeMachine() {
  const root = mkdtempSync(join(tmpdir(), 'bili-mig-'))
  const dsh = join(root, '.dsh')
  const old = join(dsh, 'bili-duty')
  const ai = join(root, '.bili-ai')
  mkdirSync(old, { recursive: true })
  mkdirSync(join(old, 'out'), { recursive: true })
  mkdirSync(join(old, '.venv', 'Lib'), { recursive: true })     // 重目录，迁移时不该被复制
  mkdirSync(ai, { recursive: true })

  writeFileSync(join(old, 'config.json'), JSON.stringify({
    perDay: 6, peakValley: true, autoComment: true, mentionName: 'Gmnnm',
    dmMode: 'only', dmUid: 42, replyToComments: true, _set: ['perDay'],
    // ⭐ 老配置里的绝对路径：家 rename 之后这个路径就失效了，迁移要跟着改（2026-10-22）
    pythonPath: join(old, '.venv', 'Scripts', 'python.exe'),
  }), 'utf8')
  writeFileSync(join(old, 'duty.md'), '# 章程\n', 'utf8')
  writeFileSync(join(old, 'charter.sha256'), 'abc', 'utf8')
  writeFileSync(join(old, 'bili_credential.json'), JSON.stringify({ sessdata: 's', bili_jct: 'j', buvid3: 'b' }), 'utf8')
  writeFileSync(join(old, 'out', '2026-10-20.md'), '### BV1xx411c7mD\n', 'utf8')
  writeFileSync(join(old, 'seen.md'), [
    '# 判重表',
    '',
    '| 日期 | bvid | 标题 | UP | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '| 2026-10-20 | BV1xx411c7mD | 一条视频 | 某UP | 挑了·评论 |',
    '| 2026-10-20 | BV1xx411c7mD | 重复行 | 某UP | 挑了 |',
    '| 2026-10-21 | BV1yy411c7mE | 另一条 | 某UP | 跳过（无字幕） |',
    '',
  ].join('\n'), 'utf8')

  writeFileSync(join(ai, 'credentials.json'), JSON.stringify({ sessdata: 's2', bili_jct: 'j2', buvid3: 'b2' }), 'utf8')
  writeFileSync(join(ai, 'persona.md'), '# 我是谁\n一条鱼。\n', 'utf8')
  writeFileSync(join(ai, 'quota.json'), JSON.stringify({
    log: [{ at: '2026-10-21T20:00:00.000Z', type: 'share', share: true, target: 'BV1', note: '第一条' }],
  }), 'utf8')
  writeFileSync(join(ai, 'replied.json'), JSON.stringify({ byUid: { 9: [{ at: '2026-10-21T21:00:00.000Z', target: 'BV2' }] } }), 'utf8')

  const env = { DSH_HOME: dsh, USERPROFILE: root, HOME: root }
  return { root, old, ai, env }
}

test('parseSeenTable：只认合法行，同一天同 BV 只留第一条', () => {
  const rows = parseSeenTable([
    '| 日期 | bvid | 标题 | UP | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '| 2026-10-20 | BV1xx411c7mD | 一条视频 | 某UP | 挑了·评论 |',
    '| 2026-10-20 | BV1xx411c7mD | 重复 | 某UP | 挑了 |',
    '| 2026-10-21 | BV1yy411c7mE | 另一条 | 某UP | 跳过 |',
    '| 不是表格 | BV1xx411c7mD | x | y | z |',
    '| 2026-10-21 | 不是bv | x | y | z |',
  ].join('\n'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].bvid, 'BV1xx411c7mD')
  assert.equal(rows[0].picked, true)
  assert.equal(rows[0].delivered, true)
  assert.equal(rows[1].delivered, false)
})

test('convertWhaleQuota：账本条目原样搬，形状换成统一的', () => {
  const out = convertWhaleQuota({ log: [{ at: '2026-10-21T20:00:00Z', type: 'share', share: true, target: 'BV1', note: 'n' }] })
  assert.equal(out.v, 1)
  assert.equal(out.entries.length, 1)
  assert.equal(out.entries[0].share, true)
  assert.equal(convertWhaleQuota(null).entries.length, 0)
})

test('planMigration：什么都不做也能看清会动什么', () => {
  const m = fakeMachine()
  const plan = planMigration(m.env)
  assert.equal(plan.alreadyDone, false)
  assert.equal(plan.renameScrollDir, true)
  assert.equal(plan.scrollConfig, true)
  assert.equal(plan.whalePersona, true)
  assert.equal(plan.whaleQuota, true)
})

test('migrateIfNeeded：整目录搬过去 + 逐项合并 + 落标记', () => {
  const m = fakeMachine()
  const logs = []
  const r = migrateIfNeeded({ env: m.env, log: (s) => logs.push(s) })
  assert.equal(r.skipped, false)
  const p = homePaths(r.home)

  // ① 老目录整体 rename 过来（连 out/ 和 .venv/ 一起走，不复制）
  assert.equal(existsSync(m.old), true)                        // 留了一个说明用的小目录
  assert.equal(existsSync(join(m.old, 'MOVED.md')), true)
  assert.equal(existsSync(join(p.home, 'out', '2026-10-20.md')), true)
  assert.equal(existsSync(join(p.home, '.venv', 'Lib')), true)
  assert.equal(existsSync(join(p.home, 'duty.md')), true)
  assert.equal(existsSync(join(p.home, 'charter.sha256')), true)
  assert.equal(existsSync(join(p.home, 'bili_credential.json')), true)

  // ② 配置：原文留底 + 新形状
  const legacyCopy = JSON.parse(readFileSync(join(p.home, 'config.legacy.json'), 'utf8'))
  assert.equal(legacyCopy.perDay, 6)
  const cfg = JSON.parse(readFileSync(p.config, 'utf8'))
  assert.equal(cfg.version, 1)
  assert.equal(cfg.feed.perDay, 6)
  assert.equal(cfg.account.mentionName, 'Gmnnm')
  assert.equal(cfg.dm.mode, 'only')
  assert.equal(cfg.share.enabled, true)
  // ⭐ pythonPath 必须跟着家一起改到新路径 —— 否则升级后第一轮 MCP 直接
  //   `spawn C:\...\bili-duty\.venv\Scripts\python.exe ENOENT`（2026-10-22 真机撞到）
  assert.equal(cfg.run.pythonPath, join(p.home, '.venv', 'Scripts', 'python.exe'))
  assert.ok(r.report.rewritten.some((x) => x.includes('run.pythonPath')), '搬迁报告要记下改了哪个路径')

  // ③ 人设 / 凭据 / 账本 / 日记
  assert.equal(readFileSync(p.persona, 'utf8').includes('一条鱼'), true)
  assert.equal(existsSync(p.credential), true)
  assert.equal(JSON.parse(readFileSync(p.credential, 'utf8')).sessdata, 's')   // scroll 那份优先
  const seenLedger = readFileSync(p.seenLedger, 'utf8').trim().split('\n')
  assert.equal(seenLedger.length, 2)
  assert.equal(JSON.parse(seenLedger[0]).bvid, 'BV1xx411c7mD')
  assert.equal(JSON.parse(readFileSync(p.shares, 'utf8')).entries.length, 1)
  assert.equal(Object.keys(JSON.parse(readFileSync(p.replies, 'utf8')).byUid).length, 1)

  // ④ 标记与报告
  assert.equal(existsSync(p.migratedMarker), true)
  assert.equal(existsSync(join(p.home, 'MIGRATION.md')), true)
  assert.ok(logs.some((l) => l.includes('config.json')))
})

test('migrateIfNeeded：第二次跑什么都不做（幂等）', () => {
  const m = fakeMachine()
  const first = migrateIfNeeded({ env: m.env, log: () => {} })
  const cfgBefore = readFileSync(homePaths(first.home).config, 'utf8')
  const mtimeBefore = statSync(homePaths(first.home).config).mtimeMs

  const second = migrateIfNeeded({ env: m.env, log: () => {} })
  assert.equal(second.skipped, true)
  assert.equal(readFileSync(homePaths(first.home).config, 'utf8'), cfgBefore)
  assert.equal(statSync(homePaths(first.home).config).mtimeMs, mtimeBefore)
})

test('migrateIfNeeded：只有 whale、没装过 scroll，也能建出一个完整的家', () => {
  const root = mkdtempSync(join(tmpdir(), 'bili-whaleonly-'))
  const dsh = join(root, '.dsh')
  const ai = join(root, '.bili-ai')
  mkdirSync(join(dsh, 'bili-whale.config.json').replace(/bili-whale\.config\.json$/, ''), { recursive: true })
  mkdirSync(ai, { recursive: true })
  writeFileSync(join(dsh, 'bili-whale.config.json'), JSON.stringify({
    owner: { mid: '11' }, quota: { shareDaily: 2 }, notify: { type: 'webhook', url: 'https://a/b' },
  }), 'utf8')
  writeFileSync(join(ai, 'persona.md'), '人设', 'utf8')

  const env = { DSH_HOME: dsh, USERPROFILE: root, HOME: root }
  const r = migrateIfNeeded({ env, log: () => {} })
  const p = homePaths(r.home)
  const cfg = JSON.parse(readFileSync(p.config, 'utf8'))
  assert.equal(cfg.account.ownerUid, 11)
  assert.equal(cfg.share.daily, 2)
  assert.equal(cfg.notify.type, 'webhook')
  assert.equal(readFileSync(p.persona, 'utf8'), '人设')
  for (const d of [p.out, p.digest, p.ledgerDir, p.memoryDir, p.syncDir]) assert.equal(existsSync(d), true)
})

test('迁移：老配置里没写 dmMode 时，投递方式保持 2.0 的默认（只私信）', () => {
  // 2.0 的 schema 默认是 `only`（CHANGELOG 写着"私信投递成为默认"）。
  // 迁移只读 config.json、读不到宿主那层 schema 默认值 ⇒ 新默认必须对齐，否则升级后开始公开发评论。
  assert.equal(fromLegacy({}, {}).config.dm.mode, 'only')
  assert.equal(fromLegacy({ dmMode: 'off' }, {}).config.dm.mode, 'off')
  assert.equal(fromLegacy({ dmMode: 'both' }, {}).config.dm.mode, 'both')
})

test('迁移：老配置里没写 dmWatch 时，私信监听保持 2.0 的默认（开）', () => {
  // 2.0 的 schema/DEFAULTS 都是 true，而且 2.0 把「私信双向」当成默认功能。
  // 新配置的默认若是 false，升级当天就会出现"以前会回我私信，现在不回了"。
  assert.equal(fromLegacy({ perDay: 6 }, {}).config.listen.dm, true)
  // 明确关过的要尊重
  assert.equal(fromLegacy({ dmWatch: false }, {}).config.listen.dm, false)
})

test('migrateIfNeeded：dryRun 只算不写', () => {
  const m = fakeMachine()
  const r = migrateIfNeeded({ env: m.env, dryRun: true, log: () => {} })
  assert.equal(r.dryRun, true)
  assert.equal(existsSync(join(m.env.DSH_HOME, 'bili')), false)
  assert.equal(existsSync(join(m.old, 'seen.md')), true)
})

test('rewriteMovedPath：只改「就在老家里面」的绝对路径，其余原样', () => {
  const oldRoot = join('C:', 'Users', 'Y', '.dsh', 'bili-duty')
  const newRoot = join('C:', 'Users', 'Y', '.dsh', 'bili')
  const sep = oldRoot.includes('\\') ? '\\' : '/'
  const withSep = (...parts) => join(...parts)

  // ① 就在老家里面 ⇒ 跟着家走（这就是 pythonPath 那个坑）
  assert.equal(
    rewriteMovedPath(withSep(oldRoot, '.venv', 'Scripts', 'python.exe'), oldRoot, newRoot),
    withSep(newRoot, '.venv', 'Scripts', 'python.exe'),
  )
  // ② 'python' / 别处的解释器 ⇒ 一个字都不动
  assert.equal(rewriteMovedPath('python', oldRoot, newRoot), 'python')
  assert.equal(rewriteMovedPath(withSep('C:', 'Python311', 'python.exe'), oldRoot, newRoot), withSep('C:', 'Python311', 'python.exe'))
  // ③ 只是名字像、并不是老家 ⇒ 不动（防误伤 bili-duty-old 这种目录）
  assert.equal(rewriteMovedPath(oldRoot + '-old' + sep + 'x', oldRoot, newRoot), oldRoot + '-old' + sep + 'x')
  // ④ 大小写不同也认（Windows 路径不区分大小写）
  const upper = withSep(oldRoot.replace('bili-duty', 'BILI-DUTY'), '.venv', 'Scripts', 'python.exe')
  assert.equal(rewriteMovedPath(upper, oldRoot, newRoot), withSep(newRoot, '.venv', 'Scripts', 'python.exe'))
  // ⑤ 正斜杠写法（用户手填的 C:/…/python.exe）原样保留正斜杠
  const fwd = oldRoot.replace(/\\/g, '/') + '/.venv/Scripts/python.exe'
  assert.equal(rewriteMovedPath(fwd, oldRoot, newRoot), newRoot.replace(/\\/g, '/') + '/.venv/Scripts/python.exe')
  // ⑥ 空值原样
  assert.equal(rewriteMovedPath('', oldRoot, newRoot), '')
})
