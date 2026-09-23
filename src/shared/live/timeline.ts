/**
 * 空间时间线的**排法** —— 「哪些格子、按什么顺序」（纯逻辑，裸 Node 可测）。
 *
 * 它从 `<MessageList>` 里搬出来的理由与 `frame-buffer.ts` 一样：这是**判断**，
 * 不是渲染。留在组件里的话，下面那条不变式就只能靠「点开应用看一眼」来验证。
 *
 * ## ★ 一条不变式：**有缓冲才抑制历史行**
 *
 * 一个轮次只要有缓冲，它的历史消息就**不进列表** —— 那个轮次由 `<StreamingRow>`
 * 单独呈现。这是 `frame-buffer.ts` 那条「缓冲的正文只来自帧，从不来自历史」在
 * 界面上的形态，也是「重放回来的帧」与「历史行」永远不会同时出现的**全部**机制：
 * 不需要任何去重逻辑。
 *
 * 反向的那一半同样重要：**没有缓冲就照常显示历史行**。那是**正确**的降级 ——
 * `content_text` 就是这一轮到目前为止的正文（§2.3：它与帧是同一个字节的两个去向）。
 * 「新进程打开一个已经在跑的轮次」走的正是这一支（见 `watermark.ts` 的 `fromStart`）。
 *
 * ## 三种格子的排法
 *
 * 1. **历史消息**：`order[workspaceId]` 的顺序（`message.seq` 升序）。空间级，
 *    用户消息与各成员的回复交错在同一条线里（§4.2 那张 `UNIQUE (workspace_id, seq)`）。
 * 2. **失败轮次**：紧跟在**触发它的那条消息**后面。
 *    ★ 不用时间戳把它插进序列里 —— 那要比较 `message.seq` 与 `turn.queued_at` 两个
 *    不同的轴（§4.7 明令禁止）。挂在触发消息后面**不需要比较任何两个轴**。
 * 3. **在途轮次**：一律排在**最后**。
 *
 * 在途轮次排在最后是一个**已知的粗略**：多个成员同时跑时，它们之间的先后是按
 * 「谁先被建起缓冲」定的，而不是任何一个数据库里的序号（此刻它们都还没有序号）。
 * 等它们落定，交换就会按 `message.seq` 归位。
 */
import type { Message } from '../entities.ts'

/** 列表里的一格。**顺序就是渲染顺序** —— 不在渲染时再排一次。 */
export type TimelineEntry =
  | { kind: 'message'; id: string }
  | { kind: 'streaming'; turnId: string }
  | { kind: 'failed'; triggerMessageId: string }

export interface TimelineInput {
  /** 该空间的 `message.seq` 升序消息 id。**缺省时传空数组**，不要传 `undefined`。 */
  order: readonly string[]
  messages: Readonly<Record<string, Message>>
  /** 当前**有缓冲**的轮次（`live.ts` 的 `streamingTurnIds`）。 */
  streamingTurnIds: readonly string[]
  /** **按触发消息 id 索引**的失败轮次（`live.ts` 的 `failuresByTrigger`）。 */
  failuresByTrigger: Readonly<Record<string, unknown>>
}

export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const { order, messages, streamingTurnIds, failuresByTrigger } = input
  const entries: TimelineEntry[] = []

  // `streamingTurnIds` 是个数组且通常只有个位数，`includes` 比建一个 Set 便宜。
  for (const id of order) {
    const m: Message | undefined = messages[id]
    // `order` 与 `messages` 是两个独立的写入口（都来自 `loadMessages`，
    // 但它俩是依次写进 store 的），所以这里要容忍短暂的不一致。
    if (m === undefined) continue
    // ★ 有缓冲 → 它由 `<StreamingRow>` 呈现，这一行让开。
    if (m.turnId !== null && streamingTurnIds.includes(m.turnId)) continue
    entries.push({ kind: 'message', id })
    // 「跑了但一个字都没产出」的轮次挂在它触发的那条消息后面。
    if (failuresByTrigger[id] !== undefined) {
      entries.push({ kind: 'failed', triggerMessageId: id })
    }
  }

  for (const turnId of streamingTurnIds) entries.push({ kind: 'streaming', turnId })

  return entries
}

/**
 * 一条历史消息**该不该去读它的事件行**（`live.ts` 的 `loadEvents` 的判据部分）。
 *
 * 搬到这里而不是留在 store 里，理由与 `buildTimeline` 一样：这是**判断**。
 * 它回答三件「不读」的事，每一条的后果都不是「少一点东西」而是**看到假的东西**：
 *
 * - **用户消息**（`turnId === null`）没有事件行。读了只会折出一个空缓冲，
 *   而空缓冲会把 `content_text` 盖掉 —— 用户那句话在界面上变成一片空白。
 * - **在途轮次**的事件行每 33ms 就多几行，此刻折出来的是一份**冻结的残缺快照**，
 *   而它随后会盖住**随流增长**的 `content_text`：字幕卡在半句话上，底下模型还在说。
 * - **`runtime` 没读回来**时我们无法断定有没有在跑的轮次，所以按「等会儿再来」处理：
 *   多等一个 IPC 往返，换掉一整个卡住的正文。
 *
 * ⚠️ 后两条是「**等会儿**再来」而不是「这辈子别再来」—— 调用方据此**不置位**
 *    `eventsAttempted`（那个置位是永久性的，见 `live.ts` 那个字段）。
 *
 * 返回值带上 `turnId` 只是为了让调用方省掉一次类型收窄（那里 `msg` 还只是
 * `Message | undefined`）。判据本身仍然全在**这一个函数**里。
 */
export type EventsReadVerdict =
  | { kind: 'read'; turnId: string }
  | { kind: 'skip'; reason: 'user-message' | 'live-turn' | 'unknown-runtime' }

export function shouldReadEvents(
  msg: Pick<Message, 'turnId'>,
  input: {
    /** 还在跑的轮次 id（`runtime.liveTurns`）。 */
    liveTurnIds: readonly string[]
    /** `runtime` **读回来了吗**。没读回来时我们无法断定，见上。 */
    runtimeLoaded: boolean
  }
): EventsReadVerdict {
  if (msg.turnId === null) return { kind: 'skip', reason: 'user-message' }
  if (!input.runtimeLoaded) return { kind: 'skip', reason: 'unknown-runtime' }
  if (input.liveTurnIds.includes(msg.turnId)) return { kind: 'skip', reason: 'live-turn' }
  return { kind: 'read', turnId: msg.turnId }
}
