import type { HandlerContext, Registry } from '../registry.ts'

/**
 * `Session` = 成员在某空间的对话流（与 `WorkspaceMember` 1:1）。
 *
 * **这里没有 `session:create`** —— 与成员同生（见 `member.ts` 的 `member:create`）。
 */
export function registerSession(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  r.handle('session:list', ({ workspaceId }) => repos.session.listByWorkspace(workspaceId))

  /** 返回 `null` 表示该成员还没有 session（正常状态，不是错误）。 */
  r.handle('session:getByMember', ({ memberId }) => repos.session.getByMember(memberId))

  /**
   * ⚠️ 删 session 会**级联带走该成员的全部消息与轮次** —— 在 UI 上这是
   * 「清空这个角色的对话」，必须二次确认后才该被调用。
   *
   * 与 `member:remove` 的区别：删 session 后成员还在，下一轮从空历史重开；
   * 删成员则连身份一起没了。
   */
  r.handle('session:remove', ({ id }) => ({ deleted: repos.session.remove(id) }))
}
