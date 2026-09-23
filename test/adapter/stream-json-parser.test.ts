/**
 * M5 验证之一：NDJSON → `AgentEvent`。**这是 M5 的主战场。**
 *
 * 为什么它比别处都重要：这一层的输入是**别人**的输出，而且对方明确会吐坏东西
 * （非 JSON 行、半截 JSON、缺字段的终态行、超长行）。上面所有模块的错都可以靠
 * 类型检查挡掉，只有这里挡不掉 —— 类型检查看不见一条运行时才出现的字符串。
 *
 * 每个用例尽量对准**一条已经发生过的事实**（§2.3 的四个坑、§8.9-12 的超长行、
 * bug #94741），而不是我自己想出来的边界 —— 后者测的是我的想象力，不是这个程序。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LINE_CHARS, createStreamParser } from '../../src/main/adapters/claude/stream-json-parser.ts'
import type { AgentDiagnostic, AgentEvent } from '../../src/main/adapters/agent-adapter.ts'

// ─────────────────────────────────────────────────────────────
// 脚手架
// ─────────────────────────────────────────────────────────────

/** 把若干对象变成一段 NDJSON。 */
function ndjson(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o) + '\n').join('')
}

interface Fed {
  events: AgentEvent[]
  /**
   * 只有 `warn` 级的标签。
   *
   * **断言一律用它，不用全部标签。** 两者是不同的东西：`info` 是**观测**
   * （「终态 subtype 是这个」「碰到压缩边界了」），每轮都会有；`warn` 才是**有东西不对劲**。
   * 拿全部标签去比会把这些用例变成「顺带钉死所有观测点」的脆弱测试 ——
   * 加一个观测点就要改一堆不相干的断言。
   */
  warnTags: string[]
  infoTags: string[]
  /** 原始诊断。有的话断言它更直接（比如要看 `message` 里有没有带上 CLI 的原话）。 */
  diagnostics: readonly AgentDiagnostic[]
}

/** 喂一段（或几段）文本，收齐事件与诊断标签。`chunks` 刻意是数组 —— 切行是重点。 */
function feed(chunks: string[], opts: Parameters<typeof createStreamParser>[0] = {}): Fed {
  const parser = createStreamParser(opts)
  const parserEvents: AgentEvent[] = []
  for (const c of chunks) parserEvents.push(...parser.push(c))
  parserEvents.push(...parser.flush())
  const ds = parser.diagnostics()
  return {
    events: parserEvents,
    warnTags: ds.filter((d) => d.level === 'warn').map((d) => d.tag),
    infoTags: ds.filter((d) => d.level === 'info').map((d) => d.tag),
    diagnostics: ds
  }
}

const of = <K extends AgentEvent['k']>(events: AgentEvent[], k: K): Extract<AgentEvent, { k: K }>[] =>
  events.filter((e): e is Extract<AgentEvent, { k: K }> => e.k === k)

/** 恰好一次 `done`，并把它取出来。顺带断言「恰好一次」—— 那是适配层的核心不变量。 */
function done(events: AgentEvent[]): Extract<AgentEvent, { k: 'done' }> {
  const ds = of(events, 'done')
  assert.equal(ds.length, 1, `done 必须恰好一次，实际 ${ds.length} 次`)
  return ds[0]
}

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'm1',
  cwd: 'G:/w',
  permissionMode: 'default',
  tools: ['Read']
}

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 40,
  output_tokens_details: { thinking_tokens: 5 }
}

const RESULT_OK = { type: 'result', subtype: 'success', is_error: false, result: '好了', usage: USAGE, total_cost_usd: 0.01 }

// ─────────────────────────────────────────────────────────────
// §2.3-1 非 JSON 行
// ─────────────────────────────────────────────────────────────

test('非 JSON 行：跳过 + 诊断，且**绝不**变成 error 事件', () => {
  const { events, warnTags } = feed(['[claude-code:unrecognized_model] {"model":"deepseek-flash"}\n' + ndjson(RESULT_OK)])

  assert.deepEqual(warnTags, ['non-json-line'], '要有一条 warn 诊断，且只有这一条')
  assert.deepEqual(of(events, 'error'), [], '一行噪声不许让 UI 弹「出错了」')
  assert.equal(done(events).reason, 'complete', '噪声之后的终态照常解析')
})

test('非 JSON 行：诊断里留一份截断样本，够定位又不撑爆日志', () => {
  const parser = createStreamParser()
  parser.push('[claude-code:x] ' + 'y'.repeat(5000) + '\n')
  parser.flush()
  const d = parser.diagnostics()[0]
  assert.ok(d.sample, '要留样本')
  assert.ok(d.sample.length <= 240, `样本要截断，实际 ${d.sample.length}`)
})

// ─────────────────────────────────────────────────────────────
// 跨 chunk 切行 —— 字节流不按行边界到达
// ─────────────────────────────────────────────────────────────

test('切行：一行的 JSON 从正中间被切成两个 chunk，仍然解析得出', () => {
  const line = JSON.stringify(RESULT_OK)
  const cut = Math.floor(line.length / 2)
  // 切点**故意落在 JSON 字符串内部**，那里最容易暴露「忘记缓冲尾巴」。
  const { events } = feed([line.slice(0, cut), line.slice(cut) + '\n'])
  assert.equal(done(events).reason, 'complete')
})

test('切行：一个 chunk 里挤了三行，三行都要认出来', () => {
  const { events } = feed([
    ndjson({ type: 'system', subtype: 'status', status: 'a' }, { type: 'system', subtype: 'status', status: 'b' }, RESULT_OK)
  ])
  assert.deepEqual(
    of(events, 'status_changed').map((e) => e.status),
    ['a', 'b']
  )
})

test('最后一行没有换行符：flush 必须把它交出来（终态就在那一行）', () => {
  const { events } = feed([JSON.stringify(RESULT_OK)]) // 刻意**不带** \n
  assert.equal(done(events).reason, 'complete')
})

// ─────────────────────────────────────────────────────────────
// §8.9-12 单行上限
// ─────────────────────────────────────────────────────────────

test('超长行：先攒在 pending 里暴涨的那种，必须放弃该行并继续解析下一行', () => {
  // 这一段没有换行，所以它会一路进 `pending`。上限就是为这条路径设的 ——
  // 没有上限，一个坏掉的 CLI 能把主进程的内存吃光。
  const huge = 'x'.repeat(MAX_LINE_CHARS + 10)
  const { events, warnTags } = feed([huge, '\n' + ndjson(RESULT_OK)])

  assert.deepEqual(warnTags, ['line-too-long'])
  assert.equal(done(events).reason, 'complete', '丢掉坏行之后必须接着解析')
  assert.deepEqual(of(events, 'error'), [])
})

test('超长行：一次到达的那种，同样放弃并继续', () => {
  const { events, warnTags } = feed(['x'.repeat(MAX_LINE_CHARS + 10) + '\n' + ndjson(RESULT_OK)])
  assert.deepEqual(warnTags, ['line-too-long'])
  assert.equal(done(events).reason, 'complete')
})

// ─────────────────────────────────────────────────────────────
// §2.3-2 双份投递 —— 去重
// ─────────────────────────────────────────────────────────────

/** 增量与完整块**都发**的一段（§2.3-2 说这两路会同时到达）。 */
function dualDelivery(): string {
  return ndjson(
    INIT,
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    {
      type: 'assistant',
      message: {
        id: 'm',
        content: [
          { type: 'text', text: '你好' },
          { type: 'tool_use', id: 'tu1', name: 'Edit', input: { a: 1 } }
        ]
      }
    },
    RESULT_OK
  )
}

test('双份投递：文本只出一次（增量说了算，完整块不补发）', () => {
  const { events } = feed([dualDelivery()])
  assert.deepEqual(
    of(events, 'text_delta').map((e) => e.text),
    ['你好'],
    '补发一次就变成「你好你好」'
  )
})

test('双份投递：tool_start 只出一次，且来自**完整块**（增量那边只有半截 JSON）', () => {
  const { events } = feed([dualDelivery()])
  const starts = of(events, 'tool_start')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].id, 'tu1')
  // 输入必须是完整块给的那个，不是把半截 JSON 拼出来的东西。
  assert.deepEqual(starts[0].input, { a: 1 })
})

test('同一 id 的 tool_use 出现两次（重放/重试）也只发一次', () => {
  const line = {
    type: 'assistant',
    message: { id: 'm', content: [{ type: 'tool_use', id: 'dup', name: 'Read', input: {} }] }
  }
  const { events } = feed([ndjson(INIT, line, line, RESULT_OK)])
  assert.equal(of(events, 'tool_start').length, 1)
})

test('兜底：**没有任何增量**时，完整块必须补发，否则整轮静默', () => {
  // 这是「关掉 --include-partial-messages」的形态。没有这条兜底，
  // 一次旗标变更就会让所有轮次一个字都不显示，且**不报任何错**。
  const { events } = feed([
    ndjson(
      INIT,
      { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: '只有完整块' }] } },
      RESULT_OK
    )
  ])
  assert.deepEqual(
    of(events, 'text_delta').map((e) => e.text),
    ['只有完整块']
  )
})

test('input_json_delta / signature_delta 被忽略：不许有人去拼半截 JSON', () => {
  const { events, warnTags } = feed([
    ndjson(
      INIT,
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } },
      RESULT_OK
    )
  ])
  assert.deepEqual(of(events, 'tool_start'), [])
  assert.deepEqual(warnTags, [], '这两类是**认识**的，不是「未处理的类型」，不该报警')
})

// ─────────────────────────────────────────────────────────────
// §2.3-3 permissionMode 报 "default"
// ─────────────────────────────────────────────────────────────

test('permissionMode 报 "default"（--help 里没有这个值）：原样带出，不当非法值', () => {
  const { events } = feed([ndjson(INIT, RESULT_OK)])
  const init = of(events, 'session_started')[0]
  assert.equal(init.permissionMode, 'default')
  assert.equal(init.sessionId, 's1')
  assert.deepEqual(init.tools, ['Read'])
  assert.deepEqual(of(events, 'error'), [])
})

// ─────────────────────────────────────────────────────────────
// §2.3-4 / bug #94741 中断后终态缺字段
// ─────────────────────────────────────────────────────────────

test('#94741：终态行缺 result 字段，仍然给出终态与用量，只记一条诊断', () => {
  const { events, infoTags } = feed([
    ndjson(INIT, { type: 'result', subtype: 'success', is_error: false, usage: USAGE, total_cost_usd: 0.004 })
  ])
  assert.ok(infoTags.includes('result-field-missing'))
  assert.equal(done(events).reason, 'complete')
  assert.equal(of(events, 'usage').length, 1, '缺 result 不影响用量')
})

test('★ subtype 认不出来但 is_error 为假 → complete，**不是** crashed', () => {
  // 这条是被一次真实的失败逼出来的：我原先写的是「不认识就落 crashed」，
  // 而那意味着 CLI 下一个版本新增任何一个**成功**的 subtype，所有正常轮次都会被报成崩溃。
  // `is_error` 是 CLI 自己对成败的明确表态，比我们对 subtype 名字的熟悉程度可靠。
  //
  // 同时验留档：原文必须落进 observations，探针据此把真实取值带回来。
  const parser = createStreamParser()
  // ⚠️ `push()` 的返回值**必须接住**：它内部是 `events.splice(0)`，也就是**取走**。
  // 丢掉返回值等于把那些事件扔了 —— 这个坑我自己刚踩过一次。
  const events = [...parser.push(ndjson(INIT, { type: 'result', subtype: 'some_brand_new_thing', is_error: false })), ...parser.flush()]
  assert.equal(done(events).reason, 'complete')
  assert.equal(parser.observations().resultSubtype, 'some_brand_new_thing')
})

test('终态 subtype 命中预算 → budget', () => {
  // ⚠️ 这个字符串是编的：CLI 实际用哪个 subtype 报超预算**尚未实测**（探针⑦）。
  // 这里验的是**映射规则**（含 budget 即命中），不是「真实 subtype 长这样」。
  const { events } = feed([ndjson(INIT, { type: 'result', subtype: 'error_max_budget_usd', is_error: true })])
  assert.equal(done(events).reason, 'budget')
})

test('is_error 但 subtype 无信息 → crashed', () => {
  const { events } = feed([ndjson(INIT, { type: 'result', subtype: 'whatever', is_error: true })])
  assert.equal(done(events).reason, 'crashed')
})

test('★ aborted 优先于任何上报值：优雅中断的 result 不许被报成 complete', () => {
  // 这是最容易错的一条：阶梯第 1 级成功时 CLI 会**照常吐一条 subtype=success 的终态**，
  // 于是「用户按了停止」会被解析成一个正常的完成。事实只有适配器知道，所以要递进来。
  const { events } = feed([ndjson(INIT, RESULT_OK)], { isAborted: () => true })
  assert.equal(done(events).reason, 'interrupted')
})

test('已知的 subtype 不用等 isAborted 也能认出中断', () => {
  const { events } = feed([ndjson(INIT, { type: 'result', subtype: 'interrupted', is_error: false })])
  assert.equal(done(events).reason, 'interrupted')
})

// ─────────────────────────────────────────────────────────────
// 用量与工具结果
// ─────────────────────────────────────────────────────────────

test('用量带出缓存与思考 token —— §4.6/§5.4 要靠它排查缓存命中', () => {
  const { events } = feed([ndjson(INIT, RESULT_OK)])
  const u = of(events, 'usage')[0]
  assert.equal(u.in, 10)
  assert.equal(u.out, 20)
  assert.equal(u.cacheRead, 30, 'cache_read 必须带出来，否则「缓存从不命中」查不了')
  assert.equal(u.cacheCreation, 40)
  assert.equal(u.thinkingTokens, 5)
  assert.equal(u.costUsd, 0.01)
})

test('用量只在终态行发一次，流事件里那些不重复发（否则同一轮有两个互相矛盾的数）', () => {
  const { events } = feed([
    ndjson(
      INIT,
      {
        type: 'stream_event',
        event: { type: 'message_delta', index: 0, usage: { input_tokens: 999, output_tokens: 999 } }
      },
      RESULT_OK
    )
  ])
  const us = of(events, 'usage')
  assert.equal(us.length, 1)
  assert.equal(us[0].in, 10, '以终态为准，不是流事件里那个')
})

test('工具结果：顶层的 tool_use_result 挂上来，content 是块数组也读得出', () => {
  const { events } = feed([
    ndjson(
      INIT,
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] }]
        },
        tool_use_result: { file: { filePath: 'a.ts' } }
      },
      RESULT_OK
    )
  ])
  const r = of(events, 'tool_result')[0]
  assert.equal(r.id, 'tu1')
  assert.equal(r.ok, true)
  assert.equal(r.output, '第一行\n第二行')
  assert.deepEqual(r.structured, { file: { filePath: 'a.ts' } })
})

test('工具结果失败：is_error 为真 → ok 为假', () => {
  const { events } = feed([
    ndjson(
      INIT,
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '炸了', is_error: true }] } },
      RESULT_OK
    )
  ])
  assert.equal(of(events, 'tool_result')[0].ok, false)
})

// ─────────────────────────────────────────────────────────────
// 思考块
// ─────────────────────────────────────────────────────────────

test('思考：增量出 delta，块结束时出 thinking_end', () => {
  const { events } = feed([
    ndjson(
      INIT,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想想' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      RESULT_OK
    )
  ])
  assert.deepEqual(
    of(events, 'thinking_delta').map((e) => e.text),
    ['想想']
  )
  assert.equal(of(events, 'thinking_end').length, 1)
})

test('思考：字段名是 thinking 而不是 text，两个都得认', () => {
  const { events } = feed([
    ndjson(
      INIT,
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', text: '退化成 text 字段' } } },
      RESULT_OK
    )
  ])
  assert.deepEqual(
    of(events, 'thinking_delta').map((e) => e.text),
    ['退化成 text 字段']
  )
})

test('thinking_end 只对思考块发，文本块的 stop 不发', () => {
  const { events } = feed([
    ndjson(
      INIT,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      RESULT_OK
    )
  ])
  assert.deepEqual(of(events, 'thinking_end'), [])
})

// ─────────────────────────────────────────────────────────────
// 噪声与终态之后
// ─────────────────────────────────────────────────────────────

test('不认识的类型不会变成 error 事件', () => {
  const { events, warnTags } = feed([
    ndjson(INIT, { type: 'totally_unknown_kind', x: 1 }, RESULT_OK)
  ])
  assert.deepEqual(warnTags, ['unknown-line-type'])
  assert.deepEqual(of(events, 'error'), [])
})

test('control_response 是**已知流量**：既不推状态机，也不报警（每次中断都响一下纯属噪声）', () => {
  const { events, warnTags } = feed([
    ndjson(INIT, { type: 'control_response', request_id: 'r1', response: { subtype: 'success' } }, RESULT_OK)
  ])
  assert.deepEqual(of(events, 'error'), [])
  assert.deepEqual(warnTags, [], 'ACK 是可预期的，不该报警')
  assert.equal(done(events).reason, 'complete', 'ACK 不许推进任何状态机')
})

test('终态之后的行一律不再产生事件（进程可能还会吐东西）', () => {
  const { events } = feed([ndjson(INIT, RESULT_OK, { type: 'system', subtype: 'status', status: 'after' })])
  assert.deepEqual(of(events, 'status_changed'), [])
  assert.equal(done(events).reason, 'complete')
})

test('空输入：一个事件都没有，也不会崩', () => {
  const { events } = feed(['', '\n', '   \n'])
  assert.deepEqual(events, [])
})

test('CRLF 行尾照样认（进程在 Windows 上不一定只吐 \\n）', () => {
  const { events } = feed([JSON.stringify(RESULT_OK) + '\r\n'])
  assert.equal(done(events).reason, 'complete')
})

test('system:status 出 status_changed（帧上无处可放，M6 会丢掉它）', () => {
  const { events } = feed([ndjson(INIT, { type: 'system', subtype: 'status', status: 'requesting' }, RESULT_OK)])
  assert.deepEqual(
    of(events, 'status_changed').map((e) => e.status),
    ['requesting']
  )
})

// ─────────────────────────────────────────────────────────────
// 探针⑦ 要的观测数据
// ─────────────────────────────────────────────────────────────

test('观测：ttft_ms / subtype / 增量是否生效 / 有没有碰到压缩边界', () => {
  const parser = createStreamParser()
  parser.push(
    ndjson(
      INIT,
      { type: 'stream_event', ttft_ms: 812, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'result', subtype: 'success', is_error: false }
    )
  )
  parser.flush()
  const obs = parser.observations()
  assert.equal(obs.ttftMs, 812)
  assert.equal(obs.resultSubtype, 'success')
  assert.equal(obs.sawPartialMessages, true)
  assert.equal(obs.sawCompactBoundary, true)
})

test('块轨迹：如实记下交错结构 —— §4.3 补记说实测前不许写死判定逻辑', () => {
  const parser = createStreamParser()
  parser.push(
    ndjson(
      INIT,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use' } } },
      RESULT_OK
    )
  )
  parser.flush()
  assert.deepEqual(
    parser.blockTrace().map((b) => `${b.index}:${b.kind}:${b.source}`),
    ['0:thinking:delta', '1:text:delta', '2:tool_use:delta']
  )
})

// ─────────────────────────────────────────────────────────────
// 探针逼出来的四条（每一条都对着归档里的一行原文）
// ─────────────────────────────────────────────────────────────

test('★ `system:thinking_tokens` 是已知高频流量，**不许**刷警告', () => {
  // 实测：一轮 374 条。我第一版把它算作「未处理的子类型」，于是刷了 374 条警告 ——
  // 那样诊断通道就被淹了，「有一行我不认识」这个信号再也看不见。
  const many = Array.from({ length: 20 }, (_, i) => ({
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: i + 1,
    estimated_tokens_delta: 1
  }))
  const f = feed([ndjson(INIT, ...many, RESULT_OK)])
  assert.deepEqual(f.warnTags, [], '已知流量不许产生警告')
  assert.deepEqual(f.events.map((e) => e.k), ['session_started', 'usage', 'done'])
})

test('★ 上报的 thinking_tokens=0 时，改用 `system:thinking_tokens` 的累计值', () => {
  // 实测逼出来的取法：这个端点上 `output_tokens_details.thinking_tokens` 报的是 **0**，
  // 而那一轮明明有 374 段思考。真正的数字只在流里。
  // 拿 0 覆盖掉一个实测量 = 「渲染了一个假的 0」，正是 §4.6 那条纪律的镜像。
  const f = feed([
    ndjson(
      INIT,
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12 },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 374 },
      { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 0 } } }
    )
  ])
  assert.equal(of(f.events, 'usage')[0].thinkingTokens, 374, '取最后一个累计值，不是第一个')
})

test('上报的 thinking_tokens 大于 0 时，**上报值优先** —— 估算不许盖过实测', () => {
  const f = feed([
    ndjson(
      INIT,
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 374 },
      { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 41 } } }
    )
  ])
  assert.equal(of(f.events, 'usage')[0].thinkingTokens, 41)
})

test('★ `system:permission_denied` 是已知流量，但**要留一条警告**（一轮最多几条）', () => {
  // 实测形状（归档原文）。它不是错误 —— 那一轮照样完成了 —— 但它是
  // 「agent 想伸手到工作目录外面」的唯一信号。M6 再决定它值不值得露给用户。
  const f = feed([
    ndjson(INIT, {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Glob',
      tool_use_id: 'call_00_x',
      decision_reason_type: 'workingDir',
      decision_reason: 'Path is outside allowed working directories',
      message: 'Claude requested permissions to read from G:\other, but you haven\'t granted it yet.'
    }, RESULT_OK)
  ])
  assert.ok(f.warnTags.includes('permission-denied'), '必须留下痕迹，不许静默')
  assert.ok(!f.warnTags.includes('unknown-system-subtype'), '它是认识的东西，不是未知子类型')
  assert.deepEqual(of(f.events, 'error'), [], '被拒一次工具调用**不是**这一轮的失败')
})

test('★ 终态行的 `terminal_reason` 优先于 `subtype` 的猜测', () => {
  // 实测：终态行带 `terminal_reason: "completed"` —— CLI 自己就在说结论，
  // 比我们拿正则猜它的词形可靠一档。
  const f = feed([ndjson(INIT, { type: 'result', subtype: 'whatever_new_word', terminal_reason: 'completed', is_error: false })])
  assert.equal(done(f.events).reason, 'complete', 'terminal_reason 认出来了就用它')
})

test('`terminal_reason` 认不出来时**不猜**，退回 subtype 那条老路', () => {
  const f = feed([ndjson(INIT, { type: 'result', subtype: 'error_max_budget_usd', terminal_reason: 'some_future_word', is_error: true })])
  assert.equal(done(f.events).reason, 'budget', '「我不认识这个词」不等于「它失败了」，所以要继续往下认')
})

test('`aborted` 仍然高于一切上报值 —— 包括 terminal_reason', () => {
  const f = feed([ndjson(INIT, { type: 'result', subtype: 'success', terminal_reason: 'completed', is_error: false })], {
    isAborted: () => true
  })
  assert.equal(done(f.events).reason, 'interrupted', '用户按了停止就是停止，不许被上报值翻案')
})

test('★★ 实测：`subtype:"success"` 而 `is_error:true` —— 终态原因是 crashed，且**失败原因不许被丢掉**', () => {
  // 归档原文（`--only=compact` 那一轮，逐字）：
  //   {"subtype":"success","is_error":true,"result":"Prompt is too long",
  //    "terminal_reason":"blocking_limit","num_turns":1,"duration_ms":119,"modelUsage":{}}
  //
  // 两条结论叠在一行里：
  // ① `subtype` **不能**当成败信号 —— 它说着 success，CLI 自己的 `is_error` 说着失败。
  //   （这正是 `reasonFromResult` 里 `is_error` 排在 subtype 之后的那个顺序被验证的地方。）
  // ② 我解析出了 `result: "Prompt is too long"` 然后把它扔了 —— 于是「为什么失败」
  //   在本进程里一个字都不剩。**计算了但不往下传 = 缺陷**（§4.6 那条纪律的反面）。
  const f = feed([
    ndjson(INIT, {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Prompt is too long',
      terminal_reason: 'blocking_limit',
      num_turns: 1,
      duration_ms: 119
    })
  ])
  assert.equal(done(f.events).reason, 'crashed', 'is_error 是 CLI 自己对成败的表态，压过 subtype 的名字')
  const hit = f.diagnostics.find((d) => d.tag === 'cli-reported-error')
  assert.ok(hit, '失败原因必须留下痕迹')
  assert.equal(hit.level, 'warn')
  assert.match(hit.message, /Prompt is too long/, 'CLI 的原话要原样带上')
})

test('`is_error:true` 但终态行没有 result 文本时，两条诊断都在，且不崩', () => {
  const f = feed([ndjson(INIT, { type: 'result', subtype: 'success', is_error: true })])
  assert.equal(done(f.events).reason, 'crashed')
  assert.ok(f.diagnostics.some((d) => d.tag === 'result-field-missing'), '缺字段还是要记一笔（bug #94741 的形态）')
})

test('★★ `system:status` 的 `status` 可以是 null，那时 payload 是**压缩结果** —— 不许静默丢掉', () => {
  // 归档原文：
  //   {"type":"system","subtype":"status","status":null,
  //    "compact_result":"failed","compact_error":"too_few_groups"}
  // 我第一版对 `status === null` 直接 return —— 一次压缩失败在诊断通道里一个字都没有。
  const f = feed([
    ndjson(
      INIT,
      { type: 'system', subtype: 'status', status: 'requesting' },
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'too_few_groups' },
      RESULT_OK
    )
  ])
  assert.deepEqual(
    of(f.events, 'status_changed').map((e) => e.status),
    ['requesting', 'compacting'],
    'null 那个不发 status 事件 —— 它不是状态，是结果'
  )
  const hit = f.diagnostics.find((d) => d.tag === 'compact-failed')
  assert.ok(hit, '压缩失败必须留下痕迹')
  assert.match(hit.message, /too_few_groups/)
  assert.ok(!f.warnTags.includes('unknown-system-subtype'), 'status 是认识的子类型')
})

test('压缩**成功**时是 info，不是警告 —— 三态不许合并', () => {
  const f = feed([
    ndjson(INIT, { type: 'system', subtype: 'status', status: null, compact_result: 'success' }, RESULT_OK)
  ])
  assert.ok(!f.warnTags.includes('compact-failed'), '成功不该报警')
  assert.ok(f.diagnostics.some((d) => d.tag === 'compact-result'), '但也要留档')
})

// ─────────────────────────────────────────────────────────────
// ★ M6a 回归：`<synthetic>` 与失败原因的终点
//
// 两处的夹具都是 `scripts/evidence/m5-2026-09-23T13-05-15-211Z/compact.ndjson`
// 的**原文**（第 5 行与第 6 行）。证据 → 回归用例，不再花一分钱。
//
// 为什么不能"提一个同形状的"：这两条要证的判据恰好藏在两个字段里 ——
// `model` 的字面量 `"<synthetic>"`，以及终态行的 `subtype:"success"` 与
// `is_error:true` **互相矛盾**这一事实。手搓的行不会不小心带上那个矛盾。
// ─────────────────────────────────────────────────────────────

/** 归档第 5 行，逐字。 */
const ARCHIVE_SYNTHETIC_ASSISTANT = {
  type: 'assistant',
  message: {
    id: 'aba77165-7bcf-4fa7-b9df-3b79a7cdf168',
    model: '<synthetic>',
    role: 'assistant',
    stop_reason: 'stop_sequence',
    type: 'message',
    content: [{ type: 'text', text: 'Prompt is too long' }],
    usage: { input_tokens: 0, output_tokens: 0 }
  },
  parent_tool_use_id: null,
  session_id: '93adecc1-2bc4-4ff7-b82b-3df1dd371bbb',
  uuid: '66cde6f5-4204-43b0-b6d6-98fe1954085e',
  timestamp: '2026-09-23T13:05:16.215Z',
  error: 'invalid_request',
  is_api_error_message: true
}

/** 归档第 6 行，逐字（只留这一轮用得到的字段）。 */
const ARCHIVE_RESULT_BLOCKING = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'Prompt is too long',
  terminal_reason: 'blocking_limit',
  num_turns: 1,
  duration_ms: 119,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, output_tokens_details: { thinking_tokens: 0 } },
  modelUsage: {}
}

test('★★ `<synthetic>` 的正文**绝不**变成模型的话 —— 一条 text 事件都不许有（归档原文）', () => {
  /**
   * 这是 M5 修掉、M6a 必须有回归的一条**真缺陷**：`onAssistant` 的兜底分支
   * （整轮没见过增量时由完整块补发文本）把 CLI 自己的报错当成了模型说的话。
   *
   * 判决标准不是"代码里有个 if" ——而是**事件流里没有 text_delta**。
   * 断言看事件、不看实现，因为它要防的正是有人在别处再补一条路径把它放出来。
   */
  const f = feed([ndjson(INIT, ARCHIVE_SYNTHETIC_ASSISTANT, ARCHIVE_RESULT_BLOCKING)])

  assert.deepEqual(of(f.events, 'text_delta'), [], '★ 用户看到的必须是「这一轮失败了」，不是「模型说了句报错」')
  assert.ok(f.warnTags.includes('synthetic-assistant'), '判据是 `model === "<synthetic>"`，要有迹可循')
  const hit = f.diagnostics.find((d) => d.tag === 'synthetic-assistant')
  assert.match(hit?.message ?? '', /Prompt is too long/, '正文不丢弃 —— 它要交回失败路径')
})

test('★ `is_error` 的正文必须变成一条 `error` 事件（M6a 补上的终点）', () => {
  /**
   * M5 把这句 `result` 解析出来、记了一条诊断、**然后扔了**。诊断不落库
   * （`EVENT_KINDS` 里没有这一类），所以进程一重启，那句话就一个字都不剩 ——
   * 用户只能看到「这一轮 crashed」，而"为什么"没了。
   *
   * M6a 的终点是 `message_event.kind='error'` + `turn.error_text`（后者由 runner 写）。
   * 这里验前半段：**事件流里有一条带原文的 error**。
   */
  const f = feed([ndjson(INIT, ARCHIVE_RESULT_BLOCKING)])

  const errs = of(f.events, 'error')
  assert.equal(errs.length, 1, '失败原因必须进事件流，且恰好一条')
  assert.equal(errs[0].message, 'Prompt is too long', 'CLI 的原话一个字不许改')
  assert.equal(errs[0].code, 'cli_reported', '码取自 AGENT_ERROR_CODES —— CLI 自述的失败不属于前七个')
  assert.equal(errs[0].fatal, true, '这一轮就结束在这里')
  assert.equal(done(f.events).reason, 'crashed', '连同终态原因一起给出')
})

test('`is_api_error_message` 单独成立时也拦（两个判据是「或」，不是「且」）', () => {
  // 第二个判据是 CLI 的**自述**。留它是因为「模型名叫 `<synthetic>`」这件事
  // 万一哪天改了名，我们仍然不该把一条自述的 API 报错当成模型发言。
  const f = feed([
    ndjson(
      INIT,
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: '限流了' }] },
        is_api_error_message: true
      },
      RESULT_OK
    )
  ])
  assert.deepEqual(of(f.events, 'text_delta'), [])
  assert.ok(f.warnTags.includes('synthetic-assistant'))
})

test('正常的完整块补发路径**没有**被这两条判据误伤（反向对照）', () => {
  // 反向对照是必须的：上面两条如果实现成"凡是没有增量的 assistant 都不发"，
  // 它们照样会绿 —— 而那是把一个真模型的话也吞掉了。
  const f = feed([
    ndjson(INIT, { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: '我来说一句' }] } }, RESULT_OK)
  ])
  assert.deepEqual(
    of(f.events, 'text_delta').map((e) => e.text),
    ['我来说一句']
  )
  assert.ok(!f.warnTags.includes('synthetic-assistant'), '真模型的话不是 synthetic')
})
