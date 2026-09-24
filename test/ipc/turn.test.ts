/**
 * M6a 验证之五：`turn:send` 与 `stream:resume`（IPC 层）。
 *
 * 这两个通道是本轮**唯一**解掉 `defer` 的两个，而它们各自带着一条文档明写的判决：
 *
 * - `turn:send`：§4.3b 写着「**不许返回伪造的 turnId**」—— 回一个假的，UI 会照常
 *   渲染出一条**永远不会运行的轮次**，用户看到「已发送、正在思考」，而实际上什么都没发生。
 *   所以这里断言的是「返回的那个 id 在库里真的有一行」。
 * - `stream:resume`：`epoch` 不匹配时 `matched: false` + 空帧**不是错误**，
 *   而是「你那条水位线作废了」这个事实本身（做成错误码的话，渲染层会走进重试分支，
 *   而重试永远重试不出正确的水位线）。
 *
 * ★ 台子是真的（`harness()`）—— 真调度器、真合批器、真适配器、真子进程：
 * 唯一被换掉的是那个 237MB 的原生二进制（换成吐固定剧本的 Node 脚本）。
 * 这不是洁癖：M6a 的产出**就是**「库里的行、帧的顺序、抑制与重放」，
 * 打桩会把它替掉 —— 于是用例全绿而管道其实没接上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  expectFail,
  expectOk,
  harness,
  makeActor,
  makeMember,
  makeWorkspace,
  type Harness
} from './helpers.ts'
import type { StreamBatch } from '../../src/main/process/event-batcher.ts'
import type { ContextShape } from '../../src/main/domain/context-builder.ts'
import type { MessageEvent, Turn } from '../../src/shared/entities.ts'

/** 与 `helpers.fakeCliLaunch()` 同一个脚本 —— 这里要加旗标，所以显式写一遍路径。 */
const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-claude.cjs', import.meta.url))

/**
 * 假 CLI + 一串**假旗标**（一律 `--fake-` 前缀，与生产的参数不会撞名）。
 *
 * argv 的形状是 `[假旗标…, 生产参数…]` —— 生产参数那一段由 `buildClaudeArgs()` 拼，
 * 与 `claude-adapter.test.ts` 的契约断言共用同一条事实（见 `fake-claude.cjs` 文件头）。
 */
function fakeCli(...flags: string[]): { exe: string; preambleArgs: readonly string[] } {
  return { exe: process.execPath, preambleArgs: [FAKE_CLI, ...flags] }
}

interface Scene {
  h: Harness
  workspaceId: string
  memberId: string
  sessionId: string
}

/** 建一个「已经在看这个空间」的可发消息场景。 */
async function scene(opts: Parameters<typeof harness>[0] = {}): Promise<Scene> {
  const h = harness(opts)
  const workspaceId = await makeWorkspace(h)
  const actorId = await makeActor(h)
  const { memberId, sessionId } = await makeMember(h, workspaceId, actorId)
  // ★ 先声明「我在看这个空间」。不声明的话合批器会把每一批都判成跨空间并**抑制**它 ——
  // 那是 §4.3 的正确行为，只是会让下面的断言看到 0 个批次（而原因与被验的东西无关）。
  await h.call('view:setActive', { workspaceId, sessionId })
  h.transport.sent.length = 0 // 清掉 `view:setActive` 自己可能带来的推送
  return { h, workspaceId, memberId, sessionId }
}

function batches(h: Harness): StreamBatch[] {
  return h.transport.sent
    .filter((s) => s.channel === 'stream:batch')
    .map((s) => s.payload as StreamBatch)
}

function frames(h: Harness): StreamBatch['frames'] {
  return batches(h).flatMap((b) => b.frames)
}

function userMessage(h: Harness, workspaceId: string): { id: string; contentText: string } {
  const rows = h.store.db
    .prepare(`SELECT id, content_text FROM message WHERE workspace_id = ? AND role = 'user'`)
    .all(workspaceId) as Array<{ id: string; content_text: string | null }>
  const row = rows[0]
  assert.ok(row, '用户消息必须落库')
  return { id: row.id, contentText: row.content_text ?? '' }
}

/** 这一轮的 assistant 消息（`turn_id` 指向它）。 */
function assistantMessage(h: Harness, turnId: string): { id: string; contentText: string } | null {
  const row = h.store.db
    .prepare(`SELECT id, content_text FROM message WHERE turn_id = ?`)
    .get(turnId) as { id: string; content_text: string | null } | undefined
  return row ? { id: row.id, contentText: row.content_text ?? '' } : null
}

function eventsOf(h: Harness, messageId: string): MessageEvent[] {
  return h.store.repos.message.listEvents(messageId)
}

// ─────────────────────────────────────────────────────────────
// 一、`turn:send` 返回的是**真实的**轮次
// ─────────────────────────────────────────────────────────────

test('★ `turn:send` 返回的 turnId 在库里真的有一行（§4.3b：不许伪造）', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const res = await h.call('turn:send', { workspaceId, memberId, text: '你好' })
  const { turnId } = expectOk<{ turnId: string }>(res)

  const row = h.store.repos.turn.get(turnId)
  assert.ok(row, '★ 回一个库里没有的 id，就是「永远不会运行的轮次」')
  assert.equal(row.workspaceId, workspaceId)
  assert.equal(row.hopDepth, 0, '用户直接发起 = 0；`@` 派出去的那些才是 1 跳往上（§3.3，M7b 起）')
  assert.equal(row.cwd.length > 0, true, 'cwd 是 NOT NULL，必须已经算好')

  const msg = userMessage(h, workspaceId)
  assert.equal(row.triggerMessageId, msg.id, '★ 轮次指回那条用户消息 —— 这个环是单向且原子的')
  await h.runtime.idle()
})

test('用户消息真的落库，正文逐字，角色是 user', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  await h.call('turn:send', { workspaceId, memberId, text: '把 x 改成 y' })
  const msg = userMessage(h, workspaceId)
  assert.equal(msg.contentText, '把 x 改成 y')
  await h.runtime.idle()
})

test('消息与轮次**在同一个事务里** —— 不会出现「消息在、轮次不在」', async () => {
  // 分开写的表现是最难查的一种：用户看到了自己发的消息，而它永远不会被回答，
  // 且没有任何地方解释为什么。
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: '一起写进去' })
  )
  const msg = userMessage(h, workspaceId)
  const row = h.store.repos.turn.get(turnId)
  assert.ok(msg && row)
  assert.equal(msg.id, row.triggerMessageId, '两行必须互指 —— 一条在另一条不在是不可能的')
  await h.runtime.idle()
})

test('cwd 走的是 runtime 的三级兜底（没有项目 → scratch/）', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: 'x' })
  )
  const cwd = h.store.repos.turn.get(turnId)?.cwd ?? ''
  assert.match(cwd, /scratch$/, '无主项目的角色靠第三级才发得出去（§8.5b 用户故事 2）')
  await h.runtime.idle()
})

test('成员不属于该空间 → E_INVALID_PAYLOAD（带上下文，便于排查）', async () => {
  const { h, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const other = await makeWorkspace(h, 'Orion')
  const err = expectFail(await h.call('turn:send', { workspaceId: other, memberId, text: 'x' }))
  assert.equal(err.code, 'E_INVALID_PAYLOAD')
})

test('成员已停用 → E_CONFLICT（不是 E_NOT_FOUND：它存在，只是发不出去）', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  h.store.repos.member.setEnabled(memberId, false, h.ctx.now())
  const err = expectFail(await h.call('turn:send', { workspaceId, memberId, text: 'x' }))
  assert.equal(err.code, 'E_CONFLICT')
})

test('不存在的成员 → E_NOT_FOUND', async () => {
  const { h, workspaceId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const err = expectFail(await h.call('turn:send', { workspaceId, memberId: '查无此人', text: 'x' }))
  assert.equal(err.code, 'E_NOT_FOUND')
})

test('空文本被 schema 拦下（`text` 有 min(1)）', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const err = expectFail(await h.call('turn:send', { workspaceId, memberId, text: '' }))
  assert.equal(err.code, 'E_INVALID_PAYLOAD')
})

// ─────────────────────────────────────────────────────────────
// 二、`queued` 真的落库（用「同一 session 串行」把那一瞬间拉长）
// ─────────────────────────────────────────────────────────────

test('★ 同一 session 的第二轮**真的停在库里是 `queued`**，且排队是可查的', async () => {
  // 这一条必须用**慢**剧本：`queued` 的寿命只有「事务提交 → 派发」之间的那一瞬，
  // 快到从 IPC 外面根本看不见。让第一轮跑得够慢，才把那个状态**变成可观察的**。
  const { h, workspaceId, memberId, sessionId } = await scene({
    cliLaunch: fakeCli('--fake-scenario=truncated-result', '--fake-delay=250')
  })

  const first = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: '第一轮' })
  )
  // 第一轮还没跑完（剧本每行隔 250ms），所以这一轮必然排不上。
  const second = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: '第二轮' })
  )

  assert.equal(h.store.repos.turn.get(first.turnId)?.status, 'running')
  assert.equal(
    h.store.repos.turn.get(second.turnId)?.status,
    'queued',
    '★ 排队是**持久**的事实 —— 硬杀重启后它还在（§4.5）'
  )

  const live = expectOk<{ liveTurns: Turn[]; queueDepth: number; slots: { used: number } }>(
    await h.call('runtime:getState')
  )
  assert.equal(live.queueDepth, 1, '★ `queueDepth` 是库里的诚实值')

  const listed = expectOk<Turn[]>(await h.call('turn:listLive'))
  assert.ok(
    listed.some((t) => t.id === second.turnId && t.sessionId === sessionId),
    '侧边栏要能列出排队项 —— 它靠的正是这个通道，不是 `turn:list`'
  )

  await h.runtime.idle()
})

// ─────────────────────────────────────────────────────────────
// 三、整条管道零成本跑通（真 spawn、真 NDJSON、真落库）
// ─────────────────────────────────────────────────────────────

test('★★ 一轮真剧本走完整条管道：帧到渲染层、行到库里、正文完整', async () => {
  const { h, workspaceId, memberId } = await scene({
    cliLaunch: fakeCli('--fake-scenario=normal', '--fake-delta-count=3')
  })
  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: '修一下空指针' })
  )
  await h.runtime.idle()

  // ── 帧这一侧 ──
  const bs = batches(h)
  assert.ok(bs.length > 0, '★ 一批都没到，说明抑制/接线断了（而这是 M6a 的产出本身）')
  const fs = frames(h)
  const seqs = fs.map((f) => f.seq)
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    '帧 seq 必须严格递增 —— 渲染层拿它当水位线'
  )
  assert.equal(new Set(seqs).size, seqs.length, '同一个号不许出现两次')

  // 相邻 text 增量被**拼接**（3 个 delta → 一帧），且保留首个 seq。
  const textFrame = fs.find((f) => f.k === 'text')
  assert.ok(textFrame && textFrame.k === 'text')
  assert.equal(textFrame.d, '我来修这个空指针。', '★ 三段增量必须拼回整句')

  // 工具调用与它的 diff。
  assert.ok(fs.some((f) => f.k === 'tool_start' && f.name === 'Edit'))
  const diff = fs.find((f) => f.k === 'file_diff')
  assert.ok(diff && diff.k === 'file_diff', '★ Edit 成功必须产出 file_diff（§8.9-17 的所有者）')
  assert.equal(diff.path, 'a.ts')
  assert.equal(diff.patch, ['-x.y', '+x?.y'].join('\n'))

  // usage 的三个新字段（§4.3 补记 ③）。
  const usage = fs.find((f) => f.k === 'usage')
  assert.ok(usage && usage.k === 'usage')
  assert.equal(usage.cacheRead, 8901)
  assert.equal(usage.cacheCreation, 234)
  assert.equal(usage.thinkingTokens, 42, '上报值优先（§4.6a 规则二）')

  const doneFrame = fs.find((f) => f.k === 'done')
  assert.ok(doneFrame && doneFrame.k === 'done')
  assert.equal(doneFrame.reason, 'complete')

  // ── 库这一侧（历史重放读的就是它） ──
  const msg = assistantMessage(h, turnId)
  assert.ok(msg)
  const kinds = eventsOf(h, msg.id).map((e) => e.kind)
  for (const k of ['thinking', 'text', 'tool_start', 'tool_result', 'file_diff', 'usage', 'done']) {
    assert.ok(kinds.includes(k as never), `事件行里必须有 ${k}（实际：${kinds.join(',')}）`)
  }
  const textRows = eventsOf(h, msg.id).filter((e) => e.kind === 'text')
  assert.equal(
    textRows.map((e) => e.textBlob ?? '').join(''),
    msg.contentText,
    '★ 正文与 text 事件必须同源（另拼一遍会造出两个可能分歧的正文）'
  )

  const row = h.store.repos.turn.get(turnId)
  assert.equal(row?.status, 'done')
  assert.equal(row?.terminalReason, 'complete')
  assert.equal(row?.tokensIn, 1234)
  assert.equal(row?.tokensOut, 567)
})

test('★ 批次载荷带 epoch / 空间 / 会话 / 轮次 / 角色，且 `toSeq` 是会话高位', async () => {
  const { h, workspaceId, memberId, sessionId } = await scene({
    cliLaunch: fakeCli('--fake-scenario=normal')
  })
  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: 'x' })
  )
  await h.runtime.idle()

  const b = batches(h)[0]
  assert.ok(b)
  assert.equal(b.v, 1)
  assert.equal(b.workspaceId, workspaceId)
  assert.equal(b.sessionId, sessionId)
  assert.equal(b.turnId, turnId)
  assert.equal(b.epoch, h.runtime.epoch, '★ 随批次下发的纪元必须是主进程当前那个')
  assert.ok(b.toSeq >= (b.frames.at(-1)?.seq ?? 0), '★ toSeq 是会话计数器的高位，不是最后一帧的号')
})

// ─────────────────────────────────────────────────────────────
// 四、抑制与未读（跨空间）
// ─────────────────────────────────────────────────────────────

test('★ 非活跃空间的轮次：一批都不推，但**帧照落库**，未读记在一个轮次上', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=normal') })
  const other = await makeWorkspace(h, 'Orion')
  // 用户切走了 —— 合批器出站时会比对 `ActiveView`。
  await h.call('view:setActive', { workspaceId: other, sessionId: null })
  h.transport.sent.length = 0

  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: '在别的空间里跑' })
  )
  await h.runtime.idle()

  assert.deepEqual(batches(h), [], '★ 用户没在看，一个字节都不该推过去')
  const unread = h.transport.sent.filter((s) => s.channel === 'workspace:unread')
  assert.equal(unread.length >= 1, true, '未读要告诉他「那边有动静」')
  assert.deepEqual(
    unread.at(-1)?.payload,
    { workspaceId, count: 1 },
    '★ 未读的单位是**一个轮次**，不是一批帧（§4.7 的裁定）'
  )

  // 而库里一个字都不少 —— 抑制只影响推送。
  const msg = assistantMessage(h, turnId)
  assert.ok(msg, '★ 帧已经落库，抑制没有损失')
  assert.ok(eventsOf(h, msg.id).some((e) => e.kind === 'text'))
})

test('切回该空间 → 未读清零，且清零是立即的', async () => {
  const { h, workspaceId, memberId, sessionId } = await scene({
    cliLaunch: fakeCli('--fake-scenario=normal')
  })
  const other = await makeWorkspace(h, 'Orion')
  await h.call('view:setActive', { workspaceId: other, sessionId: null })
  await h.call('turn:send', { workspaceId, memberId, text: 'x' })
  await h.runtime.idle()

  await h.call('view:setActive', { workspaceId, sessionId })
  const unread = h.transport.sent.filter((s) => s.channel === 'workspace:unread')
  assert.deepEqual(unread.at(-1)?.payload, { workspaceId, count: 0 })
})

// ─────────────────────────────────────────────────────────────
// 五、`stream:resume`
// ─────────────────────────────────────────────────────────────

test('★ `stream:resume` 同纪元 → `matched: true` 并回放在途帧', async () => {
  const { h, workspaceId, memberId, sessionId } = await scene({
    cliLaunch: fakeCli('--fake-scenario=normal')
  })
  await h.call('turn:send', { workspaceId, memberId, text: 'x' })
  await h.runtime.idle()

  const res = expectOk<{ epoch: string; matched: boolean; frames: unknown[] }>(
    await h.call('stream:resume', { sessionId, epoch: h.runtime.epoch, fromSeq: 0 })
  )
  assert.equal(res.matched, true)
  assert.equal(res.epoch, h.runtime.epoch)
  assert.ok(res.frames.length > 0, '★ 轮次结束不等于尾巴没了 —— 环在 beginTurn 清，不在 endTurn')
})

test('★ 纪元不匹配 → `matched: false` + 空帧，**不是错误**（渲染层据此整段重跑）', async () => {
  const { h, sessionId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const res = expectOk<{ epoch: string; matched: boolean; frames: unknown[] }>(
    await h.call('stream:resume', { sessionId, epoch: '上一进程的纪元', fromSeq: 0 })
  )
  assert.equal(res.matched, false)
  assert.deepEqual(res.frames, [])
  assert.equal(res.epoch, h.runtime.epoch, '★ 响应里给的是**主进程当前**的纪元，渲染层换上它就好')
})

test('`fromSeq` 超前（不属于本进程的编号）→ 同样是 `matched: false`', async () => {
  const { h, sessionId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const res = expectOk<{ matched: boolean; frames: unknown[] }>(
    await h.call('stream:resume', { sessionId, epoch: h.runtime.epoch, fromSeq: 9999 })
  )
  assert.equal(res.matched, false, '★ 让渲染层回去重跑，而不是拿着一个永远滤掉新帧的水位线')
  assert.deepEqual(res.frames, [])
})

test('`stream:resume` 的载荷缺字段 → zod 拦下（不静默当成 0）', async () => {
  const { h, sessionId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const err = expectFail(await h.call('stream:resume', { sessionId, epoch: h.runtime.epoch }))
  assert.equal(err.code, 'E_INVALID_PAYLOAD')
})

// ─────────────────────────────────────────────────────────────
// 六、终态与失败（`turn:stop` 对 running 仍然是 M9）
// ─────────────────────────────────────────────────────────────

test('★ `turn:stop` 停一个排队中的轮次：真的停掉（不用杀进程）', async () => {
  const { h, workspaceId, memberId } = await scene({
    cliLaunch: fakeCli('--fake-scenario=truncated-result', '--fake-delay=250')
  })
  expectOk(await h.call('turn:send', { workspaceId, memberId, text: '第一轮' }))
  const second = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: '第二轮' })
  )
  assert.equal(h.store.repos.turn.get(second.turnId)?.status, 'queued')

  const stopped = expectOk<Turn>(await h.call('turn:stop', { turnId: second.turnId }))
  assert.equal(stopped.status, 'cancelled')
  // ★ 内存队列也要一致 —— 否则 `dispatchable` 会多报一个数（库与内存各一半才叫堵上）。
  const st = expectOk<{ queueDepth: number }>(await h.call('runtime:getState'))
  assert.equal(st.queueDepth, 0)

  await h.runtime.idle()
})

test('`turn:stop` 对一个**运行中**的轮次仍然是 M9 的 `E_NOT_IMPLEMENTED`（不许谎报成功）', async () => {
  const { h, workspaceId, memberId } = await scene({
    cliLaunch: fakeCli('--fake-scenario=truncated-result', '--fake-delay=250')
  })
  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: 'x' })
  )
  assert.equal(h.store.repos.turn.get(turnId)?.status, 'running')
  const err = expectFail(await h.call('turn:stop', { turnId }))
  assert.equal(err.code, 'E_NOT_IMPLEMENTED', '谎报成功 = UI 说已停止，而那个进程还在改用户的文件')
  await h.runtime.idle()
})

test('`turn:stop` 一个已结束的轮次 → E_CONFLICT（不许抹掉真实结局）', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: 'x' })
  )
  await h.runtime.idle()
  const err = expectFail(await h.call('turn:stop', { turnId }))
  assert.equal(err.code, 'E_CONFLICT')
  assert.equal(h.store.repos.turn.get(turnId)?.status, 'done', '结局必须原样留着')
})

test('非零退出 + 没有终态行 → 轮次如实失败，且原因写在用户看得见的地方', async () => {
  const { h, workspaceId, memberId } = await scene({
    cliLaunch: fakeCli('--fake-scenario=exit-nonzero')
  })
  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: 'x' })
  )
  await h.runtime.idle()

  const row = h.store.repos.turn.get(turnId)
  assert.equal(row?.status, 'failed')
  assert.equal(row?.terminalReason, 'crashed')
  assert.ok((row?.errorText ?? '').length > 0, '★ 失败必须有一句人话 —— 光一个 failed 什么都不解释')
})

test('脚本一行都不吐（正常退出）→ 状态是终态，不许停在 running', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', { workspaceId, memberId, text: 'x' })
  )
  await h.runtime.idle()
  const row = h.store.repos.turn.get(turnId)
  assert.ok(['done', 'failed'].includes(row?.status ?? ''), `实际 ${row?.status} —— 停在 running 就是一条僵尸`)
})

// ─────────────────────────────────────────────────────────────
// 七、M7b：`turn:send` 的结构化 `@`（§5.1 的跳 3-5 + 用户侧的扇出）
// ─────────────────────────────────────────────────────────────

/** 再拉一个成员进同一个空间（`@` 要有第二个人才验得动）。 */
async function addMember(
  h: Harness,
  workspaceId: string,
  name: string
): Promise<{ memberId: string; sessionId: string }> {
  const actorId = await makeActor(h, name)
  return makeMember(h, workspaceId, actorId, name)
}

test('★★ 用户 `@` 另一个成员 → 对方会话收到一条转述消息，且多了一条 1 跳的轮次', async () => {
  // 这是 M7b 在 IPC 层唯一一条端到端：渲染层采集的结构化 mention 从
  // `turn:send` 进来 → handler 校验 → `runtime.fanoutUserMentions` → `process/fanout`
  // → 对方的会话与轮次。真调度器、真适配器、真合批器，只换了那个原生二进制。
  const { h, workspaceId, memberId, sessionId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const nyx = await addMember(h, workspaceId, 'Nyx')

  const { turnId } = expectOk<{ turnId: string }>(
    await h.call('turn:send', {
      workspaceId,
      memberId,
      text: '这块归你，@Nyx 接着看。',
      mentions: [{ memberId: nyx.memberId, kind: 'to' }]
    })
  )

  const target = h.store.repos.turn.listBySession(nyx.sessionId).at(-1)
  assert.ok(target, '★ A 的一条消息能派出 B 的一轮 —— M7b 的核心那条')
  assert.equal(target.hopDepth, 1, '用户直接发起是 0，它 @ 出去的是 1（§3.3）')
  assert.notEqual(target.id, turnId)

  const relay = target.triggerMessageId ? h.store.repos.message.get(target.triggerMessageId) : null
  assert.equal(relay?.role, 'user')
  assert.equal(relay?.sessionId, nyx.sessionId, '★ 搬的是**对方的**会话')
  assert.equal(relay?.authorMemberId, memberId, '署名是发话的人')
  assert.ok(relay?.contentText?.includes('接着看'), '搬的是原话')
  assert.ok(relay?.contentText?.includes('在刚发的那条消息里'), '`via: message` —— 下游要知道这话是从哪来的')
  assert.deepEqual(relay?.mentions, [{ memberId: nyx.memberId, kind: 'to' }])

  // 自己这一轮不受影响。
  assert.equal(h.store.repos.turn.get(turnId)?.hopDepth, 0)
  assert.equal(h.store.repos.turn.get(turnId)?.sessionId, sessionId)
  await h.runtime.idle()
})

test('不带 `mentions` → 一个轮次都不多建（反向对照）', async () => {
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const nyx = await addMember(h, workspaceId, 'Nyx')
  await h.call('turn:send', { workspaceId, memberId, text: '我自己看着办。' })
  await h.runtime.idle()

  assert.deepEqual(
    h.store.repos.turn.listBySession(nyx.sessionId),
    [],
    '没有 `mentions` 就没有扇出 —— 运行时不解析正文里的 `@`（§3.1）'
  )
})

test('★ `@` 的目标无效（自己 / 不存在 / 已停用）→ `E_INVALID_PAYLOAD`，**不静默丢弃**', async () => {
  // 四种判据（存在 / 同空间 / enabled / 不是自己）只有一份实现，
  // 而 IPC 这条路的失败语义是**整条消息发不出去**：用户当场就能改。
  // 静默丢掉一个他明确点的人，是界面在说谎。
  const { h, workspaceId, memberId } = await scene({ cliLaunch: fakeCli('--fake-scenario=empty') })
  const nyx = await addMember(h, workspaceId, 'Nyx')

  for (const [label, mentions] of [
    ['自己', [{ memberId, kind: 'to' as const }]],
    ['不存在', [{ memberId: '查无此人', kind: 'to' as const }]],
    ['已停用', [{ memberId: nyx.memberId, kind: 'to' as const }]]
  ] as const) {
    if (label === '已停用') h.store.repos.member.setEnabled(nyx.memberId, false, h.ctx.now())
    const err = expectFail(
      await h.call('turn:send', { workspaceId, memberId, text: 'x', mentions: [...mentions] })
    )
    assert.equal(err.code, 'E_INVALID_PAYLOAD', `${label}：应当整条拒绝`)
    assert.ok(err.message.includes('@ 的目标无效'), `${label}：错误要说人话，实际「${err.message}」`)
  }

  assert.equal(
    h.store.db.prepare(`SELECT COUNT(*) AS n FROM turn WHERE workspace_id = ?`).get(workspaceId)?.['n'],
    0,
    '★ 校验失败时**什么都不该发生** —— 连自己那一轮也不许建'
  )
  await h.runtime.idle()
})

// ─────────────────────────────────────────────────────────────
// 四、历史压缩（M7c）—— 判决 → 落库 → 下一轮装配，整条链
// ─────────────────────────────────────────────────────────────

/**
 * ★★ 一条用例把整条链钉住：跨过阈值的那一轮结束时**真的压了**，
 * 而它的效果在**下一轮**的 `onContextBuilt.shape` 里看得见。
 *
 * 为什么非走端到端不可：`compaction-service` 的用例验的是判决，
 * `process/compaction` 的用例验的是落库 —— 而这两半之间那一段
 * （`runtime.ts` 把 `compaction.onTurnFinished` 接在 `turn-runner` 的收尾上、
 * 在 `batcher.endTurn` **之后**）**没有任何单测能覆盖**。
 * 漏接的样子是：包里一切正常、库里一行没有、界面上一片安静。
 *
 * ★ 阈值走生产的同一条通路（`RuntimeOptions.compactionLimits` ← `CODE_CHAT_COMPACTION_N`），
 * 不是测试专用的后门 —— 所以这一条顺带验了那个旋钮的形状。
 *
 * ★ `historyIncluded` 用**对照台**来判：同一份剧本、同样三轮，
 * 唯一差别是阈值。不这样做的话那个数没法解释 —— 压缩**同时**做两件事
 * （去掉 2 条被折的、加进 1 条【系统】行），单看一边会把净效应当成结论。
 */
test('★★ 端到端：跨过阈值那一轮之后，下一轮的装配里 `<summary>` 在位、被折的历史不在数组里', async () => {
  const shapes = new Map<string, ContextShape>()
  const compacted = await scene({
    cliLaunch: fakeCli('--fake-scenario=normal'),
    compactionLimits: { compactAtCount: 2 },
    onContextBuilt: (turnId, shape) => shapes.set(turnId, shape)
  })

  const turns: string[] = []
  for (const text of ['第一轮', '第二轮', '第三轮']) {
    const { turnId } = expectOk<{ turnId: string }>(
      await compacted.h.call('turn:send', { workspaceId: compacted.workspaceId, memberId: compacted.memberId, text })
    )
    turns.push(turnId)
    await compacted.h.runtime.idle()
  }

  // ① 判决发生在**第二轮**收尾（此时「本轮之前」正好两条），第三轮之前不压。
  const shape1 = shapes.get(turns[0]!)!
  const shape3 = shapes.get(turns[2]!)!
  assert.equal(shape1.compactedThroughSeq, 0, '第一轮之前没有历史可折')
  assert.equal(shape1.summaryChars, 0)
  assert.ok(
    shape3.compactedThroughSeq > 0,
    '★ 跨过阈值那一轮结束时压了 —— 而这一行只有 `runtime.ts` 真把钩子接上了才可能为真'
  )
  assert.ok(
    shape3.summaryChars > 0,
    '★ 水位线前进还不够：<summary> 块必须在**这一轮**的数组里真的拼出来了'
  )

  // ② 库里的事实：摘要非空，且**本轮的触发消息没被折进去**。
  const session = compacted.h.store.repos.session.get(compacted.sessionId)!
  assert.ok(session.rollingSummary?.includes('我来修这个空指针。'), '摘要里要有被折那条的正文')
  assert.equal(
    compacted.h.store.repos.message.get(compacted.h.store.repos.turn.get(turns[2]!)!.triggerMessageId!)!
      .injectMode,
    'full',
    '★ 第三轮的触发消息仍是 full —— 把模型自己的请求折进摘要，它就会读到自己的转述'
  )
  assert.equal(
    compacted.h.store.repos.message.get(compacted.h.store.repos.turn.get(turns[1]!)!.triggerMessageId!)!
      .injectMode,
    'summary',
    '（对照：第二轮的触发消息落在水位线之下，已经被折了）'
  )

  // ③ 对照台：同一个剧本、同样三轮、阈值不触发。
  const controlShapes = new Map<string, ContextShape>()
  const control = await scene({
    cliLaunch: fakeCli('--fake-scenario=normal'),
    onContextBuilt: (turnId, shape) => controlShapes.set(turnId, shape)
  })
  const controlTurns: string[] = []
  for (const text of ['第一轮', '第二轮', '第三轮']) {
    const { turnId } = expectOk<{ turnId: string }>(
      await control.h.call('turn:send', { workspaceId: control.workspaceId, memberId: control.memberId, text })
    )
    controlTurns.push(turnId)
    await control.h.runtime.idle()
  }
  const controlShape3 = controlShapes.get(controlTurns[2]!)!
  assert.equal(controlShape3.compactedThroughSeq, 0, '（对照台必须确实没压 —— 否则下面那对数字不是因果）')
  assert.ok(
    shape3.historyIncluded < controlShape3.historyIncluded,
    `★ 同样的三轮，压过的那一台第三轮数组更短（${shape3.historyIncluded} < ${controlShape3.historyIncluded}）` +
      `—— 「去掉两条被折的、补进一条系统行」的净效应是负的`
  )
})
