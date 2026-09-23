/**
 * M7b 验证之二：`src/main/process/fanout.ts` —— `@` 派发的**执行**。
 *
 * 判决在 `domain/mention-service.ts`（那个文件有自己的用例），这里验的是**落地**：
 * 谁的消息被搬进了谁的会话、轮次什么时候建、取消的三步按什么顺序走、
 * 以及「一条判决」到底有没有变成**用户看得见的东西**。
 *
 * 这几件事都符合「错了不报错」的形状，各自的失败长相是：
 *
 * 1. **派发时机** —— 在事务里派发的话，调度器立刻回库里读那一行时读不到，
 *    表现是「偶尔有一条轮次永远不跑」。所以下面用一条事件序列把
 *    `tx:begin → tx:end → dispatch` 钉死，而不是靠读代码。
 * 2. **转述** —— 搬错人（搬进派发方自己的会话）的样子是「B 什么都没收到，
 *    但界面上一切正常」。所以断言的是**B 的会话里有一条 role:'user' 的行**。
 * 3. **终止** —— 终止的含义是「本轮不建新轮次 + 取消还在排队的跳」，**不是杀进程**。
 *    写成 `kill` 的样子是「一个正在正常干活的轮次被掐断，而它的产物是合法的」。
 *    所以有一条用例专门盯着「`running` 的那一跳**没有被动过**」。
 * 4. **失败要可见** —— 被 @ 的人已停用 / 名字不存在 / 去重命中，这三件事都必须
 *    留下一条 notice 或一条 warn 日志。静默丢弃一个用户明确点名的人，就是界面在说谎。
 *
 * 台子是真的：真库（`openStore(':memory:')`）、真 repository、真事务。
 * 被替换的只有**边界之外**的两件事：`dispatch` 与 `cancelQueued`（它们是调度器的入口，
 * 不是本模块的被验对象），以及 `cwdFor`（三级兜底的产物，另有自己的用例）。
 *
 * 轮次结束的那一刻由 `turn-runner` 触发，它把 `TurnFinishedInfo` **算好之后**传进来
 * （`replyTextOf` 只有一个所有者）。下面的 `infoOf()` 复刻的就是它那几行 ——
 * 真实接线由 `test/ipc/turn.test.ts` 走假 CLI 端到端覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../../src/main/persist/index.ts'
import type { Store } from '../../src/main/persist/index.ts'
import { createFanout, type Fanout } from '../../src/main/process/fanout.ts'
import {
  parseMentionsBlock,
  relayTextOf,
  replyTextOf,
  WORK_EVENT_KINDS,
  type TurnFinishedInfo
} from '../../src/main/domain/mention-service.ts'
import type { PushOf } from '../../src/shared/ipc/contract.ts'
import type { Mention, Turn } from '../../src/shared/entities.ts'

const NOW = 1_700_000_000_000
const WS = 'w1'

const ATLAS = { memberId: 'm-atlas', sessionId: 's-atlas', name: 'Atlas' }
const NYX = { memberId: 'm-nyx', sessionId: 's-nyx', name: 'Nyx' }
const ECHO = { memberId: 'm-echo', sessionId: 's-echo', name: 'Echo' }

interface Rig {
  store: Store
  fanout: Fanout
  /** `dispatch` 收到的轮次（顺序 = 派发顺序）。 */
  dispatched: Turn[]
  /** `cancelQueued` 收到的 id（顺序 = 取消顺序）。 */
  cancelQueuedCalls: string[]
  statuses: Array<{ turnId: string; status: string; reason: string | null }>
  notices: Array<PushOf<'app:notice'>>
  /** 日志里出现过的 tag（warn 那条路）。 */
  warnTags: string[]
  /** ★ 一件事发生的顺序：`tx:begin` / `tx:end` / `dispatch:<id>`。 */
  timeline: string[]
  /** 建一轮、跑完它、写一条 assistant 回复（可选带工作事件）。返回**终态**的轮次。 */
  runTurn(input: {
    sessionId: string
    hopDepth: number
    reply?: string
    worked?: boolean
    at?: number
  }): Turn
  /** 把一条**已经存在**的轮次（例如刚被扇出建出来的那条）跑到终态。 */
  completeTurn(input: { turnId: string; sessionId: string; reply?: string; worked?: boolean; at?: number }): Turn
  /** 建一条**还在排队**的轮次（带一条触发消息）。 */
  queueTurn(input: {
    sessionId: string
    hopDepth: number
    triggerAuthorMemberId: string
    triggerText: string
    at?: number
  }): Turn
  /** 复刻 `turn-runner.turnFinishedInfoOf`（见文件头最后一段）。 */
  infoOf(turnId: string): TurnFinishedInfo
  /** 某个会话里的全部轮次（按发起顺序）。 */
  turnsIn(sessionId: string): Turn[]
  /** 某个会话里 `role:'system'` 的行。 */
  systemLinesIn(sessionId: string): string[]
}

function rig(opts: { disabledMembers?: readonly string[] } = {}): Rig {
  const store = openStore(':memory:')
  store.repos.workspace.create({ id: WS, name: 'Nova', now: NOW })
  for (const who of [ATLAS, NYX, ECHO]) {
    const actorId = `a-${who.memberId}`
    store.repos.actor.create({
      id: actorId,
      name: who.name,
      model: 'deepseek-flash',
      personaPath: `${who.name}.md`,
      personaHash: 'h',
      now: NOW
    })
    const member = store.repos.member.create({
      id: who.memberId,
      workspaceId: WS,
      actorId,
      displayName: who.name,
      now: NOW
    })
    store.repos.session.create(who.sessionId, WS, member.id, NOW)
  }
  for (const memberId of opts.disabledMembers ?? []) {
    store.repos.member.setEnabled(memberId, false, NOW)
  }

  const dispatched: Turn[] = []
  const cancelQueuedCalls: string[] = []
  const statuses: Rig['statuses'] = []
  const notices: Array<PushOf<'app:notice'>> = []
  const warnTags: string[] = []
  const timeline: string[] = []
  let n = 0

  const fanout = createFanout({
    store: {
      // ★ 包一层只为了拿到「事务什么时候开始、什么时候结束」——
      //   下面那条 timeline 断言靠它，而不是靠读代码。
      tx: (fn) => {
        timeline.push('tx:begin')
        try {
          return store.tx(fn)
        } finally {
          timeline.push('tx:end')
        }
      },
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
    cwdFor: (workspaceId, memberId) => ({ cwd: `${workspaceId}/for/${memberId}` }),
    dispatch: (turn) => {
      timeline.push(`dispatch:${turn.id}`)
      dispatched.push(turn)
    },
    cancelQueued: (turnId) => {
      cancelQueuedCalls.push(turnId)
    },
    emitStatus: (payload) => {
      statuses.push({
        turnId: payload.turnId,
        status: payload.status,
        reason: payload.reason ?? null
      })
    },
    emitNotice: (notice) => notices.push(notice),
    now: () => NOW,
    newId: () => `x-${++n}`,
    onWarn: (tag) => warnTags.push(tag)
  })

  function nextNow(at?: number): number {
    return at ?? NOW + ++n * 10
  }

  /** 把一条**已经存在**的轮次跑到终态，并写一条 assistant 回复（可带工作事件）。 */
  function completeTurn(input: Parameters<Rig['completeTurn']>[0]): Turn {
    const now = nextNow(input.at)
    store.repos.turn.markRunning(input.turnId, now + 1)
    store.repos.turn.setPid(input.turnId, 1000 + ++n)
    store.repos.turn.finish(input.turnId, 'done', {}, now + 2, 0)
    const msg = store.repos.message.append({
      id: `msg-${input.turnId}`,
      workspaceId: WS,
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: 'assistant',
      contentText: input.reply ?? '',
      now: now + 2
    })
    if (input.worked) {
      store.repos.message.appendEvent({
        messageId: msg.id,
        kind: 'tool_start',
        toolName: 'Read',
        now: now + 2
      })
    }
    return store.repos.turn.get(input.turnId) as Turn
  }

  function runTurn(input: Parameters<Rig['runTurn']>[0]): Turn {
    const now = nextNow(input.at)
    const id = `t-${++n}`
    store.repos.turn.create({
      id,
      sessionId: input.sessionId,
      workspaceId: WS,
      hopDepth: input.hopDepth,
      cwd: 'C:/ws',
      now
    })
    return completeTurn({ ...input, turnId: id, at: now + 1 })
  }

  function queueTurn(input: Parameters<Rig['queueTurn']>[0]): Turn {
    const now = nextNow(input.at)
    const message = store.repos.message.append({
      id: `msg-q${++n}`,
      workspaceId: WS,
      sessionId: input.sessionId,
      role: 'user',
      authorMemberId: input.triggerAuthorMemberId,
      contentText: input.triggerText,
      now
    })
    return store.repos.turn.create({
      id: `q-${n}`,
      sessionId: input.sessionId,
      workspaceId: WS,
      triggerMessageId: message.id,
      hopDepth: input.hopDepth,
      cwd: 'C:/ws',
      now: now + 1
    })
  }

  function infoOf(turnId: string): TurnFinishedInfo {
    const produced = store.repos.message.listByTurn(turnId)
    const replyText = replyTextOf(produced)
    const hadWork = produced.some((m) =>
      WORK_EVENT_KINDS.some((kind) => store.repos.message.listEventsByKind(m.id, kind).length > 0)
    )
    return { mentions: parseMentionsBlock(replyText), replyText, hadWork }
  }

  return {
    store,
    fanout,
    dispatched,
    cancelQueuedCalls,
    statuses,
    notices,
    warnTags,
    timeline,
    runTurn,
    completeTurn,
    queueTurn,
    infoOf,
    turnsIn: (sessionId) => store.repos.turn.listBySession(sessionId),
    systemLinesIn: (sessionId) =>
      store.repos.message
        .listRecentBySession(sessionId, 50)
        .filter((m) => m.role === 'system')
        .map((m) => m.contentText ?? '')
  }
}

/** 把「一轮结束」这件事喂给扇出（真实接线里由 `turn-runner` 触发）。 */
function finish(r: Rig, turn: Turn): void {
  r.fanout.onTurnFinished(turn, r.infoOf(turn.id))
}

function kindsIn(sessionId: string, r: Rig): Mention[] {
  return r.store.repos.message
    .listRecentBySession(sessionId, 50)
    .flatMap((m) => m.mentions ?? [])
}

// ─────────────────────────────────────────────────────────────
// 一、A 的回复里 @ B —— 核心那条
// ─────────────────────────────────────────────────────────────

test('★ A 的回复里 @ B → B 的会话收到一条转述消息，且 B 多了一个 1 跳的轮次', () => {
  const r = rig()
  const a0 = r.runTurn({
    sessionId: ATLAS.sessionId,
    hopDepth: 0,
    reply: '我把 api-server/src/a.ts 的 x 改成了 2。\n\n<mentions>Nyx</mentions>'
  })
  finish(r, a0)

  const bTurns = r.turnsIn(NYX.sessionId)
  assert.equal(bTurns.length, 1, '★ B 那边要真的多出一轮 —— 这就是「A 的回复能派出 B 的一轮」')
  assert.equal(bTurns[0]?.hopDepth, 1, '跳数沿链全局递增（§3.3），不按会话重来')
  assert.equal(bTurns[0]?.status, 'queued')
  assert.equal(bTurns[0]?.cwd, `w1/for/${NYX.memberId}`, '★ cwd 按**被派发方**的三级兜底算，不是照抄派发方')

  const relay = r.store.repos.message.get(bTurns[0]?.triggerMessageId ?? '')
  assert.ok(relay)
  assert.equal(relay.role, 'user', '转述落在对方的会话里，是一条对方视角的输入')
  assert.equal(relay.sessionId, NYX.sessionId, '★ 搬错会话的样子是「B 什么都没收到，界面一切正常」')
  assert.equal(relay.authorMemberId, ATLAS.memberId, '署名是派发方 —— 下游要知道这话是谁说的')
  assert.ok(relay.contentText?.includes('x 改成了 2'), '搬的是**原话**，不是摘要')
  assert.ok(
    !relay.contentText?.includes('<mentions>Nyx</mentions>'),
    '★ 派发行本身（`<mentions>Nyx</mentions>`）不许搬过去：那是**我们与派发方之间**的机器指令，' +
      '转发它等于把「谁该被派发」这个已经做过的决定再交给下游模型猜一次'
  )
  assert.ok(
    relay.contentText?.includes('已由本应用取出'),
    '★ 但删掉这件事要说出来 —— 下游少了一行而不知道为什么，就会自己补一个解释'
  )
  assert.deepEqual(relay.mentions, [{ memberId: NYX.memberId, kind: 'to' }], '结构化的那一半也一起落库')
  assert.deepEqual(
    r.dispatched.map((t) => t.id),
    [bTurns[0]?.id],
    '★ 派发只经过 `dispatch`（§4.5a 规则一），而且正好一次'
  )
})

test('★ 派发在**事务提交之后** —— 否则调度器立刻回库里读那一行会读不到', () => {
  const r = rig()
  const a0 = r.runTurn({
    sessionId: ATLAS.sessionId,
    hopDepth: 0,
    reply: '改完了。\n\n<mentions>Nyx</mentions>'
  })
  finish(r, a0)

  const created = r.turnsIn(NYX.sessionId)[0]
  assert.deepEqual(
    r.timeline,
    ['tx:begin', 'tx:end', `dispatch:${created?.id}`],
    '顺序是硬的：先提交（调度器读得到那一行），再派'
  )
})

test('回复里**没有** `<mentions>` 块 → 什么都不派（这是设计里的正常结局，不是错误）', () => {
  const r = rig()
  const a0 = r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: '改完了，还有别的事吗？' })
  finish(r, a0)

  assert.deepEqual(r.turnsIn(NYX.sessionId), [])
  assert.deepEqual(r.dispatched, [])
  assert.deepEqual(r.notices, [], '绝大多数轮次都是这样结束的 —— 不能每次都弹一条通知')
  assert.deepEqual(r.warnTags, [], '不派发是常态，不该在日志里留痕')
})

test('★ 标签写坏了（`<mentions>` 不闭合）→ 不派发，但**留一条日志**（与「没写」分开）', () => {
  const r = rig()
  const a0 = r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: '改完了。\n\n<mentions>Nyx' })
  finish(r, a0)

  assert.deepEqual(r.dispatched, [])
  assert.ok(
    r.warnTags.includes('fanout:mentions-malformed'),
    '模型把协议写坏了 —— 这件事意味着提示词里的措辞需要改，不报出来就永远看不见'
  )
})

// ─────────────────────────────────────────────────────────────
// 二、`cc`：只写一条历史行，不建轮次（§5.4）
// ─────────────────────────────────────────────────────────────

test('★ `@` 了自己手选的 `cc` 目标 → 对方会话里有一条消息、**零个轮次**', () => {
  const r = rig()
  // 「用户以 Atlas 的身份 @ 了 Nyx，但标成抄送」—— 用户那条路进来的就是结构化的 mention。
  r.fanout.dispatchUserMentions({
    workspaceId: WS,
    authorMemberId: ATLAS.memberId,
    text: '我把 a.ts 的 x 改成了 2，顺手说一声。',
    mentions: [{ memberId: NYX.memberId, kind: 'cc' }]
  })

  assert.deepEqual(r.turnsIn(NYX.sessionId), [], '★ `cc` 的语义就是**不派活** —— 建了轮次就是界面在说谎')
  assert.deepEqual(r.dispatched, [])

  const lines = r.store.repos.message.listRecentBySession(NYX.sessionId, 10)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]?.contentText?.includes('不需要行动'), '★ 不写这四个字，被抄送者会以为自己在被派活')
})

// ─────────────────────────────────────────────────────────────
// 三、失败必须可见（静默丢弃一个被点名的人 = 界面在说谎）
// ─────────────────────────────────────────────────────────────

test('★ 被 @ 的成员**已停用** → 不派发，但弹一条 warning 通知（不静默）', () => {
  const r = rig({ disabledMembers: [ECHO.memberId] })
  const a0 = r.runTurn({
    sessionId: ATLAS.sessionId,
    hopDepth: 0,
    reply: '改完了。\n\n<mentions>Echo</mentions>'
  })
  finish(r, a0)

  assert.deepEqual(r.dispatched, [])
  assert.equal(r.notices.length, 1)
  assert.equal(r.notices[0]?.level, 'warning')
  assert.ok(r.notices[0]?.message.includes('Echo'), '通知里要点名是谁 —— 「有一个成员没派出去」没法排查')
  assert.ok(r.warnTags.includes('fanout:mention-disabled'))
})

test('回复里 @ 了一个**不存在**的名字 → 不派发 + 一条 warn（不许「差不多就派给那个」）', () => {
  const r = rig()
  const a0 = r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: '改完了。\n\n<mentions>Nova</mentions>' })
  finish(r, a0)

  assert.deepEqual(r.dispatched, [])
  assert.ok(r.warnTags.includes('fanout:mention-unknown-name'))
})

test('★ 一条坏 @ 不作废其余：@ 了两个、其中一个已停用 → 另一个照派', () => {
  const r = rig({ disabledMembers: [ECHO.memberId] })
  const a0 = r.runTurn({
    sessionId: ATLAS.sessionId,
    hopDepth: 0,
    reply: '改完了。\n\n<mentions>Echo,Nyx</mentions>'
  })
  finish(r, a0)

  assert.deepEqual(
    r.dispatched.map((t) => t.sessionId),
    [NYX.sessionId],
    'agent 已经做完的那一轮不因一个坏的 @ 而作废'
  )
  assert.equal(r.notices.length, 1, '但也不是没发生')
})

// ─────────────────────────────────────────────────────────────
// 四、乒乓熔断的落地（判决本身在 mention-service 的用例里）
// ─────────────────────────────────────────────────────────────

/** 造一条「连续 N 跳都没有实质动作」的链，最后一跳的回复里 @ 了下一个人。 */
function emptyChain(r: Rig, hops: number): Turn {
  let turn: Turn | null = null
  for (let i = 0; i < hops; i++) {
    turn = r.runTurn({
      sessionId: i % 2 === 0 ? ATLAS.sessionId : NYX.sessionId,
      hopDepth: i,
      reply: i === hops - 1 ? `说完了。\n\n<mentions>${i % 2 === 0 ? 'Nyx' : 'Atlas'}</mentions>` : '嗯，我再看看。'
    })
  }
  return turn as Turn
}

test('★ 2 跳空转 → 一条 warning 通知 + 库里一条 system 角色的事件，但**照常派发**', () => {
  const r = rig()
  const tail = emptyChain(r, 2)
  finish(r, tail)

  assert.equal(r.notices.length, 1)
  assert.equal(r.notices[0]?.level, 'warning')
  // ★ 落进**链尾那一跳的会话**（乒乓是链的局部现象，写进空间流别的成员也会看到）。
  const lines = r.systemLinesIn(tail.sessionId)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]?.includes('【系统】'), '它要读起来像系统说的话，而不是某个人说的')
  assert.ok(!/\d/.test(lines[0] ?? ''), '★ 跳数绝不进提示词 —— 这句会进上下文，一个数字都不能有')

  // 「2 次只是警告」：警告之后这一轮该派的还是要派。
  assert.equal(r.dispatched.length, 1, '★ 2 跳只警告 —— 从这里就掐掉的话，正常协作会被误杀')
})

test('★ 4 跳空转 → 强制终止：本轮**不建新轮次**，且在排队的同链条跳被取消', () => {
  const r = rig()
  // 链：0（Atlas 的会话）、1（Nyx）、2（Atlas）、3（Nyx，回复里又 @ 了 Atlas）。
  // 另外，第 3 跳**早就派出去了**一跳 4（还在排队）—— 终止时要把它一起取消。
  // 认领的条件是「触发消息的作者 = 链上某一跳那一轮的成员」：第 3 跳是 Nyx 跑的，
  // 所以它派出去的那一条躺在 **Atlas 的会话**里、署 Nyx 的名。
  const pre = r.queueTurn({
    sessionId: ATLAS.sessionId,
    hopDepth: 4,
    triggerAuthorMemberId: NYX.memberId,
    triggerText: '【派发】Nyx 在它上一轮的回复里 @ 了你，把这件事交给你。'
  })
  // 一条**正在跑**的轮次：形状上完全够格被认领（同深度、署名也对），
  // 但「终止 ≠ 杀进程」，它必须原封不动。
  const running = r.queueTurn({
    sessionId: ECHO.sessionId,
    hopDepth: 4,
    triggerAuthorMemberId: NYX.memberId,
    triggerText: '同深度的另一条，只是它已经在跑了'
  })
  r.store.repos.turn.markRunning(running.id, NOW + 5)
  r.store.repos.turn.setPid(running.id, 7777)

  const tail = emptyChain(r, 4)
  const before = r.dispatched.length
  finish(r, tail)

  // ① 本轮不建新轮次 —— 即使它的回复里明明白白写着 @ Atlas。
  assert.equal(r.dispatched.length, before, '★ 终止的含义就是**不调用 `dispatch`**')

  // ② 排队的那一跳：库 + 内存队列 + 推送，三步都走了。
  assert.equal(r.store.repos.turn.get(pre.id)?.status, 'cancelled', '库里的行必须翻成 cancelled')
  assert.deepEqual(r.cancelQueuedCalls, [pre.id], '内存队列也要摘掉 —— 只改库的话 `pickNext` 还会把它捡起来')
  assert.deepEqual(
    r.statuses.map((s) => ({ turnId: s.turnId, status: s.status })),
    [{ turnId: pre.id, status: 'cancelled' }],
    '推送发的是「两件事都成立」之后的事实'
  )

  // ③ ★ 「强制终止」不是杀进程：正在跑的那一跳一个字都没被改。
  assert.equal(r.store.repos.turn.get(running.id)?.status, 'running', '★ 它的产物是合法的，只是它之后不该再有')
  assert.equal(r.store.repos.turn.get(running.id)?.pid, 7777, '更不该有任何人去动它的进程')

  // ④ 终止是**可见的**：一条落库的 system 事件 + 一条通知。
  const lines = r.systemLinesIn(tail.sessionId)
  assert.ok(lines.some((l) => l.includes('已被自动终止')), '库里要留下发生过什么')
  assert.ok(lines.every((l) => !/\d/.test(l)), '★ 这些行会进上下文，所以一个跳数数字都不能出现')
  assert.equal(r.notices.at(-1)?.level, 'warning')
  assert.ok(r.warnTags.includes('fanout:ping-pong-terminate'))
})

test('★ 中间任一跳有工具调用 → 计数清零，链**不被**终止', () => {
  const r = rig()
  // 0、1 空转，2 真干了活（有 tool_start），3 又空转 → 尾部连续空转只有 1 跳。
  r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: '嗯，我再看看。' })
  r.runTurn({ sessionId: NYX.sessionId, hopDepth: 1, reply: '嗯，我再看看。' })
  r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 2, reply: '我读了 a.ts。', worked: true })
  const tail = r.runTurn({
    sessionId: NYX.sessionId,
    hopDepth: 3,
    reply: '说完了。\n\n<mentions>Atlas</mentions>'
  })
  finish(r, tail)

  assert.equal(r.dispatched.length, 1, '★ 豁免规则是「宁可漏杀，不可错杀」：真的在推进的来回讨论不许被掐')
  assert.deepEqual(r.notices, [], '也不该弹警告 —— 那是 2 跳才该说的话')
})

test('连续 3 跳空转只警告一次（那句话在 2 跳时已经说完了）', () => {
  const r = rig()
  r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: '嗯。' })
  const two = r.runTurn({ sessionId: NYX.sessionId, hopDepth: 1, reply: '嗯。' })
  finish(r, two)
  assert.equal(r.notices.length, 1)

  const three = r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 2, reply: '嗯。\n\n<mentions>Nyx</mentions>' })
  finish(r, three)
  assert.equal(r.notices.length, 1, '第 3 跳不该再弹一遍同样的警告')
  assert.equal(r.dispatched.length, 1)
})

// ─────────────────────────────────────────────────────────────
// 五、去重（第 2 条）：基准是「尚未执行的尾部」
// ─────────────────────────────────────────────────────────────

test('★ 同一「人 + 内容」已经排在未执行的尾部 → 不重复派，且留一条 info', () => {
  const r = rig()
  const body = '我把 api-server/src/a.ts 的 x 改成了 2。'
  // 造一条**已经排着**的轮次，它的触发消息正文正是本轮要转述的那一段。
  // 正文用 `relayTextOf` 现算 —— 与 `fanout.relayHashOf` 是同一个函数，
  // 所以这条用例同时钉住了「两处的哈希对得上」这件事。
  r.queueTurn({
    sessionId: NYX.sessionId,
    hopDepth: 1,
    triggerAuthorMemberId: ATLAS.memberId,
    triggerText: relayTextOf({ authorName: 'Atlas', kind: 'to', body, via: 'reply', stripped: true })
  })

  const a0 = r.runTurn({
    sessionId: ATLAS.sessionId,
    hopDepth: 0,
    reply: `${body}\n\n<mentions>Nyx</mentions>`
  })
  finish(r, a0)

  assert.equal(r.turnsIn(NYX.sessionId).length, 1, '★ 尾部已经有同样的一轮在排队 —— 不再派第二轮')
  assert.deepEqual(r.dispatched, [])
  assert.ok(r.warnTags.includes('fanout:mention-deduped'), '没派这件事要留痕（info 级）')
})

test('★ 去重反向对照：那一轮**已经跑完了** → 这一次照派（基准是尾部，不是整条历史）', () => {
  const r = rig()
  const body = '我把 api-server/src/a.ts 的 x 改成了 2。'
  // 上一轮：内容一样、已经跑完。
  const earlier = r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: `${body}\n\n<mentions>Nyx</mentions>` })
  finish(r, earlier)
  assert.equal(r.dispatched.length, 1)
  const first = r.dispatched[0] as Turn
  // 让 Nyx 那一轮跑完（它没干活，也没派任何人）。
  const nyxDone = r.completeTurn({ turnId: first.id, sessionId: NYX.sessionId, reply: '我看到了。' })
  assert.equal(nyxDone.id, first.id, '前置假设：被派出去的那条已经跑完了')
  assert.equal(nyxDone.status, 'done')

  // 现在同样的内容再来一次。
  const again = r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: `${body}\n\n<mentions>Nyx</mentions>` })
  finish(r, again)

  assert.equal(r.dispatched.length, 2, '★ 用整条历史做基准会吃掉「A→B→A 的第二轮复盘」这种正当行为')
  assert.deepEqual(r.notices, [])
})

// ─────────────────────────────────────────────────────────────
// 六、用户那条路：`dispatchUserMentions`
// ─────────────────────────────────────────────────────────────

test('★ 用户直接 @ 出去的那一轮是 1 跳，且**不判链**（用户就是链的打断点）', () => {
  const r = rig()
  // 先造一条已经空转了 4 跳的链 —— 如果用户这条路也判链，它会被顺手终止。
  const tail = emptyChain(r, 4)
  finish(r, tail)
  const noticesBefore = r.notices.length

  r.fanout.dispatchUserMentions({
    workspaceId: WS,
    authorMemberId: ATLAS.memberId,
    text: '换个方向，看看 b.ts。',
    mentions: [{ memberId: NYX.memberId, kind: 'to' }]
  })

  const created = r.turnsIn(NYX.sessionId).find((t) => t.hopDepth === 1)
  assert.ok(created, '★ 用户主动发起本身就是链的打断点（`hopDepth = 0`），派给它 @ 的人 = 1 跳')
  assert.equal(created?.status, 'queued')
  assert.equal(r.notices.length, noticesBefore, '不该因为「上一段链空转过」而拒绝用户这一句')

  // 用户那条消息的正文也照搬进对方会话（`via: 'message'`）。
  const relay = r.store.repos.message.get(created?.triggerMessageId ?? '')
  assert.ok(relay?.contentText?.includes('换个方向'))
  assert.ok(relay?.contentText?.includes('在刚发的那条消息里'), '措辞与 agent 那条路不同 —— 下游要知道话是从哪来的')
  assert.deepEqual(
    kindsIn(NYX.sessionId, r).filter((m) => m.memberId === NYX.memberId && m.kind === 'to').length,
    1
  )
})

// ─────────────────────────────────────────────────────────────
// 七、判不出链的时候（往回看的窗口不够）要说话，而不是默默放行
// ─────────────────────────────────────────────────────────────

test('★ 结束的那一跳不在最近 32 条之内 → 按单独成链处理，并留一条 warn', () => {
  const r = rig()
  const old = r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: '早先的一轮。' })
  // 之后又跑来 33 条别的轮次 —— 往回看 32 条已经看不到 `old` 了。
  for (let i = 0; i < 33; i++) {
    r.runTurn({ sessionId: ECHO.sessionId, hopDepth: 0, reply: `第 ${i} 条` })
  }

  r.fanout.onTurnFinished(old, r.infoOf(old.id))
  assert.ok(
    r.warnTags.includes('fanout:chain-tail-missing'),
    '判不出链 ⇒ 不终止（宁可漏杀），但「我判不出来」这件事必须留痕'
  )
  assert.equal(r.notices.length, 0)
})

// ─────────────────────────────────────────────────────────────
// 八、链上更早的跳「干过活没有」是回库里查的，不是靠内存记的
// ─────────────────────────────────────────────────────────────

test('★ 更早的跳干过活 → 从库里读得出来（判链不依赖任何进程内状态）', () => {
  const r = rig()
  const first = r.runTurn({ sessionId: ATLAS.sessionId, hopDepth: 0, reply: '我改了 a.ts。', worked: true })
  r.runTurn({ sessionId: NYX.sessionId, hopDepth: 1, reply: '嗯，我看看。' })
  const tail = r.runTurn({
    sessionId: ATLAS.sessionId,
    hopDepth: 2,
    reply: '说完了。\n\n<mentions>Nyx</mentions>'
  })
  // ★ 注意：第 0、1 跳的 `hadWork` **没有**被传进来过（扇出只拿到刚结束那一跳的）——
  // 它只能回库里数它们的事件。这正是「报告可以从归档重判」的前提。
  assert.equal(r.infoOf(first.id).hadWork, true)
  finish(r, tail)

  // ★ 这一条断言是**有区分度的**：尾部两跳（1、2）都没干活，所以判决取决于第 0 跳。
  // 第 0 跳的 tool_start **从库里读到了** ⇒ 清零 ⇒ 尾部连续空转 = 2 ⇒ **warn**（弹一条）。
  // 要是扇出只看「传进来的那一条」，第 0 跳就会被当成空转 ⇒ 3 跳 ⇒ **什么都不做**（0 条）。
  // 所以 1 条通知正是「它真的回库里读了」的证据。
  assert.equal(r.notices.length, 1)
  assert.equal(r.notices[0]?.level, 'warning')
  assert.ok(r.warnTags.includes('fanout:ping-pong-warn'))
  assert.ok(!r.warnTags.includes('fanout:ping-pong-terminate'))
})
