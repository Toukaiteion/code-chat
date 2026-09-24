/**
 * M7c 验证之二：`src/main/process/compaction.ts` —— 压缩的**执行**。
 *
 * 判决在 `domain/compaction-service.ts`（那个文件有自己的用例）。这里验的是落地，
 * 而这一块的落地**恰好全是库层面的事实** —— 所以台子是真的：
 * 真库（`openStore(':memory:')`）、真 repository、真事务。被替换的只有边界之外的两件
 * （诊断的来源、notice 的去向）。
 *
 * 每一条断言对着一种「错了不报错」的长相：
 *
 * 1. **本轮触发消息不许被折进去**（★★）。它的样子是「模型在自己的请求里读到
 *    『我请求过什么』的转述」，而那条请求还在它眼前 —— 上下文里出现了一个循环引用，
 *    而库里一切正常。
 * 2. **水位线与逐条标记必须同事务**（★）。只落一半的样子是「既不在历史里、
 *    也不在摘要里」—— 一段历史凭空消失，而两处各自看起来都自洽。
 * 3. **被明确排除的消息不许进摘要**（★）。摘要文本**就是**提示词内容 ——
 *    折进去就是把排除悄悄撤销，不报错。
 * 4. **摘要必须累积**。第二次压缩丢掉上一轮，最早那段历史就静默消失。
 * 5. **撞读取上限时不许假装压到底**。假装的样子同样是「既不在历史里也不在摘要里」。
 * 6. **压缩绝不许抛**（★★）。它跑在 `runner.run()` 的同步尾段，抛出去的后果是
 *    压缩**从此再也不会发生**。
 *
 * 风格照本仓库约定：平铺 `test()`、无 `describe`，第三参写「为什么这个相等是判决」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../../src/main/persist/index.ts'
import type { Store } from '../../src/main/persist/index.ts'
import { createCompaction, type Compaction } from '../../src/main/process/compaction.ts'
import type { AgentDiagnostic } from '../../src/main/adapters/agent-adapter.ts'
import type { PushOf } from '../../src/shared/ipc/contract.ts'
import type { Message, Turn } from '../../src/shared/entities.ts'

const NOW = 1_700_000_000_000
const WS = 'w1'
const SESSION = 's1'
const MEMBER = 'm1'
const ACTOR = 'a1'

interface Rig {
  store: Store
  compaction: Compaction
  notices: Array<PushOf<'app:notice'>>
  warns: Array<{ tag: string; message: string; detail?: unknown }>
  /** 这次要不要让 `setCompaction` 抛（验「同事务」与「绝不抛」）。 */
  failSetCompaction: { on: boolean }
  /** 写一条历史消息（本会话）。 */
  say(text: string, at?: number): Message
  /** 造一轮：一条触发消息 + 一条轮次 + 一条 assistant 回复。 */
  turnWith(input: {
    triggerText: string
    reply?: string
    hopDepth?: number
    diags?: readonly AgentDiagnostic[]
  }): Turn
  /** 某会话里 `role:'system'` 的行。 */
  systemLines(): Message[]
  tagsOf(): string[]
}

function rig(): Rig {
  const store = openStore(':memory:')
  store.repos.workspace.create({ id: WS, name: 'Nova', now: NOW })
  store.repos.actor.create({
    id: ACTOR,
    name: 'Atlas',
    model: 'deepseek-flash',
    personaPath: 'atlas.md',
    personaHash: 'h',
    now: NOW
  })
  store.repos.member.create({
    id: MEMBER,
    workspaceId: WS,
    actorId: ACTOR,
    displayName: 'Atlas',
    now: NOW
  })
  store.repos.session.create(SESSION, WS, MEMBER, NOW)

  const notices: Rig['notices'] = []
  const warns: Rig['warns'] = []
  const diagsByTurn = new Map<string, readonly AgentDiagnostic[]>()
  const failSetCompaction = { on: false }
  let n = 0
  /**
   * ★ 消息 id 用**自己的**计数器。共用一个的话 `h-1` 之类的字面量会随着
   * `nextNow`/`newId` 的开销而错位 —— 而错位的样子是 `get()` 返回 `null`
   * （或者 `setInjectMode` 静默什么都不改），于是断言验的是一个不存在的世界。
   * 所以本文件里一律**拿返回的对象**，不写 id 字面量。
   */
  let said = 0
  const nextNow = (): number => NOW + ++n * 10

  const compaction = createCompaction({
    store: {
      tx: (fn) => store.tx(fn),
      session: {
        get: (id) => store.repos.session.get(id),
        setCompaction: (id, throughSeq, summary) => {
          if (failSetCompaction.on) throw new Error('模拟写入失败')
          return store.repos.session.setCompaction(id, throughSeq, summary)
        }
      },
      member: { get: (id) => store.repos.member.get(id) },
      actor: { get: (id) => store.repos.actor.get(id) },
      message: {
        get: (id) => store.repos.message.get(id),
        append: (input) => store.repos.message.append(input),
        lastSeqBefore: (sessionId, beforeSeq) =>
          store.repos.message.lastSeqBefore(sessionId, beforeSeq),
        listBySessionBetween: (sessionId, afterSeq, beforeSeq, limit) =>
          store.repos.message.listBySessionBetween(sessionId, afterSeq, beforeSeq, limit),
        markCompactedBySession: (sessionId, throughSeq, summary) =>
          store.repos.message.markCompactedBySession(sessionId, throughSeq, summary),
        toolNamesOf: (messageId) => store.repos.message.toolNamesOf(messageId)
      }
    },
    diagnosticsOf: (_kind, turnId) => diagsByTurn.get(turnId) ?? [],
    emitNotice: (notice) => notices.push(notice),
    // ★ 走查用 N=2 才不用造 20 条历史；生产默认值由 `compaction-service` 自己的用例守。
    limits: { compactAtCount: 2 },
    now: nextNow,
    newId: () => `x-${++n}`,
    onWarn: (tag, message, detail) => warns.push({ tag, message, detail })
  })

  function say(text: string, at?: number): Message {
    return store.repos.message.append({
      id: `h-${++said}`,
      workspaceId: WS,
      sessionId: SESSION,
      role: 'assistant',
      authorMemberId: MEMBER,
      contentText: text,
      now: at ?? nextNow()
    })
  }

  function turnWith(input: Parameters<Rig['turnWith']>[0]): Turn {
    const trigger = store.repos.message.append({
      id: `t-${++n}`,
      workspaceId: WS,
      sessionId: SESSION,
      role: 'user',
      contentText: input.triggerText,
      now: nextNow()
    })
    const turn = store.repos.turn.create({
      id: `turn-${++n}`,
      sessionId: SESSION,
      workspaceId: WS,
      triggerMessageId: trigger.id,
      hopDepth: input.hopDepth ?? 0,
      cwd: 'G:/work/mine',
      now: nextNow()
    })
    store.repos.turn.markRunning(turn.id, nextNow())
    store.repos.turn.finish(turn.id, 'done', {}, nextNow(), 0)
    store.repos.message.append({
      id: `r-${++n}`,
      workspaceId: WS,
      sessionId: SESSION,
      turnId: turn.id,
      role: 'assistant',
      authorMemberId: MEMBER,
      contentText: input.reply ?? '答',
      now: nextNow()
    })
    if (input.diags) diagsByTurn.set(turn.id, input.diags)
    return store.repos.turn.get(turn.id)!
  }

  return {
    store,
    compaction,
    notices,
    warns,
    failSetCompaction,
    say,
    turnWith,
    systemLines: () =>
      store.repos.message
        .listRecentBySession(SESSION, 200)
        .filter((m) => m.role === 'system'),
    tagsOf: () => warns.map((w) => w.tag)
  }
}

// ─────────────────────────────────────────────────────────────
// ★★ 区间：右端绝不含本轮
// ─────────────────────────────────────────────────────────────

test('★★ 折进去的是「本轮之前」：触发消息仍然是 full，也不在摘要里', () => {
  const r = rig()
  const a = r.say('第一句')
  const b = r.say('第二句')
  const c = r.say('第三句')
  const turn = r.turnWith({ triggerText: '请继续' })

  r.compaction.onTurnFinished(turn)

  const session = r.store.repos.session.get(SESSION)!
  assert.equal(session.compactedThroughSeq, c.seq, '水位线止于触发消息的前一条')
  assert.equal(
    r.store.repos.message.get(turn.triggerMessageId!)!.injectMode,
    'full',
    '把本轮的请求折进摘要，模型就会在自己的请求里读到它的转述'
  )
  for (const m of [a, b, c]) {
    assert.equal(r.store.repos.message.get(m.id)!.injectMode, 'summary', `${m.id} 应当被折叠`)
  }

  const summary = session.rollingSummary!
  assert.ok(summary.includes('第一句') && summary.includes('第三句'))
  assert.equal(summary.includes('请继续'), false, '触发消息的正文不许出现在摘要里')

  // 用户看得见的那一行，且它**不属于**任何一轮的产物。
  const lines = r.systemLines()
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.contentText!.includes(`seq ≤ ${c.seq}`))
  assert.equal(lines[0]!.turnId, null, '带上 turnId 会被 `listByTurn` 算成那一轮说的话')
})

// ─────────────────────────────────────────────────────────────
// ★ 事务与「绝不抛」
// ─────────────────────────────────────────────────────────────

test('★★ 写入中途失败：水位线与逐条标记都不落库，而且函数不抛', () => {
  const r = rig()
  const a = r.say('甲')
  const b = r.say('乙')
  const c = r.say('丙')
  const turn = r.turnWith({ triggerText: '继续' })

  r.failSetCompaction.on = true
  // ★ 判决：`runner.run()` 的同步尾段里抛出去 = 压缩从此再也不会发生。
  assert.doesNotThrow(() => r.compaction.onTurnFinished(turn))

  assert.equal(r.store.repos.session.get(SESSION)!.compactedThroughSeq, 0, '水位线一动不能动')
  assert.equal(r.store.repos.session.get(SESSION)!.rollingSummary, null)
  for (const m of [a, b, c]) {
    assert.equal(
      r.store.repos.message.get(m.id)!.injectMode,
      'full',
      '半落库的样子是「既不在历史里也不在摘要里」'
    )
  }
  assert.equal(r.systemLines().length, 0, '失败时不许留下一条说「已压缩」的系统行')
  assert.ok(r.tagsOf().includes('compaction:threw'), '吞掉可以，但必须留下痕迹')
})

test('库不一致（没有触发消息）时不抛，只记一条 warn', () => {
  const r = rig()
  const turn = r.store.repos.turn.create({
    id: 'turn-orphan',
    sessionId: SESSION,
    workspaceId: WS,
    triggerMessageId: null,
    cwd: 'G:/work/mine',
    now: NOW
  })

  assert.doesNotThrow(() => r.compaction.onTurnFinished(turn))
  assert.ok(r.tagsOf().includes('compaction:trigger-missing'))
})

// ─────────────────────────────────────────────────────────────
// ★ 排除与累积
// ─────────────────────────────────────────────────────────────

test('★ 被明确排除的消息不进摘要，且它的状态不许被压缩改写', () => {
  const r = rig()
  r.say('公开的甲')
  const hidden = r.say('被排除的乙')
  r.say('公开的丙')
  const last = r.say('公开的丁')
  assert.ok(
    r.store.repos.message.setInjectMode(hidden.id, 'excluded', null),
    '前置条件：这条确实被标上了（打歪了的话下面的断言验的是另一个世界）'
  )
  const turn = r.turnWith({ triggerText: '继续' })

  r.compaction.onTurnFinished(turn)

  const summary = r.store.repos.session.get(SESSION)!.rollingSummary!
  assert.equal(
    summary.includes('被排除的乙'),
    false,
    '摘要文本就是提示词内容 —— 折进去等于把「排除」悄悄撤销'
  )
  assert.ok(summary.includes('公开的甲'))
  assert.equal(
    r.store.repos.message.get(hidden.id)!.injectMode,
    'excluded',
    '压缩只吞 `full`：把 excluded 改写成 summary 会抹掉一个装配层正在读的状态'
  )
  // 水位线照常越过被排除的那一条（它本来就不注入了）。
  assert.equal(r.store.repos.session.get(SESSION)!.compactedThroughSeq, last.seq)
})

test('★ 第二次压缩把上一轮的摘要带上 —— 最早那段历史不许消失', () => {
  const r = rig()
  r.say('最早的一段')
  r.say('第二段')
  const first = r.turnWith({ triggerText: '第一次继续' })
  r.compaction.onTurnFinished(first)
  const afterFirst = r.store.repos.session.get(SESSION)!.rollingSummary!
  assert.ok(afterFirst.includes('最早的一段'))

  r.say('第三段')
  r.say('第四段')
  const second = r.turnWith({ triggerText: '第二次继续' })
  r.compaction.onTurnFinished(second)

  const afterSecond = r.store.repos.session.get(SESSION)!.rollingSummary!
  assert.ok(
    afterSecond.includes('最早的一段'),
    '第二次折叠丢掉了第一轮 —— 库里水位线一路前进，而摘要里没有它'
  )
  assert.ok(afterSecond.includes('第四段'))
  assert.equal(
    (afterSecond.match(/【已折叠的历史摘要】/g) ?? []).length,
    1,
    '标题只许一条'
  )
})

// ─────────────────────────────────────────────────────────────
// ★ 读取上限
// ─────────────────────────────────────────────────────────────

test('★ 撞上读取上限：只压到读到的那一条，绝不假装压到底', () => {
  const r = rig()
  for (let i = 0; i < 501; i++) r.say(`历史 ${i}`)
  const turn = r.turnWith({ triggerText: '继续' })
  const triggerSeq = r.store.repos.message.get(turn.triggerMessageId!)!.seq
  const lastHistory = r.store.repos.message.lastSeqBefore(SESSION, triggerSeq)!

  r.compaction.onTurnFinished(turn)

  assert.ok(r.tagsOf().includes('compaction:read-capped'))
  assert.ok(
    r.store.repos.session.get(SESSION)!.compactedThroughSeq <= lastHistory,
    '水位线越过没读到的那几条 = 它们既不在历史里也不在摘要里'
  )
  assert.equal(
    r.store.repos.session.get(SESSION)!.compactedThroughSeq,
    lastHistory - 1,
    '恰好读到第 500 条，水位线就推到那里 —— 一条都不许多推'
  )
})

// ─────────────────────────────────────────────────────────────
// 控制状态与「不压时什么都不动」
// ─────────────────────────────────────────────────────────────

test('压缩不碰跳数（§3.3：它压的是对话内容，不是控制状态）', () => {
  const r = rig()
  r.say('甲')
  r.say('乙')
  const turn = r.turnWith({ triggerText: '继续', hopDepth: 3 })

  r.compaction.onTurnFinished(turn)

  assert.equal(r.store.repos.turn.get(turn.id)!.hopDepth, 3, '压缩不得重置跳数')
  assert.ok(r.store.repos.session.get(SESSION)!.compactedThroughSeq > 0, '（这一轮确实压了）')
})

test('没到阈值时一条都不动，但「为什么没压」必须进日志', () => {
  const r = rig()
  r.say('只有一条')
  const turn = r.turnWith({ triggerText: '继续' })

  r.compaction.onTurnFinished(turn)

  assert.equal(r.store.repos.session.get(SESSION)!.compactedThroughSeq, 0)
  assert.equal(r.store.repos.session.get(SESSION)!.rollingSummary, null)
  assert.equal(r.systemLines().length, 0)
  const decided = r.warns.find((w) => w.tag === 'compaction:decided')
  assert.ok(decided, '归档里要能回答「这一轮为什么没压」')
  assert.equal((decided!.detail as { reason: string }).reason, 'below-threshold')
})

// ─────────────────────────────────────────────────────────────
// CLI 的信号
// ─────────────────────────────────────────────────────────────

test('★ 观测到 CLI 自己压缩（boundary）：一条 warning notice + 一条持久行', () => {
  const r = rig()
  r.say('只有一条')
  const turn = r.turnWith({
    triggerText: '继续',
    diags: [{ level: 'info', tag: 'compact-boundary', message: '收到 system:compact_boundary' }]
  })

  r.compaction.onTurnFinished(turn)

  assert.equal(r.notices.length, 1, '这是「我们的估算偏低」的唯一信号，必须让用户看见')
  assert.equal(r.notices[0]!.level, 'warning')
  assert.equal((r.notices[0]!.detail as { tag: string }).tag, 'compact-boundary-seen')
  const lines = r.systemLines()
  assert.equal(lines.length, 1, '一条系统行落库，用户回看时也看得到')
  assert.equal(lines[0]!.turnId, null)
  assert.ok(lines[0]!.contentText!.includes('compact_boundary'))
  assert.ok(r.tagsOf().includes('compaction:cli-signal'), '无论露不露面都要进日志')
})

test('★ CLI 压缩失败的两面：我们本就该压才露面，不该压就不露面', () => {
  const loud = rig()
  loud.say('甲')
  loud.say('乙')
  const loudTurn = loud.turnWith({
    triggerText: '继续',
    diags: [
      { level: 'warn', tag: 'compact-failed', message: 'CLI 压缩失败：too_few_groups' }
    ]
  })
  loud.compaction.onTurnFinished(loudTurn)
  assert.equal(loud.notices.length, 1, '我们觉得该压、CLI 也失败了 ⇒ 上下文即将失控')
  assert.ok(loud.tagsOf().includes('compaction:compacted'), '（这一轮本身也压了）')

  const quiet = rig()
  quiet.say('只有一条')
  const quietTurn = quiet.turnWith({
    triggerText: '继续',
    diags: [
      { level: 'warn', tag: 'compact-failed', message: 'CLI 压缩失败：too_few_groups' }
    ]
  })
  quiet.compaction.onTurnFinished(quietTurn)
  assert.equal(
    quiet.notices.length,
    0,
    '不该压的时候 CLI 报 too_few_groups 是正常的 —— 为它弹警告会训出忽略警告的习惯'
  )
  assert.ok(
    quiet.tagsOf().includes('compaction:cli-signal'),
    '不露给用户不等于丢掉：它仍然要在归档里查得到'
  )
})
