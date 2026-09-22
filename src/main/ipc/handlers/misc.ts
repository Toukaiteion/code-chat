import type { HandlerContext, Registry } from '../registry.ts'

/** 并发上限（§2.3 / §4.5：可配置，默认 3）。等 M5 的调度器落地后改读真实配置。 */
export const DEFAULT_CONCURRENCY = 3

export function registerMisc(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  /**
   * 告诉主进程「渲染层现在正看着哪」。**这是纯内存操作，不落库** ——
   * 它是本进程内的一次视图声明，重启后没有意义。
   *
   * 消费方是 M6：出站推送据此**抑制非活跃空间**的批次（§4.3），
   * 避免三个空间的 token delta 同时往一个屏幕上倒。
   * M3 先把写入端与读取端接好，抑制逻辑本身不在本里程碑。
   */
  r.handle('view:setActive', ({ workspaceId, sessionId }) => {
    ctx.view.workspaceId = workspaceId
    ctx.view.sessionId = sessionId
    return null
  })

  /**
   * 运行时状态。三个字段的**诚实程度不一样**，写清楚：
   *
   * - `liveTurns`：**真的**（`turn.listLive()`，读 `idx_turn_running` 偏索引）。
   * - `queueDepth`：**真的是 0**，因为还没有调度器 —— 没有任何东西会把轮次
   *   放进队列。这不是桩数据：一个空队列的事实就是深度为 0。
   * - `slots`：`used` 由 liveTurns 里的 `running` 数得出（同样是真值），
   *   `total` 是 §2.3 的默认配置。没有调度器时 `used` 必然为 0，
   *   但界面照常渲染「0 / 3」，不会出现 `undefined`。
   */
  r.handle('runtime:getState', () => {
    const liveTurns = repos.turn.listLive()
    return {
      liveTurns,
      queueDepth: liveTurns.filter((t) => t.status === 'queued').length,
      slots: {
        used: liveTurns.filter((t) => t.status === 'running').length,
        total: DEFAULT_CONCURRENCY
      }
    }
  })
}
