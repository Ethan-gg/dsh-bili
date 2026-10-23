/**
 * `src/lib/seen.mjs` —— 「它刷过的视频」列表的数据来源
 * ⭐ 起因（2026-10-23 用户）：设置页显示「今天已挑 15/15」，但「它刷过的视频」永远空着。
 *    seen.md 里明明有记录，只是格式从表格变成了圆点行，老解析器只认表格 ⇒ 一条都读不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSeenTable } from '../src/lib/seen.mjs'

const HEAD = [
  '# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）',
  '',
  '## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）',
  '',
  '| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |',
  '| --- | --- | --- | --- | --- |',
  '| BV1JcnW6pEFT | 321571598912 | （楼中楼才填） | 2026-10-23 10:19 | @Gmnnm 刷B站那插件 2.0.2 被逐行 |',
  '',
  '## 看过的视频',
].join('\n')

test('现在的圆点格式：挑中的、跳过的一行一条都能读出来', () => {
  const text = HEAD + '\n'
    + '- 2026-10-23 · BV1JcnW6pEFT · 大肥鱼的日报写着"一切正常"？实际上有致命bug · 王的土豆 · 挑了（值得看）：2.0.2 体检 · https://www.bilibili.com/video/BV1JcnW6pEFT\n'
    + '- 2026-10-23 · BV1UBn86nEsA · 我惊呆了!DeepSeek选择了blender · 三年设计 · 跳过（Blender 应用演示） · https://www.bilibili.com/video/BV1UBn86nEsA\n'
    + '- 2026-10-22 · BV1GSnk6aEUz · 【DSH】刷B站插件2.0 发布 · 凌羽clover · 挑了（可以看） · https://www.bilibili.com/video/BV1GSnk6aEUz\n'
  const rows = parseSeenTable(text)
  assert.equal(rows.length, 3)
  const a = rows.find((r) => r.bvid === 'BV1JcnW6pEFT')
  assert.equal(a.day, '2026-10-23')
  assert.equal(a.title, '大肥鱼的日报写着"一切正常"？实际上有致命bug')
  assert.equal(a.up, '王的土豆')
  assert.equal(a.picked, true)
  const b = rows.find((r) => r.bvid === 'BV1UBn86nEsA')
  assert.equal(b.picked, false)
  assert.match(b.status, /跳过/)
  // 挑中的排在同一天前面
  assert.equal(rows[0].bvid, 'BV1JcnW6pEFT')
})

test('评论记录表里的 BV ⇒ 标成「发过了」，但它自己不算一条观看记录', () => {
  const rows = parseSeenTable(HEAD)
  assert.equal(rows.length, 0)              // 只有评论记录、没有观看行
  // 有观看行时，同 BV 命中评论记录 ⇒ delivered
  const text = HEAD + '\n- 2026-10-23 · BV1JcnW6pEFT · 标题 · UP · 挑了（值得看） · https://x\n'
  const rows2 = parseSeenTable(text)
  assert.equal(rows2.length, 1)
  assert.equal(rows2[0].delivered, true)
  assert.equal(rows2[0].commented, true)
})

test('老式表格格式仍然认（升级上来的老 seen.md）', () => {
  const text = '## 看过的视频\n'
    + '| 日期 | bvid | 标题 | UP | 状态 |\n'
    + '| --- | --- | --- | --- | --- |\n'
    + '| 2026-10-22 | BV1GSnk6aEUz | 标题A | UP1 | 挑了（值得看） |\n'
    + '| 2026-10-22 | BV12jn66jEyD | 标题B | UP2 | 跳过（无字幕） |\n'
  const rows = parseSeenTable(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].bvid, 'BV1GSnk6aEUz')
  assert.equal(rows[0].picked, true)
  assert.equal(rows[1].picked, false)
})

test('没有 BV 的汇总行 / 表头 / 乱行都跳过，同一天同一 BV 只留一条', () => {
  const text = [
    '## 看过的视频',
    '- 2026-10-22 18:34 · 本轮今日额度已满（6/6），未挑新视频；只复核了自己的评论（见 digest）。',
    '- 2026-10-23 · BV1JcnW6pEFT · 标题 · UP · 挑了（值得看） · https://x',
    '- 2026-10-23 · BV1JcnW6pEFT · 标题 · UP · 挑了（值得看） · https://x',
    '| 日期 | bvid | 标题 | UP | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '随便一行不是记录的文本',
  ].join('\n')
  const rows = parseSeenTable(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bvid, 'BV1JcnW6pEFT')
})

test('空文本 / 乱码不抛异常', () => {
  assert.deepEqual(parseSeenTable(''), [])
  assert.deepEqual(parseSeenTable(undefined), [])
  assert.deepEqual(parseSeenTable('随便什么\n没有记录'), [])
})
