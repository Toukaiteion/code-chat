/**
 * 通道契约的类型层 —— **全部从 `schemas.ts` 推导**，不手写。
 *
 * 这样「类型」与「运行时校验」不可能分叉：改 schema 就是改类型，
 * 漏写 schema 会被下面的覆盖断言当场拦下。
 */
import type { z } from 'zod'
import type { InvokeChannel, PushChannel } from './channels.ts'
import type { INVOKE_SCHEMAS, PUSH_SCHEMAS } from './schemas.ts'

/** `true` 当且仅当 A 与 B 互相可赋值。 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

/** invoke 通道 → 它的请求/响应类型。 */
export type InvokeContract = {
  [K in keyof typeof INVOKE_SCHEMAS]: {
    req: z.infer<(typeof INVOKE_SCHEMAS)[K]['req']>
    res: z.infer<(typeof INVOKE_SCHEMAS)[K]['res']>
  }
}

/** push 通道 → 它的载荷类型。 */
export type PushContract = {
  [K in keyof typeof PUSH_SCHEMAS]: z.infer<(typeof PUSH_SCHEMAS)[K]>
}

export type ReqOf<K extends InvokeChannel> = InvokeContract[K]['req']
export type ResOf<K extends InvokeChannel> = InvokeContract[K]['res']
export type PushOf<K extends PushChannel> = PushContract[K]

// ─────────────────────────────────────────────────────────────
// ★ 覆盖断言：schema 表与通道清单必须严格一一对应
//
// 两头都会拦：
//   - 清单里加了通道却忘了写 schema  → 下面的 keyof 少一项，失败
//   - 写了 schema 却忘了加进清单      → keyof 多一项，失败
// 这正是「通道清单是唯一事实源」在类型层的落点。
// ─────────────────────────────────────────────────────────────

/** 导出只为让 `noUnusedLocals` 满意；下划线表示这是内部断言，不是公开 API。 */
export type _InvokeCoverage = Assert<Exact<keyof InvokeContract, InvokeChannel>>
export type _PushCoverage = Assert<Exact<keyof PushContract, PushChannel>>
