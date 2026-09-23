/**
 * M6b 验证之三：空间级累计用量（`turn-repo.usageOfWorkspace`）。
 *
 * 这个查询的全部风险都在**一个**地方：`SUM` **跳过 NULL**。
 *
 * `cost_usd` / `tokens_in` / `tokens_out` 都是可空列 —— 一轮失败、被中断、
 * 或者进程被杀时它们**就是 NULL**（M6a 走查里「库里的 token：in=null out=null」
 * 那一行正是这类）。于是：
 *
 * - 只报 `SUM` 的话，界面会显示一个**偏低**的合计数，而用户无从知道它偏低。
 *   这正是 §4.6a 规则二（上报 0 不许覆盖实测量）的**反向**形态：
 *   **空缺不许冒充成 0。**
 * - 但同时，零行上的 `SUM` 返回的又是 NULL —— 那是「没有数据」而不是「没有花费」，
 *   直接透出去会让一个刚建的空间显示成「未知」。
 *
 * 两件事方向相反，只有把「合计」与「有几轮没报」**一起**返回才能都说清。
 * 所以这个文件验的不是「加法对不对」，而是**那几个 0 各自是什么含义**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../../src/main/persist/index.ts'
import type { Store } from '../../src/main/persist/index.ts'

const NOW = 1_700_000_000_000
const WS = 'w1'
const OTHER = 'w2'

/**
 * 一个最小可用的空间：成员 + 会话。轮次必须挂在会话上（外键），
 * 而会话必须挂在成员上 —— 所以三行都得有，不能只建 workspace。
 */
function rig(): { store: Store; session: string } {
  const store = openStore(':memory:')
  for (const ws of [WS, OTHER]) store.repos.workspace.create({ id: ws, name: ws, now: NOW })
  store.repos.actor.create({
    id: 'a1',
    name: 'Atlas',
    model: 'm',
    personaPath: 'p.md',
    personaHash: 'h',
    now: NOW
  })
  store.repos.member.create({
    id: 'm1',
    workspaceId: WS,
    actorId: 'a1',
    displayName: '架构师',
    now: NOW
  })
  store.repos.session.create('s1', WS, 'm1', NOW)
  return { store, session: 's1' }
}

/**
 * 造一轮并给它一个终态。
 *
 * `usage` 省略 = **不报用量**，也就是库里那三列留在 NULL —— 这正是要验的那一类。
 */
function turn(
  store: Store,
  session: string,
  id: string,
  workspaceId: string,
  usage?: { costUsd?: number | null; tokensIn?: number | null; tokensOut?: number | null }
): void {
  store.repos.turn.create({ id, sessionId: session, workspaceId, cwd: 'G:/ws', now: NOW })
  store.repos.turn.finish(id, 'done', usage ?? {}, NOW, 0, null)
}

// ─────────────────────────────────────────────────────────────
// 一、空空间
// ─────────────────────────────────────────────────────────────

test('★ 空空间回四个 0，**不是四个 null**（`SUM` 在零行上返回 NULL）', () => {
  // 「还没跑过轮次」与「跑了但花了 0 元」在展示上是同一件事：都是 0。
  // 透出 null 的话，界面得为它编一个显示法，而那个显示法没有任何含义。
  const { store } = rig()
  assert.deepEqual(store.repos.turn.usageOfWorkspace(WS), {
    turnCount: 0,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    turnsWithoutUsage: 0
  })
})

test('空间不存在也回四个 0 —— 「没有这个空间」由 handler 那层的 404 回答', () => {
  // 这一层不判断存在性（repository 不做领域校验），所以这里刻意记下它的行为：
  // 它回的是 0，而**不许**有人据此在界面上显示「这个空间花了 0 元」。
  const { store } = rig()
  assert.deepEqual(store.repos.turn.usageOfWorkspace('nope').turnCount, 0)
})

// ─────────────────────────────────────────────────────────────
// 二、★★ 本文件的重点：NULL 不能被当成 0
// ─────────────────────────────────────────────────────────────

test('★★ 没报用量的轮次被计进 `turnsWithoutUsage`，**不是被当成 0**', () => {
  // 这是整个文件存在的理由。三行：报了 $1、没报、没报。
  // 只报 `SUM` 的实现会显示「累计 $1」—— 一个**偏低**的数字，
  // 而用户在界面上完全看不出还有两轮的钱没被算进去。
  const { store, session } = rig()
  turn(store, session, 't1', WS, { costUsd: 1, tokensIn: 100, tokensOut: 10 })
  turn(store, session, 't2', WS)
  turn(store, session, 't3', WS)

  const u = store.repos.turn.usageOfWorkspace(WS)
  assert.equal(u.turnCount, 3)
  assert.equal(u.costUsd, 1, 'SUM 跳过 NULL —— 合计只是**已知部分**的合计')
  assert.equal(u.turnsWithoutUsage, 2, '★ 少了这一栏，上面那个 1 就是在说谎')
  assert.notEqual(u.turnsWithoutUsage, 0)
})

test('★ 一轮都没报时：合计是 0，而 `turnsWithoutUsage` 等于总轮数', () => {
  // 这里的 0 是**正确**的读法（已知的合计确实是 0），前提是另一栏把
  // 「这个 0 不代表没花钱」说清楚。两者缺一，这个 0 就成了谎。
  const { store, session } = rig()
  turn(store, session, 't1', WS)
  turn(store, session, 't2', WS)

  const u = store.repos.turn.usageOfWorkspace(WS)
  assert.equal(u.costUsd, 0)
  assert.equal(u.turnCount, 2)
  assert.equal(u.turnsWithoutUsage, 2, '★ 2 === turnCount，界面上此时绝不能只说「累计 0」')
})

test('一轮报、一轮中断（`tokens_in` 有值而 `cost_usd` 为 NULL）→ 分开数、分开算', () => {
  // 这是真实会出现的形状：某条路径能拿到 token 数却算不出钱。
  // 三个 SUM 各自独立地跳过 NULL，所以 `costUsd` 与 `tokensIn` 的**覆盖率可以不同**
  // —— 而 `turnsWithoutUsage` 按 `cost_usd` 数，是**最保守**的那一个。
  const { store, session } = rig()
  turn(store, session, 't1', WS, { costUsd: 2, tokensIn: 200, tokensOut: 20 })
  turn(store, session, 't2', WS, { tokensIn: 50, tokensOut: 5 })

  const u = store.repos.turn.usageOfWorkspace(WS)
  assert.equal(u.costUsd, 2)
  assert.equal(u.tokensIn, 250, 'token 那一栏覆盖了两轮')
  assert.equal(u.turnsWithoutUsage, 1, '而钱那一栏只覆盖了一轮')
})

test('真的报了 0 与压根没报是**两件事**（前者不计入 `turnsWithoutUsage`）', () => {
  // 「这一轮确实一分钱没花」和「这一轮的钱我们不知道」必须分得开。
  // 把前者也算进 `turnsWithoutUsage` 的话，界面会平白多出一句
  // 「另有 1 轮无用量数据」—— 一条谁也无法解释的告警。
  const { store, session } = rig()
  turn(store, session, 't1', WS, { costUsd: 0, tokensIn: 0, tokensOut: 0 })
  const u = store.repos.turn.usageOfWorkspace(WS)
  assert.equal(u.costUsd, 0)
  assert.equal(u.turnCount, 1)
  assert.equal(u.turnsWithoutUsage, 0, '报了 0 就是报过了')
})

// ─────────────────────────────────────────────────────────────
// 三、聚合而不是截断
// ─────────────────────────────────────────────────────────────

test('★ 累计不受 `limit` 影响 —— 这正是它必须是聚合查询的理由', () => {
  // `turn:list` 带 limit。拿一个有上限的列表去求和，结果**看起来完全正常**，
  // 只在历史变长之后悄悄变小 —— §4.6a 规则二最典型的那种「安静地少显示」。
  const { store, session } = rig()
  for (let i = 0; i < 12; i += 1) {
    turn(store, session, `t${i}`, WS, { costUsd: 1, tokensIn: 10, tokensOut: 1 })
  }
  const u = store.repos.turn.usageOfWorkspace(WS)
  assert.equal(u.turnCount, 12, '★ 不是 12 就被截断过')
  assert.equal(u.costUsd, 12)
  // 对照：带 limit 的那条通道确实只给 3 条 —— 说明这个对照不是空话。
  assert.equal(store.repos.turn.listRecentByWorkspace(WS, 3).length, 3)
})

test('★ 跨空间不串味', () => {
  const { store, session } = rig()
  store.repos.actor.create({
    id: 'a2',
    name: 'B',
    model: 'm',
    personaPath: 'p.md',
    personaHash: 'h',
    now: NOW
  })
  store.repos.member.create({ id: 'm2', workspaceId: OTHER, actorId: 'a2', displayName: 'B', now: NOW })
  store.repos.session.create('s2', OTHER, 'm2', NOW)

  turn(store, session, 't1', WS, { costUsd: 1, tokensIn: 100, tokensOut: 10 })
  turn(store, 's2', 't2', OTHER, { costUsd: 9, tokensIn: 900, tokensOut: 90 })

  assert.deepEqual(store.repos.turn.usageOfWorkspace(WS), {
    turnCount: 1,
    costUsd: 1,
    tokensIn: 100,
    tokensOut: 10,
    turnsWithoutUsage: 0
  })
  assert.equal(store.repos.turn.usageOfWorkspace(OTHER).costUsd, 9)
})

test('小数成本不被取整（REAL 列，累加保持精度）', () => {
  // `cost_usd` 是 REAL。用 `Math.round` 之类顺手取整的话，
  // 一天跑几百轮下来，累计值会与实际相差可观 —— 而那是**账**。
  const { store, session } = rig()
  turn(store, session, 't1', WS, { costUsd: 0.0012, tokensIn: 1, tokensOut: 1 })
  turn(store, session, 't2', WS, { costUsd: 0.0038, tokensIn: 1, tokensOut: 1 })
  assert.equal(store.repos.turn.usageOfWorkspace(WS).costUsd, 0.005)
})
