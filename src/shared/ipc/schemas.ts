/**
 * zod schema —— 通道契约的**事实源**。`contract.ts` 的类型全部由这里 `z.infer` 推导。
 *
 * 两条纪律：
 *
 * 1. **实体 schema 必须与 `entities.ts` 的接口逐字段一致**，靠文件末尾的编译期
 *    断言钉住。schema 与接口一旦分叉，`npm run typecheck` 直接失败 ——
 *    而不是等到运行时才发现 UI 少了一个字段。
 *
 * 2. **只对 req 做运行时校验**（方案 §4.3：「所有**入站** IPC 载荷用 zod 校验」）。
 *    res 的 schema 存在的意义是**提供类型**并被单测覆盖，不在热路径上多跑一次解析
 *    —— 返回值的形状由 `persist/row.ts` 的显式映射保证。
 *
 * ⚠️ 本文件被**两个** tsconfig 项目编译（见 `tsconfig.web.json` 的注释），
 *    所以内部引用一律带显式 `.ts` 扩展名。
 */
import { z } from 'zod'
import {
  AGENT_KINDS,
  EFFORT_LEVELS,
  EVENT_KINDS,
  INJECT_MODES,
  MEMBER_ROLES,
  PROJECT_ORIGINS,
  TURN_STATUSES
} from '../entities.ts'
import type {
  Actor,
  Mention,
  Message,
  MessageEvent,
  MemberProject,
  Project,
  Session,
  Turn,
  Workspace,
  WorkspaceMember
} from '../entities.ts'

// ─────────────────────────────────────────────────────────────
// 无载荷通道
// ─────────────────────────────────────────────────────────────

/**
 * 没有参数的通道。
 * 同时收 `undefined` 与 `null` —— Electron 在调用方没传载荷时给的是哪一个，
 * 不同版本/不同调用方式并不一致，没必要为此收紧。
 */
const NoPayload = z.union([z.undefined(), z.null()])

/** 分页上限。防止渲染层（或被攻陷的渲染层）一次要走一百万行。 */
const LIMIT = z.number().int().min(1).max(500)
const DEFAULT_LIMIT = 50

// ─────────────────────────────────────────────────────────────
// 实体 schema
// ─────────────────────────────────────────────────────────────

export const MentionSchema = z.object({
  memberId: z.string(),
  kind: z.union([z.literal('to'), z.literal('cc')])
})

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  activeProjectId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable()
})

export const ProjectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  rootPath: z.string(),
  origin: z.enum(PROJECT_ORIGINS),
  remoteUrl: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  createdAt: z.number(),
  lastOpenedAt: z.number().nullable()
})

export const ActorSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().nullable(),
  agentKind: z.enum(AGENT_KINDS),
  /** 自由文本，**绝不是枚举**（§2.4）—— 用户的 settings.json 把别名映射到第三方端点。 */
  model: z.string(),
  effort: z.enum(EFFORT_LEVELS),
  personaPath: z.string(),
  personaHash: z.string(),
  skillsJson: z.string(),
  memoryJson: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const WorkspaceMemberSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  actorId: z.string(),
  displayName: z.string(),
  roleDescPath: z.string().nullable(),
  roleDescHash: z.string().nullable(),
  permissionJson: z.string(),
  isRouter: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const MemberProjectSchema = z.object({
  memberId: z.string(),
  projectId: z.string(),
  isPrimary: z.boolean(),
  createdAt: z.number()
})

export const SessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  memberId: z.string(),
  turnCount: z.number(),
  lastSeq: z.number(),
  compactedThroughSeq: z.number(),
  rollingSummary: z.string().nullable(),
  createdAt: z.number(),
  lastActiveAt: z.number().nullable()
})

export const TurnSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  triggerMessageId: z.string().nullable(),
  status: z.enum(TURN_STATUSES),
  /** ★ 跳数计数器（§3.3）。**绝不进入提示词上下文**。 */
  hopDepth: z.number(),
  cwd: z.string(),
  pid: z.number().nullable(),
  exitCode: z.number().nullable(),
  errorText: z.string().nullable(),
  costUsd: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  terminalReason: z.string().nullable(),
  queuedAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable()
})

export const MessageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
  role: z.enum(MEMBER_ROLES),
  authorMemberId: z.string().nullable(),
  seq: z.number(),
  contentText: z.string().nullable(),
  contentPath: z.string().nullable(),
  contentBytes: z.number(),
  mentions: z.array(MentionSchema),
  injectMode: z.enum(INJECT_MODES),
  summaryText: z.string().nullable(),
  createdAt: z.number(),
  editedAt: z.number().nullable(),
  deletedAt: z.number().nullable()
})

/**
 * ⚠️ `id` 是**数字**（AUTOINCREMENT），与其余实体的字符串 UUID 不同。
 * 这一点在跨 IPC 边界时尤其要注意 —— 不要顺手写成 `z.string()`。
 */
export const MessageEventSchema = z.object({
  id: z.number(),
  messageId: z.string(),
  seq: z.number(),
  kind: z.enum(EVENT_KINDS),
  toolUseId: z.string().nullable(),
  toolName: z.string().nullable(),
  payloadJson: z.string().nullable(),
  textBlob: z.string().nullable(),
  blobPath: z.string().nullable(),
  bytes: z.number(),
  ok: z.boolean().nullable(),
  truncated: z.boolean(),
  createdAt: z.number()
})

// ─────────────────────────────────────────────────────────────
// 推送载荷（§4.3）
// ─────────────────────────────────────────────────────────────

export const StreamFrameSchema = z.discriminatedUnion('k', [
  z.object({ seq: z.number(), k: z.literal('text'), d: z.string() }),
  z.object({ seq: z.number(), k: z.literal('thinking'), d: z.string() }),
  z.object({ seq: z.number(), k: z.literal('thinking_end') }),
  z.object({
    seq: z.number(),
    k: z.literal('tool_start'),
    id: z.string(),
    name: z.string(),
    input: z.unknown()
  }),
  z.object({
    seq: z.number(),
    k: z.literal('tool_result'),
    id: z.string(),
    ok: z.boolean(),
    output: z.string(),
    truncated: z.boolean().optional()
  }),
  z.object({ seq: z.number(), k: z.literal('file_diff'), path: z.string(), patch: z.string() }),
  z.object({
    seq: z.number(),
    k: z.literal('usage'),
    in: z.number(),
    out: z.number(),
    costUsd: z.number().optional()
  }),
  z.object({
    seq: z.number(),
    k: z.literal('error'),
    code: z.string(),
    message: z.string(),
    fatal: z.boolean()
  }),
  z.object({
    seq: z.number(),
    k: z.literal('done'),
    reason: z.enum(['complete', 'interrupted', 'crashed', 'budget'])
  })
])

export const StreamBatchSchema = z.object({
  v: z.literal(1),
  t: z.number(),
  workspaceId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  actorId: z.string(),
  fromSeq: z.number(),
  toSeq: z.number(),
  frames: z.array(StreamFrameSchema)
})

export const StreamStatusSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  status: z.enum(TURN_STATUSES),
  /** 终态的补充说明（如 `user_interrupt` / `budget`）。 */
  reason: z.string().nullable()
})

export const WorkspaceUnreadSchema = z.object({
  workspaceId: z.string(),
  count: z.number().int().min(0)
})

export const AppNoticeSchema = z.object({
  level: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  detail: z.unknown().optional()
})

// ─────────────────────────────────────────────────────────────
// 通道 req / res
// ─────────────────────────────────────────────────────────────

const Deleted = z.object({ deleted: z.boolean() })

export const INVOKE_SCHEMAS = {
  // ── workspace ──────────────────────────────────────────────
  'workspace:list': { req: NoPayload, res: z.array(WorkspaceSchema) },
  'workspace:create': { req: z.object({ name: z.string().min(1) }), res: WorkspaceSchema },
  'workspace:update': {
    req: z.object({ id: z.string(), name: z.string().min(1) }),
    res: WorkspaceSchema
  },
  'workspace:delete': { req: z.object({ id: z.string() }), res: Deleted },
  'workspace:setActive': {
    req: z.object({ id: z.string(), projectId: z.string().nullable() }),
    res: WorkspaceSchema
  },

  // ── project ────────────────────────────────────────────────
  'project:list': { req: z.object({ workspaceId: z.string() }), res: z.array(ProjectSchema) },
  'project:addLocal': {
    req: z.object({ workspaceId: z.string(), name: z.string().min(1), rootPath: z.string().min(1) }),
    res: ProjectSchema
  },
  'project:copy': {
    req: z.object({
      workspaceId: z.string(),
      name: z.string().min(1),
      sourcePath: z.string().min(1),
      targetPath: z.string().min(1)
    }),
    res: ProjectSchema
  },
  'project:clone': {
    req: z.object({
      workspaceId: z.string(),
      name: z.string().min(1),
      remoteUrl: z.string().min(1),
      targetPath: z.string().min(1),
      defaultBranch: z.string().nullable().optional()
    }),
    res: ProjectSchema
  },
  'project:rename': {
    req: z.object({ id: z.string(), name: z.string().min(1) }),
    res: ProjectSchema
  },
  'project:remove': { req: z.object({ id: z.string() }), res: Deleted },

  // ── actor ──────────────────────────────────────────────────
  'actor:list': { req: NoPayload, res: z.array(ActorSchema) },
  'actor:get': { req: z.object({ id: z.string() }), res: ActorSchema.nullable() },
  'actor:create': {
    req: z.object({
      name: z.string().min(1),
      model: z.string().min(1),
      personaPath: z.string().min(1),
      personaHash: z.string(),
      avatar: z.string().nullable().optional(),
      agentKind: z.enum(AGENT_KINDS).optional(),
      effort: z.enum(EFFORT_LEVELS).optional()
    }),
    res: ActorSchema
  },
  'actor:update': {
    req: z.object({
      id: z.string(),
      name: z.string().min(1),
      model: z.string().min(1),
      effort: z.enum(EFFORT_LEVELS),
      agentKind: z.enum(AGENT_KINDS),
      avatar: z.string().nullable().optional()
    }),
    res: ActorSchema
  },
  'actor:remove': { req: z.object({ id: z.string() }), res: Deleted },

  // ── member ─────────────────────────────────────────────────
  'member:list': {
    req: z.object({ workspaceId: z.string() }),
    res: z.array(WorkspaceMemberSchema)
  },
  'member:create': {
    req: z.object({
      workspaceId: z.string(),
      actorId: z.string(),
      displayName: z.string().min(1),
      roleDescPath: z.string().nullable().optional()
    }),
    res: WorkspaceMemberSchema
  },
  'member:remove': { req: z.object({ id: z.string() }), res: Deleted },
  'member:setEnabled': {
    req: z.object({ id: z.string(), enabled: z.boolean() }),
    res: WorkspaceMemberSchema
  },
  'member:setRoleDesc': {
    req: z.object({
      id: z.string(),
      roleDescPath: z.string().nullable(),
      roleDescHash: z.string().nullable()
    }),
    res: WorkspaceMemberSchema
  },
  'member:setRouter': {
    req: z.object({ id: z.string(), isRouter: z.boolean() }),
    res: WorkspaceMemberSchema
  },
  'member:setPermissions': {
    req: z.object({ id: z.string(), permissionJson: z.string() }),
    res: WorkspaceMemberSchema
  },
  'member:visibility': {
    req: z.object({ memberId: z.string() }),
    res: z.object({
      /** 可见项目 id。`isRestricted === false` 时此数组为空 —— **空不等于不可见**。 */
      ids: z.array(z.string()),
      /** false = 该成员没有 `member_project` 行 = 可见空间内**全部**项目（§8.4）。 */
      isRestricted: z.boolean(),
      primaryProjectId: z.string().nullable()
    })
  },
  'member:setVisibility': {
    req: z.object({
      memberId: z.string(),
      projectIds: z.array(z.string()),
      primaryProjectId: z.string().nullable()
    }),
    res: z.array(MemberProjectSchema)
  },
  'member:setPrimary': {
    req: z.object({ memberId: z.string(), projectId: z.string(), isPrimary: z.boolean() }),
    res: MemberProjectSchema.nullable()
  },
  'member:clearVisibility': { req: z.object({ memberId: z.string() }), res: NoPayload },

  // ── session ────────────────────────────────────────────────
  'session:list': { req: z.object({ workspaceId: z.string() }), res: z.array(SessionSchema) },
  'session:getByMember': {
    req: z.object({ memberId: z.string() }),
    res: SessionSchema.nullable()
  },
  'session:remove': { req: z.object({ id: z.string() }), res: Deleted },

  // ── message ────────────────────────────────────────────────
  /**
   * 三种取法的优先级（§4.3）：`sessionId` > `beforeSeq` > 取最近 N 条。
   * 全部**按 seq 升序返回** —— repository 内部是倒序取再翻回来。
   */
  'message:list': {
    req: z.object({
      workspaceId: z.string(),
      sessionId: z.string().nullable().optional(),
      beforeSeq: z.number().int().nullable().optional(),
      limit: LIMIT.optional()
    }),
    res: z.array(MessageSchema)
  },
  'message:getEvents': {
    req: z.object({ messageId: z.string() }),
    res: z.array(MessageEventSchema)
  },

  // ── turn ───────────────────────────────────────────────────
  'turn:send': {
    req: z.object({
      workspaceId: z.string(),
      memberId: z.string(),
      text: z.string().min(1),
      /** ★ 结构化 mention，**不是**从 text 里解析出来的（§3.1）。 */
      mentions: z.array(MentionSchema).optional()
    }),
    res: z.object({ turnId: z.string() })
  },
  'turn:stop': { req: z.object({ turnId: z.string() }), res: TurnSchema },
  'turn:stopAll': {
    req: z.object({ workspaceId: z.string() }),
    res: z.object({ stopped: z.number() })
  },
  'turn:interject': {
    req: z.object({ turnId: z.string(), text: z.string().min(1) }),
    res: NoPayload
  },
  'turn:list': {
    req: z.object({
      workspaceId: z.string(),
      sessionId: z.string().nullable().optional(),
      limit: LIMIT.optional()
    }),
    res: z.array(TurnSchema)
  },
  'turn:get': { req: z.object({ id: z.string() }), res: TurnSchema.nullable() },
  'turn:listLive': { req: NoPayload, res: z.array(TurnSchema) },

  // ── view / stream / runtime ────────────────────────────────
  'view:setActive': {
    req: z.object({ workspaceId: z.string().nullable(), sessionId: z.string().nullable() }),
    res: NoPayload
  },
  'stream:resume': {
    req: z.object({ sessionId: z.string(), fromSeq: z.number() }),
    res: z.object({ frames: z.array(StreamFrameSchema) })
  },
  'runtime:getState': {
    req: NoPayload,
    res: z.object({
      liveTurns: z.array(TurnSchema),
      queueDepth: z.number(),
      slots: z.object({ used: z.number(), total: z.number() })
    })
  }
} as const

export const PUSH_SCHEMAS = {
  'stream:batch': StreamBatchSchema,
  'stream:status': StreamStatusSchema,
  'workspace:unread': WorkspaceUnreadSchema,
  'app:notice': AppNoticeSchema
} as const

export const DEFAULT_MESSAGE_LIMIT = DEFAULT_LIMIT

// ─────────────────────────────────────────────────────────────
// ★ 编译期断言：schema ↔ entities.ts 接口不得分叉
// ─────────────────────────────────────────────────────────────

/** `true` 当且仅当 A 与 B 互相可赋值。 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** 断言失败时 TS 会报 "Type 'false' does not satisfy the constraint 'true'"。 */
type Assert<T extends true> = T

/** 导出只为让 `noUnusedLocals` 满意；下划线表示这是内部断言，不是公开 API。 */
export type _Workspace = Assert<Exact<z.infer<typeof WorkspaceSchema>, Workspace>>
export type _Project = Assert<Exact<z.infer<typeof ProjectSchema>, Project>>
export type _Actor = Assert<Exact<z.infer<typeof ActorSchema>, Actor>>
export type _Member = Assert<Exact<z.infer<typeof WorkspaceMemberSchema>, WorkspaceMember>>
export type _MemberProject = Assert<Exact<z.infer<typeof MemberProjectSchema>, MemberProject>>
export type _Session = Assert<Exact<z.infer<typeof SessionSchema>, Session>>
export type _Turn = Assert<Exact<z.infer<typeof TurnSchema>, Turn>>
export type _Message = Assert<Exact<z.infer<typeof MessageSchema>, Message>>
export type _MessageEvent = Assert<Exact<z.infer<typeof MessageEventSchema>, MessageEvent>>
export type _Mention = Assert<Exact<z.infer<typeof MentionSchema>, Mention>>
