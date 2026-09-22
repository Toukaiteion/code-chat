/**
 * 错误 → 信封的转换。
 *
 * **分层**（这是本文件的全部要点）：
 * - 这里只做**兜底**映射：SqliteError → E_CONFLICT / E_FK_MISSING，其余 → E_INTERNAL。
 * - **语义**翻译留给 handler —— 只有它知道上下文。`project-repo.ts` 里已经写明：
 *   「同一空间内 root_path 重复时会抛 SQLITE_CONSTRAINT_UNIQUE（errcode 2067）。
 *   调用方应捕获并翻译成「这个目录已经加过了」」。
 *
 * 刻意**不**在这里按表名解析 SQLite 的报错字符串（`UNIQUE constraint failed: x.y`）——
 * 那种解析极其脆弱，改一次 DDL 就静默失效。要区分就靠 `errcode`，或者由 handler
 * 带着上下文去判定。
 */
import {
  isSqliteError,
  SQLITE_CONSTRAINT_FOREIGNKEY,
  SQLITE_CONSTRAINT_PRIMARYKEY,
  SQLITE_CONSTRAINT_UNIQUE
} from '../persist/index.ts'
import { fail, type IpcErrorCode, type IpcResult } from '../../shared/ipc/envelope.ts'

/**
 * handler 抛这个来表达领域错误。
 *
 * ★ 为什么 handler **可以**抛：信封纪律约束的是**跨进程边界的那一次返回**，
 * 不是函数内部。registry 在边界上统一 catch 并转成信封，
 * 所以 handler 内部照常 `throw` 更顺手，不必到处手搓 `fail(...)`。
 */
export class AppError extends Error {
  readonly code: IpcErrorCode
  readonly detail: unknown

  constructor(code: IpcErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }
}

/** 便捷构造：`E_NOT_FOUND` 用得太频繁，值得一个专属类。 */
export class NotFoundError extends AppError {
  constructor(what: string, id: string) {
    super('E_NOT_FOUND', `${what}不存在：${id}`, { id })
    this.name = 'NotFoundError'
  }
}

/**
 * 把任意异常转成失败信封。**永远返回信封，永远不抛** ——
 * 包括 `detail` 不可结构化克隆这种边界情况。
 */
export function toEnvelope(err: unknown): IpcResult<never> {
  if (err instanceof AppError) {
    return fail(err.code, err.message, safeDetail(err.detail))
  }

  if (isSqliteError(err)) {
    const errcode = err.errcode
    if (errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
      return fail('E_CONFLICT', '该操作与已有数据冲突', { errcode })
    }
    if (errcode === SQLITE_CONSTRAINT_FOREIGNKEY) {
      return fail('E_FK_MISSING', '引用的目标不存在', { errcode })
    }
    return fail('E_INTERNAL', '数据库错误', { errcode })
  }

  if (err instanceof Error) {
    return fail('E_INTERNAL', err.message, { name: err.name })
  }

  return fail('E_INTERNAL', '未知错误', { value: String(err) })
}

/**
 * 结构化克隆会在**接收方**炸，排查成本极高；且 `undefined` 值键的行为
 * 在不同 Electron 版本上不一致。所以 detail 一律先过一遍 JSON 往返，
 * 不可序列化就降级成字符串说明 —— 信封本身永远不能因为 detail 而失败。
 */
function safeDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined
  try {
    const roundTripped = JSON.parse(JSON.stringify(detail))
    return roundTripped === undefined ? String(detail) : roundTripped
  } catch {
    return String(detail)
  }
}
