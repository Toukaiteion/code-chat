/**
 * `message_event` 行 → 帧 → 缓冲。**历史回放与实时流走的是同一个归约器。**
 *
 * ## 为什么值得单独一个文件
 *
 * 一轮对话的正文有两个来源：**实时帧**（`stream:batch`）与**历史行**
 * （`message:getEvents` 拉回的 `message_event`）。两者说的是同一件事，
 * 但到达的形状完全不同 —— 帧是 `StreamFrame`，行是库里那张宽表
 * （`kind` / `textBlob` / `payloadJson` / `toolUseId` / `ok` …）。
 *
 * 很自然的分叉写法是：给历史**再写一套**渲染（「从行拼出思考、工具、diff」）。
 * 那样一来，同一轮对话在「刚跑完」与「重启后重看」时会长得不一样 ——
 * 而且**只在某些字段上不一样**（一个渲染了截断标记、另一个没有；
 * 一个把 `usage` 当累加、另一个当覆盖）。这种错没有任何测试能自动发现，
 * 用户也得同时看着两个视图才可能注意到。
 *
 * 所以这里只做一件事：**把行翻译成帧**，然后交给 `frame-buffer.ts` 那个
 * 唯一的归约器。翻译是机械的、可测的，而归约语义**只有一份**。
 *
 * ## 一条**有损**之处，必须写明
 *
 * `EVENT_KINDS` 里**没有 `thinking_end`** —— 它不落库（只是一条帧）。
 * 所以从历史拼出来的缓冲**没有「思考结束」这个事实**，这里统一按
 * `thinkingOpen: false` 给（回顾一条旧消息时，推理面板默认收起是我们要的样子）。
 * 代价是：历史里看不出「这段思考之后模型还说了话、之后又想了第二段」的边界。
 * 那是下一个里程碑要做的事（`message_event` 上加一类，或者记一个边界事件），
 * M6b **不做**，只把它记在这里。
 */
import type { AgentErrorCode, MessageEvent, TerminalReason } from '../entities.ts'
import { applyFrame, emptyBuffer, type StreamFrame, type TurnBuffer, type TurnIds } from './frame-buffer.ts'

/**
 * 把一个 JSON 列解析出来。
 *
 * ★ **坏 JSON 一律抛**，与 `persist/row.ts` 的 `json()` 是同一条纪律：
 * 那些列都是我们自己用 `JSON.stringify` 写进去的，读回来解析不了意味着**库被外部改过**，
 * 此时静默吞掉会让界面少显示一块而无从解释。抛出去，让调用方把它变成一条通知。
 *
 * 带回 event 的 id 与 kind —— 一个坏掉的 JSON 列比一个缺失的列更难查，所以要它自己报出身份。
 */
function parsePayload(ev: MessageEvent): unknown {
  const raw = ev.payloadJson
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(
      `事件 #${ev.id}（${ev.kind}）的 payload 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`
    )
  }
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function n(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/**
 * 一条事件行 → 一帧。**返回 `null` 表示这一行不产生帧**（目前没有这种行，
 * 但签名留成可空，将来加事件类型时不必改所有调用点）。
 */
export function eventToFrame(ev: MessageEvent): StreamFrame | null {
  const text = ev.textBlob ?? ''
  // ⚠️ 帧 `seq` 在这里**没有水位线含义**（那是每 session 的计数器，不落库）。
  //    借用 `message_event.seq` 只是为了填一个必填字段，它绝不会被喂进水位线状态机。
  const seq = ev.seq

  switch (ev.kind) {
    case 'text':
      return { seq, k: 'text', d: text }
    case 'thinking':
      return { seq, k: 'thinking', d: text }

    case 'tool_start': {
      const p = parsePayload(ev)
      return {
        seq,
        k: 'tool_start',
        // `toolUseId` 是 NOT NULL 的（`tool_start` 这类行必然带它）。
        id: ev.toolUseId ?? '',
        name: ev.toolName ?? '',
        // `payloadJson` 存的就是 `tool_use.input` 原样，可能是 `null`。
        input: p ?? undefined
      }
    }

    case 'tool_result':
      return {
        seq,
        k: 'tool_result',
        id: ev.toolUseId ?? '',
        // `ok` 可空，但一条没有 `ok` 的结果行是坏数据 —— 按**失败**读，
        // 因为把未知当成成功会让界面给一次可能没成的调用打勾。
        ok: ev.ok === true,
        output: text,
        // ★ 行里存的 `truncated` 与帧上的 `truncated` **不是同一件事**：
        //   行回答「到底输出了什么」，帧回答「这一次推送发了多少」。
        //   历史上我们看到的是**全量**（`textBlob` 就是完整的），所以这里恒为 false。
        truncated: false
      }

    case 'file_diff': {
      const p = obj(parsePayload(ev))
      const path = typeof p.path === 'string' ? p.path : null
      if (path === null) {
        // 路径读不出来就**抛**，不是编一个：`patch` 里没有路径信息，
        // 而一个「不知道改了哪个文件」的 diff 块会让用户以为它就是当前项目里的某个文件。
        throw new Error(`事件 #${ev.id} 的 file_diff 没有 path，无法显示这次改动`)
      }
      return { seq, k: 'file_diff', path, patch: text }
    }

    case 'usage': {
      const p = obj(parsePayload(ev))
      const costUsd = p.costUsd
      return {
        seq,
        k: 'usage',
        in: n(p.in),
        out: n(p.out),
        cacheRead: n(p.cacheRead),
        cacheCreation: n(p.cacheCreation),
        thinkingTokens: n(p.thinkingTokens),
        ...(typeof costUsd === 'number' ? { costUsd } : {})
      }
    }

    case 'error': {
      const p = obj(parsePayload(ev))
      const code = p.code
      if (typeof code !== 'string') {
        throw new Error(`事件 #${ev.id} 的 error 没有 code，无法给出准确的下一步提示`)
      }
      return {
        seq,
        k: 'error',
        // 这里**不校验** code 是否在 `AGENT_ERROR_CODES` 里：它是闭合联合，
        // 而主进程写进来的一定是那个集合里的值。真出现别的值，说明版本分叉了 ——
        // 那时候如实把它显示出来，比吞掉它更容易发现。
        code: code as AgentErrorCode,
        message: text,
        fatal: p.fatal === true
      }
    }

    case 'done': {
      const p = obj(parsePayload(ev))
      const reason = p.reason
      if (typeof reason !== 'string') {
        throw new Error(`事件 #${ev.id} 的 done 没有 reason`)
      }
      return { seq, k: 'done', reason: reason as TerminalReason }
    }

    default:
      // `EventKind` 是闭合的，所以这里只有「主进程版本比渲染层新」才会走到。
      // 静默跳过是对的：一个看不懂的事件不该让整条消息渲染不出来。
      return null
  }
}

/**
 * 一整条消息的全部事件 → 一个缓冲。**渲染历史行用的就是它。**
 *
 * `thinkingOpen` 在折叠完之后统一置 `false`：历史里没有 `thinking_end`
 * 这个事实（见文件头），而「回顾旧消息时推理面板默认收起」正是我们要的样子。
 */
export function bufferFromEvents(ids: TurnIds, events: readonly MessageEvent[]): TurnBuffer {
  let buf = emptyBuffer(ids)
  for (const ev of events) {
    const frame = eventToFrame(ev)
    if (frame !== null) buf = applyFrame(buf, frame)
  }
  // 一条什么都没有的消息不值得多换一个对象引用 —— 它每一帧都可能是空消息。
  const empty = buf.done === null && buf.text === '' && buf.thinking === '' && buf.items.length === 0
  return empty ? buf : { ...buf, thinkingOpen: false }
}
