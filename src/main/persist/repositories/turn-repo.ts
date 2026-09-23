import type { DatabaseSync } from 'node:sqlite'
import type { Turn, TurnStatus } from '../../../shared/entities.ts'
import { TURN_STATUSES } from '../../../shared/entities.ts'
import { nnum, nstr, num, str, type Row } from '../row.ts'

function mapTurn(row: Row): Turn {
  const status = str(row, 'status')
  if (!(TURN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`turn.status 出现未知值 ${JSON.stringify(status)}`)
  }
  return {
    id: str(row, 'id'),
    sessionId: str(row, 'session_id'),
    workspaceId: str(row, 'workspace_id'),
    triggerMessageId: nstr(row, 'trigger_message_id'),
    status: status as TurnStatus,
    hopDepth: num(row, 'hop_depth'),
    cwd: str(row, 'cwd'),
    pid: nnum(row, 'pid'),
    exitCode: nnum(row, 'exit_code'),
    errorText: nstr(row, 'error_text'),
    costUsd: nnum(row, 'cost_usd'),
    tokensIn: nnum(row, 'tokens_in'),
    tokensOut: nnum(row, 'tokens_out'),
    terminalReason: nstr(row, 'terminal_reason'),
    queuedAt: num(row, 'queued_at'),
    startedAt: nnum(row, 'started_at'),
    endedAt: nnum(row, 'ended_at')
  }
}

export interface CreateTurnInput {
  id: string
  sessionId: string
  workspaceId: string
  triggerMessageId?: string | null
  /** 本轮解析出的工作目录（§8.5b 三级兜底的结果） */
  cwd: string
  /** 跳数深度。用户直接发起 = 0；由 mention 触发 = 上游 +1（§3.3） */
  hopDepth?: number
  now: number
}

export interface TurnUsage {
  costUsd?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  terminalReason?: string | null
}

/**
 * 一个空间的累计用量（`usageOfWorkspace` 的返回形状）。
 *
 * ★ `turnsWithoutUsage` **不是**附属统计，它是这个数字能否被信任的前提：
 * `SUM` 跳过 NULL，所以 `costUsd` / `tokensIn` 只是**已知部分**的合计。
 * 界面必须把它一并显示（「另有 N 轮无用量数据」），否则那个合计数在说谎。
 */
export interface WorkspaceUsage {
  turnCount: number
  costUsd: number
  tokensIn: number
  tokensOut: number
  turnsWithoutUsage: number
}

export function turnRepo(db: DatabaseSync) {
  const s = {
    listBySession: db.prepare(
      `SELECT * FROM turn WHERE session_id = ? ORDER BY queued_at ASC`
    ),
    listLive: db.prepare(
      `SELECT * FROM turn WHERE status IN ('queued','running') ORDER BY queued_at ASC`
    ),
    listRecentByWorkspace: db.prepare(
      `SELECT * FROM turn WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?`
    ),
    get: db.prepare(`SELECT * FROM turn WHERE id = ?`),
    insert: db.prepare(
      `INSERT INTO turn
         (id, session_id, workspace_id, trigger_message_id, status, hop_depth, cwd,
          pid, exit_code, error_text, cost_usd, tokens_in, tokens_out, terminal_reason,
          queued_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)
       RETURNING *`
    ),
    /**
     * `queued` → `running`。**刻意不带 pid** —— 见 `markRunning()` 上的说明。
     */
    markRunning: db.prepare(
      `UPDATE turn SET status = 'running', started_at = ? WHERE id = ? RETURNING *`
    ),
    /** 终态。`ended_at` 一并写入，让「运行时长」不需要二次查询。 */
    finish: db.prepare(
      `UPDATE turn SET status = ?, exit_code = ?, error_text = ?, cost_usd = ?, tokens_in = ?,
              tokens_out = ?, terminal_reason = ?, ended_at = ?
       WHERE id = ? RETURNING *`
    ),
    /** 排队中就被取消的情况：从未启动，所以 started_at / ended_at 都是同一个时刻。 */
    markCancelled: db.prepare(
      `UPDATE turn SET status = 'cancelled', ended_at = ? WHERE id = ? RETURNING *`
    ),
    /**
     * ★ 启动时的孤儿清扫（§4.4）：任何仍是 queued/running 的轮次都是上次退出留下的。
     * 跑在 `idx_turn_running` 偏索引上，代价与库大小无关。
     *
     * `queued` 与 `running` 都会收，但**原因必须分开写**：`error_text` 是用户看得见的
     * 那一列（历史回放里就是那条轮次的失败说明）。queued 的写「仍在运行」是**假话** ——
     * 那一轮从没有过进程。SQLite 的 SET 右侧按**更新前**的行求值，所以 `CASE status`
     * 读到的正是被改掉之前的那个值。
     */
    reapOrphans: db.prepare(
      `UPDATE turn SET status = 'failed', ended_at = ?,
         error_text = CASE status
           WHEN 'running' THEN '应用上次退出时该轮次仍在运行，没有自动恢复'
           ELSE '应用上次退出时该轮次还没排上队执行，没有自动恢复'
         END
       WHERE status IN ('queued','running') RETURNING *`
    ),
    listOrphans: db.prepare(
      `SELECT * FROM turn WHERE status IN ('queued','running') ORDER BY queued_at ASC`
    ),
    setPid: db.prepare(`UPDATE turn SET pid = ? WHERE id = ? RETURNING *`),
    /**
     * ★ 空间级的用量汇总（M6b 的成本常驻显示，§5.4）。
     *
     * 为什么是**聚合**而不是「把 `turn:list` 的结果加起来」：那个通道**带 limit**。
     * 拿一个有上限的列表去求和，结果看起来完全正常，只在历史变长之后悄悄变小 ——
     * 正是 §4.6a 规则二那种「安静地少显示一样东西」。
     *
     * 走 `idx_turn_workspace_started ON turn(workspace_id, started_at DESC)`，
     * 覆盖 `workspace_id = ?` 这一段，是免费索引。
     *
     * ★★ `SUM` **跳过 NULL**，所以这里必须同时数出「无用量数据的轮次数」。
     * `cost_usd` / `tokens_in` / `tokens_out` 都是可空列：一轮失败、被中断、
     * 或进程被杀时它们**就是 NULL**。只报 `SUM` 的话，界面会显示一个偏低的
     * 数字而用户无从知道它偏低 —— 那正是这条纪律要防的谎。
     */
    usageOfWorkspace: db.prepare(
      `SELECT COUNT(*)              AS turn_count,
              SUM(cost_usd)         AS cost_usd,
              SUM(tokens_in)        AS tokens_in,
              SUM(tokens_out)       AS tokens_out,
              SUM(cost_usd IS NULL) AS turns_without_usage
         FROM turn WHERE workspace_id = ?`
    )
  }

  return {
    listBySession(sessionId: string): Turn[] {
      return (s.listBySession.all(sessionId) as Row[]).map(mapTurn)
    },

    listLive(): Turn[] {
      return (s.listLive.all() as Row[]).map(mapTurn)
    },

    listRecentByWorkspace(workspaceId: string, limit: number): Turn[] {
      return (s.listRecentByWorkspace.all(workspaceId, limit) as Row[]).map(mapTurn)
    },

    get(id: string): Turn | null {
      const row = s.get.get(id) as Row | undefined
      return row ? mapTurn(row) : null
    },

    /** 先落库为 `queued`，拿到并发槽位后再转 `running`（§4.5）。 */
    create(input: CreateTurnInput): Turn {
      const row = s.insert.get(
        input.id,
        input.sessionId,
        input.workspaceId,
        input.triggerMessageId ?? null,
        input.hopDepth ?? 0,
        input.cwd,
        input.now
      ) as Row
      return mapTurn(row)
    },

    /**
     * ★ **状态变更与 pid 是两件事，这里刻意只做第一件。**
     *
     * M2 的版本是 `markRunning(id, pid, now)`，把两者塞进同一条 UPDATE。
     * 到了 M6a 真的要有调用方时才发现那是个不可能满足的形状：**派发的那一刻
     * 还没有 pid** —— 进程要等 `run()` 里 spawn 之后才知道，而状态必须在派发时
     * 就翻成 `running`（否则「每 session 至多一个在跑」这条不变量的依据是空的）。
     *
     * 于是 pid 走已有的 `setPid()`，在 spawn 之后补。这正是 §4.5a 规则三
     * （不许从一个事实推断另一个）在列一级的落点：两件发生在不同时刻的事，
     * 就该有两次写入。中间那一段 `running` 且 `pid IS NULL` 是**合法**状态，
     * M10 的孤儿清扫本来就容忍空 pid。
     */
    markRunning(id: string, now: number): Turn | null {
      const row = s.markRunning.get(now, id) as Row | undefined
      return row ? mapTurn(row) : null
    },

    finish(
      id: string,
      status: Exclude<TurnStatus, 'queued' | 'running'>,
      usage: TurnUsage,
      now: number,
      exitCode: number | null = null,
      errorText: string | null = null
    ): Turn | null {
      const row = s.finish.get(
        status,
        exitCode,
        errorText,
        usage.costUsd ?? null,
        usage.tokensIn ?? null,
        usage.tokensOut ?? null,
        usage.terminalReason ?? null,
        now,
        id
      ) as Row | undefined
      return row ? mapTurn(row) : null
    },

    markCancelled(id: string, now: number): Turn | null {
      const row = s.markCancelled.get(now, id) as Row | undefined
      return row ? mapTurn(row) : null
    },

    setPid(id: string, pid: number): Turn | null {
      const row = s.setPid.get(pid, id) as Row | undefined
      return row ? mapTurn(row) : null
    },

    listOrphans(): Turn[] {
      return (s.listOrphans.all() as Row[]).map(mapTurn)
    },

    /**
     * 一个空间到目前为止的累计用量。
     *
     * ⚠️ 三处刻意的 `?? 0`，它们**不是**防御性写法：
     *
     * 1. 空空间：`COUNT(*)` 本来就是 0，但 `SUM(...)` 在**零行**上返回 NULL
     *    （不是 0）。`SUM(cost_usd IS NULL)` 同理 —— 一个刚建的空间会得到
     *    `turnsWithoutUsage: null`，那是个「未测量」的形状，而正确答案是 0。
     * 2. `SUM(cost_usd)` 在「有轮次、但一轮都没报过用量」时也是 NULL。
     *    这时候 `costUsd: 0` 配上 `turnsWithoutUsage === turnCount` 是**正确**的读法：
     *    已知的合计确实是 0，而另一栏把「这个 0 不代表没花钱」说清楚了。
     *    （两者缺一，这个 0 就成了谎。）
     */
    usageOfWorkspace(workspaceId: string): WorkspaceUsage {
      const row = s.usageOfWorkspace.get(workspaceId) as Row
      return {
        turnCount: num(row, 'turn_count'),
        costUsd: nnum(row, 'cost_usd') ?? 0,
        tokensIn: nnum(row, 'tokens_in') ?? 0,
        tokensOut: nnum(row, 'tokens_out') ?? 0,
        turnsWithoutUsage: nnum(row, 'turns_without_usage') ?? 0
      }
    },

    /**
     * 把遗留的 queued/running 全部翻成 failed。
     * 返回**被清扫的轮次**，调用方据此 `taskkill` 记录的 PID
     * —— 那个 claude 进程可能比父进程活得久（§4.4）。
     */
    reapOrphans(now: number): Turn[] {
      return (s.reapOrphans.all(now) as Row[]).map(mapTurn)
    }
  }
}

export type TurnRepo = ReturnType<typeof turnRepo>
