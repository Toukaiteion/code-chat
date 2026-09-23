/**
 * 领域实体类型 —— 主进程与渲染进程共用。
 *
 * 这里**只有类型，没有运行时代码**，所以可以在渲染进程里 import 而不触碰 Node。
 * 实体本身由 `src/main/persist/repositories/*` 从 SQLite 行**显式映射**而来，
 * 原因见 §2.1 的 M1 发现：`node:sqlite` 返回的行是 null-prototype 对象，
 * 不能原样透传给上层（`deepStrictEqual` / `hasOwnProperty` 都会炸）。
 */

// ─────────────────────────────────────────────────────────────
// 枚举（用 as const 对象 + 联合类型，不用 TS enum —— Node 的类型剥离不支持 enum）
// ─────────────────────────────────────────────────────────────

/** 项目的来源方式（§8.2）。决定「谁拥有这个路径」与删除空间时的行为。 */
export const PROJECT_ORIGINS = ['clone', 'local', 'copy'] as const
export type ProjectOrigin = (typeof PROJECT_ORIGINS)[number]

export const AGENT_KINDS = ['claude', 'codex'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export const MEMBER_ROLES = ['user', 'assistant', 'system'] as const
export type MessageRole = (typeof MEMBER_ROLES)[number]

export const TURN_STATUSES = [
  'queued',
  'running',
  'done',
  'interrupted',
  'failed',
  'cancelled'
] as const
export type TurnStatus = (typeof TURN_STATUSES)[number]

/** 未终结的轮次状态 —— 启动时孤儿清扫（§4.4）与并发槽位计算都靠这个集合。 */
export const LIVE_TURN_STATUSES: readonly TurnStatus[] = ['queued', 'running']

export const EVENT_KINDS = [
  'thinking',
  'text',
  'tool_start',
  'tool_result',
  'file_diff',
  'usage',
  'error',
  'done'
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/**
 * 适配层错误的**闭合联合**（§4.3 补记 ①）。
 *
 * ⚠️ **这不是 `IPC_ERROR_CODES`（`ipc/envelope.ts`）的第二份，两者是不同的所有者，绝不要合并。**
 * 它们回答的是两个不同的问题：
 * - `IPC_ERROR_CODES` 回答「**这次 IPC 调用**为什么没成」——`E_NOT_FOUND`、`E_CONFLICT` 是仓储层的语义；
 * - `AGENT_ERROR_CODES` 回答「**那个 agent 进程**出了什么事」——`nonzero_exit`、`budget_exceeded`
 *   是子进程的处境，仓储层根本不知道。
 *
 * 之所以放在 `entities.ts`：它是唯一同时被两个 tsconfig 项目读、又不在 IPC 层里的文件，
 * 于是适配层（`src/main/adapters/**`）与线上格式（`shared/ipc/schemas.ts` 的 `error` 帧）
 * **可以指着同一份定义**。§4.3 补记 ① 的诉求正是这个：闭合之后 UI 才能对每一类给出准确提示，
 * 而不是把「进程没起来」和「这轮超预算」渲染成同一句「出错了」。
 *
 * 命名刻意**不带 `E_` 前缀**，就是为了让人一眼看出它和 `IPC_ERROR_CODES` 不是一套。
 */
export const AGENT_ERROR_CODES = [
  /** 找不到 CLI 可执行文件（`cli-locator` 全试过了）。 */
  'cli_not_found',
  /** 定位到了但进程起不来（ENOENT 复现 / EINVAL / EPERM）。 */
  'spawn_failed',
  /** 流内容违反了协议预期（例如整轮没有 `system:init`）。 */
  'protocol',
  /** 终态行解析不出来 —— 于是这一轮的结果**不可知**，只能如实报这个。 */
  'parse',
  /** 进程非零退出，且没等到终态 `result`。 */
  'nonzero_exit',
  /** 撞上 `--max-budget-usd` 硬闸。⚠️ CLI 用哪个 subtype 报这件事**尚未实测**（M5 探针）。 */
  'budget_exceeded',
  /**
   * ★ **CLI 自报本轮失败**（终态行 `is_error: true`），原因逐字在 `message` 里。
   *
   * **M6a 新增的第 8 个取值** —— 它是 §4.4d 单独花一节写下的那个形态，不是边角料：
   *
   * ```
   * {"type":"result","subtype":"success","is_error":true,"result":"Prompt is too long",
   *  "terminal_reason":"blocking_limit", …}
   * ```
   *
   * 为什么不能塞进已有的七个（这是加值的**全部**理由，逐条对过）：
   * - `budget_exceeded` 说的是**我们**设的那道 `--max-budget-usd` 闸 —— 上面这轮
   *   撞的是 API 的上下文长度上限。把它们并成一个码，UI 会给出「调高预算」这种
   *   **照着做也不会有用**的下一步提示。
   * - `nonzero_exit` 说的是「进程非零退出」—— 上面这轮进程退了 0（它如实汇报了失败）。
   * - `protocol` / `parse` 说的是「我们读不懂 CLI 的流」—— 这里我们读得懂，
   *   而且 §4.4d 说这个形态**是预期的**，不是异常。
   *
   * 合起来用一句话说清：**前七个码说的是「进程出了什么事」，这一个说的是
   * 「进程明确告诉你这一轮没成，但它属于哪一类只有它自己知道」**。
   * 缺了它，「为什么失败」就又只剩一个 `done reason=crashed` ——
   * 而 §4.6 规则一（算出来了就必须往下传）正是为这种事定的。
   */
  'cli_reported',
  /** 我们自己按用户意图中断了它。 */
  'aborted'
] as const
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number]

/**
 * 一轮**如何结束**的闭合联合（§4.3 的 `done` 帧）。
 *
 * 与 `AGENT_ERROR_CODES` 同样的理由放在这里：它同时是 `AgentEvent.done.reason`
 * 和 `StreamFrame.done.reason`，两处必须指的是同一组值。
 *
 * 注意它**刻意只有四个值**：`failed` 不在这里 —— 失败是通过先发一个 `error` 事件、
 * 再发 `done` 表达的（`done` 只回答「结束了没、怎么结束的」）。
 */
export const TERMINAL_REASONS = ['complete', 'interrupted', 'crashed', 'budget'] as const
export type TerminalReason = (typeof TERMINAL_REASONS)[number]

/** 历史注入方式（§4.6 压缩）。 */
export const INJECT_MODES = ['full', 'summary', 'excluded'] as const
export type InjectMode = (typeof INJECT_MODES)[number]

/** 结构化 mention（§3.1）—— 运行时**永不**从文本解析 */
export interface Mention {
  memberId: string
  kind: 'to' | 'cc'
}

// ─────────────────────────────────────────────────────────────
// 实体
// ─────────────────────────────────────────────────────────────

export interface Workspace {
  id: string
  name: string
  /**
   * ★ 这个空间在磁盘上那一层目录的**名字**（`<workspaceRoot>/<dirName>/`，§8.3）。
   *
   * 存下来而不是每次从 `name` 推，是因为目录名必须**稳定**：
   * 创建时定死一次，之后改名**不动目录**（见 `infra/space-dir.ts` 的三条理由）。
   * 它是路径的**单段名字**，不是绝对路径 —— 根目录由 `workspaceRoot` 决定，
   * 那是个跟机器相关的量，不该进数据库。
   */
  dirName: string
  /** cwd 的**二级兜底**（§8.5b），不是权威。成员没有主项目时才轮到它。 */
  activeProjectId: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export interface Project {
  id: string
  workspaceId: string
  name: string
  /**
   * 绝对路径。
   * - `local`：**用户的**目录，我们只是引用它。删空间时绝不动它。
   * - `copy` / `clone`：我们在用户指定位置创建/拉取的副本。
   */
  rootPath: string
  /** §8.2 的三种导入方式 */
  origin: ProjectOrigin
  remoteUrl: string | null
  defaultBranch: string | null
  createdAt: number
  lastOpenedAt: number | null
}

export interface Actor {
  id: string
  name: string
  avatar: string | null
  agentKind: AgentKind
  /**
   * **自由文本，不是枚举**（§2.4）。用户的 settings.json 把别名映射到第三方端点，
   * 固定枚举会在换端点时立刻失效。
   */
  model: string
  effort: EffortLevel
  /** 人设文件路径（Markdown） */
  personaPath: string
  /** 内容 hash —— 用于缓存键与「可缓存前缀是否合法变更」的检测（§4.6） */
  personaHash: string
  /** 阶段一只留扩展接口 */
  skillsJson: string
  /** 阶段一只留扩展接口 */
  memoryJson: string
  createdAt: number
  updatedAt: number
}

export interface WorkspaceMember {
  id: string
  workspaceId: string
  actorId: string
  displayName: string
  /** 空间职责定位，追加进 system prompt（§4.6） */
  roleDescPath: string | null
  roleDescHash: string | null
  /** 权限白名单/黑名单；硬底 deny 列表在应用层叠加，**不可**由此覆盖（§5.5） */
  permissionJson: string
  /** 路由角色：每空间至多一个，由偏索引 idx_member_router 保证（§3.2） */
  isRouter: boolean
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/**
 * 成员可见项目（§8.4）。**没有行的成员 = 可见空间内全部项目**（默认）。
 * 这是**上下文裁剪**，不是安全边界 —— 见 §8.4 的边界声明。
 */
export interface MemberProject {
  memberId: string
  projectId: string
  /** 该成员的主项目 → 决定 cwd（§8.5b）。每成员至多一个，偏索引保证。 */
  isPrimary: boolean
  createdAt: number
}

export interface Session {
  id: string
  workspaceId: string
  memberId: string
  turnCount: number
  /** 空间时间线内的最后一个 seq 水位 */
  lastSeq: number
  /** 已被压缩进 rollingSummary 的 seq 上界 */
  compactedThroughSeq: number
  /** `<summary>` 块的正文（§4.6） */
  rollingSummary: string | null
  createdAt: number
  lastActiveAt: number | null
}

export interface Turn {
  id: string
  sessionId: string
  workspaceId: string
  triggerMessageId: string | null
  status: TurnStatus
  /**
   * ★ 跳数计数器（§3.3）。**绝不进入提示词上下文** ——
   * 压缩只压对话内容，不压控制状态，否则 agent 会丢掉「自己卡住了」这个认知。
   */
  hopDepth: number
  /** 本轮解析出的工作目录（§8.5b 三级兜底的产物） */
  cwd: string
  pid: number | null
  exitCode: number | null
  errorText: string | null
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  terminalReason: string | null
  queuedAt: number
  startedAt: number | null
  endedAt: number | null
}

export interface Message {
  id: string
  workspaceId: string
  /** null = 空间流里的用户消息（不属于任何角色的 session） */
  sessionId: string | null
  turnId: string | null
  role: MessageRole
  authorMemberId: string | null
  /** 空间时间线内的单调序号 —— 全序、keyset 分页、廉价 `<recent>` 窗口（§4.2） */
  seq: number
  contentText: string | null
  /** 超过 8KB 时外置到 blob，此处存路径（§4.2） */
  contentPath: string | null
  contentBytes: number
  /** ★ 结构化 mention，运行时永不解析文本（§3.1） */
  mentions: Mention[]
  injectMode: InjectMode
  summaryText: string | null
  createdAt: number
  editedAt: number | null
  deletedAt: number | null
}

/**
 * 一条消息内部的细粒度事件。
 *
 * ★ **`thinking` 只存在于这张表**。上下文装配只读 `message`，从不读 `message_event`，
 * 所以推理内容是**结构性排除**的，不是靠过滤条件排除的（§4.2）。
 */
export interface MessageEvent {
  id: number
  messageId: string
  seq: number
  kind: EventKind
  toolUseId: string | null
  toolName: string | null
  payloadJson: string | null
  textBlob: string | null
  blobPath: string | null
  bytes: number
  ok: boolean | null
  truncated: boolean
  createdAt: number
}
