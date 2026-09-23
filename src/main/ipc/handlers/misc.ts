import type { HandlerContext, Registry } from '../registry.ts'

/** 并发上限（§2.3 / §4.5）。**真正的所有者是调度器**，这里只是把它报给 UI。 */
export const DEFAULT_CONCURRENCY = 3

export function registerMisc(r: Registry, ctx: HandlerContext): void {
  /**
   * 告诉主进程「渲染层现在正看着哪」。**纯内存操作，不落库** ——
   * 它是本进程内的一次视图声明，重启后没有意义。
   *
   * 消费方是合批器：出站推送据此抑制非活跃空间的批次（§4.3）。
   * ⚠️ **抑制在合批器里，不在这里、也不在传输层** —— 那是同一件事只能有一个所有者的
   * 老规矩（§4.7）。放在传输层的话，「被抑制的帧要累加未读」就没有地方可写了，
   * 因为传输层看不到「一个轮次」这个单位。
   *
   * 顺带把该空间的未读清零：用户已经切过去看了。
   */
  r.handle('view:setActive', ({ workspaceId, sessionId }) => {
    ctx.view.workspaceId = workspaceId
    ctx.view.sessionId = sessionId
    ctx.runtime.onViewChanged(workspaceId)
    return null
  })

  /**
   * ★ **重放是「同纪元才能续」的**（§4.3）。
   *
   * `epoch` 由**请求方**给出，说的是「我这条水位线属于哪一纪元」——
   * 主进程拿它和自己那个比。不一致就是**事实**，不是错误：
   * 渲染层据此丢弃水位线、整段重跑 `message:list`。
   *
   * ⚠️ 响应里的 `epoch` 是**主进程当前的**，不是请求里那个 —— 匹配时两者相同，
   * 不匹配时它正是渲染层下一个 `stream:batch` 会带的值（于是它换上就好）。
   */
  r.handle('stream:resume', ({ sessionId, epoch, fromSeq }) =>
    ctx.runtime.resume(sessionId, epoch, fromSeq)
  )

  /**
   * 运行时状态。三个字段现在都是**真值**，来源写清楚：
   *
   * - `liveTurns` / `queueDepth`：**库里**的 `queued` + `running`（`idx_turn_running` 偏索引）。
   *   ⚠️ `queueDepth` **包含上一进程留下的那些** —— 它们永远不会被本次进程执行
   *   （§4.5「不自动恢复」），但把它们从计数里悄悄扣掉，用户就会看到
   *   「侧边栏有 3 条排队中，而这里说 0」。
   * - `slots.used`：**本进程内存里正在跑的数量**，不是库里 `running` 的条数。
   *   两者平时相等；不一致的那个瞬间（正在派发 / 刚刚收尾）以内存为准才是对的，
   *   因为槽位是**进程内**的资源。
   */
  r.handle('runtime:getState', () => {
    const s = ctx.runtime.state()
    /**
     * ★ `epoch` 是 M6b 加的，而且是**唯一**能把这个值交给渲染层的口子。
     *
     * 纪元的所有者是合批器（每进程铸造一次），而渲染层要拿它去调 `stream:resume`。
     * 没有这个字段的话，渲染层**永远学不到纪元** —— 于是要么每次重放都拿到
     * `matched:false`（随便编一个），要么干脆不能重放（切空间回来那段尾巴就丢了）。
     *
     * 放在这里而不是新开一条通道：纪元本来就只在「进程活着」这个尺度上变，
     * 而这个接口的语义正是「现在这个进程的运行时状态」。
     * 它的**变更信号**是 `stream:status` 那条推送（§4.3 只有四条推送，不加新的）。
     */
    return {
      liveTurns: s.liveTurns,
      queueDepth: s.queueDepth,
      slots: s.slots,
      epoch: ctx.runtime.epoch
    }
  })
}
