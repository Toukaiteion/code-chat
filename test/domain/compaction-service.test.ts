/**
 * M7c 验证之一：`src/main/domain/compaction-service.ts` —— 压缩的判决与摘要的累积。
 *
 * 这个模块的**读侧**是 M7a 建好的（`context-builder` 按水位线一刀切、把
 * `rollingSummary` 包进 `<summary>`）。缺的是写侧，而写侧最容易出的错**全都不报错**：
 *
 * 1. **摘要不累积**（★ 最重的一条）。第二次压缩若丢掉 `prev`，最早那段历史就
 *    **静默消失**：库里 `compacted_through_seq` 一路前进，摘要里却没有它，
 *    模型于是以为那段历史从没发生过。本文件第 1 条断言就是为它写的。
 * 2. **超上限时静默丢中间**。丢了可以，但要**自己说出来** —— 声明行必须在文本里。
 * 3. **条数阈值判成「超过」而不是「达到」**。差一个数会让「N=2 时压不压」这件事
 *    在走查里对不上，而那种对不上看起来像「压缩没生效」。
 * 4. **`throughSeq` 自己重算一遍**。它的所有者是那条 SQL（`seq < triggerSeq`），
 *    本模块只能回显 —— 两处各算一次，早晚不一致，而那种不一致表现为
 *    「某一轮的消息莫名消失」。
 * 5. **CLI 那边的失败信号无条件露面**。`too_few_groups`（没东西可压）是**正常**的，
 *    为它弹警告会训出「忽略警告」的习惯。
 *
 * 风格照本仓库约定：平铺 `test()`、无 `describe`，夹具取真形状（长正文、换行、
 * 多行文本），注释写「为什么这个相等是判决」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendToRollingSummary,
  compactFactsFromDiagnostics,
  interpretCompactResult,
  resolveCompactLimits,
  shouldCompact,
  summaryEntryOf,
  summaryLineOf,
  thresholdOverrideFromEnv,
  COMPACTION_N_ENV,
  COMPACT_READ_LIMIT,
  DEFAULT_COMPACT_LIMITS,
  ENTRY_MAX_CHARS,
  type CompactFacts,
  type SummaryEntry
} from '../../src/main/domain/compaction-service.ts'
import type { HistoryMessage } from '../../src/main/domain/context-builder.ts'
import type { AgentDiagnostic } from '../../src/main/adapters/agent-adapter.ts'
import type { MessageRole } from '../../src/shared/entities.ts'

const SELF = 'm-self'

function msg(
  seq: number,
  text: string,
  extra?: { role?: MessageRole; authorMemberId?: string | null; authorName?: string | null }
): HistoryMessage {
  const role = extra?.role ?? 'assistant'
  // ★ 用 `in` 判而不是 `??` —— `authorName: null` 是**有意义的输入**
  // （作者已被移除），`??` 会把它悄悄换成默认值，于是那条断言测的是默认值。
  const authorMemberId = extra && 'authorMemberId' in extra ? extra.authorMemberId! : 'm-other'
  return {
    id: `msg-${seq}`,
    seq,
    role,
    authorMemberId,
    authorName: extra && 'authorName' in extra ? extra.authorName! : 'Atlas',
    text,
    injectMode: 'full'
  }
}

function entry(seq: number, text: string, tools: readonly string[] = []): SummaryEntry {
  return { seq, label: '【Atlas】', text, tools }
}

/** 一条骨架渲染成一行 —— 大多数断言关心的是「行」，不是结构体。 */
function lines(text: string): string[] {
  return text.split('\n')
}

// ─────────────────────────────────────────────────────────────
// ★★ 累积
// ─────────────────────────────────────────────────────────────

test('第二次折叠把 prev 逐字带上 —— 最早那段历史不许静默消失', () => {
  const first = appendToRollingSummary({
    prev: null,
    entries: [entry(3, '第一段历史，只有这一条'), entry(4, '第二段历史')],
    toSeq: 4,
    maxChars: DEFAULT_COMPACT_LIMITS.summaryMaxChars
  })
  const second = appendToRollingSummary({
    prev: first.text,
    entries: [entry(9, '后来的一条')],
    toSeq: 9,
    maxChars: DEFAULT_COMPACT_LIMITS.summaryMaxChars
  })

  // 第一轮那两条骨架的**整行**必须原样出现在第二轮里。
  // 判据用「整行」而不是「子串」：子串能通过，是因为标题里也有那些字。
  for (const line of lines(first.text).slice(1)) {
    assert.ok(
      lines(second.text).includes(line),
      `第一轮的骨架行没有出现在新摘要里：${JSON.stringify(line)}`
    )
  }
  assert.equal(second.folded, 1)
  assert.equal(second.prevLines, 2)
  assert.equal(second.kept, 3, '保留的骨架行数 = 上一轮 2 条 + 本轮 1 条')
  assert.equal(second.truncated, false)
})

test('标题只有一个：新标题替掉旧标题，不是叠两个', () => {
  const first = appendToRollingSummary({ prev: null, entries: [entry(1, 'a')], toSeq: 1, maxChars: 4000 })
  const second = appendToRollingSummary({ prev: first.text, entries: [entry(2, 'b')], toSeq: 2, maxChars: 4000 })

  const heads = lines(second.text).filter((l) => l.startsWith('【已折叠的历史摘要】'))
  assert.equal(heads.length, 1, '标题行必须恰好一条 —— 两条会让模型读到一个它无法解释的重复')
  assert.ok(heads[0]!.includes('seq ≤ 2'), '新标题要写新的水位线')
})

test('prev 剥不出标题时逐字携带 —— 只丢标签，绝不丢字', () => {
  // 模拟「上一版软件写的摘要」或「有人手工改过 rolling_summary」。
  const weird = '这是我上一轮的摘要，格式不是这一版\n第二行也不能丢'
  const build = appendToRollingSummary({ prev: weird, entries: [entry(9, '新的')], toSeq: 9, maxChars: 4000 })

  assert.equal(build.prevUnparsed, true)
  assert.ok(build.text.includes('这是我上一轮的摘要，格式不是这一版'))
  assert.ok(build.text.includes('第二行也不能丢'))
  assert.equal(build.prevLines, 2)
})

// ─────────────────────────────────────────────────────────────
// ★★ 上限：从中间删，并说出来
// ─────────────────────────────────────────────────────────────

test('超上限时从中间删、首尾都留，并在删除处写一行声明', () => {
  // 每条骨架约 40 字，20 条 ≈ 800 字；上限给 300 ⇒ 必须删掉中间一大段。
  const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, `第${i + 1}条：` + 'x'.repeat(30)))
  const build = appendToRollingSummary({ prev: null, entries, toSeq: 20, maxChars: 300 })

  assert.ok(build.text.length <= 300, `摘要长度 ${build.text.length} 超过了上限 300`)
  assert.equal(build.truncated, true)
  assert.ok(build.droppedCount > 0)

  const ls = lines(build.text)
  assert.ok(ls[0]!.startsWith('【已折叠的历史摘要】'), '第一行永远是标题')
  assert.ok(
    ls.some((l) => l.includes('此处省略了') && l.includes(String(build.droppedCount))),
    '删了多少条必须写在文本里，而且数字要对得上 —— 丢了却不说，就是模型把残缺当完整'
  )
  assert.ok(ls[1]!.startsWith('[1] '), '最早的骨架要留下（开头那段是最早的历史）')
  assert.ok(ls[ls.length - 1]!.startsWith('[20] '), '最新的骨架要留下（结尾那段最靠近现在）')

  // 被删的是中间那些 —— 这一条是「从中间删」与「从头删/从尾删」的分界。
  assert.ok(!ls.some((l) => l.startsWith('[10] ')), '中段的骨架应当被删掉')
})

test('上限小到荒谬时，返回的仍是「标题 + 声明」', () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry(i + 1, 'x'.repeat(50)))
  const build = appendToRollingSummary({ prev: null, entries, toSeq: 5, maxChars: 1 })

  // ★ 声明行**永远不许被删**：一段「什么都没说、却看起来像完整历史」的摘要
  //   比一段残缺的摘要坏得多 —— 后者至少知道自己不全。
  assert.ok(build.text.includes('此处省略了 5 条'))
  assert.equal(build.kept, 0)
  assert.equal(build.droppedCount, 5)
  assert.ok(build.text.startsWith('【已折叠的历史摘要】'))
})

test('没超上限时一条都不删，且长度就是它看起来的那个长度', () => {
  const entries = [entry(1, 'a'), entry(2, 'b'), entry(3, 'c')]
  const build = appendToRollingSummary({ prev: null, entries, toSeq: 3, maxChars: 4000 })
  assert.equal(build.droppedCount, 0)
  assert.equal(build.kept, 3)
  assert.equal(build.truncated, false)
  assert.ok(!build.text.includes('此处省略了'))
  assert.equal(build.text.length, lines(build.text).reduce((a, l, i) => a + l.length + (i > 0 ? 1 : 0), 0))
})

test('同一输入折两次逐字节相同 —— 确定性是这套摘要的立身之本', () => {
  const args = {
    prev: 'x'.repeat(50),
    entries: Array.from({ length: 12 }, (_, i) => entry(i + 1, '正文' + i)),
    toSeq: 12,
    maxChars: 260
  }
  const a = appendToRollingSummary(args)
  const b = appendToRollingSummary(args)
  assert.deepEqual(a, b, '两次结果不同 ⇒ 摘要不可重放，归档里的读数也就不再是证据')
})

test('没有可折的骨架时只有标题一行，不假装有内容', () => {
  const build = appendToRollingSummary({ prev: null, entries: [], toSeq: 7, maxChars: 4000 })
  assert.equal(lines(build.text).length, 1)
  assert.equal(build.kept, 0)
  assert.ok(build.text.includes('seq ≤ 7'))
})

// ─────────────────────────────────────────────────────────────
// 该不该压
// ─────────────────────────────────────────────────────────────

function facts(over: Partial<CompactFacts> = {}): CompactFacts {
  const pending = over.pending ?? [entry(11, 'a'), entry(12, 'b')]
  return {
    waterline: 10,
    triggerSeq: 20,
    lastBeforeTriggerSeq: 19,
    pending,
    // 原文字数（不是骨架长度）—— 见 `CompactFacts.pendingChars` 上的★。
    pendingChars: pending.reduce((a, e) => a + e.text.length, 0),
    readLimit: COMPACT_READ_LIMIT,
    ...over
  }
}

test('条数阈值是「达到」不是「超过」：N-1 不压，N 压', () => {
  const limits = resolveCompactLimits({ compactAtCount: 3 })
  const below = shouldCompact(facts({ pending: [entry(11, 'a'), entry(12, 'b')] }), limits)
  assert.equal(below.compact, false)
  assert.equal(below.reason, 'below-threshold')

  const at = shouldCompact(
    facts({ pending: [entry(11, 'a'), entry(12, 'b'), entry(13, 'c')] }),
    limits
  )
  assert.equal(at.compact, true, '恰好 N 条就该压 —— 判成「超过」会让走查里 N=2 的用例永远不触发')
  assert.equal(at.reason, 'count-threshold')
})

test('字符硬闸能单独触发（条数远不够，但正文很长）', () => {
  // ★ 这个用例守着一个差点写错的量法：字符闸必须量**原文**，不能量骨架行。
  //   骨架被截到 200 字/行，用骨架量的话这个闸永远打不开。
  const limits = resolveCompactLimits({ compactAtCount: 100, compactAtChars: 300 })
  const pending = [entry(11, 'x'.repeat(400))]
  const d = shouldCompact(facts({ pending }), limits)
  assert.equal(d.compact, true)
  assert.equal(d.reason, 'char-ceiling')
})

test('没有可折的东西是正常状态：首轮、或者两轮之间只有被排除的消息', () => {
  assert.equal(shouldCompact(facts({ pending: [] }), DEFAULT_COMPACT_LIMITS).reason, 'nothing-to-fold')
  assert.equal(
    shouldCompact(facts({ lastBeforeTriggerSeq: null }), DEFAULT_COMPACT_LIMITS).reason,
    'nothing-to-fold'
  )
})

test('★ throughSeq 是回显不是重算：库说有洞时以库为准', () => {
  // 处境：seq 13..19 之间那几条被 `excluded` 排除了（不在 pending 里），
  // 而 `seq < 20` 的最大活 seq 是 19。右端的所有者是那条 SQL —— 本模块不许自己算。
  const d = shouldCompact(
    facts({ lastBeforeTriggerSeq: 19, pending: [entry(11, 'a'), entry(12, 'b')] }),
    resolveCompactLimits({ compactAtCount: 2 })
  )
  assert.equal(d.compact, true)
  assert.equal(d.throughSeq, 19, '回显传入的库事实，而不是拿 pending 的最后一条（12）重算一遍')
})

test('否决时回显的是现有水位线（不是 0，也不是 lastBefore）', () => {
  const d = shouldCompact(facts(), resolveCompactLimits({ compactAtCount: 99 }))
  assert.equal(d.compact, false)
  assert.equal(d.throughSeq, 10)
})

test('★ 撞上读取上限时，水位线只推到读到的那一条', () => {
  const limits = resolveCompactLimits({ compactAtCount: 2 })
  const pending = [entry(11, 'a'), entry(12, 'b'), entry(13, 'c')]
  const d = shouldCompact(facts({ pending, readLimit: 3 }), limits)
  assert.equal(d.compact, true)
  assert.equal(d.throughSeq, 13, '假装压到 19 会让 14..19 既不在历史里也不在摘要里')
})

// ─────────────────────────────────────────────────────────────
// CLI 的信号该不该露面
// ─────────────────────────────────────────────────────────────

function ours(compact: boolean) {
  return shouldCompact(
    facts({ pending: compact ? [entry(11, 'a'), entry(12, 'b')] : [] }),
    resolveCompactLimits({ compactAtCount: 2 })
  )
}

test('CLI 自己压了一次（boundary）永远露面 —— 它意味着我们的估算偏低', () => {
  const s = interpretCompactResult(ours(false), {
    boundarySeen: true,
    result: 'none',
    message: null
  })
  assert.equal(s?.tag, 'compact-boundary-seen')
})

test('★ CLI 压缩失败的两面：我们判该压才露面，不判该压就不露面', () => {
  const cli = { boundarySeen: false, result: 'failed' as const, message: 'CLI 压缩失败：too_few_groups' }

  const bad = interpretCompactResult(ours(true), cli)
  assert.equal(bad?.tag, 'compact-cli-failed', '我们觉得该压 + CLI 也失败了 ⇒ 上下文即将失控，必须说')

  const benign = interpretCompactResult(ours(false), cli)
  assert.equal(
    benign,
    null,
    '不该压的时候 CLI 报 too_few_groups 是**正常**的（没东西可压）—— 为它弹警告会训出忽略警告的习惯'
  )
})

test('CLI 的非失败压缩结果不露给用户，但仍然进得了日志', () => {
  assert.equal(
    interpretCompactResult(ours(true), { boundarySeen: false, result: 'other', message: 'CLI 压缩结果 success：ok' }),
    null
  )
  assert.equal(interpretCompactResult(ours(true), { boundarySeen: false, result: 'none', message: null }), null)
})

test('从诊断里读压缩事实：判据是 tag，不解析正文', () => {
  const diags: AgentDiagnostic[] = [
    { level: 'info', tag: 'compact-boundary', message: '收到 system:compact_boundary' },
    { level: 'warn', tag: 'compact-failed', message: 'CLI 压缩失败：too_few_groups' },
    { level: 'info', tag: 'thinking-tokens', message: '（噪声）' }
  ]
  const f = compactFactsFromDiagnostics(diags)
  assert.equal(f.boundarySeen, true)
  assert.equal(f.result, 'failed', '失败优先于其它结果 —— 它是更值得说的那件事')
  assert.equal(f.message, 'CLI 压缩失败：too_few_groups')

  assert.deepEqual(compactFactsFromDiagnostics([]), { boundarySeen: false, result: 'none', message: null })
})

// ─────────────────────────────────────────────────────────────
// 骨架
// ─────────────────────────────────────────────────────────────

test('标签用装配层那一套词：我 / 用户 / 系统 / 作者名', () => {
  const self = 'm-self'
  assert.equal(summaryEntryOf(msg(1, 'x', { authorMemberId: self }), self, [])!.label, '【我】')
  assert.equal(summaryEntryOf(msg(2, 'x', { authorMemberId: null }), self, [])!.label, '【用户】')
  assert.equal(summaryEntryOf(msg(3, 'x', { role: 'system', authorMemberId: null }), self, [])!.label, '【系统】')
  assert.equal(summaryEntryOf(msg(4, 'x', { authorName: 'Nyx' }), self, [])!.label, '【Nyx】')
  // 作者已被移除：不能编一个名字，也不能留空。
  assert.equal(summaryEntryOf(msg(5, 'x', { authorName: null }), self, [])!.label, '【（已移除的成员）】')
})

test('正文拍成单行 —— 一行骨架必须真的是一行', () => {
  const e = summaryEntryOf(msg(1, '第一行\n\n  第二行\t第三行  '), SELF, [])!
  assert.equal(e.text, '第一行 第二行 第三行')
  assert.ok(!e.text.includes('\n'), '带换行的骨架会把「按行累积」的行模型整个弄乱')
})

test('正文空白且没有工具名才折掉；有工具名时留下', () => {
  assert.equal(summaryEntryOf(msg(1, '   \n  '), SELF, []), null)
  const onlyTools = summaryEntryOf(msg(2, '', { authorMemberId: SELF }), SELF, ['Read', 'Grep'])
  assert.ok(onlyTools !== null, '『读了三个文件但一句话没说』是真实发生过的事，丢掉它就是改写历史')
  assert.ok(summaryLineOf(onlyTools).includes('（工具：Read、Grep）'))
})

test('一条 5000 字的正文不许独占整个摘要', () => {
  const e = summaryEntryOf(msg(1, 'x'.repeat(5000)), SELF, [])!
  const line = summaryLineOf(e)
  assert.ok(line.length <= ENTRY_MAX_CHARS, `骨架行 ${line.length} 字，超过上限 ${ENTRY_MAX_CHARS}`)
  assert.ok(line.endsWith('…'), '截断了就要看得出来')
})

test('工具名太长太多时舍工具名、保正文', () => {
  const many = Array.from({ length: 30 }, (_, i) => `some-long-tool-name-${i}`)
  const e = summaryEntryOf(msg(1, '正文只有这几个字'), SELF, many)!
  const line = summaryLineOf(e)
  assert.ok(line.length <= ENTRY_MAX_CHARS)
  assert.ok(!line.includes('工具'), '工具名是装饰，正文才是这条骨架的全部价值')
  assert.ok(line.includes('正文只有这几个字'))
})

// ─────────────────────────────────────────────────────────────
// 环境旋钮
// ─────────────────────────────────────────────────────────────

test('旋钮只收纯十进制正整数', () => {
  assert.equal(thresholdOverrideFromEnv({ [COMPACTION_N_ENV]: '2' }).value, 2)
  assert.equal(thresholdOverrideFromEnv({ [COMPACTION_N_ENV]: '100' }).value, 100)
})

test('★ 非法值返回一个问题而不是静默回退', () => {
  // 静默回退会让「我以为设成了 2」与「实际用的 20」长得一模一样，
  // 而那个差异在走查里只表现为「压缩怎么没触发」。
  for (const bad of ['', '0', '-3', '2.5', 'abc', ' 3 ', '1e3', '0x10', '3条', '9'.repeat(20)]) {
    const r = thresholdOverrideFromEnv({ [COMPACTION_N_ENV]: bad })
    assert.equal(r.value, null, `${JSON.stringify(bad)} 不该被采纳`)
    assert.ok(r.problem !== null, `${JSON.stringify(bad)} 必须带一条问题让调用方去 warn`)
    assert.ok(r.problem!.includes(COMPACTION_N_ENV))
  }
})

test('变量不在时既没有值也没有问题 —— 那不叫错', () => {
  assert.deepEqual(thresholdOverrideFromEnv({}), { value: null, problem: null })
})

test('resolveCompactLimits 只覆盖点名的字段', () => {
  const l = resolveCompactLimits({ compactAtCount: 2 })
  assert.equal(l.compactAtCount, 2)
  assert.equal(l.compactAtChars, DEFAULT_COMPACT_LIMITS.compactAtChars, '没点名的字段不许被重置')
  assert.equal(l.summaryMaxChars, DEFAULT_COMPACT_LIMITS.summaryMaxChars)
  assert.deepEqual(resolveCompactLimits(), DEFAULT_COMPACT_LIMITS)
})
