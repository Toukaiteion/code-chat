import type { DatabaseSync } from 'node:sqlite'
import type { Session } from '../../../shared/entities.ts'
import { nnum, nstr, num, str, type Row } from '../row.ts'

function mapSession(row: Row): Session {
  return {
    id: str(row, 'id'),
    workspaceId: str(row, 'workspace_id'),
    memberId: str(row, 'member_id'),
    turnCount: num(row, 'turn_count'),
    lastSeq: num(row, 'last_seq'),
    compactedThroughSeq: num(row, 'compacted_through_seq'),
    rollingSummary: nstr(row, 'rolling_summary'),
    createdAt: num(row, 'created_at'),
    lastActiveAt: nnum(row, 'last_active_at')
  }
}

export function sessionRepo(db: DatabaseSync) {
  const s = {
    listByWorkspace: db.prepare(
      `SELECT * FROM session WHERE workspace_id = ? ORDER BY created_at ASC`
    ),
    get: db.prepare(`SELECT * FROM session WHERE id = ?`),
    getByMember: db.prepare(`SELECT * FROM session WHERE member_id = ?`),
    insert: db.prepare(
      `INSERT INTO session
         (id, workspace_id, member_id, turn_count, last_seq, compacted_through_seq,
          rolling_summary, created_at, last_active_at)
       VALUES (?, ?, ?, 0, 0, 0, NULL, ?, NULL)
       RETURNING *`
    ),
    touch: db.prepare(
      `UPDATE session SET last_active_at = ? WHERE id = ? RETURNING *`
    ),
    /** 每轮结束 +1。用 SQL 自增而非读改写，避免并发下的丢失更新。 */
    bumpTurnCount: db.prepare(
      `UPDATE session SET turn_count = turn_count + 1, last_active_at = ?
       WHERE id = ? RETURNING *`
    ),
    /**
     * 推进 seq 水位。返回推进后的 session。
     * 调用方需保证 `seq` 是单调不减的 —— 见 messageRepo 的 seq 分配。
     */
    advanceSeq: db.prepare(
      `UPDATE session SET last_seq = MAX(last_seq, ?) WHERE id = ? RETURNING *`
    ),
    /**
     * 记录一次压缩（§4.6）：`compacted_through_seq` 之前的历史已被摘要取代。
     * **只动对话内容，不碰控制状态** —— 跳数计数器在 turn 表，不受影响（§3.3）。
     */
    setCompaction: db.prepare(
      `UPDATE session SET compacted_through_seq = ?, rolling_summary = ? WHERE id = ?
       RETURNING *`
    ),
    remove: db.prepare(`DELETE FROM session WHERE id = ?`)
  }

  return {
    listByWorkspace(workspaceId: string): Session[] {
      return (s.listByWorkspace.all(workspaceId) as Row[]).map(mapSession)
    },

    get(id: string): Session | null {
      const row = s.get.get(id) as Row | undefined
      return row ? mapSession(row) : null
    },

    /** 与 WorkspaceMember 1:1（UNIQUE(workspace_id, member_id)）。 */
    getByMember(memberId: string): Session | null {
      const row = s.getByMember.get(memberId) as Row | undefined
      return row ? mapSession(row) : null
    },

    create(id: string, workspaceId: string, memberId: string, now: number): Session {
      const row = s.insert.get(id, workspaceId, memberId, now) as Row
      return mapSession(row)
    },

    touch(id: string, now: number): Session | null {
      const row = s.touch.get(now, id) as Row | undefined
      return row ? mapSession(row) : null
    },

    bumpTurnCount(id: string, now: number): Session | null {
      const row = s.bumpTurnCount.get(now, id) as Row | undefined
      return row ? mapSession(row) : null
    },

    advanceSeq(id: string, seq: number): Session | null {
      const row = s.advanceSeq.get(seq, id) as Row | undefined
      return row ? mapSession(row) : null
    },

    setCompaction(id: string, throughSeq: number, rollingSummary: string): Session | null {
      const row = s.setCompaction.get(throughSeq, rollingSummary, id) as Row | undefined
      return row ? mapSession(row) : null
    },

    remove(id: string): boolean {
      return s.remove.run(id).changes > 0
    }
  }
}

export type SessionRepo = ReturnType<typeof sessionRepo>
