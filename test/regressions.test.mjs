/**
 * 结构回归：这里守的是**已经修过的坑不许被改回去**。
 * ============================================================================
 * 为什么用"读源码 + 匹配"而不是跑起来：`index.js` 的这些东西都长在 `apply(ctx)` 的闭包里
 * （`runDuty`、`ensureOverlay`、HTTP 路由），要跑起来得先造一个假宿主 + schemastery 树。
 * 那种测试写起来贵、跑起来脆，而且它验证的其实是"宿主能不能跑"，不是"这条规矩还在不在"。
 * 所以这里退一步：**只断言形状**，把"为什么"写在断言旁边。
 * 真行为由 `test/config|migrate|sync` 那三份覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('POST /config 的字段白名单从 DEFAULTS 推导（2.0 手写时漏了 7 个键）', () => {
  assert.match(INDEX, /const CFG_KEYS = Object\.keys\(DEFAULTS\)/, 'CFG_KEYS 必须从 DEFAULTS 推导')
  assert.match(INDEX, /for \(const k of CFG_KEYS\)/, '路由必须用 CFG_KEYS 过滤')
  // 反证：不许再出现"手写一串键名"的老写法
  assert.doesNotMatch(INDEX, /for \(const k of \['perDay', 'peakValley'/, '手写白名单是那个 bug 本身')
})

test('一轮在跑的时候不许再起一轮（dutyBusy 锁）', () => {
  assert.match(INDEX, /let dutyBusy = null/, '要有这把锁')
  assert.match(INDEX, /if \(dutyBusy\)/, '入口要检查')
  // 锁必须在这三处释放，少一处就会"永远在跑"
  assert.match(INDEX, /dutyBusy = null\s*\/\/ ⭐ 先放锁/)
  assert.match(INDEX, /child\.on\('error',[\s\S]{0,120}dutyBusy = null/, 'spawn 失败也要放锁')
  assert.match(INDEX, /catch \(e\) \{\n\s*dutyBusy = null/, '同步抛错也要放锁')
})

test('overlay 每次一个唯一名字 + 用完删掉 + 启动清扫', () => {
  assert.doesNotMatch(INDEX, /join\(stateDir, 'headless-overlay\.yml'\)/, '固定名字会互相覆盖')
  assert.match(INDEX, /headless-overlay-\$\{process\.pid\}-\$\{Date\.now\(\)\}/, '要带 pid 与时间戳')
  assert.match(INDEX, /sweepOverlays\(\)/, '启动要清扫上一轮的残留')
  assert.match(INDEX, /process\.kill\(pid, 0\)/, '清扫前要先确认那个进程真没了')
})

test('定时那一跳先看跑成没跑成，再消费窗口（否则被拒一轮就白丢）', () => {
  assert.match(INDEX, /const r = runDuty\(`window:\$\{k\}`\)/, '要先拿到结果')
  assert.match(INDEX, /if \(r && r\.busy\) return\s*\/\/ 留给下一跳/, '被拒时不许把窗口标记成用过了')
})

test('duty.md 里不再把 dmMode 的默认值写成 off（代码默认是 only）', () => {
  const duty = readFileSync(new URL('../prompts/duty.md', import.meta.url), 'utf8')
  assert.doesNotMatch(duty, /\| `off` \| 只发公开评论（默认）/, '那是 2.0 遗留的错误说明')
  assert.match(duty, /新装默认就是这个/, '要写清默认是 only')
})
