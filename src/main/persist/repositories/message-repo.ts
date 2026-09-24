import type { DatabaseSync } from 'node:sqlite'
import type {
  EventKind,
  InjectMode,
  Mention,
  Message,
  MessageEvent,
  MessageRole
} from '../../../shared/entities.ts'
import { EVENT_KINDS, INJECT_MODES, MEMBER_ROLES } from '../../../shared/entities.ts'
import { withTransaction } from '../db.ts'
import { bool, json, nbit, nbool, nnum, nstr, num, str, toJson, type Row } from '../row.ts'

function oneOf<T extends string>(value: string, allowed: readonly T[], column: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${column} 出现未知值 ${JSON.stringify(value)}`)
  }
  return value as T
}

function mapMessage(row: Row): Message {
  return {
    id: str(row, 'id'),
    workspaceId: str(row, 'workspace_id'),
    sessionId: nstr(row, 'session_id'),
    turnId: nstr(row, 'turn_id'),
    role: oneOf(str(row, 'role'), MEMBER_ROLES, 'message.role'),
    authorMemberId: nstr(row, 'author_member_id'),
    seq: num(row, 'seq'),
    contentText: nstr(row, 'content_text'),
    contentPath: nstr(row, 'content_path'),
    contentBytes: num(row, 'content_bytes'),
    // ★ 结构化 mention，从 JSON 列读 —— 运行时永不解析文本（§3.1）
    mentions: json<Mention[]>(row, 'mentions_json'),
    injectMode: oneOf(str(row, 'inject_mode'), INJECT_MODES, 'message.inject_mode'),
    summaryText: nstr(row, 'summary_text'),
    createdAt: num(row, 'created_at'),
    editedAt: nnum(row, 'edited_at'),
    deletedAt: nnum(row, 'deleted_at')
  }
}

function mapEvent(row: Row): MessageEvent {
  return {
    id: num(row, 'id'),
    messageId: str(row, 'message_id'),
    seq: num(row, 'seq'),
    kind: oneOf(str(row, 'kind'), EVENT_KINDS, 'message_event.kind'),
    toolUseId: nstr(row, 'tool_use_id'),
    toolName: nstr(row, 'tool_name'),
    payloadJson: nstr(row, 'payload_json'),
    textBlob: nstr(row, 'text_blob'),
    blobPath: nstr(row, 'blob_path'),
    bytes: num(row, 'bytes'),
    ok: nbool(row, 'ok'),
    truncated: bool(row, 'truncated'),
    createdAt: num(row, 'created_at')
  }
}

export interface AppendMessageInput {
  id: string
  workspaceId: string
  sessionId?: string | null
  turnId?: string | null
  role: MessageRole
  authorMemberId?: string | null
  contentText?: string | null
  contentPath?: string | null
  contentBytes?: number
  mentions?: readonly Mention[]
  now: number
}

export interface AppendEventInput {
  messageId: string
  kind: EventKind
  toolUseId?: string | null
  toolName?: string | null
  payloadJson?: string | null
  textBlob?: string | null
  blobPath?: string | null
  bytes?: number
  ok?: boolean | null
  truncated?: boolean
  now: number
}

/** 单帧载荷上限，超出则外置到 blob 并标 `truncated`（§4.3） */
export const FRAME_PAYLOAD_LIMIT = 256 * 1024

export function messageRepo(db: DatabaseSync) {
  const s = {
    get: db.prepare(`SELECT * FROM message WHERE id = ?`),
    maxSeq: db.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS s FROM message WHERE workspace_id = ?`
    ),
    insert: db.prepare(
      `INSERT INTO message
         (id, workspace_id, session_id, turn_id, role, author_member_id, seq,
          content_text, content_path, content_bytes, mentions_json, inject_mode,
          summary_text, created_at, edited_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'full', NULL, ?, NULL, NULL)
       RETURNING *`
    ),
    /** keyset 分页（无 OFFSET），倒序取最近 N 条（§4.2） */
    listRecent: db.prepare(
      `SELECT * FROM message
       WHERE workspace_id = ? AND deleted_at IS NULL
       ORDER BY seq DESC LIMIT ?`
    ),
    listBefore: db.prepare(
      `SELECT * FROM message
       WHERE workspace_id = ? AND deleted_at IS NULL AND seq < ?
       ORDER BY seq DESC LIMIT ?`
    ),
    listAfter: db.prepare(
      `SELECT * FROM message
       WHERE workspace_id = ? AND deleted_at IS NULL AND seq > ?
       ORDER BY seq ASC LIMIT ?`
    ),
    listBySession: db.prepare(
      `SELECT * FROM message WHERE session_id = ? AND deleted_at IS NULL ORDER BY seq ASC LIMIT ?`
    ),
    /**
     * 会话的**最近** N 条（M7a 新增）。
     *
     * ★ 它与上面那条的区别只有一个 `DESC`，而那个 `DESC` 是**语义**，不是排序偏好：
     * `listBySession` 取的是**最旧**的 N 条。会话历史要的是最近的 N 条 ——
     * 拿错了不会报错，只会**安静地少掉最近的那几轮**，而模型因此答非所问。
     * （同一个错在 `message:list` 的注释里被写成「该会话的最近 N 条」，
     * 而底下调的是 `listBySession` —— 注释与实现相反，见那个 handler 的说明。）
     */
    listRecentBySession: db.prepare(
      `SELECT * FROM message
       WHERE session_id = ? AND deleted_at IS NULL
       ORDER BY seq DESC LIMIT ?`
    ),
    /**
     * ★ **某一轮自己的产物**（M7b 新增）。
     *
     * `message.turn_id` 只在 assistant 行上有值 —— 用户那条触发消息是**先**插的
     * （那时轮次还不存在），轮次反过来用 `trigger_message_id` 指向它（见
     * `handlers/turn.ts` 的文件头）。所以这一条查出来的**正好是「这一轮产出的东西」**，
     * 而触发消息要另走 `turn.trigger_message_id`。
     *
     * 用途：M7b 的扇出要读「这一轮的回复说了什么」（解析 `<mentions>`）
     * 与「这一轮干了活没有」（数它的事件）。**无 LIMIT**：一轮的消息条数天然是 1-2 条
     * （合批器把流式正文折进一条 assistant 行），加 LIMIT 只会让「多了的那条」
     * 静默消失 —— 而它恰好可能是我们要找的那条。
     */
    listByTurn: db.prepare(
      `SELECT * FROM message WHERE turn_id = ? AND deleted_at IS NULL ORDER BY seq ASC`
    ),
    softDelete: db.prepare(
      `UPDATE message SET deleted_at = ?, edited_at = ? WHERE id = ? RETURNING *`
    ),
    editText: db.prepare(
      `UPDATE message SET content_text = ?, content_bytes = ?, edited_at = ? WHERE id = ? RETURNING *`
    ),
    /**
     * ★ 流式折叠正文（M6a）。
     *
     * **与 `editText` 的唯一区别就是不动 `edited_at`** —— 这不是风格问题：
     * 那个列的含义是「**用户**改过这条消息」，而流式写入是系统在写。
     * 复用 `editText` 会让界面把模型自己的回答标成「已编辑」，
     * 而那个标记是用户用来判断「这条还是不是它原来说的」的依据。
     */
    setStreamedText: db.prepare(
      `UPDATE message SET content_text = ?, content_bytes = ? WHERE id = ? RETURNING *`
    ),
    setInjectMode: db.prepare(
      `UPDATE message SET inject_mode = ?, summary_text = ? WHERE id = ? RETURNING *`
    ),
    /**
     * 压缩用：把一批消息标记为「已被摘要取代」，并写入摘要。
     * **只改对话内容，不碰控制状态** —— 跳数在 turn 表（§3.3）。
     *
     * ★★ **粒度是 session，不是 workspace**（M7c 修正）。原先是
     * `WHERE workspace_id = ?`，而压缩的权威水位线 `session.compacted_through_seq`
     * 是**会话级**的 —— 按 workspace 标记会把同空间里**别的成员**的消息一起标成
     * `summary`，而那些会话的水位线一动没动。后果不是报错，而是：
     * 那些消息在库里看起来已经被摘要取代了，一旦哪天有谁按 `inject_mode` 去做判断，
     * B、C 的历史就会静默消失。它在 M7c 之前一直是死代码（零生产调用方），
     * 所以那个错从没机会发作 —— 接线的那一刻就是处置它的唯一便宜时机。
     *
     * `AND inject_mode = 'full'` 保住「已被明确排除」的意图：否则压缩会把
     * `excluded` 改写成 `summary`，抹掉一个装配层**正在读**的状态。
     */
    markCompactedBySession: db.prepare(
      `UPDATE message SET inject_mode = 'summary', summary_text = ?
       WHERE session_id = ? AND seq <= ? AND inject_mode = 'full' AND deleted_at IS NULL
       RETURNING *`
    ),

    // ── 压缩的读侧（M7c）────────────────────────────────────
    /**
     * ★ 压缩区间**右端的唯一来源**：`seq < beforeSeq` 的最大活 seq。
     *
     * 它比 `MAX(seq)` 多出来的那两件事都是必需的：
     * - `seq < ?` 实现「**不含本轮触发消息**」——把本轮请求自己折进摘要，
     *   模型就会在自己的请求里读到「我请求过什么」的转述，而那条请求还在它眼前。
     * - `deleted_at IS NULL` —— 软删的行不该成为水位线（它已经不注入了）。
     *
     * 返回 `null`（**不是 0**）表示区间里没有活行。0 是个合法的 seq 值，
     * 用它表示「没有」会让调用方在 `seq <= 0` 上做一个静默的错误判断。
     */
    lastSeqBefore: db.prepare(
      `SELECT MAX(seq) AS s FROM message
       WHERE session_id = ? AND deleted_at IS NULL AND seq < ?`
    ),
    /**
     * 待折的区间：**开区间** `(after, before)`、升序。
     *
     * ★ `inject_mode <> 'excluded'` 不是防御性编程：摘要文本**就是**提示词内容，
     * 把一条被明确排除的正文折进摘要 = 把它悄悄送回上下文。那种错不报错，
     * 只让「排除」这个状态名存实亡。
     */
    listBySessionBetween: db.prepare(
      `SELECT * FROM message
       WHERE session_id = ? AND deleted_at IS NULL
         AND inject_mode <> 'excluded' AND seq > ? AND seq < ?
       ORDER BY seq ASC LIMIT ?`
    ),
    /**
     * 一条消息里出现过的工具名，**去重**，按**首次出现**的顺序。
     *
     * ★ 不许用 `listEvents` 顶替它：那条查询会把 `text_blob` 一起拉出来
     * （工具输出动辄几百 KB，见 §8.9-9），而这里只要一个名字列表。
     * 骨架里那句「（工具：Read、Grep）」是模型判断「它到底干了什么」的唯一线索。
     */
    toolNamesOf: db.prepare(
      `SELECT tool_name AS name, MIN(seq) AS first_seq FROM message_event
       WHERE message_id = ? AND tool_name IS NOT NULL
       GROUP BY tool_name ORDER BY first_seq ASC`
    ),

    // ── message_event ─────────────────────────────────────────
    nextEventSeq: db.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM message_event WHERE message_id = ?`
    ),
    insertEvent: db.prepare(
      `INSERT INTO message_event
         (message_id, seq, kind, tool_use_id, tool_name, payload_json, text_blob,
          blob_path, bytes, ok, truncated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    ),
    listEvents: db.prepare(
      `SELECT * FROM message_event WHERE message_id = ? ORDER BY seq ASC`
    ),
    listEventsByKind: db.prepare(
      `SELECT * FROM message_event WHERE message_id = ? AND kind = ? ORDER BY seq ASC`
    ),
    countEvents: db.prepare(
      `SELECT COUNT(*) AS c FROM message_event WHERE message_id = ?`
    ),
    purgeByKindBefore: db.prepare(
      `DELETE FROM message_event WHERE kind = ? AND created_at < ?`
    ),
    listBlobRefs: db.prepare(
      `SELECT blob_path FROM message_event WHERE blob_path IS NOT NULL`
    )
  }

  /**
   * 在空间时间线内分配下一个 seq。
   *
   * ⚠️ 必须与插入在**同一个事务**里，否则并发插入会撞 `idx_message_ws_seq`
   * 的 UNIQUE 约束。`append` 已经这么做了；单独调用本函数时要自己开事务。
   */
  function nextSeq(workspaceId: string): number {
    const row = s.maxSeq.get(workspaceId) as { s: number }
    return Number(row.s) + 1
  }

  return {
    get(id: string): Message | null {
      const row = s.get.get(id) as Row | undefined
      return row ? mapMessage(row) : null
    },

    /**
     * 追加一条消息，**自动分配 seq**，整体在一个事务里。
     * 空间时间线的全序由 `UNIQUE(workspace_id, seq)` 兜底。
     */
    append(input: AppendMessageInput): Message {
      return withTransaction(db, () => {
        const seq = nextSeq(input.workspaceId)
        const row = s.insert.get(
          input.id,
          input.workspaceId,
          input.sessionId ?? null,
          input.turnId ?? null,
          input.role,
          input.authorMemberId ?? null,
          seq,
          input.contentText ?? null,
          input.contentPath ?? null,
          input.contentBytes ?? 0,
          toJson(input.mentions ?? []),
          input.now
        ) as Row
        return mapMessage(row)
      })
    },

    /** 最近 N 条，**按 seq 升序**返回（DB 里是倒序取，这里翻回来给上下文装配用）。 */
    listRecent(workspaceId: string, limit: number): Message[] {
      const rows = (s.listRecent.all(workspaceId, limit) as Row[]).map(mapMessage)
      return rows.reverse()
    },

    /** keyset 分页：取 `seq < beforeSeq` 的最近 N 条，**按 seq 升序**返回。 */
    listBefore(workspaceId: string, beforeSeq: number, limit: number): Message[] {
      const rows = (s.listBefore.all(workspaceId, beforeSeq, limit) as Row[]).map(mapMessage)
      return rows.reverse()
    },

    /**
     * ★ 切换空间后的重放原语（§4.3）：取水位线之后的所有消息。
     * 配合 `stream:resume` 使用，让跨空间切换天然无竞态。
     */
    listAfter(workspaceId: string, afterSeq: number, limit: number): Message[] {
      return (s.listAfter.all(workspaceId, afterSeq, limit) as Row[]).map(mapMessage)
    },

    listBySession(sessionId: string, limit: number): Message[] {
      return (s.listBySession.all(sessionId, limit) as Row[]).map(mapMessage)
    },

    /** 会话的**最近** N 条，**按 seq 升序**返回（DB 里倒序取，这里翻回来给上下文装配用）。 */
    listRecentBySession(sessionId: string, limit: number): Message[] {
      const rows = (s.listRecentBySession.all(sessionId, limit) as Row[]).map(mapMessage)
      return rows.reverse()
    },

    /** 某一轮自己的产物（按 seq 升序，通常只有一条 assistant 行）。见 `listByTurn` 的 SQL 注释。 */
    listByTurn(turnId: string): Message[] {
      return (s.listByTurn.all(turnId) as Row[]).map(mapMessage)
    },

    softDelete(id: string, now: number): Message | null {
      const row = s.softDelete.get(now, now, id) as Row | undefined
      return row ? mapMessage(row) : null
    },

    editText(id: string, text: string, now: number): Message | null {
      const row = s.editText.get(text, Buffer.byteLength(text, 'utf8'), now, id) as
        | Row
        | undefined
      return row ? mapMessage(row) : null
    },

    /** 流式折叠：只改正文与字节数，**不碰 `edited_at`**（见 statement 上的说明）。 */
    setStreamedText(id: string, text: string): Message | null {
      const row = s.setStreamedText.get(text, Buffer.byteLength(text, 'utf8'), id) as
        | Row
        | undefined
      return row ? mapMessage(row) : null
    },

    setInjectMode(id: string, mode: InjectMode, summary: string | null): Message | null {
      const row = s.setInjectMode.get(mode, summary, id) as Row | undefined
      return row ? mapMessage(row) : null
    },

    /** 把**本会话** `seq <= throughSeq` 的 full 消息摘要化。返回受影响的消息。 */
    markCompactedBySession(sessionId: string, throughSeq: number, summary: string): Message[] {
      return (s.markCompactedBySession.all(summary, sessionId, throughSeq) as Row[]).map(mapMessage)
    },

    /** 压缩区间右端的唯一来源。`null` = 区间里没有活行（**不是 0**）。 */
    lastSeqBefore(sessionId: string, beforeSeq: number): number | null {
      const row = s.lastSeqBefore.get(sessionId, beforeSeq) as { s: number | null }
      return row.s === null ? null : Number(row.s)
    },

    /** 待折区间 `(afterSeq, beforeSeq)`，开区间、升序。被 `excluded` 的**不在**里面。 */
    listBySessionBetween(
      sessionId: string,
      afterSeq: number,
      beforeSeq: number,
      limit: number
    ): Message[] {
      return (
        s.listBySessionBetween.all(sessionId, afterSeq, beforeSeq, limit) as Row[]
      ).map(mapMessage)
    },

    /** 一条消息里用过的工具名，去重、按首次出现排序。只读名字，不拉 `text_blob`。 */
    toolNamesOf(messageId: string): string[] {
      return (s.toolNamesOf.all(messageId) as Row[]).map((r) => str(r, 'name'))
    },

    // ── 事件 ──────────────────────────────────────────────────

    /**
     * 追加一个事件，`seq` 在消息内单调。
     *
     * ★ 这里**是 thinking 唯一的落点**。上下文装配从不调用本文件的任何
     * `*Events*` 方法 —— 推理内容是**结构性排除**的（§4.2）。
     */
    appendEvent(input: AppendEventInput): MessageEvent {
      return withTransaction(db, () => {
        const seqRow = s.nextEventSeq.get(input.messageId) as { s: number }
        const textBlob = input.textBlob ?? null
        const bytes = input.bytes ?? (textBlob ? Buffer.byteLength(textBlob, 'utf8') : 0)
        const row = s.insertEvent.get(
          input.messageId,
          Number(seqRow.s),
          input.kind,
          input.toolUseId ?? null,
          input.toolName ?? null,
          input.payloadJson ?? null,
          textBlob,
          input.blobPath ?? null,
          bytes,
          nbit(input.ok ?? null),
          input.truncated ? 1 : 0,
          input.now
        ) as Row
        return mapEvent(row)
      })
    },

    listEvents(messageId: string): MessageEvent[] {
      return (s.listEvents.all(messageId) as Row[]).map(mapEvent)
    },

    listEventsByKind(messageId: string, kind: EventKind): MessageEvent[] {
      return (s.listEventsByKind.all(messageId, kind) as Row[]).map(mapEvent)
    },

    countEvents(messageId: string): number {
      const row = s.countEvents.get(messageId) as { c: number }
      return Number(row.c)
    },

    /**
     * 按类型清理过期事件（§5.8）。
     * `kind='thinking'` 保留 7 天；`tool_result` 的大输出保留 3 天。
     *
     * ⚠️ 删除 `blob_path` 非空的行之前，调用方要先清 blob 文件，
     * 否则磁盘上会留下无主文件。**M6a 起 `blob_path` 一律为 NULL**（全量正文留在
     * 同一行的 `text_blob` 里，见 §8.9-9 的收口），所以这条清理由 M10
     * 连同 blob-store、retention、孤儿扫描一起做 —— 那时位置是 `<空间>/blobs/`。
     */
    purgeEventsBefore(kind: EventKind, cutoff: number): number {
      // `StatementSync.run()` 的返回类型把 `changes` 标成 `number | bigint`，
      // 尽管 M1 实测（Node 24.18）运行时给的是 number（`lastInsertRowid` 亦然）。
      // 显式收敛，免得 bigint 顺着类型悄悄流到上层。
      return Number(s.purgeByKindBefore.run(kind, cutoff).changes)
    },

    /** blob 孤儿扫描用：当前所有被引用的 blob 路径（§5.8）。 */
    listBlobRefs(): string[] {
      return (s.listBlobRefs.all() as Row[]).map((r) => str(r, 'blob_path'))
    }
  }
}

export type MessageRepo = ReturnType<typeof messageRepo>
