/**
 * M6b 验证之三：空间时间线的排法（`src/shared/live/timeline.ts`）。
 *
 * 这个模块输出的东西全部**直接可见**，所以它错起来不像水位线那样静默 ——
 * 但错法有两种，两种都是「用户看到不存在的对话」：
 *
 * 1. **有缓冲却没抑制历史行** → 同一段回答出现**两遍**（一遍是流式行、一遍是历史行），
 *    而两遍的正文**可能不一致**（历史行停在最后一次刷新，流式行继续长）。
 *    用户面对的是两条不同的回答，无从知道哪条是真的。
 * 2. **没缓冲却抑制了历史行** → 这条回答**整个消失**。这比第 1 种更糟：
 *    用户以为模型没回答，而它其实答了。
 *
 * 两条判据各只有一个条件，所以测试也就一条一条地钉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline, shouldReadEvents } from '../../src/shared/live/timeline.ts'
import type { Message } from '../../src/shared/entities.ts'

/** 只给对比用得上的字段填值 —— 其余字段与这些判断无关，用固定值占位。 */
function msg(id: string, turnId: string | null): Message {
  return {
    id,
    workspaceId: 'ws-1',
    sessionId: turnId === null ? null : `s-${turnId}`,
    turnId,
    role: turnId === null ? 'user' : 'assistant',
    authorMemberId: turnId === null ? null : 'actor-1',
    seq: 0,
    contentText: '',
    contentPath: null,
    contentBytes: 0,
    mentions: [],
    injectMode: 'full',
    summaryText: null,
    createdAt: 0,
    editedAt: null,
    deletedAt: null
  }
}

const ids = (e: ReturnType<typeof buildTimeline>): string[] =>
  e.map((x) => (x.kind === 'message' ? `m:${x.id}` : x.kind === 'failed' ? `f:${x.triggerMessageId}` : `s:${x.turnId}`))

test('基本形：历史按 `order` 的顺序，在途轮次一律排在最后', () => {
  const out = buildTimeline({
    order: ['u1', 'a1'],
    messages: { u1: msg('u1', null), a1: msg('a1', 't1') },
    streamingTurnIds: ['t2'],
    failuresByTrigger: {}
  })
  assert.deepEqual(ids(out), ['m:u1', 'm:a1', 's:t2'])
})

test('★ 有缓冲的轮次 → 它的历史行**不进列表**（否则同一段回答出现两遍）', () => {
  const out = buildTimeline({
    order: ['u1', 'a1'],
    messages: { u1: msg('u1', null), a1: msg('a1', 't1') },
    streamingTurnIds: ['t1'],
    failuresByTrigger: {}
  })
  assert.deepEqual(ids(out), ['m:u1', 's:t1'], 'a1 让开，它的正文由流式行呈现')
})

test('★★ 反过来：**没有**缓冲就照常显示历史行（否则这条回答整个消失）', () => {
  // 这一支是常用的，不是异常：新进程打开一个已经在跑的轮次（`fromStart` 为假，
  // 见 `watermark.ts`）走的正是这里，而 `content_text` 就是这一轮到目前为止的正文。
  const out = buildTimeline({
    order: ['u1', 'a1'],
    messages: { u1: msg('u1', null), a1: msg('a1', 't1') },
    streamingTurnIds: [],
    failuresByTrigger: {}
  })
  assert.deepEqual(ids(out), ['m:u1', 'm:a1'])
})

test('只有 `turnId` 对得上的那一行让开，同空间的其它历史行不受影响', () => {
  const out = buildTimeline({
    order: ['a1', 'a2', 'a3'],
    messages: { a1: msg('a1', 't1'), a2: msg('a2', 't2'), a3: msg('a3', 't3') },
    streamingTurnIds: ['t2'],
    failuresByTrigger: {}
  })
  // ⚠️ 在途那一格在**末尾**，不是在被抑制的那一行的位置上 —— 这是有意的（见文件头），
  //    所以这条断言同时钉住了两件事：历史里只少了 a2，而 a3 照旧跟在 a1 后面。
  assert.deepEqual(ids(out), ['m:a1', 'm:a3', 's:t2'], '历史行只少 a2 一条，在途格排在最后')
})

test('★ 用户消息（`turnId === null`）永远不被抑制 —— 它没有轮次，也就没有流式行', () => {
  // 判据写成了 `m.turnId !== null && ...`。少了前半句的话，`turnId` 为 `null` 的
  // 用户消息会去撞 `streamingTurnIds.includes(null)` —— 那是假，所以行为上没错，
  // 但这层保护是有意的：将来若有人把 `streamingTurnIds` 换成可能含 `null` 的东西，
  // 这里不会跟着塌。
  const out = buildTimeline({
    order: ['u1'],
    messages: { u1: msg('u1', null) },
    streamingTurnIds: ['t1'],
    failuresByTrigger: {}
  })
  assert.deepEqual(ids(out), ['m:u1', 's:t1'])
})

test('★ 失败轮次紧跟在**触发它的那条消息**后面（不比较任何两个 seq 轴）', () => {
  const out = buildTimeline({
    order: ['u1', 'u2'],
    messages: { u1: msg('u1', null), u2: msg('u2', null) },
    streamingTurnIds: [],
    failuresByTrigger: { u1: { id: 't9' } }
  })
  assert.deepEqual(ids(out), ['m:u1', 'f:u1', 'm:u2'])
})

test('失败轮次的触发消息**不在** `order` 里 → 那一格不出现（不凭空虚插）', () => {
  // `failuresByTrigger` 的键是触发消息 id，而 `order` 是主进程给的时间线。
  // 键不在 `order` 里说明这条消息还没载入 —— 插一格会让它跑到**别的消息**后面。
  const out = buildTimeline({
    order: ['u1'],
    messages: { u1: msg('u1', null) },
    streamingTurnIds: [],
    failuresByTrigger: { u404: { id: 't9' } }
  })
  assert.deepEqual(ids(out), ['m:u1'])
})

test('`order` 里有一条 `messages` 还没有的 id → 跳过它，其余照排', () => {
  // `order` 与 `messages` 是依次写进 store 的两个字段，中间那一瞬可能不一致。
  // 抛出去会让整个对话面板白屏。
  const out = buildTimeline({
    order: ['u1', 'ghost', 'u2'],
    messages: { u1: msg('u1', null), u2: msg('u2', null) },
    streamingTurnIds: [],
    failuresByTrigger: {}
  })
  assert.deepEqual(ids(out), ['m:u1', 'm:u2'])
})

test('空空间 → 空数组（交给调用方去渲染空态，不在这里编一句话）', () => {
  assert.deepEqual(
    buildTimeline({ order: [], messages: {}, streamingTurnIds: [], failuresByTrigger: {} }),
    []
  )
})

// ─────────────────────────────────────────────────────────────
// `shouldReadEvents`
// ─────────────────────────────────────────────────────────────

test('★ 用户消息不读事件行（读了会折出空缓冲，把那句话盖成空白）', () => {
  const v = shouldReadEvents(msg('u1', null), { liveTurnIds: [], runtimeLoaded: true })
  assert.deepEqual(v, { kind: 'skip', reason: 'user-message' })
})

test('★ 在途轮次不读（事件行每 33ms 多几行，折出来的是冻结的半句话）', () => {
  const v = shouldReadEvents(msg('a1', 't1'), { liveTurnIds: ['t1'], runtimeLoaded: true })
  assert.deepEqual(v, { kind: 'skip', reason: 'live-turn' })
})

test('★ `runtime` 还没读回来 → 不读（无法断定有没有在跑的轮次）', () => {
  // ⚠️ 这一支**不能**退化成「当作没有在跑的轮次」：那会在最需要它的那一瞬
  //    （刚打开空间）折出一份冻结的正文，而它随后盖住随流增长的 `content_text`。
  const v = shouldReadEvents(msg('a1', 't1'), { liveTurnIds: [], runtimeLoaded: false })
  assert.deepEqual(v, { kind: 'skip', reason: 'unknown-runtime' })
})

test('落定的角色消息 → 读，并把 `turnId` 一并带出来（调用方不用再收窄一次）', () => {
  const v = shouldReadEvents(msg('a1', 't1'), { liveTurnIds: ['t2'], runtimeLoaded: true })
  assert.deepEqual(v, { kind: 'read', turnId: 't1' })
})

test('「别的轮次在跑」不影响这一条 —— 判据是**自己那个** turnId', () => {
  // 一场对话里多个成员同时跑是常态（每 session 一个），别把整屏都冻住。
  const v = shouldReadEvents(msg('a1', 't1'), { liveTurnIds: ['t2', 't3'], runtimeLoaded: true })
  assert.equal(v.kind, 'read')
})
