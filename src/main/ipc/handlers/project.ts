import { mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { HandlerContext, Registry } from '../registry.ts'
import type { CreateProjectInput } from '../../persist/repositories/project-repo.ts'
import { AppError, NotFoundError } from '../errors.ts'
import { sanitizeDirName, spacePaths } from '../../infra/space-dir.ts'
import {
  COPY_SKIP_DIRS,
  copyTree,
  describeFsError,
  isPathInside,
  isSamePath,
  pathState,
  refuseRemoval,
  removeQuietly
} from '../../infra/fs-ops.ts'
import {
  bestEffortRemoveDir,
  cloneRepo,
  currentBranch,
  firstLine,
  gitSearchHint,
  tail
} from '../../infra/git.ts'

/**
 * 项目的三种导入方式（§8.2）—— 加上改名与删除。
 *
 * 三者的骨架是**同一个**：解析绝对路径 → 证明它真的存在 → **先查重给一句人话**
 * （避免用户直接吃到 `UNIQUE constraint failed`）→ 再落库。
 * 差别只在「目标目录从哪来」：
 *
 * - `addLocal`：目标就是用户的目录，**我们不写一个字**；
 * - `copy`    ：我们自己造一个副本，所以必须自己保证目标干净、以及别把自己套进去；
 * - `clone`   ：造副本这件事交给 git，但**找得到 git、认清失败原因**是我们的责任。
 *
 * ★ 贯穿全文件的：**`local` 型项目在磁盘上永远是用户的**。删空间、删项目、
 * 清副本，任何一条路径上都不许碰它（§8.2 的硬约束）。
 */

/**
 * 源目录必须存在、且是目录。三种导入方式共用 —— 这三种情况下
 * 「源不是一个目录」都只能是我们自己（或用户）搞错了，早说比晚说好。
 */
async function requireSourceDir(what: string, abs: string): Promise<void> {
  let info
  try {
    info = await stat(abs)
  } catch {
    throw new AppError('E_NOT_FOUND', `${what}不存在或无法访问：${abs}`, { path: abs })
  }
  if (!info.isDirectory()) {
    throw new AppError('E_INVALID_PAYLOAD', `${what}不是一个目录：${abs}`, { path: abs })
  }
}

/**
 * 目标目录必须是**不存在或空的**。
 *
 * 这条对 copy 与 clone 都是硬的：`fs.cp` 会往非空目标里**静默合并**，
 * git 对非空目标的报错则含糊得没法给用户看。两者都会变成「用户以为拿到了
 * 一个干净的副本，实际上里面掺着旧东西」—— 所以由我们自己在动手前说清楚。
 */
async function requireEmptyTarget(abs: string): Promise<void> {
  const state = await pathState(abs)
  if (!state.exists) return
  if (!state.isDirectory) {
    throw new AppError('E_CONFLICT', `目标路径已经存在，而且不是一个目录：${abs}`, { path: abs })
  }
  if (!state.isEmpty) {
    throw new AppError('E_CONFLICT', `目标目录已经存在且不是空的：${abs}`, { path: abs })
  }
}

/** 同一空间内 `root_path` 唯一。预查只为给一句人话。 */
function requireNoDuplicate(
  repos: HandlerContext['store']['repos'],
  workspaceId: string,
  abs: string
): void {
  const existing = repos.project.findByPath(workspaceId, abs)
  if (existing) {
    throw new AppError('E_CONFLICT', `这个目录已经加过了：${existing.name}`, {
      projectId: existing.id,
      rootPath: abs
    })
  }
}

/**
 * 落库失败 → 把我们**刚造出来的**那个目录尽力删掉，并如实报告删没删掉。
 *
 * 只对 copy / clone 用：那两个目录是我们造的，删掉不心疼。
 * `local` 型永远走不到这里（它压根不造目录）。
 */
async function createOrCleanup(
  repos: HandlerContext['store']['repos'],
  input: CreateProjectInput,
  createdPath: string
) {
  try {
    return repos.project.create(input)
  } catch (err) {
    const cleanup = await removeQuietly(createdPath)
    throw new AppError('E_INTERNAL', `项目没能写进数据库：${describeFsError(err)}`, {
      path: createdPath,
      cleanedUp: cleanup.removed,
      cleanupReason: cleanup.reason
    })
  }
}

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
    await requireSourceDir('目录', abs)
    requireNoDuplicate(repos, workspaceId, abs)

    return repos.project.create({
      id: ctx.newId(),
      workspaceId,
      name,
      rootPath: abs,
      origin: 'local',
      now: ctx.now()
    })
  })

  /**
   * ★ 三种导入方式之二：**复制到别处**（§8.2）。
   *
   * 复制出来的副本是**我们的**，所以它归我们管：删空间时可以连带删掉，
   * 而这个副本目录**不包含在**「绝不碰用户目录」那条硬约束里 —— 它不是用户的目录。
   *
   * 两个必须自己守住的边界：
   * 1. **目标不能在源里面** —— 否则 `fs.cp` 会一边写一边读到刚写出来的东西，
   *    递归进自己，最后把一个线程池耗死在一棵无限增长的树上；
   * 2. **跳过清单是具名导出的**（`COPY_SKIP_DIRS`），UI **必须**把它显示给用户。
   *    静默跳过是不可接受的：用户会以为整个目录都复制过来了。
   *
   * `remoteUrl` / `defaultBranch` **留 null** —— 我们没跟任何远端说过话，
   * 填一个只能是编的。
   */
  r.handle('project:copy', async ({ workspaceId, name, sourcePath, targetPath }) => {
    if (!repos.workspace.get(workspaceId)) throw new NotFoundError('工作空间', workspaceId)

    const source = resolve(sourcePath)
    const target = resolve(targetPath)

    await requireSourceDir('源目录', source)

    if (isSamePath(target, source) || isPathInside(source, target)) {
      throw new AppError('E_INVALID_PAYLOAD', `目标目录不能在源目录里面：${target}`, {
        source,
        target
      })
    }

    await requireEmptyTarget(target)
    requireNoDuplicate(repos, workspaceId, target)

    try {
      await copyTree({ source, target })
    } catch (err) {
      // 复制到一半失败会留下一棵**不完整的**树。留着它比删掉更糟：
      // 用户下一次会撞上「目标已存在且不是空的」而不知道为什么。
      // 所以尽力回收，并把回收结果如实带回去。
      const cleanup = await removeQuietly(target)
      throw new AppError('E_INTERNAL', `复制失败：${describeFsError(err)}`, {
        source,
        target,
        skipped: COPY_SKIP_DIRS,
        cleanedUp: cleanup.removed,
        cleanupReason: cleanup.reason
      })
    }

    return createOrCleanup(
      repos,
      {
        id: ctx.newId(),
        workspaceId,
        name,
        rootPath: target,
        origin: 'copy',
        remoteUrl: null,
        defaultBranch: null,
        now: ctx.now()
      },
      target
    )
  })

  /**
   * ★ 三种导入方式之三：**git clone**（§8.2）。**完整克隆，不加 `--depth`** ——
   * 浅克隆会让 agent 看不到历史，而那是事后很难改回来的取舍。
   *
   * `locateGit()` 返回 null 时给出的是**人话错误**，detail 里带上我们找过哪里
   * （`gitSearchHint`）—— 「找不到 git」这种处境用户能自己修，前提是我们说清怎么修。
   *
   * 落库的 `defaultBranch` 取克隆**之后**读到的真实分支，而不是猜 `main`。
   */
  r.handle('project:clone', async ({ workspaceId, name, remoteUrl, targetPath, defaultBranch }) => {
    if (!repos.workspace.get(workspaceId)) throw new NotFoundError('工作空间', workspaceId)

    const target = resolve(targetPath)

    const gitPath = await ctx.sys.locateGit()
    if (!gitPath) {
      throw new AppError(
        'E_NOT_FOUND',
        '找不到 git 可执行文件。请安装 git 并确保它在 PATH 上，' +
          '或用环境变量 CODE_CHAT_GIT_PATH 指定它的完整路径。',
        gitSearchHint()
      )
    }

    await requireEmptyTarget(target)
    requireNoDuplicate(repos, workspaceId, target)

    // git 不会替我们建父目录。默认落点是 `<空间>/projects/<名字>`，
    // 而这个空间在盘上可能还没有目录（M4 之前建的空间），所以这一步是必须的。
    try {
      await mkdir(dirname(target), { recursive: true })
    } catch (err) {
      throw new AppError('E_INTERNAL', `建不了目标目录的上级：${dirname(target)}`, {
        path: dirname(target),
        reason: describeFsError(err)
      })
    }

    const requestedBranch = defaultBranch ?? null
    const result = await cloneRepo({ gitPath, remoteUrl, targetPath: target, branch: requestedBranch })

    if (!result.ok) {
      // git 自己通常会清掉失败的目标目录，但不是所有路径都如此
      // （网络中断、被杀、磁盘满）。留个半成品比留个空目录更糟 ——
      // 用户下一次会看到「目标已存在」。回收不掉就如实说。
      const cleaned = await bestEffortRemoveDir(target)
      const why =
        firstLine(result.stderr) ||
        (result.spawnError ? `进程没能启动（${result.spawnError}）` : 'git 没有输出原因')
      throw new AppError('E_INTERNAL', `克隆失败：${why}`, {
        remoteUrl,
        target,
        exitCode: result.code,
        stderrTail: tail(result.stderr),
        cleanedUp: cleaned
      })
    }

    // 读**真实的**分支，而不是猜。读不到（分离头指针等）就退回落库时给的那个，
    // 两个都没有就留 null —— 不知道就是不知道。
    const branch = (await currentBranch(gitPath, target)) ?? requestedBranch

    return createOrCleanup(
      repos,
      {
        id: ctx.newId(),
        workspaceId,
        name,
        rootPath: target,
        origin: 'clone',
        remoteUrl,
        defaultBranch: branch,
        now: ctx.now()
      },
      target
    )
  })

  /**
   * 默认落点 = `<空间目录>/projects/<项目名>`（§8.3）。
   *
   * **只算路径，不建目录、不碰磁盘** —— 用户还能改，建了就是白建。
   * 名字要过一遍 `sanitizeDirName`：它是**用户输入**，而这里的返回值会被
   * 直接当成路径的单段名字用 —— 不净化的话，一个带 `..\` 的项目名
   * 就能把默认落点指到空间目录外面去。
   *
   * 不在这里做去重（`pickDirName`）：那需要知道 `projects/` 里已有什么，
   * 而那要碰磁盘。重名会在 copy/clone 时以 `E_CONFLICT` 的形式如实出现。
   */
  r.handle('project:defaultTarget', ({ workspaceId, name }) => {
    const ws = repos.workspace.get(workspaceId)
    if (!ws) throw new NotFoundError('工作空间', workspaceId)
    const paths = spacePaths(ctx.sys.workspacesRoot(), ws.dirName)
    return { path: join(paths.projects, sanitizeDirName(name)) }
  })

  r.handle('project:rename', ({ id, name }) => {
    const renamed = repos.project.rename(id, name)
    if (!renamed) throw new NotFoundError('项目', id)
    return renamed
  })

  /**
   * 删项目。`origin='local'` 时**一个字节都不碰**（§8.2 的硬约束），
   * 但**要说出来** —— 用户勾了「同时删除副本」却什么都没有发生，
   * 而界面上一声不响，是最糟糕的一种交互。
   *
   * 顺序与 `workspace:delete` 一致：**先读出 origin/rootPath，再删行，最后才动磁盘**。
   * 删完就查不到了。若该项目正被当作 cwd 兜底，`workspace.active_project_id`
   * 会被 `ON DELETE SET NULL` 自动清空。
   */
  r.handle('project:remove', async ({ id, deleteCopy }) => {
    const project = repos.project.get(id)
    if (!project) return { deleted: false, copy: null }

    /**
     * ★ 两条「不动磁盘」的出路**各自直接 return**，绝不往下走。
     *
     * 写成一个会「落空」的 if 链是危险的：`local` 型在某个分支下没能设置 `copy`
     * 时，执行会**顺流而下**进入下面那段真正删目录的代码 ——
     * 而那条路径上删的正是用户的真实目录。早返回让这种事在结构上不可能发生。
     */
    if (project.origin === 'local') {
      return {
        deleted: repos.project.remove(id),
        copy: {
          path: project.rootPath,
          state: 'kept' as const,
          reason: deleteCopy
            ? '「原地引用」的目录属于你，无论是否勾选都不会删除'
            : '「原地引用」的目录属于你，不会被删除'
        }
      }
    }
    if (!deleteCopy) {
      return {
        deleted: repos.project.remove(id),
        copy: {
          path: project.rootPath,
          state: 'kept' as const,
          reason: '没有勾选「同时删除副本」'
        }
      }
    }

    // ── 到这里只可能是 `copy` / `clone` 型而且用户要求删副本 ──
    const deleted = repos.project.remove(id)

    const root = ctx.sys.workspacesRoot()
    const ws = repos.workspace.get(project.workspaceId)
    const refusal = refuseRemoval(project.rootPath, {
      root,
      wsDir: ws ? spacePaths(root, ws.dirName).root : null,
      localRoots: repos.project.localRootPaths()
    })
    if (refusal) {
      return { deleted, copy: { path: project.rootPath, state: 'failed' as const, reason: refusal } }
    }

    const before = await pathState(project.rootPath)
    if (!before.exists) {
      return { deleted, copy: { path: project.rootPath, state: 'absent' as const, reason: null } }
    }
    if (!before.isDirectory) {
      return {
        deleted,
        copy: {
          path: project.rootPath,
          state: 'failed' as const,
          reason: '这个路径现在不是一个目录，拒绝删除'
        }
      }
    }

    const result = await removeQuietly(project.rootPath)
    return {
      deleted,
      copy: result.removed
        ? { path: project.rootPath, state: 'removed' as const, reason: null }
        : { path: project.rootPath, state: 'failed' as const, reason: result.reason }
    }
  })
}
