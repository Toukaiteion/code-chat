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
  /** 空间目录的**单段名字**（§8.3）。改名不动它 —— 见 `entities.ts` 的说明。 */
  dirName: z.string(),
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

/**
 * 一个副本目录的处置结果。
 *
 * ★ **四种状态必须都能表达**：「真删掉了」「本来就不在」「按用户的意思没删」
 * 「想删但没删掉」是**四件不同的事**。把它们压进一个布尔值，UI 就只能猜
 * —— 而这里动的是用户的真实目录，猜错一次就是数据没了或以为没了。
 *
 * `state` 的四个值：
 * - `removed` 本次真的从磁盘上删掉了；
 * - `absent`  动手之前就不在磁盘上（不是错误，也不是「我们删的」）；
 * - `kept`    用户没要求删（或这是 `local` 型，我们**永不**碰）；
 * - `failed`  想删，没删掉。`reason` 必须有人话。
 */
const CopyRemoval = z.object({
  path: z.string(),
  state: z.enum(['removed', 'absent', 'kept', 'failed']),
  reason: z.string().nullable()
})

/**
 * 删除类操作的共同形状：**删了什么、什么没删掉、剩下什么，都要能说清**。
 * 只回一个布尔值的删除通道，UI 就只能猜。
 */
const DeleteReport = z.object({
  deleted: z.boolean(),
  copies: z.array(CopyRemoval),
  /**
   * 空间目录本身。**任何情况下都不删**（见 `handlers/workspace.ts` 的四条理由）。
   * 如实告诉用户它留在哪 —— 用户选了 `userData` 这个资源管理器里看不见的位置，
   * 「东西还在，在这里」是我们欠他的交代。行不存在时是 `null`。
   */
  workspaceDir: z.string().nullable(),
  workspaceDirExists: z.boolean()
})

export const INVOKE_SCHEMAS = {
  // ── workspace ──────────────────────────────────────────────
  'workspace:list': { req: NoPayload, res: z.array(WorkspaceSchema) },
  'workspace:create': { req: z.object({ name: z.string().min(1) }), res: WorkspaceSchema },
  'workspace:update': {
    req: z.object({ id: z.string(), name: z.string().min(1) }),
    res: WorkspaceSchema
  },
  'workspace:delete': {
    req: z.object({
      id: z.string(),
      /**
       * §8.2：`copy`/`clone` 的副本「**提示后**删除」。默认 `false` —— 保守那一侧。
       * `origin='local'` 的目录**无论这个标志传什么都不动**。
       */
      deleteCopies: z.boolean().optional()
    }),
    res: DeleteReport
  },
  'workspace:setActive': {
    req: z.object({ id: z.string(), projectId: z.string().nullable() }),
    res: WorkspaceSchema
  },
  'workspace:paths': {
    req: z.object({
      id: z.string(),
      /**
       * `true` 时**顺带把这棵目录建出来**（`mkdir -p` + 补写铭牌），返回的 `exists` 就是 `true`。
       *
       * ★ 为什么要有这个显式开关：M4 之前的空间在磁盘上**根本没有目录**
       * （那时还不通文件系统，`dir_name` 是迁移回填的 id）。所以「看路径」这个查询
       * 对老数据会返回一个不存在的路径。把「建目录」藏在查询里是**不可接受的**
       * —— 一个叫 `paths` 的通道不该在你只是看一眼的时候改磁盘。
       * 于是让调用方显式说要建，默认不建。
       */
      ensure: z.boolean().optional()
    }),
    res: z.object({
      rootPath: z.string(),
      projectsPath: z.string(),
      scratchPath: z.string(),
      /** 目录此刻是否真的在磁盘上。`false` 时 UI 该说「目录不存在」而不是显示一个假路径。 */
      exists: z.boolean()
    })
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
  /**
   * 默认落点 = `<空间目录>/projects/<项目名>`（§8.3）。
   * 只算路径，**不建目录、不碰磁盘** —— 用户还能改。
   */
  'project:defaultTarget': {
    req: z.object({ workspaceId: z.string(), name: z.string().min(1) }),
    res: z.object({ path: z.string() })
  },
  'project:rename': {
    req: z.object({ id: z.string(), name: z.string().min(1) }),
    res: ProjectSchema
  },
  'project:remove': {
    req: z.object({
      id: z.string(),
      /** 同 `workspace:delete`：只对 `copy`/`clone` 生效，`local` 永不碰。默认 false。 */
      deleteCopy: z.boolean().optional()
    }),
    res: z.object({
      deleted: z.boolean(),
      /**
       * 副本目录的处置。`null` = 没这个项目（删除本来就是 no-op）。
       * `origin='local'` 时是 `state: 'kept'` 且带上原因 —— 让 UI 有话说，
       * 而不是让用户以为「勾了删除却什么都没发生」。
       */
      copy: CopyRemoval.nullable()
    })
  },

  // ── actor ──────────────────────────────────────────────────
  'actor:list': { req: NoPayload, res: z.array(ActorSchema) },
  'actor:get': { req: z.object({ id: z.string() }), res: ActorSchema.nullable() },
  /**
   * ★ M4 移除了 `personaHash`：**渲染侧算不出文件 hash**（它没有 fs），
   * 要求调用方传等于要求它编一个。现在主进程读文件并算（`infra/file-hash.ts`）。
   */
  'actor:create': {
    req: z.object({
      name: z.string().min(1),
      model: z.string().min(1),
      /** 人设文件（Markdown）。它是这个角色 system prompt 的主体（§4.6）。 */
      personaPath: z.string().min(1),
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
  /** 重选人设文件。hash 同样由主进程算 —— 改了人设等于改了缓存前缀（§4.6）。 */
  'actor:setPersona': {
    req: z.object({ id: z.string(), personaPath: z.string().min(1) }),
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
  /** 同 `actor:setPersona`：hash 由主进程算，调用方只给路径。传 null 表示清空。 */
  'member:setRoleDesc': {
    req: z.object({ id: z.string(), roleDescPath: z.string().nullable() }),
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

  // ── 宿主能力（对话框 / 文件管理器）──────────────────────────
  'dialog:pickPath': {
    req: z.object({
      mode: z.enum(['file', 'directory']),
      title: z.string().optional(),
      defaultPath: z.string().optional()
    }),
    /** 用户取消 → `{ path: null }`。**取消不是错误**，别用失败信封表示它。 */
    res: z.object({ path: z.string().nullable() })
  },
  'shell:revealPath': {
    req: z.object({ path: z.string().min(1) }),
    res: z.object({ opened: z.boolean() })
  },

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
