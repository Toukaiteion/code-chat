import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '../adapters/agent-adapter.ts'
import type { AppendEventInput, AppendMessageInput } from '../persist/repositories/message-repo.ts'
import type { Message, MessageEvent, Session, TerminalReason, Turn } from '../../shared/entities.ts'
import type { PushOf } from '../../shared/ipc/contract.ts'
import { synthesizeFileDiff, looksLikeEditor } from '../domain/tool-diff.ts'

/**
 * 合批器 —— 从 `AgentEvent` 到线上帧、再到库的**唯一**通道。
 *
 * 它同时是四件事的所有者，而这四件事**必须**由同一个东西拥有，否则它们会互相打架：
 *
 * 1. **帧 seq**（`StreamFrame.seq`）—— 见下面「三条 seq 轴」；
 * 2. **合并规则**（相邻 text / thinking 拼成一帧，保留**首个** seq）；
 * 3. **一次刷新 = 一个事务**（追加事件行 + 折叠正文 + 推进水位）；
 * 4. **在途帧的回放环**（`stream:resume` 的读取端）。
 *
 * ## 三条 seq 轴（★ 混掉任何两条，界面会**静默地**不再更新）
 *
 * 这个系统里有三个都叫 `seq` 的计数器，它们跨 IPC、跨表、跨进程生命周期，
 * 而**没有任何一处类型能阻止你把它们互相赋值**（都是 `number`）。所以在这里写死：
 *
 * | 轴 | 谁分配 | 作用域 | 落库吗 | 谁读 |
 * |---|---|---|---|---|
 * | **帧** `StreamFrame.seq` | **本文件** | 每 session、跨轮次单调 | **否** —— 没有对应的列，一个都没有 | 渲染层的水位线 |
 * | **事件行** `message_event.seq` | `message-repo.nextEventSeq` | 每**消息**（从 1 重来） | 是（`UNIQUE(message_id, seq)`） | `message:getEvents` |
 * | **消息** `message.seq` | `message-repo.append` | 每**空间** | 是（`UNIQUE(workspace_id, seq)`） | 历史分页、M7 的 `<recent>` |
 *
 * 三条推论，都是会真的踩到的：
 *
 * - **`stream:resume.fromSeq` 只能来自渲染层真正收到过的最后一帧**（等价地：上一批的
 *   `toSeq`）。它**推不出来** —— `message:list` / `message:getEvents` 返回的 `seq`
 *   是**另外两条轴**上的数，填进去会得到一个「看起来在工作」的水位线。
 * - 帧 seq **不落库**，所以进程一重启就从 0 重来，而渲染层手里那个旧水位线
 *   恰好会把新帧**全部**滤掉（新 seq 全都小于它）。**这正是 `epoch` 存在的唯一理由。**
 * - `message_event.seq` **每条消息从 1 重来**：所以「帧 seq=37 的那段文字」与
 *   「事件行 seq=37」说的是两个完全无关的位置。
 *
 * ## 先落库、后推送
 *
 * 推送只发生在**事务提交之后**。这是 §4.5a 规则二那条推论（「不允许先发事件、后落库」）
 * 的直接实现 —— 反过来做，界面会显示一条重启后就消失的内容。
 * 落库失败时**一个字节都不发**：宁可整轮失去，也不做一个「界面有、库里没有」的假象。
 *
 * ## 崩溃窗口（如实写下来）
 *
 * 定时器刷新意味着**硬杀时最多丢 33ms 的增量**。终态 `done` 与正文折叠是同步写的，
 * 所以丢的是尾巴而不是结局。工具调用不受影响 —— 它们是屏障，到达即落库。
 *
 * ⚠️ 本文件**不 import electron、不 import `node:sqlite`**：持久化面由构造注入
 * （`BatcherStore`，刻意是窄口而非整个 `Store`），所以它能被裸 Node 直接测。
 */

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/** 线上帧与线上批次 —— 从 schema 推导，不手写（改 schema 就是改类型）。 */
export type StreamFrame = PushOf<'stream:batch'>['frames'][number]
export type StreamBatch = PushOf<'stream:batch'>
export type UnreadPayload = PushOf<'workspace:unread'>
export type StatusPayload = PushOf<'stream:status'>
/** 帧联合里的 `usage` 那一支。窄化要显式写出来，否则返回处会被放宽回整个联合。 */
type UsageFrame = Extract<StreamFrame, { k: 'usage' }>
type ToolResultFrame = Extract<StreamFrame, { k: 'tool_result' }>

/**
 * 渲染层当前可见的空间。
 *
 * ⚠️ **刻意不用 `ipc/registry.ts` 的 `ActiveView`**，虽然形状一样：
 * `process/` 反过来依赖 `ipc/` 会把依赖方向绕成一个圈。结构相同就够了 ——
 * 那边传进来的对象天然满足这个接口，不需要任何转换。
 */
export interface ViewLike {
  workspaceId: string | null
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** 一条待落库的事件行。`messageId` 在刷新时才填 —— 消息行是**惰性创建**的。 */
export type PendingRow = Omit<AppendEventInput, 'messageId'>

/** 合批器需要的**最小**持久化面。由 `store.repos` 满足 —— 窄口是刻意的，见文件头。 */
export interface BatcherStore {
  tx<T>(fn: () => T): T
  message: {
    append(input: AppendMessageInput): Message
    appendEvent(input: AppendEventInput): MessageEvent
    /**
     * 更新**流式写入的正文**。⚠️ 不是 `editText` —— 那个会写 `edited_at`，
     * 于是界面会把模型自己的回答标成「用户编辑过」。
     */
    setStreamedText(id: string, text: string): Message | null
  }
  session: {
    advanceSeq(id: string, seq: number): Session | null
    bumpTurnCount(id: string, now: number): Session | null
  }
  turn: {
    finish(
      id: string,
      status: 'done' | 'interrupted' | 'failed',
      usage: TurnUsageWrite,
      now: number,
      exitCode?: number | null,
      errorText?: string | null
    ): Turn | null
  }
}

export interface TurnUsageWrite {
  costUsd?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  terminalReason?: string | null
}

export interface TurnIdentity {
  turnId: string
  sessionId: string
  workspaceId: string
  /** 说话的那个角色的 id —— 批次载荷里的 `actorId`。 */
  actorId: string
  /** 这条 assistant 消息的作者 = 跑这一轮的成员。 */
  authorMemberId: string
  /** 用来把 diff 里的绝对路径缩短成展示路径（§8.5b 解析出来的那个 cwd）。 */
  cwd: string
  /** 惰性创建 assistant 消息行时用。注入是为了让断言能写死 id。 */
  newMessageId(): string
}

/**
 * 终态写入 —— **由调度层算好，合批器只负责执行**。
 *
 * ★ 这个类型的存在本身就是一条纪律：合批器**不许**自己决定「这一轮算成功还是失败」。
 * 它只看得见事件流，而 `done.reason → turn.status` 的映射表只有一处（`turn-runner`）。
 * 两个地方各判一次，就会出现「库里写 `done`、事件流最后一条却是 `error`」这种自相矛盾的行。
 *
 * `reason` 同时是两个东西：`done` 帧上的 `reason`，与 `turn.terminal_reason` 那一列。
 * 它们**就该是同一个值** —— 文档的映射表里 `complete/interrupted/crashed/budget`
 * 四行的两列逐字相同。
 */
export interface TerminalWrite {
  reason: TerminalReason
  status: 'done' | 'interrupted' | 'failed'
  errorText: string | null
  exitCode: number | null
}

export interface BatcherOptions {
  store: BatcherStore
  clock: Clock
  /** **引用**传入：`view:setActive` 改的就是这个对象，晚绑定。 */
  view: ViewLike
  emitBatch(batch: StreamBatch): void
  emitUnread(payload: UnreadPayload): void
  /**
   * ★ **终态**的 `stream:status`（M6b 补上的生产者）。
   *
   * 为什么发在合批器这里：`turn.status` 的所有者是 `turn-repo`，而
   * 「**状态切换的唯一时点是事务提交**」（§4.5a 规则二）。合并终态与正文折叠的
   * 那个事务就在本文件里（`endTurn` → `commit`），所以终态的推送点只能紧跟它。
   *
   * ⚠️ 它与同一批里的 `done` 帧**不是同一件事**，尽管它们在 `endTurn` 这一刻
   * 一起发生：`done` 帧说的是「这一轮的正文结束了」。正常路径上那一帧早在
   * **249–377ms 之前**就已经随一次普通刷新发走了（M6a 实测），两者之间那段
   * 正是「正文已完、而库里那一行还不是终态」的窗口。渲染层据此把
   * 「流式结束」与「轮次行落定」分开处理 —— 合并成一个信号就会在那个窗口里
   * 让界面断言一件还没发生的事。
   */
  emitStatus(payload: StatusPayload): void
  /** 我们自己的内部异常（落库失败、契约被违反、没有映射表的编辑工具）。**不是** `AgentEvent.error`。 */
  onWarn(tag: string, message: string, detail?: unknown): void
  /** 本进程的纪元。省略则现铸一个 —— 生产环境在 `main/index.ts` 里只铸一次。 */
  epoch?: string
  flushMs?: number
  maxFramesPerFlush?: number
  maxBufferBytes?: number
  unreadMs?: number
  ringFrames?: number
}

export interface FlushResult {
  ok: boolean
  /** 本批**发出去**的帧数（被抑制时为 0，但 `persisted` 仍然大于 0）。 */
  emitted: number
  persisted: number
}

export interface ResumeResult {
  epoch: string
  matched: boolean
  frames: StreamFrame[]
}

export interface EventBatcher {
  /**
   * 本进程的纪元。**公开读**而不是让调用方各存一份 —— 两份状态里必然有一份先过期，
   * 而过期的表现是「重放被判成不匹配」这种查不出原因的错位。
   */
  readonly epoch: string
  beginTurn(id: TurnIdentity): void
  push(turnId: string, ev: AgentEvent): FlushResult
  /** 收尾：`done` 帧、正文折叠、终态行一起进**一个**事务。 */
  endTurn(turnId: string, t: TerminalWrite): FlushResult
  resume(sessionId: string, epoch: string, fromSeq: number): ResumeResult
  unread(workspaceId: string): number
  clearUnread(workspaceId: string): void
  /** 只给测试与自检看。 */
  debugState(): unknown
  /** 清定时器 + 同步冲空。**必须在 `store.close()` 之前调**（见 `main/index.ts`）。 */
  close(): void
}

/** 默认时序。`flushMs` 与合批上限都是 §4.3 定的数。 */
export const DEFAULT_BATCH_TIMINGS = {
  flushMs: 33,
  maxFramesPerFlush: 64,
  maxBufferBytes: 32 * 1024,
  unreadMs: 1000,
  ringFrames: 4096
} as const

/**
 * 单帧载荷上限（§4.3）。与 `message-repo.FRAME_PAYLOAD_LIMIT` 是**同一个数**，
 * 但这里独立声明一次而不是 import —— 那个常量住在 `persist/`，而本文件刻意只依赖
 * 注入进来的窄口（见文件头）。两处一旦分叉，`event-batcher.test.ts` 里那条断言会红。
 */
export const FRAME_PAYLOAD_LIMIT = 256 * 1024

// ─────────────────────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────────────────────

/** 缓冲里的一帧：线上形状 + 它要落的那一行（`row: null` = 只上线不落库）。 */
interface Buffered {
  frame: StreamFrame
  row: PendingRow | null
}

interface SessionState {
  /** 已分配的**最大**帧号。它是水位线的高位，见 `toSeq` 的说明。 */
  seq: number
  /** 在途回放环。存的是**线上的原样**，所以重放的帧与实时的帧不可区分。 */
  frames: StreamFrame[]
  /** 还能回放的最早水位。比它旧的请求一律 `matched: false`（宁可让渲染层整段重跑）。 */
  retainedFrom: number
  /** 本会话正在跑的那一轮；`null` = 没有。 */
  turnId: string | null
}

interface TurnState {
  id: TurnIdentity
  buf: Buffered[]
  bufBytes: number
  /** 惰性创建。**不在派发时创建** —— 一次先导失败或空轮不该留下一条永久的空消息行。 */
  message: Message | null
  /** 整轮所有 text 的拼接。它与最后一批 `text` 事件**同源**，见 `content_text` 的说明。 */
  textAccum: string
  /** 上次写进 `content_text` 的值，避免无意义的 UPDATE。 */
  textWritten: string
  /** 流内累计的思考字符数 —— §4.6a 规则二在帧上的落点，见 `usageFrame()`。 */
  thinkingChars: number
  /** 最近一次上报的用量。终态写入要用。 */
  usage: TurnUsageWrite
  /** 记下 `tool_use.input`，等 `tool_result` 成功时合成 diff（§8.9-17）。 */
  toolInputs: Map<string, { name: string; input: unknown }>
  /** CLI 自报的会话 id（`system:init`）。**只是簿记**，不进 `message_event`。 */
  cliSessionId: string | null
  /** `done` 帧是否已经进过缓冲 —— 防止 `push(done)` 与 `endTurn` 各推一次。 */
  donePushed: boolean
  /** 本轮的告警标签计数（不落库，只进 `debugState()` 与日志）。 */
  warns: Map<string, number>
  ended: boolean
  /** 本轮的批次是否因跨空间被抑制过 —— 未读的单位是**轮次**，所以一个布尔就够。 */
  suppressed: boolean
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function frameBytes(f: StreamFrame): number {
  switch (f.k) {
    case 'text':
    case 'thinking':
      return byteLength(f.d)
    case 'tool_result':
      return byteLength(f.output)
    case 'file_diff':
      return byteLength(f.patch)
    case 'error':
      return byteLength(f.message)
    default:
      return 0
  }
}

/**
 * 按 UTF-8 **字节**上限切一段文本，**且真的不超上限、也不切坏多字节字符**。
 *
 * ⚠️ 第一版写的是 `buf.subarray(0, maxBytes).toString('utf8')`，注释里还写着
 * 「边界上可能留一个 U+FFFD，可接受」。**那句话两头都是错的**，实测（Node 24）：
 *
 * ```
 * '汉'.repeat(262144)            → 786432 字节
 * .subarray(0, 262144).toString('utf8')
 *   → 262146 字节（★ 超出上限 2 字节），且中间带一个 U+FFFD
 * ```
 *
 * 切在半个字符上时，那半个字符会被替换成 3 字节的 U+FFFD —— 于是「按 256KB 截断」
 * 这个承诺**反而不成立**了，而多出来的那 2 字节恰好是别人依赖这个数时最不该有的东西。
 * 同时，用户会在自己的中文回答正中间看到一个 `�`。
 *
 * 现在的做法：**往前退到字符边界**。UTF-8 的续字节形如 `10xxxxxx`，
 * 所以从 `maxBytes` 往前退到第一个不是续字节的位置，那里正好是一个字符的开头。
 * 代价是最多丢掉 3 个字节的尾巴（行里留着全量，见 `tool_result` 那条注释）。
 */
function sliceUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && ((buf[end] as number) & 0b1100_0000) === 0b1000_0000) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

const NOTHING: FlushResult = { ok: true, emitted: 0, persisted: 0 }

export function createEventBatcher(opts: BatcherOptions): EventBatcher {
  const clock = opts.clock
  const limit = FRAME_PAYLOAD_LIMIT
  const flushMs = opts.flushMs ?? DEFAULT_BATCH_TIMINGS.flushMs
  const maxFrames = opts.maxFramesPerFlush ?? DEFAULT_BATCH_TIMINGS.maxFramesPerFlush
  const maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_BATCH_TIMINGS.maxBufferBytes
  const unreadMs = opts.unreadMs ?? DEFAULT_BATCH_TIMINGS.unreadMs
  const ringFrames = opts.ringFrames ?? DEFAULT_BATCH_TIMINGS.ringFrames

  /**
   * ★ **纪元：本进程一铸一次，全体会话共用。**
   *
   * 它要作废的是「**进程重启**」这件事 —— 重启之后每一条帧 seq 都从 0 重来，
   * 所以每一个会话手里的水位线都失效了，一个不落，进程级的串正好表达这件事。
   * 做成每会话一个不会多覆盖任何情况（会话 id 是 uuid，`session:remove` 之后重建
   * 拿到的是新 id，不构成「同一个 id 换了纪元」的场景），却要多一份状态。
   */
  const epoch = opts.epoch ?? randomUUID()

  const sessions = new Map<string, SessionState>()
  const turns = new Map<string, TurnState>()
  const unreadCounts = new Map<string, number>()

  /** 有非空缓冲的轮次。`Set` 的插入序即处理序，所以刷新顺序是确定的。 */
  const dirty = new Set<string>()
  let flushTimer: unknown = null

  /** 被 ≤1Hz 节流压住的未读。 */
  const unreadPending = new Set<string>()
  let unreadTimer: unknown = null
  let lastUnreadAt = 0

  let closed = false

  // ─── 单例计时器 ─────────────────────────────────────────────
  //
  // 一个进程级的定时器，不是每轮一个：并发上限是 3（`Semaphore(3)`），定时器个数
  // 本来就没有差别；而**一个**定时器意味着测试里的假时钟只需要驱动一处，
  // 也意味着同一 tick 上所有会话一起刷 —— 渲染层收到的是一阵，不是三阵交错的。

  function armFlush(): void {
    if (flushTimer !== null || closed) return
    flushTimer = clock.setTimeout(() => {
      flushTimer = null
      for (const turnId of [...dirty]) {
        try {
          const frames = commit(turnId, null)
          if (frames) emitFrames(turnId, frames)
        } catch (err) {
          // 定时器回调里抛出去会变成 uncaughtException。这里兜住并如实报。
          opts.onWarn('flush-timer-failed', `定时刷新失败：${describe(err)}`, { turnId })
          dirty.delete(turnId)
        }
      }
    }, flushMs)
  }

  function clearFlush(): void {
    if (flushTimer === null) return
    clock.clearTimeout(flushTimer)
    flushTimer = null
  }

  function sessionState(sessionId: string): SessionState {
    let s = sessions.get(sessionId)
    if (!s) {
      s = { seq: 0, frames: [], retainedFrom: 0, turnId: null }
      sessions.set(sessionId, s)
    }
    return s
  }

  function turnState(turnId: string): TurnState {
    const t = turns.get(turnId)
    if (!t) throw new Error(`轮次 ${turnId} 没有 beginTurn 就被推事件`)
    return t
  }

  function warn(t: TurnState, tag: string, message: string, detail?: unknown): void {
    t.warns.set(tag, (t.warns.get(tag) ?? 0) + 1)
    opts.onWarn(tag, message, detail)
  }

  // ─── 未读（≤1Hz，单位 = 轮次）───────────────────────────────

  /**
   * ★ **未读的单位是「一个轮次」，不是「一批帧」。**
   *
   * 文档没写单位，这是 M6a 的裁定（记进 §4.7）。理由：一批帧是 33ms 一次的技术细节，
   * 而用户看到那个角标时的心理模型是「那边**发生了一件事**」。按批计的话，
   * 一个跑了 5 分钟、一直被抑制的轮次会攒出几千个未读 ——
   * 一个除了「很多」之外什么信息都没有的数。
   */
  function markUnread(t: TurnState): void {
    if (t.suppressed) return
    t.suppressed = true
    unreadCounts.set(t.id.workspaceId, (unreadCounts.get(t.id.workspaceId) ?? 0) + 1)
    unreadPending.add(t.id.workspaceId)
    drainUnread()
  }

  function drainUnread(): void {
    if (closed || unreadPending.size === 0) return
    const now = clock.now()
    const wait = lastUnreadAt === 0 ? 0 : unreadMs - (now - lastUnreadAt)
    if (wait > 0) {
      // ★ 节流 ≠ 丢。被压住的留在 `unreadPending` 里，由这个 trailing 定时器补发 ——
      // 少了它，角标会永远停在一个旧数字上（而那个数字看起来完全正常）。
      if (unreadTimer === null) {
        unreadTimer = clock.setTimeout(() => {
          unreadTimer = null
          drainUnread()
        }, wait)
      }
      return
    }
    lastUnreadAt = now
    for (const ws of [...unreadPending]) {
      unreadPending.delete(ws)
      opts.emitUnread({ workspaceId: ws, count: unreadCounts.get(ws) ?? 0 })
    }
  }

  // ─── 帧的分配与合并 ─────────────────────────────────────────

  function nextSeq(s: SessionState): number {
    s.seq += 1
    return s.seq
  }

  /**
   * 放一帧**可合并**的帧（`text` / `thinking`）。
   *
   * ★ **合并保留首个 seq**（§4.3 规则 2）。每段都新分配一个号再拼进去的话，
   * 200 delta/s 会变成「200 个序号只用了 30 个」—— 水位线于是**跳过**中间那些号，
   * 而渲染层下一次 `resume` 会以为自己漏了 170 帧。
   */
  function pushMergeable(
    t: TurnState,
    s: SessionState,
    kind: 'text' | 'thinking',
    text: string
  ): void {
    const last = t.buf[t.buf.length - 1]
    if (last && last.frame.k === kind && byteLength(last.frame.d) + byteLength(text) <= limit) {
      last.frame.d += text
      if (last.row) last.row.textBlob = last.frame.d
      t.bufBytes += byteLength(text)
      markDirty(t)
      return
    }
    // ★ 超上限时**另起一段**，不截断：`text` 是模型的正文，截了就真的没了。
    // 分段不丢任何东西 —— 渲染层本来就是按帧追加的。落库时它们是两条独立的事件行，
    // 与「合并只发生在帧上」这条一致。
    const frame: StreamFrame = { seq: nextSeq(s), k: kind, d: text }
    t.buf.push({
      frame,
      row: { kind: kind === 'text' ? 'text' : 'thinking', textBlob: text, now: clock.now() }
    })
    t.bufBytes += byteLength(text)
    markDirty(t)
  }

  function pushAtomic(t: TurnState, frame: StreamFrame, row: PendingRow | null): void {
    t.buf.push({ frame, row })
    t.bufBytes += frameBytes(frame)
    markDirty(t)
  }

  /**
   * ★ **缓冲里一有东西就把 33ms 的定时器挂上。**
   *
   * 这条在 M6a 的第一版里**漏了**，而漏掉的表现非常隐蔽：`text_delta` 走的是
   * `pushMergeable` + `maybeImmediate`，两者都不碰定时器 —— 于是**最常发生的那件事**
   * （模型在说话）攒在缓冲里，只在另一个屏障事件到来、或某一批超过 64 帧 / 32KB 时才出去。
   * 用户看到的是「模型想了很久，突然一次吐出一大段」，而 §4.3 明写的是 ~30Hz。
   *
   * 更坏的是它**不会报任何错**：所有落库与推送的代码都是对的，只是没人来敲门。
   * `event-batcher.test.ts` 里那条「33ms 到点才发」正是靠这个才抓到的 ——
   * 所以那条用例的断言里带着 `pending() === 1`（数的是定时器），而不只是「最终发出去了」。
   *
   * 放在这里而不是放在 `push()` 的出口：`push()` 的每个 `case` 都 `return`，
   * 中心化在出口意味着要把它重构成「先算结果再统一收尾」，而那是给这个 bug
   * 留第二次机会的写法 —— 下一次有人加一个 case 时，他又得记得那一句。
   */
  function markDirty(t: TurnState): void {
    dirty.add(t.id.turnId)
    armFlush()
  }

  function pushDoneRow(t: TurnState, s: SessionState, reason: TerminalReason): void {
    pushAtomic(t, { seq: nextSeq(s), k: 'done', reason }, {
      kind: 'done',
      payloadJson: JSON.stringify({ reason }),
      now: clock.now()
    })
    t.donePushed = true
  }

  // ─── 事件 → 帧 ──────────────────────────────────────────────

  function usageFrame(
    t: TurnState,
    ev: Extract<AgentEvent, { k: 'usage' }>,
    seq: number
  ): UsageFrame {
    /**
     * ★ §4.6a 规则二：**上报值 > 0 才用上报值，否则用流内累计估算。**
     *
     * 这条规则是被实测逼出来的：这个端点上 `output_tokens_details.thinking_tokens`
     * 报的是 **0**，而那一轮明明有 374 段思考。拿 0 覆盖掉一个实测量，
     * 等于「渲染了一个假的 0」—— 0 的含义是「没上报」，不是「没思考」。
     *
     * 两级兜底：解析器（它看得见 `system:thinking_tokens` 的累计估算）已经试过一轮；
     * 它也给不出数时，才用**本轮思考文本的字符数**粗估（约 4 字符 ≈ 1 token）。
     * ⚠️ 粗估**只在真有思考文本时才生效** —— 没有任何思考的那一轮，0 就是真值，
     * 编一个数出来是另一种撒谎。
     */
    const reported = ev.thinkingTokens ?? 0
    const thinkingTokens =
      reported > 0 ? reported : t.thinkingChars > 0 ? Math.ceil(t.thinkingChars / 4) : 0

    return {
      seq,
      k: 'usage',
      in: ev.in,
      out: ev.out,
      cacheRead: ev.cacheRead ?? 0,
      cacheCreation: ev.cacheCreation ?? 0,
      thinkingTokens,
      ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {})
    }
  }

  /**
   * §8.9-17 的合成点：`tool_result` **成功**时，用记下来的 `tool_use.input` 造 diff。
   *
   * ⚠️ **只在 `ok === true` 时造。** 一次失败的工具调用**没有改动任何文件**，
   * 给它配一条 diff 就是在展示一个不存在的改动 —— 用户会照着它去找一个没发生的编辑。
   */
  function diffBuffers(
    t: TurnState,
    s: SessionState,
    ev: Extract<AgentEvent, { k: 'tool_result' }>
  ): Buffered[] {
    if (!ev.ok) return []
    const remembered = t.toolInputs.get(ev.id)
    if (!remembered) return []

    const synth = synthesizeFileDiff(remembered.name, remembered.input, t.id.cwd)
    if (!synth) {
      // ★ 「工具改了文件、界面上却什么都没有」**不许安静地发生**（§8.9-17 的复发形态）。
      if (looksLikeEditor(remembered.name)) {
        warn(
          t,
          'file-diff-unmapped-tool',
          `工具 ${remembered.name} 会改文件，但我们没有它的 diff 映射表 —— 这次改动不会出现在界面上`,
          { toolUseId: ev.id }
        )
      }
      return []
    }

    return [
      {
        frame: { seq: nextSeq(s), k: 'file_diff', path: synth.path, patch: synth.patch },
        row: {
          kind: 'file_diff',
          toolUseId: ev.id,
          toolName: remembered.name,
          payloadJson: JSON.stringify({ path: synth.path }),
          textBlob: synth.patch,
          now: clock.now()
        }
      }
    ]
  }

  // ─── 落库（一个事务）────────────────────────────────────────

  /**
   * 惰性建行。第一次真的**有东西要落**的时候才建 —— 在派发时就建的话，
   * 一次先导失败（成员已停用、适配器缺失）会留下一条永远不会被填的空消息，
   * 而它会长在时间线上，看起来像模型回了个空。
   */
  function ensureMessage(t: TurnState): void {
    if (t.message) return
    t.message = opts.store.message.append({
      id: t.id.newMessageId(),
      workspaceId: t.id.workspaceId,
      sessionId: t.id.sessionId,
      turnId: t.id.turnId,
      role: 'assistant',
      authorMemberId: t.id.authorMemberId,
      contentText: t.textAccum,
      now: clock.now()
    })
    t.textWritten = t.textAccum
  }

  /**
   * 把缓冲落库并交给回放环；`terminal` 非空时**顺带把终态行也写进同一个事务**。
   *
   * 顺序是**强制**的：`ensureMessage` → 逐行 `appendEvent` → 折叠正文 → 推进 session 水位
   * → （终态）`bumpTurnCount` + `turn.finish`。全部在**一个** `store.tx()` 里
   * （§8.8 规则二：repo 的写方法已是 SAVEPOINT，可嵌套）。
   * **提交之前不碰任何内存里的可见状态**，也不发任何东西。
   *
   * @returns 已提交的帧；失败时返回 `null`（此时**一个字节都没发**）。
   */
  function commit(turnId: string, terminal: TerminalWrite | null): StreamFrame[] | null {
    const t = turns.get(turnId)
    if (!t) return null
    if (t.buf.length === 0 && !terminal) return []

    const batch = t.buf
    const frames = batch.map((b) => b.frame)

    try {
      opts.store.tx(() => {
        if (batch.length > 0) ensureMessage(t)
        if (t.message) {
          for (const b of batch) {
            if (!b.row) continue
            opts.store.message.appendEvent({ ...b.row, messageId: t.message.id })
          }
          if (t.textAccum !== t.textWritten) {
            const msg = opts.store.message.setStreamedText(t.message.id, t.textAccum)
            if (msg) {
              t.message = msg
              t.textWritten = t.textAccum
            }
          }
          // 空间时间线的水位：`advanceSeq` 内部是 `MAX(last_seq, ?)`，
          // 所以重复调用是幂等的，不需要再加一个「上次推到哪」的状态。
          opts.store.session.advanceSeq(t.id.sessionId, t.message.seq)
        }
        if (terminal) {
          opts.store.session.bumpTurnCount(t.id.sessionId, clock.now())
          opts.store.turn.finish(
            t.id.turnId,
            terminal.status,
            { ...t.usage, terminalReason: terminal.reason },
            clock.now(),
            terminal.exitCode,
            terminal.errorText
          )
        }
      })
    } catch (err) {
      opts.onWarn('persist-failed', `事件落库失败，本批未推送：${describe(err)}`, { turnId })
      t.buf = []
      t.bufBytes = 0
      dirty.delete(turnId)
      /**
       * ★ **内存里的簿记也必须跟着回滚。**
       *
       * `ensureMessage` 是在事务**内部**建的行 —— 事务一撤，那一行就不存在了，
       * 而 `t.message` 还攥着它的 id。留着的话，下一批 `appendEvent` 会撞一条
       * 外键错误（`message_id` 指向一个不存在的消息），而那个报错在库层面看起来
       * 与本轮的真正起因（磁盘/锁）毫无关系 —— 一次失败会长成一次**永久失败**。
       *
       * `textAccum` **不清**：那是模型真的说过的话，它还要在下一批里被折叠进
       * `content_text`。丢的是这一批的帧，不是这一轮的正文。
       */
      t.message = null
      t.textWritten = ''
      // ★ 终态失败时**再试一次只写终态行**：一次事件写不进去不该演变成
      // 「库里留着一个永远 running 的僵尸轮次」。丢掉的是尾巴，不是结局。
      if (terminal) bestEffortTerminal(t, terminal)
      return null
    }

    t.buf = []
    t.bufBytes = 0
    dirty.delete(turnId)
    retain(sessionState(t.id.sessionId), frames)
    return frames
  }

  function bestEffortTerminal(t: TurnState, terminal: TerminalWrite): void {
    try {
      opts.store.tx(() => {
        opts.store.turn.finish(
          t.id.turnId,
          terminal.status,
          { ...t.usage, terminalReason: terminal.reason },
          clock.now(),
          terminal.exitCode,
          terminal.errorText
        )
      })
    } catch (err) {
      opts.onWarn('persist-failed-terminal', `终态行也没写进去：${describe(err)}`, {
        turnId: t.id.turnId
      })
    }
  }

  /**
   * 把已提交的帧放进回放环。
   *
   * 环在**新一轮的第一帧**到来时清空（见 `beginTurn`），**不是** `endTurn` 时。
   * 理由：渲染层完全可能在一轮**跑完之后**才切回来（它被抑制的那一轮刚好结束了），
   * 那时它仍然该拿到尾巴。
   */
  function retain(s: SessionState, frames: readonly StreamFrame[]): void {
    for (const f of frames) s.frames.push(f)
    if (s.frames.length <= ringFrames) return
    const removed = s.frames.splice(0, s.frames.length - ringFrames)
    const highest = removed[removed.length - 1]
    // 被淘汰的那些再也回放不了 —— 把水位推到它们之后，于是比它旧的请求得到
    // `matched: false`，而不是**一段残缺的重放**（那会让界面少一块而不报错）。
    if (highest) s.retainedFrom = Math.max(s.retainedFrom, highest.seq)
  }

  function emitFrames(turnId: string, frames: StreamFrame[]): FlushResult {
    const t = turns.get(turnId)
    if (!t || frames.length === 0) return NOTHING

    if (opts.view.workspaceId !== t.id.workspaceId) {
      // 帧已经落库，**没有损失** —— 渲染层切回来时用 `stream:resume` 或历史接口拿。
      markUnread(t)
      return { ok: true, emitted: 0, persisted: frames.length }
    }

    const s = sessionState(t.id.sessionId)
    opts.emitBatch({
      v: 1,
      t: clock.now(),
      workspaceId: t.id.workspaceId,
      sessionId: t.id.sessionId,
      turnId: t.id.turnId,
      actorId: t.id.actorId,
      epoch,
      fromSeq: frames[0]?.seq ?? s.seq,
      /**
       * ★ `toSeq` 取**计数器高位**（`session.seq`），**不是** `frames[last].seq`。
       *
       * 合并保留首个 seq，所以最后一帧的号在一般情况下就不等于「已分配到的最大号」。
       * 用计数器是唯一在**所有**情况下都成立的选择：它正是渲染层下一次 `fromSeq`
       * 该填的值，而只要它不小于最后一帧的号，就没有任何帧会被漏掉或被重复投递。
       */
      toSeq: s.seq,
      frames
    })
    return { ok: true, emitted: frames.length, persisted: frames.length }
  }

  /** 缓冲到量就立刻冲，不等 33ms。 */
  function maybeImmediate(turnId: string): FlushResult {
    const t = turns.get(turnId)
    if (!t) return NOTHING
    if (t.buf.length < maxFrames && t.bufBytes < maxBufferBytes) return NOTHING
    const frames = commit(turnId, null)
    return frames ? emitFrames(turnId, frames) : { ok: false, emitted: 0, persisted: 0 }
  }

  /**
   * 屏障（§4.3 规则 3）：**先冲缓冲，屏障帧与它同批发出**。
   *
   * 两次 `commit` 而不是一次，是为了让「提交」严格发生在「拼接」之前 ——
   * 两半各自是一次干净的提交，任何一次失败都不连累另一半；而**发出一批**：
   * 渲染层看到的是「文字和它触发的工具调用同时出现」，不会有一帧空窗，
   * 也不会出现「工具先于它前面那段文字」的乱序观感。
   */
  function barrier(t: TurnState, additions: Buffered[], before?: () => void): FlushResult {
    const turnId = t.id.turnId
    const leading = commit(turnId, null)
    if (leading === null) return { ok: false, emitted: 0, persisted: 0 }
    before?.()
    for (const b of additions) {
      t.buf.push(b)
      t.bufBytes += frameBytes(b.frame)
    }
    const barrierFrames = commit(turnId, null)
    if (barrierFrames === null) return { ok: false, emitted: 0, persisted: 0 }
    return emitFrames(turnId, [...leading, ...barrierFrames])
  }

  return {
    epoch,

    beginTurn(id: TurnIdentity): void {
      const s = sessionState(id.sessionId)
      // ★ 「每 session 至多一个在跑」是 §4.5a 规则一，而**这里**是它最后一道防线。
      // 两个轮次的帧静默交错，会让渲染层把两条回答拼成一条 —— 而且不会有任何报错。
      const prev = s.turnId === null ? null : turns.get(s.turnId)
      if (prev && !prev.ended) {
        throw new Error(
          `会话 ${id.sessionId} 上一个轮次 ${prev.id.turnId} 还没结束，就开始了 ${id.turnId}`
        )
      }
      // 新一轮开始 → **上一轮**的在途帧不再可回放（但直到此刻它们都还在，
      // 这正是「渲染层在一轮跑完之后才切回来」能拿到尾巴的原因）。
      if (s.frames.length > 0) {
        s.retainedFrom = Math.max(s.retainedFrom, s.seq)
        s.frames = []
      }
      // 上一轮的 TurnState 到此为止只留着给 `push-after-end` 用，扔进 `turns.delete`
      // 会连那个判断一起丢掉 —— 所以留着，但重的东西已经在 `endTurn` 里清空了。
      s.turnId = id.turnId
      turns.set(id.turnId, {
        id,
        buf: [],
        bufBytes: 0,
        message: null,
        textAccum: '',
        textWritten: '',
        thinkingChars: 0,
        usage: {},
        toolInputs: new Map(),
        cliSessionId: null,
        donePushed: false,
        warns: new Map(),
        ended: false,
        suppressed: false
      })
    },

    push(turnId: string, ev: AgentEvent): FlushResult {
      /**
       * ★ 关掉之后推事件**不许假装成功**。
       *
       * `close()` 之后这个合批器不再有任何去向（定时器清了、`closed` 让 `armFlush`
       * 直接返回），于是推进来的帧会安安静静地留在缓冲里直到进程消失。
       * 返回 `ok: true` 会把「这一帧没人管了」说成「一切正常」——
       * 与 `push-after-end` 是同一类谎，所以用同一种方式报：一条诊断 + 一个失败结果。
       *
       * 真实场景：`will-quit` 关掉合批器之后，某个还没收尾的适配器又吐了几行。
       * 那些帧**确实是丢了**，而丢了就说丢了 —— 那是唯一能让「硬杀走查」
       * 解释自己看到了什么的信息。
       */
      if (closed) {
        opts.onWarn('push-after-close', `合批器已关闭，仍收到事件：${ev.k}`, { turnId })
        return { ok: false, emitted: 0, persisted: 0 }
      }
      const t = turnState(turnId)
      if (t.ended) {
        // 适配器「恰好一次 done」的义务被违反了。不静默吞掉 —— 那意味着
        // 有一批事件我们收下了却没有归宿。
        warn(t, 'push-after-end', `轮次已收尾，仍收到事件：${ev.k}`, { turnId })
        return NOTHING
      }
      const s = sessionState(t.id.sessionId)

      switch (ev.k) {
        case 'session_started':
          // 会话簿记：CLI 自报的 session id 只是留档，帧上没有对应物。
          t.cliSessionId = ev.sessionId
          return NOTHING

        case 'status_changed':
          // ★ **帧上无处可放**（§4.3：`stream:status` 是**轮次**状态，不是 CLI 的内部状态）。
          // 实测里它是 `requesting` 这类东西 —— 丢弃，且**不报**：它是已知流量。
          return NOTHING

        case 'thinking_delta':
          t.thinkingChars += ev.text.length
          pushMergeable(t, s, 'thinking', ev.text)
          return maybeImmediate(turnId)

        case 'thinking_end':
          // 在途标记：上线，**永不落库**（§8.5a：线上 9 项、可持久化 8 项）。
          // 它不是屏障 —— `k` 不同本身就打断了合并。
          pushAtomic(t, { seq: nextSeq(s), k: 'thinking_end' }, null)
          return maybeImmediate(turnId)

        case 'text_delta':
          // ★ 正文由**一个累加器**持有。它与最后一批 `text` 事件是同一份字节的两个去向，
          // 所以必须同源：另拼一遍会造出两个可能分歧的正文，而分歧的表现是
          // 「M7 的上下文里少一段、界面上却有」—— 一个查不出原因的 bug。
          t.textAccum += ev.text
          pushMergeable(t, s, 'text', ev.text)
          return maybeImmediate(turnId)

        case 'tool_start':
          return barrier(
            t,
            [
              {
                frame: {
                  seq: nextSeq(s),
                  k: 'tool_start',
                  id: ev.id,
                  name: ev.name,
                  input: ev.input
                },
                row: {
                  kind: 'tool_start',
                  toolUseId: ev.id,
                  toolName: ev.name,
                  payloadJson: JSON.stringify(ev.input ?? null),
                  now: clock.now()
                }
              }
            ],
            () => {
              // 记下输入，等 `tool_result` 成功时合成 diff。**成功前不记 diff**。
              t.toolInputs.set(ev.id, { name: ev.name, input: ev.input })
            }
          )

        case 'tool_result': {
          const row: PendingRow = {
            kind: 'tool_result',
            toolUseId: ev.id,
            ok: ev.ok,
            // ★ 行里放**全量**，帧上放**截断**的那份。两者说的事情不同：
            // 行回答「到底输出了什么」，帧回答「这一次推送发了多少」。
            textBlob: ev.output,
            truncated: false,
            now: clock.now()
          }
          const cut = byteLength(ev.output) > limit
          const frame: ToolResultFrame = {
            seq: nextSeq(s),
            k: 'tool_result',
            id: ev.id,
            ok: ev.ok,
            output: cut ? sliceUtf8(ev.output, limit) : ev.output,
            ...(cut ? { truncated: true } : {})
          }
          return barrier(t, [{ frame, row }, ...diffBuffers(t, s, ev)])
        }

        case 'usage': {
          t.usage = { costUsd: ev.costUsd ?? null, tokensIn: ev.in, tokensOut: ev.out }
          const frame = usageFrame(t, ev, nextSeq(s))
          pushAtomic(t, frame, {
            kind: 'usage',
            payloadJson: JSON.stringify({
              in: frame.in,
              out: frame.out,
              cacheRead: frame.cacheRead,
              cacheCreation: frame.cacheCreation,
              thinkingTokens: frame.thinkingTokens,
              ...(frame.costUsd !== undefined ? { costUsd: frame.costUsd } : {})
            }),
            now: clock.now()
          })
          return maybeImmediate(turnId)
        }

        case 'error':
          // 失败原因落库：`error` 事件 +（由 runner 算出的）`turn.error_text`。
          // 诊断**不落库**（`EVENT_KINDS` 里没有这一类），所以这条不能只做诊断。
          pushAtomic(
            t,
            { seq: nextSeq(s), k: 'error', code: ev.code, message: ev.message, fatal: ev.fatal },
            {
              kind: 'error',
              payloadJson: JSON.stringify({ code: ev.code, fatal: ev.fatal }),
              textBlob: ev.message,
              now: clock.now()
            }
          )
          return maybeImmediate(turnId)

        case 'done':
          // ★ **只入缓冲，不在这里提交。** 终态帧必须与 `turn.finish` 那一行走
          // **同一个事务**：分成两次写的话，中间崩掉就会留下「事件流到此为止、
          // 而轮次行还写着 running」的一对矛盾行。收尾由 `endTurn` 一次做完 ——
          // 它紧接着就会被调用（runner 拿到的流已经结束了）。
          if (t.donePushed) return NOTHING
          pushDoneRow(t, s, ev.reason)
          // 兜底：万一调用方没有 endTurn，33ms 后这一帧也会落库（终态不停在缓冲里）。
          armFlush()
          return NOTHING
      }
    },

    endTurn(turnId: string, terminal: TerminalWrite): FlushResult {
      const t = turns.get(turnId)
      if (!t || t.ended) return NOTHING

      const s = sessionState(t.id.sessionId)
      // 适配器没给出 `done`（中断阶梯的硬杀路径就是这样）时，由终态写入补一个。
      // `reason` 用 runner 算好的那个 —— 合批器不自己判断这一轮怎么结束的。
      if (!t.donePushed) pushDoneRow(t, s, terminal.reason)

      const frames = commit(turnId, terminal)
      t.ended = true
      if (s.turnId === turnId) s.turnId = null
      // 重的东西到此为止：正文与工具输入都已落库，留着只是内存里的一份历史副本。
      const workspaceId = t.id.workspaceId
      t.buf = []
      t.toolInputs.clear()
      t.textAccum = ''
      t.textWritten = ''

      if (frames === null) return { ok: false, emitted: 0, persisted: 0 }
      const r = emitFrames(turnId, frames)
      // 收尾时把还压着的未读补发一次 —— 否则那个角标要等下一秒才出现。
      if (unreadPending.has(workspaceId)) {
        lastUnreadAt = 0
        drainUnread()
      }
      /**
       * ★ 终态推送**排在这一批帧之后**，顺序是硬的。
       *
       * 它会让渲染层去重取历史、并丢掉这个轮次的缓冲。硬杀那条路径上，
       * `done` 帧正是由上面这次 `pushDoneRow` 补出来的、就在这一批里 ——
       * 先发状态的话，渲染层会先丢掉缓冲、再收到帧，于是**重新建出一个不完整的缓冲**，
       * 把一条已经有完整正文的历史行又盖住了。那是「内容少了一半」的形态。
       *
       * ⚠️ `commit` 返回 `null` 时（落库失败）已经提前 return 了，所以走到这里
       * 一定是事务提交成功的 —— 这正是 §4.5a 规则二要的那个时点。
       */
      opts.emitStatus({
        workspaceId,
        sessionId: t.id.sessionId,
        turnId,
        status: terminal.status,
        reason: terminal.reason
      })
      return r
    },

    resume(sessionId: string, epochIn: string, fromSeq: number): ResumeResult {
      const s = sessionState(sessionId)
      // ★ **纪元检查必须排在最前**，它不与下面两条 `fromSeq` 判断冗余：
      // 重启后的情形是「旧水位线 40，而新进程已经为这个会话分配到了 100」——
      // 只做数值比较的话 `40 < 100`、`retainedFrom = 0`，于是我们会**欢快地**
      // 把 41..100 号帧交回去，而它们属于**另一套编号**。那正是纪元要拦住的那种
      // 「看起来在工作」的错位。
      if (epochIn !== epoch) return { epoch, matched: false, frames: [] }
      if (fromSeq > s.seq) return { epoch, matched: false, frames: [] }
      if (fromSeq < s.retainedFrom) return { epoch, matched: false, frames: [] }
      return { epoch, matched: true, frames: s.frames.filter((f) => f.seq > fromSeq) }
    },

    unread(workspaceId: string): number {
      return unreadCounts.get(workspaceId) ?? 0
    },

    clearUnread(workspaceId: string): void {
      const had = (unreadCounts.get(workspaceId) ?? 0) > 0
      const pending = unreadPending.delete(workspaceId)
      if (!had && !pending) return
      unreadCounts.set(workspaceId, 0)
      // 清零是**立即**的：用户已经在看那个空间了，把 0 压在 1Hz 的下界后面
      // 只会让角标多显示一秒「3」。
      opts.emitUnread({ workspaceId, count: 0 })
    },

    debugState(): unknown {
      return {
        epoch,
        sessions: [...sessions].map(([id, s]) => ({
          sessionId: id,
          seq: s.seq,
          retainedFrom: s.retainedFrom,
          frames: s.frames.length,
          turnId: s.turnId
        })),
        turns: [...turns].map(([id, t]) => ({
          turnId: id,
          buffered: t.buf.length,
          messageId: t.message?.id ?? null,
          ended: t.ended,
          suppressed: t.suppressed,
          warns: Object.fromEntries(t.warns)
        }))
      }
    },

    close(): void {
      closed = true
      clearFlush()
      if (unreadTimer !== null) {
        clock.clearTimeout(unreadTimer)
        unreadTimer = null
      }
      // 同步冲空：不等 33ms 的定时器。**必须在 `store.close()` 之前** —— 否则
      // 一个挂着的定时器会在库关掉之后触发，退出路径上抛一次，尾巴也顺手丢了。
      for (const turnId of [...dirty]) {
        try {
          const frames = commit(turnId, null)
          if (frames) emitFrames(turnId, frames)
        } catch (err) {
          opts.onWarn('close-flush-failed', `退出前刷新失败：${describe(err)}`, { turnId })
        }
      }
    }
  }
}
