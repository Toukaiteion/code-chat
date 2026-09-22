/**
 * 全局 store —— §4.7 要求的三分：`entity` / `live` / `ui`。
 *
 * ★ **M4 只落 `entity` + `ui`，`live` 故意不建。**
 *   `live` 装的是流式渲染的瞬时缓冲（`stream:batch` 30Hz 合批进来、按 turn 归并、
 *   随渲染消费），而 M4 **一次流都没有** —— 那些通道还是 `defer` 状态。
 *   先摆一个空壳只会让后面读代码的人以为实现漏了，或者以为它已经在工作。
 *   它跟 M6 的 `stream:batch` 一起落地。这是对 §4.7 的**有意**偏差，已记进 `docs/design.md`。
 *
 * 用法：
 * ```ts
 * const notices = useStore((s) => s.notices)          // 只订阅用得上的那一片
 * const createWorkspace = useStore((s) => s.createWorkspace)
 * ```
 *
 * ⚠️ 选择器返回**新建的对象/数组**会让 zustand v5 每次渲染都判定「变了」而无限重渲染。
 *    所以派生取值要么用原子字段（`s.workspaces`），要么在组件里用模块级空数组兜底
 *    （见 `components/ProjectList.tsx` 的 `EMPTY_PROJECTS`）。
 */
import type { StateCreator } from 'zustand'
import { create } from 'zustand'
import { createEntitySlice, type EntitySlice } from './entity'
import { createUiSlice, type UiSlice } from './ui'

/** 全 store 的联合类型 —— slice 之间靠它互相读写（`entity` 的动作要写 `ui.notices`）。 */
export type Store = EntitySlice & UiSlice

/** 一个 slice 的工厂签名：`set` 能写整个 store，但只有自己那份被声明出来。 */
export type Slice<T> = StateCreator<Store, [], [], T>

export const useStore = create<Store>()((...a) => ({
  ...createEntitySlice(...a),
  ...createUiSlice(...a)
}))

export type { Notice, Selection, UiSlice } from './ui'
export type { EntitySlice } from './entity'
