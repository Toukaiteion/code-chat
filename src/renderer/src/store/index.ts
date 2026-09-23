/**
 * 全局 store —— §4.7 要求的三分：`entity` / `live` / `ui`。
 *
 * ★ **M4 只落 `entity` + `ui`，`live` 故意不建；M6b 把它补齐了。**
 *   `live` 装的是流式渲染的瞬时缓冲（`stream:batch` 30Hz 合批进来、按 turn 归并、
 *   随渲染消费），而 M4 **一次流都没有** —— 那些通道还是 `defer` 状态。
 *   先摆一个空壳只会让后面读代码的人以为实现漏了，或者以为它已经在工作。
 *   那次偏差到此结束：三份齐了，`docs/design.md` §4.7 上那个偏差标记可以撤掉。
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
import { createLiveSlice, type LiveSlice } from './live'

/** 全 store 的联合类型 —— slice 之间靠它互相读写（`entity` 的动作要写 `ui.notices`）。 */
export type Store = EntitySlice & UiSlice & LiveSlice

/** 一个 slice 的工厂签名：`set` 能写整个 store，但只有自己那份被声明出来。 */
export type Slice<T> = StateCreator<Store, [], [], T>

export const useStore = create<Store>()((...a) => ({
  ...createEntitySlice(...a),
  ...createUiSlice(...a),
  ...createLiveSlice(...a)
}))

export type { Notice, Selection, UiSlice, WorkspaceView } from './ui'
export type { EntitySlice } from './entity'
export type { LiveSlice, RuntimeView, WorkspaceUsage } from './live'
