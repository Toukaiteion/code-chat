/**
 * 持久化层的对外入口。
 *
 * 上层（domain / ipc handlers）**只**从这里拿 repository，
 * 不直接接触 `node:sqlite`。这样将来若要换驱动，只需改这一层。
 */
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, withTransaction } from './db.ts'
import { runMigrations, currentVersion } from './migrations/index.ts'
import { workspaceRepo } from './repositories/workspace-repo.ts'
import { projectRepo } from './repositories/project-repo.ts'
import { actorRepo } from './repositories/actor-repo.ts'
import { memberRepo } from './repositories/member-repo.ts'
import { sessionRepo } from './repositories/session-repo.ts'
import { turnRepo } from './repositories/turn-repo.ts'
import { messageRepo } from './repositories/message-repo.ts'

export interface Repositories {
  workspace: ReturnType<typeof workspaceRepo>
  project: ReturnType<typeof projectRepo>
  actor: ReturnType<typeof actorRepo>
  member: ReturnType<typeof memberRepo>
  session: ReturnType<typeof sessionRepo>
  turn: ReturnType<typeof turnRepo>
  message: ReturnType<typeof messageRepo>
}

export interface Store {
  db: DatabaseSync
  repos: Repositories
  /** 事务边界。嵌套调用安全 —— 见 `withTransaction` 的 SAVEPOINT 实现。 */
  tx: <T>(fn: () => T) => T
  /** 已应用的 schema 版本 */
  schemaVersion: number
  close: () => void
}

/**
 * 打开数据库、跑迁移、装配 repository。
 *
 * 顺序是**强制的**：repository 的工厂函数在构造时就会 `db.prepare(...)`，
 * 表不存在会直接抛错。先迁移再装配，问题会在启动时立刻暴露，
 * 而不是等到第一次查询。
 */
export function openStore(path: string): Store {
  const db = openDatabase(path)
  runMigrations(db)

  const repos: Repositories = {
    workspace: workspaceRepo(db),
    project: projectRepo(db),
    actor: actorRepo(db),
    member: memberRepo(db),
    session: sessionRepo(db),
    turn: turnRepo(db),
    message: messageRepo(db)
  }

  return {
    db,
    repos,
    tx: (fn) => withTransaction(db, fn),
    schemaVersion: currentVersion(db),
    close: () => db.close()
  }
}

export { openDatabase, withTransaction } from './db.ts'
export { runMigrations, currentVersion, MIGRATIONS } from './migrations/index.ts'
export type { Migration, MigrationResult } from './migrations/types.ts'
export {
  isSqliteError,
  SQLITE_CONSTRAINT,
  SQLITE_CONSTRAINT_FOREIGNKEY,
  SQLITE_CONSTRAINT_PRIMARYKEY,
  SQLITE_CONSTRAINT_UNIQUE
} from './db.ts'
export { FRAME_PAYLOAD_LIMIT } from './repositories/message-repo.ts'
