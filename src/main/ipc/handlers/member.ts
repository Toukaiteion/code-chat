import type { HandlerContext, Registry } from '../registry.ts'
import { AppError, NotFoundError } from '../errors.ts'

/**
 * `WorkspaceMember` = `Actor` × `Workspace`（§2.4）。
 * 「同一个 Claude，在 A 空间是后端、在 B 空间是客服」由这一层承载，
 * 所以显示名、职责文件、可见性都是**每空间独立**的。
 */
export function registerMember(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  r.handle('member:list', ({ workspaceId }) => repos.member.listByWorkspace(workspaceId))

  /**
   * 加入一个成员，**并在同一个事务里为它建好 session**。
   *
   * ★ 为什么 session 在这里建：`Session` 与 `WorkspaceMember` 是 **1:1**
   * （`UNIQUE(workspace_id, member_id)`，§4.2），而**通道清单里没有 `session:create`**
   * —— 那么它的诞生点只能在「成员诞生」这一处。若改成 M5 调度器首次发轮时惰性创建，
   * 就得先加一个通道，且 UI 会在成员刚建好、还没说话时看到一个「无 session」的空态。
   *
   * 放在同一个 `tx` 里是必须的：否则中途失败会留下一个**永远没有 session 的成员**，
   * 而这种半成品没有任何通道能修复它。
   */
  r.handle('member:create', ({ workspaceId, actorId, displayName, roleDescPath }) => {
    if (!repos.workspace.get(workspaceId)) throw new NotFoundError('工作空间', workspaceId)
    if (!repos.actor.get(actorId)) throw new NotFoundError('角色', actorId)

    // UNIQUE(workspace_id, actor_id)：同一个「人」在一个空间里只能有一个身份。
    const dup = repos.member.getByActor(workspaceId, actorId)
    if (dup) {
      throw new AppError('E_CONFLICT', `这个角色已经在本空间里了：${dup.displayName}`, {
        memberId: dup.id
      })
    }

    const now = ctx.now()
    const memberId = ctx.newId()
    const sessionId = ctx.newId()

    return ctx.store.tx(() => {
      const member = repos.member.create({
        id: memberId,
        workspaceId,
        actorId,
        displayName,
        roleDescPath,
        now
      })
      repos.session.create(sessionId, workspaceId, memberId, now)
      return member
    })
  })

  /** ⚠️ 级联带走该成员的 session、消息与轮次。删的是**身份**，不是那个全局的「人」。 */
  r.handle('member:remove', ({ id }) => ({ deleted: repos.member.remove(id) }))

  r.handle('member:setEnabled', ({ id, enabled }) => {
    const updated = repos.member.setEnabled(id, enabled, ctx.now())
    if (!updated) throw new NotFoundError('成员', id)
    return updated
  })

  r.handle('member:setRoleDesc', ({ id, roleDescPath, roleDescHash }) => {
    const updated = repos.member.setRoleDesc(id, roleDescPath, roleDescHash, ctx.now())
    if (!updated) throw new NotFoundError('成员', id)
    return updated
  })

  /**
   * 权限 JSON 原样落库。**M3 不做语义校验** —— 它的 schema 由 M8 的权限白名单界面定义，
   * 现在就在这里「猜」一个形状，等于提前把 M8 的设计锁死。
   * 只要求它是**合法 JSON**，这是 DB 里 `CHECK (json_valid(permission_json))` 的
   * 前置条件，早失败早说清。
   */
  r.handle('member:setPermissions', ({ id, permissionJson }) => {
    try {
      JSON.parse(permissionJson)
    } catch (err) {
      throw new AppError('E_INVALID_PAYLOAD', '权限必须是一段合法 JSON', {
        reason: (err as Error).message
      })
    }
    const updated = repos.member.setPermissions(id, permissionJson, ctx.now())
    if (!updated) throw new NotFoundError('成员', id)
    return updated
  })

  /**
   * 设为 / 取消路由角色。
   *
   * 真正的保证是偏索引 `idx_member_router`（§3.2，「交给 DB 而不是应用代码」）。
   * 这里的预查**不取代**它，只是把 `UNIQUE constraint failed` 换成一句
   * 能直接指出「谁已经占着这个位置」的话。两者冲突时 DB 才是裁决者。
   */
  r.handle('member:setRouter', ({ id, isRouter }) => {
    const member = repos.member.get(id)
    if (!member) throw new NotFoundError('成员', id)

    if (isRouter) {
      const current = repos.member.getRouter(member.workspaceId)
      if (current && current.id !== id) {
        throw new AppError('E_CONFLICT', `本空间的路由角色已经是「${current.displayName}」`, {
          memberId: current.id
        })
      }
    }

    const updated = repos.member.setRouter(id, isRouter, ctx.now())
    if (!updated) throw new NotFoundError('成员', id)
    return updated
  })

  // ── 可见性（§8.4）──────────────────────────────────────────

  /**
   * 读可见性。注意 `isRestricted === false` 时 `ids` 是**空数组**——
   * 「空」表示「没有收窄 = 全部可见」，而不是「什么都看不见」。
   * 这个反直觉之处是 `member_repo` 刻意保留的默认值，在 UI 上必须写明。
   */
  r.handle('member:visibility', ({ memberId }) => {
    if (!repos.member.get(memberId)) throw new NotFoundError('成员', memberId)
    const visible = repos.member.visibleProjectIds(memberId)
    return {
      ids: visible.ids,
      isRestricted: visible.isRestricted,
      primaryProjectId: repos.member.primaryProjectId(memberId)
    }
  })

  /**
   * 写可见性：**整体替换** + 主项目。
   *
   * 两条领域规则在这里断言，而不是留给 `setVisibleProjects` 里那句
   * `throw new Error(...)`（它会被兜底映射成 E_INTERNAL，等于把我们的编程错误
   * 伪装成一个数据库故障）：
   *
   * 1. 可见项目必须属于该成员所在的**同一个空间** —— 外键只保证项目存在。
   * 2. 主项目必须**同时**在可见集合里（§8.5b：cwd 一级来源必须真的够得着）。
   */
  r.handle('member:setVisibility', ({ memberId, projectIds, primaryProjectId }) => {
    const member = repos.member.get(memberId)
    if (!member) throw new NotFoundError('成员', memberId)

    for (const projectId of projectIds) {
      const project = repos.project.get(projectId)
      if (!project) throw new NotFoundError('项目', projectId)
      if (project.workspaceId !== member.workspaceId) {
        throw new AppError('E_CONFLICT', `项目「${project.name}」不属于这个工作空间`, {
          projectId,
          projectWorkspaceId: project.workspaceId,
          memberWorkspaceId: member.workspaceId
        })
      }
    }

    if (primaryProjectId !== null && !projectIds.includes(primaryProjectId)) {
      throw new AppError('E_INVALID_PAYLOAD', '主项目必须同时是该成员的可见项目之一', {
        primaryProjectId
      })
    }

    return repos.member.setVisibleProjects(memberId, projectIds, primaryProjectId, ctx.now())
  })

  /**
   * 单独切换某个可见项目的主项目标记。
   *
   * ⚠️ 只能把**已有可见行**标为主项目。对「没有收窄 = 全部可见」的成员
   * （一行 `member_project` 都没有），这里会明确拒绝而不是顺手插一行 ——
   * 插一行等于**悄悄地把他收窄成只能看见这一个项目**，那是个大得多的语义变更，
   * 不该藏在「设为主项目」这个动作后面。想给他主项目，请先 `member:setVisibility`。
   */
  r.handle('member:setPrimary', ({ memberId, projectId, isPrimary }) => {
    if (!repos.member.get(memberId)) throw new NotFoundError('成员', memberId)

    if (isPrimary) {
      const visible = repos.member.visibleProjectIds(memberId)
      if (!visible.isRestricted) {
        throw new AppError(
          'E_CONFLICT',
          '该成员当前可见全部项目、没有收窄列表，因此没有可挂主项目的位置；' +
            '请先用 member:setVisibility 指定可见项目集合（主项目必须是其中之一）'
        )
      }
      if (!visible.ids.includes(projectId)) {
        throw new AppError('E_CONFLICT', '只能把该成员可见的项目设为主项目', {
          memberId,
          projectId
        })
      }
    }

    return repos.member.setPrimary(memberId, projectId, isPrimary)
  })

  /** 撤销收窄，回到「全部可见」。**会一并清掉主项目标记** —— 见 repo 里的注释。 */
  r.handle('member:clearVisibility', ({ memberId }) => {
    if (!repos.member.get(memberId)) throw new NotFoundError('成员', memberId)
    repos.member.clearVisibleProjects(memberId)
    return null
  })
}
