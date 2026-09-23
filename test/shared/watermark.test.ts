/**
 * M6b 验证之二：纪元、帧水位线与「这一轮我够不够格自己渲染」
 * （`src/shared/live/watermark.ts`）。
 *
 * 这个模块里没有任何一行代码会在错的时候报错。它的两种错法都是**静默**的：
 *
 * - 水位线偏**小** → 每一批实时帧都被判成旧的，界面永远冻在第一帧；
 * - 水位线偏**大** → 一段内容永远收不到，界面少一块而没有任何提示。
 *
 * 所以这里验的是四条容易被「顺手简化」掉的判断：
 *
 * 1. **水位线是 `toSeq`（计数器高水位），不是末帧的 `seq`。** 合并保留首个 seq，
 *    被合并掉的号就跳过去了 —— 拿末帧 seq 当水位线，下一次 `resume` 会把自己
 *    以为漏掉的那一段**再要一遍**。
 * 2. **没有纪元就不许重放。** `event-batcher` 的第一道判断是
 *    `epochIn !== epoch → matched:false + 空帧`，而那个结果与「正常的空回复」
 *    长得一模一样 —— 新进程若随手编一个纪元发过去，会得到一次**看起来成功**的空重放。
 * 3. **`matched:false` 之后不许重试**，只能删掉这个 session 的**两份**记忆（水位线 +
 *    轮次）。三种成因在主进程侧就塌成同一个响应（§4.3 的设计），渲染层的动作三者完全一样。
 * 4. ★ **「我有一条水位线」不等于「我看着这一轮从头开始」。** 水位线是跨轮次的，
 *    而重放环里只有**当前这一轮**的帧 —— 这是第一版协议踩过的坑，也是 `TurnWatch`
 *    存在的全部理由。测试里对它的验法是：**同一轮**的后续批次不许把 `fromStart` 翻掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyResume,
  emptyCursor,
  learnEpoch,
  maxFrameSeq,
  observeBatch,
  planBatch,
  resumePlan,
  type StreamCursor
} from '../../src/shared/live/watermark.ts'
import type { StreamBatch, StreamFrame } from '../../src/shared/live/frame-buffer.ts'

const text = (seq: number, d: string): StreamFrame => ({ seq, k: 'text', d })

/**
 * 造一批帧。
 *
 * `toSeq` **刻意与末帧的 seq 不同** —— 这正是真实情形：合并会把分配过的号吃掉。
 * 默认让 `toSeq` 比末帧大 2，好让「拿末帧当水位线」这种写法在这里当场失败。
 *
 * `turnId` 可给：`turns` 那几条判断全都要靠「换轮次」才触发。
 */
function batch(
  epoch: string,
  sessionId: string,
  fromSeq: number,
  frames: StreamFrame[],
  toSeq?: number,
  turnId = 'turn-1'
): StreamBatch {
  const last = frames.length > 0 ? frames[frames.length - 1]!.seq : fromSeq
  return {
    v: 1,
    t: 1_700_000_000_000,
    workspaceId: 'ws-1',
    sessionId,
    turnId,
    actorId: 'actor-1',
    epoch,
    fromSeq,
    toSeq: toSeq ?? last,
    frames
  }
}

/** 看着某一轮从第一帧跑到 `toSeq` —— 返回「这一轮看完了」的游标。 */
function watchTurn(c: StreamCursor, sessionId: string, turnId: string, toSeq: number): StreamCursor {
  return observeBatch(c, batch('e1', sessionId, 1, [text(1, '首')], toSeq, turnId)).cursor
}

// ─────────────────────────────────────────────────────────────
// 一、纪元
// ─────────────────────────────────────────────────────────────

test('学会纪元：第一次是「变了」，同一个值再来就不动', () => {
  const a = learnEpoch(emptyCursor(), 'e1')
  assert.equal(a.epochChanged, true, '第一次学到，对调用方来说就是「换纪元了」')
  assert.equal(a.cursor.epoch, 'e1')

  const b = learnEpoch(a.cursor, 'e1')
  assert.equal(b.epochChanged, false)
  assert.equal(b.cursor, a.cursor, '纪元没变就该原样返回同一个对象')
})

test('★ 纪元一变，**所有**水位线与轮次记忆整体作废', () => {
  // 这是全局最重要的一条：旧的 seq 属于上一套编号，留着它们会让
  // `fromSeq` 落在一个**新编号体系里看起来合法**的位置上；
  // 而 `turns` 里的 `startSeq` 同样是旧编号，留着它就会拿一个错的数去要整轮。
  let c: StreamCursor = emptyCursor()
  c = observeBatch(c, batch('e1', 's1', 1, [text(1, 'a'), text(2, 'b')], 2)).cursor
  c = observeBatch(c, batch('e1', 's2', 1, [text(1, 'x')], 1)).cursor
  assert.equal(c.watermarks['s1'], 2)
  assert.equal(c.watermarks['s2'], 1)
  assert.ok(c.turns['s1'] !== undefined && c.turns['s2'] !== undefined, '前提：两份记忆都在')

  const after = learnEpoch(c, 'e2')
  assert.equal(after.epochChanged, true)
  assert.deepEqual(after.cursor.watermarks, {}, '换了纪元，一个水位线都不许留')
  assert.deepEqual(after.cursor.turns, {}, '轮次记忆也一样 —— 它的 startSeq 是旧编号')
})

// ─────────────────────────────────────────────────────────────
// 二、水位线是 `toSeq`，不是末帧的 seq
// ─────────────────────────────────────────────────────────────

test('★ 水位线取 `toSeq`（高水位），不是末帧的 `seq`', () => {
  // 批里只有 11 和 14 两帧，而 toSeq 是 16 —— 中间的号被合并吃掉了。
  // 用末帧的 14 当水位线的话，下一次 resume 会把 15、16 再要一遍。
  const b = batch('e1', 's1', 11, [text(11, 'a'), text(14, 'b')], 16)
  const { cursor } = observeBatch(emptyCursor(), b)
  assert.equal(cursor.watermarks['s1'], 16, '必须是 toSeq')
  assert.notEqual(cursor.watermarks['s1'], 14, '不许是末帧的 seq')
})

test('水位线只会往前 —— 一个 toSeq 更小的批次不会把它拉回去', () => {
  // 含义上就是这样：「我有了到这儿为止的内容」这件事，不会因为收到一批更旧的
  // 而变得不成立。拉回去的后果是下一次 resume 把已经有的那段再要一遍。
  let c = observeBatch(emptyCursor(), batch('e1', 's1', 1, [text(1, 'a')], 50)).cursor
  c = observeBatch(c, batch('e1', 's1', 1, [text(1, 'a')], 10)).cursor
  assert.equal(c.watermarks['s1'], 50)
})

test('多个 session 各记各的（帧 seq 是**每 session** 的计数器）', () => {
  let c = observeBatch(emptyCursor(), batch('e1', 's1', 1, [text(1, 'a')], 5)).cursor
  c = observeBatch(c, batch('e1', 's2', 1, [text(1, 'x')], 3)).cursor
  assert.equal(c.watermarks['s1'], 5)
  assert.equal(c.watermarks['s2'], 3)
})

// ─────────────────────────────────────────────────────────────
// 三、★ 什么时候**不许**重放
// ─────────────────────────────────────────────────────────────

test('★ 还不知道纪元 → 不重放（发什么纪元都是空帧）', () => {
  // 这正是「新进程刚起来」的那一刻。随手编一个纪元发过去，主进程会返回
  // `matched:false` + 空帧 —— 一个**看起来像成功空回复**的结果。
  assert.equal(resumePlan(emptyCursor(), 's1', false), null)
})

test('★ 有纪元、但没有任何记忆 → 也要重放，`fromSeq` 给 0', () => {
  // 这一条是 M6b 落地时**改掉的旧判断**（原来这里返回 null）。给 0 在
  // 「本会话于本进程的第一轮」上恰好是那个对的答案（主进程的 `retainedFrom` 还是 0），
  // 一次就能把整轮要回来，界面直接从流式渲染接上。
  // 给 0 在别的轮次上会得到 `matched:false` —— 那是一条**安全**的空手而归。
  const { cursor } = learnEpoch(emptyCursor(), 'e1')
  const plan = resumePlan(cursor, 's1', false)
  assert.ok(plan, '「没有水位线」不再是拒绝重放的理由')
  assert.equal(plan.epoch, 'e1')
  assert.equal(plan.fromSeq, 0)
})

// ─────────────────────────────────────────────────────────────
// 四、★ 按轮次的两份记忆（第一版协议踩过的坑）
// ─────────────────────────────────────────────────────────────

test('★ 见到这一轮的第一帧 → `fromStart` 为真，`startSeq` 是换轮那一刻的水位线', () => {
  // 前提：上一轮看完了（水位线 30），然后新一轮的第一批帧从 31 开始 —— 正好接上。
  let c = watchTurn(emptyCursor(), 's1', 'turn-0', 30)
  c = observeBatch(c, batch('e1', 's1', 31, [text(31, '新'), text(33, '轮')], 40, 'turn-1')).cursor

  const w = c.turns['s1']!
  assert.equal(w.turnId, 'turn-1')
  assert.equal(w.startSeq, 30, '换轮那一刻的水位线就是这一轮的起点（= 主进程的 retainedFrom）')
  assert.equal(w.fromStart, true, 'fromSeq 31 落在 startSeq+1 上 ⇒ 从头看起')
})

test('★★ 同一轮的后续批次**不许**把 `fromStart` 翻掉（这条错了界面会静默停更）', () => {
  // 「每次拿 fromSeq 现算」看着更简单，其实是错的：第二批的 fromSeq 是 41，
  // 而 `41 <= 30 + 1` 是假 —— 于是第一个 delta 之后，这一轮就再也不建缓冲了，
  // 而界面上的表现是「流了几行就停住」，不报错。
  let c = watchTurn(emptyCursor(), 's1', 'turn-0', 30)
  c = observeBatch(c, batch('e1', 's1', 31, [text(31, 'a')], 35, 'turn-1')).cursor
  assert.equal(c.turns['s1']!.fromStart, true, '前提')

  c = observeBatch(c, batch('e1', 's1', 36, [text(36, 'b')], 48, 'turn-1')).cursor
  assert.equal(c.turns['s1']!.fromStart, true, '仍然是同一轮 ⇒ 沿用第一次的判定')
  assert.equal(c.turns['s1']!.startSeq, 30, 'startSeq 也不许被后续批次改写')
})

test('同一轮次的后续批次**原样保留** `turns` 对象（免得下游选择器白抖）', () => {
  const c0 = watchTurn(emptyCursor(), 's1', 'turn-0', 30)
  const c1 = observeBatch(c0, batch('e1', 's1', 31, [text(31, 'a')], 35, 'turn-1')).cursor
  const c2 = observeBatch(c1, batch('e1', 's1', 36, [text(36, 'b')], 48, 'turn-1')).cursor
  assert.equal(c2.turns, c1.turns, '没换轮次就该返回同一个对象')
})

test('★ 换轮次但**没见到开头** → `fromStart` 为假（新进程打开一个已在跑的轮次）', () => {
  // 我们从没见过 s1 的任何一帧，第一批就是 57 号 —— 主进程的 retainedFrom
  // 早就不是 0 了。此时不许建缓冲，退化成历史行（`content_text` 就是这一轮到
  // 目前为止的正文，一个字都不缺）。
  const { cursor } = observeBatch(
    emptyCursor(),
    batch('e1', 's1', 57, [text(57, '半截')], 60, 'turn-9')
  )
  const w = cursor.turns['s1']!
  assert.equal(w.fromStart, false, 'fromSeq 57 不在 startSeq+1 上')
  assert.equal(w.startSeq, 0, 'startSeq 是「换轮那一刻的水位线」，此刻确实是 0（我们什么都还没有）')
})

test('★ 换轮次：`startSeq` 取的是**上一轮结束时**的水位线，不是本轮的第一帧', () => {
  // 两者在这批帧上相等（31 = 30 + 1），但含义不同、且**可以不相等**：
  // 本轮的第一批被合并吃掉几个号时（fromSeq = 33），startSeq 仍然是 30。
  // 拿 fromSeq 当 startSeq 的后果是要不到整轮的开头那几个号。
  let c = watchTurn(emptyCursor(), 's1', 'turn-0', 30)
  c = observeBatch(c, batch('e1', 's1', 33, [text(33, 'a')], 40, 'turn-1')).cursor
  assert.equal(c.turns['s1']!.startSeq, 30)
  assert.equal(c.turns['s1']!.fromStart, false, '33 跳过了 31、32 —— 我们确实没有它们')
})

test('`hasBuffer` 决定问**哪一头**：有缓冲要尾巴，没有要整轮', () => {
  // 有缓冲 → 只能要尾巴。要整轮会把这一轮已应用过的帧**再折一遍**，正文出现两遍。
  // 没有缓冲 → 必须从 startSeq 要起（`frame-buffer` 的不变式：要么从第一帧起，要么不建）。
  let c = watchTurn(emptyCursor(), 's1', 'turn-0', 30)
  c = observeBatch(c, batch('e1', 's1', 31, [text(31, 'a')], 44, 'turn-1')).cursor

  assert.equal(resumePlan(c, 's1', true)!.fromSeq, 44, '有缓冲 ⇒ 我自己的水位线（尾巴）')
  assert.equal(resumePlan(c, 's1', false)!.fromSeq, 30, '没有缓冲 ⇒ 这一轮的起点（整轮）')
})

test('换轮之后 `fromStart` 重算（旧轮次的判定不许跟过来）', () => {
  // 上一轮我们没看到头（fromStart 假），但下一轮的头我们看到了 —— 那就该是真。
  // 反过来也一样。判据只与**当前这一轮的第一批**有关。
  let c = observeBatch(emptyCursor(), batch('e1', 's1', 9, [text(9, '半截')], 20, 'turn-1')).cursor
  assert.equal(c.turns['s1']!.fromStart, false, '前提')

  c = observeBatch(c, batch('e1', 's1', 21, [text(21, '新轮')], 25, 'turn-2')).cursor
  assert.equal(c.turns['s1']!.turnId, 'turn-2')
  assert.equal(c.turns['s1']!.startSeq, 20, '新轮的起点 = 上一轮结束时的水位线')
  assert.equal(c.turns['s1']!.fromStart, true, '这一轮我们从 21 接上，正好是 20+1')
})

// ─────────────────────────────────────────────────────────────
// 五、`matched:false` 的处置
// ─────────────────────────────────────────────────────────────

test('★★ `matched:false` → 删掉**两份**记忆、采纳响应里的纪元、**不重试**', () => {
  // 三种成因（纪元不同 / 水位线超前 / 环里已淘汰）在主进程侧就返回同一个响应，
  // 因为渲染层的动作三者完全一样：丢记忆，整段靠历史渲染。
  // 做成可区分的错误码会诱导渲染层走进「重试」分支 —— 而重试永远推不出正确的水位线。
  let c = watchTurn(emptyCursor(), 's1', 'turn-0', 30)
  c = observeBatch(c, batch('e1', 's1', 31, [text(31, 'a')], 44, 'turn-1')).cursor

  const out = applyResume(c, 's1', { epoch: 'e1', matched: false, frames: [] })

  assert.equal(out.accepted, false)
  assert.equal(out.cursor.watermarks['s1'], undefined, '水位线必须被**删掉**，不是设成某个数')
  assert.ok(!('s1' in out.cursor.watermarks), '连键都不该留 —— 留着就会在下次 resumePlan 里复活')
  assert.ok(
    !('s1' in out.cursor.turns),
    '轮次记忆也要删：它的 startSeq 正是这次被证伪的那个值'
  )
  // 删干净之后仍然会给一个计划（fromSeq 0）—— 「不知道」是个合法起点，
  // 它的代价（matched:false 一次）远小于「不敢问」的代价（界面永远冻着）。
  assert.equal(resumePlan(out.cursor, 's1', false)!.fromSeq, 0)

  // 别的 session 不受牵连：作废是**按 session** 的。
  const two = observeBatch(c, batch('e1', 's2', 1, [text(1, 'x')], 7)).cursor
  const out2 = applyResume(two, 's1', { epoch: 'e1', matched: false, frames: [] })
  assert.equal(out2.cursor.watermarks['s2'], 7, '作废一个 session 不该影响另一个')
  assert.ok(out2.cursor.turns['s2'] !== undefined, '轮次记忆同理')
})

test('`matched:false` 时采纳响应里的纪元（它就是主进程**当前**那个）', () => {
  const { cursor } = learnEpoch(emptyCursor(), 'e1')
  const out = applyResume(cursor, 's1', { epoch: 'e2', matched: false, frames: [] })
  assert.equal(out.cursor.epoch, 'e2')
})

// ─────────────────────────────────────────────────────────────
// 六、`matched:true`
// ─────────────────────────────────────────────────────────────

test('重放成功但一帧都没有：水位线**不动**（那是「离开期间它没产出」，不是失败）', () => {
  const { cursor } = observeBatch(emptyCursor(), batch('e1', 's1', 1, [text(1, 'a')], 20))
  const out = applyResume(cursor, 's1', { epoch: 'e1', matched: true, frames: [] })
  assert.equal(out.accepted, true)
  assert.equal(out.cursor.watermarks['s1'], 20, '没有新帧就该保持原值')
})

test('重放成功带帧：水位线推到末帧的 seq，轮次记忆保留', () => {
  const { cursor } = observeBatch(emptyCursor(), batch('e1', 's1', 1, [text(1, 'a')], 20))
  const out = applyResume(cursor, 's1', {
    epoch: 'e1',
    matched: true,
    frames: [text(21, '尾'), text(24, '巴')]
  })
  assert.equal(out.accepted, true)
  assert.equal(out.cursor.watermarks['s1'], 24)
  assert.equal(out.cursor.turns, cursor.turns, '重放回来的帧属于同一轮 ⇒ 轮次记忆不动')
})

test('重放回来的帧比水位线还旧也不许把水位线拉回去', () => {
  const { cursor } = observeBatch(emptyCursor(), batch('e1', 's1', 1, [text(1, 'a')], 20))
  const out = applyResume(cursor, 's1', { epoch: 'e1', matched: true, frames: [text(5, '旧')] })
  assert.equal(out.cursor.watermarks['s1'], 20)
})

test('`maxFrameSeq([])` 是 `null`，**不是 0**', () => {
  // 0 会伪装成一个合法水位线，于是 `resumePlan` 会拿它去要整轮 →
  // 而 `0 < retainedFrom` 恒成立（除非是第一轮）→ matched:false。
  // 「没有帧」和「水位线是 0」是两件事。
  assert.equal(maxFrameSeq([]), null)
  assert.equal(maxFrameSeq([text(3, 'a'), text(9, 'b'), text(4, 'c')]), 9)
})

// ─────────────────────────────────────────────────────────────
// 七、一次完整的「切走 → 切回」
// ─────────────────────────────────────────────────────────────

test('★★ 全程：看着它跑 → 切走 → 切回 → 补上尾巴，水位线正确推进', () => {
  let c = emptyCursor()

  // 1. 进空间，开始看。前两批实时帧（toSeq 10、21 —— 中间被合并吃掉了一些号）。
  c = observeBatch(c, batch('e1', 's1', 1, [text(1, '你'), text(3, '好')], 10)).cursor
  c = observeBatch(c, batch('e1', 's1', 11, [text(12, '，我')], 21)).cursor
  assert.equal(c.watermarks['s1'], 21)
  assert.equal(c.turns['s1']!.fromStart, true, '我们从第一帧看起')

  // 2. 切走。期间的批次被主进程抑制（渲染层根本收不到），水位线停在 21。

  // 3. 切回：手里**还留着**这一轮的缓冲 ⇒ 只能要尾巴，用**自己的** 21 去要。
  //    （要整轮会把这轮已经折过的帧再折一遍，正文出现两遍。）
  const plan = resumePlan(c, 's1', true)
  assert.ok(plan)
  assert.equal(plan.fromSeq, 21, '要的是我离开时那个位置')

  // 4. 主进程把 21 之后的全给我 —— 重放与实时帧不可区分，因为环里存的是线上原样。
  const out = applyResume(c, 's1', {
    epoch: 'e1',
    matched: true,
    frames: [text(22, '在'), text(23, '改文件')]
  })
  assert.equal(out.accepted, true)
  assert.equal(out.cursor.watermarks['s1'], 23, '水位线跟着推到重放的末尾')

  // 5. 之后实时接着来，fromSeq 严格大于上一批的 toSeq（不是 +1）。
  c = observeBatch(out.cursor, batch('e1', 's1', 24, [text(25, '完成')], 31)).cursor
  assert.equal(c.watermarks['s1'], 31)
  assert.equal(c.turns['s1']!.fromStart, true, '整段看下来，始终没丢开头')
})

test('★★ 全程之二：手里没有缓冲 → 改要**整轮**，而不是尾巴', () => {
  // 与上一条的唯一差别是 `hasBuffer`，而它决定的是**问哪一头**：
  // 没有缓冲时不许从尾巴接（`frame-buffer` 的不变式），只能从这一轮的起点要起。
  // 要尾巴在这里的后果不是「少一段」，而是那段**接不到任何东西上** —— 它会被丢掉。
  let c = watchTurn(emptyCursor(), 's1', 'turn-0', 10) // 第一轮到 10 看完
  c = observeBatch(c, batch('e1', 's1', 11, [text(11, '新'), text(13, '轮')], 21, 'turn-1')).cursor
  assert.equal(c.turns['s1']!.startSeq, 10, '前提：这一轮的起点是 10')

  const plan = resumePlan(c, 's1', false)
  assert.ok(plan)
  assert.equal(plan.fromSeq, 10, '整轮 ⇒ 从这一轮的起点（10）要起，不是从我现在的 21')
})

// ─────────────────────────────────────────────────────────────
// `planBatch` —— 收到一批帧之后该做哪几件事
// ─────────────────────────────────────────────────────────────

test('★★ 纪元刚学到时：清的是**旧缓冲**，这一批的帧照样收', () => {
  // 这条是 M6b 真机走查用一次真实损失换来的。第一版把两件事揉成一句
  // 「纪元变了 → 丢缓冲、这一批也丢」，而 `batch.epoch` 正是刚被学到的那个
  // —— 这一批的帧属于**新**纪元，丢它没有任何依据。
  //
  // 代价：**进程启动后的第一批帧永远走这一支**（纪元的第一个消息就是学它），
  // 于是每次开应用，那一轮回答的开头都缺一段。走查量到的形状是
  // 「DOM 45 字 / 帧 66 字」，缺的正是模型说的第一句。
  //
  // ⚠️ 表面上这条断言只是 `useFrames === true`（一个恒真字段）。它的价值在于
  //    **名字**：谁要把 `resetBuffers` 与 `useFrames` 合回一句话，这里当场红。
  const plan = planBatch(undefined, 'turn-1', false, true)
  assert.equal(plan.resetBuffers, true, '旧纪元的缓冲一个都不留')
  assert.equal(plan.useFrames, true, '★ 但这一批是新纪元的帧，照收')
})

test('★ 「没见到这一轮的第一帧」→ 不许**新建**缓冲（已有的照常追加）', () => {
  // `fromStart` 为假 = 我们是从中间接上的。缓冲一旦存在就会抑制历史行
  // （`live.ts` 那条不变式），于是界面只剩半截 —— 而半截看起来像一个
  // **完整的、只是很短的**回答。退化成历史行才是对的（`content_text` 是全文）。
  const midJoin = { turnId: 'turn-1', startSeq: 30, fromStart: false }
  assert.equal(planBatch(midJoin, 'turn-1', false, false).createBuffer, false, '没缓冲 → 别建')
  assert.equal(
    planBatch(midJoin, 'turn-1', true, false).createBuffer,
    true,
    '★ 手里已经有缓冲 → 照常追加（中途切走又切回来的那一支）'
  )
  // 别人的轮次不归这条管：`watch` 记的是**当前这一轮**。
  assert.equal(planBatch(midJoin, 'turn-9', false, false).createBuffer, true)
  assert.equal(
    planBatch({ turnId: 'turn-1', startSeq: 30, fromStart: true }, 'turn-1', false, false)
      .createBuffer,
    true,
    '从头看着的那一轮不受影响'
  )
})
