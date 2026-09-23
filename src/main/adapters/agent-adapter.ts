import type { AgentErrorCode, EffortLevel, TerminalReason } from '../../shared/entities.ts'

/**
 * 适配层**锁定的接口**（§4.4 / §8.5c）。
 *
 * 这一层回答一个问题：**「把一件事交给一个 agent 去做，会发生什么」** —— 而且答案必须
 * 对不同种类的 agent 都成立。M5 只有 `claude` 一种实现，但接口现在就按两种写，
 * 因为 §8.5c 的性质 4 说得很清楚：日后接 codex / cursor 系，各家的
 * `collectProjectContext` 认识各自的文件集，上层装配逻辑不变。
 *
 * ## 三个所有权裁定（§4.7 那条纪律在这里的第一次应用）
 *
 * **1. `AgentEvent` 与线上帧 `StreamFrame`（`shared/ipc/schemas.ts`）的关系是「超集 + 映射」，
 * 而不是「同一个东西」。** 帧是**派生层**：它带 `seq`（由 M6 的合批器分配），
 * 适配层**不许**有 `seq` —— 否则就有两个地方在分配同一个序号。
 * 两者的差集必须逐项写清去向，见下表；**差集每多一项，就多一处需要维护的翻译**，
 * 所以能对齐的地方一律对齐。
 *
 * | 差集 | 去向 |
 * |---|---|
 * | `session_started` / `status_changed` | 会话簿记，**不进 `message_event`**。`status_changed`（CLI 的 `system:status`，如 `requesting`）在帧上**无处可放** —— §4.3 的 `stream:status` 是**轮次**状态，不是 CLI 的内部状态。M6 丢弃它 |
 * | `usage` 多带 `cacheRead`/`cacheCreation`/`thinkingTokens` | §2.2 有这三个字段，§4.6/§5.4 要求 `cache_read_input_tokens` 被记录且非零。**M6 必须同时拓宽 `StreamFrame.usage`**，否则这个事实在帧上没地方放，M7 的验收做不成 |
 * | `tool_result` 多带 `structured` | §2.2：`user` 行带**顶层** `tool_use_result`（结构化，如 Read 返回 `{file:{…}}`），帧上只有 `output: string` |
 * | `text_delta` 多带 `block` | 内容块下标。**M6 实现 `textMode` 时需要它**（「最后一段 text」是 `textMode` 的定义依赖），随 `textMode` 一起进帧 |
 * | `file_diff` | **适配层目前没有生产者** —— §2.2 的映射表没有任何一行产出它，它只能从 `Edit`/`Write` 的 tool_use 输入合成。M5 不写合成逻辑，只把真实输入留档（探针⑦） |
 * | `textMode` | **待实测**。§4.3 补记 ② 明令实测前不许写死判定逻辑，M5 只如实暴露交错结构 |
 *
 * **2. `TurnContext` 的所有者是本文件，不是 `domain/context-builder.ts`。**
 * 消费方定义接口，生产者（M7）去满足它 —— 这是 §4.1「服务通过构造注入」的直接推论。
 * 但形状现在就要定对：**必须带结构化的 `messages[]`，绝不能是一个预先序列化好的 NDJSON blob**，
 * 因为 §4.6 整段论证的前提就是「历史以真正的消息数组传递」。定错了，M7 要么 churn 一个
 * 「已锁定」的接口，要么做出一个**永远打不中 prefix 缓存**的版本。
 *
 * **3. 取消意图只能有一个所有者。** §8.5c 同时锁了 `run(ctx, signal)` 与 `interrupt(handle)`，
 * 而这是同一个事实（「这一轮要停」）的两个入口 —— 正是 §4.7 要禁的形状。
 * 裁定：**`signal` 是唯一的所有者**，`interrupt(handle)` 只是它的命令式外壳
 * （查表拿到同一个 `AbortSignal` 再 abort）。中断阶梯（§4.4）因此只有一份实现。
 * 表由 `process/child-registry.ts` 持有，见 `CancelTable`。
 *
 * ## 两条实现纪律（不是风格偏好，是会真的报错）
 *
 * - **禁止 TS `enum`，也禁止参数属性**（`constructor(private readonly exe: string)`）。
 *   `test/**` 与 `src/main/**` 由裸 Node 的**原生类型剥离**直接跑，两者都要求生成代码，
 *   于是都会被拒。显式字段声明，照 `ipc/errors.ts` 的 `AppError` 写。
 * - **`noUnusedLocals` / `noUnusedParameters` 都是 `true`**，而 M5 还没有调度器来消费
 *   `run()` 的 `signal`。实现里的下划线形参（`_signal`）**是刻意的**，
 *   为的是不偏离上面这份锁定签名 —— 不是笔误。
 */

// ─────────────────────────────────────────────────────────────
// 事件
// ─────────────────────────────────────────────────────────────

/**
 * 适配层发出的**原始**事件。一个轮次是一串 `AgentEvent`，且**恰好以一次 `done` 收尾**。
 *
 * ★ **「恰好一次 `done`」是适配器的义务，不是解析器的。** 中断阶梯的第 2/3 级是硬杀
 * （§4.4），杀完**没有任何 `result` 行**，也就没有 `done` 可解析 —— 于是「用户点了停止」
 * 这条最常见的非正常结束路径上，轮次会永远等不到终态，而 `turn:stop`（M9）也没有事件可报。
 * 所以 `claude-adapter` 必须在 `close` / `error` / `exit` 上**自己合成**那个 `done`。
 */
export type AgentEvent =
  /** CLI 的 `system:init`。`permissionMode` 是 **string 而非字面量联合** —— §2.3-3：回报值是内部名（实测 `"default"`，`--help` 里没有），不许从回报值反推入参。 */
  | { k: 'session_started'; sessionId: string; model: string; cwd: string; permissionMode: string; tools: readonly string[] }
  /** CLI 的 `system:status`。**帧上没有对应物**，M6 丢弃（见文件头差集表）。 */
  | { k: 'status_changed'; status: string }
  | { k: 'thinking_delta'; block: number; text: string }
  | { k: 'thinking_end'; block: number }
  | { k: 'text_delta'; block: number; text: string }
  | { k: 'tool_start'; id: string; name: string; input: unknown }
  | { k: 'tool_result'; id: string; ok: boolean; output: string; structured?: unknown; truncated?: boolean }
  | {
      k: 'usage'
      in: number
      out: number
      /** §4.6/§5.4：缓存命中率是要被**排查**的量，必须带出来。 */
      cacheRead?: number
      cacheCreation?: number
      /** `output_tokens_details.thinking_tokens`（§2.2）。 */
      thinkingTokens?: number
      /** ⚠️ §2.4-2：走第三方端点时这个数**不可信**，展示时必须说明是估算。 */
      costUsd?: number
    }
  | { k: 'error'; code: AgentErrorCode; message: string; fatal: boolean }
  | { k: 'done'; reason: TerminalReason }

/**
 * 解析过程中的**非致命**观察（非 JSON 行、超长行被放弃……）。
 *
 * ⚠️ **刻意不是 `AgentEvent`，更不是 `error` 事件。** §2.3-1 要求「跳过无法解析的行」，
 * §8.9-12 要求超长行「记一条诊断」—— 如果这些走 `error`，UI 就会为一行
 * `[claude-code:unrecognized_model] {…}` 弹一个「出错了」，正是 §4.3 补记 ① 想避免的混淆。
 * 诊断与错误是两回事：错误说「这轮没成」，诊断说「我看到了一点不对劲」。
 *
 * M5 只把它们交给调用方（探针打印）；M6 决定是否作为 `app:notice` 露给用户。
 */
export interface AgentDiagnostic {
  level: 'info' | 'warn'
  /** 短标签，便于聚合同类噪声，如 `non-json-line` / `line-too-long` / `unknown-line-type`。 */
  tag: string
  message: string
  /** 原始行的**截断**样本（最多几百字节），足以定位问题又不会把日志撑爆。 */
  sample?: string
}

// ─────────────────────────────────────────────────────────────
// 接口
// ─────────────────────────────────────────────────────────────

export interface TurnContext {
  turnId: string
  sessionId: string
  /** 已解析好的工作目录（§8.5b 三级兜底的产物，**由调用方算好**，适配器不猜）。 */
  cwd: string
  /**
   * ★ **真正的消息数组，不是 blob。** §4.6：历史必须逐条传递，
   * 因为 prefix 缓存以消息为界；拼成一个字符串会让每一轮都整体失配。
   */
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  /** 追加到 CLI 默认系统提示之后的内容。适配器负责把它落成临时文件（见 §4.4 的 `--append-system-prompt-file`）。 */
  systemPrompt: string
  model: string
  effort: EffortLevel
  /** 自由文本（§2.3-3）。默认值由上层决定，不在这里写死。 */
  permissionMode: string
  /** 单轮成本硬闸（§3.4）。 */
  maxBudgetUsd: number
  /** 工具可及范围（§8.4/§8.5）。**不是**上下文来源 —— 那是 `collectProjectContext` 的活。 */
  addDirs: readonly string[]
}

/** `pid` 是这里唯一能唯一标识「哪个进程」的东西，也是 `taskkill /T` 需要的。 */
export interface AgentHandle {
  turnId: string
  pid: number
}

export const PROJECT_CONTEXT_KINDS = [
  'claude-md',
  'agents-md',
  'rules',
  'cursorrules',
  'copilot'
] as const
export type ProjectContextKind = (typeof PROJECT_CONTEXT_KINDS)[number]

export interface ProjectContextFile {
  kind: ProjectContextKind
  /** 相对 `rootPath` 的路径，用于注入提示词时的标注与 UI 展示。 */
  path: string
  /** 原始字节数（**截断前**）—— UI 要说「被截掉了多少」就得知道它。 */
  bytes: number
  /** 实际读到的文本，可能已被截断。 */
  text: string
}

export interface ProjectContext {
  rootPath: string
  files: ProjectContextFile[]
  /**
   * 有**任何一个**文件被 16KB 上限截断即为 `true`。
   *
   * 与 `skipped` 刻意分开：截断是「读到了但不全」，跳过是「压根没读到」，
   * UI 要说的话完全不同，所以不合并成一个布尔。
   */
  truncated: boolean
  /**
   * 读失败/跳过的条目（§8.5c 性质 5）。
   *
   * ⚠️ **不能静默吞掉**：那个性质承诺了「项目记忆没被读到」是一个**可见**的状态。
   * 一个安静跳过的目录（`EISDIR`）就会把它变回一个安静的失效。
   * 「文件不存在」（`ENOENT`）**不算**跳过 —— 大部分项目本来就没有那些文件。
   */
  skipped: Array<{ path: string; reason: string }>
}

export interface AgentAdapter {
  /**
   * 跑一轮。**必须恰好产出一次 `done`**（见 `AgentEvent` 的说明）。
   *
   * `signal` 是取消的唯一入口 —— 它被 abort 时，实现要走完 §4.4 的中断阶梯。
   */
  run(ctx: TurnContext, signal: AbortSignal): AsyncIterable<AgentEvent>

  /**
   * 请求中断。**它只是 `signal` 的命令式外壳**：查 `CancelTable` 拿到同一个
   * `AbortSignal` 再 abort。阶梯本身只有一份实现，在 `child-registry` 里。
   *
   * 返回 `false` 表示这一轮已经不在跑了（或从未跑过）—— 调用方据此区分
   * 「请求了中断」和「本来就结束了」，这正是 §4.5a 规则 4 要的幂等语义。
   */
  interrupt(handle: AgentHandle): Promise<boolean>

  /** ★ 收集一个项目根下、对该 agent 类型有意义的持久化项目上下文（§8.5c）。 */
  collectProjectContext(rootPath: string): Promise<ProjectContext>

  /** 该 agent 类型认识哪些上下文文件，用于 UI 显示「这个项目的记忆被读到了吗」。 */
  projectContextSources(): ReadonlyArray<{ kind: string; relPath: string }>
}

/**
 * 「这一轮要停」的唯一存放处。
 *
 * 接口声明在这里（消费方定义），实现放在 `process/child-registry.ts`
 * —— M9 的 `turn:stop` 会同时需要它和 `pid↔turnId`，两者必须一致，
 * 所以由同一个模块持有。
 *
 * ⚠️ 方法名刻意带 `…Cancel` 后缀：`child-registry` 已经有一个
 * 「登记一个子进程」的 `register`，两者参数完全不同（`ChildProcess` vs `AbortController`），
 * 同名会让那个类同时实现两个接口时**撞名**。
 */
export interface CancelTable {
  registerCancel(turnId: string, controller: AbortController): void
  forgetCancel(turnId: string): void
  signalOf(turnId: string): AbortSignal | null
  /** abort 到了一个真实的在跑轮次才返回 `true` —— 这是 §4.5a 规则 4 的幂等语义要的区分。 */
  abort(turnId: string): boolean
  liveTurnIds(): string[]
}
