/**
 * M6a 验证之一：**合批器**（`src/main/process/event-batcher.ts`）。
 *
 * 这是本轮的主战场。它同时拥有四件事 —— 帧 seq、合并规则、一次刷新一个事务、
 * 在途回放环 —— 而其中**任何一件错了都不会当场报错**：表现是界面上的数字慢慢错位、
 * 重启后重放一段空白、或者库里多出一条谁也没写过的 text 事件。
 * 所以这里验的不是「函数算得对」，而是**这四条不变量各自都有反向对照**。
 *
 * ★ 台子上没有一处打桩：真的 `openStore(':memory:')`、真的 repository、
 * 真的 `batcherStoreOf`（与 `runtime.ts` 用的是**同一个**接线函数）。
 * 唯一被替换的是时钟 —— 而那是为了让「33ms 后刷新」这条路径可以被确定地驱动，
 * 不是为了绕开真实的落库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../../src/main/persist/index.ts'
import type { Store } from '../../src/main/persist/index.ts'
import {
  createEventBatcher,
  FRAME_PAYLOAD_LIMIT,
  type Clock,
  type EventBatcher,
  type StreamBatch,
  type UnreadPayload,
  type ViewLike
} from '../../src/main/process/event-batcher.ts'
import { batcherStoreOf } from '../../src/main/process/runtime.ts'
import { FRAME_PAYLOAD_LIMIT as REPO_LIMIT } from '../../src/main/persist/index.ts'
import type { MessageEvent } from '../../src/shared/entities.ts'

const NOW = 1_700_000_000_000
const WORKSPACE = 'w1'
const SESSION = 's1'
const ACTOR = 'a1'
const MEMBER = 'm1'

interface Warn {
  tag: string
  message: string
  detail?: unknown
}

interface Rig {
  store: Store
  batcher: EventBatcher
  view: ViewLike
  batches: StreamBatch[]
  unreads: UnreadPayload[]
  warns: Warn[]
  /** 推进假时钟并**跑掉**期间到期的定时器。 */
  tick(ms: number): void
  /** 还有几个没触发的定时器（验「空闲不留计时器」）。 */
  pending(): number
  /** 起一轮，返回 turnId。 */
  begin(over?: { cwd?: string; newMessageId?: () => string }): string
  /** 这一轮的那条 assistant 消息（惰性创建，可能还不存在）。 */
  assistantMessage(turnId: string): { id: string; contentText: string | null; seq: number } | null
  /** 某一轮的全部事件行，按 `message_event.seq` 升序。 */
  events(turnId: string): MessageEvent[]
}

function rig(opts: { flushMs?: number; unreadMs?: number; maxFramesPerFlush?: number; maxBufferBytes?: number; ringFrames?: number; epoch?: string; onTx?: () => void } = {}): Rig {
  const store = openStore(':memory:')
  store.repos.workspace.create({ id: WORKSPACE, name: 'Nova', now: NOW })
  store.repos.actor.create({
    id: ACTOR,
    name: 'Atlas',
    model: 'm',
    personaPath: 'p.md',
    personaHash: 'h',
    now: NOW
  })
  store.repos.member.create({
    id: MEMBER,
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    displayName: '架构师',
    now: NOW
  })
  store.repos.session.create(SESSION, WORKSPACE, MEMBER, NOW)

  const view: ViewLike = { workspaceId: WORKSPACE }
  const batches: StreamBatch[] = []
  const unreads: UnreadPayload[] = []
  const warns: Warn[] = []

  let now = NOW
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let handle = 0
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      handle += 1
      timers.set(handle, { fn, ms })
      return handle
    },
    clearTimeout: (h) => {
      timers.delete(h as number)
    }
  }

  /**
   * 数事务边界。★ 必须在**建合批器之前**把包装塞进去 —— `batcherStoreOf` 是
   * `{ tx: store.tx, … }` 取值绑定，之后再来改 `store.tx` 对它毫无影响。
   * （我第一版就是这么写的，于是「两个屏障 = 两个事务」那条断言数到的是 0。）
   */
  const baseStore = batcherStoreOf(store)
  const counted: typeof baseStore = opts.onTx
    ? {
        ...baseStore,
        tx: <T,>(fn: () => T): T => {
          opts.onTx?.()
          return baseStore.tx(fn)
        }
      }
    : baseStore

  const batcher = createEventBatcher({
    store: counted,
    clock,
    view,
    emitBatch: (b) => batches.push(b),
    emitUnread: (u) => unreads.push(u),
    onWarn: (tag, message, detail) => warns.push({ tag, message, detail }),
    epoch: opts.epoch ?? 'epoch-1',
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    ...(opts.unreadMs !== undefined ? { unreadMs: opts.unreadMs } : {}),
    ...(opts.maxFramesPerFlush !== undefined ? { maxFramesPerFlush: opts.maxFramesPerFlush } : {}),
    ...(opts.maxBufferBytes !== undefined ? { maxBufferBytes: opts.maxBufferBytes } : {}),
    ...(opts.ringFrames !== undefined ? { ringFrames: opts.ringFrames } : {})
  })

  let turnSeq = 0

  function assistantMessage(turnId: string): { id: string; contentText: string | null; seq: number } | null {
    const rows = store.db
      .prepare(`SELECT id, content_text, seq FROM message WHERE turn_id = ?`)
      .all(turnId) as Array<{ id: string; content_text: string | null; seq: number }>
    const row = rows[0]
    return row ? { id: row.id, contentText: row.content_text, seq: row.seq } : null
  }

  return {
    store,
    batcher,
    view,
    batches,
    unreads,
    warns,
    tick(ms) {
      now += ms
      for (const [h, t] of [...timers]) {
        // 只跑到期的。先进先出在这里不重要 —— 合批器只有一个刷新定时器 + 一个未读定时器。
        if (t.ms <= ms) {
          timers.delete(h)
          t.fn()
        }
      }
    },
    pending: () => timers.size,
    begin(over = {}) {
      turnSeq += 1
      const turnId = `t${turnSeq}`
      store.repos.turn.create({
        id: turnId,
        sessionId: SESSION,
        workspaceId: WORKSPACE,
        cwd: over.cwd ?? 'G:/ws',
        now
      })
      batcher.beginTurn({
        turnId,
        sessionId: SESSION,
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        authorMemberId: MEMBER,
        cwd: over.cwd ?? 'G:/ws',
        newMessageId: over.newMessageId ?? (() => `msg-${turnId}`)
      })
      return turnId
    },
    assistantMessage,
    events(turnId: string) {
      const msg = assistantMessage(turnId)
      return msg ? store.repos.message.listEvents(msg.id) : []
    }
  }
}

/** 全部帧，按到达顺序摊平。 */
function frames(r: Rig): StreamBatch['frames'] {
  return r.batches.flatMap((b) => b.frames)
}

function kinds(r: Rig): string[] {
  return frames(r).map((f) => f.k)
}

/** 收尾一轮，返回 done 帧。 */
function end(r: Rig, turnId: string, over: Partial<Parameters<EventBatcher['endTurn']>[1]> = {}) {
  r.batcher.endTurn(turnId, {
    reason: 'complete',
    status: 'done',
    errorText: null,
    exitCode: 0,
    ...over
  })
}

// ─────────────────────────────────────────────────────────────
// 一、两条 seq 不是一条
// ─────────────────────────────────────────────────────────────

test('★ 帧 seq 跨轮次单调：同一 session 连跑两轮，第二轮从上一轮的高位接着数', () => {
  const r = rig()
  const t1 = r.begin()
  r.batcher.push(t1, { k: 'text_delta', block: 0, text: '第一轮' })
  end(r, t1)

  const t2 = r.begin()
  r.batcher.push(t2, { k: 'text_delta', block: 0, text: '第二轮' })
  end(r, t2)

  const seqs = frames(r).map((f) => f.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '帧 seq 必须严格递增')
  assert.equal(new Set(seqs).size, seqs.length, '不能有重复的帧 seq')

  // 计数器挂在 **sessionId** 上，不随轮次销毁 —— 这正是第二条的前提。
  const t1Max = Math.max(...r.batches.flatMap((b) => (b.turnId === t1 ? b.frames.map((f) => f.seq) : [])))
  const t2Min = Math.min(...r.batches.flatMap((b) => (b.turnId === t2 ? b.frames.map((f) => f.seq) : [])))
  assert.ok(t2Min > t1Max, `第二轮的首帧 ${t2Min} 必须大于第一轮的末帧 ${t1Max}`)
})

test('★ 行 seq 每条消息从 1 重来 —— 它与帧 seq 说的是两个完全无关的位置', () => {
  const r = rig()
  const t1 = r.begin()
  r.batcher.push(t1, { k: 'text_delta', block: 0, text: 'a' })
  end(r, t1)
  const t2 = r.begin()
  r.batcher.push(t2, { k: 'text_delta', block: 0, text: 'b' })
  end(r, t2)

  assert.deepEqual(
    r.events(t1).map((e) => e.seq),
    [1, 2],
    '第一轮：一条 text 行 + 一条 done 行'
  )
  assert.deepEqual(
    r.events(t2).map((e) => e.seq),
    [1, 2],
    '第二轮**也从 1 重来**（UNIQUE(message_id, seq)）—— 这正是「帧 seq 推不出来」的原因'
  )
})

test('★ 两个「256KB」是同一个数 —— 分叉时这条先红', () => {
  assert.equal(FRAME_PAYLOAD_LIMIT, REPO_LIMIT)
})

test('★ toSeq 是会话计数器的高位，不是本批最后一帧的 seq', () => {
  const r = rig()
  const t1 = r.begin()
  r.batcher.push(t1, { k: 'text_delta', block: 0, text: 'x' })
  // 合并的帧保留**首个** seq，所以「最后一帧的 seq」会比计数器低 —— 差就在这里。
  r.batcher.push(t1, { k: 'text_delta', block: 0, text: 'y' })
  r.batcher.push(t1, { k: 'thinking_delta', block: 1, text: 'z' })
  end(r, t1)

  const batch = r.batches[r.batches.length - 1] as StreamBatch
  assert.equal(batch.frames[batch.frames.length - 1]?.k, 'done')
  assert.equal(
    batch.toSeq,
    batch.frames[batch.frames.length - 1]?.seq,
    '上下文：done 是屏障帧，它必然是最后一个，所以这一批里两者恰好相同'
  )

  // ★ 真正要证的是「toSeq 不依赖最后一帧长什么样」：拿一批**只有被合并的帧**来看。
  const r2 = rig()
  const t = r2.begin()
  r2.batcher.push(t, { k: 'text_delta', block: 0, text: 'x' })
  r2.batcher.push(t, { k: 'text_delta', block: 0, text: 'y' })
  r2.tick(33)
  const only = r2.batches[0] as StreamBatch
  assert.equal(only.frames.length, 1, '两个相邻 text 增量合成一帧')
  assert.equal(only.frames[0]?.seq, only.fromSeq, '合并保留**首个** seq')
  assert.equal(only.toSeq, only.fromSeq, '计数器只推进了第一次那一个号')
})

// ─────────────────────────────────────────────────────────────
// 二、合批（§4.3 合批规则逐条）
// ─────────────────────────────────────────────────────────────

test('定时刷新：33ms 到点才发，到点前一个字节都不发', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '你好' })

  assert.equal(r.batches.length, 0, '还没到点，不许发')
  assert.equal(r.pending(), 1, '有一个在等')
  r.tick(33)
  assert.equal(r.batches.length, 1)
  assert.deepEqual(kinds(r), ['text'])
  assert.equal(r.pending(), 0, '★ 冲完即停 —— 空闲不留计时器')
})

test('★ 相邻 text 拼接成一帧，且保留**首个** seq', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '我来' })
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '修这个' })
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '空指针。' })
  r.tick(33)

  const f = frames(r)[0]
  assert.equal(r.batches.length, 1, '一次刷新一个批次')
  assert.deepEqual(f, { seq: 1, k: 'text', d: '我来修这个空指针。' })
  assert.equal(r.batches[0]?.toSeq, 1, '三个增量只花掉一个帧号')
})

test('text 与 thinking 各自合并，**不跨类型**', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'A' })
  r.batcher.push(t, { k: 'thinking_delta', block: 1, text: 'B' })
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'C' })
  r.tick(33)

  assert.deepEqual(kinds(r), ['text', 'thinking', 'text'])
  assert.deepEqual(
    frames(r).map((f) => (f.k === 'text' || f.k === 'thinking' ? f.d : '')),
    ['A', 'B', 'C']
  )
})

test('★ 屏障先冲后发：tool_start 到达时，前面攒的正文在同一批里**排在它前面**', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '先说话' })
  // 还没到 33ms —— 缓冲里是脏的。
  r.batcher.push(t, { k: 'tool_start', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } })

  assert.equal(r.batches.length, 1, '屏障**立刻**冲，不等定时器')
  assert.deepEqual(kinds(r), ['text', 'tool_start'])
  const [text, tool] = r.batches[0]?.frames ?? []
  assert.ok(text && tool && text.k < tool.k, '同批内顺序必须保持：text 在 tool_start 之前')
  assert.ok((text.seq as number) < (tool.seq as number))
})

test('缓冲超过 maxFramesPerFlush 帧就立即冲（不等定时器）', () => {
  const r = rig({ maxFramesPerFlush: 3 })
  const t = r.begin()
  // 交替类型 → 帧不合并，攒够 3 帧。
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'a' })
  r.batcher.push(t, { k: 'thinking_delta', block: 1, text: 'b' })
  assert.equal(r.batches.length, 0, '两帧还不到上限')
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'c' })
  assert.equal(r.batches.length, 1, '第三帧到顶，立刻冲')
  assert.equal(r.batches[0]?.frames.length, 3)
})

test('缓冲超过 maxBufferBytes 字节就立即冲', () => {
  const r = rig({ maxBufferBytes: 16 })
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '一二三四五六七八' }) // 24 字节
  assert.equal(r.batches.length, 1, '超过 16 字节，立刻冲')
})

// ─────────────────────────────────────────────────────────────
// 三、落库：一次刷新一个事务、先落库后推送
// ─────────────────────────────────────────────────────────────

test('★ 一次刷新 = 一个事务：事件行 + 正文折叠 + 水位推进同生共死', () => {
  let tx = 0
  const r = rig({ onTx: () => (tx += 1) })
  const t = r.begin()

  // 攒两段正文再让它自己到点刷新 —— 这是**最平常**的一次刷新，也是最该被验的一次：
  // 事件行、`content_text` 折叠、`session.last_seq` 三件事必须一起进去、一起出来。
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '一句' })
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '话' })
  assert.equal(tx, 0, '前置：还没提交')

  r.tick(33)
  assert.equal(tx, 1, '★ 一次定时刷新 = **恰好一个**事务（不是「每条事件一个」）')

  const before = tx
  end(r, t)
  assert.equal(
    tx - before,
    1,
    '★ 收尾（done 帧 + 正文折叠 + 终态行）也只有一个事务 —— 它们必须同生共死'
  )

  const msg = r.assistantMessage(t)
  assert.ok(msg, '收尾后消息行必须存在')
  assert.equal(msg.contentText, '一句话', '正文折叠与最后一批 text 事件同源')
})

test('★ 先落库、后推送：推送发生的那一瞬间，行已经在库里了', () => {
  /**
   * 把这个断言塞进 `emitBatch` 回调里 —— 这是「先落库」**唯一**能被证明的形态。
   * 只断言「最后库里有一行」是证明不了的：先推送后落库也会在结束时有一行，
   * 而两者的区别正是这一条要验的东西。
   */
  const r = rig()
  const seen: Array<{ kind: string; rowsInDb: number }> = []

  const store = r.store
  const probe = createEventBatcher({
    store: batcherStoreOf(store),
    clock: { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} },
    view: r.view,
    emitBatch: (b) => {
      for (const f of b.frames) {
        const n = store.db
          .prepare(`SELECT COUNT(*) AS n FROM message_event WHERE kind = ?`)
          .get(f.k === 'done' ? 'done' : f.k) as { n: number }
        seen.push({ kind: f.k, rowsInDb: n.n })
      }
    },
    emitUnread: () => {},
    onWarn: () => {},
    epoch: 'e'
  })

  const turnId = 't-probe'
  store.repos.turn.create({ id: turnId, sessionId: SESSION, workspaceId: WORKSPACE, cwd: 'G:/ws', now: NOW })
  probe.beginTurn({
    turnId,
    sessionId: SESSION,
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    authorMemberId: MEMBER,
    cwd: 'G:/ws',
    newMessageId: () => 'msg-probe'
  })
  probe.push(turnId, { k: 'text_delta', block: 0, text: 'x' })
  probe.endTurn(turnId, { reason: 'complete', status: 'done', errorText: null, exitCode: 0 })

  const text = seen.find((s) => s.kind === 'text')
  assert.ok(text, 'text 帧必须被推送过')
  assert.ok(text.rowsInDb > 0, '★ 推送 text 帧时，那条 text 事件行必须**已经**在库里')

  const done = seen.find((s) => s.kind === 'done')
  assert.ok(done && done.rowsInDb > 0, '★ 同理：done 帧推送时终态行已经落库')
})

test('落库失败时一个字节都不发 —— 宁可整轮失去，也不做「界面有库里没有」', () => {
  const r = rig()
  const t = r.begin()
  const warns: Warn[] = []

  // 让每一次 `appendEvent` 都炸掉。只换这一个方法：`ensureMessage` 照常建行，
  // 于是失败发生在**事务内部**、在有东西可回滚的位置 —— 那才是真实形态。
  const base = batcherStoreOf(r.store)
  const failing = createEventBatcher({
    store: {
      ...base,
      message: {
        ...base.message,
        appendEvent: () => {
          throw new Error('磁盘满了')
        }
      }
    },
    clock: { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} },
    view: { workspaceId: WORKSPACE },
    emitBatch: () => {
      throw new Error('落库失败时不该有推送')
    },
    emitUnread: () => {},
    onWarn: (tag, message, detail) => warns.push({ tag, message, detail }),
    epoch: 'e'
  })
  failing.beginTurn({
    turnId: t,
    sessionId: SESSION,
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    authorMemberId: MEMBER,
    cwd: 'G:/ws',
    newMessageId: () => 'msg-fail'
  })

  // ★ 必须走到**提交点**才算验过。只推 `text_delta` 的话它躺在缓冲里等 33ms，
  // 这次调用连库都没碰过，返回一个 `ok: true` 完全正确 —— 那条断言会变成
  // 一个「因为什么都没发生所以通过」的绿灯。用屏障把事务逼出来。
  const res = failing.push(t, { k: 'tool_start', id: 'tu1', name: 'Read', input: {} })
  assert.equal(res.ok, false, '如实报告失败，不假装发过')
  assert.equal(res.emitted, 0)
  assert.equal(res.persisted, 0)
  assert.ok(
    warns.some((w) => w.tag === 'persist-failed'),
    '失败必须留下一条诊断 —— 否则「这一轮的帧全没了」在日志里一个字都不剩'
  )

  // 回滚是**真的**：库里不该留下半条消息行。
  assert.equal(r.assistantMessage(t), null, '事务回滚了，就一行都不该留下')
})

test('★ 正文与 text 事件同源：库里那条 text 行拼起来必须逐字等于 content_text', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '第一段。' })
  r.batcher.push(t, { k: 'thinking_delta', block: 1, text: '（想一下）' })
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '第二段。' })
  end(r, t)

  const msg = r.assistantMessage(t)
  const textRows = r.events(t).filter((e) => e.kind === 'text')
  const joined = textRows.map((e) => e.textBlob ?? '').join('')
  assert.equal(joined, '第一段。第二段。')
  assert.equal(msg?.contentText, joined, '两个去向必须逐字相同')
})

// ─────────────────────────────────────────────────────────────
// 四、只上线不落库的那些
// ─────────────────────────────────────────────────────────────

test('★ thinking_end 上线但不落库（线上 9 项 / 可持久化 8 项）', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'thinking_delta', block: 0, text: '推理' })
  r.batcher.push(t, { k: 'thinking_end', block: 0 })
  end(r, t)

  assert.deepEqual(kinds(r).slice(0, 2), ['thinking', 'thinking_end'])
  assert.deepEqual(
    r.events(t).map((e) => e.kind),
    ['thinking', 'done'],
    '★ `thinking_end` 在 message_event 里**没有**对应行'
  )
})

test('status_changed 在帧上没有对应物（§2.3 的差集表）', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'status_changed', status: 'requesting' })
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'x' })
  end(r, t)
  assert.deepEqual(kinds(r), ['text', 'done'])
})

// ─────────────────────────────────────────────────────────────
// 五、载荷上限
// ─────────────────────────────────────────────────────────────

test('★ 超过 256KB 的工具结果：帧上截断 + truncated，行里留全量', () => {
  const r = rig()
  const t = r.begin()
  const big = 'x'.repeat(FRAME_PAYLOAD_LIMIT + 1024)
  r.batcher.push(t, { k: 'tool_result', id: 'tu1', ok: true, output: big })
  end(r, t)

  const frame = frames(r).find((f) => f.k === 'tool_result')
  assert.ok(frame && frame.k === 'tool_result')
  assert.equal(frame.truncated, true)
  assert.ok(
    Buffer.byteLength(frame.output, 'utf8') <= FRAME_PAYLOAD_LIMIT,
    '帧上的那份必须在上限之内'
  )

  const row = r.events(t).find((e) => e.kind === 'tool_result')
  assert.ok(row)
  assert.equal(
    row.textBlob?.length,
    big.length,
    '★ 行里放**全量**：行回答「到底输出了什么」，帧回答「这一次推送发了多少」'
  )
})

test('恰好等于上限时不截断（边界是 `>` 不是 `>=`）', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'tool_result', id: 'tu1', ok: true, output: 'x'.repeat(FRAME_PAYLOAD_LIMIT) })
  const frame = frames(r).find((f) => f.k === 'tool_result')
  assert.ok(frame && frame.k === 'tool_result')
  assert.equal(frame.truncated, undefined)
})

test('截断按**字节**算，不按字符 —— 中文不能被切坏', () => {
  const r = rig()
  const t = r.begin()
  // 每个汉字 3 字节：`FRAME_PAYLOAD_LIMIT` 个字符远超上限。
  r.batcher.push(t, { k: 'tool_result', id: 'tu1', ok: true, output: '汉'.repeat(FRAME_PAYLOAD_LIMIT) })
  const frame = frames(r).find((f) => f.k === 'tool_result')
  assert.ok(frame && frame.k === 'tool_result')
  assert.equal(frame.truncated, true)
  assert.ok(Buffer.byteLength(frame.output, 'utf8') <= FRAME_PAYLOAD_LIMIT)
  // 切在 UTF-8 边界上 —— 出现 U+FFFD 就说明切在了字符中间。
  assert.ok(!frame.output.includes('\uFFFD'), '截断不许切坏一个多字节字符')
})

// ─────────────────────────────────────────────────────────────
// 六、抑制与未读
// ─────────────────────────────────────────────────────────────

test('★ 非活跃空间：帧照落库，但不推送，且未读累加', () => {
  const r = rig({ unreadMs: 0 })
  r.view.workspaceId = '别的空间'
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '后台在跑' })
  end(r, t)

  assert.equal(r.batches.length, 0, '★ 一个批次都不发')
  assert.ok(r.events(t).length >= 2, '★ 但库里一行都不少 —— 帧已落库，无损失')
  assert.equal(r.batcher.unread(WORKSPACE), 1, '未读的**单位是轮次**，不是帧')
})

test('未读单位是一个轮次：一轮里几十帧也只算 1', () => {
  const r = rig({ unreadMs: 0 })
  r.view.workspaceId = null
  const t = r.begin()
  for (let i = 0; i < 5; i += 1) {
    r.batcher.push(t, { k: 'text_delta', block: 0, text: `第${i}段` })
    r.batcher.push(t, { k: 'thinking_delta', block: 1, text: '想' })
  }
  end(r, t)
  assert.equal(r.batcher.unread(WORKSPACE), 1)
})

test('未读按 ≤1Hz 节流，但**只延迟不丢失**', () => {
  const r = rig()
  r.view.workspaceId = null
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'a' })
  end(r, t)
  assert.ok(r.unreads.length >= 1)
  const first = r.unreads[0]
  assert.deepEqual(first, { workspaceId: WORKSPACE, count: 1 })

  r.batcher.clearUnread(WORKSPACE)
  assert.equal(r.batcher.unread(WORKSPACE), 0)
  assert.deepEqual(
    r.unreads[r.unreads.length - 1],
    { workspaceId: WORKSPACE, count: 0 },
    '清零**立刻**发，不等节流'
  )
})

// ─────────────────────────────────────────────────────────────
// 七、工具 → diff
// ─────────────────────────────────────────────────────────────

test('★ Edit 成功 → file_diff 帧 + 行；失败 → 一条都没有', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, {
    k: 'tool_start',
    id: 'tu1',
    name: 'Edit',
    input: { file_path: 'G:/ws/a.ts', old_string: 'x.y', new_string: 'x?.y' }
  })
  assert.deepEqual(kinds(r), ['tool_start'], '成功之前不下 diff')

  r.batcher.push(t, { k: 'tool_result', id: 'tu1', ok: true, output: 'ok' })
  end(r, t)

  assert.deepEqual(kinds(r).slice(0, 3), ['tool_start', 'tool_result', 'file_diff'])
  const diff = frames(r).find((f) => f.k === 'file_diff')
  assert.ok(diff && diff.k === 'file_diff')
  assert.equal(diff.path, 'a.ts', '绝对路径被缩到 cwd 的相对路径')
  assert.ok(diff.patch.includes('x.y') && diff.patch.includes('x?.y'))
  assert.ok(r.events(t).some((e) => e.kind === 'file_diff'))
})

test('工具失败时**不**产出 file_diff —— 没改成的编辑不许显示成改成了', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, {
    k: 'tool_start',
    id: 'tu1',
    name: 'Edit',
    input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' }
  })
  r.batcher.push(t, { k: 'tool_result', id: 'tu1', ok: false, output: '报错' })
  end(r, t)
  assert.ok(!kinds(r).includes('file_diff'))
})

test('没有映射表的编辑工具 → 诊断，不是崩溃、也不是伪造一个 diff', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, {
    k: 'tool_start',
    id: 'tu1',
    name: 'MultiEdit',
    input: { file_path: 'a.ts', edits: [] }
  })
  r.batcher.push(t, { k: 'tool_result', id: 'tu1', ok: true, output: 'ok' })
  end(r, t)
  assert.ok(!kinds(r).includes('file_diff'))
  assert.ok(
    r.warns.some((w) => w.tag.includes('diff') || w.message.includes('MultiEdit')),
    `应当有一条关于 MultiEdit 的诊断，实际：${JSON.stringify(r.warns)}`
  )
})

// ─────────────────────────────────────────────────────────────
// 八、`<synthetic>` 与失败原因
// ─────────────────────────────────────────────────────────────

test('★ `<synthetic>` 的正文**永远不会**变成一条 text 事件（归档原文）', () => {
  const r = rig()
  const t = r.begin()
  // 解析器已经把它拦成了一条诊断（见 `stream-json-parser.test.ts`），
  // 这里验的是**合批器的兜底**：即便有人把这句话当成事件推了进来，
  // 它也不该出现在 `content_text` 里 —— 用户看到的是模型「开口」说了句 CLI 的报错，
  // 正是 §8.9-18 / §4.4d 点名要防的那件事。
  r.batcher.push(t, { k: 'error', code: 'cli_reported', message: 'Prompt is too long', fatal: true })
  end(r, t, { reason: 'crashed', status: 'failed', errorText: 'Prompt is too long' })

  const msg = r.assistantMessage(t)
  // ⚠️ 是 `''` 而不是 `null` —— `content_text` 那一列的默认值是空串。
  // 断言写成 `null` 会红，而红的原因是**列默认值**，不是这条用例要验的那件事。
  assert.equal(msg?.contentText ?? '', '', '★ 没有模型说过话，正文就必须是空的')
  assert.equal(r.events(t).filter((e) => e.kind === 'text').length, 0, '一条 text 行都不许有')
  const errRow = r.events(t).find((e) => e.kind === 'error')
  assert.ok(errRow, '失败原因必须以 error 事件落库（诊断不落库，那句话重启后一个字都不剩）')
  // 分工：`text_blob` 放**那句话本身**，`payload_json` 放它的机器可读标签。
  assert.equal(errRow.textBlob, 'Prompt is too long')
  assert.ok(errRow.payloadJson?.includes('cli_reported'), '错误码也要落库，否则重启后只剩一句人话')
  assert.ok(r.events(t).some((e) => e.kind === 'done'))
})

test('error 事件落库、诊断不落库 —— 两者是不同的事实，不许互相顶替', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'error', code: 'nonzero_exit', message: '进程退出码 3', fatal: true })
  end(r, t, { reason: 'crashed', status: 'failed', errorText: '进程退出码 3' })
  assert.deepEqual(
    r.events(t).map((e) => e.kind),
    ['error', 'done']
  )
  assert.equal(r.store.repos.turn.get(t)?.status, 'failed')
})

// ─────────────────────────────────────────────────────────────
// 九、终态与回放
// ─────────────────────────────────────────────────────────────

test('★ endTurn 把 done 帧与终态行放进同一个事务；之后库里没有 running', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '完成了' })
  end(r, t)

  const row = r.store.repos.turn.get(t)
  assert.equal(row?.status, 'done')
  assert.equal(row?.terminalReason, 'complete')
  assert.ok(row?.endedAt != null)
  assert.ok(kinds(r).includes('done'))
})

test('中断：终态行写 interrupted，done 帧的 reason 也是 interrupted（同一个值）', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '被停了' })
  end(r, t, { reason: 'interrupted', status: 'interrupted', exitCode: null })
  const done = frames(r).find((f) => f.k === 'done')
  assert.ok(done && done.k === 'done')
  assert.equal(done.reason, 'interrupted')
  assert.equal(r.store.repos.turn.get(t)?.terminalReason, 'interrupted')
})

test('★ 落库失败时终态行也必须写下去 —— 不许留下一条永远 running 的僵尸', () => {
  const r = rig()
  const t = r.begin()
  const base = batcherStoreOf(r.store)
  const failing = createEventBatcher({
    store: {
      ...base,
      message: {
        ...base.message,
        // 事件行写不进去（磁盘满 / 行超限），但终态行那条 UPDATE 仍必须走。
        appendEvent: () => {
          throw new Error('落不进去')
        }
      }
    },
    clock: { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} },
    view: { workspaceId: WORKSPACE },
    emitBatch: () => {},
    emitUnread: () => {},
    onWarn: () => {},
    epoch: 'e'
  })
  failing.beginTurn({
    turnId: t,
    sessionId: SESSION,
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    authorMemberId: MEMBER,
    cwd: 'G:/ws',
    newMessageId: () => 'msg-zombie'
  })
  failing.push(t, { k: 'text_delta', block: 0, text: 'x' })
  failing.endTurn(t, { reason: 'crashed', status: 'failed', errorText: '落库失败', exitCode: null })

  const row = r.store.repos.turn.get(t)
  assert.equal(row?.status, 'failed', '★ 绝不能停在 running')
  assert.equal(row?.errorText, '落库失败')
})

test('★ resume：同纪元续上，不同纪元一律 matched:false', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '一' })
  r.batcher.push(t, { k: 'thinking_delta', block: 1, text: '二' })
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '三' })
  // ★ 帧只在**提交时**进回放环。不 tick 的话环是空的，于是这条用例会在
  // 「回放长度 >= 3」上红，而红的原因是它自己没让那一批出去 —— 不是 resume 错了。
  r.tick(33)

  const all = r.batcher.resume(SESSION, 'epoch-1', 0)
  assert.equal(all.matched, true)
  assert.equal(all.epoch, 'epoch-1')
  assert.ok(all.frames.length >= 3, '在途帧全部回放')

  // 只回放 `fromSeq` **之后**的。
  const after = r.batcher.resume(SESSION, 'epoch-1', all.frames[0]?.seq ?? 0)
  assert.equal(after.matched, true)
  assert.ok(
    after.frames.every((f) => f.seq > (all.frames[0]?.seq ?? 0)),
    '回放的帧必须都严格大于 fromSeq'
  )

  // ★ epoch 检查必须在**最前面** —— 它挡的是另一个问题（进程重启），
  // 不是 fromSeq 的边界。两者不可互相顶替。
  const stale = r.batcher.resume(SESSION, '上一次进程的纪元', 0)
  assert.equal(stale.matched, false, '★ 纪元不匹配 → 丢弃水位线')
  assert.deepEqual(stale.frames, [])
  assert.equal(stale.epoch, 'epoch-1', '响应里给的是主进程**当前**的纪元')
})

test('resume 的 fromSeq 超前（渲染层拿着未来的水位线）→ 一律 matched:false', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'x' })
  r.tick(33)

  /**
   * ★ 一个**超前**的水位线不可能来自本进程（本进程只发过 1 号帧），
   * 所以它是「渲染层和我们说的不是同一套编号」的证据 —— 纪元对得上也没用。
   *
   * 这里**不**返回 `matched: true` + 空帧，理由是那种写法会让界面**永久冻住**：
   * 渲染层收到空回放会认为「我什么都没漏」，于是继续拿 9999 当水位线，
   * 而接下来每一批的 `toSeq` 都小于它 → 每一帧都被滤掉，且不会报任何错。
   * `matched: false` 是唯一能把渲染层推回 `message:list` 的答复。
   */
  const res = r.batcher.resume(SESSION, 'epoch-1', 9999)
  assert.equal(res.matched, false, '★ 不可能的水位线 = 编号错位，必须让渲染层整段重跑')
  assert.deepEqual(res.frames, [])
})

test('回放环有上限：太旧的水位线宁可让渲染层整段重跑', () => {
  const r = rig({ ringFrames: 2 })
  const t = r.begin()
  for (let i = 0; i < 6; i += 1) {
    r.batcher.push(t, { k: 'text_delta', block: 0, text: `第${i}段` })
    r.batcher.push(t, { k: 'tool_start', id: `tu${i}`, name: 'Read', input: {} })
  }
  const res = r.batcher.resume(SESSION, 'epoch-1', 0)
  assert.equal(res.matched, false, '★ 太旧 → matched:false，渲染层据此整段重跑 message:list')
  assert.deepEqual(res.frames, [])
})

test('★ 环在 beginTurn 清空（不是在 endTurn）—— 刚结束那一轮的尾巴仍可重放', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '这一轮的尾巴' })
  end(r, t)
  const res = r.batcher.resume(SESSION, 'epoch-1', 0)
  assert.equal(res.matched, true)
  assert.ok(res.frames.length > 0, '轮次结束了但尾巴还在环里')
})

// ─────────────────────────────────────────────────────────────
// 十、close()
// ─────────────────────────────────────────────────────────────

test('★ close() 同步冲空脏缓冲，并清掉定时器 —— 退出时那 33ms 不能丢', () => {
  // 用 `rig()` 的真时钟替换版：计时器永不触发（`setTimeout` 返回 0 且没人跑它），
  // 于是「脏缓冲只能靠 close() 落地」这件事是被**构造**出来的，不是碰巧。
  const r = rig({ flushMs: 100_000 })
  const t = r.begin({ newMessageId: () => 'msg-close' })
  r.batcher.push(t, { k: 'text_delta', block: 0, text: '退出前最后一句' })
  assert.equal(r.batches.length, 0, '前置：还没到刷新点')
  assert.equal(r.pending(), 1, '前置：有一个在等的定时器')

  r.batcher.close()

  const row = r.store.db
    .prepare(`SELECT content_text FROM message WHERE id = 'msg-close'`)
    .get() as { content_text: string | null } | undefined
  assert.equal(row?.content_text, '退出前最后一句', '★ close() 必须把脏缓冲写下去')
  assert.equal(r.pending(), 0, '定时器必须一起清掉，否则进程退不掉')
})

test('close() 之后推事件不再抛 —— 但也不再假装成功', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.close()
  const res = r.batcher.push(t, { k: 'text_delta', block: 0, text: '关了之后' })
  assert.equal(res.ok, false)
})

// ─────────────────────────────────────────────────────────────
// 十一、契约细节
// ─────────────────────────────────────────────────────────────

test('usage 帧的三个新字段永远是**数字**（0 表示确实没命中，不是「没上报」）', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'usage', in: 10, out: 20 })
  r.tick(33)
  const f = frames(r)[0]
  assert.ok(f && f.k === 'usage')
  assert.equal(f.cacheRead, 0)
  assert.equal(f.cacheCreation, 0)
  assert.equal(f.thinkingTokens, 0)
  assert.equal(f.costUsd, undefined, 'costUsd 未知就是不出现，不是 0')
})

test('★ 上报的 0 不许覆盖流内累计的思考量（§4.6a 规则二）', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'thinking_delta', block: 0, text: '一二三四五' })
  r.batcher.push(t, { k: 'usage', in: 1, out: 2, thinkingTokens: 0 })
  r.tick(33)
  const f = frames(r).find((x) => x.k === 'usage')
  assert.ok(f && f.k === 'usage')
  assert.ok(f.thinkingTokens > 0, `0 表示「没上报」，不许拿它盖掉实测量（得到 ${f.thinkingTokens}）`)
})

test('usage 也落库，且 payload 里带上三个新字段', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'usage', in: 10, out: 20, cacheRead: 3, cacheCreation: 4, thinkingTokens: 5 })
  end(r, t)
  const row = r.events(t).find((e) => e.kind === 'usage')
  assert.ok(row)
  const payload = JSON.parse(row.payloadJson ?? '{}') as Record<string, unknown>
  assert.equal(payload.cacheRead, 3)
  assert.equal(payload.cacheCreation, 4)
  assert.equal(payload.thinkingTokens, 5)
})

test('没有 beginTurn 就推事件 → 抛（这是调用方的错，不是可忽略的噪声）', () => {
  const r = rig()
  assert.throws(() => r.batcher.push('不存在的轮次', { k: 'text_delta', block: 0, text: 'x' }))
})

test('批次载荷带 epoch / workspaceId / sessionId / turnId / actorId', () => {
  const r = rig({ epoch: 'e-42' })
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'x' })
  end(r, t)
  const b = r.batches[0]
  assert.ok(b)
  assert.equal(b.epoch, 'e-42')
  assert.equal(b.workspaceId, WORKSPACE)
  assert.equal(b.sessionId, SESSION)
  assert.equal(b.turnId, t)
  assert.equal(b.actorId, ACTOR, '★ 必须是真实 actorId，不是空串')
  assert.equal(b.v, 1)
})

test('debugState 是可读的（自检用，不是内部状态的泄漏口）', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'text_delta', block: 0, text: 'x' })
  const state = r.batcher.debugState()
  assert.equal(typeof state, 'object')
  assert.ok(r.batches.length === 0, 'debugState 不该触发刷新')
})

test('同一轮里 done 只发一次 —— 即便 push 和 endTurn 都被调了', () => {
  const r = rig()
  const t = r.begin()
  r.batcher.push(t, { k: 'done', reason: 'complete' })
  end(r, t)
  assert.equal(kinds(r).filter((k) => k === 'done').length, 1)
})
