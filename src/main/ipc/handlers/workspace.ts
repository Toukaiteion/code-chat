import { mkdir, writeFile } from 'node:fs/promises'
import type { Workspace } from '../../../shared/entities.ts'
import {
  buildManifest,
  pickDirName,
  sanitizeDirName,
  SPACE_SUBDIRS,
  spacePaths,
  type SpacePaths
} from '../../infra/space-dir.ts'
import { describeFsError, pathState, refuseRemoval, removeQuietly } from '../../infra/fs-ops.ts'
import { isSqliteError, SQLITE_CONSTRAINT_UNIQUE } from '../../persist/index.ts'
import { AppError, NotFoundError } from '../errors.ts'
import type { HandlerContext, Registry, SysCapabilities } from '../registry.ts'

/**
 * 工作空间的 CRUD —— M4 里**第一次真正通文件系统**的地方（§8.3）。
 *
 * 三条贯穿全文件的纪律：
 *
 * 1. **磁盘与数据库的顺序是刻意选的**，两处相反（建空间是「先盘后库」，
 *    删空间是「先库后盘」）。理由分别写在各自的注释里 —— 判据是同一条：
 *    **让失败留下能从磁盘收拾的孤儿，而不是不可逆的数据丢失。**
 * 2. **绝不假装干净**。删不掉就带上原因返回，而不是回一个 `true`。
 * 3. **`origin='local'` 的目录一个字节都不碰**（§8.2 的硬约束）。
 */

// ─────────────────────────────────────────────────────────────
// 空间目录的落地
// ─────────────────────────────────────────────────────────────

/** 建一棵空间目录 + 写铭牌。**幂等** —— `mkdir -p`，铭牌是纯派生内容。 */
async function materializeSpaceDir(
  sys: SysCapabilities,
  ws: { id: string; name: string; dirName: string; createdAt: number }
): Promise<SpacePaths> {
  const paths = spacePaths(sys.workspacesRoot(), ws.dirName)
  try {
    await mkdir(paths.root, { recursive: true })
    // `SPACE_SUBDIRS` 的每一项都是 `SpacePaths` 的键，所以这里不用手拼路径。
    for (const sub of SPACE_SUBDIRS) await mkdir(paths[sub], { recursive: true })
    await writeFile(paths.manifest, buildManifest(ws), 'utf8')
  } catch (err) {
    throw new AppError('E_INTERNAL', `建不了空间目录：${paths.root}`, {
      path: paths.root,
      reason: describeFsError(err)
    })
  }
  return paths
}

/**
 * 重写铭牌（改名后）。
 *
 * **失败不致命**：铭牌是「给人看的」静态说明（`space-dir.ts` 的 `buildManifest` 有详述），
 * §8.3 也写明了「两者冲突时以 DB 为准」。让一个可选的展示文件挡住一次改名，
 * 是拿用户的操作去迁就一个装饰品。所以这里只留一行日志。
 *
 * 目录不存在时**不建** —— 顺手建目录是 `workspace:paths` 里 `ensure: true` 才做的事，
 * 改名不该有那个副作用（老空间在盘上本来就没有目录）。
 */
async function refreshManifest(sys: SysCapabilities, ws: Workspace): Promise<void> {
  const paths = spacePaths(sys.workspacesRoot(), ws.dirName)
  if (!(await pathState(paths.root)).exists) return
  try {
    await writeFile(paths.manifest, buildManifest(ws), 'utf8')
  } catch (err) {
    console.warn(`[workspace] 铭牌重写失败（不影响使用）：${paths.manifest}`, err)
  }
}

export function registerWorkspace(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  r.handle('workspace:list', () => repos.workspace.list())

  /**
   * ★ 建空间 = 建目录 + 落库。**顺序是「先盘后库」**。
   *
   * 反过来的话（先落库再建目录），中间失败会留下一个**有记录、没目录**的空间：
   * 之后每一次 clone/copy 都会撞上一个不存在的默认落点，而 UI 上它看起来完全正常。
   * 现在这个顺序的最坏结果是「磁盘上多了一棵没人引用的目录」——
   * 它可回收（§8.9 的孤儿回收），而且我们**当场就会尽力删掉它**。
   *
   * （注意这与 `workspace:delete` 的顺序**恰好相反**，那不是笔误：
   *  那边最坏情况是「行没了、副本还在盘上」，同样是可回收的孤儿。）
   */
  r.handle('workspace:create', async ({ name }) => {
    const dirName = pickDirName(sanitizeDirName(name), new Set(repos.workspace.usedDirNames()))
    const id = ctx.newId()
    const now = ctx.now()

    const paths = await materializeSpaceDir(ctx.sys, { id, name, dirName, createdAt: now })

    try {
      return repos.workspace.create({ id, name, dirName, now })
    } catch (err) {
      // 「尽力」是字面意思：删不掉就把路径如实带回去，用户能自己去看。
      const cleanup = await removeQuietly(paths.root)
      const conflict = isSqliteError(err) && err.errcode === SQLITE_CONSTRAINT_UNIQUE
      throw new AppError(
        conflict ? 'E_CONFLICT' : 'E_INTERNAL',
        conflict
          ? `目录名「${dirName}」已经被另一个空间占用了，换个名字再试`
          : `空间没能写进数据库：${describeFsError(err)}`,
        {
          path: paths.root,
          dirName,
          cleanedUp: cleanup.removed,
          cleanupReason: cleanup.reason
        }
      )
    }
  })

  /**
   * ⚠️ **只改显示名，不动磁盘**（`space-dir.ts` 文件头列了三条理由，
   * 最硬的一条是：M5 起 agent 的 cwd 就在这些目录里，Windows 拒绝重命名被占用的目录）。
   * 所以 UI **必须**显示真实目录路径，否则用户改完名会以为目录也跟着变了。
   */
  r.handle('workspace:update', async ({ id, name }) => {
    const updated = repos.workspace.rename(id, name, ctx.now())
    if (!updated) throw new NotFoundError('工作空间', id)
    await refreshManifest(ctx.sys, updated)
    return updated
  })

  /**
   * ★★ 验收标准所在：**`origin='local'` 的目录在删空间后一个字节都不动。**
   *
   * 顺序：**读出副本路径 → 删 DB 行 → 才动磁盘**。
   * 反过来的话（先删磁盘再删行），一旦行删失败，我们就为一批**还存在的记录**
   * 销毁了数据 —— 空间还在、副本没了。按现在这个顺序，最坏情况是
   * 「行没了、某些副本还在盘上」：一个**可回收的孤儿**，而不是一次不可逆的丢失。
   *
   * 副本路径**必须在删行之前读出来** —— 删完就查不到了（级联带走了 project 行）。
   *
   * 空间目录本身**永不删除**，只在结果里如实报告它在哪。
   */
  r.handle('workspace:delete', async ({ id, deleteCopies }) => {
    const ws = repos.workspace.get(id)
    if (!ws) {
      return { deleted: false, copies: [], workspaceDir: null, workspaceDirExists: false }
    }

    const projects = repos.project.listByWorkspace(id)
    // 全库的 local 根目录 —— 见 `refuseReason` 与 `project-repo.localRootPaths` 的说明。
    const localRoots = repos.project.localRootPaths()

    const deleted = repos.workspace.remove(id)

    const root = ctx.sys.workspacesRoot()
    const wsDir = spacePaths(root, ws.dirName).root
    const scope = { root, wsDir, localRoots }

    const copies: Array<{
      path: string
      state: 'removed' | 'absent' | 'kept' | 'failed'
      reason: string | null
    }> = []

    for (const project of projects) {
      // ★ 硬约束：原地引用的目录是**用户的**，无论标志传什么都不碰（§8.2）。
      if (project.origin === 'local') {
        copies.push({
          path: project.rootPath,
          state: 'kept',
          reason: '「原地引用」的目录属于你，无论是否勾选都不会删除'
        })
        continue
      }
      if (!deleteCopies) {
        copies.push({ path: project.rootPath, state: 'kept', reason: '没有勾选「同时删除副本」' })
        continue
      }
      // 行已经删了，但仍然逐条过闸 —— 见 `fs-ops.ts` 的 `refuseRemoval`。
      const refusal = refuseRemoval(project.rootPath, scope)
      if (refusal) {
        copies.push({ path: project.rootPath, state: 'failed', reason: refusal })
        continue
      }

      const before = await pathState(project.rootPath)
      if (!before.exists) {
        // 「本来就不在」既不是成功也不是失败，**分开记**（见 `DeleteReport` 的说明）。
        copies.push({ path: project.rootPath, state: 'absent', reason: null })
        continue
      }
      if (!before.isDirectory) {
        copies.push({
          path: project.rootPath,
          state: 'failed',
          reason: '这个路径现在不是一个目录，拒绝删除'
        })
        continue
      }

      const result = await removeQuietly(project.rootPath)
      copies.push(
        result.removed
          ? { path: project.rootPath, state: 'removed', reason: null }
          : { path: project.rootPath, state: 'failed', reason: result.reason }
      )
    }

    return {
      deleted,
      copies,
      workspaceDir: wsDir,
      workspaceDirExists: (await pathState(wsDir)).exists
    }
  })

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

  /**
   * 空间目录在哪 —— 用户选了 `userData` 这个资源管理器里看不见的位置，
   * 所以「它到底在磁盘的哪里」必须是可查的（`paths.ts` 的代价说明）。
   *
   * ★ `ensure: true` 才建目录。**这个开关是必须的**：M4 之前的空间在磁盘上
   * 根本没有目录（`dir_name` 是迁移回填的 id），所以老数据第一次查会得到一个
   * 不存在的路径。把「建目录」藏在查询里是不可接受的 —— 一个叫 `paths` 的通道
   * 不该在你只是看一眼的时候改磁盘。于是让调用方明说要建，默认不建。
   */
  r.handle('workspace:paths', async ({ id, ensure }) => {
    const ws = repos.workspace.get(id)
    if (!ws) throw new NotFoundError('工作空间', id)

    if (ensure) await materializeSpaceDir(ctx.sys, ws)

    const paths = spacePaths(ctx.sys.workspacesRoot(), ws.dirName)
    return {
      rootPath: paths.root,
      projectsPath: paths.projects,
      scratchPath: paths.scratch,
      exists: (await pathState(paths.root)).exists
    }
  })

  /**
   * ★ 累计用量（M6b，§5.4 的「成本常驻显示」）。
   *
   * 走**聚合读**而不是把 `turn:list` 加起来 —— 那条通道带 limit，用它求和会
   * 「看起来完全正常，只在历史变长之后悄悄变小」。
   *
   * ⚠️ 空间不存在时**抛错，不返回零**：回一个 `costUsd: 0` 会让界面显示
   * 「这个空间花了 0 元」，而正确的读法是「没有这个空间」。
   * 一个不存在的空间和一个真的没花过钱的空间，不该长得一样。
   */
  r.handle('workspace:usage', ({ workspaceId }) => {
    if (!repos.workspace.get(workspaceId)) throw new NotFoundError('工作空间', workspaceId)
    return repos.turn.usageOfWorkspace(workspaceId)
  })
}
