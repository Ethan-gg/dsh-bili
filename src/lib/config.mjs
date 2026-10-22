/**
 * src/lib/config.mjs —— 唯一配置：schema、默认值、读写、钳制、旧配置映射
 * ============================================================================
 * 2.1 之前这事分散在两边：
 *   · scroll 用一个**扁平**的 26 字段对象 + DSH 原生设置页（schemastery）
 *   · whale 用一个**分组**的 12 段对象 + 自己的设置页
 * 两边各有各的默认值、各有各的钳制，还各自写过各自的 bug（示例值与代码值不一致之类）。
 *
 * 现在只有这一份。
 *
 * ⚠️ 两条硬规矩（都是从真实事故里换来的，别改）：
 *   ① **写配置一律原子**（临时文件 + rename）：写坏一半比没写更糟 —— 用户会看到"设置回默认"
 *   ② **钳制只在这里做**：schema 里故意不写 `.max()`（校验不过会让整条插件不激活），
 *      范围一律在 `clamp()` 里钳。读和写两头都过一遍。
 * ============================================================================
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CONFIG_VERSION = 1

/** 未知键直接丢掉（防止老版本残留字段一路带着走） */
export const DEFAULTS = {
  version: CONFIG_VERSION,

  /**
   * 用户"在插件面板里存过"的键（旧形状时代叫 `_set`）。
   * 它决定了 `config.json` 和 DSH 原生设置页谁说了算 —— 详见 index.js `loadCfg` 的注释。
   * 放在配置里而不是单开一个文件，是因为它必须和配置**同生共死**：配置被覆盖了它就该一起走。
   */
  _set: [],

  /** 账号：她是谁、你（主人）是谁、评论里 @ 谁 */
  account: { selfUid: 0, selfName: '', ownerUid: 0, mentionName: '' },

  /** 选题：搜什么、挑几条、口味 */
  feed: {
    keywords: [],
    /** 每天最多挑几条（0 = 只手动） */
    perDay: 5,
    /** 单次醒来最多看几条（whale 的 night.maxVideos） */
    maxVideosPerWake: 5,
    like: [],
    dislike: [],
  },

  /** 作息：什么时候醒、像不像人 */
  schedule: {
    /** 谷时自动刷（总开关）。关 = 只手动 */
    enabled: false,
    /** 中午谷时 12–14 */
    noon: true,
    /** 晚上谷时 18–09 */
    night: true,
    /** 生物钟窗口（M1 起生效；空 = 用上面的谷时窗口） */
    windows: [],
    /** 今天不想看的概率 */
    skipChance: 0.3,
    /** 两次唤醒的最小间隔（分钟） */
    minGapMin: 10,
    /** 一天最多醒几次 */
    maxWakesPerDay: 1,
  },

  /** 闸门：说多少、说什么、什么时候闭嘴 */
  share: {
    enabled: false,
    via: 'comment',        // comment | dm
    perRound: 1,           // 每轮最多说几条
    daily: 3,              // 每天最多说几条
    minScore: 13,          // 0–20，低于这个不分享
    sameVideoDays: 7,      // 同一视频几天内只说一次
    silenceDays: 3,        // 沉默几天开始降额
    silenceStopDays: 7,    // 沉默几天归零
  },

  /** 互动：听谁说话 */
  listen: {
    comments: false,
    commentIntervalSec: 300,
    scope: 'both',         // both | reply
    oncePerPerson: false,
    allDay: false,
    /**
     * 私信监听。**默认 true** —— 这是 2.0 的行为（2.0 的 schema 与 DEFAULTS 都是 true）。
     * 迁移时如果老配置里没写这个键，必须保持 true，否则升级当天的行为会悄悄变掉
     * （用户会发现"以前会回我私信，现在不回了"）。冒烟测试逮到过这一处。
     */
    dm: true,
    dmIntervalSec: 20,
    live: false,
    liveRoom: '',
    liveScope: 'owner',    // owner | mention
    mentionSummary: false,
  },

  /** 回复：只回楼中楼，默认先审后发 */
  reply: { perRound: 1, toComments: false, approval: true },

  /**
   * 私信。`mode` 默认 **`only`** —— 这是 2.0 的口径（schema 与设置页都是 only，
   * 2.0 的 CHANGELOG 明确写着"私信投递成为默认"）。
   *
   * ⚠️ 为什么强调：迁移只读 `config.json`，**读不到宿主那层 schema 默认值**。
   * 如果你的 config.json 里从没写过 dmMode，2.0 实际跑的是 `only`（来自 schema），
   * 而我把新默认写成 `off` 的话，升级后她就会**开始发公开评论** —— 一个没人预期的行为变化。
   * 真实数据演练时逮到的。
   */
  dm: { mode: 'only', uid: 0, replyPerDay: 0, ownerUid: 0 },

  /** 产物 */
  report: { level: 'full' },                              // full | brief | off
  diary: { owner: true, self: true, push: true },

  /** 通知（云桥之外的另一条出口） */
  notify: { type: 'none', url: '', template: 'text', cmd: '', args: [], path: '' },

  /**
   * 人设。**优先级：persona.file（本文件）> persona.prompt（设置页那段）> 兜底中性**。
   * 为什么文件优先：云同步要把人格当成一份可分发的东西（带 hash 和 updatedAt），
   * 塞在 config 里的一个字符串没法做版本比较。
   */
  persona: { file: 'persona.md', name: '', ownerTitle: '', selfClaim: '', prompt: '' },

  /** 运行：怎么起一轮、用哪个 dsh */
  run: {
    headlessProfile: 'headless',
    dshBin: '',
    dshPath: '',
    workspace: '',
    overlayMcp: true,
    pythonPath: 'python',
  },

  /** 本地转写（没字幕的视频） */
  asr: { enabled: false, model: 'small' },

  /** 自动收藏 */
  fav: { folderId: 0 },

  /** 云桥（M4 起真用；默认全关） */
  sync: {
    enabled: false,
    transport: 'file',     // file | dshim | http
    endpoint: '',
    botId: '',
    targetId: '',
    conversations: [],     // 入站白名单（convId）
    maxInboundPerMinute: 2,
    replayWindowMin: 10,
  },
}

/* ─────────────────────────── 深合并 / 钳制 ─────────────────────────── */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function merge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (!(k in out)) continue                       // 未知键丢掉
    if (isObj(out[k]) && isObj(v)) out[k] = merge(out[k], v)
    // ⚠️ 数组要连**对象元素**一起留（`schedule.windows` 就是对象数组）——
    //    以前只放行 string/number，结果整个 windows 被无声清空（单测逮到的）
    else if (Array.isArray(out[k])) out[k] = Array.isArray(v) ? v.filter((x) => x !== null && ['string', 'number', 'object'].includes(typeof x)) : out[k]
    else if (typeof out[k] === typeof v) out[k] = v
    else if (typeof out[k] === 'number' && Number.isFinite(Number(v))) out[k] = Number(v)
    else if (typeof out[k] === 'boolean') out[k] = Boolean(v)
    else if (typeof out[k] === 'string') out[k] = String(v)
  }
  return out
}

/** `HH:MM` 校验（允许 24:00 当"到午夜"）。非法返回 null。 */
export function hhmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
  if (!m) return null
  const h = Number(m[1]); const mi = Number(m[2])
  if (mi > 59) return null
  if (h === 24 && mi === 0) return '24:00'
  if (h > 23) return null
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/**
 * 把一行文本解析成作息窗口 —— `"20:00-24:00:1, 12:00-14:00:2"`。
 *
 * 为什么用字符串而不是 JSON 数组：DSH 原生设置页的字段只认标量（且必须 volatile），
 * 数组/对象塞不进去；而这个值要同时在**设置页、`bili_config` 工具、config.json** 三处可改。
 * 字符串是唯一能同时满足三者的形状，代价是要有这一对解析/格式化函数（并且**必须单测**）。
 *
 * 规则：
 *   · 分隔符：逗号、中文逗号、分号、换行都行（人会怎么写就怎么认）
 *   · 每一段：`开始-结束[:次数]`，次数省略 = 1
 *   · `结束 <= 开始` 视为跨午夜（`23:00-02:00`）
 *   · 认不出的段**丢掉**（不抛）—— 配置里写错一个字不该让插件起不来；丢掉几段由调用方记日志
 */
export function parseWindows(text) {
  const out = []
  const bad = []
  for (const raw of String(text ?? '').split(/[,，;；\n]+/)) {
    const seg = raw.trim()
    if (!seg) continue
    const m = /^(\d{1,2}:\d{2})\s*[-~—至]\s*(\d{1,2}:\d{2})(?:\s*[:：]\s*(\d{1,2}))?$/.exec(seg)
    if (!m) { bad.push(seg); continue }
    const start = hhmm(m[1])
    const end = hhmm(m[2])
    if (!start || !end) { bad.push(seg); continue }
    const wakes = m[3] === undefined ? 1 : Math.min(12, Math.max(0, Number(m[3]) || 0))
    out.push({ start, end, wakes })
  }
  return { windows: out, bad }
}

/** `parseWindows` 的逆（设置页展示用） */
export function formatWindows(windows = []) {
  return (Array.isArray(windows) ? windows : [])
    .map((w) => `${w.start}-${w.end}:${Number(w.wakes ?? 1)}`)
    .join(', ')
}

/** 整数夹取；非数字回落到默认 */
const int = (v, lo, hi, def) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}
const num = (v, lo, hi, def) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}
const bool = (v, def) => (typeof v === 'boolean' ? v : def)
const oneOf = (v, list, def) => (list.includes(v) ? v : def)
const strList = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [])

/** 把任意输入钳成合法配置。**读和写都要过这里。** */
export function clamp(cfg = {}) {
  const c = merge(DEFAULTS, cfg)
  c.version = CONFIG_VERSION
  c._set = strList(c._set).slice(0, 200)

  c.account.selfUid = int(c.account.selfUid, 0, Number.MAX_SAFE_INTEGER, 0)
  c.account.ownerUid = int(c.account.ownerUid, 0, Number.MAX_SAFE_INTEGER, 0)
  c.account.mentionName = String(c.account.mentionName ?? '').trim().slice(0, 64)
  c.account.selfName = String(c.account.selfName ?? '').trim().slice(0, 64)

  c.feed.keywords = strList(c.feed.keywords).slice(0, 50)
  c.feed.like = strList(c.feed.like).slice(0, 50)
  c.feed.dislike = strList(c.feed.dislike).slice(0, 50)
  c.feed.perDay = int(c.feed.perDay, 0, 50, DEFAULTS.feed.perDay)
  c.feed.maxVideosPerWake = int(c.feed.maxVideosPerWake, 1, 20, DEFAULTS.feed.maxVideosPerWake)

  c.schedule.enabled = bool(c.schedule.enabled, DEFAULTS.schedule.enabled)
  c.schedule.noon = bool(c.schedule.noon, true)
  c.schedule.night = bool(c.schedule.night, true)
  c.schedule.skipChance = num(c.schedule.skipChance, 0, 0.95, DEFAULTS.schedule.skipChance)
  c.schedule.minGapMin = int(c.schedule.minGapMin, 1, 720, DEFAULTS.schedule.minGapMin)
  c.schedule.maxWakesPerDay = int(c.schedule.maxWakesPerDay, 0, 12, DEFAULTS.schedule.maxWakesPerDay)
  c.schedule.windows = (Array.isArray(c.schedule.windows) ? c.schedule.windows : [])
    .map((w) => ({
      start: hhmm(w?.start) ?? '20:00',
      end: hhmm(w?.end) ?? '24:00',
      wakes: int(w?.wakes, 1, 12, 1),
    }))
    .slice(0, 6)

  c.share.enabled = bool(c.share.enabled, DEFAULTS.share.enabled)
  c.share.via = oneOf(c.share.via, ['comment', 'dm'], DEFAULTS.share.via)
  c.share.perRound = int(c.share.perRound, 0, 20, DEFAULTS.share.perRound)
  c.share.daily = int(c.share.daily, 0, 20, DEFAULTS.share.daily)
  c.share.minScore = int(c.share.minScore, 0, 20, DEFAULTS.share.minScore)
  c.share.sameVideoDays = int(c.share.sameVideoDays, 1, 365, DEFAULTS.share.sameVideoDays)
  c.share.silenceDays = int(c.share.silenceDays, 1, 90, DEFAULTS.share.silenceDays)
  c.share.silenceStopDays = int(c.share.silenceStopDays, c.share.silenceDays, 180, DEFAULTS.share.silenceStopDays)

  c.listen.comments = bool(c.listen.comments, DEFAULTS.listen.comments)
  c.listen.commentIntervalSec = int(c.listen.commentIntervalSec, 60, 86400, DEFAULTS.listen.commentIntervalSec)
  c.listen.scope = oneOf(c.listen.scope, ['both', 'reply'], DEFAULTS.listen.scope)
  c.listen.oncePerPerson = bool(c.listen.oncePerPerson, DEFAULTS.listen.oncePerPerson)
  c.listen.allDay = bool(c.listen.allDay, DEFAULTS.listen.allDay)
  c.listen.dm = bool(c.listen.dm, DEFAULTS.listen.dm)
  c.listen.dmIntervalSec = int(c.listen.dmIntervalSec, 10, 3600, DEFAULTS.listen.dmIntervalSec)
  c.listen.live = bool(c.listen.live, false)
  c.listen.liveRoom = String(c.listen.liveRoom ?? '').trim().replace(/\D/g, '').slice(0, 20)
  c.listen.liveScope = oneOf(c.listen.liveScope, ['owner', 'mention'], 'owner')
  c.listen.mentionSummary = bool(c.listen.mentionSummary, false)

  c.reply.perRound = int(c.reply.perRound, 0, 20, DEFAULTS.reply.perRound)
  c.reply.toComments = bool(c.reply.toComments, false)
  c.reply.approval = bool(c.reply.approval, true)

  c.dm.mode = oneOf(c.dm.mode, ['off', 'only', 'both'], DEFAULTS.dm.mode)
  c.dm.uid = int(c.dm.uid, 0, Number.MAX_SAFE_INTEGER, 0)
  c.dm.replyPerDay = int(c.dm.replyPerDay, 0, 200, 0)
  c.dm.ownerUid = int(c.dm.ownerUid, 0, Number.MAX_SAFE_INTEGER, 0)

  c.report.level = oneOf(c.report.level, ['full', 'brief', 'off'], DEFAULTS.report.level)
  c.diary.owner = bool(c.diary.owner, true)
  c.diary.self = bool(c.diary.self, true)
  c.diary.push = bool(c.diary.push, true)

  c.notify.type = oneOf(c.notify.type, ['none', 'desktop', 'webhook', 'command', 'dm', 'stdout', 'file'], 'none')
  c.notify.url = String(c.notify.url ?? '').trim().slice(0, 2048)
  c.notify.template = oneOf(c.notify.template, ['text', 'markdown'], 'text')
  c.notify.cmd = String(c.notify.cmd ?? '').trim().slice(0, 1024)
  c.notify.args = Array.isArray(c.notify.args) ? c.notify.args.map(String).slice(0, 32) : []
  c.notify.path = String(c.notify.path ?? '').trim().slice(0, 1024)

  c.persona.file = 'persona.md'                                 // 固定，不给配（防止指到别人家）
  c.persona.name = String(c.persona.name ?? '').trim().slice(0, 64)
  c.persona.ownerTitle = String(c.persona.ownerTitle ?? '').trim().slice(0, 64)
  c.persona.selfClaim = String(c.persona.selfClaim ?? '').trim().slice(0, 64)
  c.persona.prompt = String(c.persona.prompt ?? '').slice(0, 20000)

  c.run.headlessProfile = String(c.run.headlessProfile ?? 'headless').trim().slice(0, 64) || 'headless'
  c.run.dshBin = String(c.run.dshBin ?? '').trim().slice(0, 1024)
  c.run.dshPath = String(c.run.dshPath ?? '').trim().slice(0, 1024)
  c.run.workspace = String(c.run.workspace ?? '').trim().slice(0, 1024)
  c.run.overlayMcp = bool(c.run.overlayMcp, true)
  c.run.pythonPath = String(c.run.pythonPath ?? 'python').trim().slice(0, 1024) || 'python'

  c.asr.enabled = bool(c.asr.enabled, false)
  c.asr.model = oneOf(c.asr.model, ['tiny', 'base', 'small', 'medium', 'large-v3'], 'small')

  c.fav.folderId = int(c.fav.folderId, 0, Number.MAX_SAFE_INTEGER, 0)

  c.sync.enabled = bool(c.sync.enabled, false)
  c.sync.transport = oneOf(c.sync.transport, ['file', 'dshim', 'http'], 'file')
  c.sync.endpoint = String(c.sync.endpoint ?? '').trim().slice(0, 2048)
  c.sync.botId = String(c.sync.botId ?? '').trim().slice(0, 128)
  c.sync.targetId = String(c.sync.targetId ?? '').trim().slice(0, 128)
  c.sync.conversations = strList(c.sync.conversations).slice(0, 20)
  c.sync.maxInboundPerMinute = int(c.sync.maxInboundPerMinute, 0, 60, 2)
  c.sync.replayWindowMin = int(c.sync.replayWindowMin, 1, 1440, 10)

  return c
}

/* ─────────────────────────── 读 / 写 ─────────────────────────── */

/** 去掉 UTF-8 BOM。用户拿记事本改过 config.json 就会带上它，`JSON.parse` 会直接拒。 */
export const stripBom = (s) => String(s).replace(/^\uFEFF/, '')

/** 读。文件坏了不抛错 —— 回落到默认值，并把原因带出去（设置页要显示"你的配置读不出来了"）。 */
export function readConfig(file) {
  let raw = null
  let error = null
  try {
    raw = JSON.parse(stripBom(readFileSync(file, 'utf8')))
  } catch (e) {
    if (e && e.code !== 'ENOENT') error = String(e.message ?? e)
  }
  return { config: clamp(raw ?? {}), raw: raw ?? null, hasFile: raw !== null, error }
}

/** 写。原子 + 0600（配置里有 ownerUid 这类身份信息，不该给别的用户读）。 */
export function writeConfig(file, cfg) {
  const next = clamp(cfg)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch { /* Windows 上可能不生效，不算错 */ }
  return next
}

/* ─────────────────────────── 兼容旧形状 ─────────────────────────── */

/**
 * 给还活在旧字段名上的代码（现在的 `index.js`）看的**扁平视图**。
 * M0 用它让老的 tick/工具/设置页继续工作；M1 会逐个把调用点迁到新形状，然后删掉这个函数。
 */
export function flatView(cfg) {
  const c = clamp(cfg)
  return {
    perDay: c.feed.perDay,
    peakValley: c.schedule.enabled,
    noon: c.schedule.noon,
    night: c.schedule.night,
    autoComment: c.share.enabled,
    dmMode: c.dm.mode,
    dmUid: c.dm.uid,
    transcribe: c.asr.enabled,
    asrModel: c.asr.model,
    commentPerRound: c.share.perRound,
    mentionName: c.account.mentionName,
    keywords: c.feed.keywords,
    pythonPath: c.run.pythonPath,
    dshBin: c.run.dshBin,
    headlessProfile: c.run.headlessProfile,
    overlayMcp: c.run.overlayMcp,
    personaPrompt: c.persona.prompt,
    dmWatch: c.listen.dm,
    dmWatchMinutes: Math.max(1, Math.round(c.listen.dmIntervalSec / 60)),
    dmReplyPerDay: c.dm.replyPerDay,
    dmOwnerUid: c.dm.ownerUid,
    workspace: c.run.workspace,
    reportLevel: c.report.level,
    replyToComments: c.reply.toComments,
    replyPerRound: c.reply.perRound,
    favFolderId: c.fav.folderId,
    /** 作息窗口的文本形式：DSH 原生设置页只认标量，数组塞不进去 */
    scheduleWindows: formatWindows(c.schedule.windows),
  }
}

/**
 * `flatView` 的逆：把一份**旧字段名**的补丁写回新形状。
 * 为什么需要它：`index.js` 里那套"面板存过就本地优先"的账（`_set`）是按扁平键记的，
 * 而盘上存的已经是新形状 —— 不映射回去，每次保存都会把新配置洗掉。M1 迁完调用点后删掉。
 */
export function applyFlat(cfg, patch = {}) {
  const c = clamp(cfg)
  const has = (k) => patch[k] !== undefined
  if (has('perDay')) c.feed.perDay = patch.perDay
  if (has('keywords')) c.feed.keywords = patch.keywords
  if (has('peakValley')) c.schedule.enabled = patch.peakValley
  if (has('noon')) c.schedule.noon = patch.noon
  if (has('night')) c.schedule.night = patch.night
  if (has('autoComment')) c.share.enabled = patch.autoComment
  if (has('commentPerRound')) c.share.perRound = patch.commentPerRound
  if (has('mentionName')) c.account.mentionName = patch.mentionName
  if (has('dmMode')) c.dm.mode = patch.dmMode
  if (has('dmUid')) c.dm.uid = patch.dmUid
  if (has('dmWatch')) c.listen.dm = patch.dmWatch
  if (has('dmWatchMinutes')) c.listen.dmIntervalSec = Math.max(1, Number(patch.dmWatchMinutes) || 1) * 60
  if (has('dmReplyPerDay')) c.dm.replyPerDay = patch.dmReplyPerDay
  if (has('dmOwnerUid')) c.dm.ownerUid = patch.dmOwnerUid
  if (has('transcribe')) c.asr.enabled = patch.transcribe
  if (has('asrModel')) c.asr.model = patch.asrModel
  if (has('personaPrompt')) c.persona.prompt = patch.personaPrompt
  if (has('pythonPath')) c.run.pythonPath = patch.pythonPath
  if (has('dshBin')) c.run.dshBin = patch.dshBin
  if (has('headlessProfile')) c.run.headlessProfile = patch.headlessProfile
  if (has('overlayMcp')) c.run.overlayMcp = patch.overlayMcp
  if (has('workspace')) c.run.workspace = patch.workspace
  if (has('reportLevel')) c.report.level = patch.reportLevel
  if (has('replyToComments')) c.reply.toComments = patch.replyToComments
  if (has('replyPerRound')) c.reply.perRound = patch.replyPerRound
  if (has('favFolderId')) c.fav.folderId = patch.favFolderId
  // 作息窗口：文本 ⇄ 数组。认不出的段在这里被丢掉（写错了不该让插件起不来）
  if (has('scheduleWindows')) c.schedule.windows = parseWindows(patch.scheduleWindows).windows.slice(0, 6)
  return clamp(c)
}

/**
 * 盘上那份是不是 2.1 的新形状。判据故意放宽（有任一分组就算）：
 * 老形状是纯扁平的，一个新分组键都不会有。
 */
export function isNewShape(raw) {
  if (!raw || typeof raw !== 'object') return false
  return ['version', 'account', 'feed', 'schedule', 'share', 'listen', 'reply', 'dm', 'report', 'diary', 'notify', 'persona', 'run', 'asr', 'fav', 'sync']
    .some((k) => k in raw)
}

/**
 * 把两份旧配置合成一份新的。返回 `{ config, mapped, conflicts, dropped }`。
 *
 * 规则：**scroll 优先**（它是要发布的那一支），whale 只补 scroll 没有的字段。
 * 两边都有且值不同的，记进 `conflicts` 让设置页显示"这两处不一致，我按 scroll 的来了"。
 */
export function fromLegacy(scrollCfg = {}, whaleCfg = {}, whaleNightCfg = {}) {
  const out = structuredClone(DEFAULTS)
  const mapped = []
  const conflicts = []
  const dropped = []

  const put = (target, obj, key, value, from) => {
    if (value === undefined || value === null || value === '') return
    const cur = obj[key]
    const isDefault = JSON.stringify(cur) === JSON.stringify(DEFAULTS[target]?.[key] ?? cur)
    if (!isDefault && JSON.stringify(cur) !== JSON.stringify(value)) {
      conflicts.push({ field: `${target}.${key}`, kept: cur, ignored: value, from })
      return
    }
    obj[key] = value
    mapped.push(`${from}:${target}.${key}`)
  }

  /* ── scroll（扁平，26 字段）── */
  const s = scrollCfg
  if (s.perDay !== undefined) put('feed', out.feed, 'perDay', int(s.perDay, 0, 50, 5), 'scroll')
  if (s.keywords !== undefined) put('feed', out.feed, 'keywords', strList(s.keywords), 'scroll')
  if (s.peakValley !== undefined) put('schedule', out.schedule, 'enabled', bool(s.peakValley, false), 'scroll')
  if (s.noon !== undefined) put('schedule', out.schedule, 'noon', bool(s.noon, true), 'scroll')
  if (s.night !== undefined) put('schedule', out.schedule, 'night', bool(s.night, true), 'scroll')
  if (s.autoComment !== undefined) put('share', out.share, 'enabled', bool(s.autoComment, false), 'scroll')
  if (s.commentPerRound !== undefined) put('share', out.share, 'perRound', int(s.commentPerRound, 0, 20, 1), 'scroll')
  if (s.mentionName !== undefined) put('account', out.account, 'mentionName', String(s.mentionName || ''), 'scroll')
  if (s.dmMode !== undefined) put('dm', out.dm, 'mode', oneOf(s.dmMode, ['off', 'only', 'both'], 'off'), 'scroll')
  if (s.dmUid !== undefined) put('dm', out.dm, 'uid', int(s.dmUid, 0, Number.MAX_SAFE_INTEGER, 0), 'scroll')
  if (s.dmWatch !== undefined) put('listen', out.listen, 'dm', bool(s.dmWatch, true), 'scroll')
  if (s.dmWatchMinutes !== undefined) put('listen', out.listen, 'dmIntervalSec', int((Number(s.dmWatchMinutes) || 1) * 60, 10, 3600, 60), 'scroll')
  if (s.dmReplyPerDay !== undefined) put('dm', out.dm, 'replyPerDay', int(s.dmReplyPerDay, 0, 200, 0), 'scroll')
  if (s.dmOwnerUid !== undefined) put('dm', out.dm, 'ownerUid', int(s.dmOwnerUid, 0, Number.MAX_SAFE_INTEGER, 0), 'scroll')
  if (s.transcribe !== undefined) put('asr', out.asr, 'enabled', bool(s.transcribe, false), 'scroll')
  if (s.asrModel !== undefined) put('asr', out.asr, 'model', oneOf(s.asrModel, ['tiny', 'base', 'small', 'medium', 'large-v3'], 'small'), 'scroll')
  if (s.personaPrompt !== undefined) put('persona', out.persona, 'prompt', String(s.personaPrompt || '').slice(0, 20000), 'scroll')
  if (s.pythonPath !== undefined) put('run', out.run, 'pythonPath', String(s.pythonPath || 'python'), 'scroll')
  if (s.dshBin !== undefined) put('run', out.run, 'dshBin', String(s.dshBin || ''), 'scroll')
  if (s.headlessProfile !== undefined) put('run', out.run, 'headlessProfile', String(s.headlessProfile || 'headless'), 'scroll')
  if (s.overlayMcp !== undefined) put('run', out.run, 'overlayMcp', bool(s.overlayMcp, true), 'scroll')
  if (s.workspace !== undefined) put('run', out.run, 'workspace', String(s.workspace || ''), 'scroll')
  if (s.reportLevel !== undefined) put('report', out.report, 'level', oneOf(s.reportLevel, ['full', 'brief', 'off'], 'full'), 'scroll')
  if (s.replyToComments !== undefined) put('reply', out.reply, 'toComments', bool(s.replyToComments, false), 'scroll')
  if (s.replyPerRound !== undefined) put('reply', out.reply, 'perRound', int(s.replyPerRound, 0, 20, 1), 'scroll')
  if (s.favFolderId !== undefined) put('fav', out.fav, 'folderId', int(s.favFolderId, 0, Number.MAX_SAFE_INTEGER, 0), 'scroll')

  /* ── whale（分组）── */
  const w = whaleCfg
  if (w.owner?.mid) put('account', out.account, 'ownerUid', int(w.owner.mid, 0, Number.MAX_SAFE_INTEGER, 0), 'whale')
  if (w.self?.mid) put('account', out.account, 'selfUid', int(w.self.mid, 0, Number.MAX_SAFE_INTEGER, 0), 'whale')
  if (w.self?.name) put('account', out.account, 'selfName', String(w.self.name), 'whale')
  if (w.persona?.name) put('persona', out.persona, 'name', String(w.persona.name), 'whale')
  if (w.persona?.ownerTitle) put('persona', out.persona, 'ownerTitle', String(w.persona.ownerTitle), 'whale')
  if (w.persona?.selfClaim) put('persona', out.persona, 'selfClaim', String(w.persona.selfClaim), 'whale')
  if (Array.isArray(w.preferences?.like)) put('feed', out.feed, 'like', strList(w.preferences.like), 'whale')
  if (Array.isArray(w.preferences?.dislike)) put('feed', out.feed, 'dislike', strList(w.preferences.dislike), 'whale')
  if (w.preferences?.keywords?.length) put('feed', out.feed, 'keywords', strList(w.preferences.keywords), 'whale')
  if (w.night?.maxVideos !== undefined) put('feed', out.feed, 'maxVideosPerWake', int(w.night.maxVideos, 1, 20, 5), 'whale')
  const nightSrc = { ...(w.night ?? {}), ...(whaleNightCfg ?? {}) }   // 旧文件优先（它当年就是这么盖的）
  if (Array.isArray(nightSrc.windows) && nightSrc.windows.length) {
    put('schedule', out.schedule, 'windows', nightSrc.windows.slice(0, 6), 'whale')
  }
  if (nightSrc.skipChance !== undefined) put('schedule', out.schedule, 'skipChance', num(nightSrc.skipChance, 0, 0.95, 0.3), 'whale')
  if (nightSrc.minGapMin !== undefined) put('schedule', out.schedule, 'minGapMin', int(nightSrc.minGapMin, 1, 720, 10), 'whale')
  if (nightSrc.maxWakesPerDay !== undefined) put('schedule', out.schedule, 'maxWakesPerDay', int(nightSrc.maxWakesPerDay, 0, 12, 1), 'whale')
  if (w.quota?.shareDaily !== undefined) put('share', out.share, 'daily', int(w.quota.shareDaily, 0, 20, 3), 'whale')
  if (w.share?.enabled !== undefined) put('share', out.share, 'enabled', bool(w.share.enabled, true), 'whale')
  if (w.share?.via) put('share', out.share, 'via', oneOf(w.share.via, ['comment', 'dm'], 'comment'), 'whale')
  if (w.share?.minScore !== undefined) put('share', out.share, 'minScore', int(w.share.minScore, 0, 20, 13), 'whale')
  if (w.share?.silentAfterDays !== undefined) put('share', out.share, 'silenceDays', int(w.share.silentAfterDays, 1, 90, 3), 'whale')
  if (w.share?.silentStopDays !== undefined) put('share', out.share, 'silenceStopDays', int(w.share.silentStopDays, 1, 180, 7), 'whale')
  if (w.listen?.comment !== undefined) put('listen', out.listen, 'comments', bool(w.listen.comment, true), 'whale')
  if (w.listen?.commentIntervalSec !== undefined) put('listen', out.listen, 'commentIntervalSec', int(w.listen.commentIntervalSec, 60, 86400, 300), 'whale')
  if (w.listen?.scope) put('listen', out.listen, 'scope', oneOf(w.listen.scope, ['both', 'reply'], 'both'), 'whale')
  if (w.listen?.oncePerPerson !== undefined) put('listen', out.listen, 'oncePerPerson', bool(w.listen.oncePerPerson, false), 'whale')
  if (w.listen?.allDay !== undefined) put('listen', out.listen, 'allDay', bool(w.listen.allDay, false), 'whale')
  if (w.listen?.live !== undefined) put('listen', out.listen, 'live', bool(w.listen.live, false), 'whale')
  if (w.listen?.liveRoom !== undefined) put('listen', out.listen, 'liveRoom', String(w.listen.liveRoom || ''), 'whale')
  if (w.listen?.liveScope) put('listen', out.listen, 'liveScope', oneOf(w.listen.liveScope, ['owner', 'mention'], 'owner'), 'whale')
  if (w.listen?.mentionSummary !== undefined) put('listen', out.listen, 'mentionSummary', bool(w.listen.mentionSummary, false), 'whale')
  if (w.notify?.type) put('notify', out.notify, 'type', oneOf(w.notify.type, ['none', 'desktop', 'webhook', 'command', 'dm', 'stdout', 'file'], 'none'), 'whale')
  if (w.notify?.url !== undefined) put('notify', out.notify, 'url', String(w.notify.url || ''), 'whale')
  if (w.notify?.template) put('notify', out.notify, 'template', oneOf(w.notify.template, ['text', 'markdown'], 'text'), 'whale')
  if (w.notify?.cmd !== undefined) put('notify', out.notify, 'cmd', String(w.notify.cmd || ''), 'whale')
  if (w.notify?.args !== undefined) put('notify', out.notify, 'args', Array.isArray(w.notify.args) ? w.notify.args.map(String) : [], 'whale')
  if (w.notify?.path !== undefined) put('notify', out.notify, 'path', String(w.notify.path || ''), 'whale')
  if (w.diary?.push !== undefined) put('diary', out.diary, 'push', bool(w.diary.push, true), 'whale')

  // 老版本里出现过但这一版没有对应位置的键：明确记下来，别静默丢
  for (const k of ['aliases', 'toolsPath', 'home']) if (w[k] !== undefined) dropped.push(`whale:${k}`)
  for (const k of ['_set', 'enabled']) if (s[k] !== undefined) dropped.push(`scroll:${k}`)

  return { config: clamp(out), mapped, conflicts, dropped }
}
