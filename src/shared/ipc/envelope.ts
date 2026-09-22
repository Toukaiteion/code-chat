/**
 * IPC 信封 —— 两端共用。**不 import electron，也不 import node**，
 * 所以渲染进程可以安全地 import 它。
 *
 * ★ 为什么 handler 必须**返回**信封而不是**抛**异常（方案 §4.3）：
 * `ipcMain.handle` 的异常跨进程边界时会被 Electron 重新序列化，
 * **只保留 message 与 stack，自定义字段全丢**。而 M2 的 repository 恰恰靠
 * `errcode` 区分约束类型（`SQLITE_CONSTRAINT_UNIQUE` = 2067 等，见 `persist/db.ts`）——
 * 靠抛异常等于主动扔掉唯一能区分「这个目录已经加过了」和
 * 「该成员已有主项目」的信息。所以：**handler 一律返回 IpcResult，绝不抛**。
 */

export const IPC_ERROR_CODES = [
  /** zod 拒绝了入站载荷。**handler 未被调用**，repository 更没被碰到。 */
  'E_INVALID_PAYLOAD',
  'E_NOT_FOUND',
  /** 唯一约束 / 偏索引冲突（errcode 2067 / 1555）。语义由 handler 翻译得更具体。 */
  'E_CONFLICT',
  /** 外键指向不存在的行（errcode 787）。 */
  'E_FK_MISSING',
  /** 通道已注册但能力要等后续里程碑（信封里会注明是哪个）。 */
  'E_NOT_IMPLEMENTED',
  'E_INTERNAL'
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

export interface IpcFailure {
  code: IpcErrorCode
  /** 给人看的中文说明。UI 可以直接展示。 */
  message: string
  /**
   * 结构化补充信息（如 `{ errcode: 2067 }` 或 `{ milestone: 'M4' }`）。
   *
   * ⚠️ **必须可结构化克隆** —— 跨进程走的是 Structured Clone，
   * 塞函数、类实例、Proxy 会在边界上炸，而且是在**接收方**炸，很难查。
   */
  detail?: unknown
}

export type IpcOk<T> = { ok: true; data: T }
export type IpcResult<T> = IpcOk<T> | { ok: false; error: IpcFailure }

export function ok<T>(data: T): IpcOk<T> {
  return { ok: true, data }
}

export function fail(code: IpcErrorCode, message: string, detail?: unknown): IpcResult<never> {
  // 显式构造而不是 { code, message, detail }，避免 detail === undefined 时
  // 多出一个键 —— 结构化克隆对 undefined 值键的处理在不同 Electron 版本上不一致。
  return detail === undefined ? { ok: false, error: { code, message } } : { ok: false, error: { code, message, detail } }
}

/**
 * 渲染侧的失败还原。让调用点写起来像普通 async 函数：
 *
 * ```ts
 * try { const list = await api.workspace.list() }
 * catch (e) { if (e instanceof IpcError && e.code === 'E_CONFLICT') … }
 * ```
 */
export class IpcError extends Error {
  readonly code: IpcErrorCode
  readonly detail: unknown

  constructor(failure: IpcFailure) {
    super(failure.message)
    this.name = 'IpcError'
    this.code = failure.code
    this.detail = failure.detail
  }
}

/** 拆信封：成功取 data，失败抛 IpcError。 */
export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data
  throw new IpcError(result.error)
}
