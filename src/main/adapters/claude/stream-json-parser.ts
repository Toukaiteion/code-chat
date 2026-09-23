import type { AgentDiagnostic, AgentEvent } from '../agent-adapter.ts'
import type { TerminalReason } from '../../../shared/entities.ts'

/**
 * `claude --output-format stream-json` 的 NDJSON → `AgentEvent`。
 *
 * **它是有状态的，不是纯函数**（§4.1 把它描述成「NDJSON 行 → 事件」，
 * 但那只是它的形状，不是它的性质）。跨行状态至少四处必需：
 * ① 增量与完整消息的**去重**；② 超长行的「丢弃到下一个换行」；③ 内容块下标 → 类型
 * 的映射（`content_block_stop` 只给下标，不给类型）；④ 观测数据（探针要的）。
 *
 * ## 四个实测坑（§2.3）各自落在哪一行
 *
 * 1. **非 JSON 行**（实测见过 `[claude-code:unrecognized_model] {…}`）→ `handleLine` 的
 *    `JSON.parse` 失败分支：跳过 + 记诊断，**不崩**。
 * 2. **`--include-partial-messages` 让同一内容到达两次**（增量 `stream_event` + 完整 `assistant`）→
 *    见下面「谁说了算」一节的裁定。
 * 3. **`permissionMode` 回报 `"default"`**（而 `--help` 的可选项里没有）→ 类型上就不设字面量联合，
 *    见 `agent-adapter.ts` 的注释。
 * 4. **中断后终态 `result` 缺 `result` 字段**（bug #94741）→ `result` 一律当可选，
 *    只按 `subtype` / `is_error` 分支。
 *
 * ## 谁说了算：增量 vs 完整消息（坑 2 的裁定）
 *
 * §2.3-2 当年把去重判给了**渲染层**（「渲染层必须原地替换而非追加」）——
 * 那句话写在适配层存在之前。现在解析器就站在渲染层前面，两边都做 = 双重抑制，
 * 都不做 = 文字重复。**裁定给解析器**（离源头最近），于是：
 *
 * - **文本/思考：增量说了算。** 完整 `assistant` 块里的 `text` / `thinking` **不重复发**。
 * - **`tool_start`：完整块说了算。** 因为 `input_json_delta` 给的是**半截 JSON**，
 *   逐片拼起来再解析等于自己写一个流式 JSON 解析器 —— 不做（§4.1 没给这件事预算）。
 * - **兜底**：万一某次运行没开 `--include-partial-messages`（没有任何 `content_block_delta`），
 *   增量就没有内容可发，于是**整轮静默**。所以记一个 `sawAnyDelta`，
 *   完整块到达时若从未见过增量，才由完整块补发一次。这样两种旗标组合都对，
 *   且不会重复。
 *
 * ## 诊断 ≠ 错误
 *
 * 坑 1 与超长行产生的都是 `AgentDiagnostic`，**不是** `error` 事件。
 * 一行 `[claude-code:unrecognized_model]` 不该让 UI 弹「出错了」。
 */

/**
 * 单行长度上限（§8.9-12，两个项目共同的缺口）。
 *
 * 一个没有上限的行缓冲 = 一个可以吃光内存的入口：把 `pending` 一直拼下去，
 * 直到 `JSON.parse` 因为内存不足而炸。所以超限就**放弃这一行**（丢弃到下一个换行）、
 * 记一条诊断、**继续解析下一行** —— 既不崩，也不无限缓存。
 *
 * 阈值取 8MB：§2.2 见过的最长行是 Read 返回的文件内容，
 * 而工具结果另有 1MB 的截断纪律（§5.8），所以 8MB 是「这一定不正常」的量级。
 */
export const MAX_LINE_CHARS = 8 * 1024 * 1024

/** 诊断里附的原始行样本上限 —— 够定位问题，又不至于把日志撑爆。 */
const SAMPLE_CHARS = 240

/** 探针⑦要的观测数据：块序列 + 几个「有没有出现」的布尔。 */
export interface BlockTraceEntry {
  index: number
  kind: 'text' | 'thinking' | 'tool_use' | 'unknown'
  /** 事件来源。区分它是从增量还是从完整块来的，正是 §4.3 补记 ② 要问的。 */
  source: 'delta' | 'assistant'
}

export interface ParserObservations {
  /** CLI 自报的首字延迟（§2.2 的 `ttft_ms`）。比墙钟更值得信，因为它是 CLI 自己量的。 */
  ttftMs: number | null
  /** 实测到的终态 `subtype` 原文 —— 探针据此回答「budget 用哪个 subtype 报」（§4.4）。 */
  resultSubtype: string | null
  /** §8.9-13：`system:compact_boundary` 到底是不是一类一等事件。 */
  sawCompactBoundary: boolean
  /** 有没有真的收到增量 —— 即 `--include-partial-messages` 到底生效没有。 */
  sawPartialMessages: boolean
}

export interface StreamParser {
  push(chunk: string): AgentEvent[]
  /** 流结束时调用：最后一行可能没有换行符。 */
  flush(): AgentEvent[]
  diagnostics(): readonly AgentDiagnostic[]
  /** 本轮见到的内容块序列（探针⑦）。 */
  blockTrace(): readonly BlockTraceEntry[]
  observations(): ParserObservations
}

type Json = Record<string, unknown>

function asObj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `tool_result` 的 `content` 可以是字符串，也可以是块数组。两种都要读得出来。 */
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const o = asObj(item)
    if (!o) continue
    const t = str(o.text)
    if (t !== null) parts.push(t)
    else if (o.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n')
}

/**
 * 终态 `subtype` → 我们的 `TerminalReason`。
 *
 * ⚠️ **这是全文件唯一一处「猜」**，而且是刻意的：CLI 到底用哪些 subtype 报
 * 「超预算」和「被中断」，**尚无实测**（§4.4 只记了 bug #94741 说中断后 `result` 会缺字段）。
 * 所以这里是**保守匹配 + 如实留档**：认识的词就映射，同时把原文塞进
 * `observations().resultSubtype` 让探针把它打出来 ——
 * 下一版按实测收窄，而不是现在编一份假的枚举。
 *
 * **subtype 认不出来时落 `complete` 而不是 `crashed`，这是刻意的**：
 * `is_error` 是 CLI **自己**对成败的明确表态，比我们对 subtype 名字的熟悉程度可靠得多。
 * 一刀切成 `crashed` 的代价是：CLI 下一个版本新增任何一个成功的 subtype，
 * 所有正常轮次都会被报成崩溃。**「我不认识这个词」不等于「它失败了」。**
 *
 * `aborted` 是**我们自己知道的事实**（用户按了停止），优先级高于任何上报值：
 * 硬杀之后根本没有 `result` 行，那时只有这个信号可用。
 */
function reasonFromResult(raw: Json | null, aborted: boolean): TerminalReason {
  if (aborted) return 'interrupted'

  // ★ **先看 `terminal_reason`** —— 实测（`scripts/m5-probe.ts` 的归档）发现终态行除了
  // `subtype` 还带一个 `terminal_reason`，实测值 `completed`。那是 CLI **自己**在说结论，
  // 比我们拿正则去猜它的词形可靠一档。已知取值只有 `completed`，其余仍待实测，
  // 所以认不出来就往下走，**不猜**。
  const terminal = raw ? str(raw.terminal_reason) : null
  if (terminal !== null) {
    if (/budget/i.test(terminal)) return 'budget'
    if (/interrupt|abort|cancel/i.test(terminal)) return 'interrupted'
    if (/complet|success/i.test(terminal)) return 'complete'
  }

  const subtype = raw ? str(raw.subtype) : null
  if (subtype !== null) {
    if (/budget/i.test(subtype)) return 'budget'
    if (/interrupt|abort|cancel/i.test(subtype)) return 'interrupted'
  }
  if (raw && raw.is_error === true) return 'crashed'
  return 'complete'
}

export interface StreamParserOptions {
  /**
   * 「这一轮被我们自己中断了吗」—— **只有适配器知道的事实**，解析器无从推断。
   *
   * 不给它就会出这个错：优雅中断（阶梯第 1 级生效）会照常吐一条终态 `result`，
   * 于是终态原因只能靠 `subtype` 的正则去猜。**猜错了的后果是「用户按了停止」
   * 被报成 `complete`** —— 一个把取消说成完成的事件。所以让适配器把事实递进来，
   * `aborted` 命中时它优先于任何上报值（见 `reasonFromResult`）。
   */
  isAborted?: () => boolean
}

export function createStreamParser(opts: StreamParserOptions = {}): StreamParser {
  /** 尚未遇到换行的尾巴。 */
  let pending = ''
  /** 超长行已放弃，正在丢弃直到下一个换行。 */
  let dropping = false

  const events: AgentEvent[] = []
  const diagnostics: AgentDiagnostic[] = []
  const trace: BlockTraceEntry[] = []
  const observations: ParserObservations = {
    ttftMs: null,
    resultSubtype: null,
    sawCompactBoundary: false,
    sawPartialMessages: false
  }

  /** 内容块下标 → 类型。`content_block_stop` 只给下标，所以必须自己记。 */
  const blockKind = new Map<number, 'text' | 'thinking' | 'tool_use' | 'unknown'>()
  /** 已经吐过的 tool_use id —— 去重的另一半（另一半是 `sawAnyDelta`）。 */
  const emittedToolIds = new Set<string>()
  /** 见过任何增量吗？没见过说明 `--include-partial-messages` 没生效，得由完整块补发。 */
  let sawAnyDelta = false
  /** 已经收过终态 `result` 了 —— 之后的行不再产生事件（进程可能还会吐别的）。 */
  let sawResult = false
  /**
   * `system:thinking_tokens` 的**累计**估算。
   *
   * ★ 这个字段是探针逼出来的：实测这个端点上终态 `usage.output_tokens_details.thinking_tokens`
   * 报的是 **0**，而真正的数字在 `system:thinking_tokens` 这条流里（每轮 374 条，
   * 最后一条的 `estimated_tokens` 就是全轮的估算量）。见 `onResult` 里怎么用它。
   */
  let thinkingTokensEstimate = 0

  function diag(level: 'info' | 'warn', tag: string, message: string, sample?: string): void {
    diagnostics.push({ level, tag, message, sample: sample?.slice(0, SAMPLE_CHARS) })
  }

  function emit(ev: AgentEvent): void {
    events.push(ev)
  }

  // ─── 各种行 ───────────────────────────────────────────────

  function onSystem(raw: Json): void {
    const subtype = str(raw.subtype)
    if (subtype === 'init') {
      emit({
        k: 'session_started',
        sessionId: str(raw.session_id) ?? '',
        model: str(raw.model) ?? '',
        cwd: str(raw.cwd) ?? '',
        permissionMode: str(raw.permissionMode) ?? '',
        tools: Array.isArray(raw.tools) ? (raw.tools.filter((t) => typeof t === 'string') as string[]) : []
      })
      return
    }
    if (subtype === 'status') {
      const status = str(raw.status)
      if (status !== null) {
        emit({ k: 'status_changed', status })
        return
      }
      // ★ 实测：`status` 可以是 `null`，这时这行 payload 装的是**压缩的结果**：
      // `{"subtype":"status","status":null,"compact_result":"failed","compact_error":"too_few_groups"}`
      // （`scripts/m5-probe.ts --only=compact` 的归档）。我第一版对 `null` 直接 return ——
      // 于是一次压缩失败在诊断通道里**一个字都没有**：CLI 明明说了原因，我们把它丢了。
      const compactResult = str(raw.compact_result)
      if (compactResult !== null) {
        const why = str(raw.compact_error) ?? '(无原因)'
        if (compactResult === 'failed') diag('warn', 'compact-failed', `CLI 压缩失败：${why}`)
        else diag('info', 'compact-result', `CLI 压缩结果 ${compactResult}：${why}`)
      }
      return
    }
    if (subtype === 'thinking_tokens') {
      // ★ **已知且高频**：实测一轮来了 **374 条**（一条思考增量对应一条）。
      // 我第一版把它算作「未处理的子类型」，于是**一轮刷了 374 条警告** ——
      // 那会把诊断通道彻底淹掉，「有一行我不认识」这个信号就再也看不见了。
      // 所以它是已知流量：既不报，也别指望它是事件。
      const est = num(raw.estimated_tokens)
      if (est !== null) thinkingTokensEstimate = est
      return
    }
    if (subtype === 'permission_denied') {
      // 实测形状：`{tool_name, tool_use_id, decision_reason_type, decision_reason, message}`。
      // **它不是错误**（这一轮照样完成了），但它是「agent 想伸手到工作目录外面」的
      // 唯一信号，而且一轮最多几条 —— 正好是诊断该干的事。M6 再决定它值不值得露给用户。
      diag(
        'warn',
        'permission-denied',
        `CLI 拒绝了一次工具调用：${str(raw.tool_name) ?? '(未知工具)'} —— ` +
          `${str(raw.decision_reason) ?? str(raw.message) ?? '(无原因)'}`
      )
      return
    }
    if (subtype === 'compact_boundary') {
      // §8.9-13：它到底是一等事件还是一个 bug？M5 只**观测**，不处理 ——
      // 所以它既不发事件也不发警告，只留一条 info 诊断与一个布尔。
      observations.sawCompactBoundary = true
      diag('info', 'compact-boundary', '收到 system:compact_boundary（§8.9-13 的观测点）')
      return
    }
    diag('warn', 'unknown-system-subtype', `未处理的 system 子类型：${subtype ?? '(缺失)'}`)
  }

  function onStreamEvent(raw: Json): void {
    const ttft = num(raw.ttft_ms)
    if (ttft !== null && observations.ttftMs === null) observations.ttftMs = ttft

    const ev = asObj(raw.event)
    if (!ev) {
      diag('warn', 'stream-event-no-payload', 'stream_event 里没有 event 对象')
      return
    }
    const kind = str(ev.type)
    const index = num(ev.index) ?? -1

    if (kind === 'content_block_start') {
      const cb = asObj(ev.content_block)
      const cbType = cb ? str(cb.type) : null
      const mapped: 'text' | 'thinking' | 'tool_use' | 'unknown' =
        cbType === 'text' ? 'text' : cbType === 'thinking' ? 'thinking' : cbType === 'tool_use' ? 'tool_use' : 'unknown'
      blockKind.set(index, mapped)
      trace.push({ index, kind: mapped, source: 'delta' })
      return
    }

    if (kind === 'content_block_delta') {
      const delta = asObj(ev.delta)
      if (!delta) {
        // 形状不对的增量**不算证据**：`sawAnyDelta` / `sawPartialMessages` 都不置位，
        // 否则一个空壳 delta 会把「完整块补发」那条兜底路径关掉（见文件头「谁说了算」）。
        diag('warn', 'stream-event-no-delta', 'content_block_delta 里没有 delta 对象')
        return
      }
      const deltaType = str(delta.type)
      sawAnyDelta = true
      observations.sawPartialMessages = true

      if (deltaType === 'text_delta') {
        const text = str(delta.text)
        if (text) emit({ k: 'text_delta', block: index, text })
        return
      }
      if (deltaType === 'thinking_delta') {
        // 字段名是 `thinking`（不是 `text`）；两个都认，因为 §5.7 的「思考为空」
        // 降级路径还没有实测口径。
        const text = str(delta.thinking) ?? str(delta.text)
        if (text) emit({ k: 'thinking_delta', block: index, text })
        return
      }
      if (deltaType === 'input_json_delta' || deltaType === 'signature_delta') {
        // **刻意忽略**：前者是半截 JSON（拼不动，见文件头），后者是思考签名（我们不用）。
        // 忽略不等于丢弃信息 —— tool_start 会从完整块那边来。
        return
      }
      diag('warn', 'unknown-delta-type', `未处理的 delta 类型：${deltaType ?? '(缺失)'}`)
      return
    }

    if (kind === 'content_block_stop') {
      if (blockKind.get(index) === 'thinking') emit({ k: 'thinking_end', block: index })
      return
    }

    if (kind === 'message_start' || kind === 'message_delta' || kind === 'message_stop') {
      // usage 一律以终态 `result` 为准（那里有 cache_* 与 thinking_tokens 的完整视图），
      // 所以这里不重复发 usage —— 否则同一轮会出现两个互相矛盾的用量数字。
      return
    }

    diag('warn', 'unknown-stream-event', `未处理的流事件：${kind ?? '(缺失)'}`)
  }

  function onAssistant(raw: Json): void {
    const message = asObj(raw.message)
    const content = message && Array.isArray(message.content) ? message.content : []
    for (const item of content) {
      const o = asObj(item)
      if (!o) continue
      const type = str(o.type)

      if (type === 'tool_use') {
        const id = str(o.id) ?? ''
        const name = str(o.name) ?? ''
        // 去重：同一 id 只发一次。
        if (id && emittedToolIds.has(id)) continue
        if (id) emittedToolIds.add(id)
        emit({ k: 'tool_start', id, name, input: o.input ?? null })
        continue
      }

      // 文本与思考：只有「整轮没见过增量」时才由完整块补发（见文件头「谁说了算」）。
      if (sawAnyDelta) continue
      if (type === 'text') {
        const text = str(o.text)
        if (text) {
          trace.push({ index: -1, kind: 'text', source: 'assistant' })
          emit({ k: 'text_delta', block: -1, text })
        }
      } else if (type === 'thinking') {
        const text = str(o.thinking)
        if (text) {
          trace.push({ index: -1, kind: 'thinking', source: 'assistant' })
          emit({ k: 'thinking_delta', block: -1, text })
          emit({ k: 'thinking_end', block: -1 })
        }
      }
    }
  }

  function onUser(raw: Json): void {
    const message = asObj(raw.message)
    const content = message && Array.isArray(message.content) ? message.content : []
    // 顶层另有结构化的 tool_use_result（§2.2）—— 它是**整行一份**，不是每个块一份，
    // 所以只把它挂在该行第一个 tool_result 上。
    const structured = raw.tool_use_result ?? null
    let first = true

    for (const item of content) {
      const o = asObj(item)
      if (!o || o.type !== 'tool_result') continue
      const id = str(o.tool_use_id) ?? ''
      const output = flattenToolResultContent(o.content)
      emit({
        k: 'tool_result',
        id,
        ok: o.is_error !== true,
        output,
        structured: first ? structured : null,
        truncated: false
      })
      first = false
    }
  }

  function onResult(raw: Json): void {
    const subtype = str(raw.subtype)
    observations.resultSubtype = subtype
    // 探针要的回答之一就在这里：CLI 用哪个 subtype 报超预算。
    diag('info', 'result-subtype', `终态 subtype = ${subtype ?? '(缺失)'}`)

    const usage = asObj(raw.usage)
    const outDetails = usage ? asObj(usage.output_tokens_details) : null
    const reported = outDetails ? num(outDetails.thinking_tokens) : null
    emit({
      k: 'usage',
      in: usage ? (num(usage.input_tokens) ?? 0) : 0,
      out: usage ? (num(usage.output_tokens) ?? 0) : 0,
      cacheRead: usage ? (num(usage.cache_read_input_tokens) ?? undefined) : undefined,
      cacheCreation: usage ? (num(usage.cache_creation_input_tokens) ?? undefined) : undefined,
      // ★ **上报值为 0 时改用流里的累计估算** —— 实测逼出来的取法：这个端点上
      // `output_tokens_details.thinking_tokens` 报的是 0，而那一轮明明有 374 段思考，
      // 真正的数字只在 `system:thinking_tokens` 里。拿 0 覆盖掉一个实测量，
      // 正是 §4.6「计算了但没渲染 = 缺陷」的镜像：**这里是「渲染了一个假的 0」。**
      // 两个都是估算，但 0 的含义是「没上报」，不是「没思考」。
      thinkingTokens: reported !== null && reported > 0 ? reported : thinkingTokensEstimate || undefined,
      // §2.4-2：这个数在第三方端点上不可信，展示侧必须标「估算」。
      costUsd: num(raw.total_cost_usd) ?? undefined
    })

    // bug #94741：中断后 `result` 字段**会缺**。所以它一律当可选 ——
    // 缺了不影响我们给出终态，只影响我们能否复述模型最后那句话。
    const resultText = str(raw.result)
    if (resultText === null) {
      diag('info', 'result-field-missing', '终态行没有 result 字段（bug #94741 的已知形态）')
    } else if (raw.is_error === true) {
      // ★ 实测逼出来的一条（`scripts/m5-probe.ts --only=compact` 的归档）：
      // **`subtype` 可以是 `"success"` 而 `is_error` 是 `true`**。那一轮的 `result` 是
      // CLI 自己写的失败原因，原文 `Prompt is too long`，伴生 `terminal_reason: "blocking_limit"`。
      //
      // 我把它解析出来、然后**扔掉了** —— 于是「这一轮失败了」只剩一个 `done reason=crashed`，
      // 人话没了，而那句话恰恰是唯一能解释为什么的东西。
      // 这正是 §4.6 那条纪律的反面：**计算了但不往下传 = 缺陷**。
      // 光有原因还不够：没有它，M6/M7 只能对着 `crashed` 干瞪眼。
      diag('warn', 'cli-reported-error', `CLI 自报本轮失败：${resultText}`)
    }

    sawResult = true
    // 中断事实由适配器提供 —— 它是「用户按了停止」这件事的唯一知情者。
    emit({ k: 'done', reason: reasonFromResult(raw, opts.isAborted?.() ?? false) })
  }

  function handleLine(line: string): void {
    if (sawResult) return
    const trimmed = line.trim()
    if (!trimmed) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // 坑 1：实测见过 `[claude-code:unrecognized_model] {…}`。跳过 + 记诊断，不崩。
      diag('warn', 'non-json-line', '输出流里有一行不是 JSON，已跳过', trimmed)
      return
    }

    const raw = asObj(parsed)
    if (!raw) {
      diag('warn', 'non-object-line', '输出流里有一行是 JSON 但不是对象，已跳过', trimmed)
      return
    }

    const type = str(raw.type)
    switch (type) {
      case 'system':
        onSystem(raw)
        return
      case 'stream_event':
        onStreamEvent(raw)
        return
      case 'assistant':
        onAssistant(raw)
        return
      case 'user':
        onUser(raw)
        return
      case 'result':
        onResult(raw)
        return
      case 'control_response':
        // **已知流量，刻意既不发事件也不报警。** 它是中断请求的 ACK，形状在
        // `control-protocol.ts` 里写着；而「ACK ≠ 完成」意味着它**不许**推进任何状态机
        // （推进了就正好是那个被禁止的混淆）。每次中断都报一条诊断则纯粹是噪声。
        return
      default:
        // `warn` 而不是 `info`：**「有一行我完全不认识」和「我看到了一个已知的东西」是两回事。**
        // 前者意味着协议漂了，正是最该被看见的那类问题。
        diag('warn', 'unknown-line-type', `未处理的输出行类型：${type ?? '(缺失)'}`, trimmed)
    }
  }

  return {
    push(chunk: string): AgentEvent[] {
      let buf = chunk
      for (;;) {
        if (dropping) {
          // 丢弃到下一个换行 —— 超长行的剩余部分对我们没有价值。
          const nl = buf.indexOf('\n')
          if (nl < 0) return events.splice(0)
          dropping = false
          buf = buf.slice(nl + 1)
          continue
        }

        const nl = buf.indexOf('\n')
        if (nl < 0) {
          pending += buf
          if (pending.length > MAX_LINE_CHARS) {
            diag(
              'warn',
              'line-too-long',
              `一行超过 ${MAX_LINE_CHARS} 字符上限，已放弃该行并继续解析（§8.9-12）`
            )
            pending = ''
            dropping = true
          }
          return events.splice(0)
        }

        // `\r\n` 也认 —— 照 `infra/git.ts` 的写法。
        const line = (pending + buf.slice(0, nl)).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        pending = ''

        if (line.length > MAX_LINE_CHARS) {
          diag('warn', 'line-too-long', `一行超过 ${MAX_LINE_CHARS} 字符上限，已放弃（§8.9-12）`)
          continue
        }
        handleLine(line)
      }
    },

    flush(): AgentEvent[] {
      // 最后一行可能没有换行符 —— 不 flush 就会丢掉终态 `result`，那是最要紧的一行。
      if (!dropping && pending) {
        const line = pending.replace(/\r$/, '')
        pending = ''
        if (line.length <= MAX_LINE_CHARS) handleLine(line)
      }
      return events.splice(0)
    },

    diagnostics: () => diagnostics,
    blockTrace: () => trace,
    observations: () => ({ ...observations })
  }
}
