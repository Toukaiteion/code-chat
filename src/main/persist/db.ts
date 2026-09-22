/**
 * SQLite 连接层。
 *
 * 选型依据见方案 §2.1：Electron 44 内置 Node 24.21 → 直接用 `node:sqlite`，
 * 不需要 better-sqlite3，由此消除 electron-rebuild / asarUnpack 的整类问题。
 *
 * 这个文件是**唯一**允许知道「底层是 node:sqlite 还是 better-sqlite3」的地方
 * （除 repositories 之外）。`domain/` 不得 import 它 —— 见 §4.1 的架构约束。
 */
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'

/** 打开连接时统一设置的 PRAGMA。四项都有具体理由，见方案 §4.2。 */
const PRAGMAS = [
  // 读写并发。**必需** —— 写方在 UI 线程，没有 WAL 会直接卡住渲染。
  'PRAGMA journal_mode = WAL',
  // WAL 下的推荐值：断电最多丢最后一个事务，但不损库。
  'PRAGMA synchronous = NORMAL',
  // ★ 必须真生效。M1 已验证：不生效则级联删除**静默失效**，
  //   孤儿数据会一路积累到很晚才被发现。
  'PRAGMA foreign_keys = ON',
  // 写锁竞争时等待而非立刻抛 SQLITE_BUSY。
  'PRAGMA busy_timeout = 5000'
] as const

/**
 * 打开数据库并应用 PRAGMA。
 *
 * @param path 文件路径，或 `':memory:'`（测试用）。
 *
 * ⚠️ 生产环境**绝不要**传相对路径或 `__dirname` —— 打包后两者都会失效。
 * 调用方应传 `app.getPath('userData')` 拼出来的绝对路径（§4.2）。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  for (const pragma of PRAGMAS) db.exec(pragma)
  return db
}

/**
 * 在一个事务里跑 `fn`，异常时回滚。
 *
 * 不用 `db.exec('BEGIN')` 包一层的原因：嵌套调用会炸（SQLite 不支持嵌套事务），
 * 而 repository 之间互相调用是常态。用 SAVEPOINT 让嵌套变成合法的分层保存点。
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0
  const name = `sp_${depth}`
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`)
  txDepth.set(db, depth + 1)
  try {
    const result = fn()
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`)
    return result
  } catch (err) {
    // ★ 回滚失败**绝不能盖掉原始错误**。
    //   若原始错误本身就让事务提前结束了（例如它触发了一次隐式回滚），
    //   这里的 `no transaction is active` 会把真正的病因替换成一条毫无信息量的报错。
    //   所以回滚单独兜住，把失败挂到 `cause` 上而不是抛出去。
    try {
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`)
    } catch (rollbackErr) {
      attachCause(err, rollbackErr)
    }
    throw err
  } finally {
    if (depth === 0) txDepth.delete(db)
    else txDepth.set(db, depth)
  }
}

/**
 * 把一个错误的 `cause` 挂到另一个错误上，**不覆盖已有的 cause**。
 * `Error.prototype.cause` 只读，所以只能重建；类型不符时退化为打日志式的静默忽略，
 * 总比抛出去盖掉原始错误强。
 */
export function attachCause(primary: unknown, secondary: unknown): void {
  if (typeof primary !== 'object' || primary === null) return
  const e = primary as { cause?: unknown }
  if (e.cause !== undefined) return
  try {
    e.cause = secondary
  } catch {
    /* 冻结对象之类，忽略 —— 原始错误更重要 */
  }
}

/** 每个连接当前的嵌套事务深度。WeakMap 让连接被 GC 时自动清理。 */
const txDepth = new WeakMap<DatabaseSync, number>()

/**
 * `node:sqlite` 抛出的错误形状。实测（Node 24.18）：
 * - `code` 恒为 `'ERR_SQLITE_ERROR'`
 * - `errcode` 是 SQLite 原生码，**可以据此区分**是哪类约束
 */
export interface SqliteError extends Error {
  code?: string
  errcode?: number
}

/** SQLITE_CONSTRAINT_PRIMARYKEY / _UNIQUE —— 实测 1555 / 2067 都归到这两类 */
export const SQLITE_CONSTRAINT = 19
/** SQLITE_CONSTRAINT_FOREIGNKEY —— 实测 787 */
export const SQLITE_CONSTRAINT_FOREIGNKEY = 787
/** SQLITE_CONSTRAINT_PRIMARYKEY —— 实测 1555 */
export const SQLITE_CONSTRAINT_PRIMARYKEY = 1555
/** SQLITE_CONSTRAINT_UNIQUE —— 实测 2067 */
export const SQLITE_CONSTRAINT_UNIQUE = 2067

/** 判断错误是否是某类约束失败。用于把 DB 约束翻译成领域错误。 */
export function isSqliteError(err: unknown, errcode?: number): err is SqliteError {
  if (typeof err !== 'object' || err === null) return false
  const e = err as SqliteError
  if (e.code !== 'ERR_SQLITE_ERROR') return false
  return errcode === undefined || e.errcode === errcode
}

/** 预编译语句的类型别名，避免 repositories 到处 import。 */
export type Stmt = StatementSync
