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
const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('待审草稿：入队靠工具、发出靠人点头，宿主三个接口都在', () => {
  // 她只能"入队"，发不出去 —— 这是"先审后发"的全部意义
  assert.match(INDEX, /name: 'bili_draft'/, '要有 bili_draft 工具')
  assert.match(INDEX, /path === '\/api\/bili-duty\/pending'/, '要有列表接口')
  assert.match(INDEX, /pending\/approve/, '要有批准接口')
  assert.match(INDEX, /pending\/drop/, '要有否掉接口')

  // 批准流程的三条语义：先取走（防连点发两条）/ 失败放回（别把草稿弄丢）/ 成功才记账
  // （2026-10-22 M4：逻辑收进 approveDraftById，设置页按钮与云桥 approval.result 共用一份）
  assert.match(INDEX, /async function approveDraftById\(id\)/, '要有一处共用的批准逻辑')
  assert.match(INDEX, /const taken = takeDraft\(readQueue\(pendingFile\), id\)/, '先取走')
  assert.match(INDEX, /队列里没有这条（可能已经发过）/, '取不到就明确说"可能已经发过"')
  assert.match(INDEX, /const back = addDraft\(taken\.queue, item, \{\}\)/, '发失败要放回队列')
  assert.match(INDEX, /recordShare\(\{ bvid: item\.bvid, rpid: item\.parent, text: item\.message \}\)/, '成功才记账')
  assert.match(INDEX, /await approveDraftById\(id\)/, '路由要复用同一段逻辑')

  // 设置页有入口
  assert.match(CLIENT, /jget\('\/pending'\)/, '设置页要能读列表')
  assert.match(CLIENT, /jpost\('\/pending\/approve'/, '要有批准按钮')
  assert.match(CLIENT, /jpost\('\/pending\/drop'/, '要有否掉按钮')

  // ⭐ 2026-10-22（M3 落地后改）：常驻会话里宿主工具都在 ⇒ 提示词**必须**要求
  //    "陌生人回复一律先 bili_draft 进待审"，不许用 bili_reply 绕过本人点头。
  const duty = readFileSync(new URL('../prompts/duty.md', import.meta.url), 'utf8')
  assert.match(duty, /bili_draft\(bvid, rpid, text, why\)/, '要给出 bili_draft 的调用形状')
  assert.match(duty, /不许直接 `bili_reply` 回陌生人/, '陌生人回复必须进待审队列，不许绕过本人')
  assert.match(duty, /一次性进程/, '要写清"退回一次性进程"那轮没有这只工具时怎么办')
})

/**
 * 那一轮**实际能看见**的工具取决于跑法：
 *   · spawn（`--profile headless`）—— 那个 profile 里**没有这个插件**，只有 Python MCP 那六个
 *   · 常驻会话（M3，默认）—— 她跑在插件自己的会话里，宿主工具也在
 * 2026-10-22 起：章程按**常驻会话**写成无条件要求；但必须写清"退回一次性进程的轮次怎么办"，
 * 否则那个兜底跑法会去调根本不存在的工具、白烧一轮。
 */
const MCP_TOOLS = ['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_reply', 'bili_send_message']
const HOST_ONLY_TOOLS = ['bili_diary', 'bili_draft', 'bili_done', 'bili_say']

test('提示词提宿主专属工具时，必须写清「退回一次性进程」那一轮怎么办', () => {
  const duty = readFileSync(new URL('../prompts/duty.md', import.meta.url), 'utf8')
  const named = new Set([...duty.matchAll(/`?(bili_[a-z_]+)/g)].map((m) => m[1]))
  const unknown = [...named].filter((n) => ![...MCP_TOOLS, ...HOST_ONLY_TOOLS].includes(n))
  assert.deepEqual(unknown, [], '提示词提到了根本不存在的工具：' + unknown.join(', '))
  // M3 之后章程本来就该点名宿主工具（无条件要求），所以这里不再要求"每处带没有就跳过"
  assert.ok(HOST_ONLY_TOOLS.every((t) => named.has(t)), 'M3 之后章程要点名 bili_done / bili_diary / bili_draft')
  assert.match(duty, /一次性进程/, '要写清另一种跑法（没有宿主工具）时怎么办')
})

test('绝不把 sessionController 写进 inject（whale 那个"永远 pending"的坑）', () => {
  const m = /export const inject = (\[[^\]]*\])/.exec(INDEX)
  assert.ok(m, 'index.js 要有 inject 声明')
  assert.doesNotMatch(m[1], /sessionController/,
    '声明它 ⇒ 没有这个服务的 profile 里整条插件不激活、设置页 404。要运行时 ctx.get')
  assert.match(INDEX, /const sessionController = \(\) =>/, '要有运行时取用')
  assert.match(INDEX, /ctx\.get\('sessionController'\)/, '取用要真的调 ctx.get')
})

test('常驻会话的投递只保证"被收下"，所以必须有收尾兜底', () => {
  const wake = readFileSync(new URL('../src/host/wake.mjs', import.meta.url), 'utf8')
  assert.match(wake, /acknowledgement|只保证"被收下"/, '注释里要写清这个语义（别人接手时最容易误解的地方）')
  assert.match(wake, /createWatchdog/, '要有着门狗')
  assert.match(wake, /mode: 'queue'/, '投递用 queue 模式，别用 steer 打断她正在做的事')
})

test('状态卡接在两条跑法上（常驻会话 / 一次性进程）', () => {
  // 状态卡 = 每轮的"记忆锚点"：今天挑了几条 / 阈值 / 最近 7 天判重 / 她上次给自己写的
  assert.match(INDEX, /const promptWithCard = \(\) =>/, '要有组装函数')
  assert.match(INDEX, /const text = promptWithCard\(\)/, '常驻会话那条路要带上状态卡')
  assert.match(INDEX, /args\.push\(promptWithCard\(\)\)/, '一次性进程那条路也要带上状态卡')
  assert.match(INDEX, /buildStatusCard\(/, '用 src/host/card.mjs 拼，别在 index.js 里再写一份')
  assert.match(INDEX, /cfgNew: readConfig\(cfgFile\)\.config/, 'readConfig 返回的是包壳（{config,...}），别把壳当配置传进去')
  assert.match(INDEX, /lastEntryAny\(memoryDir, 'self'/, '"她上次给自己写的"要走日记的读入口')
  // 卡拼不出来不许拦着一轮：必须在 try 里退回原提示词
  assert.match(INDEX, /状态卡拼不出来（这一轮照跑）/, '失败要有日志、不能抛出去')
})

test('M2 能力层：只读三件走 Node、可退回 MCP（写入也搬了，同样可退回）', () => {
  assert.match(INDEX, /createNodeBili\(\{ home: stateDir, log \}\)/, '要真建 Node 能力层')
  assert.match(INDEX, /const readCall = async \(toolName, args\) =>/, '只读工具要统一入口')
  assert.match(INDEX, /Node 能力层失败（\$\{toolName\}）：\$\{why\} ⇒ 退回 Python MCP/, 'Node 抛错要能退回 MCP')
  // 三个只读工具必须走 readCall
  assert.match(INDEX, /return readCall\('bili_search'/, 'search 走能力层路由')
  assert.match(INDEX, /return readCall\('bili_subtitle'/, 'subtitle 走能力层路由')
  assert.match(INDEX, /return readCall\('bili_comments'/, 'comments 走能力层路由')
  assert.match(INDEX, /const capabilityNow = \(\) =>/, '要有一处统一的开关判断')
  assert.match(INDEX, /capability: 'node'/, '扁平 DEFAULTS 里要有 capability（干净机器默认不依赖 Python）')

  // M2 收尾：写入类（发评论 / 私信）也走 Node，异常时退回 MCP；回执判断收在一处
  assert.match(INDEX, /const writeCall = async \(toolName, args\) =>/, '写操作也要统一入口')
  assert.match(INDEX, /out = await writeCall\('bili_reply'/, '发评论（含审核批准）走 writeCall')
  assert.match(INDEX, /return writeCall\('bili_send_message'/, '私信走 writeCall')
  assert.match(INDEX, /name: 'bili_send_message'/, '要注册私信工具（常驻会话里她才有这只手）')
  assert.match(INDEX, /const writeOk = \(out\) =>/, '回执判断要有一处统一实现')
})

test('M4 云桥：签名入站路由、出站事件、回群的手、配额对账都在', () => {
  assert.match(INDEX, /path === '\/api\/bili-duty\/sync\/inbound'/, '要有签名入站路由')
  assert.match(INDEX, /b\.ingest\(events, syncHandlers\(\)\)/, '入站要走 bridge.ingest（与 pump 同一套安检）')
  assert.match(INDEX, /path === '\/api\/bili-duty\/sync\/info'/, '要有入站地址/密钥查询')
  assert.match(INDEX, /name: 'bili_say'/, '她得有回群的那只手')
  assert.match(INDEX, /TYPES\.MSG_IN/, '群里消息要能叫醒她')
  assert.match(INDEX, /deliverToSession\(\{ sessionController: sessionController\(\), cwd: stateDir, text: material \}\)/, '入站要投进常驻会话')
  assert.match(INDEX, /emitSync\(TYPES\.QUOTA, localQuota\(\)\)/, '一轮收尾要跟云端对账配额')
  assert.match(INDEX, /emitSync\(TYPES\.APPROVAL_REQ/, '草稿入队要推待审')
  assert.match(INDEX, /emitSync\(TYPES\.MEMORY/, '写日记要同步记忆')
  assert.match(INDEX, /getDshIm: \(\) =>/, 'dshim 出站要运行时取宿主服务（不能写进 inject）')
  assert.match(INDEX, /syncEnabled: false/, '云桥默认关（不该在用户不知情时开）')
  // M4 收尾：云端的额度也要占本地额度（取严）
  assert.match(INDEX, /extraShared: remoteSharedExtra\(\)/, '闸门要算上跨端多出来的分享数')
  assert.match(INDEX, /const remoteSharedExtra = \(\) =>/, '要有一处"云端比本地多几条"的换算')
})


test('宿主工具仍然在（交互会话与常驻会话里都能用）', () => {
  assert.match(INDEX, /name: 'bili_diary'/, '写日记的手（宿主侧）')
  assert.match(INDEX, /name: 'bili_draft'/, '待审草稿的手（宿主侧）')
  assert.match(INDEX, /name: 'bili_done'/, '收工的手（常驻会话靠它收尾）')
})

test('两本日记真有写入者（whale 那个「只有提示词、没有代码」的坑不能重演）', () => {
  assert.match(INDEX, /name: 'bili_diary'/, '她得有个写日记的手')
  assert.match(INDEX, /appendDiary\(memoryDir, kind,/, '工具必须落到 diary.mjs 的唯一写入口')
  assert.match(INDEX, /const notifyRound = async/, '一轮收尾要有推送动作')
  assert.match(INDEX, /todayDigest\(memoryDir\)/, '推送里要带两本日记的摘要')
  // 没配推送就什么都不做；跑砸了也不推（收尾现在统一在 finishRound 里）
  assert.match(INDEX, /if \(!cfgN \|\| !cfgN\.type \|\| cfgN\.type === 'none'\) return/, '默认安静')
  assert.match(INDEX, /if \(code === 0\) \{ try \{ notifyRound\(\)/, '只在跑成时推')
  assert.match(CLIENT, /diaryPush/, '设置页要有开关')
  // 2026-10-22：M3 之后章程改成无条件要求（每轮必写两本日记），这里守的是"要求还在"
  const duty = readFileSync(new URL('../prompts/duty.md', import.meta.url), 'utf8')
  assert.match(duty, /两本日记/, '提示词要提两本日记')
  assert.match(duty, /每一轮都要写|必须/, '日记是无条件要求，不是"有工具才写"')
  assert.match(duty, /不许写成操作台账/, '日记不是日志，这条得写死')
})

test('设置页给了新东西的入口，宿主也有对应的接口（否则是"看得见点不动"）', () => {
  // 客户端：作息窗口 / 推送方式 / 发条测试
  assert.match(CLIENT, /scheduleWindows/, '要有作息窗口输入框')
  assert.match(CLIENT, /\/notify-test/, '要有「发条测试」按钮走的接口')
  assert.match(CLIENT, /notifyType/, '要能选推送方式')
  // 宿主：接口真的注册了
  assert.match(INDEX, /path === '\/api\/bili-duty\/notify-test'/, '宿主得真的有这个路由')
  assert.match(INDEX, /const notifyCfg = \(\) => \{/, '通知配置要有一处统一解析（新形状 / 扁平都能读）')
})

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

test('生物钟接在 tick 上，且没配窗口时走老路（升级当天行为不变）', () => {
  assert.match(INDEX, /const schedule = clockSchedule\(\)/, 'tick 里要先算作息窗口')
  assert.match(INDEX, /if \(schedule\) \{ tickClock\(schedule, now\); return \}/, '配了就走生物钟，否则继续老谷时逻辑')
  assert.match(INDEX, /return windows\.length \? \{ windows, minGapMin: 10, skipChance: 0\.3 \} : null/, '空窗口必须返回 null')
  // 定时器里抛异常会带走整个宿主（10-14 的事故），所以这一跳必须自己兜
  assert.match(INDEX, /const tickClock = \(schedule, now\) => \{\s*try \{/, 'tickClock 要自己 try')
  // 计划要先落盘再唤醒；"不看"也要记掉这次机会
  assert.match(INDEX, /if \(JSON\.stringify\(plan\) !== JSON\.stringify\(st\)\) writeJson\(CLOCK_FILE, plan\)/, '计划要持久化')
  assert.match(INDEX, /if \(plan\.action === 'skip'\)/, '跳过要单独处理')
  assert.match(INDEX, /if \(!r \|\| !r\.started\) return\s*\/\/ 没起来就别记账/, '没跑起来不许记账')
})

test('闸门接在 bili_reply 上，且**没传 score 时不判**（老提示词零影响）', () => {
  assert.match(INDEX, /const gateShare = \(args\) => \{/, '要有闸门入口')
  assert.match(INDEX, /if \(args\?\.score === undefined \|\| args\?\.score === null/, '没传评分直接放行')
  assert.match(INDEX, /const blocked = gateShare\(args\)/, 'bili_reply 里要真的调它')
  assert.match(INDEX, /evaluateShare\(\{/, '判定要落到纯函数上，别在路由里手写一遍规则')
  // 记账两头都要在：失败不记（额度白扣）
  assert.match(INDEX, /if \(writeOk\(out\)\) recordShare\(/, '发出去了才记账')
  assert.match(INDEX, /writeLedger\(sharesFile, next\)/, '账本要落盘')
})

test('提示词要求她传 score / reason（否则闸门永远是空的）', () => {
  const duty = readFileSync(new URL('../prompts/duty.md', import.meta.url), 'utf8')
  assert.match(duty, /score=15/, '要给一个能照抄的例子')
  assert.match(duty, /被拒了不要换个理由重试/, '被拒的处理方式必须写死，否则她会反复重试烧 token')
})

test('duty.md 里不再把 dmMode 的默认值写成 off（代码默认是 only）', () => {
  const duty = readFileSync(new URL('../prompts/duty.md', import.meta.url), 'utf8')
  assert.doesNotMatch(duty, /\| `off` \| 只发公开评论（默认）/, '那是 2.0 遗留的错误说明')
  assert.match(duty, /新装默认就是这个/, '要写清默认是 only')
})
