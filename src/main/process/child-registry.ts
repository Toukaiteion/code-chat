import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'
import type { CancelTable } from '../adapters/agent-adapter.ts'

/**
 * 活着的子进程登记处 + 「这一轮要停」的唯一存放处。
 *
 * M5 里它只有两个消费者（适配器与探针），但它的形状是按 M9/M10 的需要定的：
 * `turn:stop` 要按 turnId 找到进程与取消信号，`before-quit` 要能枚举全部再逐个杀树，
 * 启动清扫要按 `turn.pid` 去`taskkill` 上次硬杀留下的孤儿（§4.4）。
 *
 * ## ★ §4.4 的中断阶梯：顺序必须换（Windows）
 *
 * §4.4 写的阶梯是：① stdin `control_request/interrupt` → ② `child.kill('SIGTERM')`
 * → ③ `taskkill /PID <pid> /T /F`。问题出在 **② 在 ③ 之前**：
 *
 * - Windows 上 `child.kill('SIGTERM')` **不是信号**。libuv 是用 `TerminateProcess`
 *   实现的，也就是**立刻硬杀**直接子进程 —— 没有收尾、没有遗言。
 * - 而 `taskkill /T` 是沿**父进程链**（ParentProcessId）走整棵树的。根一旦没了，
 *   拿一个死掉的 PID 去发 `/T`，它只会回一句「找不到进程」——
 *   **此时任何补救都已经来不及**。
 *
 * ### 实测（Node 24 / Windows 11 26200，本机）
 *
 * 我原本在这里写的是「于是旧阶梯的净效果是只杀根、放过整棵树」。**那句话说过头了**，
 * 实测把它收窄成了下面这三条：
 *
 * 1. **非 detached 的孙进程会随根一起死。** 那是继承来的 Job Object 在起作用
 *    （`detached: true` 的孙摘出了这个 job）。所以杀根在那种情形下**看起来**
 *    把树收干净了 —— 也正因为如此，一条用普通孙进程写的用例会**假绿**。
 * 2. **detached 的孙进程，杀根之后真的活得下来。** MCP server 这类东西经常是
 *    detached 起来的，所以这不是构造出来的边界。
 * 3. **根还活着的时候发 `taskkill /T /F`，连 detached 的孙也收得回来** ——
 *    因为 `/T` 走的是父进程链，而 detached 只改进程组、不改父进程链。
 *
 * 结论：**第 2/3 级都必须在根还活着的时候发。** 这不是「Windows 一定会漏掉整棵树」，
 * 而是「先杀根就把**唯一**能收回 detached 后代的手段废掉了，且废掉之后无法补救」。
 * M10 的验收标准是「带运行中的轮硬杀应用 → 重启 → 任务管理器无残留 `claude.exe`」，
 * 而 CLI 是个会起子进程的工具（Bash、MCP server），所以这一条是验收线上的东西。
 *
 * **改后的阶梯**（Windows）：
 * 1. stdin `control_request/interrupt`，宽限期内等终态 `result`（优雅，让 CLI 收尾在途工具）
 * 2. 还活着 → `taskkill /PID <pid> /T`（**不带 `/F`**；此时根还活着，`/T` 有效）
 * 3. 还活着 → `taskkill /PID <pid> /T /F`
 *
 * POSIX 上仍是 `SIGTERM` → `SIGKILL`，那套在那边是对的。
 *
 * ## 两条防打错人的纪律
 *
 * - **发 `/F` 之前必须确认 `child.exitCode === null`。** Windows 回收 PID 很积极，
 *   而这一级和上一级之间隔着一段宽限期 —— 对着一个已经死掉的 PID 发 `/F`，
 *   打的可能是别人刚起的进程。
 * - **绝不拿 `process.pid` 走这条路径。** `taskkill /T` 会把整棵树带走 ——
 *   包括调用者自己。测试里尤其致命：表现是「测试框架莫名崩了」。
 */

const execFileAsync = promisify(execFile)

const IS_WINDOWS = process.platform === 'win32'

/** 阶梯各级的默认宽限期。测试用 `timings` 注入缩短，否则一个用例要真等 8 秒以上。 */
export const DEFAULT_TIMINGS = {
  /** 第 1 级：写完 interrupt 请求后，等 CLI 自己体面收尾的时长。 */
  interruptGraceMs: 5_000,
  /** 第 2 级：`taskkill /T` 之后等它退出的时长。 */
  gracefulGraceMs: 3_000
}

export interface KillTimings {
  interruptGraceMs: number
  gracefulGraceMs: number
}

/** 这次杀树走到了哪一级 —— 如实记录，因为「为什么没优雅收尾」要靠它回答。 */
export type KillStage =
  | 'already-exited'
  /** 没走到任何一级：进程在中断请求之后自己退了。 */
  | 'interrupt'
  | 'taskkill-graceful'
  | 'taskkill-force'
  | 'sigterm'
  | 'sigkill'

export interface KillOutcome {
  turnId: string
  pid: number
  stage: KillStage
  /** 杀完之后是不是真没了。**`false` 是好消息里的坏消息**，调用方要如实上报。 */
  exited: boolean
  exitCode: number | null
}

export interface ChildRecord {
  turnId: string
  pid: number
  child: ChildProcess
}

export interface ChildRegistry extends CancelTable {
  /** 登记一个刚 spawn 出来的子进程，返回它的 turnId↔pid 句柄。 */
  register(turnId: string, child: ChildProcess): ChildRecord
  handleOf(turnId: string): { turnId: string; pid: number } | null
  listLive(): Array<{ turnId: string; pid: number }>
  /** 子进程已退出时调用（或提前调用以撤销登记）。幂等。 */
  release(turnId: string): void
  /**
   * 按阶梯终止一个轮次的进程树。
   *
   * `sendInterrupt` 由适配器提供 —— 只有它知道 `control_request` 的载荷形状。
   * 返回 `false` 表示这轮已经不在登记表里（已经结束或从未开始）。
   *
   * ⚠️ **不要拿 `process.pid` 调这个函数。**
   */
  killTree(turnId: string, opts?: { timings?: KillTimings; sendInterrupt?: (c: ChildProcess) => boolean }): Promise<KillOutcome | null>
}

/** 等子进程退出；到点返回 `false`。用 `exit` 而不是 `close` —— 我们要的是进程没了，不是管道关了。 */
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    const finish = (v: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(v)
    }
    const onExit = (): void => finish(true)
    // **刻意不 `unref()`**：这个等待是被 await 的，让定时器拖住事件循环才是对的。
    // unref 之后一旦子进程恰好已经没了、又没有别的 handle，Node 会在 await 还没回来时
    // 就把进程退出掉 —— 杀树走到一半被打断正是最难查的那类问题。
    const timer = setTimeout(() => finish(false), ms)
    child.once('exit', onExit)
    // 竞态：注册监听器之前就已经退了。
    if (child.exitCode !== null || child.signalCode !== null) finish(true)
  })
}

/** `taskkill` —— 只在 Windows 上有意义。`shell:false`，PID 走 argv。 */
async function taskkill(pid: number, force: boolean): Promise<void> {
  const args = ['/PID', String(pid), '/T']
  if (force) args.push('/F')
  try {
    await execFileAsync('taskkill', args, { windowsHide: true, timeout: 10_000 })
  } catch {
    // 「找不到进程」/「已经退出」都会走到这里 —— 那正是我们想要的结果，不是错误。
  }
}

export function createChildRegistry(): ChildRegistry {
  const children = new Map<string, ChildProcess>()
  const controllers = new Map<string, AbortController>()

  function pidOf(turnId: string): number | null {
    const c = children.get(turnId)
    return c && typeof c.pid === 'number' ? c.pid : null
  }

  function forget(turnId: string): void {
    children.delete(turnId)
    controllers.delete(turnId)
  }

  return {
    register(turnId: string, child: ChildProcess): ChildRecord {
      children.set(turnId, child)
      // 子进程自己退出时自动撤销登记 —— 否则登记表会随着运行时间慢慢变脏。
      child.once('exit', () => {
        children.delete(turnId)
      })
      const pid = typeof child.pid === 'number' ? child.pid : -1
      return { turnId, pid, child }
    },

    handleOf(turnId: string): { turnId: string; pid: number } | null {
      const pid = pidOf(turnId)
      return pid === null ? null : { turnId, pid }
    },

    listLive(): Array<{ turnId: string; pid: number }> {
      const out: Array<{ turnId: string; pid: number }> = []
      for (const [turnId, child] of children) {
        if (typeof child.pid === 'number') out.push({ turnId, pid: child.pid })
      }
      return out
    },

    release(turnId: string): void {
      forget(turnId)
    },

    // ── CancelTable：取消意图的唯一存放处 ──────────────────

    registerCancel(turnId: string, controller: AbortController): void {
      controllers.set(turnId, controller)
    },

    forgetCancel(turnId: string): void {
      controllers.delete(turnId)
    },

    signalOf(turnId: string): AbortSignal | null {
      return controllers.get(turnId)?.signal ?? null
    },

    abort(turnId: string): boolean {
      const c = controllers.get(turnId)
      if (!c || c.signal.aborted) return false
      c.abort()
      return true
    },

    liveTurnIds(): string[] {
      return Array.from(controllers.keys())
    },

    async killTree(
      turnId: string,
      opts: { timings?: KillTimings; sendInterrupt?: (c: ChildProcess) => boolean } = {}
    ): Promise<KillOutcome | null> {
      const child = children.get(turnId)
      if (!child) return null
      const pid = typeof child.pid === 'number' ? child.pid : -1
      const timings = opts.timings ?? DEFAULT_TIMINGS

      const finish = (stage: KillStage): KillOutcome => ({
        turnId,
        pid,
        stage,
        exited: child.exitCode !== null || child.signalCode !== null,
        exitCode: child.exitCode
      })

      if (child.exitCode !== null || child.signalCode !== null) return finish('already-exited')
      if (pid < 0) return finish('already-exited')

      // ── 第 1 级：优雅。只有适配器知道 control_request 的载荷形状。 ──
      opts.sendInterrupt?.(child)
      if (await waitForExit(child, timings.interruptGraceMs)) return finish('interrupt')

      if (IS_WINDOWS) {
        // ── 第 2 级：`/T` 不带 `/F`。**根还活着，所以 `/T` 还能走完整棵树。** ──
        await taskkill(pid, false)
        if (await waitForExit(child, timings.gracefulGraceMs)) return finish('taskkill-graceful')

        // ── 第 3 级：`/F`。先确认它真的还在 —— PID 会被回收，见文件头。 ──
        if (child.exitCode === null && child.signalCode === null) {
          await taskkill(pid, true)
          await waitForExit(child, timings.gracefulGraceMs)
        }
        return finish('taskkill-force')
      }

      // POSIX：SIGTERM → SIGKILL 这套在那边是正确的。
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已经没了 */
      }
      if (await waitForExit(child, timings.gracefulGraceMs)) return finish('sigterm')

      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已经没了 */
        }
        await waitForExit(child, timings.gracefulGraceMs)
      }
      return finish('sigkill')
    }
  }
}

/** 独立的取消表（只有 AbortController，没有子进程）。与 `createChildRegistry()` 分开，便于只测取消语义。 */
export function createCancelTable(): CancelTable {
  const controllers = new Map<string, AbortController>()
  return {
    registerCancel(turnId: string, controller: AbortController): void {
      controllers.set(turnId, controller)
    },
    forgetCancel(turnId: string): void {
      controllers.delete(turnId)
    },
    signalOf(turnId: string): AbortSignal | null {
      return controllers.get(turnId)?.signal ?? null
    },
    abort(turnId: string): boolean {
      const c = controllers.get(turnId)
      if (!c || c.signal.aborted) return false
      c.abort()
      return true
    },
    liveTurnIds(): string[] {
      return Array.from(controllers.keys())
    }
  }
}
