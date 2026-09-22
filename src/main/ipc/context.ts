import { randomUUID } from 'node:crypto'
import type { Store } from '../persist/index.ts'
import type { ActiveView, HandlerContext } from './registry.ts'

/**
 * `HandlerContext` 的**真实**实现 —— 注入的 `now` / `newId` 在这里落到
 * `Date.now()` / `randomUUID()`。生产代码里这是唯一一处。
 *
 * 测试用的是同一套 handler，但把这两个换成计数器（见 `test/ipc/`）——
 * 于是断言可以写「id 是 'id-1'」，而不是只能写「id 非空」。
 */
export function createContext(store: Store): HandlerContext {
  const view: ActiveView = { workspaceId: null, sessionId: null }

  return {
    store,
    now: () => Date.now(),
    newId: () => randomUUID(),
    view
  }
}
