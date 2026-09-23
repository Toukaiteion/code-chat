/**
 * M6b 验证之一：帧 → 缓冲的**归约**（`src/shared/live/frame-buffer.ts`）。
 *
 * 这是整个 M6b 里最容易错、又最难靠肉眼发现的一块，所以它是主战场。测试的重点
 * 不是「拼接对不对」（那太显然），而是三类**错了不会报错**的事：
 *
 * 1. **引用稳定性**。§4.7 规则 4 要求思考 delta 不触发正文节点重渲染 ——
 *    那件事**没有别的办法验证**：组件层没有测试（仓库里没有 jsdom）。
 *    但它其实是个可测的纯函数性质：思考帧到达时 `text` 必须是**同一个字符串引用**，
 *    反之亦然；`items` 只在真的增删时才换引用。
 *    这三条一旦破了，界面照样「看起来在工作」，只是每来一个 delta 就重渲染一整轮。
 * 2. **不许编**。没见过 `tool_start` 就给工具名留空（不拿 id 猜）、
 *    `file_diff` 的 patch 一个字符都不动（不自己算行号）。
 * 3. **未知帧不许抛**。推送路径**不做 zod 校验**（`client.ts` 的 `onPush` 是直接 cast），
 *    所以一个看不懂的帧会真的走到 `default` 分支上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFrame,
  applyFrames,
  emptyBuffer,
  type StreamFrame,
  type TurnIds
} from '../../src/shared/live/frame-buffer.ts'

const IDS: TurnIds = {
  turnId: 'turn-1',
  sessionId: 'sess-1',
  workspaceId: 'ws-1',
  actorId: 'actor-1'
}

// ─── 帧的构造器。写全每一个字段，免得漏字段被 TS 拦住时还要回来改一堆字面量 ───

const text = (seq: number, d: string): StreamFrame => ({ seq, k: 'text', d })
const thinking = (seq: number, d: string): StreamFrame => ({ seq, k: 'thinking', d })
const thinkingEnd = (seq: number): StreamFrame => ({ seq, k: 'thinking_end' })
const toolStart = (seq: number, id: string, name: string, input: unknown): StreamFrame => ({
  seq,
  k: 'tool_start',
  id,
  name,
  input
})
const toolResult = (seq: number, id: string, ok: boolean, output: string): StreamFrame => ({
  seq,
  k: 'tool_result',
  id,
  ok,
  output
})
const fileDiff = (seq: number, path: string, patch: string): StreamFrame => ({
  seq,
  k: 'file_diff',
  path,
  patch
})
const usage = (seq: number): StreamFrame => ({
  seq,
  k: 'usage',
  in: 100,
  out: 20,
  cacheRead: 30,
  cacheCreation: 0,
  thinkingTokens: 5
})
const done = (seq: number): StreamFrame => ({ seq, k: 'done', reason: 'complete' })

const fold = (frames: readonly StreamFrame[]) => {
  const buf = applyFrames(null, IDS, frames)
  assert.ok(buf, '这批帧非空，应当建出缓冲')
  return buf
}

// ─────────────────────────────────────────────────────────────
// 一、建缓冲的边界：空批**不许**建
// ─────────────────────────────────────────────────────────────

test('★ 空批不建缓冲 —— 空缓冲会把已有的历史行藏起来', () => {
  // 这条看起来琐碎，但它是「有缓冲才抑制历史行」那条规则的反面：
  // 一个空的缓冲会让 `<MessageList>` 抑制掉一条**有内容**的历史行，
  // 用户在界面上看到的是「这条消息消失了」。
  assert.equal(applyFrames(null, IDS, []), null)
})

test('非空批建出缓冲，并把 id 带上（帧上不带 workspaceId/turnId，靠批带）', () => {
  const buf = fold([text(1, '你')])
  assert.equal(buf.turnId, 'turn-1')
  assert.equal(buf.sessionId, 'sess-1')
  assert.equal(buf.workspaceId, 'ws-1')
  assert.equal(buf.actorId, 'actor-1')
  assert.equal(buf.text, '你')
  assert.equal(buf.done, null)
  assert.equal(buf.usage, null)
})

// ─────────────────────────────────────────────────────────────
// 二、★ 引用稳定性（§4.7 规则 4 的可测形式）
// ─────────────────────────────────────────────────────────────

test('★★ 思考 delta 不动 `text` 的引用，正文 delta 不动 `thinking` 的引用', () => {
  // 这是规则 4 在纯逻辑层的全部内容：`<StreamingText>` 与 `<ThinkingPanel>`
  // 各订阅各的字段，选择器比的是 `Object.is`。只要没变的那一边**保持同一个引用**，
  // 思考 delta 就不会让正文节点重渲染，反之亦然。
  const a = fold([text(1, '正文'), thinking(2, '想')])
  const b = applyFrame(a, thinking(3, '考'))
  assert.equal(b.text, a.text, '来了思考帧，正文那个字符串必须是同一个引用')
  assert.notEqual(b.thinking, a.thinking)

  const c = applyFrame(b, text(4, '继续'))
  assert.equal(c.thinking, b.thinking, '来了正文帧，思考那个字符串必须是同一个引用')
  assert.notEqual(c.text, b.text)
})

test('★ 空 delta 连自己那一边的引用都不该动（它会让订阅者白重渲染一次）', () => {
  const a = fold([text(1, '正文')])
  assert.equal(applyFrame(a, text(2, '')), a, '空 text 帧应当原样返回')

  const b = fold([thinking(1, '想')])
  assert.equal(applyFrame(b, thinking(2, '')), b, '空 thinking 帧应当原样返回')
})

test('★ `items` 只在真的增删时换引用（否则订阅时间线的组件每帧都重渲染）', () => {
  const a = fold([text(1, 'a'), toolStart(2, 't1', 'Read', { file_path: 'a.ts' })])
  const b = applyFrame(a, text(3, 'b'))
  assert.equal(b.items, a.items, '只来了正文帧，时间线数组必须是同一个引用')

  const c = applyFrame(b, fileDiff(4, 'a.ts', '-1\n+2'))
  assert.notEqual(c.items, b.items, '真的多了一个条目，引用必须换')
})

// ─────────────────────────────────────────────────────────────
// 三、思考面板的折叠
// ─────────────────────────────────────────────────────────────

test('`thinking_end` 收起面板；**再来思考要重新展开**', () => {
  // 「重新展开」不是可有可无的润色：工具调用之间会再出现一段思考，
  // 把它塞进一个已经收起的面板里，等于凭空少显示一段内容。
  const a = fold([thinking(1, '第一段')])
  assert.equal(a.thinkingOpen, true, '初值应当是展开的')

  const b = applyFrame(a, thinkingEnd(2))
  assert.equal(b.thinkingOpen, false)

  const c = applyFrame(b, thinking(3, '第二段'))
  assert.equal(c.thinkingOpen, true, '新来的思考必须重新展开，否则用户看不到它')
  assert.equal(c.thinking, '第一段第二段')
})

test('重复的 `thinking_end` 不换引用（同一件事说两遍不该引起重渲染）', () => {
  const a = applyFrame(fold([thinking(1, 'x')]), thinkingEnd(2))
  assert.equal(applyFrame(a, thinkingEnd(3)), a)
})

// ─────────────────────────────────────────────────────────────
// 四、工具的配对（按 id，不是按顺序）
// ─────────────────────────────────────────────────────────────

test('★ `tool_result` 按 id 配到自己的那次调用 —— 两个工具交错时顺序会骗人', () => {
  // agent 可以并发发起多个工具调用，结果的到达顺序**不保证**与发起顺序一致。
  // 按顺序配对（「第二个结果配第二个调用」）在单工具时永远正确、在并发时静默错位。
  const buf = fold([
    toolStart(1, 'a', 'Read', { file_path: 'a.ts' }),
    toolStart(2, 'b', 'Read', { file_path: 'b.ts' }),
    toolResult(3, 'b', true, 'B 的内容'),
    toolResult(4, 'a', true, 'A 的内容')
  ])

  const [first, second] = buf.items
  assert.ok(first && first.kind === 'tool' && second && second.kind === 'tool')
  assert.equal(first.name, 'Read')
  assert.equal(first.result?.output, 'A 的内容', 'a 的调用必须配 a 的结果')
  assert.equal(second.result?.output, 'B 的内容', 'b 的调用必须配 b 的结果')
})

test('★ 没见过 `tool_start` 的结果：名字留空，**不许拿 id 猜**', () => {
  // 重放从中间接上时会这样。猜一个名字出来的话，那个名字会被当成事实读 ——
  // 界面会说「它调用了 X」，而我们从没见过那次调用。
  const buf = fold([toolResult(7, 'toolu_01ABC', true, '文件内容')])
  const item = buf.items[0]
  assert.ok(item && item.kind === 'tool')
  assert.equal(item.started, false)
  assert.equal(item.name, null)
  assert.equal(item.input, undefined)
  assert.equal(item.result?.output, '文件内容', '结果本身是确凿的，要显示')
})

test('结果先到、调用后到（同一 id）：补全那一条，不压第二条', () => {
  const buf = fold([toolResult(1, 't1', true, 'out'), toolStart(2, 't1', 'Edit', { a: 1 })])
  assert.equal(buf.items.length, 1, '同一个 id 只该有一个条目')
  const item = buf.items[0]
  assert.ok(item && item.kind === 'tool')
  assert.equal(item.started, true)
  assert.equal(item.name, 'Edit')
  assert.equal(item.result?.output, 'out', '先前拿到的结果不能被丢掉')
})

test('`truncated` 缺省成 false（不是 undefined —— 界面要判真假）', () => {
  const buf = fold([toolStart(1, 't1', 'Bash', {}), toolResult(2, 't1', true, 'x')])
  const item = buf.items[0]
  assert.ok(item && item.kind === 'tool')
  assert.equal(item.result?.truncated, false)
})

test('失败的工具调用也如实记下来（成功与失败是同一件事的两个取值）', () => {
  const buf = fold([toolStart(1, 't1', 'Bash', {}), toolResult(2, 't1', false, 'command not found')])
  const item = buf.items[0]
  assert.ok(item && item.kind === 'tool')
  assert.equal(item.result?.ok, false)
  assert.equal(item.result?.output, 'command not found')
})

// ─────────────────────────────────────────────────────────────
// 五、diff / 错误 / 用量 / 结束
// ─────────────────────────────────────────────────────────────

test('★ `file_diff` 的 patch 原样透传，一个字符都不动', () => {
  // 夹具是 `tool-diff.ts` 真的会产出的两种形状：`replace_all` 的注释行 +
  // 一行走一行来（Edit）、以及只有 `+`（Write）。含 `#` 注释行是为了钉住
  // 「注释与内容不许混淆」这条 —— 渲染方按首字符分类。
  const editPatch = '# replace_all：该替换在文件里出现多次，每一处都已被替换\n-export const x = 1\n+export const x = 2'
  const writePatch = '# 整文件写入：覆盖前的原文未知（未读取文件）\n+第一行\n+第二行'

  const buf = fold([fileDiff(1, 'src/a.ts', editPatch), fileDiff(2, 'src/b.ts', writePatch)])
  const [d1, d2] = buf.items
  assert.ok(d1 && d1.kind === 'diff' && d2 && d2.kind === 'diff')

  assert.equal(d1.path, 'src/a.ts')
  assert.equal(d1.patch, editPatch, 'patch 必须逐字相同 —— 加行号、加 @@ 都是在编位置')
  assert.equal(d2.patch, writePatch)
  assert.ok(!d1.patch.includes('@@'), 'patch 里不该出现 @@')
})

test('错误条目保住 code / fatal —— 界面据此给**准确的下一步提示**', () => {
  const buf = fold([
    { seq: 1, k: 'error', code: 'budget_exceeded', message: '撞上预算闸', fatal: true }
  ])
  const item = buf.items[0]
  assert.ok(item && item.kind === 'error')
  assert.equal(item.code, 'budget_exceeded')
  assert.equal(item.fatal, true)
  assert.equal(item.message, '撞上预算闸')
})

test('★ 后来的 `usage` **覆盖**前一个，不是累加', () => {
  // 一轮只发一条 usage（`event-batcher` 的 `usageFrame()` 从终态 result 造它）。
  // 累加会把同一轮的用量算两遍 —— 一个用户看不出来的错，直到他去对账。
  const first: StreamFrame = {
    seq: 1,
    k: 'usage',
    in: 10,
    out: 1,
    cacheRead: 0,
    cacheCreation: 0,
    thinkingTokens: 0
  }
  const second: StreamFrame = {
    seq: 2,
    k: 'usage',
    in: 100,
    out: 20,
    cacheRead: 30,
    cacheCreation: 5,
    thinkingTokens: 7
  }
  const buf = fold([first, second])
  assert.equal(buf.usage?.in, 100, 'in 不该是 110 —— 那是两条 usage 相加')
  assert.equal(buf.usage?.cacheRead, 30)
})

test('`usage` 的五个字段原样带过来（§4.6a 规则一：算出来了就必须往下传）', () => {
  const buf = fold([usage(1)])
  assert.equal(buf.usage?.in, 100)
  assert.equal(buf.usage?.out, 20)
  assert.equal(buf.usage?.cacheRead, 30)
  assert.equal(buf.usage?.cacheCreation, 0)
  assert.equal(buf.usage?.thinkingTokens, 5)
})

test('`done` 只置标志，**不**自己推断终态', () => {
  // `done` 帧说的是「正文结束了」，而库里那一行是另一个时刻才变终态的（实测差 249–377ms）。
  // 缓冲里因此只能有一个 reason，不能有 status。
  const buf = fold([text(1, '说完了'), done(2)])
  assert.equal(buf.done, 'complete')
  assert.equal(buf.text, '说完了')
})

// ─────────────────────────────────────────────────────────────
// 六、未知帧
// ─────────────────────────────────────────────────────────────

test('★ 不认识的帧被忽略，而不是抛 —— 推送路径没有 zod 校验', () => {
  // `client.ts` 的 `onPush` 是 `bridge.on(channel, listener as …)`，载荷原样交付。
  // 于是主进程版本比渲染层新时，这个分支会真的被执行到。
  const bogus = { seq: 99, k: 'quantum_entangled', payload: {} } as unknown as StreamFrame
  const a = fold([text(1, 'x')])
  const b = applyFrame(a, bogus)
  assert.equal(b, a, '看不懂的帧不该改动任何东西')
})

// ─────────────────────────────────────────────────────────────
// 七、逐帧 vs 整批：两种喂法必须等价
// ─────────────────────────────────────────────────────────────

test('★ 逐帧归约与整批归约结果一致（批的边界不该改变结果）', () => {
  // 合批器会把一批拆成几批发（刷新时机取决于定时器），所以「一批之内的相邻帧」
  // 与「跨批的相邻帧」在渲染层是**同一件事**。这个等价性一旦破了，
  // 界面上的内容会随网络/定时器的抖动而不同 —— 最难查的那种 bug。
  const frames: StreamFrame[] = [
    thinking(1, '想一'),
    thinking(2, '想二'),
    thinkingEnd(3),
    toolStart(4, 't1', 'Edit', { file_path: 'a.ts' }),
    text(5, '改'),
    text(6, '好了'),
    toolResult(7, 't1', true, 'ok'),
    fileDiff(8, 'a.ts', '-1\n+2'),
    usage(9),
    done(10)
  ]

  const whole = fold(frames)

  // 逐帧
  let step = emptyBuffer(IDS)
  for (const f of frames) step = applyFrame(step, f)
  assert.deepEqual(step, whole, '逐帧喂与整批喂必须得到同一个缓冲')

  // 再按「每两帧一批」的切法喂
  let chunked = applyFrames(null, IDS, frames.slice(0, 2))
  assert.ok(chunked)
  chunked = applyFrames(chunked, IDS, frames.slice(2, 4))
  assert.ok(chunked)
  chunked = applyFrames(chunked, IDS, frames.slice(4))
  assert.ok(chunked)
  assert.deepEqual(chunked, whole, '批的切法不该影响结果')
})
