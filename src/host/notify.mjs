/**
 * src/host/notify.mjs —— 把"今天的事"送到你眼前
 * ============================================================================
 * 移植自 [`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale) 的
 * `tools/commands/notify.mjs`（MIT）。七种后端：`none / desktop / webhook / command / dm / stdout / file`。
 *
 * 三个设计取舍，都是踩过之后才定下来的：
 *
 * ① **Webhook 按域名自动适配报文。** 飞书、钉钉、企业微信、QQ 机器人的 JSON 结构**互不相同** ✗。
 *    让用户去记"我这个平台要填 msgtype 还是 msg_type"不现实 —— 所以他只填一个 URL，报文由这里决定。
 *
 * ② **自定义命令走 `execFile`，不走 shell。** 消息正文来自陌生评论/弹幕，一旦拼进命令行就是
 *    命令注入（`$MSG` 那种写法早在 whale 里被废掉了）。现在消息只作为**最后一个参数**传进去，
 *    中文、emoji、引号都不会坏。
 *
 * ③ **失败不抛，返回原因。** 通知是"最后一公里"，它挂了不该把这一轮算失败 ——
 *    但也不能静默：调用方拿 `{ ok:false, error }` 去写日志/设置页。
 * ============================================================================
 */
import { execFile as execFileCb } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const BACKENDS = ['none', 'desktop', 'webhook', 'command', 'dm', 'stdout', 'file']

const clip = (s, n = 800) => {
  const v = String(s ?? '')
  return v.length > n ? v.slice(0, n) + '…' : v
}

/**
 * 按域名生成对方认的报文。**这是这个文件里最值钱的一段**：
 * 四个平台的字段名分别是 `msg_type/msgtype/msgtype/{content}`，抄错一个就是 400。
 */
export function buildWebhookBody(url, { title = '通知', text = '', template = 'text' } = {}) {
  const md = template === 'markdown'
  const body = `${title}\n${text}`
  const u = String(url)
  if (u.includes('open.feishu.cn') || u.includes('larksuite.com')) {
    return md
      ? { msg_type: 'post', content: { post: { zh_cn: { title, content: [[{ tag: 'text', text: body }]] } } } }
      : { msg_type: 'text', content: { text: body } }
  }
  if (u.includes('oapi.dingtalk.com')) {
    return md ? { msgtype: 'markdown', markdown: { title, text: body } } : { msgtype: 'text', text: { content: body } }
  }
  if (u.includes('qyapi.weixin.qq.com')) {
    return md ? { msgtype: 'markdown', markdown: { content: body } } : { msgtype: 'text', text: { content: body } }
  }
  if (u.includes('workbuddy')) return { title, text: body, format: md ? 'markdown' : 'text' }
  // 通用兜底（含 QQ 机器人常见的 { content } 约定）—— 多带几个键，比少带好
  return { title, text: body, content: body, format: md ? 'markdown' : 'text' }
}

function defaultExecFile(cmd, args, opts) {
  return new Promise((resolve) => {
    try {
      execFileCb(cmd, args, { ...opts, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err ? String(err.message ?? err) : null })
      })
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: '', error: String(e?.message ?? e) })
    }
  })
}

/** Windows 的 Toast 通知（PowerShell WinRT）。不是 win32 就退回打印。 */
async function desktopToast(title, text, execFile) {
  if (process.platform !== 'win32') {
    return { ok: true, detail: `[通知] ${title}\n${text}` }
  }
  const stamp = `${process.pid}-${Date.now()}`
  const script = join(tmpdir(), `bili-toast-${stamp}.ps1`)
  const xml = join(tmpdir(), `bili-toast-${stamp}.xml`)
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '"<toast><visual><binding template=""ToastGeneric""><text></text><text></text></binding></visual></toast>" | Out-File -Encoding utf8 $env:BILI_TOAST_XML',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$x.LoadXml([IO.File]::ReadAllText($env:BILI_TOAST_XML))',
    '$n = $x.GetElementsByTagName("text")',
    '$n.Item(0).AppendChild($x.CreateTextNode($env:BILI_TOAST_TITLE)) | Out-Null',
    '$n.Item(1).AppendChild($x.CreateTextNode($env:BILI_TOAST_TEXT)) | Out-Null',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("DeepSeek Harness").Show([Windows.UI.Notifications.ToastNotification]::new($x))',
  ].join('\n')
  try {
    writeFileSync(script, ps, 'utf8')
    const r = await execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      env: { ...process.env, BILI_TOAST_TITLE: clip(title, 120), BILI_TOAST_TEXT: clip(text, 400), BILI_TOAST_XML: xml },
    })
    return r.ok ? { ok: true, detail: '桌面通知已发送' } : { ok: false, error: r.error || r.stderr || 'powershell 执行失败' }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    try { rmSync(script, { force: true }) } catch { /* 删不掉不影响 */ }
    try { rmSync(xml, { force: true }) } catch { /* 同上 */ }
  }
}

/**
 * 发一条通知。
 *
 * @param {object} config  `config.notify`
 * @param {object} msg     `{ title, text }`
 * @param {object} [hooks] 测试注入点：`{ fetch, execFile, dm, dryRun, now }`
 * @returns {Promise<{ok:boolean, backend:string, detail?:string, error?:string, body?:object}>}
 */
export async function sendNotify(config = {}, { title = '通知', text = '' } = {}, hooks = {}) {
  const type = BACKENDS.includes(config.type) ? config.type : 'none'
  const fetchImpl = hooks.fetch ?? globalThis.fetch
  const execFile = hooks.execFile ?? defaultExecFile
  const dryRun = Boolean(hooks.dryRun)
  const out = (extra) => ({ ok: true, backend: type, ...extra })
  const fail = (error, detail) => ({ ok: false, backend: type, error: String(error ?? '未知错误'), detail })

  try {
    switch (type) {
      case 'none':
        return out({ detail: '方式=none（不推送）' })

      case 'stdout':
        return out({ detail: `[通知] ${title}\n${text}` })

      case 'file': {
        const file = String(config.path || '').trim() || join(tmpdir(), 'bili-notify.log')
        if (dryRun) return out({ detail: `[dry] 会写入 ${file}` })
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), title, text }) + '\n', 'utf8')
        return out({ detail: `已写入 ${file}` })
      }

      case 'webhook': {
        const url = String(config.url || '').trim()
        if (!url) return fail('没配 webhook 地址')
        const body = buildWebhookBody(url, { title, text, template: config.template })
        if (dryRun) return out({ detail: '[dry] 只算报文，不发', body })
        if (typeof fetchImpl !== 'function') return fail('这个 Node 没有 fetch')
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        const raw = await r.text?.().catch?.(() => '') ?? ''
        if (!r.ok) return fail(`webhook HTTP ${r.status} ${clip(raw, 160)}`)
        return out({ detail: `webhook ${r.status} ${clip(raw, 120)}` })
      }

      case 'command': {
        const cmd = String(config.cmd || '').trim()
        if (!cmd) return fail('没配推送命令')
        // 🔴 旧写法 `$MSG` 会走 shell ⇒ 正文里一个引号就能破开引号边界（= 遥控执行命令）。
        //    消息来源是陌生评论/弹幕，这条不能松。
        if (cmd.includes('$MSG')) return fail('$MSG 已弃用（有命令注入风险）：请把 cmd 填成可执行文件、参数放 args，消息会自动作为最后一个参数传入')
        const args = Array.isArray(config.args) ? config.args.map(String) : []
        if (dryRun) return out({ detail: `[dry] 会执行 ${cmd} ${args.join(' ')} "<消息>"` })
        const r = await execFile(cmd, [...args, String(text)], {
          env: { ...process.env, BILI_NOTIFY_TITLE: String(title), BILI_NOTIFY_TEXT: String(text) },
        })
        return r.ok ? out({ detail: '命令已执行' }) : fail(r.error || r.stderr || '命令失败')
      }

      case 'dm': {
        if (typeof hooks.dm !== 'function') return fail('这个环境没有私信通道（需要宿主注入 dm 发送函数）')
        if (dryRun) return out({ detail: '[dry] 不会真发私信' })
        const r = await hooks.dm({ text: clip(text, 480) })
        return r?.ok ? out({ detail: r.detail || '私信已发送' }) : fail(r?.error || '私信发送失败')
      }

      case 'desktop':
      default: {
        if (dryRun) return out({ detail: `[dry] 桌面通知：${clip(text, 60)}` })
        const r = await desktopToast(title, text, execFile)
        return r.ok ? out({ detail: r.detail }) : fail(r.error)
      }
    }
  } catch (e) {
    return fail(e?.message ?? e)
  }
}

/** 设置页「发条测试」用：真发一条，然后把结果原样带回去给人看 */
export const TEST_MESSAGE = () => ({
  title: 'B站鱼娘 · 通知测试',
  text: `这是一条测试消息 ✓\n如果你看到它，说明「消息推送」配好了。\n（${new Date().toLocaleString('zh-CN', { hour12: false })}）`,
})
