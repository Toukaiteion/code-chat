/**
 * ★ 启动断言：**TS 里的枚举与 DDL 的 `CHECK` 必须逐字一致**（§8.5a 欠的那一条）。
 *
 * ## 为什么需要它
 *
 * §8.5a 把 `EVENT_KINDS`（TS）与 `message_event.kind` 的 DDL `CHECK`（SQL）
 * 称作「同一条轴的两种写法」。这句话只有在它们真的相同时才成立 ——
 * 而在此之前**没有任何自动检查**：一个只在 TS 里加、没同步迁移的 kind
 * 会一路活到第一次落库才炸，而那时的表现是「用户的这一轮突然失败」，
 * 报错来自 SQLite 的约束层，离「你忘了改迁移」隔着一整个调用栈。
 *
 * 形态照 `§4.3b` 的 `Registry.seal()`：**开发期错误在启动时炸**，
 * 而不是等用户点下去才发现。
 *
 * ## 为什么是「读 `sqlite_master`」而不是「读迁移源码」
 *
 * 迁移文件是**过程**，库里的表是**结果**。M2 之后必然会有 0002、0003……
 * 而 `ALTER TABLE`、重建表、以及「某次迁移把手写 SQL 改了但没改 TS」这些
 * 都会让「读源码」这种检查变得可被绕过。`sqlite_master.sql` 是 SQLite
 * 自己记下来的**实际生效的那份 DDL**，它没有第二种可能。
 *
 * ## 只读
 *
 * 本模块只 `SELECT`，一个字节都不写。它在 `openStore()` 里、迁移之后立刻跑 ——
 * 也就是说它验证的是**这一次真的要用的那个库**，包括用户从旧版本升上来的那个。
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  AGENT_KINDS,
  EFFORT_LEVELS,
  EVENT_KINDS,
  MEMBER_ROLES,
  PROJECT_ORIGINS,
  TURN_STATUSES
} from '../../shared/entities.ts'

interface EnumPair {
  /** `表.列`，只用于报错信息 —— 它必须是用户/开发者一眼能找到位置的那种写法。 */
  where: string
  table: string
  column: string
  /** TS 侧的那一份。**顺序也要一致** —— 见文件末尾「为什么顺序也算」。 */
  values: readonly string[]
}

/**
 * 全部「TS 枚举 ↔ DDL CHECK」对。
 *
 * 为什么不止 `EVENT_KINDS` 一个：§8.5a 只点名了它（因为 `event-batcher` 正要
 * 往那张表里第一次写东西），但**这一整类错误与表无关**。同一个正则能验的六条，
 * 只验一条是把剩下的五条继续留在「靠人记得」的状态里。
 */
const PAIRS: readonly EnumPair[] = [
  { where: 'message_event.kind', table: 'message_event', column: 'kind', values: EVENT_KINDS },
  { where: 'turn.status', table: 'turn', column: 'status', values: TURN_STATUSES },
  { where: 'actor.agent_kind', table: 'actor', column: 'agent_kind', values: AGENT_KINDS },
  { where: 'actor.effort', table: 'actor', column: 'effort', values: EFFORT_LEVELS },
  { where: 'message.role', table: 'message', column: 'role', values: MEMBER_ROLES },
  { where: 'project.origin', table: 'project', column: 'origin', values: PROJECT_ORIGINS }
]

/** 从一份 DDL 里抠出 `CHECK (<column> IN ('a','b', …))` 的那串值。**顺序保持原样。** */
export function ddlCheckedValues(ddl: string, column: string): string[] | null {
  // `[^)]*` 足够：这些 CHECK 里没有嵌套括号。`kind` 那条跨了行，所以不能用 `.`。
  const m = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(ddl)
  if (!m?.[1]) return null
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1] as string)
}

/**
 * 比对全部对；不一致就抛。
 *
 * 抛而不是 `console.warn`：不一致意味着「应用层同意写、DB 拒绝」，
 * 而那是一个**必然发生**的运行时错误 —— 它只是早晚的问题。
 * 一个启动就炸的库比一个跑三天才炸的库好得多，因为那时用户手里有数据。
 */
export function assertDdlEnumsMatch(db: DatabaseSync): void {
  const problems: string[] = []

  for (const pair of PAIRS) {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(pair.table) as { sql: string | null } | undefined

    if (!row?.sql) {
      problems.push(`${pair.where}：表 ${pair.table} 不存在（迁移没跑到？）`)
      continue
    }

    const actual = ddlCheckedValues(row.sql, pair.column)
    if (actual === null) {
      // CHECK 不见了比 CHECK 写错了更严重：约束蒸发是不可逆的静默降级。
      problems.push(`${pair.where}：DDL 里找不到 CHECK (${pair.column} IN (...))`)
      continue
    }

    /**
     * 比较**逐位**，不是集合比较 —— 顺序也算不一致。
     *
     * 严格说顺序不构成 bug（库里存的是文本，SQLite 不看顺序），但对齐顺序的代价是零，
     * 而它买到的是两个列表**逐字可比**：以后每次改动，「差在哪」一眼就能看出来。
     * 一旦允许它们以不同顺序存放，审阅者就必须在脑子里做集合比较，
     * 而漏看一项的表现**正是本模块要防的那个 bug**。
     */
    const expected = [...pair.values]
    if (actual.length === expected.length && actual.every((v, i) => v === expected[i])) {
      continue
    }

    // 报「谁多了谁少了」而不是只报「不相等」—— 那句话直接就是修法。
    const missing = expected.filter((v) => !actual.includes(v))
    const extra = actual.filter((v) => !expected.includes(v))
    problems.push(
      `${pair.where}：TS 与 DDL 不一致` +
        `（TS 有 ${expected.length} 项、DDL 有 ${actual.length} 项` +
        (missing.length > 0 ? `；TS 里有而 DDL 拒收：${missing.join(', ')}` : '') +
        (extra.length > 0 ? `；DDL 收而 TS 不知道：${extra.join(', ')}` : '') +
        ')'
    )
  }

  if (problems.length > 0) {
    throw new Error(
      `数据库 schema 与应用层的枚举对不上，拒绝启动：\n  - ${problems.join('\n  - ')}\n` +
        `（修法在 src/main/persist/migrations/ —— TS 侧在 src/shared/entities.ts。§8.5a）`
    )
  }
}
