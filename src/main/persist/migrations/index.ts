/**
 * 迁移 runner。
 *
 * 设计要点（全部围绕「幂等」与「失败可见」）：
 *
 * 1. **账本先行**：`schema_migrations` 表本身由 runner 负责创建，不放在任何迁移里 ——
 *    否则「如何记录第 0 号迁移已应用」会成为鸡生蛋问题。
 * 2. **每个迁移一个事务**。半途失败时，DB 停在上一个成功的版本上，而不是半新半旧。
 * 3. **不猜、不修**：发现库版本比代码新 → **抛错拒绝启动**。
 *    这通常意味着用户装了旧版应用，静默继续会写坏数据。
 * 4. **不校验 SQL 的语义**，只保证「跑过的不再跑」。迁移内容一旦发布就冻结。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Migration, MigrationResult } from './types.ts'
import { migration0001 } from './0001-init.ts'
import { migration0002 } from './0002-workspace-dir-name.ts'

/** 全部迁移，按版本升序。新增迁移只需往这里追加。 */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002]

/** 账本表的建表语句。刻意不放进迁移列表 —— 它是 runner 的基础设施。 */
const LEDGER_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
)`

/**
 * 把库升到当前代码的最新版本。**可重复调用**：第二次起是 no-op。
 *
 * @throws 若库的版本高于代码已知的最大版本（用户装了旧版应用）。
 */
export function runMigrations(
  db: DatabaseSync,
  list: readonly Migration[] = MIGRATIONS
): MigrationResult {
  assertWellFormed(list)

  db.exec(LEDGER_DDL)

  const current = currentVersion(db)
  const maxKnown = list.length === 0 ? 0 : list[list.length - 1].version

  if (current > maxKnown) {
    throw new Error(
      `数据库版本 ${current} 高于本应用已知的最高版本 ${maxKnown}。` +
        `这通常意味着你安装了更旧版本的 Code Chat。请升级应用，或使用新的数据目录。`
    )
  }

  const applied: number[] = []
  for (const m of list) {
    if (m.version <= current) continue
    // 每个迁移独立事务：失败时停在上一版本，不产生半新半旧的库
    db.exec('BEGIN')
    try {
      db.exec(m.up)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now()
      )
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 ${m.version}_${m.name} 执行失败，已回滚：${(err as Error).message}`, {
        cause: err
      })
    }
    applied.push(m.version)
  }

  return { applied, from: current, to: currentVersion(db) }
}

/** 当前已应用到第几版。0 = 全新库。 */
export function currentVersion(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number } | undefined
  // node:sqlite 返回 null-prototype 对象，取字段即可，不要做原型相关操作
  return row ? Number(row.v) : 0
}

/**
 * 迁移列表的静态校验。这些错误在开发期就该暴露，
 * 而不是等到用户的库上以「版本号冲突」的形式出现。
 */
function assertWellFormed(list: readonly Migration[]): void {
  let prev = 0
  const seen = new Set<number>()
  for (const m of list) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(`迁移版本号必须是 ≥1 的整数，收到 ${m.version}`)
    }
    if (seen.has(m.version)) throw new Error(`迁移版本号 ${m.version} 重复`)
    if (m.version <= prev) {
      throw new Error(`迁移列表必须按版本升序，${m.version} 出现在 ${prev} 之后`)
    }
    if (!m.name.trim()) throw new Error(`迁移 ${m.version} 缺少 name`)
    if (!m.up.trim()) throw new Error(`迁移 ${m.version} 的 up 为空`)
    seen.add(m.version)
    prev = m.version
  }
}
