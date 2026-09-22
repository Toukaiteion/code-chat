import type { HandlerContext, Registry } from '../registry.ts'
import { AppError, NotFoundError } from '../errors.ts'

export function registerWorkspace(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  r.handle('workspace:list', () => repos.workspace.list())

  r.handle('workspace:create', ({ name }) =>
    repos.workspace.create({ id: ctx.newId(), name, now: ctx.now() })
  )

  r.handle('workspace:update', ({ id, name }) => {
    const updated = repos.workspace.rename(id, name, ctx.now())
    if (!updated) throw new NotFoundError('工作空间', id)
    return updated
  })

  /**
   * ⚠️ 只删数据库行。级联会带走成员/项目/session/message，
   * 但 **`origin='local'` 的项目目录在磁盘上一个字节都不会动** —— 那是用户的目录，
   * 我们只是引用它（§8.2）。`copy` / `clone` 型的磁盘清理由 M4 的导入流程负责并需用户确认。
   */
  r.handle('workspace:delete', ({ id }) => ({ deleted: repos.workspace.remove(id) }))

  /**
   * 设置 cwd 的**二级兜底**（§8.5b）。这里校验项目属于本空间 ——
   * repository 刻意不校验（外键只保证项目存在），领域规则由这一层负责。
   */
  r.handle('workspace:setActive', ({ id, projectId }) => {
    if (projectId !== null) {
      const project = repos.project.get(projectId)
      if (!project) throw new NotFoundError('项目', projectId)
      if (project.workspaceId !== id) {
        throw new AppError('E_CONFLICT', '该项目不属于这个工作空间', {
          projectId,
          workspaceId: id,
          projectWorkspaceId: project.workspaceId
        })
      }
    }
    const updated = repos.workspace.setActiveProject(id, projectId, ctx.now())
    if (!updated) throw new NotFoundError('工作空间', id)
    return updated
  })
}
