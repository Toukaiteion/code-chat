/**
 * M5 真机探针 —— 六项 + 第⑦⑧项实测（§五 的验收标准本身）。
 *
 *     npm run probe:m5                       # 默认 main,mcp
 *     npm run probe:m5 -- --only=stdin       # ⑧ 终态之后 CLI 会不会自己退出
 *     npm run probe:m5 -- --only=compact     # ③ 压缩边界（花钱不定，默认不跑）
 *     npm run probe:m5 -- --archive=<某个 .ndjson>
 *                                           # ★ 重放：**零成本**重出一份报告
 *
 * ## ⚠️ 它会花真钱，所以**绝不能被 `npm test` 扫到**
 *
 * 它 spawn 的是那个 237MB 的真 `claude.exe`，用本机默认凭据、打真端点。
 * 它放在 `scripts/` 而 `test` 脚本的 glob 是 `test/**\/*.test.ts` —— 两者不相交，
 * 这不是巧合，是**故意的**。往 `test/` 里放任何会 spawn 真 CLI 的东西都会让
 * 「跑个测试」变成「花一笔钱」，而那种事一旦发生过一次，就没人再敢随便跑测试了。
 *
 * 单轮成本硬闸是 `--max-budget-usd`（默认 0.50），但**它在第三方端点上是否真的生效尚未验证**
 * —— §2.4-2 记着这个端点上的 `total_cost_usd` 本身就不可信。所以真正的兜底是**墙钟超时**
 * （默认 180 秒）与「结果里把 token 数一并打出来」：数字对不上时，至少还有个能对账的东西。
 *
 * ## 为什么分析要**独立复读**归档，而不是复用解析器的产物
 *
 * 每一轮的原始 NDJSON 全文落在 `scripts/evidence/`，然后探针**重新读一遍那些字节**、
 * 自己数行类型、自己找标记。因为用我们自己的解析器去验我们自己的解析器，
 * 只能证明两者一致，证明不了两者都对 —— 而这一层要回答的恰恰是
 * 「我们对 CLI 的理解对不对」。
 *
 * **报告是归档的纯函数**，所以改报告不许再买一轮：`--archive=<file>` 从归档重新长出报告。
 * 这不是优化，是纪律 —— 一个需要重新花钱才能复核的结论，实际上是不复核的。
 * （`④` 那一节的 ✅/❌ 判据写错过一次，就是这么修的，零成本。）
 *
 * ## 端点溯源（决策 6）
 *
 * ②③⑥⑦ 的结论**只在「本机当前默认凭据所指向的端点」下成立**，不是 Anthropic 官方行为，
 * 所以每次运行都把生效的模型、端点来源、上下文窗口值打进文件头。
 * **凭据本身一律不读、不回显**，只报「设了没有」。
 *
 * ## 一台机器上能跑出什么
 *
 * | # | 项 | 步骤 |
 * |---|---|---|
 * | ① | 冷启动 `ttft_ms` 与峰值 RSS | `main` |
 * | ② | `thinking_delta` 是否真带正文 | `main` |
 * | ③ | 是否出现 `compact_boundary` | `compact`（**默认不跑**，理由见下） |
 * | ④ | `--add-dir` 带进的 CLAUDE.md 与显式注入是否重复 | `main` |
 * | ⑤ | `--mcp-config` 动态挂载；内联 JSON 在 Windows 上是否被当成路径 | `mcp` |
 * | ⑥ | `--append-system-prompt-file` 的内容角色是否真收到 | `main` |
 * | ⑦ | §4.3 追问的三件事 + 真实 `Edit` 输入留档 | `main` |
 * | ⑧ | 终态之后 CLI 会不会自己退出（`closeStdinOnResult` 的**成对**验证） | `stdin` |
 *
 * **③ 为什么默认不跑**：`--autocompact <tokens>` 的取值下限是 **100k**（见 `--help`），
 * 也就是「要看到压缩边界，上下文就得真的超过十万 token」—— 那不是一笔小钱，
 * 而且它会**污染同一次调用里的其余各项测量**。所以它单独成步，要花这笔钱时显式跑
 * `--only=compact`。默认跑 `main,mcp`，两项都是确定性花费。
 *
 * ★ 实测之后这一条要补一句：`CLAUDE_CODE_MAX_CONTEXT_TOKENS=20000` 的做法
 * **不是**「让 CLI 早点压缩」，而是让它**把整轮判死**（`terminal_reason: "blocking_limit"`，
 * `result: "Prompt is too long"`，1.7 秒结束、`num_turns: 1`）。所以 ③ 现在既证明不了
 * 「压缩边界不会出现」，也证明不了它会 —— **它需要一整段真实历史**，那是 M7 才有的东西。
 * 详见 docs/design.md §5.3a。
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createClaudeAdapter } from '../src/main/adapters/claude/claude-adapter.ts'
import { claudeSearchHint, resolveClaude } from '../src/main/adapters/claude/cli-locator.ts'
import { createChildRegistry } from '../src/main/process/child-registry.ts'
import type { AgentDiagnostic, AgentEvent, TurnContext } from '../src/main/adapters/agent-adapter.ts'
import type { KillTimings } from '../src/main/process/child-registry.ts'

const execFileAsync = promisify(execFile)

// ─────────────────────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────────────────────

const ALL_STEPS = ['main', 'compact', 'mcp', 'stdin'] as const

interface ProbeArgs {
  only: string[]
  model: string
  budget: number
  turnTimeoutMs: number
  contextTokens: number | null
}

function argValue(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

function parseArgs(): ProbeArgs {
  const only = (argValue('only') ?? 'main,mcp')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const s of only) {
    if (!ALL_STEPS.includes(s as (typeof ALL_STEPS)[number])) {
      throw new Error(`未知步骤 ${s}；可用：${ALL_STEPS.join(', ')}`)
    }
  }
  return {
    only,
    // 模型名**没有默认值可猜**：这台机器上默认凭据指向的端点认哪个名字，
    // 只有跑一次才知道。所以给一个显式的默认并在报告里逐字打印。
    model: argValue('model') ?? process.env.CODE_CHAT_PROBE_MODEL ?? 'deepseek-flash',
    budget: Number(argValue('budget') ?? '0.5'),
    turnTimeoutMs: Number(argValue('turn-timeout-ms') ?? '180000'),
    contextTokens: argValue('context-tokens') ? Number(argValue('context-tokens')) : null
  }
}

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────

const say = (s = ''): void => {
  process.stdout.write(s + '\n')
}
const rule = (title: string): void => {
  say()
  say(`──── ${title} ${'─'.repeat(Math.max(4, 66 - title.length))}`)
}
const quote = (s: string, n = 200): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…（共 ${one.length} 字）` : one
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 一项结论。三态是刻意的：**「没测到」与「测到是坏的」是两回事**，不许合并。 */
function check(level: 'ok' | 'bad' | 'unknown', text: string): void {
  const mark = level === 'ok' ? '✅' : level === 'bad' ? '❌' : '⚠️'
  say(`  ${mark} ${text}`)
}

// ─────────────────────────────────────────────────────────────
// 归档的独立复读
// ─────────────────────────────────────────────────────────────

/** 一个标记串第一次出现在哪一类行里 —— 这正是「自动注入」与「工具读到」的分界线。 */
interface MarkerEvidence {
  marker: string
  line: number
  where: 'tool_result' | 'assistant' | 'other'
  excerpt: string
}

interface RawAnalysis {
  totalLines: number
  nonJsonLines: string[]
  typeHist: Array<[string, number]>
  systemSubtypes: Array<[string, number]>
  /** **全部** ttft_ms。实测它出现在每个 `stream_event/message_start` 上（一次 API 请求一个），
   *  终态行上另有一个。取第一个当「冷启动」是错的 —— 那是第一次请求的首字延迟。 */
  ttftValues: number[]
  thinkingDeltaTexts: string[]
  assistantThinkingTexts: string[]
  compactHits: string[]
  blockOrder: string[]
  assistantTexts: number[]
  editWriteInputs: Array<{ name: string; input: unknown }>
  usage: Record<string, unknown> | null
  costUsd: number | null
  resultSubtype: string | null
  claudeMdLines: string[]
  assistantText: string
  markerFirst: MarkerEvidence[]
  resultFields: {
    terminalReason: string | null
    /** CLI 对成败的明确表态。★ 实测：它可以是 `true` 而 `subtype` 说着 `success`。 */
    isError: boolean | null
    /** `is_error` 时这里是 CLI 写的失败原因（实测原文：`Prompt is too long`）。 */
    errorText: string | null
    numTurns: number | null
    durationMs: number | null
    contextWindow: number | null
    permissionDenials: number
  }
}

type Json = Record<string, unknown>

function asObj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null ? (v as Json) : null
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function analyzeRaw(raw: string): RawAnalysis {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const parsed: Json[] = []
  const nonJsonLines: string[] = []
  for (const l of lines) {
    try {
      const o = asObj(JSON.parse(l))
      if (o) parsed.push(o)
      else nonJsonLines.push(l)
    } catch {
      nonJsonLines.push(l)
    }
  }

  const bump = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  const typeHist = new Map<string, number>()
  const systemSubtypes = new Map<string, number>()
  const thinkingDeltaTexts: string[] = []
  const assistantThinkingTexts: string[] = []
  const compactHits: string[] = []
  const blockOrder: string[] = []
  const assistantTexts: number[] = []
  const editWriteInputs: Array<{ name: string; input: unknown }> = []
  const claudeMdLines: string[] = []
  const ttftValues: number[] = []
  let usage: Record<string, unknown> | null = null
  let costUsd: number | null = null
  let resultSubtype: string | null = null
  const textParts: string[] = []
  const resultFields: RawAnalysis['resultFields'] = {
    terminalReason: null,
    isError: null,
    errorText: null,
    numTurns: null,
    durationMs: null,
    contextWindow: null,
    permissionDenials: 0
  }
  for (const o of parsed) {
    const type = typeof o.type === 'string' ? o.type : '(无 type)'
    bump(typeHist, type)
    if (typeof o.subtype === 'string') {
      if (type === 'system') bump(systemSubtypes, o.subtype)
      if (o.subtype.includes('compact')) compactHits.push(`${type}:${o.subtype}`)
    }
    // ③ 要在**任何**位置找压缩边界，所以顺带扫一遍 JSON 文本本身。
    if (JSON.stringify(o).includes('compact_boundary')) compactHits.push(`${type}(JSON 里含 compact_boundary)`)

    if (typeof o.ttft_ms === 'number') ttftValues.push(o.ttft_ms)

    const ev = asObj(o.event)
    if (ev) {
      if (typeof ev.type === 'string' && ev.type.startsWith('content_block_')) blockOrder.push(ev.type)
      const delta = asObj(ev.delta)
      if (delta && delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length) {
        thinkingDeltaTexts.push(delta.thinking)
      }
      if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') textParts.push(delta.text)
    }

    const msg = asObj(o.message)
    const content = msg ? msg.content : null
    if (Array.isArray(content)) {
      let textBlocks = 0
      for (const c of content) {
        const b = asObj(c)
        if (!b) continue
        if (b.type === 'text') {
          textBlocks += 1
          if (typeof b.text === 'string') textParts.push(b.text)
        }
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length) {
          assistantThinkingTexts.push(b.thinking)
        }
        if (b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Write' || b.name === 'MultiEdit')) {
          // ★ ⑦ 要留档的正是这个：`file_diff` 唯一可能的来源（§4.3 补记 ③）。
          editWriteInputs.push({ name: String(b.name), input: b.input })
        }
      }
      if (textBlocks > 0) assistantTexts.push(textBlocks)
    }

    if (type === 'result') {
      resultSubtype = typeof o.subtype === 'string' ? o.subtype : null
      usage = asObj(o.usage)
      if (typeof o.total_cost_usd === 'number') costUsd = o.total_cost_usd
      // ★ 终态行上还有几样我们原本不知道的东西（实测逼出来的，见 §8.8d）：
      // `terminal_reason`（CLI 自己给的结论词）、`num_turns`、`modelUsage.<model>.contextWindow`
      // （**这就是「这个端点的真实窗口是多少」的答案**）、`permission_denials`。
      const modelUsage = asObj(o.modelUsage)
      const firstModel = modelUsage ? asObj(Object.values(modelUsage)[0]) : null
      resultFields.terminalReason = typeof o.terminal_reason === 'string' ? o.terminal_reason : null
      resultFields.isError = typeof o.is_error === 'boolean' ? o.is_error : null
      resultFields.errorText = o.is_error === true && typeof o.result === 'string' ? o.result : null
      resultFields.numTurns = typeof o.num_turns === 'number' ? o.num_turns : null
      resultFields.durationMs = typeof o.duration_ms === 'number' ? o.duration_ms : null
      resultFields.contextWindow = firstModel && typeof firstModel.contextWindow === 'number' ? firstModel.contextWindow : null
      resultFields.permissionDenials = Array.isArray(o.permission_denials) ? o.permission_denials.length : 0
    }

    const line = JSON.stringify(o)
    if (line.includes('CLAUDE.md')) claudeMdLines.push(quote(line, 320))
  }

  // ── 标记串的归属：它第一次出现在**哪一类行**里 ──
  //
  // ★ 这是探针④唯一站得住的判据，而我第一版把它写错了。
  // 我一开始只是问「模型的回答里有没有这个标记」—— 那是**假阳性**：
  // `--add-dir` 给了工具访问权，所以模型完全可以自己 Read 那个文件再复述出来，
  // 而那条路径与「CLI 自动把它注入上下文」是**两件完全不同的事**。
  //
  // 归档里的分界线是硬的：内容若来自自动注入，它第一次出现时**周围没有任何 tool_result**；
  // 若是模型自己读来的，它第一次出现**必然在某条 tool_result 里**。
  // 所以逐行看类型即可判定，不需要相信模型的自述（自述只作旁证）。
  const markerFirst: MarkerEvidence[] = []
  for (const marker of Object.values(MARKERS)) {
    for (let li = 0; li < lines.length; li += 1) {
      if (!lines[li].includes(marker)) continue
      const o = asObj(safeParse(lines[li]))
      if (o && o.type === 'result') continue // 终态行是模型自己的复述，不算证据
      const blocks = (() => {
        const msg = o ? asObj(o.message) : null
        return msg && Array.isArray(msg.content) ? msg.content : []
      })()
      const isToolResult =
        o?.type === 'user' && blocks.some((c) => asObj(c)?.type === 'tool_result')
      markerFirst.push({
        marker,
        line: li + 1,
        where: isToolResult ? 'tool_result' : o?.type === 'assistant' ? 'assistant' : 'other',
        excerpt: quote(lines[li], 200)
      })
      break
    }
  }

  return {
    totalLines: lines.length,
    nonJsonLines,
    typeHist: [...typeHist].sort((a, b) => b[1] - a[1]),
    systemSubtypes: [...systemSubtypes],
    ttftValues,
    markerFirst,
    resultFields,
    thinkingDeltaTexts,
    assistantThinkingTexts,
    compactHits,
    blockOrder,
    assistantTexts,
    editWriteInputs,
    usage,
    costUsd,
    resultSubtype,
    claudeMdLines,
    assistantText: textParts.join('')
  }
}

// ─────────────────────────────────────────────────────────────
// 一轮真跑
// ─────────────────────────────────────────────────────────────

interface TurnResult {
  events: AgentEvent[]
  diagnostics: readonly AgentDiagnostic[]
  raw: string
  analysis: RawAnalysis
  archivePath: string
  wallMs: number
  /**
   * 从 spawn 到**第一块 stdout 字节**的毫秒数 —— 也就是真正的冷启动。
   *
   * 我第一版拿 CLI 自报的 `ttft_ms` 当冷启动，那是错的：`ttft_ms` 是**一次 API 请求**
   * 的首字延迟，一轮里会有好几个，而且完全不含加载那 237MB 二进制、握手、鉴权的开销。
   * 真正的冷启动只有从我们的管道这头才量得到。`null` = 一个字节都没收到（被杀/报错）。
   */
  firstChunkMs: number | null
  peakRssBytes: number | null
  timedOut: boolean
}

/** 生产宽限期的缩短版 —— 探针只关心「阶梯收得回来」，不关心它等了几秒。 */
const PROBE_TIMINGS: KillTimings = { interruptGraceMs: 3000, gracefulGraceMs: 3000 }

/**
 * 子进程的峰值工作集。
 *
 * ⚠️ Windows 上拿不到别人的 RSS：`process.memoryUsage()` 只说本进程，
 * 而 `wmic` 在 Win11 26200 已被移除。所以走 `tasklist`。
 * 非 Windows 返回 `null` —— 这一项只在 Windows 上有实测值，报告里如实标出。
 */
async function sampleRss(pid: number): Promise<number | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 10_000
    })
    const m = /"([\d.,\s]+ K)"/.exec(stdout)
    if (!m) return null
    const kb = Number(m[1].replace(/[^\d]/g, ''))
    return Number.isFinite(kb) ? kb * 1024 : null
  } catch {
    return null
  }
}

function describeEvent(ev: AgentEvent): string {
  // 穷尽的 switch：`AgentEvent` 加一个新的 `k` 时这里会直接编译不过 —— 刻意的。
  switch (ev.k) {
    case 'session_started':
      return `session_started session=${ev.sessionId} model=${ev.model} permissionMode=${JSON.stringify(ev.permissionMode)} tools=${ev.tools.length}`
    case 'status_changed':
      return `status_changed ${ev.status}`
    case 'thinking_delta':
      return `thinking_delta[${ev.block}] ${quote(ev.text)}`
    case 'thinking_end':
      return `thinking_end[${ev.block}]`
    case 'text_delta':
      return `text_delta[${ev.block}] ${quote(ev.text)}`
    case 'tool_start':
      return `tool_start ${ev.name} ${quote(JSON.stringify(ev.input) ?? '', 240)}`
    case 'tool_result':
      return `tool_result ok=${ev.ok}${ev.structured ? ' +structured' : ''} ${quote(ev.output)}`
    case 'usage':
      return `usage in=${ev.in} out=${ev.out} cacheRead=${ev.cacheRead ?? '-'} cacheCreation=${ev.cacheCreation ?? '-'} thinking=${ev.thinkingTokens ?? '-'} cost=$${ev.costUsd ?? '-'}`
    case 'error':
      return `❗ error ${ev.code} fatal=${ev.fatal} ${quote(ev.message, 400)}`
    case 'done':
      return `done reason=${ev.reason}`
  }
}

interface RunTurnOpts {
  label: string
  ctx: TurnContext
  /** 墙钟上限。到点就 abort，走中断阶梯 —— 这才是成本的真正兜底（见文件头）。 */
  timeoutMs: number
  extraArgs?: string[]
  /** 只在这一轮临时生效的环境变量（跑完还原）。 */
  env?: Record<string, string>
  /** 见 `claude-adapter.ts` 的 `closeStdinOnResult`；默认 `true`（生产取值）。 */
  closeStdinOnResult?: boolean
}

async function runTurn(opts: RunTurnOpts): Promise<TurnResult> {
  const { ctx } = opts
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  const registry = createChildRegistry()
  const chunks: string[] = []
  const events: AgentEvent[] = []
  // t0 必须在**建适配器之前**：第一块字节可能来得极快，晚一刻钟计时就少一刻钟。
  const t0 = Date.now()
  let firstChunkMs: number | null = null
  const adapter = createClaudeAdapter({
    registry,
    extraArgs: opts.extraArgs,
    timings: PROBE_TIMINGS,
    closeStdinOnResult: opts.closeStdinOnResult,
    onRawChunk: (t) => {
      if (firstChunkMs === null) firstChunkMs = Date.now() - t0
      chunks.push(t)
    }
  })

  const ctrl = new AbortController()
  registry.registerCancel(ctx.turnId, ctrl)

  let peakRssBytes: number | null = null
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const pid = registry.handleOf(ctx.turnId)?.pid
      if (pid && pid > 0) {
        const r = await sampleRss(pid)
        if (r !== null) peakRssBytes = Math.max(peakRssBytes ?? 0, r)
      }
      await sleep(400)
    }
  })()

  let timedOut = false
  const soft = setTimeout(() => {
    timedOut = true
    say(`  ⏱️ 墙钟超时（${opts.timeoutMs}ms）—— 走中断阶梯收尾`)
    ctrl.abort()
  }, opts.timeoutMs)

  const drain = (async () => {
    for await (const ev of adapter.run(ctx, ctrl.signal)) {
      events.push(ev)
      say(`  ${describeEvent(ev)}`)
    }
  })()

  // 硬兜底：连阶梯都没能把它收回来（理论上不该发生，发生了说明阶梯本身有洞）。
  const hardMs = opts.timeoutMs + 30_000
  const outcome = await Promise.race([drain.then(() => 'drained' as const), sleep(hardMs).then(() => 'hard' as const)])
  clearTimeout(soft)
  sampling = false
  await sampler

  if (outcome === 'hard') {
    say(`  ❌ 硬超时：阶梯没能在 ${hardMs}ms 内收回这一轮。直接杀树并退出。`)
    await registry.killTree(ctx.turnId, { timings: PROBE_TIMINGS }).catch(() => undefined)
    // 归档先落盘再退 —— 出问题的这一轮恰恰是最该留下证据的那一轮。
    await writeFile(archivePathOf(opts.label), chunks.join(''), 'utf8').catch(() => undefined)
    process.exit(2)
  }

  const wallMs = Date.now() - t0
  const raw = chunks.join('')
  const archivePath = archivePathOf(opts.label)
  await writeFile(archivePath, raw, 'utf8')

  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  return {
    events,
    diagnostics: adapter.diagnosticsOf(ctx.turnId),
    raw,
    analysis: analyzeRaw(raw),
    archivePath,
    wallMs,
    firstChunkMs,
    peakRssBytes,
    timedOut
  }
}

// ─────────────────────────────────────────────────────────────
// 工作区
// ─────────────────────────────────────────────────────────────

/**
 * 归档目录。**刻意不叫 `out/`** —— 仓库根的 `.gitignore` 里有一条 `out/`
 * （本意是 electron-vite 的构建产物），而 gitignore 的模式**匹配任意层级**，
 * 于是 `scripts/out/` 会被**安静地**忽略掉：证据在盘上，却永远进不了版本库，
 * 而「留档」这件事看起来是做了的。改名 + 显式规则，让它是被决定的，不是被撞上的。
 */
const OUT_DIR = join(import.meta.dirname, 'evidence')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUN_DIR = join(OUT_DIR, `m5-${STAMP}`)

function archivePathOf(label: string): string {
  return join(RUN_DIR, `${label}.ndjson`)
}

/** 三个标记串 —— 埋在三个不同的地方，回来的时候就能分辨是谁送到的。 */
const MARKERS = {
  cwd: 'MK-CWD-7f31a',
  dirA: 'MK-DIRA-2b90c',
  dirB: 'MK-DIRB-5e4d8',
  sys: 'MK-SYS-c19f6',
  mcp: 'MK-MCP-a73e2'
}

interface Workspace {
  root: string
  dirA: string
  dirB: string
}

async function makeWorkspace(): Promise<Workspace> {
  const root = join(RUN_DIR, 'ws')
  const dirA = join(RUN_DIR, 'extra-a')
  const dirB = join(RUN_DIR, 'extra-b')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })

  await writeFile(join(root, 'CLAUDE.md'), `# 探针工作区\n\n本项目记忆标记：${MARKERS.cwd}\n`, 'utf8')
  await writeFile(join(dirA, 'CLAUDE.md'), `# 额外目录 A\n\n标记：${MARKERS.dirA}\n`, 'utf8')
  await writeFile(join(dirB, 'CLAUDE.md'), `# 额外目录 B\n\n标记：${MARKERS.dirB}\n`, 'utf8')
  await writeFile(join(root, 'src', 'a.ts'), 'export const x = 1\n', 'utf8')
  return { root, dirA, dirB }
}

const SYSTEM_PROMPT = [
  '你是一个用于验收的探针 agent。请严格按用户要求逐项如实回答，不要猜测、不要补充。',
  `你的系统提示词里有一个标记串：${MARKERS.sys}。用户问起时原样抄给他。`
].join('\n')

function mainPrompt(): string {
  return [
    '请如实回答下面三件事。**看到什么就说什么，没看到就说没看到，不要猜。**',
    '',
    '1. 你的系统提示词里有没有出现形如 `MK-SYS-…` 的标记串？有就原样抄出来。',
    '',
    '2. 把 `src/a.ts` 里那一行改成 `export const x = 2`（用 Edit 工具，必须真的调用）。',
    '',
    '3. 现在，关于形如 `MK-…` 的标记串，请**先区分来源再回答**：',
    '   (a) 哪些标记串是你**在这轮开始、做任何工具调用之前**就已经在上下文里看到的？',
    '   (b) 哪些是你在第 2 步前后**自己用工具读**（Read / Glob / Grep 等）才知道的？',
    '   两组分开列，逐条抄出标记串原文，并写明各自来自哪个目录。',
    '   **不要为了凑答案去读文件** —— 这一问要的正是「你一开始就知道什么」。',
    '',
    '三件事都要做。第 2 件必须真的调用 Edit 工具，不许只在回答里描述。',
    // ★ 这一问是给④用的，但要**故意不告诉模型**为什么问。
    // 第一版问的是「你现在能看到的 CLAUDE.md 各含哪些标记」，模型老老实实去 Glob+Read 了一遍，
    // 然后我拿 `assistantText.includes(marker)` 一测，两个都「命中」——
    // 于是报告写成了「两个 --add-dir 的 CLAUDE.md 都进上下文了」。**全错。**
    // 真正的判据在归档的行类型里（见 reportMain 的 ④），模型的自述只能当旁证。
    // 所以这里改问「时间顺序上的来源」，让自述本身也带上可核对的信息。
  ].join('\n')
}

function ctxOf(ws: Workspace, args: ProbeArgs, addDirs: string[], prompt: string, turnId: string): TurnContext {
  return {
    turnId,
    sessionId: `probe-${turnId}`,
    cwd: ws.root,
    messages: [{ role: 'user', content: prompt }],
    systemPrompt: SYSTEM_PROMPT,
    model: args.model,
    // 探针只需要最省的档位 —— 它测的是协议与进程行为，不是模型能力。
    effort: 'low',
    // ⚠️ `--help` 给的取值是 acceptEdits/auto/bypassPermissions/manual/dontAsk/plan，
    // **没有 `default`** —— 而 `system:init` 回报的恰恰是 `"default"`（§2.3-3）。
    permissionMode: 'acceptEdits',
    maxBudgetUsd: args.budget,
    addDirs
  }
}

// ─────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────

function reportEnvironment(model: string, budget: number, contextTokens: number | null, exe: string | null): void {
  rule('环境')
  say(`  node            ${process.version} (${process.platform} ${process.arch})`)
  if (exe) {
    let size = '?'
    try {
      size = `${statSync(exe).size.toLocaleString('en-US')} 字节`
    } catch {
      /* 大小读不到不影响其余 */
    }
    say(`  CLI             ${exe}  (${size})`)
  } else {
    say('  CLI             ❌ 没找到（下面几项跑不了）')
  }
  say(`  模型            ${model}`)
  say(`  预算硬闸        $${budget}  ⚠️ §2.4-2：这个端点上的 cost 字段不可信，真正的兜底是墙钟超时`)
  say(`  上下文窗口      ${contextTokens === null ? '未设置（CLAUDE_CODE_MAX_CONTEXT_TOKENS 未设 → ③ 不可解读）' : String(contextTokens)}`)
  // ── 端点溯源：只报「设了没有」，**绝不回显凭据本身** ──
  const envFlag = (k: string): string => (process.env[k] ? '已设置' : '未设置（不打印内容）')
  say(`  ANTHROPIC_BASE_URL      ${process.env.ANTHROPIC_BASE_URL ?? '未设置'}`)
  say(`  ANTHROPIC_AUTH_TOKEN    ${envFlag('ANTHROPIC_AUTH_TOKEN')}`)
  say(`  ANTHROPIC_API_KEY       ${envFlag('ANTHROPIC_API_KEY')}`)
  say(`  CODE_CHAT_CLAUDE_PATH   ${process.env.CODE_CHAT_CLAUDE_PATH ?? '未设置'}`)
  say('  ↑ 环境变量都没设时，凭据来自 CLI 自己的配置文件 —— **探针不读那个文件、也不回显任何凭据**。')
  say('   所以「本机默认端点是谁」这句话在本次运行里的含义是：CLI 自己会用的那个。')
}

function reportArchive(label: string, r: TurnResult): void {
  rule(`${label}：归档与独立复读`)
  say(`  墙钟            ${r.wallMs}ms${r.timedOut ? '（⚠️ 触碰了墙钟超时）' : ''}`)
  say(`  原始 NDJSON     ${r.archivePath}（${r.raw.length} 字节，${r.analysis.totalLines} 行）`)
  say()
  say('  行类型直方图（**这是独立复读出来的**，不是解析器的产物）：')
  for (const [t, n] of r.analysis.typeHist) say(`      ${t.padEnd(16)} ${n}`)
  if (r.analysis.systemSubtypes.length) {
    say(`  system 子类型   ${r.analysis.systemSubtypes.map(([k, v]) => `${k}×${v}`).join('  ')}`)
  }
  if (r.analysis.nonJsonLines.length) {
    say(`  非 JSON 行      ${r.analysis.nonJsonLines.length} 条（§2.3-1 实测形态）`)
    for (const l of r.analysis.nonJsonLines.slice(0, 5)) say(`      ${quote(l, 160)}`)
  }
  if (r.diagnostics.length) {
    say(`  解析器诊断      ${r.diagnostics.length} 条`)
    for (const d of r.diagnostics.slice(0, 12)) say(`      [${d.level}] ${d.tag}: ${quote(d.message, 140)}`)
  }
}

/**
 * 这一轮的终态是不是**失败**。
 *
 * ★ 这个判断是必须的，因为「这一轮失败了」会让下面各节的每一条 ✅/❌ 全部失效 ——
 * 模型根本没得到机会回答，那⑥ 的「没收到系统提示词」就不是结论，只是**没测**。
 * 我是在重放 `compact` 归档时才看见这个坑的：它把一次 `Prompt is too long` 印成了
 * `❌ --append-system-prompt-file 没生效` —— 一个纯属虚构的结论，而且看起来很像真的。
 */
function failedTurn(a: RawAnalysis): string | null {
  if (a.resultFields.isError === true) return a.resultFields.errorText ?? '(CLI 自报失败但没给原因)'
  const t = a.resultFields.terminalReason
  if (t !== null && /block|limit|error|fail/i.test(t)) return `terminal_reason=${t}`
  return null
}

function reportMain(r: TurnResult): void {
  const a = r.analysis
  const failure = failedTurn(a)
  if (failure !== null) {
    rule('⚠️ 这一轮的终态是失败 —— 下面各节的 ✅/❌ 一律不成立')
    say(`  CLI 自报：${failure}`)
    say(`  terminal_reason=${a.resultFields.terminalReason ?? '-'}  is_error=${a.resultFields.isError ?? '-'}  ` +
      `num_turns=${a.resultFields.numTurns ?? '-'}  duration_ms=${a.resultFields.durationMs ?? '-'}`)
    say('  **模型没有得到机会回答**，所以「⑥ 没收到系统提示词」之类的话在这里都不是结论，只是没测。')
    say('  要看 ①②④⑥⑦ 的结论，必须拿一轮**真的跑完**的归档（例如 main.ndjson）。')
    return
  }
  rule('① 冷启动与峰值 RSS')

  // ⚠️ 我第一版只取了**第一个** ttft_ms 当作「冷启动」，那是错的：实测它挂在
  // 每个 `stream_event/message_start` 上（一次 API 请求一个），终态行上另有一个。
  // 「冷启动」是客户端的事，只能用**从 spawn 到第一块 stdout** 来量。
  if (r.firstChunkMs !== null) {
    check('ok', `冷启动：从 spawn 到第一块 stdout **${r.firstChunkMs}ms**（含加载 237MB 二进制、握手、鉴权）`)
  } else {
    check('unknown', '没量到首块 stdout 的时间')
  }
  if (a.ttftValues.length) {
    say(`      CLI 自报的 ttft_ms（**一次 API 请求一个**，共 ${a.ttftValues.length} 个）：${a.ttftValues.join(', ')} ms`)
    say('      ↑ 最后一个来自终态行，是**整轮汇总**口径；前面的才是单次请求的首字延迟。')
  } else {
    check('unknown', '归档里没有 ttft_ms —— 该端点/该 CLI 版本没有吐它')
  }
  say(`      本轮墙钟 ${r.wallMs}ms；终态行自报 duration_ms=${a.resultFields.durationMs ?? '?'}ms、num_turns=${a.resultFields.numTurns ?? '?'}`)
  if (r.peakRssBytes !== null) {
    check('ok', `峰值工作集 ${(r.peakRssBytes / 1024 / 1024).toFixed(1)} MiB（tasklist 采样）`)
  } else {
    check('unknown', '峰值 RSS 没采到（非 Windows，或进程活得太短）')
  }
  if (a.resultFields.contextWindow !== null) {
    check('ok', `★ 端点自报的上下文窗口 = **${a.resultFields.contextWindow}** tokens（终态行的 modelUsage）—— 这就是 §2.4-3 那个未知量`)
  }

  rule('② `thinking_delta` 是否真带正文')
  if (a.thinkingDeltaTexts.length) {
    check('ok', `带正文，共 ${a.thinkingDeltaTexts.length} 段`)
    say(`      例：${quote(a.thinkingDeltaTexts[0])}`)
  } else if (a.assistantThinkingTexts.length) {
    check('bad', `**增量里没有正文**，只有完整 assistant 块里才有（${a.assistantThinkingTexts.length} 段）`)
    say('      → §5.7 的结论：观感来自增量还是完整块，必须按这个事实决定')
  } else {
    check('unknown', '这一轮压根没有 thinking 内容 —— 该端点可能不返回思考')
  }

  rule('④ CLAUDE.md 到底是自动注入，还是模型自己读的？')
  say('  判据是**归档里那一行的类型**，不是模型的自述：')
  say('  · 第一次出现时周围没有 tool_result → 它在模型动手之前就在上下文里 = 自动注入')
  say('  · 第一次出现在某条 tool_result 里 → 是模型自己 Read/Glob 来的，与注入无关')
  say('  · 整轮都没出现 → 它压根没进过上下文')
  say('  ⚠️ 「被自动注入」本身不是坏事，**但它决定了 M7 显式注入会不会撞车**：')
  say('     自动注入了 + 我们再显式注入 = 同一份内容进两遍。所以下面按这个后果判 ✅/❌。')
  const label: Record<string, string> = { cwd: 'cwd/CLAUDE.md', dirA: '--add-dir A', dirB: '--add-dir B' }
  for (const [key, name] of Object.entries(label)) {
    const marker = MARKERS[key as keyof typeof MARKERS]
    const ev = a.markerFirst.find((m) => m.marker === marker)
    if (!ev) {
      // 缺席也是证据，而且方向明确：没进上下文 = 没被注入。
      // 前提是这一轮的提问确实要求模型列标记串（mainPrompt 的 (a)/(b) 两问就是干这个的）。
      check('ok', `${name} → 整轮**从未出现** ⇒ **没有**被自动注入，M7 显式注入它不会撞`)
    } else if (ev.where === 'tool_result') {
      check('ok', `${name} → **工具读到的**（第 ${ev.line} 行的 tool_result）⇒ **没有**被自动注入`)
    } else if (ev.where === 'assistant') {
      check('bad', `${name} → 第 ${ev.line} 行就出现在 assistant 里、且之前没有 tool_result ＝ **被自动注入了** ⇒ M7 若再显式注入同一个文件，**内容会进两遍**`)
    } else {
      check('unknown', `${name} → 第 ${ev.line} 行（${ev.where}），判据不明确`)
    }
    if (ev) say(`      ${ev.marker} @ ${ev.line}`)
  }
  say('  → 结论要分两半说（**第一版报告在这里把两半混成了一句，是错的**）：')
  say('     · `--add-dir` 的 CLAUDE.md：**不进上下文**（给的是工具可及范围）⇒ 显式注入不会重复；')
  say('     · **cwd 的 CLAUDE.md：会被 CLI 自动注入** ⇒ M7 若把 cwd/CLAUDE.md 也塞进')
  say('       `systemPrompt`，就是实打实的重复 —— 这半边 §8.5c 得给个说法（注入前先看 cwd 那份？）。')
  if (a.resultFields.permissionDenials > 0) {
    say(`  （旁证：终态行报告了 ${a.resultFields.permissionDenials} 次权限拒绝 —— 模型想枚举工作目录的父目录被挡了。）`)
  }
  if (a.claudeMdLines.length) {
    say('  CLI 自己提到 CLAUDE.md 的地方：')
    for (const l of a.claudeMdLines.slice(0, 3)) say(`      ${l}`)
  }

  rule('⑥ `--append-system-prompt-file` 的内容角色是否真收到')
  // ⑥ 的判据和 ④ 不一样，而且**这里可以信模型的复述**：`MK-SYS-…` 是随机串，
  // 只存在于系统提示词里，模型**没有任何工具**能读到它 —— 复述对了就只能是收到了。
  // （④ 之所以不能这么判，正因为那些标记躺在文件里、模型读得到。）
  if (a.assistantText.includes(MARKERS.sys)) {
    check('ok', `收到了 —— 模型逐字复述出了 ${MARKERS.sys}（它没有任何途径读到这个串）`)
  } else {
    check('bad', `**没收到**：模型没能复述 ${MARKERS.sys}`)
    say('      → 若确认，file 版与 Clowder 实测证伪的内联版是同一个失效：静默且不报错。')
  }
  say('  模型的原话（截断）：')
  say(`      ${quote(a.assistantText, 900)}`)

  rule('⑦ §4.3 追问的三件事 + 真实 Edit 输入')
  const blockKinds = a.blockOrder.filter((k) => k === 'content_block_start')
  say(`  内容块顺序      ${blockKinds.length} 个块（按 content_block_start 计）`)
  say(`  每轮 text 块数  ${a.assistantTexts.join(', ') || '（没有 assistant 完整块）'}`)
  if (a.assistantTexts.length) {
    const maxText = Math.max(...a.assistantTexts)
    check(maxText > 1 ? 'ok' : 'unknown', `单次 assistant 消息里最多 ${maxText} 段 text`)
    say('      → 「整轮最多几段 text」的答案决定 `textMode` 能不能只留最后一段。')
  }
  if (a.editWriteInputs.length) {
    check('ok', `拿到真实 Edit/Write 输入 ${a.editWriteInputs.length} 条 —— 这就是 \`file_diff\` 唯一的来源（§4.3 补记 ③）`)
    for (const e of a.editWriteInputs.slice(0, 3)) say(`      ${e.name} ${quote(JSON.stringify(e.input) ?? '', 300)}`)
  } else {
    check('unknown', '这一轮没有 Edit/Write 输入留档 —— `file_diff` 的来源仍未见到真东西')
  }
}

function reportCost(r: TurnResult): void {
  const u = r.analysis.usage
  say()
  say('  成本与 token（§2.4-2：**这个端点上的 cost 不可信**，所以 token 数必须一起打出来对账）：')
  if (u) {
    const pick = (k: string): string => (typeof u[k] === 'number' ? String(u[k]) : '-')
    say(`      input=${pick('input_tokens')}  output=${pick('output_tokens')}`)
    say(`      cache_read=${pick('cache_read_input_tokens')}  cache_creation=${pick('cache_creation_input_tokens')}`)
    const det = asObj(u.output_tokens_details)
    say(`      thinking_tokens=${det && typeof det.thinking_tokens === 'number' ? det.thinking_tokens : '-'}`)
  } else {
    say('      ⚠️ 归档里没有 result 行的 usage —— 这一轮可能被中断了')
  }
  say(`      result.subtype = ${r.analysis.resultSubtype ?? '(无 result 行)'}`)
  say(`      total_cost_usd = ${r.analysis.costUsd ?? '(缺失)'}  ← 仅供参考，不要拿它做判断`)
}

// ─────────────────────────────────────────────────────────────
// 步骤
// ─────────────────────────────────────────────────────────────

async function stepMain(ws: Workspace, args: ProbeArgs): Promise<void> {
  rule('main：一轮真实对话（覆盖 ①②④⑥⑦）')
  say(`  工作区          ${ws.root}`)
  say(`  --add-dir       ${ws.dirA}`)
  say(`                  ${ws.dirB}`)
  say('  埋了五个标记串：cwd 的 CLAUDE.md、两个 --add-dir 的 CLAUDE.md、系统提示词、MCP 工具返回值。')
  say('  三个 CLAUDE.md 的标记互不相同 —— 回来的时候就能分辨是谁送到的。')
  say()

  const ctx = ctxOf(ws, args, [ws.dirA, ws.dirB], mainPrompt(), 'main')
  const r = await runTurn({ label: 'main', ctx, timeoutMs: args.turnTimeoutMs })
  reportArchive('main', r)
  reportMain(r)
  reportCost(r)
  say()
  say(`  改后的 a.ts：${quote(await readFile(join(ws.root, 'src', 'a.ts'), 'utf8').catch(() => '(读不到)'), 120)}`)
}

async function stepCompact(ws: Workspace, args: ProbeArgs): Promise<void> {
  rule('compact：③ 压缩边界（**这一步是唯一花费不定的**）')
  // ⚠️ `--help` 说 `--autocompact` 的取值下限是 **100k**。所以**默认不传它** ——
  // 传一个小于下限的值大概率只是被拒，而那会浪费一整轮。默认只设 §5.3 记的那个环境变量；
  // 用户显式给了 `--context-tokens=` 才认为他知道自己在干什么，那时才一起传。
  say(`  CLAUDE_CODE_MAX_CONTEXT_TOKENS = ${args.contextTokens ?? 20000}`)
  say(`  --autocompact                  ${args.contextTokens === null ? '不传（未显式指定窗口；下限是 100k）' : String(args.contextTokens)}`)
  say('  ⚠️ 传了小于 100k 的 autocompact 大概率会被 CLI 拒掉 —— 那本身也是结论：')
  say('     ③ 在小预算下**做不到**，要花的是十万 token 级的钱。')

  const ctx = ctxOf(ws, args, [ws.dirA, ws.dirB], mainPrompt(), 'compact')
  const tokens = args.contextTokens ?? 20000
  const r = await runTurn({
    label: 'compact',
    ctx,
    timeoutMs: args.turnTimeoutMs,
    extraArgs: args.contextTokens === null ? [] : ['--autocompact', String(tokens)],
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(tokens) }
  })
  reportArchive('compact', r)
  rule('③ 是否出现 `system:compact_boundary`')
  if (r.analysis.compactHits.length) {
    check('ok', `出现了：${r.analysis.compactHits.join(', ')}`)
  } else {
    check('unknown', `没有出现（窗口按 ${tokens} 算）。`)
    say('      → 这不等于「CLI 不会压缩」，只等于「这次的上下文没到边界」。')
  }
  reportCost(r)
}

async function stepMcp(ws: Workspace, args: ProbeArgs): Promise<void> {
  rule('⑤ `--mcp-config` 动态挂载')
  const server = join(import.meta.dirname, 'fixtures', 'mcp-probe-server.cjs')
  const logFile = join(RUN_DIR, 'mcp-server.log')
  const configFile = join(RUN_DIR, 'mcp.json')
  const config = {
    mcpServers: {
      m5probe: { command: process.execPath, args: [server, '--log', logFile, '--marker', MARKERS.mcp] }
    }
  }
  await writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')

  // ── 先试**文件**形态：`--help` 说 `--mcp-config <configs...>`「Load MCP servers from JSON files or strings」──
  say(`  配置文件        ${configFile}`)
  say(`  server 日志     ${logFile}（它自己被 spawn 过没有，也只会写在这里）`)
  const prompt = `请调用 mcp__m5probe__probe_ping 工具（它不接受参数），把它返回的标记串原样抄给我。如果这个工具不存在，就说「没有这个工具」。`

  const ctx = ctxOf(ws, args, [ws.dirA], prompt, 'mcp')
  const r = await runTurn({
    label: 'mcp-file',
    ctx,
    timeoutMs: args.turnTimeoutMs,
    extraArgs: [
      '--mcp-config',
      configFile,
      // 只放行这一个工具 —— 探针不该顺手把别的权限也开出去。
      '--allowedTools',
      'mcp__m5probe__probe_ping',
      // `-p` 模式下没人回答权限询问；显式说「没人回答，该拒就拒」，
      // 免得探针卡在一个永远等不到回答的询问上（那就是一次纯浪费的墙钟超时）。
      '--permission-prompts',
      'none'
    ]
  })
  reportArchive('mcp-file', r)

  const log = await readFile(logFile, 'utf8').catch(() => '')
  const called = /tools\/call/.test(log)
  if (log) {
    check('ok', `MCP server **被真的 spawn 了**（日志 ${log.split('\n').filter(Boolean).length} 行）`)
    say(`      ${quote(log, 300)}`)
  } else {
    check('bad', 'MCP server 的日志文件根本没生成 —— 配置多半没生效（连进程都没起）')
  }
  if (called) {
    check('ok', '`tools/call` 发生过 —— 工具真的被调用了')
  } else {
    check('unknown', '没有 `tools/call` —— 挂载成功但模型没调，或挂载就没成功（两者靠上面的日志区分）')
  }
  check(r.analysis.assistantText.includes(MARKERS.mcp) ? 'ok' : 'unknown', `模型复述里${r.analysis.assistantText.includes(MARKERS.mcp) ? '出现了' : '**没有**'} ${MARKERS.mcp}`)
  reportCost(r)

  rule('⑤b 内联 JSON 在 Windows 上会不会被当成路径')
  const inline = JSON.stringify(config)
  say('  这一次**故意**只传内联 JSON 字符串，看它是被解析成配置还是被当成文件路径。')
  const ctx2 = ctxOf(ws, args, [], prompt, 'mcp-inline')
  const r2 = await runTurn({
    label: 'mcp-inline',
    ctx: ctx2,
    timeoutMs: args.turnTimeoutMs,
    extraArgs: ['--mcp-config', inline, '--allowedTools', 'mcp__m5probe__probe_ping', '--permission-prompts', 'none']
  })
  reportArchive('mcp-inline', r2)
  const inlineLog = r2.analysis.assistantText.includes(MARKERS.mcp)
  const pathish = r2.events.some((e) => e.k === 'error')
  if (inlineLog) check('ok', '内联 JSON 直接被当成配置解析了 —— Windows 上不必绕道临时文件')
  else if (pathish) check('bad', '内联 JSON 没能生效，且这一轮报了错 —— 多半是被当成路径了')
  else check('unknown', '内联 JSON 没有生效，但也没报错 —— 静默失效，最坏的一种；用文件版')
  reportCost(r2)
}

/**
 * 第⑦项之外的自查：**CLI 在 `result` 之后到底会不会自己退出。**
 *
 * 第一轮真跑最贵的发现就是这个：终态行自报 `duration_ms=8525`，而墙钟是 **187,172ms** ——
 * 多出来的约 171 秒全在 `result` 之后，stdin 开着，CLI 就那么等我们。最后靠 180 秒墙钟超时
 * 加中断阶梯才收回来。这不是「慢」，这是**一轮永远不会自己结束**。
 *
 * 修法是 `closeStdinOnResult`（默认 `true`）：见到终态事件就 `stdin.end()`。
 * 这一步就是验证它 —— 而且要**成对**验证：只跑修好的那一半，证明不了「不开它真会挂住」；
 * 只跑坏的那一半，证明不了「修好了」。两半都跑，墙钟差三个数量级，结论才算落地。
 *
 * 坏的那一半故意把墙钟上限压到 15 秒：挂住的代价是墙钟不是 money，
 * 而 15 秒已经足够让「终态已到、进程不走」这件事显形。
 */
async function stepStdin(ws: Workspace, args: ProbeArgs): Promise<void> {
  rule('⑧ stdin：终态之后 CLI 会不会自己退出（`closeStdinOnResult` 的成对验证）')
  const prompt = '只回答两个字：收到。不要调用任何工具。'

  say('  ── A：生产取值 closeStdinOnResult = true ──')
  const ctxA = ctxOf(ws, args, [], prompt, 'stdin-on')
  const a = await runTurn({ label: 'stdin-on', ctx: ctxA, timeoutMs: args.turnTimeoutMs })
  reportArchive('stdin-on', a)
  const durA = a.analysis.resultFields.durationMs
  if (a.timedOut) {
    check('bad', `A 也超时了 —— 关 stdin 并没有解决「终态后不退出」`)
  } else if (durA !== null) {
    check('ok', `A 自己退了：墙钟 ${a.wallMs}ms，终态自报 duration_ms=${durA}ms，差 ${a.wallMs - durA}ms`)
    say('      → 差值是收尾开销（进程退出、管道 flush），不是等待。这才是正常的形状。')
  } else {
    check('unknown', `A 没超时，但归档里没有终态行的 duration_ms（墙钟 ${a.wallMs}ms）—— 对不上账，别急着下结论`)
  }
  reportCost(a)

  say()
  say('  ── B：反向对照 closeStdinOnResult = false（**预期会挂住**）──')
  say('     上限压到 15 秒：挂住的代价是墙钟，不是钱。')
  const ctxB = ctxOf(ws, args, [], prompt, 'stdin-off')
  const b = await runTurn({
    label: 'stdin-off',
    ctx: ctxB,
    timeoutMs: 15_000,
    closeStdinOnResult: false
  })
  const durB = b.analysis.resultFields.durationMs
  const sawResult = b.analysis.resultSubtype !== null
  if (!sawResult) {
    check('unknown', 'B 连终态行都没有 —— 这一轮没能复现「终态已到、进程不走」，对照无效')
  } else if (!b.timedOut) {
    check('bad', `B **没有**挂住（墙钟 ${b.wallMs}ms）—— 那「不关 stdin 就永不结束」这个因果就还没被证明，` + 'A 的「修好了」也就没有对照物')
  } else {
    check('ok', `B 挂住了：终态自报 duration_ms=${durB ?? '?'}ms，而墙钟烧掉了 ${b.wallMs}ms（被 15 秒上限截断）`)
    say('      → 因果成立：不关 stdin，CLI 在终态之后**不退出**，靠墙钟超时 + 中断阶梯才收得回来。')
  }
  reportCost(b)
}

/**
 * 重放模式：**只读归档，不 spawn 任何东西。**
 *
 * 存在的理由是 M5 里真实发生过的一件事：报告文案写错了（④ 那一节的 ✅/❌），
 * 而修文案不需要再花一轮的钱 —— 报告本来就是归档的纯函数。
 * 把它做成一条零成本的路径，改报告就不再与"再买一轮"绑在一起。
 *
 * 这也是对「归档是唯一证据」那条纪律的兑现：**结论只能从归档里长出来**，
 * 那么只要归档还在，结论就该能被重新长一遍。
 */
async function replayArchive(path: string): Promise<void> {
  const raw = await readFile(path, 'utf8')
  rule('重放模式（--archive）：以下数字全部来自归档，**本次没有 spawn 任何进程、没有花钱**')
  say(`  归档            ${path}（${raw.length} 字节）`)
  say('  ⚠️ 重放拿不到的东西：墙钟、首块 stdout 时间、峰值 RSS、解析器诊断。')
  say('     它们不是归档的内容，是**观测那一轮时**的副产品。这里如实标成「重放不可得」。')
  const r: TurnResult = {
    events: [],
    diagnostics: [],
    raw,
    analysis: analyzeRaw(raw),
    archivePath: path,
    wallMs: 0,
    firstChunkMs: null,
    peakRssBytes: null,
    timedOut: false
  }
  say(`  行类型直方图（**独立复读**，不是解析器的产物）：`)
  for (const [t, n] of r.analysis.typeHist) say(`      ${t.padEnd(16)} ${n}`)
  if (r.analysis.systemSubtypes.length) {
    say(`  system 子类型   ${r.analysis.systemSubtypes.map(([k, v]) => `${k}×${v}`).join('  ')}`)
  }
  reportMain(r)
  reportCost(r)
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs()

  // 重放模式要在建目录、找 CLI 之前分叉 —— 它两样都不需要。
  const archive = argValue('archive')
  if (archive) {
    await replayArchive(archive)
    return
  }

  await mkdir(RUN_DIR, { recursive: true })

  rule('M5 探针')
  say(`  步骤            ${args.only.join(', ')}`)
  say(`  落档目录        ${RUN_DIR}`)

  const exe = await resolveClaude()
  reportEnvironment(args.model, args.budget, args.contextTokens, exe)
  if (args.contextTokens === null) {
    say('  ⚠️ 未设上下文窗口 → ③ 即使在归档里出现边界也无法解读（§2.4-3：这个端点的真实窗口未知）。')
  }

  if (!exe) {
    rule('找不到 CLI，剩下的都跑不了')
    const hint = await claudeSearchHint()
    say(`  找过：${hint.blindCandidates.join('\n        ')}`)
    say(`  PATH 上的 claude：${hint.whereMatches.join(', ') || '（无）'}`)
    process.exit(1)
  }

  const ws = await makeWorkspace()
  say(`  工作区          ${ws.root}`)

  if (args.only.includes('main')) await stepMain(ws, args)
  if (args.only.includes('mcp')) await stepMcp(ws, args)
  if (args.only.includes('stdin')) await stepStdin(ws, args)
  if (args.only.includes('compact')) await stepCompact(ws, args)

  rule('结束')
  say('  归档都在上面那个目录里。**结论只在「本机默认端点」下成立**，不是 Anthropic 官方行为。')
  say('  回写 docs/design.md 时逐条带上端点限定语。')
}

main().catch((err: unknown) => {
  process.stderr.write(`\n探针自己崩了：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
