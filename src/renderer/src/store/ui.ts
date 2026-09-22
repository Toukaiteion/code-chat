/**
 * `ui` slice —— **纯属于这一屏**的状态：在看哪个空间、选中了谁、有没有未读，
 * 以及全应用**唯一**的错误出口。
 *
 * 它**不缓存任何实体**（那是 `entity` 的事）。判断标准很简单：
 * 刷新一次重来也无所谓的放这里；重来一次会让用户看到不同数据的放 entity。
 *
 * ★ 「错误只有一个出口」这条纪律落在 `toNotice()` 上：所有 slice 动作的
 * 失败都经它变成 `notices` 里的一条。于是组件层**不写 try/catch、不用 alert**，
 * 用户也不会在不同地方看到三种风格的报错。
 */
import { api } from '../ipc'
import { IpcError } from '@shared/ipc/envelope'
import type { ResOf } from '@shared/ipc/contract'
import type { Slice } from './index'

/**
 * 运行时概要（`runtime:getState`）。
 *
 * ⚠️ 它**本该属于 `live` slice**，而 M4 不建 `live`（见 `index.ts` 的说明）。
 * 在 M4 里它只是一个**只读的展示值**（运行中的轮、队列深度、并发槽位），
 * 所以先寄在 `ui` 下；M6 的调度器与 `stream:batch` 落地时会把它搬过去。
 */
export type RuntimeView = ResOf<'runtime:getState'>

export interface Notice {
  id: string
  level: 'info' | 'warning' | 'error'
  message: string
  /** 给人看的补充（错误码 + 结构化 detail）。**不是**给程序判断的字段。 */
  detail?: string
  at: number
}

/** 右侧详情面板在看谁。切换空间时清空 —— 不然会看到上一个空间的对象。 */
export type Selection = { kind: 'member' | 'project'; id: string } | null

export interface UiSlice {
  activeWorkspaceId: string | null
  activeSessionId: string | null
  selection: Selection
  /** 空间 id → 未读数（`workspace:unread` 推来的，M6 才会有非零值）。 */
  unread: Record<string, number>
  notices: Notice[]
  /** 进行中的动作，键由调用点命名（`'workspace:create'`…）。用来禁用按钮，防止双击建两个。 */
  pending: Record<string, boolean>
  /** 进程级的运行概要。`null` = 还没读回来（不是「零个在跑」）。 */
  runtime: RuntimeView | null

  loadRuntime(): Promise<void>
  setActiveWorkspace(id: string | null): void
  setActiveSession(id: string | null): void
  select(sel: Selection): void
  setUnread(workspaceId: string, count: number): void
  pushNotice(n: Omit<Notice, 'id' | 'at'>): void
  dismissNotice(id: string): void
  setPending(key: string, on: boolean): void
}

/** 通知 id 的自增种子。用模块级计数器而不是 `Date.now()` —— 同一毫秒内会撞。 */
let noticeSeq = 0

/** 一次最多留几条。再多就不是「提示」而是把界面淹了。 */
const MAX_NOTICES = 8

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // 循环引用等。绝不能因为「打印 detail 失败」而把真正的错误盖掉。
    return String(value)
  }
}

/**
 * 把任意异常翻译成一条通知。**唯一的错误出口**。
 *
 * `IpcError` 带 `code`（闭集合，给程序看）与 `detail`（结构化补充，给人看），
 * 两个都留下来：用户看到的是一句中文，而排查问题需要那串 code。
 */
export function toNotice(err: unknown, what: string): Omit<Notice, 'id' | 'at'> {
  if (err instanceof IpcError) {
    return {
      level: 'error',
      message: `${what}：${err.message}`,
      detail: err.detail === undefined ? err.code : `${err.code} · ${safeJson(err.detail)}`
    }
  }
  // 非 IpcError 意味着这是**我们自己的**编程错误（或者桥本身出了问题），
  // 更要原样露出来，别把它伪装成一次正常的业务失败。
  return {
    level: 'error',
    message: `${what}：${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * slice 工厂。签名用 `Slice<UiSlice>`（zustand 文档里的标准写法）——
 * 于是 `set` / `get` 的类型由 `StateCreator` 上下文推出来，不必手抄那串条件类型。
 */
export const createUiSlice: Slice<UiSlice> = (set, get) => ({
  activeWorkspaceId: null,
  activeSessionId: null,
  selection: null,
  unread: {},
  notices: [],
  pending: {},
  runtime: null,

  /**
   * 读一次运行概要。**只读、幂等**，可以放心在 effect 里调（StrictMode 跑两遍无害）。
   *
   * M4 里它读回来的必然是「0 个在跑、队列 0、槽位 0/3」—— 而且那是**真值**：
   * 没有调度器，就没有任何东西会进队列（`handlers/misc.ts` 有详述）。
   * 界面照常渲染这些数字，而不是像 M0 那样摆一串编出来的 token 数和金额。
   */
  async loadRuntime() {
    try {
      set({ runtime: await api.runtime.getState() })
    } catch (err) {
      get().pushNotice(toNotice(err, '读取运行状态'))
    }
  },

  /**
   * 切换当前空间。
   *
   * 除了改本地状态，还要告诉主进程「现在在看谁」（§4.3 的 `view:setActive`，
   * M6 靠它抑制非活跃空间的推送）。这条声明**纯内存、幂等**，所以
   * StrictMode 下被调用两次完全无害 —— 这也是它敢直接写在同步 setter 里的原因。
   */
  setActiveWorkspace(id) {
    set({ activeWorkspaceId: id, activeSessionId: null, selection: null })
    void api.view.setActive({ workspaceId: id, sessionId: null }).catch((err: unknown) => {
      get().pushNotice(toNotice(err, '告知主进程当前视图'))
    })
  },

  setActiveSession(id) {
    set({ activeSessionId: id })
    void api.view
      .setActive({ workspaceId: get().activeWorkspaceId, sessionId: id })
      .catch((err: unknown) => {
        get().pushNotice(toNotice(err, '告知主进程当前视图'))
      })
  },

  select(sel) {
    set({ selection: sel })
  },

  setUnread(workspaceId, count) {
    set((s) => ({ unread: { ...s.unread, [workspaceId]: count } }))
  },

  pushNotice(n) {
    const notice: Notice = { ...n, id: `n${++noticeSeq}`, at: Date.now() }
    // 新的在上面：出错时用户的眼睛在顶部，最新的那条不该被挤到需要滚动才看得见。
    set((s) => ({ notices: [notice, ...s.notices].slice(0, MAX_NOTICES) }))
  },

  dismissNotice(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
  },

  setPending(key, on) {
    set((s) => ({ pending: { ...s.pending, [key]: on } }))
  }
})
