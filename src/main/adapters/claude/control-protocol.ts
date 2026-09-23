import type { Writable } from 'node:stream'

/**
 * 往 CLI 的 **stdin** 说话的那一小套协议（§4.4）。
 *
 * `--input-format stream-json` 是**中断能力的必要条件**：只有开着它，stdin 才是一条
 * 可以中途插话的通道；否则 `-p` 模式下 stdin 只是「一次性的提示词入口」，
 * 我们手里就没有任何优雅收尾的手段（§5.2 记的就是这个缺口）。
 *
 * ## 一个必须记住的协议事实：ACK ≠ 完成
 *
 * `control_response` 只表示 CLI **收到了**中断请求，**不表示工作已经结束** ——
 * 它可能正停在一个跑了一半的 `Edit` 上。要等的是**终态 `result` 事件**，不是这个 ACK。
 * 所以 `control_response` 在 M5 里只做一件事：让「CLI 至少听见了」这件事可被观测。
 * 中断阶梯的推进完全靠 `child-registry` 的等待与超时。
 *
 * ## M5 的一处**明知故犯** —— M7a 已收口，结论是「那不是故犯，那就是对的」
 *
 * M5 留档的原话是：`TurnContext.messages` 是「真正的消息数组」（§4.6 的前提），
 * 但 M5 往 stdin 只写**一条** user 消息（由 `renderTurnInput()` 拍平），
 * 因为「CLI 的 stream-json 输入是否接受多条消息（含 assistant 角色的历史）」尚未实测 ——
 * 并特意写明「**M5 这一处是暂时违反 §4.6 的，不是满足它**」。
 *
 * **2026-09-23 的 M7a 探针测了，答案是它满足了、而 §4.6 写错了。**
 * 两份归档在 `scripts/evidence/m7a-2026-09-23T16-48-08-427Z` 与
 * `scripts/evidence/m7a-2026-09-23T16-51-08-216Z`，逐字结论见
 * `domain/context-builder.ts` 的文件头。两条直接相关：
 *
 * - **内层 `message.role` 只能是 `'user'`。** 写 `assistant` → 整轮被拒
 *   （stderr `Error: Expected message role 'user', got 'assistant'`）。
 * - **多条 user 行 = 多轮，不是一轮的多条。** 3 行 → 2 条 `result`。
 *
 * ⇒ 所以 `renderTurnInput()` 的拍平**不是临时实现**，它是这个协议唯一正确的用法；
 * 「一条 user 消息」也不是将就，是**必须**。
 */

/**
 * 把一轮的输入渲染成 stdin 那一条消息。
 *
 * ★ M7a 起这是**终局实现**，不是临时实现（见文件头那一段）。调用方**必须**
 * 把返回值交给 `userMessageLine()` 只写**一行** —— 自己按 `messages` 逐条写
 * 会变成多轮对话，那是探针实测过的另一件事（`context-builder.ts` 文件头）。
 *
 * 它同时是**角色标记在这条链上的唯一所有者**：`【你上一轮的回答】`由它加，
 * 别的作者标签由装配层加 —— 两边各加一份就会出现两个标记（见 `context-builder` 的 `labelOf`）。
 */
export function renderTurnInput(messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): string {
  if (messages.length === 0) return ''
  if (messages.length === 1) return messages[0].content
  // 多轮时标出角色 —— 不标的话模型分不清哪句是它自己说的。
  return messages
    .map((m) => (m.role === 'user' ? m.content : `【你上一轮的回答】\n${m.content}`))
    .join('\n\n')
}

/** 一条 user 消息的 NDJSON 行（不带换行符）。 */
export function userMessageLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  })
}

/** 中断请求的 NDJSON 行（不带换行符）。形状逐字照 §4.4。 */
export function interruptLine(requestId: string): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt' }
  })
}

/**
 * 写一行进 stdin。
 *
 * **写失败一律吞掉**：stdin 会在进程退出时先一步关闭（EPIPE），
 * 而那恰好是中断路径上的常态 —— 一个已经死掉的 CLI 收不到我们的中断请求，
 * 这不需要报警，阶梯的下一级会处理它。
 */
export function writeLine(stream: Writable | null, line: string): boolean {
  if (!stream || stream.destroyed || !stream.writable) return false
  try {
    return stream.write(line + '\n')
  } catch {
    return false
  }
}

export interface ControlResponse {
  requestId: string
  /** 实际见过的取值需要实测；M5 只把它记下来。 */
  subtype: string | null
  /** CLI 说「不行」时填这里。 */
  error: string | null
  /**
   * 我们请求中断时**还没被处理掉**的工作。
   *
   * 实测形状（探针归档）里有这一个字段：`response.response.still_queued`。
   * 它是「ACK ≠ 完成」最直接的证据 —— CLI 一边说 `success`，一边告诉你有东西还排着队。
   */
  stillQueued: readonly string[]
}

/**
 * 认一行是不是 `control_response`。是则返回解析结果，否则 `null`。
 *
 * 它**只用于观测**（见文件头「ACK ≠ 完成」）—— 不许拿它推进状态机。
 *
 * ⚠️ **`request_id` 在 `response` 里面，不在顶层。** 实测的一行是：
 *
 * ```json
 * {"type":"control_response","response":{"subtype":"success","request_id":"d1013ab6-…",
 *  "response":{"still_queued":[]}}}
 * ```
 *
 * 我第一版读的是顶层 `raw.request_id`，于是永远拿到空串 —— 一个「看起来在工作、
 * 其实永远读不到东西」的解析函数。靠探针归档里那一行原文才发现。
 */
export function readControlResponse(raw: Record<string, unknown>): ControlResponse | null {
  if (raw.type !== 'control_response') return null
  const resp = typeof raw.response === 'object' && raw.response !== null ? (raw.response as Record<string, unknown>) : null
  // 内层还有一个同名 `response` —— 中断特有的信息（有哪些还没做完）在那里。
  const inner = resp && typeof resp.response === 'object' && resp.response !== null ? (resp.response as Record<string, unknown>) : null
  const queued = inner && Array.isArray(inner.still_queued) ? inner.still_queued : []
  return {
    requestId: resp && typeof resp.request_id === 'string' ? resp.request_id : '',
    subtype: resp && typeof resp.subtype === 'string' ? resp.subtype : null,
    error: resp && typeof resp.error === 'string' ? resp.error : null,
    stillQueued: queued.filter((q): q is string => typeof q === 'string')
  }
}
