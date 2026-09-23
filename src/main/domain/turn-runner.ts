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
  Message,
  Session,
  TerminalReason,
  Turn,
  Workspace,
  WorkspaceMember
} from '../../shared/entities.ts'
import type { CwdProject } from './turn-cwd.ts'
import { resolveAddDirs, resolveTurnCwd } from './turn-cwd.ts'

/**
 * 单轮编排 —— 把「库里的一条 `queued` 轮次」变成「一次真实的 agent 调用 + 一串落库的事件」。
 *
 * ## 它的边界：M6a 的 `TurnContext` 是**最小但真实**的一份
 *
 * `TurnContext` 的**形状**是 M5 锁定的，M6a 只负责填。填进去的东西与不填的东西
 * 一样重要，逐条写在这里，免得 M7 把它们当成「已经有了」：
 *
 * | 字段 | M6a 的来源 |
 * |---|---|
 * | `cwd` | `turn-cwd.ts` 的三级兜底（主项目 → 空间 active 项目 → `scratch/`） |
 * | `addDirs` | §8.4 的可见性（`member_project`）—— **本函数是可见性模型的第一个真实消费方** |
 * | `messages` | **只有当轮那条用户消息**。不拼历史 —— 那是 M7 的 `context-builder` |
 * | `systemPrompt` | **空串**。`<env>/<summary>/<recent>/<trigger>` 的装配是 M7 |
 * | `model` / `effort` | `actor.model`（自由文本，§2.4-1）/ `actor.effort` |
 * | `permissionMode` | `member.permissionJson.mode ?? 'bypassPermissions'` |
 * | `maxBudgetUsd` | 常量默认值（`DEFAULT_MAX_BUDGET_USD`），成员覆盖是 M8 |
 *
 * **代价说清楚**：M6a 里同一会话的第二轮**不记得**第一轮。这不是遗漏，
 * 它是 M7 的验收项本身（「第 2 轮能正确引用第 1 轮」）。
 * 另外本函数**不调 `collectProjectContext`**（§8.5c 把它放在首条 user 消息里，
 * 属于上下文装配 = M7）——但 agent 并非全盲：**cwd 里的 `CLAUDE.md` 由 CLI 自己自动注入**
 * （M5 实测），而 `--add-dir` 目录里的那份不会。M6a 只如实记录这条不对称，去重规则是 M7 的。
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

/** 编排一轮需要的**最小**持久化面。 */
export interface TurnRunnerStore {
  turn: {
    get(id: string): Turn | null
    /** spawn 之后补 pid（**与状态翻转是两次写入**，见 `turn-repo.markRunning`）。 */
    setPid(id: string, pid: number): Turn | null
  }
  message: { get(id: string): Message | null }
  session: { get(id: string): Session | null }
  member: {
    get(id: string): WorkspaceMember | null
    visibleProjectIds(memberId: string): { ids: string[]; isRestricted: boolean }
    primaryProjectId(memberId: string): string | null
  }
  actor: { get(id: string): Actor | null }
  workspace: { get(id: string): Workspace | null }
  project: { listByWorkspace(workspaceId: string): CwdProject[] }
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
  now(): number
  newId(): string
  onWarn(tag: string, message: string, detail?: unknown): void
  maxBudgetUsd?: number
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

      // ── 4. 上下文：**只有当轮那条用户消息**（见文件头那张表）──
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
      if (turn.triggerMessageId) {
        const trigger = store.message.get(turn.triggerMessageId)
        if (trigger?.contentText) messages.push({ role: 'user', content: trigger.contentText })
      }
      if (messages.length === 0) {
        // 理论上不可达（`turn:send` 一定带 triggerMessageId），但**空提示词发出去**
        // 会让模型对着空气说话、并可能真的改文件 —— 这个代价太大，值得一行守卫。
        fail('protocol', '这一轮没有可发送的用户消息，已取消执行')
        return
      }

      const ctx: TurnContext = {
        turnId: turn.id,
        sessionId: turn.sessionId,
        cwd: decision.cwd,
        messages,
        // ★ M6a 是空串。§4.6 的装配是 M7 —— 见文件头那张表。
        systemPrompt: '',
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
    }
  }
}
