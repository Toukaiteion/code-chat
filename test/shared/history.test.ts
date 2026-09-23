/**
 * M6b 验证之五：历史事件行 → 缓冲（`src/shared/live/history.ts`）。
 *
 * 这个文件的**头号断言**是最后那一条「等价性」：同一轮对话，从实时帧折出来的缓冲
 * 与从库里的事件行拼出来的缓冲必须**逐字段相同**。
 *
 * 它要挡的分叉是很自然就会发生的：给历史另写一套渲染（「从行拼出思考、工具、diff」）。
 * 分叉之后，同一轮对话在「刚跑完」与「重启后重看」时长得不一样 —— 而且只在
 * 某些字段上不一样（一个渲染了截断标记、另一个没有；一个把 usage 当累加、另一个当覆盖）。
 * 这种错没有任何别的测试能发现。
 *
 * 夹具里的 payload 字面量是**抄自 `event-batcher.ts` 的写入点**，不是编的：
 * `file_diff` 只存 `{path}`（patch 在 `textBlob` 里）、`error` 存 `{code,fatal}`、
 * `usage` 存五个数、`done` 存 `{reason}`、`tool_start` 存 `tool_use.input` 原样。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufferFromEvents, eventToFrame } from '../../src/shared/live/history.ts'
import { applyFrames, type StreamFrame, type TurnBuffer, type TurnIds } from '../../src/shared/live/frame-buffer.ts'
import type { MessageEvent } from '../../src/shared/entities.ts'

const IDS: TurnIds = { turnId: 't1', sessionId: 's1', workspaceId: 'w1', actorId: 'a1' }

/** 造一行事件。只写用得上的字段，其余按 schema 的缺省填。 */
function ev(seq: number, over: Partial<MessageEvent> & Pick<MessageEvent, 'kind'>): MessageEvent {
  return {
    id: seq,
    messageId: 'm1',
    seq,
    toolUseId: null,
    toolName: null,
    payloadJson: null,
    textBlob: null,
    blobPath: null,
    bytes: 0,
    ok: null,
    truncated: false,
    createdAt: 0,
    // `kind` 由 `over` 带进来（它与 `seq` 都要能被覆盖），所以不在这里先写一遍 ——
    // 先写再被展开覆盖是 TS 会直接报错的那种写法。
    ...over
  }
}

test('text / thinking 行 → 对应的 delta 帧', () => {
  assert.deepEqual(eventToFrame(ev(1, { kind: 'text', textBlob: '你好' })), {
    seq: 1,
    k: 'text',
    d: '你好'
  })
  assert.deepEqual(eventToFrame(ev(2, { kind: 'thinking', textBlob: '想' })), {
    seq: 2,
    k: 'thinking',
    d: '想'
  })
})

test('★ `tool_result` 行里的 `truncated` **恒为 false** —— 行存的是全量', () => {
  // 行与帧的 `truncated` 不是同一件事：行回答「到底输出了什么」，帧回答
  // 「这一次推送发了多少」。库里那一列写的是 `false`（`event-batcher` 的写入点），
  // 但即便它是 true，历史上我们拿到的也是完整的那份 —— 标「已截断」会是在说谎。
  const frame = eventToFrame(
    ev(1, { kind: 'tool_result', toolUseId: 'tu1', ok: true, textBlob: '全文', truncated: true })
  )
  assert.ok(frame && frame.k === 'tool_result')
  assert.equal(frame.output, '全文')
  assert.equal(frame.truncated, false)
})

test('★ `tool_result` 的 `ok` 是 `null` 时按**失败**读（未知不许当成成功）', () => {
  // `ok` 是唯一区分「这次调用成了没有」的字段。把它当成功，界面会给一次
  // 可能没成的调用打勾 —— 而用户会据此相信文件已经被改好了。
  const frame = eventToFrame(
    ev(1, { kind: 'tool_result', toolUseId: 'tu1', ok: null, textBlob: 'x' })
  )
  assert.ok(frame && frame.k === 'tool_result')
  assert.equal(frame.ok, false)
})

test('`tool_start` 行 → 帧，`input` 来自 payloadJson 原样', () => {
  const frame = eventToFrame(
    ev(1, {
      kind: 'tool_start',
      toolUseId: 'tu1',
      toolName: 'Edit',
      payloadJson: JSON.stringify({ file_path: 'a.ts' })
    })
  )
  assert.deepEqual(frame, {
    seq: 1,
    k: 'tool_start',
    id: 'tu1',
    name: 'Edit',
    input: { file_path: 'a.ts' }
  })
})

test('`file_diff` 行：patch 来自 textBlob，path 来自 payloadJson', () => {
  const frame = eventToFrame(
    ev(1, {
      kind: 'file_diff',
      toolUseId: 'tu1',
      payloadJson: JSON.stringify({ path: 'src/a.ts' }),
      textBlob: '# 注释\n-旧\n+新'
    })
  )
  assert.deepEqual(frame, { seq: 1, k: 'file_diff', path: 'src/a.ts', patch: '# 注释\n-旧\n+新' })
})

test('★ `file_diff` 缺 path 时**抛**，不编一个', () => {
  // patch 里没有路径信息。编一个「（未知）」会让用户以为它就是当前项目里的某个文件；
  // 抛出去则由 `live` slice 变成一条可读的通知。这与 `persist/row.ts` 对坏 JSON 的态度一致。
  assert.throws(
    () => eventToFrame(ev(1, { kind: 'file_diff', payloadJson: '{}', textBlob: '+x' })),
    /没有 path/
  )
})

test('`usage` 行 → 帧，五个数原样；`costUsd` 缺省时不塞进去', () => {
  const withCost = eventToFrame(
    ev(1, {
      kind: 'usage',
      payloadJson: JSON.stringify({
        in: 10,
        out: 2,
        cacheRead: 3,
        cacheCreation: 0,
        thinkingTokens: 4,
        costUsd: 0.5
      })
    })
  )
  assert.deepEqual(withCost, {
    seq: 1,
    k: 'usage',
    in: 10,
    out: 2,
    cacheRead: 3,
    cacheCreation: 0,
    thinkingTokens: 4,
    costUsd: 0.5
  })

  const noCost = eventToFrame(
    ev(2, {
      kind: 'usage',
      payloadJson: JSON.stringify({ in: 1, out: 1, cacheRead: 0, cacheCreation: 0, thinkingTokens: 0 })
    })
  )
  assert.ok(noCost && noCost.k === 'usage')
  // 键**不在**，而不是 `undefined` —— 与线上帧的形状逐字一致（`deepEqual` 会区分这两者）。
  assert.ok(!('costUsd' in noCost))
})

test('坏 JSON 一律抛，并且报出是哪一条事件', () => {
  assert.throws(
    () => eventToFrame(ev(7, { kind: 'usage', payloadJson: '{坏' })),
    /事件 #7（usage）/
  )
})

test('看不懂的 kind 被跳过（主进程版本更新时才会走到）', () => {
  const frame = eventToFrame({ ...ev(1, { kind: 'text' }), kind: 'telepathy' as never })
  assert.equal(frame, null)
})

test('历史缓冲的推理面板**默认收起**（库里没有 `thinking_end` 这个事实）', () => {
  const buf = bufferFromEvents(IDS, [
    ev(1, { kind: 'thinking', textBlob: '想了一堆' }),
    ev(2, { kind: 'text', textBlob: '结论' })
  ])
  assert.equal(buf.thinking, '想了一堆')
  assert.equal(buf.thinkingOpen, false, '回顾旧消息时收起是对的 —— 内容仍在，只是不占屏')
})

test('空事件列表 → 一个空缓冲（不是 null —— 调用方按它渲染一条空行）', () => {
  const buf = bufferFromEvents(IDS, [])
  assert.equal(buf.text, '')
  assert.equal(buf.items.length, 0)
})

// ─────────────────────────────────────────────────────────────
// ★★ 头号断言：两条来源必须折出**同一个**缓冲
// ─────────────────────────────────────────────────────────────

test('★★ 同一轮：实时帧折出来的缓冲 === 历史行拼出来的缓冲（逐字段）', () => {
  // 这是 `history.ts` 存在的全部理由。左边是 M6b 的新路径（帧），
  // 右边是 M4 就有的旧路径（行）—— 它们必须收敛到同一个渲染态，
  // 否则「刚跑完」和「重启后重看」会给出两个不同的样子。
  //
  // ⚠️ 比较的是**渲染相关的投影**，其中剔掉了 `usage.seq` 这一个字段。
  //    理由不是「它无关紧要」，而是**两边压根不是同一条轴上的数**：实时那边的
  //    `seq` 是每 session 的帧计数器，历史那边的 `seq` 是每消息的 `message_event.seq`
  //    （从 1 重来）。§1.2 已经裁定帧水位线**不落库**，所以历史**原理上**复现不出
  //    帧 seq —— 这不是实现的疏漏，是数据的形状。把它一起比就是在要求一件不存在的事。
  //    下面单独断言了这一点，免得下一个人以为剔掉它是在掩盖什么。
  const frames: StreamFrame[] = [
    { seq: 1, k: 'thinking', d: '先看看 ' },
    { seq: 2, k: 'thinking', d: 'auth.ts' },
    { seq: 3, k: 'thinking_end' },
    { seq: 4, k: 'tool_start', id: 'tu1', name: 'Read', input: { file_path: 'auth.ts' } },
    { seq: 5, k: 'tool_result', id: 'tu1', ok: true, output: '文件内容' },
    { seq: 6, k: 'text', d: '改好了' },
    { seq: 7, k: 'file_diff', path: 'auth.ts', patch: '# replace_all\n-旧\n+新' },
    { seq: 8, k: 'usage', in: 10, out: 2, cacheRead: 0, cacheCreation: 0, thinkingTokens: 1 },
    { seq: 9, k: 'done', reason: 'complete' }
  ]

  // 同一轮，从库里读回来的那一份。注意 `code` 之外的字段名与上面完全不同。
  const rows: MessageEvent[] = [
    ev(1, { kind: 'thinking', textBlob: '先看看 ' }),
    ev(2, { kind: 'thinking', textBlob: 'auth.ts' }),
    // ← 没有「thinking_end」这一行：`EVENT_KINDS` 里没有它，它不落库
    ev(3, {
      kind: 'tool_start',
      toolUseId: 'tu1',
      toolName: 'Read',
      payloadJson: JSON.stringify({ file_path: 'auth.ts' })
    }),
    ev(4, { kind: 'tool_result', toolUseId: 'tu1', ok: true, textBlob: '文件内容' }),
    ev(5, { kind: 'text', textBlob: '改好了' }),
    ev(6, {
      kind: 'file_diff',
      toolUseId: 'tu1',
      payloadJson: JSON.stringify({ path: 'auth.ts' }),
      textBlob: '# replace_all\n-旧\n+新'
    }),
    ev(7, {
      kind: 'usage',
      payloadJson: JSON.stringify({ in: 10, out: 2, cacheRead: 0, cacheCreation: 0, thinkingTokens: 1 })
    }),
    ev(8, { kind: 'done', payloadJson: JSON.stringify({ reason: 'complete' }) })
  ]

  /** 渲染相关的投影：只去掉那条**不属于缓冲的轴**的 `seq`。 */
  const rendered = (b: TurnBuffer) => ({
    ...b,
    // 推理面板的展开态也要归一到「实时那边的样子」—— 见下方断言。
    thinkingOpen: true,
    usage: b.usage === null ? null : { ...b.usage, seq: 0 }
  })

  const live = applyFrames(null, IDS, frames)
  const fromHistory = bufferFromEvents(IDS, rows)
  assert.ok(live)

  assert.deepEqual(
    rendered(fromHistory),
    rendered(live),
    '历史与实时两条路径折算出的渲染态必须逐字段一致'
  )

  // 两条被归一掉的差异，逐一钉住 —— 它们都是**已知且正确**的，不是漏网的。

  // 1) 推理面板的展开态。这个夹具里**两边都收起了**，但成因完全不同：
  //    实时那边是 `thinking_end` 帧真的到了；历史那边是文件头那条统一处置
  //    （`EVENT_KINDS` 里没有 `thinking_end`，它不落库）。它们**碰巧一致**。
  //    下面那条单独的用例钉住「碰巧不一致」的情形 —— 那时候实时是展开的。
  assert.equal(fromHistory.thinkingOpen, false)
  assert.equal(live.thinkingOpen, false)

  // 2) `usage.seq` 在两边来自**不同的轴**，且**将来也不许有人读它**。
  assert.equal(live.usage?.seq, 8, '实时：帧计数器（这批帧里的第 8 帧）')
  assert.equal(fromHistory.usage?.seq, 7, '历史：message_event.seq（第 7 行）')
  // 用具名断言把它钉成「已知事实」而不是「碰巧相等」—— 上面那个 `seq: 0`
  // 归一只在这个前提下才是诚实的。
})

test('★ 上面那条等价性有一处**已知的有损**：这一轮结束在思考中途', () => {
  // 上面那个夹具里两边都收起了，纯属 `thinking_end` 恰好到了。
  // 一轮如果**结束在思考中途**（模型想了很久、然后连接断了 / 被中断），
  // 实时那边的缓冲会停在展开态 —— 用户正看着那段思考，它不该自己合上；
  // 而历史上我们**无从知道**它当时是不是展开的，统一给收起。
  //
  // 于是「刚跑完」与「重启后重看」在这一个字段上真的不一样。这是 `history.ts`
  // 文件头记的那条有损之处在测试里的样子：**内容不丢，只有展开态丢**。
  // 记在这里是为了让下一个人调整 `thinkingOpen` 的初值时能看见它。
  const ids: TurnIds = { ...IDS, turnId: 't2' }
  const live = applyFrames(null, ids, [{ seq: 1, k: 'thinking', d: '想到一半' }])
  const history = bufferFromEvents(ids, [ev(1, { kind: 'thinking', textBlob: '想到一半' })])

  assert.equal(live?.thinking, '想到一半')
  assert.equal(history.thinking, '想到一半', '内容一个字不差')
  assert.equal(live?.thinkingOpen, true, '实时：还在想，面板开着')
  assert.equal(history.thinkingOpen, false, '历史：不知道当时开着没有，按收起给')
})
