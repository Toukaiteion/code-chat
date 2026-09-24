import type { Actor, Message, WorkspaceMember, Session, Turn } from '../../shared/entities.ts'
import type { AgentDiagnostic } from '../adapters/agent-adapter.ts'
import type { AppendMessageInput } from '../persist/repositories/message-repo.ts'
import type { PushOf } from '../../shared/ipc/contract.ts'
import { historyMessageOf } from '../domain/context-builder.ts'
import {
  appendToRollingSummary,
  compactFactsFromDiagnostics,
  interpretCompactResult,
  resolveCompactLimits,
  shouldCompact,
  summaryEntryOf,
  COMPACT_READ_LIMIT,
  type CompactFacts,
  type CompactLimits,
  type SummaryEntry
} from '../domain/compaction-service.ts'

/**
 * 压缩的**执行** —— 判决在 `domain/compaction-service.ts`，这里只负责落地。
 *
 * 它管的是「一轮结束之后」：`@` 出现在 agent 的回复里，而**压缩的对象是这一轮之前的
 * 历史**，所以两边都只能发生在轮次结束时。落点是 `turn-runner` 收尾处注入的回调
 * `onTurnFinished(turn)`，**必须在 `batcher.endTurn` 之后** ——
 * 那是提交终态的事务，压缩要在库干净之后读它（读的就是刚提交的东西）。
 *
 * ## 与扇出的顺序：压缩**在前**
 *
 * 同一个缝上挂着两件事（`runtime.ts` 的装配处），顺序是「先压缩、后扇出」：
 * 先落定对**过去**的记账，再开始**未来**的事。★ 诚实记一句：**今天这个顺序不是
 * load-bearing 的** —— §4.5a 规则一（同一会话不会并起第二轮）保证了两者互不影响。
 * 正因如此它更要写下来：哪天有人调换了它们，没有任何测试会红。
 *
 * ## ★★ 它**绝不许抛**
 *
 * 本函数的整个函数体包在一个 `try` 里。它跑在 `runner.run()` 的**同步尾段**，
 * 抛出去会变成调度器的 `run-crashed` warn —— 而真正的后果是**压缩从此再也不会发生**
 * （每一轮都在同一个地方炸，安静地、永远地）。那比「压缩没做成」坏得多：
 * 前者至少还在记账，后者是记账这件事本身没了。
 *
 * 库不一致（会话/成员/角色查不到、没有触发消息）一律 `warn` + 返回，不抛 ——
 * 照 `fanout` 的先例：抛出去会把 **agent 已经做完的那一轮**一起变成失败。
 *
 * ## 它不 import electron、不 import `node:sqlite`
 *
 * 持久化面是注入的窄口（照 `FanoutStore`），于是 `test/process/compaction.test.ts`
 * 能用**真内存库**在裸 Node 下跑完这套 —— 而这一块最要紧的几条断言
 * （水位线不含本轮、水位线与逐条标记同事务、`excluded` 不许被折进摘要）
 * 恰恰都是**库层面的**事实，打桩是打不出来的。
 */
export interface CompactionStore {
  tx<T>(fn: () => T): T
  session: {
    get(id: string): Session | null
    setCompaction(id: string, throughSeq: number, summary: string): Session | null
  }
  member: { get(id: string): WorkspaceMember | null }
  /** 角色 —— 只为了拿 `agentKind` 去问诊断（诊断是按 agent 类型收集的）。 */
  actor: { get(id: string): Actor | null }
  message: {
    get(id: string): Message | null
    append(input: AppendMessageInput): Message
    lastSeqBefore(sessionId: string, beforeSeq: number): number | null
    listBySessionBetween(
      sessionId: string,
      afterSeq: number,
      beforeSeq: number,
      limit: number
    ): Message[]
    markCompactedBySession(sessionId: string, throughSeq: number, summary: string): Message[]
    toolNamesOf(messageId: string): string[]
  }
}

export interface CompactionOptions {
  store: CompactionStore
  /** 这一轮的诊断（CLI 自己压缩的信号在这里面）。形状与 `TurnRunnerOptions.diagnosticsOf` 一致。 */
  diagnosticsOf(kind: Actor['agentKind'], turnId: string): readonly AgentDiagnostic[]
  emitNotice(notice: PushOf<'app:notice'>): void
  /** 阈值覆盖（走查用 `CODE_CHAT_COMPACTION_N`）。没点名的字段仍是模块里那一份。 */
  limits?: Partial<CompactLimits>
  now(): number
  newId(): string
  onWarn(tag: string, message: string, detail?: unknown): void
}

export interface Compaction {
  /** 一轮结束时调用（**必须在 `batcher.endTurn` 之后**）。**同步、不返回值、绝不抛。** */
  onTurnFinished(turn: Turn): void
}

export function createCompaction(opts: CompactionOptions): Compaction {
  const store = opts.store
  const limits = resolveCompactLimits(opts.limits)

  function warn(tag: string, message: string, detail?: unknown): void {
    opts.onWarn(`compaction:${tag}`, message, detail)
  }

  /**
   * 一条**持久的** system 行 —— 用户与模型都能看到的那个「压缩发生了」。
   *
   * ★ 它**不带 `turnId`**（照 `fanout.appendSystemEvent`）：这条行是事后追加的，
   * 带上就会被 `listByTurn` 算成那一轮说的话，而 M7b 的扇出正是按 `listByTurn`
   * 去解析「这一轮回复里 @ 了谁」的 —— 一条系统说明混进去，最轻的后果是它被当成回复。
   *
   * ★ 它是**提示词内容**（下次装配时以 `【系统】` 出现），所以正文必须短、且只写真话。
   */
  function appendSystemRow(turn: Turn, text: string): void {
    store.message.append({
      id: opts.newId(),
      workspaceId: turn.workspaceId,
      sessionId: turn.sessionId,
      role: 'system',
      contentText: text,
      now: opts.now()
    })
  }

  function onTurnFinished(turn: Turn): void {
    try {
      finish(turn)
    } catch (e) {
      warn(
        'threw',
        `压缩在轮次收尾时抛了 —— 已吞掉（它绝不许影响轮次的收尾，更不许让压缩从此不再发生）`,
        { turnId: turn.id, error: e instanceof Error ? e.message : String(e) }
      )
    }
  }

  function finish(turn: Turn): void {
    const session = store.session.get(turn.sessionId)
    const member = session ? store.member.get(session.memberId) : null
    const actor = member ? store.actor.get(member.actorId) : null
    if (!session || !member || !actor) {
      warn('actor-missing', `轮次 ${turn.id} 的会话/成员/角色查不到，这一轮不做压缩`, {
        turnId: turn.id
      })
      return
    }

    // 没有触发消息就**算不出区间右端** —— 「本轮之前」这件事的位置由它定义。
    const trigger = turn.triggerMessageId ? store.message.get(turn.triggerMessageId) : null
    if (!trigger) {
      warn('trigger-missing', `轮次 ${turn.id} 没有触发消息，这一轮不做压缩`, { turnId: turn.id })
      return
    }

    const waterline = session.compactedThroughSeq
    // ── 读区间 `(waterline, trigger.seq)`：两端都是开区间 ──
    const rows = store.message.listBySessionBetween(
      session.id,
      waterline,
      trigger.seq,
      COMPACT_READ_LIMIT
    )
    if (rows.length >= COMPACT_READ_LIMIT) {
      // 只压到读到的地方，**绝不假装压到底** —— 假装的话那一段就会
      // 既不在历史里、也不在摘要里（水位线却已经越过它们了）。
      warn(
        'read-capped',
        `待折消息达到读取上限 ${COMPACT_READ_LIMIT} 条，这一次只压到第 ${rows[rows.length - 1]!.seq} 条`,
        { turnId: turn.id, limit: COMPACT_READ_LIMIT, lastSeq: rows[rows.length - 1]!.seq }
      )
    }

    // 作者名要现查（`message` 表只存 id）—— 复用装配层那个映射，
    // 于是摘要里的标签与历史里的**不可能**分叉。
    const nameCache = new Map<string, string | null>()
    const nameOf = (memberId: string): string | null => {
      if (!nameCache.has(memberId)) {
        nameCache.set(memberId, store.member.get(memberId)?.displayName ?? null)
      }
      return nameCache.get(memberId) ?? null
    }

    const entries: SummaryEntry[] = []
    for (const m of rows) {
      const e = summaryEntryOf(
        historyMessageOf(m, nameOf),
        session.memberId,
        store.message.toolNamesOf(m.id)
      )
      if (e) entries.push(e)
    }

    const facts: CompactFacts = {
      waterline,
      triggerSeq: trigger.seq,
      lastBeforeTriggerSeq: store.message.lastSeqBefore(session.id, trigger.seq),
      pending: entries,
      // ★ 原文字数，不是骨架长度 —— 见 `CompactFacts.pendingChars` 上的★。
      pendingChars: rows.reduce((a, m) => a + (m.contentText?.length ?? 0), 0),
      readLimit: COMPACT_READ_LIMIT
    }
    const decision = shouldCompact(facts, limits)
    const cli = compactFactsFromDiagnostics(opts.diagnosticsOf(actor.agentKind, turn.id))
    const surface = interpretCompactResult(decision, cli)

    // 判决**无论压不压都进日志**：归档里那个「这一轮为什么没压」的问题，
    // 只能靠这一条回答（`reason` 是它的答案）。
    warn('decided', `压缩判决：${decision.reason}`, {
      turnId: turn.id,
      sessionId: session.id,
      reason: decision.reason,
      compact: decision.compact,
      throughSeq: decision.throughSeq,
      waterline,
      triggerSeq: trigger.seq,
      lastBeforeTriggerSeq: facts.lastBeforeTriggerSeq,
      pendingCount: entries.length,
      pendingChars: facts.pendingChars,
      limits
    })

    if (decision.compact) {
      const build = appendToRollingSummary({
        prev: session.rollingSummary,
        entries,
        toSeq: decision.throughSeq,
        maxChars: limits.summaryMaxChars
      })

      // ★ 水位线与逐条标记**必须同事务**：只落一半的后果是
      // 「水位线说压过了，而逐条标记说没有」（或者反过来）——
      // 前者会让那段历史既不在历史里也不在摘要里。
      store.tx(() => {
        store.session.setCompaction(session.id, decision.throughSeq, build.text)
        store.message.markCompactedBySession(session.id, decision.throughSeq, build.text)
        appendSystemRow(
          turn,
          `【系统】历史上下文已压缩：seq ≤ ${decision.throughSeq} 的 ${entries.length} 条消息` +
            `已折叠成摘要，原文不再进入后续轮次。`
        )
      })

      warn('compacted', `已折叠 ${entries.length} 条骨架，水位线推到 ${decision.throughSeq}`, {
        turnId: turn.id,
        sessionId: session.id,
        throughSeq: decision.throughSeq,
        folded: build.folded,
        kept: build.kept,
        prevLines: build.prevLines,
        chars: build.text.length,
        truncated: build.truncated
      })
      if (build.prevUnparsed) {
        // 上一轮的摘要没剥出标题 ⇒ 已**逐字**携带。只丢一个标签，一个字都没丢。
        warn('prev-summary-unparsed', '上一轮的摘要没解析出标题，已逐字携带（只丢标签，不丢字）', {
          turnId: turn.id,
          sessionId: session.id
        })
      }
      if (build.truncated) {
        warn(
          'summary-truncated',
          `摘要超过 ${limits.summaryMaxChars} 字上限，已从中间删掉 ${build.droppedCount} 条骨架` +
            `（删除处在文本里写明了）`,
          { turnId: turn.id, droppedCount: build.droppedCount, maxChars: limits.summaryMaxChars }
        )
      }
    }

    if (surface) {
      // 用户看得见的那一类（CLI 自己压了 / CLI 压缩失败且我们本就该压）：
      // 一条 notice + 一条持久行。正文走 `interpretCompactResult` 的措辞，
      // 诊断原文只进 `detail`（它是我们自己的话，不是给人看的报错文本）。
      appendSystemRow(turn, `【系统】${surface.message}。`)
      opts.emitNotice({
        level: 'warning',
        message: surface.message,
        detail: {
          tag: surface.tag,
          turnId: turn.id,
          sessionId: session.id,
          cliMessage: cli.message
        }
      })
    }
    // ★ CLI 的信号**无论露不露面都进日志** —— 归档里要能回答
    // 「CLI 说过压缩的什么事」，而 `too_few_groups` 正是那种「说了但不该弹窗」的。
    if (cli.result !== 'none' || cli.boundarySeen) {
      warn('cli-signal', `CLI 的压缩信号：boundary=${cli.boundarySeen} result=${cli.result}`, {
        turnId: turn.id,
        boundarySeen: cli.boundarySeen,
        result: cli.result,
        cliMessage: cli.message,
        surfaced: surface?.tag ?? null
      })
    }
  }

  return { onTurnFinished }
}
