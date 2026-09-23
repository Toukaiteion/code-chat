import type { AdapterRegistry } from '../adapters/registry.ts'
import type { ChildRegistry } from './child-registry.ts'
import type { Store } from '../persist/index.ts'
import type { Mention, Turn } from '../../shared/entities.ts'
import type { ContextShape } from '../domain/context-builder.ts'
import type { PushOf } from '../../shared/ipc/contract.ts'
import { spacePaths } from '../infra/space-dir.ts'
import { readTextFile } from '../infra/text-file.ts'
import { createEventBatcher, type BatcherStore, type EventBatcher, type ResumeResult, type StatusPayload, type StreamBatch, type UnreadPayload, type ViewLike } from './event-batcher.ts'
import { createFanout, type Fanout } from './fanout.ts'
import { createScheduler, type Scheduler, type SchedulerState, type StartupSweep } from '../domain/scheduler.ts'
import { createTurnRunner } from '../domain/turn-runner.ts'
import { resolveTurnCwd, type CwdDecision } from '../domain/turn-cwd.ts'

/**
 * 运行时门面 —— **调度器 / 合批器 / 适配器 / 子进程登记处**这四件东西的装配点与唯一入口。
 *
 * 它在 M6a 里回答一个具体的问题：**谁有权把一个轮次送进那条管道？**
 * 答案是「只有这里」。`ipc/handlers/turn.ts` 的 `turn:send` 做完库里的两笔写之后，
 * 唯一能做的事就是调 `runtime.dispatch(turn)` —— 它不可能绕过调度器直接去跑适配器，
 * 因为除了本文件没有任何地方同时握着那两半（§4.5a 规则一：唯一入口）。
 *
 * ## 为什么 emit 是注入进来的三件回调，而不是一个 `Registry`
 *
 * 生产环境里 registry 与本模块**互为先后**：registry 的 `HandlerContext` 要拿到
 * runtime，而 runtime 的推送要走 registry 的 `emit`。用一个泛化的
 * `emit(channel, payload)` 把这个环藏起来，只会让「谁在什么时候才是活的」
 * 变成一个到处都要小心的隐状态。拆成三个**具体的**回调之后，
 * 调用方（`main/index.ts` / `test/ipc/helpers.ts`）自己决定那个环怎么接。
 *
 * （第三件 `emitStatus` 是 M6b 加的，与前两件同理：**推送的生产者只有本文件
 * 装配的那几件东西**。`turn:stop` 要把 `queued` 翻成 `cancelled`，走的也是
 * 门面上那个 `emitStatus`，而不是自己去找 registry —— 否则生产者的名单就散了。）
 *
 * ## 它不 import electron
 *
 * 空间根目录由调用方递进来（`infra/paths.ts` 里那个函数 import 了 electron）。
 * 于是本文件连同它装配的四件东西**全部**能在裸 Node 下跑真的一套 ——
 * 这正是 `test/ipc/helpers.ts` 敢构造真 runtime 而不是打桩的原因。
 */

export interface RuntimeOptions {
  store: Store
  children: ChildRegistry
  adapters: AdapterRegistry
  /** §8.3 的 `<workspaceRoot>`。 */
  workspaceRoot: string
  /** 渲染层当前可见的空间 —— **同一个对象**会被 `view:setActive` 改写，合批器持引用读它。 */
  view: ViewLike
  emitBatch(batch: StreamBatch): void
  emitUnread(payload: UnreadPayload): void
  /**
   * 轮次状态切换的推送（`stream:status`）。
   *
   * ★ **不抑制**：批次按可见空间抑制，状态不抑制 —— 侧边栏要显示「谁在跑」，
   * 那本来就是跨空间的（见 `event-batcher` 的文件头与 `channels.ts` 的四条白名单）。
   */
  emitStatus(payload: StatusPayload): void
  /**
   * ★ `app:notice` 的生产者（M7b 加的第四件回调，与前三件同理）。
   *
   * 在 M7b 之前这条通道**只有启动期**在用（`main/index.ts` 的 `notify()`）——
   * 而 §4.5b 要求乒乓熔断「弹一条**可见**警告（UI 提示 + 一条系统事件，落库）」，
   * 那条可见警告就是它。**不抑制**（与 `emitStatus` 同理）：它不是流内容。
   *
   * ★ 它**必须注入**：本文件不 import electron、`ipc/` 也不认识它 ——
   * 装配处（`main/index.ts` / `test/ipc/helpers.ts`）自己决定怎么接。
   */
  emitNotice(notice: PushOf<'app:notice'>): void
  now(): number
  newId(): string
  onWarn(tag: string, message: string, detail?: unknown): void
  /** 并发上限（§2.3，默认 3）。 */
  concurrency?: number
  /** 本进程的纪元。给测试写死；生产省略则现铸一个。 */
  epoch?: string
  maxBudgetUsd?: number
  /** 合批刷新间隔（§4.3：33ms ≈ 30Hz）。测试注入一个短值，免得每个用例真等 33ms。 */
  flushMs?: number
  /** `workspace:unread` 的节流间隔（§4.3：≤1Hz）。 */
  unreadMs?: number
  /** 会话历史的**取数**上限（见 `turn-runner.DEFAULT_HISTORY_LIMIT`）。 */
  historyLimit?: number
  /** ★ 装配形状的观测缝 —— **只传形状、不传正文**（见 `TurnRunnerOptions.onContextBuilt`）。 */
  onContextBuilt?(turnId: string, shape: ContextShape): void
}

export interface Runtime {
  readonly batcher: EventBatcher
  readonly epoch: string
  /**
   * 派发**之前**就要算出来的 cwd。
   *
   * `turn.cwd` 是 `NOT NULL`，所以「这一轮会在哪个目录里跑」必须在插入那一条
   * `queued` 行时就回答。这和 `turn-runner` 在开跑时再解析一次并不重复 ——
   * 两处都调同一个纯函数，而 runner 那边还会比对「派发之后主项目被改过吗」并如实报。
   * 界面显示「将在哪里运行」用的就是这个值。
   */
  cwdFor(workspaceId: string, memberId: string): CwdDecision
  /**
   * 把一个**已经落库为 `queued`** 的轮次交给调度器。调用方必须先提交事务 ——
   * 这里会立刻去读它。这是轮次进入管道的**唯一**入口（见文件头）。
   */
  dispatch(turn: Turn): void
  cancelQueued(turnId: string): void
  /**
   * 用户在 `turn:send` 里结构化 `@` 的那条路（§5.1 的跳 1-4）。
   *
   * 它**不是**第二个派发入口：里面最终仍然只调 `dispatch`（§4.5a 规则一）——
   * 加这一层是为了让 `handlers/turn.ts` 不必拿到扇出对象，
   * 也不必知道去重基准 / 转述正文这些事。
   * 调用方必须在**自己那个事务提交之后**调它（它会立刻回库里读会话与成员）。
   */
  fanoutUserMentions(input: {
    workspaceId: string
    authorMemberId: string
    text: string
    mentions: readonly Mention[]
  }): void
  /**
   * 把一次状态切换推出去。**只给 `turn:stop` 用** —— 那是唯一一个在 handler 里
   * 写终态的路径（把 `queued` 翻成 `cancelled`，`handlers/turn.ts`）。
   * 其余切换点都在本文件装配的那几件东西内部，各自直接调 `opts.emitStatus`。
   */
  emitStatus(payload: StatusPayload): void
  resume(sessionId: string, epoch: string, fromSeq: number): ResumeResult
  state(): SchedulerState
  /** 启动清扫。**只调一次**，在建好 registry 之后、窗口加载之前。 */
  startupSweep(): StartupSweep
  /** 用户切到某个空间 → 清掉它的未读。 */
  onViewChanged(workspaceId: string | null): void
  /** 退出路径：**先于** `store.close()` 调用（同步冲空 + 清定时器）。 */
  close(): void
  /** 测试用：等所有在跑与排队的轮次结束。 */
  idle(): Promise<void>
}

/**
 * 把整个 `Store` 收窄成合批器要的那一小片（`BatcherStore`）。
 *
 * ★ **导出它，不只是为了让 `createRuntime` 好看** —— `test/process/event-batcher.test.ts`
 * 需要造一个「真的库 + 真的合批器」的台子，而台子上那一小片**必须与生产逐字相同**。
 * 在测试文件里再抄一遍的话，两边一旦分叉，测试验的就是一个生产里不存在的合批器
 * （最典型的形态：这边接上了某个 repo 方法、那边忘了，于是「落库失败」那条路径
 * 在测试里永远走不到）。窄口的形状是合批器定的，**接线只有一处**。
 */
export function batcherStoreOf(store: Store): BatcherStore {
  return {
    tx: store.tx,
    message: {
      append: (input) => store.repos.message.append(input),
      appendEvent: (input) => store.repos.message.appendEvent(input),
      setStreamedText: (id, text) => store.repos.message.setStreamedText(id, text)
    },
    session: {
      advanceSeq: (id, seq) => store.repos.session.advanceSeq(id, seq),
      bumpTurnCount: (id, now) => store.repos.session.bumpTurnCount(id, now)
    },
    turn: {
      finish: (id, status, usage, now, exitCode, errorText) =>
        store.repos.turn.finish(id, status, usage, now, exitCode, errorText)
    }
  }
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const store = opts.store

  const batcher = createEventBatcher({
    store: batcherStoreOf(store),
    clock: {
      now: opts.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    },
    view: opts.view,
    emitBatch: opts.emitBatch,
    emitUnread: opts.emitUnread,
    emitStatus: opts.emitStatus,
    onWarn: opts.onWarn,
    ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}),
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    ...(opts.unreadMs !== undefined ? { unreadMs: opts.unreadMs } : {})
  })

  /**
   * cwd 的**唯一**解析点（三级兜底）。
   *
   * 抽成函数是因为它现在有两个调用方：`turn:send`（`runtime.cwdFor`）与扇出的转述派发
   * （派给别人的那一轮也要有 cwd，且必须按**对方**算）。两处各写一遍就会分叉 ——
   * 而分叉的表现是「界面上说将在 A 里跑，实际在 B 里跑」。
   */
  function runtimeCwdFor(workspaceId: string, memberId: string): CwdDecision {
    const workspace = store.repos.workspace.get(workspaceId)
    if (!workspace) throw new Error(`空间 ${workspaceId} 不存在，算不出 cwd`)
    return resolveTurnCwd({
      memberPrimaryProjectId: store.repos.member.primaryProjectId(memberId),
      workspaceActiveProjectId: workspace.activeProjectId,
      projects: store.repos.project.listByWorkspace(workspaceId),
      scratchPath: spacePaths(opts.workspaceRoot, workspace.dirName).scratch
    })
  }

  /**
   * ★ 扇出编排（M7b）。**它拿到的是 `dispatch` / `cancelQueued` 这两个注入进来的函数值**，
   * 而那两件东西的实现只可能是下面 `scheduler` 那两个调用 —— 于是
   * 「谁有权把一个轮次送进管道」这件事仍然只有一个答案（§4.5a 规则一）。
   *
   * ⚠️ 定义顺序：它引用的 `scheduler` 在下面才建（`dispatch` 要等调度器存在）。
   * 这里用「箭头函数闭包里读」而不是把扇出挪到调度器之后 ——
   * 因为 `createTurnRunner` 要在扇出**之前**建（runner 要拿到 `fanout.onTurnFinished`）。
   * 两个东西互为先后，所以第二个引用放在了**运行时**才求值的位置（照 `main/index.ts`
   * 里那个 registry 环的先例：环的方向一眼可见，而不是靠一个 setter 注入）。
   */
  const fanout: Fanout = createFanout({
    store: {
      tx: store.tx,
      turn: {
        get: (id) => store.repos.turn.get(id),
        listLive: () => store.repos.turn.listLive(),
        listRecentByQueuedAt: (workspaceId, limit) =>
          store.repos.turn.listRecentByQueuedAt(workspaceId, limit),
        create: (input) => store.repos.turn.create(input),
        markCancelled: (id, now) => store.repos.turn.markCancelled(id, now)
      },
      message: {
        get: (id) => store.repos.message.get(id),
        append: (input) => store.repos.message.append(input),
        listByTurn: (turnId) => store.repos.message.listByTurn(turnId),
        listEventsByKind: (messageId, kind) => store.repos.message.listEventsByKind(messageId, kind)
      },
      member: {
        get: (id) => store.repos.member.get(id),
        listByWorkspace: (workspaceId) => store.repos.member.listByWorkspace(workspaceId)
      },
      session: {
        get: (id) => store.repos.session.get(id),
        getByMember: (memberId) => store.repos.session.getByMember(memberId)
      }
    },
    // ★ cwd 按**被派发方**算（三级兜底），所以给的是运行时自己的那个解析器 ——
    //   与 `turn:send` 用的是同一个函数，两处不可能算出不同的目录。
    cwdFor: (workspaceId, memberId) => runtimeCwdFor(workspaceId, memberId),
    dispatch: (turn) => scheduler.enqueue(turn),
    cancelQueued: (turnId) => scheduler.cancel(turnId),
    emitStatus: opts.emitStatus,
    emitNotice: opts.emitNotice,
    now: opts.now,
    newId: opts.newId,
    onWarn: opts.onWarn
  })

  const runner = createTurnRunner({
    store: {
      turn: {
        get: (id) => store.repos.turn.get(id),
        setPid: (id, pid) => store.repos.turn.setPid(id, pid)
      },
      message: {
        get: (id) => store.repos.message.get(id),
        listRecentBySession: (sessionId, limit) =>
          store.repos.message.listRecentBySession(sessionId, limit),
        listByTurn: (turnId) => store.repos.message.listByTurn(turnId),
        listEventsByKind: (messageId, kind) => store.repos.message.listEventsByKind(messageId, kind)
      },
      session: { get: (id) => store.repos.session.get(id) },
      member: {
        get: (id) => store.repos.member.get(id),
        visibleProjectIds: (memberId) => store.repos.member.visibleProjectIds(memberId),
        primaryProjectId: (memberId) => store.repos.member.primaryProjectId(memberId)
      },
      actor: { get: (id) => store.repos.actor.get(id) },
      workspace: { get: (id) => store.repos.workspace.get(id) },
      project: { listByWorkspace: (workspaceId) => store.repos.project.listByWorkspace(workspaceId) }
    },
    batcher,
    adapters: opts.adapters,
    cancelTable: {
      registerCancel: (turnId, controller) => opts.children.registerCancel(turnId, controller),
      forgetCancel: (turnId) => opts.children.forgetCancel(turnId)
    },
    pidOf: (turnId) => opts.children.handleOf(turnId)?.pid ?? null,
    scratchPathOf: (workspace) => spacePaths(opts.workspaceRoot, workspace.dirName).scratch,
    // ★ 装配要读人设 / 职责描述。**这里是「读文件」这件事在编排层的唯一所有者** ——
    // `domain/` 那一侧只见到一个函数值，不 import `infra/text-file.ts`（§4.5a 规则一）。
    textReader: readTextFile,
    now: opts.now,
    newId: opts.newId,
    onWarn: opts.onWarn,
    ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    ...(opts.historyLimit !== undefined ? { historyLimit: opts.historyLimit } : {}),
    ...(opts.onContextBuilt !== undefined ? { onContextBuilt: opts.onContextBuilt } : {}),
    // ★ `@` 扇出：一轮的收尾交给它（**在 `batcher.endTurn` 之后**，见那个选项的说明）。
    onTurnFinished: (turn, info) => fanout.onTurnFinished(turn, info)
  })

  const scheduler: Scheduler = createScheduler({
    store: {
      turn: {
        get: (id) => store.repos.turn.get(id),
        listLive: () => store.repos.turn.listLive(),
        markRunning: (id, now) => store.repos.turn.markRunning(id, now),
        reapOrphans: (now) => store.repos.turn.reapOrphans(now)
      }
    },
    now: opts.now,
    run: (turn) => runner.run(turn),
    /**
     * `runner.run()` **只**在库自身不一致时抛（会话/空间行不见了）。
     * 那不是一个「模型失败」，所以这里直接写终态行 —— 不走合批器：一条事件都没有的一轮
     * 不该在时间线上留下一条 assistant 消息，它该是一条**如实**的失败记录。
     */
    onRunCrashed: (turnId, err) => {
      const message = err instanceof Error ? err.message : String(err)
      opts.onWarn('run-crashed', `轮次 ${turnId} 的执行器抛了异常：${message}`, { turnId })
      const row = store.repos.turn.get(turnId)
      if (!row || row.status !== 'running') return
      store.tx(() => {
        store.repos.turn.finish(
          turnId,
          'failed',
          { terminalReason: 'crashed' },
          opts.now(),
          null,
          `执行器内部错误：${message}`
        )
      })
      /**
       * 这里也写了一次终态（`turn.finish`），所以**这里也得发**。
       *
       * 漏掉它的后果很具体：崩溃的那一轮在界面上永远停在「运行中」——
       * 而这正是本文件开头那段「执行器崩溃不该被当成模型失败」想避免的谎。
       * 走的是同一个 `turn.finish`，只是没经过合批器（那一轮本来就没有事件）。
       */
      opts.emitStatus({
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        turnId,
        status: 'failed',
        reason: 'crashed'
      })
    },
    emitStatus: opts.emitStatus,
    onWarn: opts.onWarn,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {})
  })

  return {
    batcher,
    epoch: batcher.epoch,

    cwdFor: runtimeCwdFor,

    dispatch: (turn) => scheduler.enqueue(turn),
    cancelQueued: (turnId) => scheduler.cancel(turnId),
    fanoutUserMentions: (input) => fanout.dispatchUserMentions(input),
    emitStatus: opts.emitStatus,
    resume: (sessionId, epoch, fromSeq) => batcher.resume(sessionId, epoch, fromSeq),
    state: () => scheduler.state(),
    /**
     * 启动清扫也把遗留轮次翻成 `failed`，但**刻意不发** `stream:status`：
     * 此刻窗口还没加载，发了没有听众，而渲染层随后用 `runtime:getState` 读到的
     * 是**已经落库的事实** —— 那条路更硬。
     */
    startupSweep: () => scheduler.sweepStartup(),
    onViewChanged: (workspaceId) => {
      if (workspaceId !== null) batcher.clearUnread(workspaceId)
    },
    close: () => batcher.close(),
    idle: () => scheduler.idle()
  }
}

