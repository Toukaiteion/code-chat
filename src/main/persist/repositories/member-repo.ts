import type { DatabaseSync } from 'node:sqlite'
import type { MemberProject, WorkspaceMember } from '../../../shared/entities.ts'
import { bit, bool, nstr, num, str, type Row } from '../row.ts'

function mapMember(row: Row): WorkspaceMember {
  return {
    id: str(row, 'id'),
    workspaceId: str(row, 'workspace_id'),
    actorId: str(row, 'actor_id'),
    displayName: str(row, 'display_name'),
    roleDescPath: nstr(row, 'role_desc_path'),
    roleDescHash: nstr(row, 'role_desc_hash'),
    permissionJson: str(row, 'permission_json'),
    isRouter: bool(row, 'is_router'),
    enabled: bool(row, 'enabled'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at')
  }
}

function mapMemberProject(row: Row): MemberProject {
  return {
    memberId: str(row, 'member_id'),
    projectId: str(row, 'project_id'),
    isPrimary: bool(row, 'is_primary'),
    createdAt: num(row, 'created_at')
  }
}

export interface CreateMemberInput {
  id: string
  workspaceId: string
  actorId: string
  displayName: string
  roleDescPath?: string | null
  roleDescHash?: string | null
  now: number
}

/**
 * 成员（角色 × 空间）+ 成员可见项目（§8.4）。
 *
 * 可见性语义（**务必按此实现 UI**）：
 *   没有 member_project 行 → 可见空间内**全部**项目（默认）
 *   有行                   → **只**可见这些
 * 它是**上下文裁剪，不是安全边界**。不得在 UI 上宣传为权限控制（§8.4）。
 */
export function memberRepo(db: DatabaseSync) {
  const s = {
    listByWorkspace: db.prepare(
      `SELECT * FROM workspace_member WHERE workspace_id = ? ORDER BY created_at ASC`
    ),
    listEnabled: db.prepare(
      `SELECT * FROM workspace_member WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at ASC`
    ),
    get: db.prepare(`SELECT * FROM workspace_member WHERE id = ?`),
    getByActor: db.prepare(
      `SELECT * FROM workspace_member WHERE workspace_id = ? AND actor_id = ?`
    ),
    getRouter: db.prepare(`SELECT * FROM workspace_member WHERE workspace_id = ? AND is_router = 1`),
    insert: db.prepare(
      `INSERT INTO workspace_member
         (id, workspace_id, actor_id, display_name, role_desc_path, role_desc_hash,
          permission_json, is_router, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 0, 1, ?, ?)
       RETURNING *`
    ),
    setEnabled: db.prepare(
      `UPDATE workspace_member SET enabled = ?, updated_at = ? WHERE id = ? RETURNING *`
    ),
    setRoleDesc: db.prepare(
      `UPDATE workspace_member SET role_desc_path = ?, role_desc_hash = ?, updated_at = ?
       WHERE id = ? RETURNING *`
    ),
    setPermissions: db.prepare(
      `UPDATE workspace_member SET permission_json = ?, updated_at = ? WHERE id = ? RETURNING *`
    ),
    /**
     * 设为/取消路由角色。设 `is_router = 1` 时，若空间已有路由角色，
     * 会撞上偏索引 `idx_member_router`（errcode 2067）。
     * 让 DB 来保证「每空间至多一个」而不是应用层代码（§3.2）。
     */
    setRouter: db.prepare(
      `UPDATE workspace_member SET is_router = ?, updated_at = ? WHERE id = ? RETURNING *`
    ),
    remove: db.prepare(`DELETE FROM workspace_member WHERE id = ?`),

    // ── member_project ────────────────────────────────────────
    listVisible: db.prepare(`SELECT * FROM member_project WHERE member_id = ?`),
    getPrimary: db.prepare(
      `SELECT * FROM member_project WHERE member_id = ? AND is_primary = 1`
    ),
    /**
     * 插入可见项目行。`is_primary = 1` 时若该成员已有主项目，
     * 会撞上偏索引 `idx_member_primary`（errcode 2067）。
     */
    insertVisible: db.prepare(
      `INSERT INTO member_project (member_id, project_id, is_primary, created_at)
       VALUES (?, ?, ?, ?) RETURNING *`
    ),
    setPrimary: db.prepare(
      `UPDATE member_project SET is_primary = ? WHERE member_id = ? AND project_id = ?
       RETURNING *`
    ),
    removeVisible: db.prepare(`DELETE FROM member_project WHERE member_id = ? AND project_id = ?`),
    clearVisible: db.prepare(`DELETE FROM member_project WHERE member_id = ?`)
  }

  /** 把可见项目集合整体替换成 `projectIds`，并把 `primaryProjectId` 标为主项目。 */
  function setVisibleProjects(
    memberId: string,
    projectIds: readonly string[],
    primaryProjectId: string | null,
    now: number
  ): MemberProject[] {
    if (primaryProjectId !== null && !projectIds.includes(primaryProjectId)) {
      throw new Error(`主项目 ${primaryProjectId} 必须同时在该成员的可见项目集合里`)
    }
    db.exec('BEGIN')
    try {
      s.clearVisible.run(memberId)
      for (const projectId of projectIds) {
        s.insertVisible.run(memberId, projectId, bit(projectId === primaryProjectId), now)
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return (s.listVisible.all(memberId) as Row[]).map(mapMemberProject)
  }

  /**
   * 该成员本轮能看到哪些项目（§8.4）。
   * **没有行 = 全部可见** —— 这个兜底是刻意的默认值，不要在调用处重复实现。
   */
  function visibleProjectIds(memberId: string): { ids: string[]; isRestricted: boolean } {
    const rows = (s.listVisible.all(memberId) as Row[]).map(mapMemberProject)
    return {
      ids: rows.map((r) => r.projectId),
      isRestricted: rows.length > 0
    }
  }

  /**
   * cwd 的一级来源（§8.5b）。返回 null 表示该成员**没有**主项目，
   * 调用方继续走二级/三级兜底 —— 不要在这里编一个默认值。
   */
  function primaryProjectId(memberId: string): string | null {
    const row = s.getPrimary.get(memberId) as Row | undefined
    return row ? mapMemberProject(row).projectId : null
  }

  return {
    listByWorkspace(workspaceId: string): WorkspaceMember[] {
      return (s.listByWorkspace.all(workspaceId) as Row[]).map(mapMember)
    },

    listEnabled(workspaceId: string): WorkspaceMember[] {
      return (s.listEnabled.all(workspaceId) as Row[]).map(mapMember)
    },

    get(id: string): WorkspaceMember | null {
      const row = s.get.get(id) as Row | undefined
      return row ? mapMember(row) : null
    },

    getByActor(workspaceId: string, actorId: string): WorkspaceMember | null {
      const row = s.getByActor.get(workspaceId, actorId) as Row | undefined
      return row ? mapMember(row) : null
    },

    getRouter(workspaceId: string): WorkspaceMember | null {
      const row = s.getRouter.get(workspaceId) as Row | undefined
      return row ? mapMember(row) : null
    },

    create(input: CreateMemberInput): WorkspaceMember {
      const row = s.insert.get(
        input.id,
        input.workspaceId,
        input.actorId,
        input.displayName,
        input.roleDescPath ?? null,
        input.roleDescHash ?? null,
        input.now,
        input.now
      ) as Row
      return mapMember(row)
    },

    setEnabled(id: string, enabled: boolean, now: number): WorkspaceMember | null {
      const row = s.setEnabled.get(bit(enabled), now, id) as Row | undefined
      return row ? mapMember(row) : null
    },

    setRoleDesc(
      id: string,
      roleDescPath: string | null,
      roleDescHash: string | null,
      now: number
    ): WorkspaceMember | null {
      const row = s.setRoleDesc.get(roleDescPath, roleDescHash, now, id) as Row | undefined
      return row ? mapMember(row) : null
    },

    setPermissions(id: string, permissionJson: string, now: number): WorkspaceMember | null {
      const row = s.setPermissions.get(permissionJson, now, id) as Row | undefined
      return row ? mapMember(row) : null
    },

    setRouter(id: string, isRouter: boolean, now: number): WorkspaceMember | null {
      const row = s.setRouter.get(bit(isRouter), now, id) as Row | undefined
      return row ? mapMember(row) : null
    },

    remove(id: string): boolean {
      return s.remove.run(id).changes > 0
    },

    // ── 可见性 ────────────────────────────────────────────────
    listVisibleProjects(memberId: string): MemberProject[] {
      return (s.listVisible.all(memberId) as Row[]).map(mapMemberProject)
    },

    setVisibleProjects,

    visibleProjectIds,

    primaryProjectId,

    setPrimary(memberId: string, projectId: string, isPrimary: boolean): MemberProject | null {
      const row = s.setPrimary.get(bit(isPrimary), memberId, projectId) as Row | undefined
      return row ? mapMemberProject(row) : null
    },

    /**
     * 撤销「收窄」，回到默认的全可见。
     * 注意这会**一并清掉主项目标记** —— 因为主项目必须同时是可见项目，
     * 保留一个不可见的「主项目」会让 §8.5b 的 cwd 解析指向角色看不到的目录。
     */
    clearVisibleProjects(memberId: string): void {
      s.clearVisible.run(memberId)
    },

    removeVisibleProject(memberId: string, projectId: string): boolean {
      return s.removeVisible.run(memberId, projectId).changes > 0
    }
  }
}

export type MemberRepo = ReturnType<typeof memberRepo>
