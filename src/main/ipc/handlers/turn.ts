import type { HandlerContext, Registry } from '../registry.ts'
import { AppError, NotFoundError } from '../errors.ts'
import { DEFAULT_MESSAGE_LIMIT } from '../../../shared/ipc/schemas.ts'

export function registerTurn(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  /**
   * ⚠️ `listRecentByWorkspace` 按 `started_at DESC` 排序，而**排队中的轮次
   * `started_at` 是 NULL** —— SQLite 的 DESC 把 NULL 排在最后，
   * 所以「刚点了发送、还在排队」的那条会出现在列表**末尾**。
   * 侧边栏要显示排队项时不要用它，用 `turn:listLive`。
   */
  r.handle('turn:list', ({ workspaceId, sessionId, limit }) => {
    if (sessionId != null) {
      // `listBySession` 没有 LIMIT —— 一个会话的轮次数天然有界（按会话切分，
      // 且 `session:remove` 可清空），不值得为它再加一个索引变体。
      return repos.turn.listBySession(sessionId).slice(0, limit ?? DEFAULT_MESSAGE_LIMIT)
    }
    return repos.turn.listRecentByWorkspace(workspaceId, limit ?? DEFAULT_MESSAGE_LIMIT)
  })

  r.handle('turn:get', ({ id }) => repos.turn.get(id))

  /** 全局的排队中 + 运行中，按 `queued_at` 升序（= FIFO 顺序）。 */
  r.handle('turn:listLive', () => repos.turn.listLive())

  /**
   * 停止一轮。
   *
   * ★ 这里是 M3 里**唯一一个「部分实现」的通道**，两半都必须是真话：
   *
   * - `queued` → **真的停掉**（`markCancelled`，M2 已有）。它还没启动，
   *   没有任何进程需要杀，翻一下状态就是完整的操作。
   * - `running` → `E_NOT_IMPLEMENTED`（M9）。**不能假装停掉了**：
   *   杀进程要走 §4.4 的阶梯（SIGINT → 等 → 硬杀），M9 才做。
   *   现在谎报成功，UI 会显示已停止、而那个 claude 进程还在改用户的文件。
   * - 终态 → `E_CONFLICT`。已经是 `done` 的轮次不需要停，
   *   而且 `markCancelled` 是**不带状态守卫的 UPDATE**，
   *   直接调它会把一个已完成的轮次改写成 `cancelled`，抹掉真实结局。
   */
  r.handle('turn:stop', ({ turnId }) => {
    const turn = repos.turn.get(turnId)
    if (!turn) throw new NotFoundError('轮次', turnId)

    if (turn.status === 'queued') {
      const cancelled = repos.turn.markCancelled(turnId, ctx.now())
      if (!cancelled) throw new NotFoundError('轮次', turnId)
      return cancelled
    }

    if (turn.status === 'running') {
      throw new AppError(
        'E_NOT_IMPLEMENTED',
        // ⚠️ 这句话在 M5 之后已经不准了：**Windows 上没有 SIGINT/SIGTERM 可用**
        // （libuv 的 `child.kill()` 走 TerminateProcess，直接硬杀直接子进程，
        //  而 `taskkill /T` 靠活着的父子链走路 —— 先杀根会让孙进程永远收不回来）。
        // M5 定的阶梯是「stdin 中断 → 根还活着时 `taskkill /T` → `/T /F`」，
        // 完整理由与实测见 docs/design.md §4.4b。M9 落地时照那一节做，不要照这句话做。
        `通道 turn:stop 对运行中的轮次尚未实现（计划在 M9）：走 docs/design.md §4.4b 的中断阶梯`,
        { turnId, pid: turn.pid, milestone: 'M9' }
      )
    }

    throw new AppError('E_CONFLICT', `该轮次已经结束了（${turn.status}），无需停止`, {
      turnId,
      status: turn.status
    })
  })
}
