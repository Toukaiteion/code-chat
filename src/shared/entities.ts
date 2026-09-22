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
