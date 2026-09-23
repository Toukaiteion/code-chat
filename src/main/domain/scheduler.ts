import type { Turn } from '../../shared/entities.ts'
import type { PushOf } from '../../shared/ipc/contract.ts'

/**
 * 轮次调度器 —— §4.5 的两条不变量的**唯一**实现点。
 *
 * 1. **全局并发上限**（默认 3，可配）。
 * 2. **每 session 至多一个 running**：同一个角色的两轮之间必须**串行**，
 *    否则两条回答的帧会交错，渲染层会把它们拼成一条 —— 而那是**静默**的。
 *
 * ## 排队是持久的，队列是内存的（★ 这两句话不矛盾，是刻意分开的）
 *
 * - **持久**的那部分：`turn:send` 在**同一个事务**里写用户消息 + 一条 `queued` 轮次。
 *   于是侧边栏能诚实显示「N 个排队中」，硬杀重启后那条 `queued` 也还在。
 * - **内存**的那部分：本模块手里那份「**允许被派发**」的 turnId 队列。
 *
 * 为什么必须分开：§4.5 明写了「**不自动恢复**」——
 * 上一进程留下的 `queued` 轮次要**原样留着**并告诉用户「有 N 个没执行」，
 * 而不是重启之后自己跑起来（那会在用户没看着的时候动他的代码）。
 * 让派发只认内存队列，「不自动恢复」就是**结构性**的，不依赖任何标志位：
 * 进程刚起来时内存队列是空的，库里那些 `queued` 一条都派不出去。
 *
 * ## `queued → running` 恰好一次
 *
 * 派发时**先在事务里**翻状态，翻转成功（返回了行）才算真的派发。
 * 于是「取消排队」与「派发」之间没有窗口：`turn:stop` 把行改成 `cancelled` 之后，
 * `markRunning` 的 `WHERE id = ?` 仍然会返回行**并把它改回 running** —— 所以
 * 取消必须在**内存队列**上也摘一次（`cancel()`），两条路径都堵上才叫恰好一次。
 *
 * ## 它不 import electron、不 import `node:sqlite`
 *
 * 持久化面是注入的窄口（`SchedulerStore`），所以 `test/domain/scheduler.test.ts`
 * 可以用裸 Node 跑真调度 + 内存库，不需要起应用。
 */

/** 调度器需要的**最小**持久化面。 */
export interface SchedulerStore {
  turn: {
    get(id: string): Turn | null
    listLive(): Turn[]
    markRunning(id: string, now: number): Turn | null
    /** `queued` + `running` → `failed`（§4.4）。返回被清扫的行。 */
    reapOrphans(now: number): Turn[]
  }
}

export interface SchedulerOptions {
  store: SchedulerStore
  now(): number
  /**
   * 真的去跑一轮。**实现必须自己保证终态写入** —— 调度器只负责在它返回之后
   * 释放槽位，它不替这一轮决定成败。
   */
  run(turn: Turn): Promise<void>
  /**
   * `run()` 自己抛出来时（那是我们代码的 bug，不是模型失败）的兜底。
   * 不给这个口的话，一个抛异常的 `run()` 会让轮次永远停在 `running`，槽位也永远不还。
   */
  onRunCrashed(turnId: string, err: unknown): void
  onWarn(tag: string, message: string, detail?: unknown): void
  /**
   * ★ `stream:status` 的生产者（M6b 补上；此前是个**有 schema、有白名单、
   * 有用例、零生产者**的死通道）。
   *
   * 调度器负责 `queued` 与 `running` 两个切换点，因为**它就是做这件事的那一方**：
   * 前者是「交给队列」，后者紧跟 `markRunning` 的事务提交之后。
   * 终态不在这里 —— 它属于合并终态与正文折叠的那个事务（`event-batcher.endTurn`），
   * 以及 `turn:stop` 把 `queued` 翻成 `cancelled` 的那一处。
   *
   * ⚠️ **发的是「事实」，不是「意图」**：`running` 只在 `markRunning` **真的返回了行**
   * 之后才发。写入失败那条分支（下面那个 `warn`）一帧都不该发出去 ——
   * 否则界面会显示一个从来没开始过的轮次正在运行。
   */
  emitStatus(payload: PushOf<'stream:status'>): void
  /** 并发上限。默认 3（§2.3）。 */
  concurrency?: number
}

export interface SchedulerState {
  /** 库里全部未终结的轮次（`queued` + `running`）。驱动 `runtime:getState`。 */
  liveTurns: Turn[]
  /** 库里 `queued` 的条数。**含本次派发不了的**，这就是诚实值。 */
  queueDepth: number
  /** 本进程内存队列里的条数 —— 与 `queueDepth` 的差 = 上一进程留下的那些。 */
  dispatchable: number
  slots: { used: number; total: number }
}

/**
 * 启动清扫的结果，用来组织那条 `app:notice`。
 *
 * ★ **两类分开报，不合成一个数** —— 它们对用户是两件事：
 * 「有一轮跑到一半被掐了」（要重发）与「有一条消息根本没发出去」（也要重发，
 * 但原因是**我们没启动它**，不是它失败了）。合成一个「3 个问题」什么也没说清。
 *
 * ⚠️ **这里与计划的字面写法有一处分歧，必须写下来**：计划说 `queued` 原样留着、
 * 只 reap `running`。实际执行的是**两类都翻成 `failed`**（沿用 M2 就已实现、
 * 已测过的 `reapOrphans`），理由是「原样留着」会让侧边栏把一条**永远不会执行**的
 * 轮次永远显示成「排队中」—— 那正是本项目最不想要的那种界面谎言。
 * 翻成 `failed` 则可以在 `error_text` 里逐字写清「上次退出时它还在排队，没有自动恢复」。
 * 已记进设计文档 §4.4。
 */
export interface StartupSweep {
  /** 上一进程**正在跑**、被翻成 `failed` 的轮次数。 */
  reapedRunning: number
  /** 上一进程**排队中**（从未启动）、被翻成 `failed` 的轮次数。 */
  reapedQueued: number
}

export interface Scheduler {
  /**
   * 把一个**刚刚落库为 `queued`** 的轮次交给调度器。调用方必须保证事务已提交 ——
   * 这里会立刻去读它，读不到就说明顺序错了（会如实报，不静默丢）。
   */
  enqueue(turn: Turn): void
  /** 用户取消了排队中的轮次（行已经是 `cancelled`）。从内存队列里摘掉，防派发。 */
  cancel(turnId: string): void
  /** 启动时的孤儿清扫 + 遗留 `queued` 统计。**只做一次**，在 `enqueue` 之前。 */
  sweepStartup(): StartupSweep
  state(): SchedulerState
  /** 等所有在跑的轮次结束（测试与退出路径用）。空转时立即 resolve。 */
  idle(): Promise<void>
}

export const DEFAULT_CONCURRENCY = 3

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY

  /**
   * 内存队列 —— **只有这些允许被派发**（见文件头）。`Set` 的插入序即 FIFO 序，
   * 所以不需要另存一个数组；插入序天然是「入队顺序」，而 JS 的 `Set` 保证迭代序
   * 就是插入序，这一点在规范里写死了（不是实现细节）。
   */
  const queue = new Set<string>()
  /** 正在跑的。 */
  const running = new Set<string>()
  /** 已有 running 轮次的 sessionId —— §4.5a 规则一的直接载体。 */
  const busySessions = new Set<string>()
  /** `idle()` 的等待者。 */
  let waiters: Array<() => void> = []

  function warn(tag: string, message: string, detail?: unknown): void {
    opts.onWarn(tag, message, detail)
  }

  /**
   * 派发循环。**同步**跑完所有能派的 —— 没有 setTimeout 的轮询，
   * 于是「槽位一空就立刻派下一个」是确定的，测试不需要推进假时钟。
   */
  function pump(): void {
    while (running.size < concurrency) {
      const next = pickNext()
      if (next === null) break
      dispatch(next)
    }
    if (running.size === 0 && queue.size === 0 && waiters.length > 0) {
      const ws = waiters
      waiters = []
      for (const w of ws) w()
    }
  }

  /**
   * 取「最早入队、且该 session 没有 running、且仍然排在 `queued`」的那一条。
   *
   * ⚠️ 跳过「库里已经不是 `queued`」的条目时**要把它从内存队列里摘掉**，
   * 否则一个被取消的 id 会永远挡在队首（`pickNext` 每次都撞上它，虽然不会死循环，
   * 但队列只增不减，而 `dispatchable` 那个数会越报越大）。
   */
  function pickNext(): Turn | null {
    for (const turnId of queue) {
      const turn = opts.store.turn.get(turnId)
      if (!turn || turn.status !== 'queued') {
        queue.delete(turnId)
        continue
      }
      if (busySessions.has(turn.sessionId)) continue
      return turn
    }
    return null
  }

  function dispatch(turn: Turn): void {
    queue.delete(turn.id)
    const started = opts.store.turn.markRunning(turn.id, opts.now())
    if (!started) {
      // 读得到、却写不动：只可能是这一行在两次读之间被删了（`session:remove`
      // 级联）或被改了状态。如实报，然后继续派下一个。
      warn('dispatch-mark-running-failed', `轮次 ${turn.id} 从 queued 转 running 失败，已跳过`, {
        turnId: turn.id
      })
      return
    }

    running.add(started.id)
    busySessions.add(started.sessionId)

    // ★ 发的是**事实**：`markRunning` 真的返回了行，库里那一行现在就是 `running`。
    // 上面那条早退分支（写不动）刻意不发 —— 那一轮从来没开始过。
    // 顺序也是硬的：这条必须排在 `run()` 之前，否则界面会在「已经开始跑」
    // 之后才收到「开始跑」。
    opts.emitStatus({
      workspaceId: started.workspaceId,
      sessionId: started.sessionId,
      turnId: started.id,
      status: 'running',
      reason: null
    })

    // ★ 刻意不 `await`：`run()` 是长任务（可能几分钟），而这里必须**同步**把
    // 循环推完 —— 否则并发上限形同虚设（三个轮次会被串行地一个个启动）。
    void opts
      .run(started)
      .catch((err: unknown) => {
        // 走到这里的是我们自己的 bug（适配器契约、落库异常……）。
        // 兜底交给注入方：**必须**有人把这个轮次写成终态，否则它会永远 running。
        try {
          opts.onRunCrashed(started.id, err)
        } catch (err2) {
          warn('on-run-crashed-threw', `兜底处理本身又抛了：${describe(err2)}`, {
            turnId: started.id
          })
        }
      })
      .finally(() => {
        running.delete(started.id)
        busySessions.delete(started.sessionId)
        pump()
      })
  }

  return {
    enqueue(turn: Turn): void {
      if (turn.status !== 'queued') {
        warn('enqueue-not-queued', `试图入队的轮次不是 queued（${turn.status}），已忽略`, {
          turnId: turn.id
        })
        return
      }
      queue.add(turn.id)

      /**
       * ★ 先发 `queued`，**再** `pump()` —— 顺序是硬的。
       *
       * `pump()` 是同步的：只要还有槽位，它会在这次调用里就把这一轮派发掉，
       * 于是紧接着发出 `running`。反过来的话，渲染层会先收到 `running`、
       * 再收到 `queued`，界面上那一行会从「运行中」跳回「排队中」并永远停在那儿。
       *
       * `reason: null` 不是占位符：非终态本来就没有原因（schema 里这一列可空）。
       */
      opts.emitStatus({
        workspaceId: turn.workspaceId,
        sessionId: turn.sessionId,
        turnId: turn.id,
        status: 'queued',
        reason: null
      })

      pump()
    },

    cancel(turnId: string): void {
      queue.delete(turnId)
      // 在跑的轮次不走这里 —— `turn:stop` 对 `running` 仍然是 `E_NOT_IMPLEMENTED`（M9）。
      // 这一行只是让内存队列与库保持一致。
    },

    sweepStartup(): StartupSweep {
      // 先数，后扫 —— 清扫是一条不分青红皂白的 UPDATE，扫完就分不出谁原来是什么了。
      const live = opts.store.turn.listLive()
      const queued = live.filter((t) => t.status === 'queued').length
      const runningRows = live.filter((t) => t.status === 'running').length

      // 上一进程留下的 queued/running 全部翻成 `failed`（§4.4 的**状态层**，
      // 在 M6a 提前落地；**真正的进程残留清扫仍归 M10** —— 那要按 `pid` 去
      // `taskkill`，而 pid 可能早就被系统回收给了别人）。
      const reaped = opts.store.turn.reapOrphans(opts.now())
      if (reaped.length !== queued + runningRows) {
        // 清扫是原子的，两个数却来自两次读 —— 不一致只可能意味着**有别的写入者**。
        warn('sweep-count-mismatch', '启动清扫的条数与清扫前不一致（有并发写入者？）', {
          reaped: reaped.length,
          expected: queued + runningRows
        })
      }

      return { reapedRunning: runningRows, reapedQueued: queued }
    },

    state(): SchedulerState {
      const liveTurns = opts.store.turn.listLive()
      return {
        liveTurns,
        queueDepth: liveTurns.filter((t) => t.status === 'queued').length,
        dispatchable: queue.size,
        slots: { used: running.size, total: concurrency }
      }
    },

    idle(): Promise<void> {
      if (running.size === 0 && queue.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
