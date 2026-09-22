import type { DatabaseSync } from 'node:sqlite'
import type { Workspace } from '../../../shared/entities.ts'
import { nnum, nstr, num, str, type Row } from '../row.ts'

/** 行 → 实体的显式映射。见 `row.ts` 顶部关于 null-prototype 的说明。 */
function mapWorkspace(row: Row): Workspace {
  const id = str(row, 'id')
  return {
    id,
    name: str(row, 'name'),
    /**
     * 迁移 0002 已把历史行回填成 `id`，所以正常路径上不会是 NULL。
     * 这里的 `?? id` 是**同一规则的第二次落点**：防的是手工改库 / 半途失败的迁移，
     * 让「目录名缺失」退化成「用 id 当目录名」，而不是抛一个看不懂的类型错误。
     */
    dirName: nstr(row, 'dir_name') ?? id,
    activeProjectId: nstr(row, 'active_project_id'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
    archivedAt: nnum(row, 'archived_at')
  }
}

export interface CreateWorkspaceInput {
  id: string
  name: string
  /**
   * 空间目录的单段名字（§8.3）。**决定目录名的地方是 handler**，它按
   * `sanitizeDirName` + `pickDirName` 算好了再传进来。
   *
   * 省略则退回 `id` —— 与迁移 0002 对历史行的回填规则**完全一致**（一条规则，不是两条）。
   * 测试里造夹具时用得上，生产路径永远显式传。
   */
  dirName?: string
  now: number
}

export function workspaceRepo(db: DatabaseSync) {
  const s = {
    list: db.prepare(
      `SELECT * FROM workspace WHERE archived_at IS NULL ORDER BY created_at ASC`
    ),
    get: db.prepare(`SELECT * FROM workspace WHERE id = ?`),
    insert: db.prepare(
      `INSERT INTO workspace (id, name, dir_name, active_project_id, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)
       RETURNING *`
    ),
    /** ⚠️ **只改显示名，不动 `dir_name`** —— 目录名一经确定就不再变（见 `space-dir.ts`）。 */
    rename: db.prepare(`UPDATE workspace SET name = ?, updated_at = ? WHERE id = ? RETURNING *`),
    /** 已被占用的目录名（大小写不敏感地比较由调用方负责，这里给原始值）。 */
    listDirNames: db.prepare(`SELECT dir_name FROM workspace WHERE dir_name IS NOT NULL`),
    /**
     * 设置 cwd 的二级兜底（§8.5b）。**不校验** project 属于本空间 ——
     * 外键只保证项目存在。跨空间误指由上层 service 校验，
     * 这里不重复实现领域规则（否则规则会有两份，迟早分叉）。
     */
    setActiveProject: db.prepare(
      `UPDATE workspace SET active_project_id = ?, updated_at = ? WHERE id = ? RETURNING *`
    ),
    archive: db.prepare(
      `UPDATE workspace SET archived_at = ?, updated_at = ? WHERE id = ? RETURNING *`
    ),
    /** 硬删除。级联会带走成员/项目/session/message —— 见 §8.2 关于 `local` 目录的说明。 */
    remove: db.prepare(`DELETE FROM workspace WHERE id = ?`)
  }

  return {
    list(): Workspace[] {
      return (s.list.all() as Row[]).map(mapWorkspace)
    },

    get(id: string): Workspace | null {
      const row = s.get.get(id) as Row | undefined
      return row ? mapWorkspace(row) : null
    },

    create(input: CreateWorkspaceInput): Workspace {
      const dirName = input.dirName ?? input.id
      const row = s.insert.get(input.id, input.name, dirName, input.now, input.now) as Row
      return mapWorkspace(row)
    },

    /**
     * 已经被占用的目录名。
     *
     * ⚠️ 大小写不敏感的比较留给调用方（`pickDirName` 会归一化）：NTFS 默认大小写不敏感，
     * `Nova` 与 `nova` 是**同一个目录**，而 SQLite 的唯一索引是区分大小写的。
     * 这个落差是「DB 放行、磁盘撞车」的经典来源，所以唯一索引建在 `lower(dir_name)` 上。
     */
    usedDirNames(): string[] {
      return (s.listDirNames.all() as { dir_name: string }[]).map((r) => r.dir_name)
    },

    rename(id: string, name: string, now: number): Workspace | null {
      const row = s.rename.get(name, now, id) as Row | undefined
      return row ? mapWorkspace(row) : null
    },

    setActiveProject(id: string, projectId: string | null, now: number): Workspace | null {
      const row = s.setActiveProject.get(projectId, now, id) as Row | undefined
      return row ? mapWorkspace(row) : null
    },

    archive(id: string, now: number): Workspace | null {
      const row = s.archive.get(now, now, id) as Row | undefined
      return row ? mapWorkspace(row) : null
    },

    /**
     * ⚠️ 只删数据库行。**`origin='local'` 的项目目录在磁盘上一个字节都不会动**
     * —— 那是用户的目录，我们只是引用它（§8.2）。
     * 对 `copy` / `clone` 型项目，磁盘清理由上层决定并需用户确认。
     *
     * 空间自己的目录（`<workspaceRoot>/<dirName>/`）**同样不在这里删** ——
     * 见 `handlers/workspace.ts` 里 `workspace:delete` 的说明。
     */
    remove(id: string): boolean {
      return s.remove.run(id).changes > 0
    }
  }
}

export type WorkspaceRepo = ReturnType<typeof workspaceRepo>
