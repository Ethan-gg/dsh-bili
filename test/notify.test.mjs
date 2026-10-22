/**
 * 通知后端单测：报文适配、注入防护、各后端的失败语义
 * 跑法：node --test "test/*.test.mjs"
 *
 * ⚠️ 不真的发消息、不开 PowerShell：`fetch` / `execFile` / `dm` 全部从 hooks 注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKENDS, buildWebhookBody, sendNotify } from '../src/host/notify.mjs'

const msg = { title: '今天三条', text: '第一条：BV1xx411c7mD' }

test('未知后端当 none 处理（配置被人手改坏也不炸）', async () => {
  const r = await sendNotify({ type: 'telegram' }, msg)
  assert.equal(r.ok, true)
  assert.equal(r.backend, 'none')
  assert.ok(BACKENDS.every((b) => typeof b === 'string'))
})

test('none / stdout：不碰网络也不碰磁盘', async () => {
  assert.equal((await sendNotify({ type: 'none' }, msg)).ok, true)
  const s = await sendNotify({ type: 'stdout' }, msg)
  assert.equal(s.ok, true)
  assert.match(s.detail, /第一条/)
})

test('file：追加 JSONL；dryRun 不写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-notify-'))
  const file = join(dir, 'n.log')
  const r = await sendNotify({ type: 'file', path: file }, msg)
  assert.equal(r.ok, true)
  const line = JSON.parse(readFileSync(file, 'utf8').trim())
  assert.equal(line.title, '今天三条')
  assert.equal(line.text, msg.text)

  const file2 = join(dir, 'm.log')
  const dry = await sendNotify({ type: 'file', path: file2 }, msg, { dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(existsSync(file2), false)
})

test('webhook：按域名生成对方认的报文（飞书/钉钉/企微/通用）', () => {
  const fs = buildWebhookBody('https://open.feishu.cn/open-apis/bot/v2/hook/x', msg)
  assert.equal(fs.msg_type, 'text')
  assert.match(fs.content.text, /今天三条/)

  const fsMd = buildWebhookBody('https://open.feishu.cn/open-apis/bot/v2/hook/x', { ...msg, template: 'markdown' })
  assert.equal(fsMd.msg_type, 'post')
  assert.equal(fsMd.content.post.zh_cn.title, '今天三条')

  const dd = buildWebhookBody('https://oapi.dingtalk.com/robot/send?access_token=x', msg)
  assert.equal(dd.msgtype, 'text')
  assert.match(dd.text.content, /今天三条/)

  const wc = buildWebhookBody('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', { ...msg, template: 'markdown' })
  assert.equal(wc.msgtype, 'markdown')
  assert.match(wc.markdown.content, /今天三条/)

  const generic = buildWebhookBody('https://example.com/hook', msg)
  assert.equal(generic.content, generic.text)
  assert.equal(generic.format, 'text')
})

test('webhook：真发的成功/失败都能分辨；dryRun 只算报文', async () => {
  const calls = []
  const okFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{"code":0}' }
  }
  const r = await sendNotify({ type: 'webhook', url: 'https://open.feishu.cn/x', template: 'text' }, msg, { fetch: okFetch })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.msg_type, 'text')

  const bad = await sendNotify({ type: 'webhook', url: 'https://open.feishu.cn/x' }, msg, {
    fetch: async () => ({ ok: false, status: 400, text: async () => 'bad token' }),
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /400/)

  const dry = await sendNotify({ type: 'webhook', url: 'https://open.feishu.cn/x' }, msg, { dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.body.msg_type, 'text')
})

test('webhook：没配地址就说清楚，不是静默成功', async () => {
  const r = await sendNotify({ type: 'webhook', url: '' }, msg, { fetch: async () => { throw new Error('不该被调用') } })
  assert.equal(r.ok, false)
  assert.match(r.error, /没配/)
})

test('command：消息是**最后一个参数**，且不走 shell', async () => {
  const seen = []
  const execFile = async (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { ok: true, stdout: '', stderr: '' } }
  const r = await sendNotify({ type: 'command', cmd: 'C:/tools/send.exe', args: ['--to', 'me'] }, msg, { execFile })
  assert.equal(r.ok, true)
  assert.equal(seen[0].cmd, 'C:/tools/send.exe')
  assert.deepEqual(seen[0].args, ['--to', 'me', msg.text], '消息必须是最后一个参数')
  assert.equal(seen[0].opts.env.BILI_NOTIFY_TEXT, msg.text)
  assert.equal(seen[0].opts.shell, undefined, '不许走 shell')
})

test('command：$MSG 直接拒（命令注入），不许"兼容老配置"', async () => {
  const r = await sendNotify({ type: 'command', cmd: 'curl $MSG' }, msg, { execFile: async () => { throw new Error('不该被调用') } })
  assert.equal(r.ok, false)
  assert.match(r.error, /\$MSG/)
})

test('command：没配命令 / 命令失败，都如实报错', async () => {
  assert.equal((await sendNotify({ type: 'command', cmd: '' }, msg)).ok, false)
  const bad = await sendNotify({ type: 'command', cmd: 'x.exe' }, msg, { execFile: async () => ({ ok: false, error: 'ENOENT' }) })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /ENOENT/)
})

test('dm：没有私信通道时报清楚；有通道才算成功；dryRun 不发', async () => {
  assert.equal((await sendNotify({ type: 'dm' }, msg)).ok, false)

  let sent = null
  const r = await sendNotify({ type: 'dm' }, msg, { dm: async (x) => { sent = x; return { ok: true } } })
  assert.equal(r.ok, true)
  assert.match(sent.text, /第一条/)

  const dry = await sendNotify({ type: 'dm' }, msg, { dryRun: true, dm: async () => { throw new Error('不该被调用') } })
  assert.equal(dry.ok, true)
})

test('desktop：dryRun 不真的弹窗', async () => {
  const r = await sendNotify({ type: 'desktop' }, msg, { dryRun: true, execFile: async () => { throw new Error('不该被调用') } })
  assert.equal(r.ok, true)
  assert.match(r.detail, /\[dry\]/)
})
