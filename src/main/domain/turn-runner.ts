import type {
  AgentAdapter,
  AgentDiagnostic,
  AgentEvent,
  TurnContext
} from '../adapters/agent-adapter.ts'
import type { TerminalWrite, TurnIdentity } from '../process/event-batcher.ts'
import type {
  Actor,
  AgentErrorCode,
  EventKind,
  Message,
  MessageEvent,
  Project,
  Session,
  TerminalReason,
  Turn,
  Workspace,
  WorkspaceMember
} from '../../shared/entities.ts'
import type { ContextShape, HistoryMessage } from './context-builder.ts'
import type { TextReadResult } from '../infra/text-file.ts'
import { buildContext, historyMessageOf } from './context-builder.ts'
import {
  parseMentionsBlock,
  replyTextOf,
  WORK_EVENT_KINDS,
  type TurnFinishedInfo
} from './mention-service.ts'
import { resolveAddDirs, resolveTurnCwd } from './turn-cwd.ts'

/**
 * 单轮编排 —— 把「库里的一条 `queued` 轮次」变成「一次真实的 agent 调用 + 一串落库的事件」。
 *
 * ## 它的边界：`TurnContext` 的形状是 M5 锁定的，M7a 填上了上下文那一半
 *
 * | 字段 | M7a 的来源 |
 * |---|---|
 * | `cwd` | `turn-cwd.ts` 的三级兜底（主项目 → 空间 active 项目 → `scratch/`） |
 * | `addDirs` | §8.4 的可见性（`member_project`）—— **本函数是可见性模型的第一个真实消费方** |
 * | `messages` | `context-builder.buildContext()`：prelude（`<env>`+`<project_context>`+`<summary?>`）+ 会话历史 |
 * | `systemPrompt` | 同一次装配：`<persona>` + `<role?>` + 协作协议 |
 * | `model` / `effort` | `actor.model`（自由文本，§2.4-1）/ `actor.effort` |
 * | `permissionMode` | `member.permissionJson.mode ?? 'bypassPermissions'` |
 * | `maxBudgetUsd` | 常量默认值（`DEFAULT_MAX_BUDGET_USD`），成员覆盖是 M8 |
 *
 * M6a 那张表里 `messages` / `systemPrompt` 两行**都变了**，各有一处要说清：
 *
 * - `messages` 不再是「只有当轮那条用户消息」。★ **但它在 stdin 上仍然只占一行** ——
 *   适配器把数组拍平成一条写出去。M7a 探针实测：**发 N 行 = 发 N 轮**，不是一轮的 N 条
 *   （详见 `context-builder.ts` 的文件头，别在这里重述）。
 * - `systemPrompt` 不再是空串。
 *
 * **仍然不做的一件事**：同一会话的历史**没有「最近 N 轮」这个参数** ——
 * 窗口由压缩水位线（`session.compacted_through_seq`）决定，§4.4 明确否掉了第二个 N。
 * 但**取数**时有一个必须有的上限（`DEFAULT_HISTORY_LIMIT`）：不设它，一个从未被压缩过
 * 的长会话会把整张表读进内存。撞上限会记一条 `warn`，**不静默截断** ——
 * 那是「压缩没跟上」的信号，不是正常状态。
 *
 * ## 人设读不到 = 致命 —— **判决在这一层，不在 `context-builder`**
 *
 * `context-builder` 只记一条 note。这里读 `shape.personaBytes === null` 决定 `fail()`。
 * 理由（依据是列级事实，不是口味）：`actor.persona_path` 是 `NOT NULL`，且写入时
 * （`actor:create` / `actor:setPersona`）已经验证过那个文件存在 —— 所以「读不到」
 * 意味着**建立之后被删/被改**，是真异常。用一份空人设跑一轮，等于让用户以为
 * 「Nyx 在干活」而实际是别的东西在干活：那正是本项目最贵的那类错（**看起来正常**）。
 *
 * 职责描述读不到**不致命**：`role_desc_path` 可空，NULL 本来就是合法状态。
 *
 * ## 终态映射表**只有一处**（`terminalOf()`）
 *
 * `turn.status` 是 6 值，`done.reason` 是 4 值。两个地方各判一次，
 * 就会出现「库里写着 `done`、事件流最后一条却是 `error`」这种自相矛盾的行。
 * 合批器拿到的是**算好的** `TerminalWrite`（见那个类型的说明）。
 *
 * ## 它不 import electron、不 import `node:sqlite`
 *
 * `workspacesRoot` 由外面递进来（它在 `infra/paths.ts` 里，那个文件 import 了 electron）。
 */

/** 单轮成本硬闸（§3.4）。成员级覆盖是 M8 的界面，M6a 只有这个默认值。 */
export const DEFAULT_MAX_BUDGET_USD = 0.5

/** 权限模式的默认值。§4.4 逐字：不做交互式确认，agent 直接干活。 */
export const DEFAULT_PERMISSION_MODE = 'bypassPermissions'

/**
 * 一次取多少条会话历史。
 *
 * ★ **这不是「最近 N 轮」那个 N**（§4.4 否掉了第二个窗口参数），只是**取数上限**。
 * 真正决定进不进上下文的是压缩水位线，而这个上限要足够宽松，
 * 宽松到**只有压缩坏了才会撞上它** —— 撞上会 `warn`，因为那说明有东西没在干活。
 */
export const DEFAULT_HISTORY_LIMIT = 200

/** 编排一轮需要的**最小**持久化面。 */
export interface TurnRunnerStore {
  turn: {
    get(id: string): Turn | null
    /** spawn 之后补 pid（**与状态翻转是两次写入**，见 `turn-repo.markRunning`）。 */
    setPid(id: string, pid: number): Turn | null
  }
  message: {
    get(id: string): Message | null
    /** 会话的**最近** N 条，**按 `seq` 升序**返回（见 `message-repo.listRecentBySession`）。 */
    listRecentBySession(sessionId: string, limit: number): Message[]
    /** **这一轮自己的产物**（M7b 的 `<mentions>` 解析与「干过活没有」都要读它）。 */
    listByTurn(turnId: string): Message[]
    /** 数某一轮有没有工具调用 / 文件改动（判据见 `mention-service.WORK_EVENT_KINDS`）。 */
    listEventsByKind(messageId: string, kind: EventKind): MessageEvent[]
  }
  session: { get(id: string): Session | null }
  member: {
    get(id: string): WorkspaceMember | null
    visibleProjectIds(memberId: string): { ids: string[]; isRestricted: boolean }
    primaryProjectId(memberId: string): string | null
  }
  actor: { get(id: string): Actor | null }
  workspace: { get(id: string): Workspace | null }
  /**
   * `Project` 而不是 `CwdProject`：装配要用 `name` 拼 `<env>` 的项目清单，
   * 而 `CwdProject` 只有 `{id, rootPath}`。`Project` 是它的超集，所以
   * `resolveTurnCwd` 照样吃得下（结构化子类型）。
   */
  project: { listByWorkspace(workspaceId: string): Project[] }
}

/** 合批器里本函数要用的那几件。刻意窄于 `EventBatcher`，测试可以只给这几件。 */
export interface RunnerBatcher {
  beginTurn(id: TurnIdentity): void
  push(turnId: string, ev: AgentEvent): unknown
  endTurn(turnId: string, t: TerminalWrite): unknown
}

export interface RunnerAdapters {
  /** 没有实现的 kind 返回 `null`（见 `adapters/registry.ts`）。 */
  get(kind: Actor['agentKind']): AgentAdapter | null
  diagnosticsOf(kind: Actor['agentKind'], turnId: string): readonly AgentDiagnostic[]
}

/** 「这一轮要停」的存放处。M6a 只**登记**，不主动 abort（那是 M9 的 `turn:stop`）。 */
export interface RunnerCancelTable {
  registerCancel(turnId: string, controller: AbortController): void
  forgetCancel(turnId: string): void
}

export interface TurnRunnerOptions {
  store: TurnRunnerStore
  batcher: RunnerBatcher
  adapters: RunnerAdapters
  cancelTable: RunnerCancelTable
  /**
   * 活子进程登记处（只用到「按 turnId 找 pid」这一件事）。
   * 适配器 spawn 完自己登记，本函数**只是去读** —— 所以刻意只依赖这一个方法。
   */
  pidOf(turnId: string): number | null
  /** `<空间>/scratch/` 的绝对路径（`spacePaths(root, dirName).scratch`）。 */
  scratchPathOf(workspace: Workspace): string
  /**
   * ★ 读一个文本文件（`context-builder` 的两条注入缝之一）。
   *
   * **刻意不给默认值**：给了的话单测就会在「读一个人设文件」这件事上
   * 悄悄走真文件系统，而「第 1 个文件缺失」这种处境就只能靠真造文件来构造。
   * 生产由 `process/runtime.ts` 递 `infra/text-file.ts` 的 `readTextFile`。
   *
   * （另一条缝 `collectProjectContext` 不在这里 —— 它就在 `AgentAdapter` 接口上，
   * 而 `adapter` 已经是本函数的局部变量。多一条注入只会多一个能对不上的地方。）
   */
  textReader(path: string, capBytes?: number): Promise<TextReadResult>
  now(): number
  newId(): string
  onWarn(tag: string, message: string, detail?: unknown): void
  maxBudgetUsd?: number
  /** 会话历史的**取数**上限，见 `DEFAULT_HISTORY_LIMIT`。 */
  historyLimit?: number
  /**
   * ★ **装配形状的观测缝**（M7a 的走查需要它）。
   *
   * 「这一轮实际发出去了什么」此前**没有任何落档处**：装配产物只在内存里，
   * 走查读 `db-*.json` 看不到它。而走查又不能把提示词全文写进归档
   * （那里面有用户的项目内容）—— 所以这里**只传 `ContextShape`，永远不传正文**。
   *
   * 形状照 `onWarn`：**可选、同步、不返回值**。它是个观察者，不是钩子 ——
   * 站在它里面改不了这一轮的走向。
   */
  onContextBuilt?(turnId: string, shape: ContextShape): void
  /**
   * ★ **一轮结束之后的 `@` 扇出**（M7b）。
   *
   * 为什么落在这里：`@` 出现在 **agent 的回复里**，所以「这一轮 @ 了谁」只有
   * 轮次结束时才知道 —— 不能在 `turn:send` 时算。执行（建轮次 / 取消排队 / 落库）
   * 在 `process/fanout.ts`，本函数只把**事实**递出去。
   *
   * ★ **必须在 `batcher.endTurn` 之后调用**（本函数也确实这么调）：`endTurn` 是提交
   * 终态的那个事务，而扇出要读的正是刚提交的东西（这一轮的回复、它有没有干活）。
   * 在它之前读，读到的是一份**还没落库**的世界。
   *
   * 为什么不在这里直接做：本函数在 `domain/`，而建轮次 / 派发要走 `runtime.dispatch`
   * 与 `runtime.cancelQueued` 这两个**唯一入口**（§4.5a 规则一）—— 那两个入口只在
   * `runtime.ts` 的装配里存在。
   */
  onTurnFinished?(turn: Turn, info: TurnFinishedInfo): void
}

export interface TurnRunner {
  /** 跑一轮。**保证**：除非库本身不一致（那时会抛，由调度器的兜底收尾），这一轮必有终态。 */
  run(turn: Turn): Promise<void>
}

/**
 * ★ **终态映射表 —— 全仓库唯一一处。**
 *
 * | `done.reason` | `turn.status` | `terminal_reason` 列 |
 * |---|---|---|
 * | `complete` | `done` | `complete` |
 * | `interrupted` | `interrupted` | `interrupted` |
 * | `crashed` | `failed` | `crashed` |
 * | `budget` | `failed` | `budget` |
 * | **一次 `done` 都没有** | `failed` | `crashed` |
 *
 * 最后一行是**必须有的**：适配器的契约是「恰好一次 `done`」，但契约被违反时
 * （生成器抛异常、进程被杀在合成 `done` 之前）我们**不能**让轮次停在 `running`。
 * 宁可如实报一个 `crashed`，也不要一个永远转圈的轮次。
 *
 * `cancelled` 不在表里：它**只能**从 `markCancelled` 来（排队中被取消，M2 已有），
 * 而且它永远不经过本函数 —— 一个从未启动的轮次没有事件流可映射。
 */
export function terminalOf(reason: TerminalReason | null): {
  status: 'done' | 'interrupted' | 'failed'
  reason: TerminalReason
} {
  switch (reason) {
    case 'complete':
      return { status: 'done', reason: 'complete' }
    case 'interrupted':
      return { status: 'interrupted', reason: 'interrupted' }
    case 'budget':
      return { status: 'failed', reason: 'budget' }
    case 'crashed':
    case null:
      return { status: 'failed', reason: 'crashed' }
  }
}

/** 从 `permissionJson` 里取 `mode`。**形状未定**（M8 才定义 schema），所以只认可字符串。 */
export function permissionModeOf(permissionJson: string): string {
  try {
    const parsed: unknown = JSON.parse(permissionJson)
    if (parsed && typeof parsed === 'object' && 'mode' in parsed) {
      const mode = (parsed as { mode: unknown }).mode
      if (typeof mode === 'string' && mode.length > 0) return mode
    }
  } catch {
    // 库里有 `CHECK (json_valid(...))`，走到这里说明是**本进程**写进去的坏值。
    // 不抛：一轮跑不起来的代价远大于一个权限字段读不出来，而默认值是安全的那一个。
  }
  return DEFAULT_PERMISSION_MODE
}

export function createTurnRunner(opts: TurnRunnerOptions): TurnRunner {
  const maxBudgetUsd = opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD
  const historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT

  function warn(tag: string, message: string, detail?: unknown): void {
    opts.onWarn(tag, message, detail)
  }

  return {
    async run(turn: Turn): Promise<void> {
      const store = opts.store

      // ── 1. 会话 / 空间：**库自身的一致性**问题，不是运行期处境 ──
      //
      // 两条都是外键，正常路径删不掉（`workspace:remove` 对未归档的空间是拒绝的，
      // `session:remove` 会级联删掉轮次）。真走到这里说明库被外部动过 ——
      // 那不是「这一轮失败了」，而是**我们脚下的地不对**，所以抛。
      // 调度器的 `onRunCrashed` 会把这一轮写成终态，不会留下僵尸。
      const session = store.session.get(turn.sessionId)
      if (!session) throw new Error(`轮次 ${turn.id} 的会话 ${turn.sessionId} 不存在`)
      const workspace = store.workspace.get(turn.workspaceId)
      if (!workspace) throw new Error(`轮次 ${turn.id} 的空间 ${turn.workspaceId} 不存在`)

      // ── 2. 成员 / 角色：这两条**是**运行期处境（用户随时可以停用成员），
      //       所以它们是「看得见的失败」而不是异常 ──
      const member = store.member.get(session.memberId)
      const actor = member ? store.actor.get(member.actorId) : null

      // ── 3. cwd / addDirs（§8.5b / §8.4）──
      const projects = store.project.listByWorkspace(turn.workspaceId)
      const decision = resolveTurnCwd({
        memberPrimaryProjectId: member ? store.member.primaryProjectId(member.id) : null,
        workspaceActiveProjectId: workspace.activeProjectId,
        projects,
        scratchPath: opts.scratchPathOf(workspace)
      })
      const visibility = member
        ? store.member.visibleProjectIds(member.id)
        : { ids: [], isRestricted: false }
      const addDirs = resolveAddDirs(
        projects,
        visibility.isRestricted ? visibility.ids : null,
        decision.cwd
      )
      // cwd 的**来源**要留痕：用户问「它到底在哪个目录里跑的」时，这是答案。
      // `turn.cwd` 是派发时写的那个，两者不同只可能是「派发之后主项目被改了」——
      // 如实报，不偷偷采用其中之一。
      if (turn.cwd !== decision.cwd) {
        warn('cwd-changed-since-dispatch', '本轮派发时记录的 cwd 与此刻解析出的不一致', {
          turnId: turn.id,
          atDispatch: turn.cwd,
          resolved: decision.cwd,
          source: decision.source
        })
      }

      // ★ `beginTurn` 必须在**任何** `push` 之前，而且要在这一刻才知道的
      // `actorId` / cwd 一起传进去 —— 批次载荷里的 `actorId` 就是「谁在说话」，
      // 失败路径上也一样要能回答（界面要显示「某个角色出了错」，而不是一个空 id）。
      opts.batcher.beginTurn({
        turnId: turn.id,
        sessionId: turn.sessionId,
        workspaceId: turn.workspaceId,
        actorId: actor?.id ?? '',
        authorMemberId: session.memberId,
        cwd: decision.cwd,
        newMessageId: () => opts.newId()
      })

      /**
       * 「还没开跑就注定失败」的统一出路：**记一条 `error` + 一个终态**，
       * 于是它在时间线上是一条**看得见的失败**，而不是一个安静的缺口。
       * 这也是「失败的一轮证明不了任何事」的另一面 —— **失败本身必须可见**。
       */
      const fail = (code: AgentErrorCode, message: string): void => {
        opts.batcher.push(turn.id, { k: 'error', code, message, fatal: true })
        const t = terminalOf('crashed')
        opts.batcher.endTurn(turn.id, {
          reason: t.reason,
          status: t.status,
          errorText: message,
          exitCode: null
        })
      }

      if (!member) {
        fail('protocol', '这个轮次的成员已经被移除了，没有被执行')
        return
      }
      if (!member.enabled) {
        fail('protocol', `成员「${member.displayName}」已停用，没有执行这一轮`)
        return
      }
      if (!actor) {
        fail('protocol', `成员「${member.displayName}」的角色已经被删除了，没有执行这一轮`)
        return
      }
      const adapter = opts.adapters.get(actor.agentKind)
      if (!adapter) {
        // 这个错误码的**字面**说的是「找不到可执行文件」，而实情是「这种 agent 还没有适配器」。
        // **用 `message` 说真话**：界面读的是这句话，错误码只是给 M8 的「下一步怎么办」分类用。
        fail(
          'cli_not_found',
          `「${actor.name}」用的是 ${actor.agentKind}，而这个 agent 类型还没有适配器` +
            `（当前只支持 claude）。这一轮没有被执行。`
        )
        return
      }

      // ── 4. 上下文装配（§4.6 / M7a）──
      //
      // ★ **触发行必须先单独判空。** 装配之后提示词**永远非空**（prelude 一定在），
      // 所以 M6a 那条「空提示词不出门」的守卫不能靠装配结果做 ——
      // 它得在这里，用触发行本身做。少了它，模型会对着一份「只有环境说明、
      // 没有请求」的提示词说话，并可能真的去改文件。
      const trigger = turn.triggerMessageId ? store.message.get(turn.triggerMessageId) : null
      if (!trigger || !trigger.contentText || trigger.contentText.trim().length === 0) {
        // 理论上不可达（`turn:send` 一定带 triggerMessageId 且正文非空），但代价太大。
        fail('protocol', '这一轮没有可发送的用户消息，已取消执行')
        return
      }

      // 作者名要现查：`message` 表只存 `author_member_id`，而标签需要显示名。
      // 缓存一下 —— 一段历史里作者通常只有两三个。
      const nameCache = new Map<string, string | null>()
      const nameOf = (memberId: string): string | null => {
        if (!nameCache.has(memberId)) {
          nameCache.set(memberId, store.member.get(memberId)?.displayName ?? null)
        }
        return nameCache.get(memberId) ?? null
      }
      // ★ 映射本身在 `context-builder` 那边（`historyMessageOf`）—— 压缩折骨架时用的是
      // 同一个函数，于是「谁在说话」在两处不可能分叉。这里只负责提供名字的查法。
      const toHistory = (m: Message): HistoryMessage => historyMessageOf(m, nameOf)

      const rows = store.message.listRecentBySession(session.id, historyLimit + 1)
      // 多取一条只为了**知道有没有被截掉** —— 恰好取满 `limit` 时，多出来那条就是证据。
      const capped = rows.length > historyLimit
      const window = capped ? rows.slice(rows.length - historyLimit) : rows
      const history = window.map(toHistory)
      if (capped) {
        warn(
          'history-window-capped',
          `会话历史超过 ${historyLimit} 条取数上限，更早的消息没有进入本轮上下文：` +
            '压缩本应已经把旧消息折叠掉 —— 撞上这个上限说明压缩没跟上',
          { turnId: turn.id, limit: historyLimit, fetched: rows.length }
        )
      }
      if (!history.some((m) => m.id === trigger.id)) {
        // 触发行被上限挤出窗口。实机上不可达（它刚被写入、而挤出它需要 200 条更新的消息），
        // 但**不能因此不管**：提示词里没有本轮请求 = 模型对着空气说话。
        // 补在末尾并如实报警 —— 补是安全的，因为「请求在最后」本来就是这段历史的形状。
        warn('history-missing-trigger', '本轮触发行不在历史窗口里，已单独补在末尾', {
          turnId: turn.id
        })
        history.push(toHistory(trigger))
      }

      const build = await buildContext(
        {
          turn: { id: turn.id, sessionId: turn.sessionId, workspaceId: turn.workspaceId },
          actor: { name: actor.name, personaPath: actor.personaPath, personaHash: actor.personaHash },
          member: {
            id: member.id,
            displayName: member.displayName,
            roleDescPath: member.roleDescPath,
            roleDescHash: member.roleDescHash
          },
          workspace: { name: workspace.name, dirName: workspace.dirName },
          cwd: decision.cwd,
          cwdSource: decision.source,
          addDirs,
          projects,
          history,
          session: {
            compactedThroughSeq: session.compactedThroughSeq,
            rollingSummary: session.rollingSummary
          }
        },
        {
          readText: opts.textReader,
          // 项目记忆由**这一轮真正要跑的那个适配器**去收：`claude` 收 `CLAUDE.md` 那一套，
          // 日后的 `codex` 收它自己认识的文件集，而装配逻辑一行都不用改（§8.5c 性质 4）。
          collectProjectContext: (rootPath) => adapter.collectProjectContext(rootPath)
        }
      )

      // 装配的处境**全部要留痕**：项目记忆没读到、cwd 那份被剔了、水位线有洞……
      // 这些都是「模型看到的世界与用户以为的不一样」，而它们一个都不会让轮次失败。
      for (const n of build.notes) {
        warn(`context:${n.tag}`, n.message, { turnId: turn.id, level: n.level, detail: n.detail })
      }
      opts.onContextBuilt?.(turn.id, build.shape)

      // ★ 人设读不到 = 致命。判决在这里（见文件头）：读不到意味着建立之后被删/被改，
      // 而用一份空人设跑下去，用户会以为他的角色在干活。
      if (build.shape.personaBytes === null) {
        fail(
          'protocol',
          `角色「${actor.name}」的人设文件读不到（${actor.personaPath}）。` +
            '人设是这个角色的唯一身份来源 —— 用一份空人设跑下去，等于换了个东西在干活' +
            '却不告诉用户，所以这一轮没有被执行。'
        )
        return
      }

      const ctx: TurnContext = {
        turnId: turn.id,
        sessionId: turn.sessionId,
        cwd: decision.cwd,
        messages: build.messages,
        systemPrompt: build.systemPrompt,
        model: actor.model,
        effort: actor.effort,
        permissionMode: permissionModeOf(member.permissionJson),
        maxBudgetUsd,
        addDirs
      }

      // ── 5. 取消通道：M6a 只登记，不 abort（`turn:stop` 的 running 分支是 M9）──
      const controller = new AbortController()
      opts.cancelTable.registerCancel(turn.id, controller)

      let doneReason: TerminalReason | null = null
      let fatalError: string | null = null
      let pidWritten = false

      try {
        try {
          for await (const ev of adapter.run(ctx, controller.signal)) {
            // 适配器 spawn 之后自己把子进程登记进了 child-registry —— 这里**只是去读**
            // 一个已经存在的事实，好让 `turn.pid` 落库（M10 要靠它 taskkill）。
            // 放在第一个事件上而不是 spawn 之前：pid 是 spawn 的产物，在它之前问没有意义。
            if (!pidWritten) {
              const pid = opts.pidOf(turn.id)
              if (pid !== null) {
                store.turn.setPid(turn.id, pid)
                pidWritten = true
              }
            }
            if (ev.k === 'done') doneReason = ev.reason
            if (ev.k === 'error' && ev.fatal) fatalError = ev.message
            opts.batcher.push(turn.id, ev)
          }
        } catch (err) {
          // 适配器的生成器抛了 —— 契约要求它**绝不抛**，所以这是**我们自己的** bug。
          // 不往外抛：这一轮已经跑了一半，把它变成「整个 run 崩了」只会丢掉已经落库的东西。
          const detail = err instanceof Error ? err.message : String(err)
          warn('adapter-threw', `适配器在轮次 ${turn.id} 上抛了异常：${detail}`, {
            turnId: turn.id
          })
          fatalError = fatalError ?? `适配器内部错误：${detail}`
        }

        // ── 6. 诊断：**只转发，不落库**（`EVENT_KINDS` 里没有这一类）──
        const diags = opts.adapters.diagnosticsOf(actor.agentKind, turn.id)
        for (const d of diags) {
          warn(`adapter-diag:${d.tag}`, `${d.level}: ${d.message}`, {
            turnId: turn.id,
            sample: d.sample
          })
        }

        // ★ `<synthetic>` 那条路径的**去处**（§4.4d / §8.9-18）：解析器把 CLI 自己造的
        // assistant 正文挡在 `text` 事件之外，但它得有地方去 —— 否则「Prompt is too long」
        // 要么变成模型说的话，要么彻底消失。这里接住：没有别的致命错误时，它就是失败原因。
        if (!fatalError) {
          const synthetic = diags.filter((d) => d.tag === 'synthetic-assistant')
          if (synthetic.length > 0) {
            fatalError = synthetic.map((d) => d.message).join('\n')
            // 顺便把结论也定下来：CLI 明确说了这一轮没成，不许报成 `complete`。
            if (doneReason === null || doneReason === 'complete') doneReason = 'crashed'
          }
        }
      } finally {
        opts.cancelTable.forgetCancel(turn.id)
      }

      // ── 7. 收尾：映射表 + 一个事务（`done` 帧与终态行同批）──
      const mapped = terminalOf(doneReason)
      opts.batcher.endTurn(turn.id, {
        reason: mapped.reason,
        status: mapped.status,
        errorText: fatalError,
        exitCode: null
      })

      // ── 8. `@` 扇出（M7b）：**在 `endTurn` 之后**，理由见 `onTurnFinished` 的说明 ──
      opts.onTurnFinished?.(turn, turnFinishedInfoOf(turn.id))
    }
  }

  /**
   * 收集「这一轮结束时」要交给扇出的事实。
   *
   * ★ 读的是**刚提交的库**（`endTurn` 已经落定）：这一轮的回复、它有没有干活。
   * 两件事都必须从库里读，不能从内存里的流事件攒 —— 「这一轮到底产出了什么」
   * 的唯一事实源是库，而扇出的判据要在**归档里重判得出来**（§8.8e 纪律）。
   */
  function turnFinishedInfoOf(turnId: string): TurnFinishedInfo {
    const produced = opts.store.message.listByTurn(turnId)
    const replyText = replyTextOf(produced)
    const hadWork = produced.some((m) =>
      WORK_EVENT_KINDS.some((kind) => opts.store.message.listEventsByKind(m.id, kind).length > 0)
    )
    return { mentions: parseMentionsBlock(replyText), replyText, hadWork }
  }
}
