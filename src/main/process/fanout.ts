import type { Mention, Message, MessageEvent, Session, Turn, WorkspaceMember } from '../../shared/entities.ts'
import type { EventKind } from '../../shared/entities.ts'
import type { AppendMessageInput } from '../persist/repositories/message-repo.ts'
import type { CreateTurnInput } from '../persist/repositories/turn-repo.ts'
import type { StatusPayload } from './event-batcher.ts'
import type { PushOf } from '../../shared/ipc/contract.ts'
import {
  chainOf,
  dedupeKeyOf,
  fanoutOf,
  hopDepthOf,
  pingPongOf,
  relayTextOf,
  resolveMentions,
  stripMentionsBlock,
  USER_INITIATED_HOP_DEPTH,
  WORK_EVENT_KINDS,
  type ChainHop,
  type ChainTurn,
  type FanoutNote,
  type QueuedTailEntry,
  type TurnFinishedInfo
} from '../domain/mention-service.ts'
import { sha256Hex } from '../infra/text-file.ts'

/**
 * `@` 派发的**执行** —— 判决在 `domain/mention-service.ts`，这里只负责落地。
 *
 * ## 它管的是「一轮结束之后」（§5.5）
 *
 * `@` 出现在 **agent 的回复里**，所以扇出只能发生在**轮次结束时**，
 * 而不是 `turn:send` 时。落点是 `turn-runner` 收尾处注入的回调
 * `onTurnFinished(turn, info)`，且**必须在 `batcher.endTurn` 之后** ——
 * `endTurn` 是提交终态的那个事务，扇出要在库干净之后读它（读的就是刚提交的东西）。
 *
 * 用户自己 `@` 的那条路（Composer 采集的结构化 mention）在 `turn:send` 时就要派，
 * 所以另有一个入口 `dispatchUserMentions()`。**两条路共用同一套验证与去重**
 * （`fanoutOf` / `resolveMentions`），只是失败语义不同（见 `mentionProblemOf`）。
 *
 * ## §4.5a 规则一：派发只经过 `dispatch`，取消只经过 `cancelQueued`
 *
 * 本文件**没有**自己的调度器、**没有** `cancelChain`。两个原语都是注入进来的，
 * 而它们的实现只可能是 `runtime.ts` 里那两个闭包 —— 于是「谁有权把一个轮次送进管道」
 * 这件事仍然只有一个答案。**组合是允许的、新增原语是不允许的。**
 *
 * ## ★ 「强制终止」不杀进程（§5.5）
 *
 * 终止 = ① 本轮不建新轮次（扇出被取消）+ ② 链上仍 `queued` 的跳被取消。
 * 正在跑的那一轮**不动** —— 它的产物是合法的，只是它之后不该再有。
 * 库里那几笔取消的写法与顺序**照抄 `turn:stop`**：
 *
 * ```
 * 先 markCancelled（库，包在一个事务里）→ 再 cancelQueued（内存队列）→ 再 emitStatus
 * ```
 *
 * 那个顺序在 `handlers/turn.ts` 里有逐字论证（`stream:status` 发的是「两件事都成立」
 * 之后的事实），**别改**。`cancelQueued` 只动内存队列，所以库那几笔要自己包 `store.tx()`。
 *
 * ## 它不 import electron、不 import `node:sqlite`
 *
 * 持久化面是注入的窄口，`cwdFor` 也是注入的（`cwd` 是 `NOT NULL`，派给别人的轮次
 * 也要有 cwd，而那个值必须按**对方**的三级兜底算）。
 * ⇒ `test/process/fanout.test.ts` 能用真库 + 真调度器在裸 Node 下跑完这套。
 */

/** 链判据往回看多少个轮次。见下面 `CHAIN_TAIL_LIMIT` 的两条理由。 */
export const CHAIN_TAIL_LIMIT = 32

/** 编排需要的**最小**持久化面。 */
export interface FanoutStore {
  tx<T>(fn: () => T): T
  turn: {
    get(id: string): Turn | null
    listLive(): Turn[]
    listRecentByQueuedAt(workspaceId: string, limit: number): Turn[]
    create(input: CreateTurnInput): Turn
    markCancelled(id: string, now: number): Turn | null
  }
  message: {
    get(id: string): Message | null
    append(input: AppendMessageInput): Message
    listByTurn(turnId: string): Message[]
    listEventsByKind(messageId: string, kind: EventKind): MessageEvent[]
  }
  member: {
    get(id: string): WorkspaceMember | null
    listByWorkspace(workspaceId: string): WorkspaceMember[]
  }
  session: {
    get(id: string): Session | null
    getByMember(memberId: string): Session | null
  }
}

export interface UserMentionInput {
  workspaceId: string
  /** 说话的那个人（用户以它的身份发言）。它不能 @ 自己。 */
  authorMemberId: string
  text: string
  mentions: readonly Mention[]
}

export interface FanoutOptions {
  store: FanoutStore
  /** 运行时自己的 `cwdFor` —— 三级兜底按**被派发方**算，不是按派发方。 */
  cwdFor(workspaceId: string, memberId: string): { cwd: string }
  dispatch(turn: Turn): void
  cancelQueued(turnId: string): void
  emitStatus(payload: StatusPayload): void
  emitNotice(notice: PushOf<'app:notice'>): void
  now(): number
  newId(): string
  onWarn(tag: string, message: string, detail?: unknown): void
}

export interface Fanout {
  /** 一轮结束时调用（**必须在 `batcher.endTurn` 之后**）。 */
  onTurnFinished(turn: Turn, info: TurnFinishedInfo): void
  /** 用户结构化 `@` 的派发（`turn:send` 那个事务提交之后）。 */
  dispatchUserMentions(input: UserMentionInput): void
}

export function createFanout(opts: FanoutOptions): Fanout {
  const store = opts.store

  function warn(tag: string, message: string, detail?: unknown): void {
    opts.onWarn(`fanout:${tag}`, message, detail)
  }

  /** 一跳干过活没有。**判据只有 `WORK_EVENT_KINDS` 一处**（见 `mention-service`）。 */
  function hadWorkOf(turnId: string): boolean {
    for (const m of store.message.listByTurn(turnId)) {
      for (const kind of WORK_EVENT_KINDS) {
        if (store.message.listEventsByKind(m.id, kind).length > 0) return true
      }
    }
    return false
  }

  /**
   * 判链。**起点是刚结束的这一跳，不是「最近的那一条」** ——
   * 并发下会有轮次乱序收尾（先入队的后结束），按「最近一条」会把链的尾巴错接到
   * 另一个会话的轮次上，而那种错**不会报错**。
   */
  function chainTailOf(turn: Turn): ChainTurn[] {
    const recent = store.turn.listRecentByQueuedAt(turn.workspaceId, CHAIN_TAIL_LIMIT)
    const idx = recent.findIndex((t) => t.id === turn.id)
    if (idx < 0) {
      // 往回看 32 条都看不到它 —— 说明这个空间的轮次多得超出了窗口。
      // 按「这一跳单独成链」处理（判不出空转 ⇒ 不终止），并如实报。
      warn('chain-tail-missing', `轮次 ${turn.id} 不在最近 ${CHAIN_TAIL_LIMIT} 条之内，这一跳按单独成链处理`, {
        turnId: turn.id
      })
      return [{ turnId: turn.id, hopDepth: turn.hopDepth, status: turn.status }]
    }
    return chainOf(
      recent.slice(0, idx + 1).map((t) => ({ turnId: t.id, hopDepth: t.hopDepth, status: t.status }))
    )
  }

  /** 链上每一跳的 `{hopDepth, hadWork}` —— 刚结束那一跳用传进来的值，更早的回去查。 */
  function hopsOf(chain: readonly ChainTurn[], info: TurnFinishedInfo | null, turnId: string): ChainHop[] {
    return chain.map((h) => ({
      turnId: h.turnId,
      hopDepth: h.hopDepth,
      hadWork: h.turnId === turnId && info ? info.hadWork : hadWorkOf(h.turnId)
    }))
  }

  /**
   * 去重键里那个「内容哈希」到底哈希什么：**要写给对方的正文**，不是派发方的原文。
   *
   * ★ 这一条不对齐就会得到一个**永远算不中**的去重（它不报错，只是从不生效）。
   * `queuedTailOf` 哈希的是**库里那条触发消息的正文**，所以两边必须是同一个东西 ——
   * 而那条正文就是 `relayTextOf({kind: 'to'})` 的产物。`kind` 固定成 `to`
   * 是因为去重只对 `to` 有意义（`cc` 不建轮次）；所有 `to` 目标的正文逐字相同
   * （头部那句话不点目标的名字，每个收件人读自己的那一份）。
   */
  function relayHashOf(input: {
    authorName: string
    body: string
    via: 'reply' | 'message'
    stripped: boolean
  }): string {
    return sha256Hex(relayTextOf({ ...input, kind: 'to' }))
  }

  /**
   * 「尚未执行的尾部」= `status === 'queued'` 的那些（§4.5b 第 2 条）。
   * `running` 的不算 —— 它已经执行过了，同一个成员可以再次被派。
   */
  function queuedTailOf(workspaceId: string): QueuedTailEntry[] {
    const entries: QueuedTailEntry[] = []
    for (const t of store.turn.listLive()) {
      if (t.status !== 'queued' || t.workspaceId !== workspaceId) continue
      const session = store.session.get(t.sessionId)
      const trigger = t.triggerMessageId ? store.message.get(t.triggerMessageId) : null
      if (!session || trigger?.contentText == null) {
        // 算不出键 ⇒ 这一条不进基准。后果是「少判一次重复」（多派一轮），
        // 而不是「误判成重复」（少派一轮）—— 前者看得见，后者是安静的。
        warn('dedupe-basis-skipped', `排队中的轮次 ${t.id} 算不出内容哈希，没有进去重基准`, {
          turnId: t.id
        })
        continue
      }
      const key = sha256Hex(trigger.contentText)
      entries.push({ memberId: session.memberId, dedupeKey: dedupeKeyOf(session.memberId, key) })
    }
    return entries
  }

  /**
   * 链上**仍然排队**的跳 —— 终止时要取消的就是它们。
   *
   * ★ 判据不是「同空间所有 `hopDepth > 0` 的排队跳」，而是**「能被链上某一跳认领」**：
   * 候选项的 `hopDepth` 必须恰好等于链上某一跳 + 1，**且**它的触发消息的作者
   * 就是那一跳的成员（转述消息的作者 = 派发方，这是全仓库唯一能把「这条排队跳是谁派的」
   * 从库里读出来的线索）。少了后半条，同空间另一条并发 @ 链的排队跳会被一起取消 ——
   * 那是**错杀**，而 §4.5b 的口径是「宁可漏杀，不可错杀」。
   *
   * 用户的直接发起（`hopDepth === 0`）**永远不在此列**：他不是链的一部分，
   * 取消他那一轮等于替他做了决定。
   *
   * **已知仍会误伤的一种情形**（写下来，不藏）：另一条链的派发方**恰好**是链上
   * 某一跳的同一个成员，且深度也对得上时，它会被认领 —— 这需要两个巧合同时成立。
   */
  function queuedChainHopsOf(turn: Turn, chain: readonly ChainTurn[]): Turn[] {
    const out: Turn[] = []
    for (const t of store.turn.listLive()) {
      if (t.status !== 'queued' || t.workspaceId !== turn.workspaceId || t.hopDepth < 1) continue
      const parent = chain.find((h) => h.hopDepth === t.hopDepth - 1)
      if (!parent) continue
      // `ChainTurn` 上刻意只有三样（判链只需那三样），要认领才回头读一次轨道。
      const parentTurn = store.turn.get(parent.turnId)
      const parentSession = parentTurn ? store.session.get(parentTurn.sessionId) : null
      const trigger = t.triggerMessageId ? store.message.get(t.triggerMessageId) : null
      if (!parentSession || !trigger || trigger.authorMemberId !== parentSession.memberId) continue
      out.push(t)
    }
    return out
  }

  /** ② 取消：**照抄 `turn:stop` 的三步**（库 → 内存队列 → 推送）。 */
  function cancelTurns(turns: readonly Turn[]): void {
    if (turns.length === 0) return
    const now = opts.now()
    const cancelled = store.tx(() =>
      turns.map((t) => store.turn.markCancelled(t.id, now)).filter((t): t is Turn => t !== null)
    )
    for (const t of cancelled) opts.cancelQueued(t.id)
    for (const t of cancelled) {
      opts.emitStatus({
        workspaceId: t.workspaceId,
        sessionId: t.sessionId,
        turnId: t.id,
        status: 'cancelled',
        // 与 `turn:stop` 逐字同因：`markCancelled` 只写 status / ended_at，
        // 不动 `terminal_reason`，填一个值就是编。
        reason: t.terminalReason
      })
    }
  }

  /**
   * 一条**持久的** system 事件，落进链尾那一跳的会话。
   *
   * ★ 落进会话（不是空间流 `session_id = NULL`）：乒乓是链的局部现象，
   * 写进空间流会让别的成员也看到。
   * ★ **跨会话的链没有「链所在的会话」**（这一条修正了 §5.3 的措辞，理由同
   * `mention-service` 的文件头）：写进**刚结束的那一跳的会话** —— 下一轮会再开口的
   * 正是那里。
   * ★ **正文里不许出现跳数数字**（`Turn.hopDepth` 逐字：「绝不进入提示词上下文」）。
   */
  function appendSystemEvent(turn: Turn, text: string): void {
    store.message.append({
      id: opts.newId(),
      workspaceId: turn.workspaceId,
      sessionId: turn.sessionId,
      role: 'system',
      // 刻意**不带 `turnId`**：这条行不属于那一轮的产物（它是事后追加的），
      // 带上的话 `listByTurn` 就会把它算成那一轮说的话。
      contentText: text,
      now: opts.now()
    })
  }

  function reportNotes(notes: readonly FanoutNote[], turnId: string | null): void {
    for (const n of notes) {
      if (n.level === 'warn') {
        // 用户看得见的那一类（「你说的那个人已停用，没派出去」）走 notice；
        // 全部 notes 都进日志 —— 归档里能按 tag 检索。
        opts.emitNotice({ level: 'warning', message: n.message, detail: { tag: n.tag, turnId, ...(n.detail ? { detail: n.detail } : {}) } })
      }
      warn(n.tag, n.message, { turnId, level: n.level, detail: n.detail })
    }
  }

  /**
   * 把一条转述消息 + 一轮（`to`）写进对方的会话。
   *
   * 为什么是**转述**：各成员的会话是分开的，B 看不到 A 的回复。
   * 转述的是 A 的**原话**（不是摘要、不是改述），理由见 `mention-service.relayTextOf`。
   */
  function dispatchTargets(input: {
    workspaceId: string
    authorMemberId: string
    authorName: string
    body: string
    via: 'reply' | 'message'
    stripped: boolean
    targets: ReturnType<typeof fanoutOf>['targets']
    parentHopDepth: number
    /** 来源轮次，只进日志/note 的 detail。 */
    fromTurnId: string | null
  }): void {
    const now = opts.now()
    const created: Turn[] = []

    store.tx(() => {
      for (const target of input.targets) {
        const session = store.session.getByMember(target.memberId)
        if (!session) {
          // 会话与成员同生（`member:create` 的事务），所以这一条查不到就是库不一致。
          // 不抛：抛出去会把 **agent 已经做完的那一轮** 一起变成失败。
          warn('target-session-missing', `「${target.displayName}」没有会话，这一条没有派出去`, {
            memberId: target.memberId
          })
          continue
        }
        const text = relayTextOf({
          authorName: input.authorName,
          kind: target.kind,
          body: input.body,
          via: input.via,
          stripped: input.stripped
        })
        const messageId = opts.newId()
        store.message.append({
          id: messageId,
          workspaceId: input.workspaceId,
          sessionId: session.id,
          role: 'user',
          authorMemberId: input.authorMemberId,
          contentText: text,
          mentions: [{ memberId: target.memberId, kind: target.kind }],
          now
        })
        // ★ `cc` 到此为止：一条历史行，**不建轮次**（§5.4）。被抄送者下一次开口时
        //   会看到它 —— 那是「有意义且成本极低」的形态，而不是把它记在 schema 里不做。
        if (target.kind === 'cc') continue

        created.push(
          store.turn.create({
            id: opts.newId(),
            sessionId: session.id,
            workspaceId: input.workspaceId,
            triggerMessageId: messageId,
            // ★ 跳数在 `create` 之前算好（§3.3：`hop_depth` 没有 updater）。
            hopDepth: hopDepthOf(input.parentHopDepth),
            cwd: opts.cwdFor(input.workspaceId, target.memberId).cwd,
            now
          })
        )
      }
    })

    // ★ **事务提交之后**才派发（调度器会立刻回库里读那一行）。
    for (const turn of created) opts.dispatch(turn)
  }

  function onTurnFinished(turn: Turn, info: TurnFinishedInfo): void {
    const session = store.session.get(turn.sessionId)
    const member = session ? store.member.get(session.memberId) : null
    if (!session || !member) {
      warn('actor-missing', `轮次 ${turn.id} 的会话/成员查不到，本轮不派发`, { turnId: turn.id })
      return
    }

    // ── ① 乒乓：判定点在**扇出之前**（§5.3）──
    const chain = chainTailOf(turn)
    const hops = hopsOf(chain, info, turn.id)
    const verdict = pingPongOf(hops)

    if (verdict.action === 'terminate') {
      // ★ 这里**刻意不调 `fanoutOf`**：终止的含义就是「本轮不建新轮次」。
      const queueHead = queuedChainHopsOf(turn, chain)
      cancelTurns(queueHead)
      appendSystemEvent(
        turn,
        `【系统】这条协作链连续几跳都没有任何实际动作（既没有工具调用，也没有文件改动），已被自动终止 —— ` +
          `本轮的派发已取消，还在排队的同链条轮次也已取消。${verdict.message}。`
      )
      opts.emitNotice({
        level: 'warning',
        message: `协作链已被强制终止：连续多跳没有实际动作，${queueHead.length} 个排队中的轮次已取消`,
        detail: { turnId: turn.id, emptyHops: verdict.emptyHops, cancelled: queueHead.map((t) => t.id) }
      })
      warn('ping-pong-terminate', verdict.message, {
        turnId: turn.id,
        emptyHops: verdict.emptyHops,
        chain: hops.map((h) => ({ turnId: h.turnId, hopDepth: h.hopDepth, hadWork: h.hadWork })),
        cancelled: queueHead.map((t) => t.id)
      })
      return
    }

    if (verdict.action === 'warn') {
      // 2 跳空转：**警告 + 落库**，但**照常派发**（§4.5b：2 次只是警告）。
      appendSystemEvent(
        turn,
        `【系统】这条协作链已经连续几跳没有任何实际动作（只有来回发言）。` +
          `再往后仍然如此的话，它会被自动终止。`
      )
      opts.emitNotice({
        level: 'warning',
        message: '协作链已经连续几跳没有实际动作（只有来回发言），再这样下去会被自动终止',
        detail: { turnId: turn.id, emptyHops: verdict.emptyHops }
      })
      warn('ping-pong-warn', verdict.message, {
        turnId: turn.id,
        emptyHops: verdict.emptyHops,
        chain: hops.map((h) => ({ turnId: h.turnId, hopDepth: h.hopDepth, hadWork: h.hadWork }))
      })
    }

    // ── ② 目标：回复里 @ 了谁 ──
    const members = store.member.listByWorkspace(turn.workspaceId)
    const resolved = resolveMentions({
      names: info.mentions.names,
      selfMemberId: member.id,
      members
    })
    if (info.mentions.status === 'malformed') {
      warn('mentions-malformed', `回复里的 <mentions> 标签不完整，这一轮不派发任何成员`, {
        turnId: turn.id
      })
    }
    if (info.mentions.status === 'empty') {
      warn('mentions-empty', `回复里写了空的 <mentions> 块，没有派出任何人`, { turnId: turn.id })
    }
    if (resolved.mentions.length === 0) {
      // 绝大多数轮次走到这里就结束了：**没有标记块 = 没有派发**（§5.4 的失败形态）。
      reportNotes(resolved.notes, turn.id)
      return
    }

    // ── ③ 去重 + 组装（第 2 条）──
    const stripped = stripMentionsBlock(info.replyText)
    const relayStripped = info.replyText !== stripped
    const plan = fanoutOf({
      selfMemberId: member.id,
      members,
      wanted: resolved.mentions,
      queuedTail: queuedTailOf(turn.workspaceId),
      contentHash: relayHashOf({
        authorName: member.displayName,
        body: stripped,
        via: 'reply',
        stripped: relayStripped
      })
    })
    reportNotes([...resolved.notes, ...plan.notes], turn.id)
    if (plan.targets.length === 0) return

    dispatchTargets({
      workspaceId: turn.workspaceId,
      authorMemberId: member.id,
      authorName: member.displayName,
      body: stripped,
      via: 'reply',
      stripped: relayStripped,
      targets: plan.targets,
      parentHopDepth: turn.hopDepth,
      fromTurnId: turn.id
    })
  }

  /**
   * 用户那条路：`turn:send` 里的结构化 mention。
   *
   * 与上面**共用** `fanoutOf`（验证 + 去重），但**不判链**：
   * 乒乓管的是 agent 之间的链，而用户的主动发起本身就是链的打断点
   * （`hopDepth === 0`）—— 在它上面再判一次只会把「上一段链」的判决重放一遍，
   * 那件事已经由那条链自己的每一跳判过了。**验证失败的处理也由调用方负责**
   * （`handlers/turn.ts` 用 `mentionProblemOf` 直接抛 `E_INVALID_PAYLOAD`），
   * 所以走到这里的 mention 已经全过了一遍 —— 这里再查一次是因为
   * `fanoutOf` 必须能单独被调用（单测直接调它）。
   */
  function dispatchUserMentions(input: UserMentionInput): void {
    const author = store.member.get(input.authorMemberId)
    if (!author) {
      warn('author-missing', `找不到发话的成员 ${input.authorMemberId}，用户 @ 没有派发`, {
        memberId: input.authorMemberId
      })
      return
    }
    const members = store.member.listByWorkspace(input.workspaceId)
    const plan = fanoutOf({
      selfMemberId: author.id,
      members,
      wanted: input.mentions,
      queuedTail: queuedTailOf(input.workspaceId),
      contentHash: relayHashOf({
        authorName: author.displayName,
        body: input.text,
        via: 'message',
        stripped: false
      })
    })
    reportNotes(plan.notes, null)
    if (plan.targets.length === 0) return
    dispatchTargets({
      workspaceId: input.workspaceId,
      authorMemberId: author.id,
      authorName: author.displayName,
      body: input.text,
      via: 'message',
      stripped: false,
      targets: plan.targets,
      // 用户的直接发起就是链的根（0），所以派给它 @ 的人 = 1（§3.3）。
      parentHopDepth: USER_INITIATED_HOP_DEPTH,
      fromTurnId: null
    })
  }

  return { onTurnFinished, dispatchUserMentions }
}
