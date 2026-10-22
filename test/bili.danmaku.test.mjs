/**
 * 弹幕解析/汇总单测（纯函数，不碰网络）
 * 跑法：node --test "test/*.test.mjs"
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDanmakuXml, summarizeDanmaku } from '../src/bili/danmaku.mjs'

test('parseDanmakuXml：容忍实体/空白/坏条目，只留能用的', () => {
  const xml = '<i>'
    + '<d p="1.5,1,25,16777215,1750000000,0,u1,d1">A &amp; B</d>'
    + '<d p="2,1,25,16777215,1750000000,0,u2,d2">  多  空白  </d>'
    + '<d p="oops,1,25,0,0,0,u3,d3">坏时间</d>'
    + '<d p="3,1,25,0,0,0,u4,d4"></d>'
    + '<x p="4">不是 d</x>'
    + '</i>'
  const list = parseDanmakuXml(xml)
  assert.deepEqual(list.map((x) => x.text), ['A & B', '多 空白'])
  assert.equal(list[0].at, 1.5)
  assert.equal(list[0].mode, 1)
})

test('summarizeDanmaku：热区按时间分桶、top 只收重复出现的梗、sample 取最后几条', () => {
  const list = [
    { at: 0, text: 'a' }, { at: 1, text: '梗' }, { at: 2, text: '梗' }, { at: 99, text: 'b' }, { at: 100, text: 'c' },
  ]
  const s = summarizeDanmaku(list, { duration: 120, buckets: 4 })
  assert.equal(s.count, 5)
  assert.equal(s.duration, 120)
  assert.equal(s.heat.length, 4)
  assert.equal(s.top[0].text, '梗')
  assert.equal(s.top[0].count, 2)
  assert.equal(s.sample[0].text, 'c', '抽样按时间倒序（最后出现的在前）')
  // 没有重复就不编 top
  assert.deepEqual(summarizeDanmaku([{ at: 1, text: 'x' }], { duration: 10 }).top, [])
})
