import { randomUUID } from 'node:crypto'
import type { Store } from '../persist/index.ts'
import type { Runtime } from '../process/runtime.ts'
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
 *
 * ## 为什么 `view` 是**递进来**的，而不是本文件自己 `{}` 一个
 *
 * 合批器（`process/event-batcher.ts`）按 `ActiveView.workspaceId` 抑制非活跃空间的推流，
 * 而它是**持引用**读的 —— 每帧都重新读一次那个字段，所以它必须与 `view:setActive`
 * 写的是**同一个对象**。本文件自己 new 一个的话，`createRuntime` 就得先拿到它，
 * 于是 `context → runtime → view` 与 `context → view` 两条路会造出两个视图，
 * 症状是「切了空间但推流照旧」——一个不报错、只是不生效的 bug。
 * 递进来之后这件事变成**调用方一眼可见**的：同一个 `view` 对象交出去两次。
 */

/** 建一个空白视图。调用方持有它，并**同一个**交给 `createRuntime` 与 `createContext`。 */
export function createActiveView(): ActiveView {
  return { workspaceId: null, sessionId: null }
}

export interface ContextOptions {
  store: Store
  sys: SysCapabilities
  runtime: Runtime
  /** 与递给 `createRuntime` 的必须是**同一个对象**（见文件头最后一段）。 */
  view: ActiveView
}

export function createContext(opts: ContextOptions): HandlerContext {
  return {
    store: opts.store,
    now: () => Date.now(),
    newId: () => randomUUID(),
    view: opts.view,
    sys: opts.sys,
    runtime: opts.runtime
  }
}
