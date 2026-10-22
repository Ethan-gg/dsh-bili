import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

/**
 * 找 ffmpeg。找不到返回 null（不是抛错 —— "没装 ffmpeg" 是正常状态）。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function findFfmpeg(env = process.env) {
  const explicit = String(env.FFMPEG_PATH || '').trim()
  if (explicit) return explicit
  // PATH 上有没有：不真跑，只按目录找可执行文件名（Windows 上带 .exe）
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']
  for (const dir of String(env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    const d = dir.trim()
    if (!d) continue
    for (const n of names) {
      try {
        const p = d.endsWith('\\') || d.endsWith('/') ? d + n : d + (process.platform === 'win32' ? '\\' : '/') + n
        if (existsSync(p)) return p
      } catch { /* 忽略坏 PATH 段 */ }
    }
  }
  return null
}

/**
 * 跑一次 ffmpeg。返回 `{ ok, code, stderr }`，**不抛**（调用方按 ok 处理）。
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [opts]
 */
export function runFfmpeg(bin, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, code: -1, stderr: String(e?.message ?? e) })
    }
    let err = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已经没了 */ } finish({ ok: false, code: -2, stderr: 'ffmpeg 超时' }) }, timeoutMs)
    timer.unref?.()
    child.stderr?.on('data', (b) => { err += String(b); if (err.length > 4000) err = err.slice(-4000) })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, code: -1, stderr: String(e?.message ?? e) }) })
    child.on('exit', (code) => { clearTimeout(timer); finish({ ok: code === 0, code, stderr: err.slice(-1500) }) })
  })
}
