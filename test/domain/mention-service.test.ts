/**
 * M7b 验证之一：`src/main/domain/mention-service.ts`
 * —— §4.5b 的三条熔断 + §3.3 的跳数记账。
 *
 * 这个文件不能省的理由，不是"覆盖一下纯函数"：这三条规则的判决**全是「错了不报错」**
 * 的那一类。判宽了，一圈 agent 互相 @ 到天亮，而账单要第二天才看得见；
 * 判严了，一次真的在推进的来回讨论被掐掉，而**界面上的样子和「它自己停了」一模一样**。
 * 两边都没有异常可看。所以判决必须能被单测钉住（architecture.md §3.1 规则三）。
 *
 * ★ 最要紧的一条断言是**链的判据是跨 session 的**：
 * 计划书 §5.2 逐字写的是「链 = **本 session 内**……hop_depth 连续递增的那一段后缀」，
 * 而按它实现的话熔断**永远不可能触发** —— §3.3 定死跳数沿链全局递增，A↔B 的乒乓
 * 天然跨两个会话（A 那边是 0、2、4，B 那边是 1、3、5），两边各切出一跳。
 * 下面 `chainOf` 那两条用例（正反）就是这件事的可执行版本。
 *
 * ★ 第二条反向对照盯着「广播不设第四个机制」：`fanoutOf` **不因成员数而拒绝**。
 * 日后有人"顺手"加一个上限，这里会红，而红的地方写着原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chainOf,
  dedupeKeyOf,
  fanoutOf,
  hopDepthOf,
  mentionProblemOf,
  parseMentionsBlock,
  pingPongOf,
  relayTextOf,
  replyTextOf,
  resolveMentions,
  stripMentionsBlock,
  USER_INITIATED_HOP_DEPTH,
  WORK_EVENT_KINDS,
  type ChainHop,
  type ChainTurn,
  type QueuedTailEntry
} from '../../src/main/domain/mention-service.ts'
import type { EventKind, Mention, TurnStatus, WorkspaceMember } from '../../src/shared/entities.ts'

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

function member(id: string, displayName: string, enabled = true): WorkspaceMember {
  return {
    id,
    workspaceId: 'ws-1',
    actorId: `actor-${id}`,
    displayName,
    roleDescPath: null,
    roleDescHash: null,
    permissionJson: '{}',
    isRouter: false,
    enabled,
    createdAt: 0,
    updatedAt: 0
  }
}

/** 三个成员：Nyx、Atlas、Echo（Echo 停用）。 */
const NYX = member('m-nyx', 'Nyx')
const ATLAS = member('m-atlas', 'Atlas')
const ECHO = member('m-echo', 'Echo', false)
const MEMBERS = [NYX, ATLAS, ECHO]

function turn(turnId: string, hopDepth: number, status: TurnStatus = 'done'): ChainTurn {
  return { turnId, hopDepth, status }
}

function hop(turnId: string, hopDepth: number, hadWork: boolean): ChainHop {
  return { turnId, hopDepth, hadWork }
}

function to(memberId: string, kind: Mention['kind'] = 'to'): Mention {
  return { memberId, kind }
}

// ─────────────────────────────────────────────────────────────
// 一、`<mentions>` 标记块（决策 2 的落地）
// ─────────────────────────────────────────────────────────────

test('标记块：没有块 → `none`，**不派发**（这是设计里的正常结局，不是错误）', () => {
  const parsed = parseMentionsBlock('我改完了 src/a.ts，请继续。')
  assert.equal(parsed.status, 'none')
  assert.deepEqual(parsed.names, [])
})

test('标记块：逗号分隔、去空白、去重名', () => {
  const parsed = parseMentionsBlock('改完了\n<mentions>Nyx, Atlas ,Nyx</mentions>')
  assert.equal(parsed.status, 'ok')
  assert.deepEqual(parsed.names, ['Nyx', 'Atlas'], '同一个名字写两遍只算一次 —— 派发是按人去重的')
})

test('标记块：中文逗号照样切开（模型常写），但这是**能看见的**宽松，不是静默容错', () => {
  // 协议逐字要求英文逗号；这里切开它，是因为"切不开"的后果是**整条派发静默消失**。
  const parsed = parseMentionsBlock('<mentions>Nyx，Atlas</mentions>')
  assert.deepEqual(parsed.names, ['Nyx', 'Atlas'])
})

test('标记块：空块 → `empty`（写了标签没写名字），与「没写」分开', () => {
  assert.equal(parseMentionsBlock('<mentions></mentions>').status, 'empty')
  assert.equal(parseMentionsBlock('<mentions>  ,  </mentions>').status, 'empty')
})

test('★ 标记块：孤立的开/闭标签 → `malformed`，与「没写」分开', () => {
  // 这两种都要"不派发"，但原因完全不同：一个是模型没打算派，一个是模型写坏了协议。
  // 合成一个状态的话，后者会被当成正常，而它意味着**协议的措辞需要改**。
  assert.equal(parseMentionsBlock('改完了\n<mentions>Nyx').status, 'malformed')
  assert.equal(parseMentionsBlock('改完了\n</mentions>').status, 'malformed')
})

test('★ 标记块：正文里**举例**提到格式时，取的是**最后一个**块', () => {
  // 模型解释协议时会写「格式是 <mentions>Nyx</mentions> 这样」，而真派发行在最后一行。
  // 取第一个就会把「举例说明」当成真派发 —— 那是一种**看起来正常**的错。
  const text = '用法是 <mentions>Echo</mentions> 这样写。\n改完了。\n<mentions>Atlas</mentions>'
  assert.deepEqual(parseMentionsBlock(text).names, ['Atlas'])
})

test('stripMentionsBlock：删掉块本身与它留下的空行', () => {
  const stripped = stripMentionsBlock('我改完了 a.ts。\n\n<mentions>Nyx</mentions>')
  assert.equal(stripped, '我改完了 a.ts。', '块被删掉后不该在正文尾巴上留一串空行')
})

test('replyTextOf：取**最后一条** assistant 消息（解析与转述必须读同一段）', () => {
  const produced = [
    { role: 'assistant', contentText: '先说一句。' },
    { role: 'user', contentText: '（这是转述进来的，不是它说的）' },
    { role: 'assistant', contentText: '这才是回复。' }
  ]
  assert.equal(replyTextOf(produced), '这才是回复。')
})

test('replyTextOf：没有 assistant 消息 → 空串（**不抛**，空回复是合法结局）', () => {
  assert.equal(replyTextOf([{ role: 'user', contentText: '你好' }]), '')
  assert.equal(replyTextOf([]), '')
})

test('WORK_EVENT_KINDS 只有两个：工具调用与文件改动 ——「有新信息」判不了，不装作能判', () => {
  assert.deepEqual([...WORK_EVENT_KINDS], ['tool_start', 'file_diff'])
  const all: EventKind[] = ['thinking', 'text', 'tool_result']
  for (const kind of all) {
    assert.ok(!WORK_EVENT_KINDS.includes(kind), `${kind} 不是"实质工作"的证据`)
  }
})

// ─────────────────────────────────────────────────────────────
// 二、跳数（§3.3）
// ─────────────────────────────────────────────────────────────

test('★ 跳数：用户直接发起的一轮是 0 —— 那个 0 是**语义**（当且仅当用户发起），不是默认值', () => {
  assert.equal(USER_INITIATED_HOP_DEPTH, 0)
  assert.equal(hopDepthOf(USER_INITIATED_HOP_DEPTH), 1, '用户 @ 出去的那一轮是 1 跳')
  assert.equal(hopDepthOf(1), 2)
})

// ─────────────────────────────────────────────────────────────
// 三、链（★ 跨 session，见文件头）
// ─────────────────────────────────────────────────────────────

test('★ 链：A↔B 的乒乓**跨两个会话**，四跳连成一条链 —— 按 session 切的话两边各只有一跳', () => {
  // 库里的形状（`turn.listRecentByQueuedAt` 按 queued_at 升序，跨 session）：
  //   A 的会话：0、2、4   B 的会话：1、3、5
  // 这一串里前面还夹着一段更早的、无关的对话（hop 0 的老轮次），它必须被切掉。
  const workspaceOrder = [
    turn('t-old', 0),
    turn('t-a0', 0),
    turn('t-b1', 1),
    turn('t-a2', 2),
    turn('t-b3', 3)
  ]
  const chain = chainOf(workspaceOrder)
  assert.deepEqual(
    chain.map((t) => t.turnId),
    ['t-a0', 't-b1', 't-a2', 't-b3'],
    '0→1→2→3 逐跳 +1，是一条四跳的链；更早那条同样 0 跳的轮次在 0 跳处断开'
  )

  // ★ 反向对照：**如果**照计划书 §5.2 的「本 session 内」切（这里等价于取隔项），
  // 每一边都只剩一跳 —— 于是 `pingPongOf` 永远数不到 2，熔断永远不触发。
  const onlyA = chainOf(workspaceOrder.filter((_, i) => i % 2 === 0))
  assert.equal(onlyA.length, 1, '按 session 切：A 那边只有一跳 ⇒ 熔断永远不会触发')
})

test('★ 链：用户手动发起的一轮**打断递增**，自己单独成链', () => {
  const chain = chainOf([turn('t-a0', 0), turn('t-b1', 1), turn('t-a2', 2), turn('t-user', 0)])
  assert.deepEqual(
    chain.map((t) => t.turnId),
    ['t-user'],
    '用户插一句话就开了一条新的链 —— 上一段已经空转了两跳，不该算进这一段'
  )
})

test('★ 链：一条还在排队的**兄弟**轮次不把链切开（它对判链不可见，也不占位）', () => {
  // A 派给了 B 和 C 各一轮：B 已经跑完、C 还在队列里，B 那一跳又派回了 A。
  // 库里的顺序是 A0、B1、C1(排队)、A2 —— C 那一条在 B 与 A2 之间，但它不该切断后缀。
  const chain = chainOf([
    turn('t-a0', 0),
    turn('t-b1', 1),
    turn('t-c1', 1, 'queued'),
    turn('t-a2', 2)
  ])
  assert.deepEqual(chain.map((t) => t.turnId), ['t-a0', 't-b1', 't-a2'])
})

test('★ 链：尾部还在排队的跳**不算一跳**（不能把「还没跑的」当成空转）', () => {
  const chain = chainOf([turn('t-a0', 0), turn('t-b1', 1), turn('t-a2', 2, 'queued'), turn('t-b3', 3, 'running')])
  assert.deepEqual(
    chain.map((t) => t.turnId),
    ['t-a0', 't-b1'],
    '刚结束的那一跳才是链尾 —— 它之后新排上的跳还没跑，判不了它有没有实质工作'
  )
})

test('链：已执行的那一段里缺了一级 → 断在那里（漏杀方向，如实记）', () => {
  // 深度 2 的已执行行不在列表里（另一条链上同深度的轮次还没跑完），
  // 于是 0→1→3 接不上。判不出来 ≠ 判错，代价只是这一次不终止。
  const chain = chainOf([turn('t-a0', 0), turn('t-b1', 1), turn('t-a3', 3)])
  assert.deepEqual(chain.map((t) => t.turnId), ['t-a3'])
})

test('链：全是没跑完的轮次 → 空链（不拿"还没跑的跳"当空转）', () => {
  assert.deepEqual(chainOf([turn('t-1', 0, 'queued'), turn('t-2', 1, 'running')]), [])
  assert.deepEqual(chainOf([]), [])
})

// ─────────────────────────────────────────────────────────────
// 四、乒乓熔断（第 1 条）
// ─────────────────────────────────────────────────────────────

test('★ 乒乓：连续 2 跳无实质工作 → 警告（还没到终止）', () => {
  const verdict = pingPongOf([hop('t-a0', 0, true), hop('t-b1', 1, false), hop('t-a2', 2, false)])
  assert.equal(verdict.action, 'warn')
  assert.equal(verdict.emptyHops, 2)
})

test('★ 乒乓：连续 4 跳无实质工作 → 终止该链', () => {
  const hops = [hop('t-a0', 0, false), hop('t-b1', 1, false), hop('t-a2', 2, false), hop('t-b3', 3, false)]
  assert.equal(pingPongOf(hops).action, 'terminate')
})

test('★ 乒乓：中间任一跳有工具调用 → 计数清零（宁可漏杀，不可错杀）', () => {
  // 形状：空转、空转、**真干活**、空转。尾部连续空转只有 1 跳 ⇒ 什么都不做。
  const hops = [hop('t-a0', 0, false), hop('t-b1', 1, false), hop('t-a2', 2, true), hop('t-b3', 3, false)]
  const verdict = pingPongOf(hops)
  assert.equal(verdict.action, 'none')
  assert.equal(verdict.emptyHops, 1, '「清零」在这里不是维护一个计数器，就是数一遍尾部后缀')
})

test('乒乓：3 跳空转**不重复**弹警告（那句话在 2 跳时已经说完了）', () => {
  const hops = [hop('t-a0', 0, false), hop('t-b1', 1, false), hop('t-a2', 2, false)]
  assert.equal(pingPongOf(hops).action, 'none')
})

test('乒乓：终止用 `>=` 兜住 —— 万一某一跳漏了终止，下一跳不能放过去', () => {
  const hops = [0, 1, 2, 3, 4].map((i) => hop(`t-${i}`, i, false))
  assert.equal(pingPongOf(hops).emptyHops, 5)
  assert.equal(pingPongOf(hops).action, 'terminate')
})

test('★ 乒乓：判决说的话里**一个跳数数字都没有**（跳数绝不进提示词）', () => {
  // 这条 `message` 会落成一条 `role:'system'` 的消息正文（`fanout.ts`），
  // 而 `entities.ts` 的 `Turn.hopDepth` 逐字要求跳数「绝不进入提示词上下文」。
  // ⇒ 正文里数不出来数字，数字只在 notes / 推送 detail 里。
  for (const action of [pingPongOf([hop('a', 0, false), hop('b', 1, false)]), pingPongOf([hop('a', 0, false), hop('b', 1, false), hop('c', 2, false), hop('d', 3, false)])]) {
    assert.ok(!/\d/.test(action.message), `这句要落成消息正文，不能带跳数：${action.message}`)
  }
})

// ─────────────────────────────────────────────────────────────
// 五、去重（第 2 条）
// ─────────────────────────────────────────────────────────────

test('去重键：同成员同内容 → 同键；换人或换内容 → 不同键', () => {
  assert.equal(dedupeKeyOf('m-nyx', 'hash-a'), dedupeKeyOf('m-nyx', 'hash-a'))
  assert.notEqual(dedupeKeyOf('m-nyx', 'hash-a'), dedupeKeyOf('m-atlas', 'hash-a'))
  assert.notEqual(dedupeKeyOf('m-nyx', 'hash-a'), dedupeKeyOf('m-nyx', 'hash-b'))
})

test('★ 去重：同一个「人 + 内容」已经排在**尚未执行的尾部** → 不重复派，并记一条 note', () => {
  const tail: QueuedTailEntry[] = [{ memberId: ATLAS.id, dedupeKey: dedupeKeyOf(ATLAS.id, 'hash-1') }]
  const plan = fanoutOf({
    selfMemberId: NYX.id,
    members: MEMBERS,
    wanted: [to(ATLAS.id)],
    queuedTail: tail,
    contentHash: 'hash-1'
  })
  assert.deepEqual(plan.targets, [])
  assert.equal(plan.notes[0]?.tag, 'mention-deduped')
})

test('★ 去重反向对照：同一对出现在**已终结**的轮次里 → 照样派发（尾部才是基准，不是整条历史）', () => {
  // 「已终结」在数据上的样子就是：`turn.listLive()` 里**没有它** ⇒ 尾部为空。
  // 用整条 session 做基准会吃掉「A→B→A 的第二轮复盘」这种正当行为（§4.5b 逐字）。
  const plan = fanoutOf({
    selfMemberId: NYX.id,
    members: MEMBERS,
    wanted: [to(ATLAS.id)],
    queuedTail: [],
    contentHash: 'hash-1'
  })
  assert.deepEqual(
    plan.targets.map((t) => t.memberId),
    [ATLAS.id],
    '上一轮派过、那一轮已经跑完了 ⇒ 这一次是新的一次，必须照派'
  )
})

test('去重只管 `to`：`cc` 不建轮次，也就没有「同一轮被排两次」这件事', () => {
  const tail: QueuedTailEntry[] = [{ memberId: ATLAS.id, dedupeKey: dedupeKeyOf(ATLAS.id, 'hash-1') }]
  const plan = fanoutOf({
    selfMemberId: NYX.id,
    members: MEMBERS,
    wanted: [to(ATLAS.id, 'cc')],
    queuedTail: tail,
    contentHash: 'hash-1'
  })
  assert.deepEqual(plan.targets.map((t) => t.kind), ['cc'])
})

// ─────────────────────────────────────────────────────────────
// 六、验证四条（规则 ①-④）
// ─────────────────────────────────────────────────────────────

test('@ 的四种问题各有各的 note，且**都不是静默丢弃**', () => {
  assert.equal(mentionProblemOf({ memberId: NYX.id, selfMemberId: ATLAS.id, members: MEMBERS }), null)
  assert.equal(
    mentionProblemOf({ memberId: 'm-ghost', selfMemberId: NYX.id, members: MEMBERS })?.tag,
    'mention-not-a-member'
  )
  assert.equal(
    mentionProblemOf({ memberId: ECHO.id, selfMemberId: NYX.id, members: MEMBERS })?.tag,
    'mention-disabled'
  )
  assert.equal(
    mentionProblemOf({ memberId: NYX.id, selfMemberId: NYX.id, members: MEMBERS })?.tag,
    'mention-self'
  )
})

test('★ 扇出：@ 了一个**已停用**的成员 → 只丢这一条，其余照派（不因一条坏 @ 作废整轮）', () => {
  const plan = fanoutOf({
    selfMemberId: NYX.id,
    members: MEMBERS,
    wanted: [to(ECHO.id), to(ATLAS.id)],
    queuedTail: [],
    contentHash: 'h'
  })
  assert.deepEqual(plan.targets.map((t) => t.memberId), [ATLAS.id])
  assert.equal(plan.notes.length, 1, '丢了一条就有一条 note —— agent 已经做完的工作不会因此作废，但也不是没发生')
})

test('扇出：同一个成员被 @ 两遍 → 只派一轮', () => {
  const plan = fanoutOf({
    selfMemberId: NYX.id,
    members: MEMBERS,
    wanted: [to(ATLAS.id), to(ATLAS.id)],
    queuedTail: [],
    contentHash: 'h'
  })
  assert.equal(plan.targets.length, 1)
})

test('★ 广播：`fanoutOf` **不因成员数而拒绝** —— §4.5b 明文说没有第四个机制', () => {
  // 这条是反向对照。真正的闸门是**并发槽位（默认 3）**，不是这里的一个上限。
  // 谁日后"顺手"加一个 maxTargets，这里会红，而红的地方写着原因。
  const many = Array.from({ length: 8 }, (_, i) => member(`m-${i}`, `成员${i}`))
  const plan = fanoutOf({
    selfMemberId: NYX.id,
    members: many,
    wanted: many.map((m) => to(m.id)),
    queuedTail: [],
    contentHash: 'h'
  })
  assert.equal(plan.targets.length, 8, '八个成员就派八条 —— 拦住它们的是调度器的并发槽位')
  assert.deepEqual(plan.notes, [], '不拒绝就不该顺手记一条"太多了"的 note —— 那也是一种机制')
})

// ─────────────────────────────────────────────────────────────
// 七、名字 → 成员（assistant 那条路）
// ─────────────────────────────────────────────────────────────

test('名字解析：精确命中优先', () => {
  const { mentions, notes } = resolveMentions({ names: ['Atlas'], selfMemberId: NYX.id, members: MEMBERS })
  assert.deepEqual(mentions, [to(ATLAS.id)])
  assert.deepEqual(notes, [])
})

test('名字解析：大小写不敏感只在**唯一命中**时用，且记一条 info', () => {
  const { mentions, notes } = resolveMentions({ names: ['atlas'], selfMemberId: NYX.id, members: MEMBERS })
  assert.deepEqual(mentions, [to(ATLAS.id)])
  assert.equal(notes[0]?.tag, 'mention-name-case')
  assert.equal(notes[0]?.level, 'info', '模型的常见偏差，纠正了就行，不必报警')
})

test('★ 名字解析：两个成员只差大小写 → **不猜**，一条 note 说清为什么', () => {
  const twins = [member('m-1', 'Nyx'), member('m-2', 'NYX'), member('m-3', 'Atlas')]
  const { mentions, notes } = resolveMentions({ names: ['nyx'], selfMemberId: 'm-3', members: twins })
  assert.deepEqual(mentions, [], '猜错 = 派给了错的人；判不出来 = 不派发 + 一条 note。后者可恢复')
  assert.equal(notes[0]?.tag, 'mention-ambiguous-name')
})

test('名字解析：本空间没有这个名字 → 不派发 + note（不许"差不多就派给那个"）', () => {
  const { mentions, notes } = resolveMentions({ names: ['Nova'], selfMemberId: NYX.id, members: MEMBERS })
  assert.deepEqual(mentions, [])
  assert.equal(notes[0]?.tag, 'mention-unknown-name')
})

test('名字解析：@ 自己 / @ 已停用 → 各自一条 note，其余名字照常', () => {
  const { mentions, notes } = resolveMentions({
    names: ['Nyx', 'Echo', 'Atlas'],
    selfMemberId: NYX.id,
    members: MEMBERS
  })
  assert.deepEqual(mentions, [to(ATLAS.id)])
  assert.deepEqual(
    notes.map((n) => n.tag).sort(),
    ['mention-disabled', 'mention-self']
  )
})

// ─────────────────────────────────────────────────────────────
// 八、转述正文
// ─────────────────────────────────────────────────────────────

test('★ 转述：`cc` 必须逐字说明「你不需要行动」—— 不写的话，被抄送者会以为自己在被派活', () => {
  const text = relayTextOf({ authorName: 'Nyx', kind: 'cc', body: '原话', via: 'reply', stripped: false })
  assert.ok(text.includes('抄送'))
  assert.ok(text.includes('不需要行动'))
  assert.ok(!text.includes('把这件事交给你'))
})

test('转述：`to` 是派活，措辞与 `cc` 不同', () => {
  const text = relayTextOf({ authorName: 'Nyx', kind: 'to', body: '原话', via: 'message', stripped: false })
  assert.ok(text.includes('派发'))
  assert.ok(text.includes('把这件事交给你'))
})

test('★ 转述：原文**逐字**在末尾（搬的是原话，不是摘要、不是改述）', () => {
  const body = '我把 api-server/src/a.ts 的 x 改成了 2，边界情况还没动。'
  const text = relayTextOf({ authorName: 'Nyx', kind: 'to', body, via: 'reply', stripped: true })
  assert.ok(text.endsWith(body), '下游要接的是具体的那件事，任何改述都可能丢掉它')
})

test('转述：删掉了 `<mentions>` 块时要说明（那是派发指令，不是给下游看的）', () => {
  const withStrip = relayTextOf({ authorName: 'Nyx', kind: 'to', body: '原话', via: 'reply', stripped: true })
  const without = relayTextOf({ authorName: 'Nyx', kind: 'to', body: '原话', via: 'reply', stripped: false })
  assert.ok(withStrip.includes('<mentions>'))
  assert.ok(!without.includes('<mentions>'))
})
