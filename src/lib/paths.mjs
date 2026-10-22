/**
 * src/lib/paths.mjs —— 全部落盘路径的唯一出处
 * ============================================================================
 * 规矩：**只有这个文件知道路径长什么样**。别的模块一律 import，不许自己拼。
 *
 * 家目录换了（2.1 起）：
 *   `$DSH_HOME/bili/`          ← 现在的家
 *   `$DSH_HOME/bili-duty/`     ← 老的家（scroll ≤2.0），只读迁移源
 *   `~/.bili-ai/`              ← whale 的老家，只读迁移源
 *
 * 为什么换名字：`bili-duty` 是"值班"的语义，而 2.1 之后这里住的是"她"——
 * 人设、记忆、账本、日记、云桥都在这儿。名字得对得上内容，不然下一个人读到会误解。
 * ============================================================================
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** DSH 家（`$DSH_HOME` → `~/.dsh`）。与宿主 `dshHomePath` 的口径一致。 */
export function resolveDshHome(env = process.env) {
  const v = String(env.DSH_HOME ?? '').trim()
  return v ? resolve(v) : join(homedir(), '.dsh')
}

/** 插件自己的家：`$DSH_HOME/bili` */
export function resolveBiliHome(env = process.env) {
  return join(resolveDshHome(env), 'bili')
}

/** 老位置（只读）。`exists()` 判断用，别往里写。 */
export function legacyPaths(env = process.env) {
  const dsh = resolveDshHome(env)
  const userHome = env.USERPROFILE || env.HOME || homedir()
  return {
    /** scroll ≤2.0 的家 */
    scrollDir: join(dsh, 'bili-duty'),
    /** scroll ≤2.0 的配置（其实就在 scrollDir 里） */
    scrollConfig: join(dsh, 'bili-duty', 'config.json'),
    /** whale 的配置 */
    whaleConfig: join(dsh, 'bili-whale.config.json'),
    /** whale 的作息旧文件（会覆盖新配置的 schedule 段，迁移时要读） */
    whaleNight: join(dsh, 'whale-night.config.json'),
    /** whale 的数据目录（与 DSH_HOME 无关，这是它自己的约定） */
    whaleAiDir: join(userHome, '.bili-ai'),
    /** scroll 二维码落点（登录页要用） */
    qrcode: join(dsh, 'bili-duty', 'qrcode_login.png'),
  }
}

/** 家里的固定子路径。新增文件先加到这里。 */
export function homePaths(home = resolveBiliHome()) {
  return {
    home,
    config: join(home, 'config.json'),
    persona: join(home, 'persona.md'),
    duty: join(home, 'duty.md'),
    charterLedger: join(home, 'charter.sha256'),
    credential: join(home, 'credential.json'),
    /** scroll 老名字：Python 侧写死 `Path(__file__).parent / "bili_credential.json"` */
    legacyCredential: join(home, 'bili_credential.json'),
    out: join(home, 'out'),
    digest: join(home, 'digest'),
    reports: join(home, 'reports'),
    seen: join(home, 'seen.md'),
    state: join(home, 'state.json'),
    log: join(home, 'duty.log'),
    installLog: join(home, 'install.log'),
    ledgerDir: join(home, 'ledger'),
    shares: join(home, 'ledger', 'shares.json'),
    replies: join(home, 'ledger', 'replies.json'),
    seenLedger: join(home, 'ledger', 'seen.jsonl'),
    memoryDir: join(home, 'memory'),
    events: join(home, 'memory', 'events.jsonl'),
    diaryOwner: join(home, 'memory', 'diary-owner'),
    diarySelf: join(home, 'memory', 'diary-self'),
    syncDir: join(home, 'sync'),
    outbox: join(home, 'sync', 'outbox.jsonl'),
    inbox: join(home, 'sync', 'inbox.jsonl'),
    cursor: join(home, 'sync', 'cursor.json'),
    secret: join(home, 'sync', 'secret'),
    seenIds: join(home, 'sync', 'seen-ids.json'),
    syncQueue: join(home, 'sync', 'queue.jsonl'),
    migratedMarker: join(home, '.migrated-v1'),
  }
}

/** 这个路径是不是老位置的（迁移器用；防止把新家当迁移源） */
export function isLegacy(p) {
  return /(^|[\\/])(bili-duty|\.bili-ai)([\\/]|$)/.test(String(p)) || /bili-whale\.config\.json$/.test(String(p))
}

export const exists = (p) => { try { return existsSync(p) } catch { return false } }
