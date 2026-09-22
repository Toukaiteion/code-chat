import type { DatabaseSync } from 'node:sqlite'
import type { Workspace } from '../../../shared/entities.ts'
import { nnum, nstr, num, str, type Row } from '../row.ts'

/** 行 → 实体的显式映射。见 `row.ts` 顶部关于 null-prototype 的说明。 */
function mapWorkspace(row: Row): Workspace {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    activeProjectId: nstr(row, 'active_project_id'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
    archivedAt: nnum(row, 'archived_at')
  }
}

export interface CreateWorkspaceInput {
  id: string
  name: string
  now: number
}

export function workspaceRepo(db: DatabaseSync) {
  const s = {
    list: db.prepare(
      `SELECT * FROM workspace WHERE archived_at IS NULL ORDER BY created_at ASC`
    ),
    get: db.prepare(`SELECT * FROM workspace WHERE id = ?`),
    insert: db.prepare(
      `INSERT INTO workspace (id, name, active_project_id, created_at, updated_at, archived_at)
       VALUES (?, ?, NULL, ?, ?, NULL)
       RETURNING *`
    ),
    rename: db.prepare(`UPDATE workspace SET name = ?, updated_at = ? WHERE id = ? RETURNING *`),
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
      const row = s.insert.get(input.id, input.name, input.now, input.now) as Row
      return mapWorkspace(row)
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
     */
    remove(id: string): boolean {
      return s.remove.run(id).changes > 0
    }
  }
}

export type WorkspaceRepo = ReturnType<typeof workspaceRepo>
