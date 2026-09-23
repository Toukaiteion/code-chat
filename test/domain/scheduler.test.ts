/**
 * M6a 验证之四：调度器（`src/main/domain/scheduler.ts`）。
 *
 * 它只有两条不变量 —— 全局并发上限、每 session 至多一个 running —— 但两条都是
 * 「错了**不会报错**」的那种：并发超了只是慢/乱，而同一 session 两个轮次同时跑
 * 会让**两条回答的帧交错**，渲染层把两段话拼成一条，谁也看不出发生过什么。
 *
 * ★ 整个文件都在验一件事：**「允许被派发」这件事只存在于内存队列里**（`pickNext`
 * 遍历的是 `queue`，不是库）。§4.5 的「不自动恢复」因此是**结构性**的 ——
 * 进程刚起来时内存队列是空的，库里那些上一进程留下的 `queued` 一条都派不出去。
 * 所以这里最后一段专门验「reap 之后不会再派发」，而不只是「reap 改了状态」。
 *
 * 台子上没有一处打桩：真的 `openStore(':memory:')`、真的 `turn-repo`。
 * 被替换的只有 `run()` —— 那是被验对象**之外**的东西（本文件不验怎么跑一轮）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../../src/main/persist/index.ts'
import type { Store } from '../../src/main/persist/index.ts'
import { createScheduler, DEFAULT_CONCURRENCY, type Scheduler } from '../../src/main/domain/scheduler.ts'
import type { Turn } from '../../src/shared/entities.ts'

const NOW = 1_700_000_000_000
const WS = 'w1'
const M1 = 'm1'
const M2 = 'm2'

interface Rig {
  store: Store
  scheduler: Scheduler
  /** 已开始跑的轮次 id，按开始顺序。 */
  started: string[]
  /** 结束第 n 个开跑的轮次（默认第一个）。 */
  finishRun(turnId: string): void
  /** 让某个轮次的 `run()` 抛异常。 */
  failRun(turnId: string): void
  crashed: Array<{ turnId: string; message: string }>
  warns: string[]
  /** 推送出去的每一次状态切换，按发生顺序。 */
  statuses: Array<{ turnId: string; status: string }>
  /** 建一条 `queued` 轮次并入队。 */
  send(sessionId: string, id: string): Turn
}

function rig(opts: { concurrency?: number } = {}): Rig {
  const store = openStore(':memory:')
  store.repos.workspace.create({ id: WS, name: 'Nova', now: NOW })
  for (const [memberId, sessionId] of [
    [M1, 's1'],
    [M2, 's2']
  ] as const) {
    // ⚠️ 每个成员一个**自己的** actor：`workspace_member` 上有
    // `UNIQUE(workspace_id, actor_id)` —— 同一个「人」在一个空间里只能出现一次。
    const actorId = `a-${memberId}`
    store.repos.actor.create({
      id: actorId,
      name: memberId,
      model: 'm',
      personaPath: 'p.md',
      personaHash: 'h',
      now: NOW
    })
    store.repos.member.create({ id: memberId, workspaceId: WS, actorId, displayName: memberId, now: NOW })
    store.repos.session.create(sessionId, WS, memberId, NOW)
  }

  const started: string[] = []
  const crashed: Array<{ turnId: string; message: string }> = []
  const warns: string[] = []
  /** 推送出去的每一次状态切换，按发生顺序。 */
  const statuses: Array<{ turnId: string; status: string }> = []
  /** 每一轮开跑时挂起的 resolve —— 由 `finishRun` 放行。 */
  const pendings = new Map<string, () => void>()
  const toThrow = new Set<string>()

  const scheduler = createScheduler({
    store: {
      turn: {
        get: (id) => store.repos.turn.get(id),
        listLive: () => store.repos.turn.listLive(),
        markRunning: (id, now) => store.repos.turn.markRunning(id, now),
        reapOrphans: (now) => store.repos.turn.reapOrphans(now)
      }
    },
    now: () => NOW,
    run: (turn) => {
      started.push(turn.id)
      if (toThrow.has(turn.id)) {
        return Promise.reject(new Error(`假适配器炸了：${turn.id}`))
      }
      return new Promise<void>((resolve) => pendings.set(turn.id, resolve))
    },
    onRunCrashed: (turnId, err) => {
      crashed.push({ turnId, message: err instanceof Error ? err.message : String(err) })
    },
    onWarn: (tag) => warns.push(tag),
    emitStatus: (s) => statuses.push({ turnId: s.turnId, status: s.status }),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {})
  })

  return {
    store,
    scheduler,
    started,
    crashed,
    warns,
    statuses,
    finishRun(turnId) {
      const r = pendings.get(turnId)
      if (!r) throw new Error(`轮次 ${turnId} 没在跑`)
      pendings.delete(turnId)
      r()
    },
    failRun(turnId) {
      toThrow.add(turnId)
    },
    send(sessionId, id) {
      const turn = store.repos.turn.create({ id, sessionId, workspaceId: WS, cwd: 'G:/ws', now: NOW })
      scheduler.enqueue(turn)
      return turn
    }
  }
}

/** 跑完所有当前的微任务 —— `dispatch` 里那句 `void run()` 的 `.finally` 要走完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

// ─────────────────────────────────────────────────────────────
// 一、并发上限与每 session 串行
// ─────────────────────────────────────────────────────────────

test('★ 全局并发上限：第 4 个轮次拿不到槽位，前一个结束后立刻补上', async () => {
  const r = rig({ concurrency: 3 })
  // ★ 四个轮次、四个**不同的** session —— 否则第 4 个挡住它的可能是「每 session 一个」
  // 那条规则，于是这条用例就再也验不到并发上限了（它会在错的原因上变绿）。
  for (const [memberId, sessionId] of [['m3', 's3'], ['m4', 's4']] as const) {
    r.store.repos.actor.create({ id: `a-${memberId}`, name: memberId, model: 'm', personaPath: 'p', personaHash: 'h', now: NOW })
    r.store.repos.member.create({ id: memberId, workspaceId: WS, actorId: `a-${memberId}`, displayName: memberId, now: NOW })
    r.store.repos.session.create(sessionId, WS, memberId, NOW)
  }
  for (const [s, id] of [['s1', 't1'], ['s2', 't2'], ['s3', 't3'], ['s4', 't4']] as const) r.send(s, id)

  assert.deepEqual(r.started, ['t1', 't2', 't3'], '★ 三个槽位，第 4 个必须等着')
  assert.equal(r.scheduler.state().slots.used, 3)
  assert.equal(r.scheduler.state().dispatchable, 1, 't4 还在内存队列里等')

  r.finishRun('t2')
  await settle()
  assert.deepEqual(r.started, ['t1', 't2', 't3', 't4'], '★ 槽位一空就立刻派下一个，不用轮询')
})

test('★ 每 session 至多一个 running：同一个 session 的两轮必须串行', async () => {
  const r = rig()
  r.send('s1', 't1')
  r.send('s1', 't2')
  assert.deepEqual(r.started, ['t1'], '第二个同 session 的轮次不许同时开跑')

  r.finishRun('t1')
  await settle()
  assert.deepEqual(r.started, ['t1', 't2'], '前一个结束了才轮到它')
})

test('★ 每 session FIFO：连发三轮，开始顺序就是发送顺序', async () => {
  const r = rig()
  for (const id of ['t1', 't2', 't3']) r.send('s1', id)
  assert.deepEqual(r.started, ['t1'])

  r.finishRun('t1')
  await settle()
  assert.deepEqual(r.started, ['t1', 't2'], '★ 不是 t3 —— 队列是有序的，不是集合语义')

  r.finishRun('t2')
  await settle()
  assert.deepEqual(r.started, ['t1', 't2', 't3'])
})

// ─────────────────────────────────────────────────────────────
// 一之二、`stream:status` 的两个切换点（M6b）
// ─────────────────────────────────────────────────────────────

test('★ 状态推送的顺序：`queued` 一定排在 `running` **之前**', () => {
  // `pump()` 是同步的，所以「先发 queued 再 pump」与「先 pump 再发 queued」
  // 只差一行，但后者会让界面先收到 `running`、再收到 `queued` ——
  // 那一行于是从「运行中」跳回「排队中」并永远停在那儿。
  const r = rig({ concurrency: 3 })
  r.send('s1', 't1')
  assert.deepEqual(r.statuses, [
    { turnId: 't1', status: 'queued' },
    { turnId: 't1', status: 'running' }
  ])
})

test('拿不到槽位的那一轮只发 `queued`（它确实还没开始跑）', async () => {
  const r = rig({ concurrency: 1 })
  r.send('s1', 't1')
  r.send('s2', 't2')
  assert.deepEqual(r.statuses, [
    { turnId: 't1', status: 'queued' },
    { turnId: 't1', status: 'running' },
    { turnId: 't2', status: 'queued' }
  ])
  assert.ok(
    !r.statuses.some((s) => s.turnId === 't2' && s.status === 'running'),
    '★ 库里那一行还是 queued，不许提前发 running'
  )

  r.finishRun('t1')
  await settle()
  assert.deepEqual(r.statuses[3], { turnId: 't2', status: 'running' })
})

test('★ 一个 session 的队首占着，**不挡**别的 session —— 队列是全局扫描，不是队头阻塞', async () => {
  const r = rig({ concurrency: 2 })
  r.send('s1', 't1')
  r.send('s1', 't2') // 被 s1 自己挡住
  r.send('s2', 't3') // 但它不该被 t2 挡住
  assert.deepEqual(r.started, ['t1', 't3'], '★ 队首 t2 派不出去时，必须继续往后找，而不是停在那里')
})

test('runnning 释放后 `slots.used` 回到 0，队列也空了', async () => {
  const r = rig()
  r.send('s1', 't1')
  assert.equal(r.scheduler.state().slots.used, 1)
  r.finishRun('t1')
  await settle()
  assert.equal(r.scheduler.state().slots.used, 0)
  assert.equal(r.scheduler.state().dispatchable, 0)
})

// ─────────────────────────────────────────────────────────────
// 二、`queued → running` 恰好一次
// ─────────────────────────────────────────────────────────────

test('★ 派发时真的把行翻成 `running`（不是只在内存里记一笔）', () => {
  const r = rig()
  r.send('s1', 't1')
  assert.equal(r.store.repos.turn.get('t1')?.status, 'running')
  assert.equal(r.store.repos.turn.get('t1')?.startedAt !== null, true)
})

test('★ 取消排队：行翻成 `cancelled` **且**从内存队列里摘掉（两条路都要堵）', async () => {
  const r = rig()
  r.send('s1', 't1')
  r.send('s1', 't2')
  // 用户取消了排队中的 t2。
  r.store.repos.turn.markCancelled('t2', NOW)
  r.scheduler.cancel('t2')

  r.finishRun('t1')
  await settle()
  assert.deepEqual(r.started, ['t1'], '★ 被取消的那条不许再被派发')
  assert.equal(r.store.repos.turn.get('t2')?.status, 'cancelled')
})

test('★ 只调 `cancel()` 不改库（反过来也一样）也不许派发 —— 两条路各堵一半是够的', async () => {
  // 这里只摘内存队列，**不**动库 —— 于是 `pickNext` 会读到一条仍然 `queued` 的行。
  // 它必须因为「不在内存队列里」而派不出去（见文件头：允许被派发这件事只由内存队列说了算）。
  const r = rig()
  r.send('s1', 't1')
  r.send('s1', 't2')
  r.scheduler.cancel('t2')
  r.finishRun('t1')
  await settle()
  assert.deepEqual(r.started, ['t1'])
})

test('★ 库里已经不是 `queued` 的条目会被顺手摘掉，不再堵在队首', async () => {
  const r = rig({ concurrency: 1 })
  r.send('s1', 't1')
  r.send('s1', 't2')
  // 模拟「行被改成了别的状态，但内存队列没被通知」—— 只可能是并发写入者。
  r.store.db.prepare(`UPDATE turn SET status = 'cancelled' WHERE id = 't2'`).run()
  r.finishRun('t1')
  await settle()
  assert.deepEqual(r.started, ['t1'])
  assert.equal(r.scheduler.state().dispatchable, 0, '★ 摘掉了，不是留在队列里每次都撞一遍')
})

test('入队一个不是 `queued` 的轮次 → 忽略 + 一条诊断（不静默）', async () => {
  const r = rig()
  const turn = r.store.repos.turn.create({ id: 't1', sessionId: 's1', workspaceId: WS, cwd: 'G:/ws', now: NOW })
  r.store.repos.turn.markRunning('t1', NOW)
  r.scheduler.enqueue({ ...turn, status: 'running' })
  assert.deepEqual(r.started, [])
  assert.ok(r.warns.includes('enqueue-not-queued'))
})

test('行在两次读之间被删了 → 从内存队列里摘掉，不停摆、也不报「写失败」', async () => {
  // 这里「删了」的形态是 `get()` 直接返回 null。它与下面那条**不是**同一件事：
  // 这里不是「写失败」，是「这东西没了，没什么可派的」—— 一条诊断都不该有。
  const r = rig({ concurrency: 1 })
  r.send('s1', 't1')
  r.send('s2', 't2')
  r.store.db.prepare(`DELETE FROM turn WHERE id = 't2'`).run()
  r.finishRun('t1')
  await settle()
  assert.deepEqual(r.started, ['t1'])
  assert.deepEqual(r.warns, [], '没有东西可派不是异常，不该刷警告')
  assert.equal(r.scheduler.state().dispatchable, 0, '摘掉了')
})

test('★ 读得到、却写不动（两次读之间被并发写入者改了）→ 如实报 + 继续派下一个', async () => {
  // 这是 `markRunning` 唯一会返回 null 的形态，而它**必须**被报出来：
  // 静默跳过的表现是「用户发了消息，界面显示排队中，然后它就永远停在那里」。
  const store = openStore(':memory:')
  store.repos.workspace.create({ id: WS, name: 'Nova', now: NOW })
  store.repos.actor.create({ id: 'a1', name: 'A', model: 'm', personaPath: 'p', personaHash: 'h', now: NOW })
  store.repos.member.create({ id: M1, workspaceId: WS, actorId: 'a1', displayName: 'm', now: NOW })
  store.repos.session.create('s1', WS, M1, NOW)

  const warns: string[] = []
  const statuses: string[] = []
  const t1 = store.repos.turn.create({ id: 't1', sessionId: 's1', workspaceId: WS, cwd: 'G:/ws', now: NOW })
  const s = createScheduler({
    store: {
      turn: {
        get: (id) => store.repos.turn.get(id),
        listLive: () => store.repos.turn.listLive(),
        // 读的时候还是 `queued`，写的时候已经翻不动了 —— 依赖注入让这个窗口可以被构造出来。
        markRunning: () => null,
        reapOrphans: (now) => store.repos.turn.reapOrphans(now)
      }
    },
    now: () => NOW,
    run: () => Promise.resolve(),
    onRunCrashed: () => {},
    onWarn: (tag) => warns.push(tag),
    emitStatus: (st) => statuses.push(st.status)
  })
  s.enqueue(t1)
  await settle()
  assert.deepEqual(warns, ['dispatch-mark-running-failed'])
  assert.equal(s.state().slots.used, 0, '没派出去就不占槽位 —— 否则槽位会随这种失败一路漏掉')
  // ★ 发的是**事实**：库里的那一行根本没被翻成 `running`，所以那一帧一帧都不该发。
  // 发了的话界面会显示一个从来没开始过的轮次正在运行，而它永远不会结束。
  assert.deepEqual(statuses, ['queued'], '派发失败只该有那一条 queued，不该有 running')
})

// ─────────────────────────────────────────────────────────────
// 三、`run()` 抛异常：兜底必须接住，否则轮次永远 running、槽位永远不还
// ─────────────────────────────────────────────────────────────

test('★ `run()` 抛了 → `onRunCrashed` 接手，且**槽位照样还回来**', async () => {
  const r = rig({ concurrency: 1 })
  r.failRun('t1')
  r.send('s1', 't1')
  r.send('s2', 't2')
  await settle()
  assert.deepEqual(r.crashed, [{ turnId: 't1', message: '假适配器炸了：t1' }])
  assert.deepEqual(r.started, ['t1', 't2'], '★ 槽位没还的话 t2 永远开不了 —— 整个应用会静默停摆')
})

test('兜底处理本身又抛时不再往外冒，只留一条诊断', async () => {
  const store = openStore(':memory:')
  store.repos.workspace.create({ id: WS, name: 'Nova', now: NOW })
  store.repos.actor.create({ id: 'a1', name: 'A', model: 'm', personaPath: 'p', personaHash: 'h', now: NOW })
  store.repos.member.create({ id: M1, workspaceId: WS, actorId: 'a1', displayName: 'm', now: NOW })
  store.repos.session.create('s1', WS, M1, NOW)
  const warns: string[] = []
  const s = createScheduler({
    store: {
      turn: {
        get: (id) => store.repos.turn.get(id),
        listLive: () => store.repos.turn.listLive(),
        markRunning: (id, now) => store.repos.turn.markRunning(id, now),
        reapOrphans: (now) => store.repos.turn.reapOrphans(now)
      }
    },
    now: () => NOW,
    run: () => Promise.reject(new Error('原异常')),
    onRunCrashed: () => {
      throw new Error('兜底也炸了')
    },
    onWarn: (tag) => warns.push(tag),
    emitStatus: () => {}
  })
  s.enqueue(store.repos.turn.create({ id: 't1', sessionId: 's1', workspaceId: WS, cwd: 'G:/ws', now: NOW }))
  await settle()
  assert.ok(warns.includes('on-run-crashed-threw'), '一个 unhandled rejection 会把进程带走')
  // 槽位仍然要还 —— 否则一次兜底失败 = 永久少一个槽。
  assert.equal(s.state().slots.used, 0)
})

// ─────────────────────────────────────────────────────────────
// 四、启动清扫：★「不自动恢复」是结构性的
// ─────────────────────────────────────────────────────────────

test('★ 启动清扫：上一进程的 `running` 与 `queued` 都翻成 `failed`，且分开报数', () => {
  const r = rig()
  // 造出「上一进程留下的」两行 —— 直接写库，不走调度器（它们从来不属于本进程）。
  const a = r.store.repos.turn.create({ id: 'old-running', sessionId: 's1', workspaceId: WS, cwd: 'G:/ws', now: NOW })
  r.store.repos.turn.create({ id: 'old-queued', sessionId: 's2', workspaceId: WS, cwd: 'G:/ws', now: NOW })
  r.store.repos.turn.markRunning(a.id, NOW)

  const sweep = r.scheduler.sweepStartup()
  assert.deepEqual(sweep, { reapedRunning: 1, reapedQueued: 1 }, '★ 两类分开报 —— 合成一个「2」什么也没说清')
  assert.equal(r.store.repos.turn.get('old-running')?.status, 'failed')
  assert.equal(r.store.repos.turn.get('old-queued')?.status, 'failed')
})

test('★ 清扫之后**一条都不会被派发** —— 「不自动恢复」不靠标志位，靠内存队列是空的', async () => {
  const r = rig()
  r.store.repos.turn.create({
    id: 'old-queued',
    sessionId: 's1',
    workspaceId: WS,
    cwd: 'G:/ws',
    now: NOW
  })
  r.scheduler.sweepStartup()
  await settle()
  assert.deepEqual(r.started, [], '★ 重启不该在用户没看着的时候动他的代码')

  // 对照：清扫**之后**新发的一轮照常跑起来 —— 证明"没派发"是队列空，不是调度器坏了。
  r.send('s1', '新的一轮')
  assert.deepEqual(r.started, ['新的一轮'])
})

test('清扫前先数后扫（清扫是不分青红皂白的 UPDATE，扫完就分不出谁原来是什么）', () => {
  const r = rig()
  const t = r.store.repos.turn.create({ id: 'old', sessionId: 's1', workspaceId: WS, cwd: 'G:/ws', now: NOW })
  r.store.repos.turn.finish(t.id, 'done', { terminalReason: 'complete' }, NOW, 0, null)
  assert.deepEqual(r.scheduler.sweepStartup(), { reapedRunning: 0, reapedQueued: 0 }, '已终结的轮次不参与清扫')
  assert.equal(r.store.repos.turn.get('old')?.status, 'done', '★ 不许把上一进程**正常完成**的轮次翻成 failed')
})

// ─────────────────────────────────────────────────────────────
// 五、诚实的状态与 `idle()`
// ─────────────────────────────────────────────────────────────

test('★ `queueDepth` 与 `dispatchable` 是两个数，差值 = 本进程看不见的那些', () => {
  const r = rig({ concurrency: 1 })
  r.send('s1', 't1')
  r.send('s1', 't2')
  // 上一进程留下的、这一进程永远不会碰的一条。
  r.store.repos.turn.create({ id: 'old-queued', sessionId: 's2', workspaceId: WS, cwd: 'G:/ws', now: NOW })

  const st = r.scheduler.state()
  assert.equal(st.queueDepth, 2, '★ queueDepth 是**库里**的诚实值（含永远派不出去的那些）')
  assert.equal(st.dispatchable, 1, 'dispatchable 是内存队列的长度')
  assert.equal(st.slots.total, 1)
  assert.equal(st.liveTurns.length, 3)
})

test('`idle()` 在有轮次时等待，全跑完才 resolve', async () => {
  const r = rig()
  r.send('s1', 't1')
  let done = false
  const p = r.scheduler.idle().then(() => {
    done = true
  })
  await settle()
  assert.equal(done, false, '还有一轮在跑，不许提前 resolve')

  r.finishRun('t1')
  await p
  assert.equal(done, true)
})

test('空转时 `idle()` 立即 resolve（不能挂住退出路径）', async () => {
  const r = rig()
  await r.scheduler.idle()
  assert.equal(r.scheduler.state().slots.used, 0)
})

test('默认并发是 3（§2.3）', () => {
  assert.equal(DEFAULT_CONCURRENCY, 3)
  const r = rig()
  assert.equal(r.scheduler.state().slots.total, 3)
})
