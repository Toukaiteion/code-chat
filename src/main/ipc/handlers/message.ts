import type { HandlerContext, Registry } from '../registry.ts'
import { NotFoundError } from '../errors.ts'
import { DEFAULT_MESSAGE_LIMIT } from '../../../shared/ipc/schemas.ts'

export function registerMessage(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  /**
   * 历史查询。三种取法的**优先级**（§4.3，写成一条 if 链而不是三个通道）：
   *
   * 1. `sessionId` → 该会话的最近 N 条
   * 2. `beforeSeq` → 空间时间线上 `seq < beforeSeq` 的最近 N 条（keyset 分页，**无 OFFSET**）
   * 3. 都不给 → 空间时间线的最近 N 条
   *
   * 三者一律**按 seq 升序**返回 —— repository 内部倒序取再翻回来，
   * 调用方拿到的永远是「老 → 新」，可以直接喂给列表渲染。
   */
  r.handle('message:list', ({ workspaceId, sessionId, beforeSeq, limit }) => {
    const n = limit ?? DEFAULT_MESSAGE_LIMIT

    if (sessionId != null) return repos.message.listBySession(sessionId, n)
    if (beforeSeq != null) return repos.message.listBefore(workspaceId, beforeSeq, n)
    return repos.message.listRecent(workspaceId, n)
  })

  /**
   * 单条消息的**完整未截断**事件流（含 thinking、工具大输出）。
   *
   * 这是「展开原始输出」才走的路径，与 `message:list` 分开正是为了不让它上热路径
   * —— 一条长消息的事件可能有几 MB。
   *
   * 先确认消息存在：否则「消息不存在」和「这条消息没有事件」都会得到 `[]`，
   * 而这在 UI 上是两个完全不同的状态（前者是真错，后者是正常）。
   */
  r.handle('message:getEvents', ({ messageId }) => {
    if (!repos.message.get(messageId)) throw new NotFoundError('消息', messageId)
    return repos.message.listEvents(messageId)
  })
}
