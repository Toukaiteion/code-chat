import type { DatabaseSync } from 'node:sqlite'
import type { Project, ProjectOrigin } from '../../../shared/entities.ts'
import { PROJECT_ORIGINS } from '../../../shared/entities.ts'
import { nnum, nstr, num, str, type Row } from '../row.ts'

function mapProject(row: Row): Project {
  const origin = str(row, 'origin')
  if (!(PROJECT_ORIGINS as readonly string[]).includes(origin)) {
    // CHECK 约束本该拦住它。走到这里说明库被外部工具改过，
    // 或者 CHECK 与 TS 的联合类型已经分叉 —— 两种都值得立刻知道。
    throw new Error(`project.origin 出现未知值 ${JSON.stringify(origin)}`)
  }
  return {
    id: str(row, 'id'),
    workspaceId: str(row, 'workspace_id'),
    name: str(row, 'name'),
    rootPath: str(row, 'root_path'),
    origin: origin as ProjectOrigin,
    remoteUrl: nstr(row, 'remote_url'),
    defaultBranch: nstr(row, 'default_branch'),
    createdAt: num(row, 'created_at'),
    lastOpenedAt: nnum(row, 'last_opened_at')
  }
}

export interface CreateProjectInput {
  id: string
  workspaceId: string
  name: string
  /** 绝对路径。`local` 型是**用户的**目录，我们只引用（§8.2）。 */
  rootPath: string
  origin: ProjectOrigin
  remoteUrl?: string | null
  defaultBranch?: string | null
  now: number
}

/**
 * 同一空间内 root_path 重复时会抛 SQLITE_CONSTRAINT_UNIQUE（errcode 2067）。
 * 调用方应捕获并翻译成「这个目录已经加过了」，而不是弹一个原始 SQL 错误。
 */
export function projectRepo(db: DatabaseSync) {
  const s = {
    listByWorkspace: db.prepare(
      `SELECT * FROM project WHERE workspace_id = ? ORDER BY created_at ASC`
    ),
    get: db.prepare(`SELECT * FROM project WHERE id = ?`),
    findByPath: db.prepare(`SELECT * FROM project WHERE workspace_id = ? AND root_path = ?`),
    insert: db.prepare(
      `INSERT INTO project
         (id, workspace_id, name, root_path, origin, remote_url, default_branch, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       RETURNING *`
    ),
    touch: db.prepare(`UPDATE project SET last_opened_at = ? WHERE id = ? RETURNING *`),
    rename: db.prepare(`UPDATE project SET name = ? WHERE id = ? RETURNING *`),
    remove: db.prepare(`DELETE FROM project WHERE id = ?`),
    /** 孤儿检测用：本项目是否还被某个空间当作 cwd 兜底（§8.5b） */
    referencedAsActive: db.prepare(`SELECT COUNT(*) AS c FROM workspace WHERE active_project_id = ?`),
    /**
     * **全库**的 `origin='local'` 根目录（**不按空间过滤**）。
     * 见下面 `localRootPaths()` 的说明 —— 这个「不按空间过滤」正是要点。
     */
    allLocalRoots: db.prepare(`SELECT root_path FROM project WHERE origin = 'local'`)
  }

  return {
    listByWorkspace(workspaceId: string): Project[] {
      return (s.listByWorkspace.all(workspaceId) as Row[]).map(mapProject)
    },

    get(id: string): Project | null {
      const row = s.get.get(id) as Row | undefined
      return row ? mapProject(row) : null
    },

    findByPath(workspaceId: string, rootPath: string): Project | null {
      const row = s.findByPath.get(workspaceId, rootPath) as Row | undefined
      return row ? mapProject(row) : null
    },

    create(input: CreateProjectInput): Project {
      const row = s.insert.get(
        input.id,
        input.workspaceId,
        input.name,
        input.rootPath,
        input.origin,
        input.remoteUrl ?? null,
        input.defaultBranch ?? null,
        input.now
      ) as Row
      return mapProject(row)
    },

    touch(id: string, now: number): Project | null {
      const row = s.touch.get(now, id) as Row | undefined
      return row ? mapProject(row) : null
    },

    rename(id: string, name: string): Project | null {
      const row = s.rename.get(name, id) as Row | undefined
      return row ? mapProject(row) : null
    },

    /**
     * ⚠️ **只删数据库行。** 对 `origin='local'` 的项目，磁盘目录是用户的，
     * 我们绝不碰它（§8.2）。对 `copy`/`clone` 型，删除磁盘副本需用户显式确认，
     * 由上层 service 处理 —— repository 不做文件系统操作。
     *
     * 若该项目正被空间当作 cwd 兜底，`workspace.active_project_id` 会被
     * `ON DELETE SET NULL` 自动清空，不需要手动处理。
     */
    remove(id: string): boolean {
      return s.remove.run(id).changes > 0
    },

    /** 该项目是否仍被某个空间引用为活跃项目。删除前给 UI 提示用。 */
    isReferencedAsActive(id: string): boolean {
      const row = s.referencedAsActive.get(id) as { c: number }
      return Number(row.c) > 0
    },

    /**
     * **全部**`origin='local'` 项目的根目录（跨空间，不去重）。
     *
     * ★ 传回全库而不是某个空间的，是这里唯一要紧的决定。
     * 用途是删副本前的最后一道闸：如果待删目录是**任何一个** `local` 项目的祖先，
     * 就拒绝删 —— 否则「删空间时顺带清副本」会连带把用户**真实的**工作目录删掉。
     * 只在当前空间里查是不够的：另一个空间原地引用着 `C:\work\proj`，
     * 而本空间某个副本的目标恰好被指到了 `C:\work`。
     */
    localRootPaths(): string[] {
      return (s.allLocalRoots.all() as { root_path: string }[]).map((r) => r.root_path)
    }
  }
}

export type ProjectRepo = ReturnType<typeof projectRepo>
