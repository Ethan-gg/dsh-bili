/**
 * `src/lib/dsh.mjs` 的测试 —— 找 dsh CLI 的那套逻辑
 * ⭐ 起因：2.1.1 在本机（桌面版 portable 构建，D:\Software\DS Harness）自检写着「dsh：没找到」，
 *    可 `dsh Desktop.exe` 旁边的 `node_modules/@deepseek-ai/dsh/lib/bin.js` 明明就在
 *    —— 老逻辑只从 `resources/` 往下搜，漏掉了**应用根目录**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDshCli, dshCandidates, dshScanRoots, hasDshOnPath, looksLikeDshBin, scanForDsh } from '../src/lib/dsh.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-find-'))
const touch = (p, body = '// dsh\n') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body) }
const BIN_REL = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

test('candidates：应用根目录的 node_modules 排在前面', () => {
  const appRoot = join(tmpdir(), 'Some App')
  const list = dshCandidates({ execPath: join(appRoot, 'dsh Desktop.exe'), env: {} })
  assert.equal(list[0], join(appRoot, BIN_REL))
  assert.ok(list.some((p) => p.includes(join('resources', 'app.asar.unpacked'))))
})

test('桌面版 portable 构建：exe 旁边 node_modules 里有 dsh ⇒ 找得到', () => {
  const root = tmp()
  try {
    const appRoot = join(root, 'Some App')
    touch(join(appRoot, BIN_REL))
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '^0.2.1' } }))
    const hit = findDshCli({ execPath: join(appRoot, 'dsh Desktop.exe'), env: {}, selfUrl: join(appRoot, 'plug', 'index.js') })
    assert.equal(hit, join(appRoot, BIN_REL))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('桌面版 asar 解包形状：resources/app.asar.unpacked 里也能找到（有界递归兜底）', () => {
  const root = tmp()
  try {
    const appRoot = join(root, 'Some App')
    const bin = join(appRoot, 'resources', 'app.asar.unpacked', BIN_REL)
    touch(bin)
    const hit = findDshCli({
      execPath: join(appRoot, 'dsh Desktop.exe'),
      resourcesPath: join(appRoot, 'resources'),
      env: {},
      selfUrl: join(appRoot, 'plug', 'index.js'),
    })
    assert.equal(hit, bin)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('桌面版真正的宿主形状：宿主只是 node.exe，argv[1] 才是 dsh 的 bin.js', () => {
  const root = tmp()
  try {
    // 2026-10-23 实测的进程树：
    //   dsh Desktop.exe（Electron）
    //     └─ D:\Software\nodejs\node.exe "<app>/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web …
    // ⇒ process.execPath 是 node.exe，dirname 指不到 dsh；argv[1] 才是。
    const bin = join(root, 'Some App', BIN_REL)
    touch(bin)
    const hit = findDshCli({
      execPath: join(root, 'nodejs', 'node.exe'),
      env: {},
      selfUrl: join(root, 'plug', 'index.js'),
      argv: [join(root, 'nodejs', 'node.exe'), bin, '--profile', 'web'],
    })
    assert.equal(hit, bin)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('looksLikeDshBin：只认 <前缀>/@deepseek-ai/dsh/lib/bin.js', () => {
  assert.equal(looksLikeDshBin('D:\\a\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'), true)
  assert.equal(looksLikeDshBin('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'), true)
  assert.equal(looksLikeDshBin('D:\\Software\\nodejs\\node.exe'), false)
  assert.equal(looksLikeDshBin('D:\\a\\@deepseek-ai\\other\\lib\\bin.js'), false)
  assert.equal(looksLikeDshBin(''), false)
})

test('用户手填的 dshBin 优先（存在才用）', () => {
  const root = tmp()
  try {
    const appRoot = join(root, 'Some App')
    touch(join(appRoot, BIN_REL))
    const mine = join(root, 'my-dsh', 'lib', 'bin.js')
    touch(mine)
    assert.equal(findDshCli({ explicit: mine, execPath: join(appRoot, 'dsh Desktop.exe'), env: {} }), mine)
    // 填错了（不存在）就跳过，继续自动找
    assert.equal(findDshCli({ explicit: join(root, 'nope.js'), execPath: join(appRoot, 'dsh Desktop.exe'), env: {} }), join(appRoot, BIN_REL))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('真找不到时返回空串（调用方才会「出声」，不硬退化成裸 dsh）', () => {
  const root = tmp()
  try {
    assert.equal(findDshCli({ execPath: join(root, 'dsh Desktop.exe'), env: {}, selfUrl: join(root, 'plug', 'index.js') }), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('scanForDsh：有界递归只认 dsh/lib/bin.js，且深度/目录数有上限', () => {
  const root = tmp()
  try {
    const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'dsh', 'lib')
    touch(join(deep, 'bin.js'))
    // depth > maxDepth 不进去 ⇒ 找不到
    assert.equal(scanForDsh(root, 0, { n: 0 }, { maxDepth: 3 }), '')
    // 预算 0 也不翻
    assert.equal(scanForDsh(root, 0, { n: 4001 }, {}), '')
    // 给足预算/深度就找得到
    assert.equal(scanForDsh(root, 0, { n: 0 }, { maxDepth: 12 }), join(deep, 'bin.js'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dshScanRoots：应用根目录排在 resources 之前', () => {
  const root = tmp()
  try {
    const appRoot = join(root, 'Some App')
    mkdirSync(join(appRoot, 'resources'), { recursive: true })
    const roots = dshScanRoots({ execPath: join(appRoot, 'dsh Desktop.exe'), resourcesPath: join(appRoot, 'resources') })
    assert.equal(roots[0], appRoot)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('hasDshOnPath：PATH 里有没有 dsh', () => {
  const root = tmp()
  try {
    const d1 = join(root, 'bin1')
    mkdirSync(d1, { recursive: true })
    writeFileSync(join(d1, 'dsh.cmd'), '@echo off\n')
    assert.equal(hasDshOnPath({ PATH: `${root}\\nope;${d1}` }, 'win32'), true)
    assert.equal(hasDshOnPath({ PATH: join(root, 'nope') }, 'win32'), false)
    assert.equal(hasDshOnPath({}), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
