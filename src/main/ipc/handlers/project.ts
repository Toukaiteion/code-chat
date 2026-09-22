import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { HandlerContext, Registry } from '../registry.ts'
import { AppError, NotFoundError } from '../errors.ts'

export function registerProject(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  r.handle('project:list', ({ workspaceId }) => repos.project.listByWorkspace(workspaceId))

  /**
   * ★ 三种导入方式之一：**原地引用**（§8.2）。这是默认方式，也是语义最微妙的一个。
   *
   * `root_path` 是**用户的**目录。我们**只登记一行**，不复制、不移动、不写入。
   * 删工作空间时它同样一个字节都不动（见 `workspace:delete` 的注释）。
   *
   * 代价必须说清：agent 会直接改用户的真实工作目录。这不是安全边界，
   * 也**不得**在 UI 上被描述成安全机制（§8.4 的边界声明）。
   */
  r.handle('project:addLocal', async ({ workspaceId, name, rootPath }) => {
    if (!repos.workspace.get(workspaceId)) throw new NotFoundError('工作空间', workspaceId)

    // 统一成绝对路径。`resolve` 兼做归一化，让「同一个目录写两遍」能被
    // `UNIQUE(workspace_id, root_path)` 认出来。
    const abs = resolve(rootPath)

    let info
    try {
      info = await stat(abs)
    } catch {
      throw new AppError('E_NOT_FOUND', `目录不存在或无法访问：${abs}`, { rootPath: abs })
    }
    if (!info.isDirectory()) {
      throw new AppError('E_INVALID_PAYLOAD', `这不是一个目录：${abs}`, { rootPath: abs })
    }

    // 先查重再插入，是为了给一句人话 —— 直接吃 2067 只能得到
    // 「UNIQUE constraint failed: project.workspace_id, project.root_path」。
    const existing = repos.project.findByPath(workspaceId, abs)
    if (existing) {
      throw new AppError('E_CONFLICT', `这个目录已经加过了：${existing.name}`, {
        projectId: existing.id,
        rootPath: abs
      })
    }

    return repos.project.create({
      id: ctx.newId(),
      workspaceId,
      name,
      rootPath: abs,
      origin: 'local',
      now: ctx.now()
    })
  })

  r.handle('project:rename', ({ id, name }) => {
    const renamed = repos.project.rename(id, name)
    if (!renamed) throw new NotFoundError('项目', id)
    return renamed
  })

  /**
   * ⚠️ 只删数据库行（`project-repo` 的注释同样适用）：
   * `local` 型绝不碰磁盘；`copy`/`clone` 型的副本清理在 M4 的导入流程里做，
   * 且需要用户显式确认。若该项目正被当作 cwd 兜底，
   * `workspace.active_project_id` 会被 `ON DELETE SET NULL` 自动清空。
   */
  r.handle('project:remove', ({ id }) => ({ deleted: repos.project.remove(id) }))
}
