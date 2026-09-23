import type { AgentKind } from '../../shared/entities.ts'
import { AGENT_KINDS } from '../../shared/entities.ts'
import type { AgentAdapter, AgentDiagnostic } from './agent-adapter.ts'
import type { ChildRegistry } from '../process/child-registry.ts'
import { createClaudeAdapter } from './claude/claude-adapter.ts'
import type { ClaudeAdapter, CliLaunch } from './claude/claude-adapter.ts'
import type { KillTimings } from '../process/child-registry.ts'

/**
 * `AgentKind` → 适配器实例。§4.1 把它画在 `adapters/` 的根上，是有道理的：
 * **上层不该知道有哪些 kind 存在，只该知道「拿到一个 kind，换回一个会跑轮次的东西」。**
 *
 * ## 两个刻意的设计
 *
 * **1. 没有实现的 kind 返回 `null`，不抛。**
 * `AGENT_KINDS` 里现在有两个值（`claude` / `codex`，DDL 的 CHECK 也是这两个），
 * 而 M5 只实现了 `claude`。这不是异常 —— 是阶段性的已知缺口，所以调用方拿 `null`
 * 去组织人话（「codex 还没接，现在只有 claude」）。照 `locateGit()` / `resolveClaude()`
 * 的形状：**预期中的处境用返回值表达，不用异常**。
 *
 * **2. `Record<AgentKind, …>` 是穷尽的，这是本文件最值钱的一行类型。**
 * 往 `AGENT_KINDS` 里加第三个 kind 时，`claude`/`codex` 那张表会**编译不过**，
 * 于是「新加了 kind 但忘了适配器」不可能变成一个运行时才发现的 `null`。
 * 用手写 `Array.includes` 之类的写法就丢掉这个保证。
 *
 * ## `diagnosticsOf` 为什么在这里转一手
 *
 * 诊断通道挂在**具体的** `ClaudeAdapter` 上（见那个类型的说明：它刻意不在锁定的
 * `AgentAdapter` 上）。但探针只认 kind，不认具体类 —— 所以由本模块把那条通道
 * 按 kind 转出来，探针不必知道 `ClaudeAdapter` 这个名字。
 */

export interface AdapterRegistryOptions {
  /** 活子进程登记处。**必填** —— 没有它就没有中断阶梯。 */
  registry: ChildRegistry
  /** 覆盖 CLI 的启动方式。测试与探针用来顶替那个 237MB 的真身。 */
  launch?: CliLaunch
  /** 阶梯宽限期注入（测试用）。 */
  timings?: KillTimings
}

export interface AdapterRegistry {
  /** 没有实现时返回 `null`，由调用方说人话。 */
  get(kind: AgentKind): AgentAdapter | null
  /** 真的有实现的 kind。调用方据此组织「现在支持哪些」。 */
  available(): readonly AgentKind[]
  /** 尚缺实现的 kind。与 `available()` 互补，两个都拿去拼那句人话。 */
  missing(): readonly AgentKind[]
  /** 该 kind 该轮次的诊断。没有实现、或该 kind 没有这条通道时返回空数组。 */
  diagnosticsOf(kind: AgentKind, turnId: string): readonly AgentDiagnostic[]
}

export function createAdapterRegistry(opts: AdapterRegistryOptions): AdapterRegistry {
  // 构造是廉价的：真正解析 CLI 路径、spawn 进程都发生在 `run()` 里，不在这里。
  const claude: ClaudeAdapter = createClaudeAdapter({
    registry: opts.registry,
    launch: opts.launch,
    timings: opts.timings
  })

  // ★ 穷尽表：加 kind 忘了适配器 → 编译错误，而不是运行时 null。
  const table: Record<AgentKind, AgentAdapter | null> = {
    claude,
    // codex 在 AGENT_KINDS 与 DDL 的 CHECK 里都存在，但**没有任何实现**。
    // 写在这里而不是删掉，正是为了让上面那句「穷尽」成立。
    codex: null
  }

  return {
    get(kind: AgentKind): AgentAdapter | null {
      return table[kind] ?? null
    },

    available(): readonly AgentKind[] {
      return AGENT_KINDS.filter((k) => table[k] !== null)
    },

    missing(): readonly AgentKind[] {
      return AGENT_KINDS.filter((k) => table[k] === null)
    },

    diagnosticsOf(kind: AgentKind, turnId: string): readonly AgentDiagnostic[] {
      // M5 只有 claude 有这条 M5 自己的观测通道；别的 kind 一律空数组而不是抛。
      return kind === 'claude' ? claude.diagnosticsOf(turnId) : []
    }
  }
}
