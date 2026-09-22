import { randomUUID } from 'node:crypto'
import type { Store } from '../persist/index.ts'
import type { ActiveView, HandlerContext, SysCapabilities } from './registry.ts'

/**
 * `HandlerContext` 的**装配点** —— 注入的 `now` / `newId` 在这里落到
 * `Date.now()` / `randomUUID()`。生产代码里这是唯一一处。
 *
 * 测试用的是同一套 handler，但把它们换成计数器（见 `test/ipc/`）——
 * 于是断言可以写「id 是 'id-1'」，而不是只能写「id 非空」。
 *
 * ★ 本文件**刻意不 import electron**：`sys`（对话框、shell、workspacesRoot、git 定位器）
 * 由调用方从外面递进来。生产环境递的是 `system-capabilities.ts`，
 * 测试递的是一组固定实现（临时根目录 + 预设的 pickPath + 可控的 locateGit）。
 * 这条边界就是 M4 的「本机没装 git」与「建空间」两条分支能被自动测到的全部原因。
 */
export function createContext(store: Store, sys: SysCapabilities): HandlerContext {
  const view: ActiveView = { workspaceId: null, sessionId: null }

  return {
    store,
    now: () => Date.now(),
    newId: () => randomUUID(),
    view,
    sys
  }
}
