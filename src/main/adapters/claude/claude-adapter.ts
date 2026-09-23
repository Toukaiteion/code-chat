import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AgentAdapter,
  AgentDiagnostic,
  AgentEvent,
  AgentHandle,
  ProjectContext,
  TurnContext
} from '../agent-adapter.ts'
import type { ChildRegistry, KillOutcome, KillTimings } from '../../process/child-registry.ts'
import { createStreamParser } from './stream-json-parser.ts'
import { PROJECT_CONTEXT_SOURCES, collectProjectContext } from './project-context.ts'
import { interruptLine, renderTurnInput, userMessageLine, writeLine } from './control-protocol.ts'
import { claudeSearchHint, invalidateClaudeCache, resolveClaude } from './cli-locator.ts'

/**
 * `ClaudeAdapter` —— 真的去 spawn 那个 237MB 的原生 `claude.exe`。
 *
 * M5 之前，这个仓库里 **`child_process.spawn` 的调用点是零**。所以这一层不是「再长一个」，
 * 而是第一次起子进程，而它同时要承担三件都不便宜的事：逐行解析对方的 NDJSON、
 * 把对方的处境翻译成我们自己的事件、以及**随时能把它那棵进程树杀干净**。
 *
 * ## ★ 本文件最要紧的一条不变量：`run()` 恰好产出一次 `done`
 *
 * 解析器只在**读到终态 `result` 行**时才吐 `done`。而中断阶梯的第 2/3 级是**硬杀**
 * （§4.4，在 Windows 上修正后见 `child-registry.ts` 的文件头）—— 杀完**根本不会有
 * `result` 行**。于是「用户点了停止」这条**最常见的非正常结束路径**上，
 * 调用方会永远等不到终态：轮次卡在 running，`turn:stop`（M9）没有事件可报，
 * 并发槽位（§4.5 的 `Semaphore(3)`）永远不释放。
 *
 * 所以终态由**适配器**兜底：进程 `close`/`error` 之后若一次 `done` 都没吐过，
 * 就按退出码与「是不是我们中断的」自己合成一个。**这条义务在适配器，不在解析器。**
 *
 * ## 可测性：`CliLaunch` 注入
 *
 * 构造参数收一个 `{ exe, preambleArgs }`，测试于是可以传
 * `{ exe: process.execPath, preambleArgs: [假 CLI 脚本的绝对路径] }` ——
 * **真 spawn、真 stdio、真解析、真中断阶梯**，只把那个 237MB 的二进制换成一个
 * 一百多行的 Node 脚本。否则这一层几乎没法测：真 CLI 要花钱、要联网、还没法假装
 * 「不回 ACK」或「忽略 SIGTERM」这种专门要测的坏行为。
 *
 * ## 那处「明知故犯」已经收口（M7a）
 *
 * 原文写的是：`renderTurnInput()` 把消息数组拍平成一条文本，「这是**暂时违反 §4.6** 的，
 * 因为『CLI 的 stream-json 输入收不收多条消息』尚未实测」。
 *
 * **M7a 测了，结论是：拍平是唯一正确的用法**，§4.6 的那句「必须逐条传递」写错了。
 * 3 行 stdin → 2 条 `result`（发 N 行 = 发 N 轮），内层 `role` 只能是 `user`
 * （逐字见 `domain/context-builder.ts` 的文件头与它引的归档）。
 *
 * ⇒ 本文件的 `userMessageLine(renderTurnInput(ctx.messages))` **保持不变，且不再是妥协**。
 * 装配那一半（历史、`<env>`、`<project_context>`、人设）由 `domain/context-builder.ts`
 * 在 M7a 补上了，`ctx.systemPrompt` 也从空串变成了真的内容。
 */

/** 生产环境为空；测试用 `process.execPath` + 假 CLI 脚本路径顶替真二进制。 */
export interface CliLaunch {
  exe: string
  preambleArgs: readonly string[]
}

export interface ClaudeAdapterOptions {
  /** 活子进程登记处。适配器把 spawn 出来的进程交给它，杀树也走它。 */
  registry: ChildRegistry
  /** 已知的启动方式。给了就跳过解析（测试与探针用）。 */
  launch?: CliLaunch
  /**
   * 解析器注入。不给就现解析（`cli-locator`）。
   *
   * ★ 它存在是为了让**「找不到 CLI」这条分支可以被安全地测**。
   * 只给一个 `launch?: CliLaunch` 的话，「没有 launch」就等于「去问本机」——
   * 而一台**真的装了** CLI 的机器上，那条用例会**真的 spawn 一个真的 claude.exe**：
   * 真凭据、真端点、真花钱，而且表现成「一个跑了三分钟的测试」。
   * 这不是假想的风险，我自己写的第一个版本就踩了（见 §8.8d）。
   */
  resolve?: () => Promise<CliLaunch | null>
  /** 阶梯宽限期。测试注入缩短，否则每个用例真等 8 秒以上。 */
  timings?: KillTimings
  /** stderr 留档上限 —— 它只用来在失败时说人话，不需要全量。 */
  stderrLimitBytes?: number
  /**
   * 收到终态 `done` 之后关掉 stdin。**默认 `true`**，而这不是个可有可无的开关 ——
   * 它是探针实测逼出来的一条修正，见下。
   *
   * 实测（`scripts/evidence/m5-…/main.ndjson`，Node 24 / Windows 11 / 本机端点）：
   * 那一轮**模型只干了 8.5 秒**（终态行自报 `duration_ms: 8525`），
   * 而那一次进程**活到了 187 秒**才被中断阶梯收走 —— 中间 171 秒它什么也没做。
   * 原因是结构性的：`--input-format stream-json` 让 stdin 成为一条**持续**的输入通道，
   * 于是 `-p` 那一轮做完之后进程**不会退出**，它还在等下一条 user 消息。
   * 归档里最后两行就是证据：`result` 之后只剩一条中断 ACK，之后再无输出。
   *
   * 为什么不在**写完提示词**时就关（那是 `closeStdinAfterPrompt`）：因为中断阶梯的
   * 第 1 级（§4.4）正是往 stdin 写 `control_request/interrupt` —— 提示词一写完就关，
   * 等于亲手把唯一的优雅中断通道焊死。**在终态到达时关**才两边都对：
   * 轮次进行中 stdin 是开的（可中断），轮次一结束它就关（进程得以自己退出）。
   */
  closeStdinOnResult?: boolean
  /**
   * 写完首条 user 消息后是否关掉 stdin。**默认 `false`。**
   *
   * 它是 `closeStdinOnResult` 的另一端，只在做实验时才打开 —— 见上面对那个选项的说明。
   */
  closeStdinAfterPrompt?: boolean
  /**
   * 原始 stdout 的**逐块**旁路（**M5 探针的接缝**，生产不用）。
   *
   * 只给探针用，理由有两个，都不是为了方便：
   * ① 决策 3 要求「原始 NDJSON 全文留档」—— 六项实测的数字以后会被反复引用，
   *    而没有原始字节，任何一个数字都没法重新解读；
   * ② 探针据此**独立复读**归档，也就是**不经过我们自己的解析器**再数一遍。
   *    用自己的解析器验自己，只能证明两者一致，证明不了两者都对。
   */
  onRawChunk?: (text: string) => void
  /**
   * 追加到 argv 末尾的额外参数（**M5 探针的接缝**）。
   *
   * 唯一用途是探针⑤：`--mcp-config` **不在** §4.4 的参数表里，因为
   * 「动态挂载 MCP 到底怎么写才对（文件？内联 JSON？Windows 上会不会被当成路径？）」
   * 正是 §8.9-11 那个待实测的问题。在拿到答案之前，不许把它写进 `buildClaudeArgs`
   * —— 写进去就等于把一个未经验证的猜测变成生产行为。
   */
  extraArgs?: readonly string[]
}

/**
 * 组装 argv。**逐字照 §4.4**，所以它是被断言的契约而不是实现细节 ——
 * 测试会直接比对这份数组。
 *
 * `preambleArgs` 插在最前面，那是给假 CLI 用的位置（生产为空数组）。
 */
export function buildClaudeArgs(ctx: TurnContext, promptFile: string, preamble: readonly string[] = []): string[] {
  const args: string[] = [
    ...preamble,
    '-p',
    // 中断能力的必要条件（§5.2）：只有开着它，stdin 才是可插话的通道。
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // 增量事件 —— 没有它就没有流式观感（但见解析器文件头：它会带来双份投递）。
    '--include-partial-messages',
    // 用 file 版绕开 Windows 命令行长度限制（§2.2 确认存在，但不在 --help 里）。
    '--append-system-prompt-file',
    promptFile,
    // 保住前缀稳定 —— 缓存命中率靠它（§4.6/§5.4）。
    '--exclude-dynamic-system-prompt-sections',
    '--model',
    ctx.model,
    '--effort',
    ctx.effort,
    '--permission-mode',
    ctx.permissionMode,
    // 应用是唯一事实源：不许 CLI 自己留会话文件。
    '--no-session-persistence',
    '--max-budget-usd',
    String(ctx.maxBudgetUsd)
  ]
  for (const dir of ctx.addDirs) {
    // 工具可及范围（§8.4/§8.5）—— **不是**上下文来源，那是 collectProjectContext 的活。
    args.push('--add-dir', dir)
  }
  return args
}

/** 按退出码与中断事实合成终态原因。 */
function synthesizedReason(exitCode: number | null, aborted: boolean): 'complete' | 'interrupted' | 'crashed' {
  if (aborted) return 'interrupted'
  // 进程自己退出且退出码为 0，但一行 `result` 都没吐 —— 只能如实说「它正常地结束了，
  // 但我们没读到结局」。这比编一个 subtype 诚实。
  if (exitCode === 0) return 'complete'
  return 'crashed'
}

type SearchHint = Awaited<ReturnType<typeof claudeSearchHint>>

/**
 * 把「找过哪里」拼进那句人话。照 `handlers/project.ts:225` 用 `gitSearchHint()` 的形状。
 *
 * 最要紧的是 `whereMatches` 与 `whereMatchDerivations` 并排显示 ——
 * 本机 `where claude` 返回的两条**都是垫片**，用户看到「PATH 上确实有 claude」
 * 和「它反推出来的 claude.exe 不存在」放在一起，才会明白这是两件事。
 */
function describeHint(hint: SearchHint): string {
  const lines: string[] = ['\n找过这些位置：']
  if (hint.override) {
    lines.push(`  · CODE_CHAT_CLAUDE_PATH = ${hint.override}（设了就只用它，没有回退）`)
  }
  if (hint.whereMatches.length) {
    lines.push('  · PATH 上匹配到 claude，但它们都不是可执行的真身：')
    hint.whereMatches.forEach((m, i) => {
      lines.push(`      ${m}  →  推导出 ${hint.whereMatchDerivations[i]}（不存在）`)
    })
  } else {
    lines.push('  · PATH 上没有任何叫 claude 的东西')
  }
  lines.push('  · 也试过这些推测位置：')
  for (const c of hint.blindCandidates) lines.push(`      ${c}`)
  lines.push('（注意：PATH 上有 claude 与 claude.exe 存在是两件事 —— npm 装的是垫片脚本，不是它本体。）')
  return lines.join('\n')
}

/**
 * 适配器 + 一条 **M5 自己的观测通道**。
 *
 * `AgentAdapter`（§8.5c 锁定的接口）里**没有诊断的位置**：`run()` 只吐 `AgentEvent`，
 * 而 `AgentDiagnostic` 按设计**不是**事件 —— 诊断若走 `error`，UI 就会为一行
 * `[claude-code:unrecognized_model]` 弹「出错了」，正是 §4.3 那条闭合联合要避免的混淆。
 *
 * 于是诊断需要一个出口，而出口**不该去改一个已锁定的接口**。所以这里用交叉类型把
 * 通道加在**具体工厂的返回值**上：`AgentAdapter` 一个字节没动，M6 的 `registry.ts`
 * 照样只认那个接口。M6 落地 `app:notice` 时再决定，它是变成事件，还是变成这条通道的正式版。
 */
export type ClaudeAdapter = AgentAdapter & {
  /** 该轮次最近一次运行产生的诊断。`run()` 开始时清空。 */
  diagnosticsOf(turnId: string): readonly AgentDiagnostic[]
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): ClaudeAdapter {
  const registry = opts.registry
  const stderrLimit = opts.stderrLimitBytes ?? 64 * 1024
  /** turnId → 该轮最近一次运行的诊断（见 `ClaudeAdapter` 的说明）。 */
  const diagnosticsByTurn = new Map<string, AgentDiagnostic[]>()

  async function resolveLaunch(): Promise<CliLaunch | null> {
    if (opts.resolve) return opts.resolve()
    if (opts.launch) return opts.launch
    const exe = await resolveClaude()
    return exe ? { exe, preambleArgs: [] } : null
  }

  async function* run(ctx: TurnContext, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const launch = await resolveLaunch()
    if (!launch) {
      // 「本机没装 CLI」是可预期的处境，不是异常 —— 所以是一句**能照着修**的人话，
      // 而不是一个错误码。找过哪里必须一起给（照 `gitSearchHint()`）。
      yield {
        k: 'error',
        code: 'cli_not_found',
        message:
          '找不到 claude 可执行文件。请确认已安装 Claude Code CLI，' +
          '或用环境变量 CODE_CHAT_CLAUDE_PATH 指定 claude.exe 的完整路径。' +
          describeHint(await claudeSearchHint()),
        fatal: true
      }
      yield { k: 'done', reason: 'crashed' }
      return
    }

    // 系统提示词落临时文件（§4.4 用的是 file 版旗标）。
    // ★ 这个文件的生命周期**归本函数所有** —— §8.9-11 问过 `--mcp-config` 的临时文件
    // 「什么时候可以删」，这里是同一个形状：不认领就会在 %TEMP% 里慢慢堆积。
    const tempDir = await mkdtemp(join(tmpdir(), 'code-chat-prompt-'))
    const promptFile = join(tempDir, 'system-prompt.md')

    let child: ChildProcess | null = null
    let killRequested = false
    let sawDone = false
    let aborted = signal.aborted
    let exitCode: number | null = null
    let spawnErrorCode: string | null = null
    let stderrBuf = ''
    // 开头清空：`diagnosticsOf` 读到的必须是**最近一次**运行的东西，
    // 否则重跑一轮会在上一次的噪声上继续堆。
    const diagnostics: AgentDiagnostic[] = []
    diagnosticsByTurn.set(ctx.turnId, diagnostics)

    /** 队列把「子进程推事件」和「生成器 yield」解耦 —— 两者节奏完全不同。 */
    const queue: AgentEvent[] = []
    let ended = false
    let notify: (() => void) | null = null
    const wake = (): void => {
      notify?.()
      notify = null
    }
    const pushAll = (evs: AgentEvent[]): void => {
      if (evs.length) {
        queue.push(...evs)
        wake()
      }
    }

    /**
     * 中断阶梯的唯一入口。**阶梯本身只有一份实现，在 `child-registry` 里** ——
     * 这里只提供载荷形状（`control_request` 长什么样只有适配器知道）。
     *
     * 回调里**只置位、不 await**：`abort` 事件是同步派发的，在这里等一条最长 8 秒的
     * 阶梯会把事件循环和信号派发一起卡住。真正的等待在下面的泵循环里做。
     */
    const requestKill = (): void => {
      aborted = true
      killRequested = true
      wake()
    }

    const killTree = (): Promise<KillOutcome | null> =>
      registry.killTree(ctx.turnId, {
        timings: opts.timings,
        sendInterrupt: (c) => writeLine(c.stdin, interruptLine(randomUUID()))
      })

    try {
      await writeFile(promptFile, ctx.systemPrompt, 'utf8')

      if (signal.aborted) {
        yield { k: 'done', reason: 'interrupted' }
        return
      }

      const args = buildClaudeArgs(ctx, promptFile, launch.preambleArgs)
      if (opts.extraArgs?.length) args.push(...opts.extraArgs)
      child = spawn(launch.exe, args, {
        cwd: ctx.cwd,
        // Windows 必需，否则闪一个黑框。
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 不动 ANTHROPIC_* —— 复用用户自己的登录态与端点配置（§2.4）。
        env: { ...process.env }
        // ★ 绝不 shell: true：提示词会暴露给 shell 注入，且 .cmd 垫片会抛 EINVAL。
      })

      // `isAborted` 把「用户按了停止」这个**只有我们知道**的事实递给解析器 ——
      // 否则优雅中断那条终态 `result` 只能靠 subtype 正则去猜，
      // 猜错的后果是把取消报成 `complete`。
      const parser = createStreamParser({ isAborted: () => aborted })
      const childRef = child
      registry.register(ctx.turnId, childRef)
      signal.addEventListener('abort', requestKill, { once: true })
      // 竞态：监听器挂上之前就已经 abort 了（上面的 `signal.aborted` 检查和这里之间
      // 隔着一次 spawn）。漏掉它，这一轮就永远不会走阶梯，子进程会一直挂着。
      if (signal.aborted) requestKill()

      // ── 出口 1：进程起不来（ENOENT / EINVAL / EPERM）。 ──
      childRef.on('error', (err) => {
        const e = err as NodeJS.ErrnoException
        spawnErrorCode = e.code ?? 'unknown'
        pushAll([
          {
            k: 'error',
            code: 'spawn_failed',
            message: `claude 进程起不来：${e.code ?? ''} ${e.message}`.trim(),
            fatal: true
          }
        ])
        ended = true
        wake()
      })

      childRef.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        // 旁路**先**走：归档要的是对方的原始字节，晚一步就可能被解析器的异常带没。
        opts.onRawChunk?.(text)
        pushAll(parser.push(text))
      })
      childRef.stdout?.on('end', () => {
        pushAll(parser.flush())
        // 解析器不认识的 `control_response` 之类，只做观测（ACK ≠ 完成，见 control-protocol）。
        for (const d of parser.diagnostics()) diagnostics.push(d)
      })

      childRef.stderr?.on('data', (chunk: Buffer) => {
        // 有界留档 —— 只为了在失败时说人话。
        if (stderrBuf.length < stderrLimit) stderrBuf += chunk.toString('utf8')
      })

      childRef.on('close', (code) => {
        exitCode = code
        ended = true
        wake()
      })

      // ── 入口：首条 user 消息。 ──
      writeLine(childRef.stdin, userMessageLine(renderTurnInput(ctx.messages)))
      if (opts.closeStdinAfterPrompt) childRef.stdin?.end()

      // ── 泵：把队列里的东西按序交出去。 ──
      for (;;) {
        // ★ 刻意在这个循环里 await 阶梯，而不是在 abort 回调里 fire-and-forget：
        // 这样 `run()` **不可能在杀树还没落定的时候就返回**，也就不需要在 finally 里
        // 去追一个悬着的 Promise（那种写法有个更隐蔽的坏处：杀树的失败会变成
        // unhandled rejection，而它恰恰最需要被看见）。
        if (killRequested) {
          killRequested = false
          const outcome = await killTree()
          if (outcome?.exited) {
            // 进程确认已死 —— 不必再干等 `close`。阶梯内部已经等过它了，
            // 而 `close` 一旦迟到（硬杀之后并不罕见）这一轮就会卡住，
            // 那正是文件头那条终态不变量不允许出现的情况。
            if (exitCode === null) exitCode = outcome.exitCode
            ended = true
          }
        }

        if (queue.length) {
          const ev = queue.shift() as AgentEvent
          if (ev.k === 'done') {
            sawDone = true
            // ★ 见 `closeStdinOnResult`：轮次一结束就放开 stdin，否则这个进程会一直
            // 等下一条 user 消息（实测：模型干完活之后又空等了 171 秒）。
            // 这一句让进程自己退出，于是正常路径根本不需要动用中断阶梯。
            if (opts.closeStdinOnResult !== false) childRef.stdin?.end()
          }
          yield ev
          continue
        }
        if (ended) break
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }

      // ── 终态兜底：见文件头那条不变量。 ──
      if (!sawDone) {
        if (spawnErrorCode === 'ENOENT') {
          // CLI 会自更新，路径可能刚换过（本机那个 `claude.exe.old.<ts>` 就是证据）。
          // 解析缓存作废，下一轮会重新解析 —— M5 不在这里重试，重试是 M6 调度器的活。
          invalidateClaudeCache()
        }
        if (!aborted && spawnErrorCode === null && exitCode !== 0) {
          const tail = stderrBuf.split(/\r?\n/).filter((l) => l.trim()).slice(-4).join('\n')
          yield {
            k: 'error',
            code: 'nonzero_exit',
            message: `claude 以退出码 ${exitCode} 结束，且没有给出终态结果${tail ? `：\n${tail}` : ''}`,
            fatal: true
          }
        }
        yield { k: 'done', reason: synthesizedReason(exitCode, aborted) }
      }
    } finally {
      signal.removeEventListener('abort', requestKill)
      // 消费者提前 `break`（生成器被 `return()`）时子进程还活着 —— 不能就这么走掉，
      // 否则**每中断一次就漏一个 237MB 的进程**，而这条路径上没人会替我们收尸。
      // 正常结束时它早已退出（`exit` 事件已把它从登记表里摘掉），这里是空操作。
      //
      // 注意这条路径上**发不出终态事件**：生成器正在被销毁，`yield` 已经没有人接了。
      // 文件头那条「恰好一次 done」约束的是正常迭代，不是这一条。
      if (!ended) await killTree().catch(() => undefined)
      if (child) registry.release(ctx.turnId)
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return {
    run,

    async interrupt(handle: AgentHandle): Promise<boolean> {
      // ★ 它**只是 signal 的命令式外壳**（见 agent-adapter 的所有权裁定）：
      // 查表拿到同一个 AbortSignal 再 abort，阶梯因此只有一份实现。
      return registry.abort(handle.turnId)
    },

    async collectProjectContext(rootPath: string): Promise<ProjectContext> {
      return collectProjectContext(rootPath)
    },

    projectContextSources() {
      return PROJECT_CONTEXT_SOURCES
    },

    /** M5 的观测通道（见 `ClaudeAdapter` 的说明）—— **不在** `AgentAdapter` 上。 */
    diagnosticsOf(turnId: string): readonly AgentDiagnostic[] {
      return diagnosticsByTurn.get(turnId) ?? []
    }
  }
}
