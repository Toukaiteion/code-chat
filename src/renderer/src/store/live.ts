/**
 * `live` slice —— 对话与流式渲染的**全部渲染态**（§4.7 三分里的第三份）。
 *
 * ★ 这个文件在 M4 是**故意不建**的（`index.ts` 的文件头记了那次偏差），
 *   它的落地时点就是 M6b：`stream:batch` 有听众的那一刻。
 *
 * ## 四份状态，四个所有者
 *
 * | 这里存的 | 所有者 | 怎么变 |
 * |---|---|---|
 * | `cursor`（纪元 + 每 session 水位线） | **渲染层自己** | 只由 `stream:batch` / `stream:resume` 驱动 |
 * | `buffers[turnId]` | 渲染层自己（写入者是 `src/shared/live/frame-buffer.ts`） | 只由 `stream:batch` 驱动 |
 * | `messages` / `order[workspaceId]` | 主进程 `message-repo`（DB 是事实源） | 这里是**投影**，由 `message:list` 载入 |
 * | `runtime` / `usage` | 主进程 `scheduler` / `turn-repo` | 只读回来，不在这里算 |
 *
 * ★ **没有 `turnStatus`。** `stream:status` 推送本身**不是**一份状态，它是两件事的信号：
 * 1. **折叠**（终态到了 → 丢掉缓冲、重取历史）；
 * 2. `runtime:getState` 的**变更信号**（§3.6 —— 那四条推送里没有 `runtime:changed`，
 *    而状态的切换时刻恰好就是队列深度与槽位占用会变的时刻）。
 * 轮次的状态本身属于 `turn-repo`，渲染层读 `runtime.liveTurns`。
 * 再存一份 `turnStatus` 就是同一个事实有两个来源 —— §4.7 明令禁止的那种。
 *
 * ## ★ 一条贯穿全文件的不变式：**有缓冲才抑制历史行**
 *
 * `frame-buffer.ts` 的文件头论证了「缓冲的正文只来自帧，从不来自历史」。
 * 那条不变式的**界面形态**就是这一句：`<MessageList>` 渲染 `order[workspaceId]` 时，
 * 把「当前有缓冲的轮次」对应的那条历史消息**过滤掉** —— 那个轮次由 `<StreamingRow>`
 * 单独呈现。
 *
 * 于是「重放回来的帧」与「历史行」的重叠**在界面上根本不成立**，不需要任何去重逻辑。
 * 反过来，只要某个轮次没有缓冲（新进程打开一个已经在跑的轮次、或重放被判 `matched:false`），
 * 历史行就照常显示 —— 那是**正确**的降级：`content_text` 就是这一轮到目前为止的正文。
 */
import { api } from '../ipc'
import type { Mention, Message, Turn } from '@shared/entities'
import type { PushOf, ResOf } from '@shared/ipc/contract'
import {
  applyFrames,
  type StreamBatch,
  type TurnBuffer
} from '@shared/live/frame-buffer'
import { bufferFromEvents } from '@shared/live/history'
import { shouldReadEvents } from '@shared/live/timeline'
import {
  applyResume,
  emptyCursor,
  observeBatch,
  planBatch,
  resumePlan,
  type StreamCursor
} from '@shared/live/watermark'
import { toNotice } from './ui'
import type { Slice } from './index'

/** `runtime:getState` 的返回形状。**M4 起寄在 `ui` 下，M6b 搬到这里**（那段注释许诺的时点）。 */
export type RuntimeView = ResOf<'runtime:getState'>
export type WorkspaceUsage = ResOf<'workspace:usage'>
/** `stream:status` 的载荷形状。**从契约派生**，不手抄 —— 手抄的分叉没人会发现。 */
export type StreamStatus = PushOf<'stream:status'>

/** 最近结束的轮次最多记多少个。见 `recentlyFinished`。 */
const RECENT_FINISHED_LIMIT = 64

export interface LiveSlice {
  // ── 空间级聊天流（主进程 DB 是事实源）──
  messages: Record<string, Message>
  /** 空间 id → 该空间的 `message.seq` 升序消息 id 列表。★ 键是**空间**，不是会话。 */
  order: Record<string, string[]>
  /** 载入过的空间。区分「还没载」与「载了但一条都没有」。 */
  loadedWorkspaces: Record<string, boolean>
  /**
   * 「跑完了、但一个字都没产生」的轮次，按**触发它的那条消息 id** 索引。
   *
   * ★ 为什么必须有：`event-batcher` 只在**有事件行**时才惰性建那条 assistant 消息
   * （`if (batch.length > 0) ensureMessage(t)`）。于是一轮**在产出任何东西之前就失败**
   * 的对话（撞预算闸、适配器报错、执行器崩溃）在 `message:list` 里**根本没有行** ——
   * 界面上它完全不存在，用户只看到自己那条消息石沉大海。
   *
   * 按触发消息索引是因为那就是它在时间线上的位置：回答该出现的地方。
   * 用时间戳把两个 seq 轴（`message.seq` 与 `turn.queued_at`）混起来排序是
   * §4.7 明令禁止的事，而「挂在触发它的那条消息后面」不需要比较任何两个轴。
   */
  failuresByTrigger: Record<string, Turn>
  /**
   * 已落定的历史消息 → 它的完整渲染态（含思考 / 工具 / diff），由 `message_event` 行折出来。
   *
   * ★ 这里存的是**折好的缓冲**，不是原始事件行。两个理由：
   * 1. 折叠是 `history.ts` 的活，让组件每次渲染自己折一遍是把纯函数塞进热路径；
   * 2. 折出来的形状**与在途缓冲是同一个类型**（`TurnBuffer`），所以
   *    「历史行」与「流式行」可以由同一套子组件渲染 —— 这正是 `history.ts` 存在的理由。
   *
   * 与 `buffers` 的区别是**生命周期**：`buffers` 由帧驱动、终态即销毁；
   * 这个是只读的历史，载一次就不再变（除非 `message:list` 重载了这条消息）。
   */
  historyBuffers: Record<string, TurnBuffer>
  /**
   * 这条消息的事件**已经试过加载**了 —— 成功或失败都置位。
   *
   * ★ 没有它就必然写出「每渲染一次就重试一次」的循环：坏数据（`file_diff` 少 path、
   * payload 不是合法 JSON）是**持久**的错，重试多少次都是同一个结果，
   * 而每次重试都推一条通知 —— 界面会被同一条错误刷屏。失败也是终点。
   */
  eventsAttempted: Record<string, boolean>

  // ── 流式 ──
  /** turnId → 在途缓冲。写入者只有 `applyBatch` / `resumeWorkspace`。 */
  buffers: Record<string, TurnBuffer>
  /**
   * 当前有缓冲的 turnId，**只在缓冲建立/销毁时变**（不是每个 delta）。
   *
   * ★ 它是给 `<MessageList>` 用来过滤历史行的。做成一个**独立的数组**而不是
   * 让组件去 `Object.keys(s.buffers)`：后者每次 delta 都换一个新数组，
   * §4.7 规则 1（`<MessageList>` 只订阅 `order[...]`、绝不随 30Hz 重渲染）
   * 会当场失效。这个数组的引用只在轮次**开始/结束**时变。
   */
  streamingTurnIds: string[]
  /**
   * 最近到达终态的 turnId（最新在前，有界）。
   *
   * ★ 它挡的是那一类**迟到帧**：一轮结束了、我们按终态丢掉了缓冲，而某批
   * 还在路上的帧随后到达。没有它，`applyFrames` 会**重新建出一个只有尾巴的缓冲**，
   * 把一条正文已经完整的历史行又盖住 —— 盖出来的是半个气泡。
   */
  recentlyFinished: string[]
  /** 纪元 + 每 session 水位线。所有者是渲染层，见 `watermark.ts`。 */
  cursor: StreamCursor

  // ── 主进程报回来的只读值 ──
  /** 进程级运行概要。`null` = 还没读回来（**不是**「零个在跑」）。 */
  runtime: RuntimeView | null
  /** 当前空间的累计用量。`null` = 还没读回来。 */
  usage: WorkspaceUsage | null

  loadRuntime(): Promise<void>
  loadUsage(workspaceId: string): Promise<void>
  loadMessages(workspaceId: string): Promise<void>
  /**
   * 载入一条**历史**消息的完整事件流，折成 `historyBuffers[messageId]`。
   *
   * ★ 调用方可以**无条件地**对每条可见消息调它 —— 该不该折由这一支自己判断
   *   （判据在 `@shared/live/timeline.ts` 的 `shouldReadEvents`，账在这里的
   *   `eventsAttempted`）。把它做成无脑可调，是为了让调用点只是一个 `for` 循环，
   *   而不是第二份判据。
   */
  loadEvents(messageId: string): Promise<void>
  /** 进对话视图要读的全部东西 + 在途重放。切空间时调一次。 */
  openConversation(workspaceId: string): Promise<void>
  /**
   * 把在途的尾巴接上 —— **`stream:resume` 的调用点，全仓只有这一处**。
   *
   * 按 session 逐个来，因为帧 `seq` 是**每 session** 的计数器，而聊天流是**每空间**的
   * （§4.3-2 的三条轴）。一个空间里可能有多个成员同时在跑，各要各的。
   */
  resumeWorkspace(workspaceId: string): Promise<void>
  /** 收到一批实时帧。**高频路径**：同步、零 IPC、零分配（除非真的变了）。 */
  applyBatch(batch: StreamBatch): void
  /** 收到一次状态切换。终态时折叠；任何状态都顺带刷一次运行概要。 */
  applyStatus(p: StreamStatus): void
  /**
   * 发一轮。返回 turnId（失败返回 `null`，错误已进通知）。
   *
   * ★ `mentions` 是**结构化的**（§3.1：运行时永不解析文本）—— 由 Composer 在
   * **输入时**采集（`@` 候选浮层），这里只透传。`contentText` 里仍然留着人名的
   * 字面文本（用户看到的就是他打的那句），两者不互相派生。
   */
  sendTurn(input: {
    workspaceId: string
    memberId: string
    text: string
    mentions?: readonly Mention[]
  }): Promise<string | null>
  /** 停止一轮（只有排队中的能停，§4.3b）。 */
  stopTurn(turnId: string): Promise<boolean>
}

/** 终态集合。与 `TURN_STATUSES` 的划分一致：非 `queued`/`running` 即终态。 */
function isTerminal(status: string): boolean {
  return status !== 'queued' && status !== 'running'
}

/** 有一轮结束了。**放在这里而不是散在下面两处** —— 判据只有这一条。 */
function terminalPatch(turnId: string, prev: readonly string[]): string[] {
  const without = prev.filter((id) => id !== turnId)
  return [turnId, ...without].slice(0, RECENT_FINISHED_LIMIT)
}

export const createLiveSlice: Slice<LiveSlice> = (set, get) => ({
  messages: {},
  order: {},
  loadedWorkspaces: {},
  failuresByTrigger: {},
  historyBuffers: {},
  eventsAttempted: {},
  buffers: {},
  streamingTurnIds: [],
  recentlyFinished: [],
  cursor: emptyCursor(),
  runtime: null,
  usage: null,

  /**
   * 读一次运行概要。**只读、幂等**，可以放心在 effect 里调（StrictMode 跑两遍无害）。
   *
   * 它是 `stream:status` 驱动的（§3.6：那条推送就是本接口的变更信号）。
   */
  async loadRuntime() {
    try {
      set({ runtime: await api.runtime.getState() })
    } catch (err) {
      get().pushNotice(toNotice(err, '读取运行状态'))
    }
  },

  async loadUsage(workspaceId) {
    try {
      set({ usage: await api.workspace.usage({ workspaceId }) })
    } catch (err) {
      get().pushNotice(toNotice(err, '读取累计用量'))
    }
  },

  /**
   * 拉一个空间的历史。**不给 `sessionId`** —— 那正是「整个空间的时间线」这条语义
   * （`handlers/message.ts` 的优先级链最后一条落到 `listRecent(workspaceId)`）。
   *
   * ★ 顺带拉 `turn:list` 并算出 `failuresByTrigger`（见那个字段的说明）。
   * 两个读是**并行**的，但它们描述的是同一时刻的两半，所以一起写进 store。
   */
  async loadMessages(workspaceId) {
    try {
      const [messages, turns] = await Promise.all([
        api.message.list({ workspaceId }),
        api.turn.list({ workspaceId })
      ])
      const byId: Record<string, Message> = { ...get().messages }
      for (const m of messages) byId[m.id] = m

      // ★ 回答已经落库的轮次不算「没有回答」—— 一条轮次可能是失败的，
      //   但它照样产出了半截正文（那一行在 `messages` 里），那种情况由历史行自己交代。
      const answered = new Set(messages.map((m) => m.turnId).filter((id): id is string => id !== null))

      const failures: Record<string, Turn> = { ...get().failuresByTrigger }
      // 先把这个空间旧的清掉：一轮后来产出了正文，就不该再挂着那条失败提示。
      for (const [msgId, t] of Object.entries(failures)) {
        if (t.workspaceId === workspaceId) delete failures[msgId]
      }
      for (const t of turns) {
        if (t.status === 'queued' || t.status === 'running') continue
        if (t.status === 'done' || t.triggerMessageId === null) continue
        if (answered.has(t.id)) continue
        failures[t.triggerMessageId] = t
      }

      set((s) => ({
        messages: byId,
        order: { ...s.order, [workspaceId]: messages.map((m) => m.id) },
        loadedWorkspaces: { ...s.loadedWorkspaces, [workspaceId]: true },
        failuresByTrigger: failures
      }))
    } catch (err) {
      get().pushNotice(toNotice(err, '读取对话历史'))
    }
  },

  /**
   * 载入一条历史消息的完整事件流。**`history.ts` 的唯一调用点。**
   *
   * 三件要写清楚的事：
   *
   * 1. **「该不该读」的判据不在这里**，在 `@shared/live/timeline.ts` 的
   *    `shouldReadEvents`（用户消息 / 在途轮次 / `runtime` 还没读回来 —— 三条的后果
   *    都写在那儿）。这里只管**账**（`eventsAttempted`：已经试过的别再试）。
   *
   * 2. **失败也是终点**（`eventsAttempted`）。坏数据是持久的，重试只会让同一条通知刷屏。
   *    失败后这条消息**退回 `content_text` 渲染** —— 那是 §2.3 的同一个字节的另一个去向，
   *    内容一个字不少，只是少了思考面板与工具时间线。这是正确的降级。
   *
   * 3. **一条都没有事件的消息不留条目。** 空缓冲会让 `<MessageRow>` 换一条渲染路径，
   *    而它本来就有 `content_text` 可显示 —— 没有理由用一个更差的来源去替它。
   */
  async loadEvents(messageId) {
    if (get().eventsAttempted[messageId]) return

    const msg = get().messages[messageId]
    // 不在这个空间已载入的集合里（`order` 与 `messages` 是依次写进 store 的，
    // 中间那一瞬可能不一致）。这不是「不该读」，是「还没到时候」。
    if (msg === undefined) return

    const runtime = get().runtime
    // 三条「不折」的理由与它们各自的后果，全在 `shouldReadEvents` 里。
    const verdict = shouldReadEvents(msg, {
      liveTurnIds: (runtime?.liveTurns ?? []).map((t) => t.id),
      runtimeLoaded: runtime !== null
    })
    if (verdict.kind !== 'read') return

    // 先置位再 await：同一个 messageId 的两个并发调用（StrictMode 下 effect 跑两遍）
    // 会在这里就撞上，而不是各发一次 IPC。
    set((s) => ({ eventsAttempted: { ...s.eventsAttempted, [messageId]: true } }))

    try {
      const events = await api.message.getEvents({ messageId })
      if (events.length === 0) return

      const buf = bufferFromEvents(
        {
          turnId: verdict.turnId,
          // 两个都是可空列，但在这一支里 `turnId` 已经非空 ⇒ 这是一条角色的消息，
          // 那么 `sessionId` 与 `authorMemberId` 必然有值（`message` 表的形状如此）。
          // 仍然写 `?? ''` 是为了**不编**：真出现 null 时留空，界面显示「未知成员」，
          // 比拿会话去反推一个角色 id 诚实（`resumeWorkspace` 那边是同一个立场）。
          sessionId: msg.sessionId ?? '',
          workspaceId: msg.workspaceId,
          actorId: msg.authorMemberId ?? ''
        },
        events
      )
      set((s) => ({ historyBuffers: { ...s.historyBuffers, [messageId]: buf } }))
    } catch (err) {
      // `history.ts` 对坏数据是**抛**的（`file_diff` 少 path、payload 不是合法 JSON）。
      // 在这里收成一条通知 —— 那正是它抛而不是静默吞掉的目的。
      get().pushNotice(toNotice(err, '读取这条消息的完整过程'))
    }
  },

  /**
   * 进一个空间的对话视图：历史 + 用量 + 运行概要，**然后把在途的尾巴接上**。
   *
   * ★ 顺序是硬的：`stream:resume` 要在知道「哪些轮次在跑」之后才能发，
   * 而那个答案来自 `runtime:getState`。反过来的话我们不知道要按哪个 turnId 建缓冲。
   *
   * ★ **只对「已经知道纪元」的 session 重放**（`resumePlan` 返回 `null` 就不发）。
   * 不发/拿不到的情形都退化成「靠历史渲染」，而那是对的：
   * - 新进程还没有纪元 —— 发什么都得到空帧（见 `watermark.ts` 文件头）；
   * - `matched: false` —— 三种成因（纪元不同 / 水位线超前 / 环里已淘汰）塌成同一个响应，
   *   动作也只有一个：丢掉那个 session 的记忆，**不重试**，让历史行显示；
   * - 那一轮已经结束了 —— 它在 `recentlyFinished` 里，历史行会显示它。
   */
  async openConversation(workspaceId) {
    await Promise.all([get().loadMessages(workspaceId), get().loadUsage(workspaceId)])
    await get().loadRuntime()
    await get().resumeWorkspace(workspaceId)
  },

  /**
   * 收到一批实时帧 —— **整个 M6b 里唯一的热路径**。
   *
   * 全程同步：这里每 33ms 被调一次，任何 `await` 都会让帧在微任务队列里排队，
   * 于是界面的滞后随运行时间增长。
   */
  applyBatch(batch) {
    // ① 水位线。★ 实时批次**不按 seq 过滤**：主进程已经决定好发什么了（抑制在合批器里做）。
    //    渲染侧再筛一遍只会在「合并跳号」这类正常情形下把自己筛出空档。
    const { cursor, epochChanged } = observeBatch(get().cursor, batch)

    // ② 迟到帧：这一轮已经结束了，这批帧是它结束前发出的。丢掉。
    //    见 `recentlyFinished` 的说明 —— 收下它们会重建出一个只有尾巴的缓冲。
    if (get().recentlyFinished.includes(batch.turnId)) {
      // ⚠️ 纪元那支**在这里也要清缓冲**：这一批的帧确定不要了，但旧纪元的缓冲同样留不得
      //    （它们的正文是按另一套编号拼的）。只在下面那条路径上清，会漏掉这一支。
      set(epochChanged ? { cursor, buffers: {}, streamingTurnIds: [] } : { cursor })
      return
    }

    const frames = batch.frames

    /**
     * ★★ 纪元变了（含**第一次学到**）时，作废的是**旧缓冲**，而不是**这一批帧**。
     *
     * 这条是 M6b 真机走查抓出来的，第一版在这里写反了：`epochChanged` 时
     * `set({ cursor, buffers: {}, streamingTurnIds: [] })` 顺手把这一批也扔了。
     * 理由写的是「旧缓冲的正文是按上一套编号的帧拼的」—— 但**旧缓冲**与**这一批帧**
     * 是两回事：这一批带的就是**新**纪元（`batch.epoch` 正是刚被学到的那个），
     * 它的帧是干净的，扔它没有任何依据。
     *
     * 代价是实打实的：**进程启动后的第一批帧永远走这一支**（纪元的第一个消息就是学它），
     * 于是每次开应用，那一轮回答的**开头**都会缺一段。走查里量到的形状是
     * 「DOM 45 字 / 帧 66 字」—— 缺的正是模型说的第一句。而它看起来不像出错：
     * 界面显示的是一个**完整的、只是更短的**回答。
     *
     * 收下它为什么安全：新缓冲的 `fromStart` 由 `observeBatch` 现算
     * （`batch.fromSeq <= startSeq + 1`，纪元刚清空过 `turns` 所以 `startSeq` 为 0），
     * 与下面那条「没见到第一帧就不许建缓冲」的护栏是同一条判据 —— 不会漏。
     * 而**旧**缓冲照样一个不留：`base` 取 `{}`，它们连被追加的机会都没有。
     */
    const base = epochChanged ? {} : get().buffers
    const prev = base[batch.turnId] ?? null

    // ★ 三条判断在 `watermark.ts` 的 `planBatch` 里合流，测试钉在那儿。
    //   本函数只负责把它们**执行**出来 —— 「没见到这一轮的第一帧就不许建缓冲」也是其中一条。
    const plan = planBatch(cursor.turns[batch.sessionId], batch.turnId, prev !== null, epochChanged)
    if (!plan.createBuffer) {
      set(epochChanged ? { cursor, buffers: base, streamingTurnIds: [] } : { cursor })
      return
    }
    const next = applyFrames(
      prev,
      {
        turnId: batch.turnId,
        sessionId: batch.sessionId,
        workspaceId: batch.workspaceId,
        actorId: batch.actorId
      },
      frames
    )
    if (next === prev) {
      // 一批看不懂的帧、或全是空 delta。水位线照推（内容确实到过这儿），但不换缓冲引用。
      set(
        epochChanged ? { cursor, buffers: base, streamingTurnIds: Object.keys(base) } : { cursor }
      )
      return
    }

    const buffers = { ...base }
    if (next === null) delete buffers[batch.turnId]
    else buffers[batch.turnId] = next

    set({
      cursor,
      buffers,
      // ★ 只在键集合真的变了时才换这个数组的引用 —— 它是 `<MessageList>` 的订阅源之一，
      //   每个 delta 都换就等于让整张列表以 30Hz 重渲染（§4.7 规则 1 的正题）。
      //   纪元那支必然变了（`base` 是空的，旧键一个都不在），所以它一定走后半句。
      streamingTurnIds:
        (next === null) === (prev === null) ? get().streamingTurnIds : Object.keys(buffers)
    })
  },

  /**
   * 收到一次状态切换。
   *
   * ★ **终态那一支才是「折叠」**：丢掉这一轮的缓冲（历史行随即接管），
   * 重取历史与用量。这正是 §4.7 规则 7 说的那件事，只是它做在**状态推送**上
   * 而不是 `done` 帧上 —— 两者相差 249–377ms（M6a 实测），而库里的那一行
   * 是**后**落定的那一个。正文其实在 `done` 时就已经说完了，早折叠一次会让
   * 界面先闪回一条还没有正文的历史行。
   *
   * ⚠️ 任何状态都刷一次运行概要：那是 §3.6 —— `stream:status` 兼作
   * `runtime:getState` 的变更信号（那四条推送里没有 `runtime:changed`）。
   */
  applyStatus(p) {
    if (!isTerminal(p.status)) {
      // `queued`：用户那条消息刚进库，得让它出现。
      // `running`：什么都不用补 —— 帧马上就来了，而运行概要照刷。
      if (p.status === 'queued') void get().loadMessages(p.workspaceId)
      void get().loadRuntime()
      return
    }

    /*
     * ★ 交接顺序：**先把历史读回来，再丢缓冲。**
     *
     * 反过来（先丢、再异步补历史）会有一个**看得见的空档**：这一轮的 assistant 消息行
     * 是 `event-batcher` 在**第一条事件**到达时才建的，而上一次 `message:list`
     * 比那更早 —— 所以 `order[workspaceId]` 里此刻**还没有它**。
     * 缓冲一丢，那段回答就从界面上**整个消失**，一个 IPC 往返之后再冒出来。
     *
     * 而 `await` 这一下是安全的：`loadMessages` 自己吞掉异常（转成通知），
     * 所以下面那几行一定会执行；期间照进来的帧只会更新一个马上要被丢掉的缓冲。
     */
    void (async () => {
      await get().loadMessages(p.workspaceId)

      const buffers = { ...get().buffers }
      delete buffers[p.turnId]
      set({
        buffers,
        streamingTurnIds: Object.keys(buffers),
        // ⚠️ 放在这里而不是函数开头：`recentlyFinished` 的作用是挡住**迟到的帧**
        //    重建出一个只有尾巴的缓冲，而它必须在缓冲真的消失之后才生效 ——
        //    否则从丢缓冲到置位的这几毫秒里，一批帧能把它重新建起来。
        recentlyFinished: terminalPatch(p.turnId, get().recentlyFinished)
      })

      void get().loadUsage(p.workspaceId)
      void get().loadRuntime()
    })()
  },

  async sendTurn({ workspaceId, memberId, text, mentions }) {
    try {
      const { turnId } = await api.turn.send({
        workspaceId,
        memberId,
        text,
        // 不带 `mentions` 时**不传这个键**（而不是传 `[]`）：schema 里它是可选的，
        // 而「用户没 @ 任何人」与「用户 @ 了一个空列表」在主进程那边是同一条路，
        // 少一个字段就少一个能被填错的地方。
        ...(mentions && mentions.length > 0 ? { mentions: [...mentions] } : {})
      })
      // 用户那条消息与新轮次已经在库里了。刷新一次让它们**立刻**出现，
      // 而不是等 `queued` 那条推送绕一圈回来（那条也会来，但会晚一个 IPC 往返）。
      void get().loadMessages(workspaceId)
      void get().loadRuntime()
      return turnId
    } catch (err) {
      get().pushNotice(toNotice(err, '发送消息'))
      return null
    }
  },

  async stopTurn(turnId) {
    try {
      await api.turn.stop({ turnId })
      // 终态由 `stream:status` 推回来（`handlers/turn.ts` 里那个第四写入点）。
      return true
    } catch (err) {
      get().pushNotice(toNotice(err, '停止轮次'))
      return false
    }
  },

  async resumeWorkspace(workspaceId) {
    const live = get().runtime?.liveTurns ?? []
    /** 一个 session 至多一个在跑的轮次（§4.5a 规则一），所以这个映射是良定义的。 */
    const turnOfSession = new Map<string, Turn>()
    for (const t of live) if (t.workspaceId === workspaceId) turnOfSession.set(t.sessionId, t)
    if (turnOfSession.size === 0) return

    for (const [sessionId, turn] of turnOfSession) {
      // ★ `hasBuffer` 决定这次问的是**整轮**还是**尾巴**，见 `resumePlan` 的说明：
      //   - 已经有这一轮的缓冲（看着它跑、中途切走）→ 只补尾巴，否则会把已应用的帧折两遍；
      //   - 没有缓冲（切回来时它已经跑了一会儿）→ 要**整轮**，因为缓冲必须从第一帧起。
      //     ⚠️ 这一条是 M6b 落地时改的：第一版一律问尾巴，结果切回来只看到后半段回答，
      //        而那个半截缓冲还盖住了完整的历史行。
      const plan = resumePlan(get().cursor, sessionId, get().buffers[turn.id] !== undefined)
      // 还没有纪元 → **不发**（发什么都是空帧）。见 `watermark.ts` 文件头。
      if (plan === null) continue

      let res: ResOf<'stream:resume'>
      try {
        res = await api.stream.resume({ sessionId, ...plan })
      } catch (err) {
        get().pushNotice(toNotice(err, '续接在途的流'))
        continue
      }

      const { cursor, accepted } = applyResume(get().cursor, sessionId, res)

      // ★ 在这两行之间它可能已经结束了（`stream:status` 是**不抑制**的，所以必然会到）。
      //   那就不要把缓冲建起来 —— 建了就会盖住一条正文已经完整的历史行。
      if (get().recentlyFinished.includes(turn.id)) {
        set({ cursor })
        continue
      }

      if (!accepted) {
        // `matched:false` 的三种成因在主进程侧就塌成同一个响应，渲染层的动作三者一样：
        // 丢水位线（`applyResume` 已做）、丢掉缓冲、**不重试**。
        // 重跑历史之所以是对的：成因之一是纪元变了，成因之三是确实有一段帧被丢掉了
        // —— 两种都只有历史接口能补回来。
        const buffers = { ...get().buffers }
        delete buffers[turn.id]
        set({ cursor, buffers, streamingTurnIds: Object.keys(buffers) })
        continue
      }

      const prev = get().buffers[turn.id] ?? null
      const next = applyFrames(
        prev,
        {
          turnId: turn.id,
          sessionId,
          workspaceId,
          // ★ 不知道就留空串：`actorId` 只用来查头像与配色，而两个都查不到时
          //   界面显示的是「未知成员」—— 那是对的。拿会话去反推一个角色 id 才是编。
          actorId: ''
        },
        res.frames
      )
      if (next === null) {
        // 重放回来一帧都没有：那是「我离开期间它没产出任何东西」，一个正常情形。
        // **不建空缓冲**（它会把历史行藏起来）。
        set({ cursor })
        continue
      }
      const buffers = { ...get().buffers, [turn.id]: next }
      set({ cursor, buffers, streamingTurnIds: Object.keys(buffers) })
    }
  }
})
