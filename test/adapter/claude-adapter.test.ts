/**
 * M5 验证之五：适配器本身 —— **真 spawn、真 stdio、真解析、真中断阶梯**。
 *
 * 只把那个 237MB 的原生二进制换成 `test/fixtures/fake-claude.cjs`（一百多行 Node），
 * 其余一律是真的：真的管道、真的进程、真的 `taskkill`。这一层几乎没法用 mock 测 ——
 * 要验的东西（进程起不来、被硬杀、stdout 从中间切断）全都是「真的起一个进程」才出现的。
 *
 * ## 本文件盯得最紧的一条：`run()` **恰好**产出一次 `done`
 *
 * 这是适配器唯一的硬不变量。漏了它，中断路径上轮次永远等不到终态：
 * M9 的 `turn:stop` 没有事件可报，§4.5 的并发槽位永远不释放。
 * 而它最容易漏的地方恰恰是**硬杀** —— 杀完根本没有 `result` 行可解析。
 * 所以下面每一条路径（正常、非零退出、起不来、被中断）都单独断言一次终态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClaudeArgs, createClaudeAdapter } from '../../src/main/adapters/claude/claude-adapter.ts'
import type { CliLaunch } from '../../src/main/adapters/claude/claude-adapter.ts'
import { createChildRegistry } from '../../src/main/process/child-registry.ts'
import type { ChildRegistry, KillOutcome, KillTimings } from '../../src/main/process/child-registry.ts'
import type { AgentEvent, TurnContext } from '../../src/main/adapters/agent-adapter.ts'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.cjs', import.meta.url))

const FAST: KillTimings = { interruptGraceMs: 400, gracefulGraceMs: 400 }

const tmp = mkdtempSync(join(tmpdir(), 'code-chat-adapter-'))
const scratch = (name: string): string => join(tmp, name)

/** 顶替真身。`preambleArgs` 就是生产里那个「空数组」的位置。 */
function fakeCli(...flags: string[]): CliLaunch {
  return { exe: process.execPath, preambleArgs: [FAKE, ...flags] }
}

function ctxOf(over: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 't1',
    sessionId: 's1',
    cwd: tmp,
    messages: [{ role: 'user', content: '把那个空指针修了' }],
    systemPrompt: '你是 Atlas，一个架构师。',
    model: 'deepseek-flash',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    maxBudgetUsd: 0.5,
    addDirs: [],
    ...over
  }
}

function adapterWith(launch: CliLaunch) {
  const registry = createChildRegistry()
  const adapter = createClaudeAdapter({ registry, launch, timings: FAST })
  return { registry, adapter }
}

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

const of = <K extends AgentEvent['k']>(events: AgentEvent[], k: K): Extract<AgentEvent, { k: K }>[] =>
  events.filter((e): e is Extract<AgentEvent, { k: K }> => e.k === k)

/** 恰好一次终态。**每条用例都该在最后调它一次。** */
function doneOnce(events: AgentEvent[]): Extract<AgentEvent, { k: 'done' }> {
  const ds = of(events, 'done')
  assert.equal(ds.length, 1, `run() 必须恰好产出一个 done，实际 ${ds.length} 个`)
  return ds[0]
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('等待超时')
}

// ─────────────────────────────────────────────────────────────
// 完整一轮
// ─────────────────────────────────────────────────────────────

test('完整一轮：事件序列按序到齐，且恰好一次终态', async () => {
  const { registry, adapter } = adapterWith(fakeCli('--fake-scenario=normal'))
  const events = await drain(adapter.run(ctxOf(), new AbortController().signal))

  assert.deepEqual(
    events.map((e) => e.k),
    [
      'session_started',
      'status_changed',
      'thinking_delta',
      'thinking_end',
      'text_delta',
      'tool_start',
      'tool_result',
      'usage',
      'done'
    ]
  )
  assert.equal(doneOnce(events).reason, 'complete')

  const started = of(events, 'session_started')[0]
  assert.equal(started.permissionMode, 'default', '§2.3-3：上报值是内部名，原样带出')
  assert.equal(of(events, 'usage')[0].cacheRead, 8901, '§4.6/§5.4 要能排查缓存命中')
  assert.deepEqual(of(events, 'tool_result')[0].structured, { file: { filePath: 'a.ts', numLines: 12 } })

  // 登记表在轮次结束后要干净 —— 否则它会随运行时间慢慢变脏。
  assert.deepEqual(registry.listLive(), [])
})

test('真实参数：假 CLI 那边看到的 argv 与 `buildClaudeArgs` 的产物一致', async () => {
  // 契约断言。§4.4 的参数表是**要求**，不是实现细节 —— 少一个 `--no-session-persistence`
  // 就会在用户磁盘上悄悄留下一堆会话文件。
  const argvFile = scratch('argv.json')
  const fakeFlags = ['--fake-scenario=empty', `--fake-echo-argv=${argvFile}`]
  const { adapter } = adapterWith(fakeCli(...fakeFlags))
  const ctx = ctxOf({ addDirs: ['G:/work/api', 'G:/work/web'] })
  await drain(adapter.run(ctx, new AbortController().signal))

  const seen = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
  const promptPath = seen[seen.indexOf('--append-system-prompt-file') + 1]
  // 假 CLI 看到的是「假旗标 + 生产参数」；它自己的 `slice(2)` 把 node 与脚本路径摘掉了，
  // 所以生产参数那段与 `buildClaudeArgs` 的输出**逐字相等**（假旗标在生产里不存在）。
  assert.deepEqual(seen, buildClaudeArgs(ctx, promptPath, fakeFlags))

  // 逐项点名 —— 上面那行是自洽性，下面这些才是「§4.4 要求的那些旗标真的在」。
  for (const required of [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file',
    '--exclude-dynamic-system-prompt-sections',
    '--no-session-persistence',
    '--max-budget-usd'
  ]) {
    assert.ok(seen.includes(required), `argv 里必须有 ${required}`)
  }
  assert.equal(seen[seen.indexOf('--model') + 1], 'deepseek-flash')
  assert.equal(seen[seen.indexOf('--effort') + 1], 'medium')
  assert.equal(seen[seen.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(seen[seen.indexOf('--max-budget-usd') + 1], '0.5')
  // 每个可见项目根一个 `--add-dir`（§8.4：工具可及范围，不是上下文来源）。
  assert.equal(seen.filter((a) => a === '--add-dir').length, 2)
})

test('buildClaudeArgs 是纯函数：同样的输入给同样的数组，顺序稳定', () => {
  const ctx = ctxOf({ addDirs: ['A', 'B'] })
  assert.deepEqual(buildClaudeArgs(ctx, '/tmp/p.md'), buildClaudeArgs(ctx, '/tmp/p.md'))
  assert.deepEqual(buildClaudeArgs(ctx, '/tmp/p.md').slice(-4), ['--add-dir', 'A', '--add-dir', 'B'])
})

test('★ 临时提示词文件的生死：spawn 时存在且内容正确，轮次结束后被删掉', async () => {
  const promptEcho = scratch('prompt.json')
  const { adapter } = adapterWith(fakeCli('--fake-scenario=empty', `--fake-echo-prompt=${promptEcho}`))
  const ctx = ctxOf({ systemPrompt: '独一无二的系统提示词标记-XYZZY' })
  await drain(adapter.run(ctx, new AbortController().signal))

  const seen = JSON.parse(readFileSync(promptEcho, 'utf8')) as { found: boolean; path: string; content: string }
  assert.equal(seen.found, true)
  assert.equal(seen.content, '独一无二的系统提示词标记-XYZZY', '传给 CLI 的必须是 systemPrompt 本身')
  // 进程退出后必须删掉 —— 不认领这个文件就会在 %TEMP% 里慢慢堆积（§8.9-11 问的是同一件事）。
  assert.equal(existsSync(seen.path), false, '轮次结束后临时文件必须已被删除')
})

// ─────────────────────────────────────────────────────────────
// ★ 终态不变量
// ─────────────────────────────────────────────────────────────

test('★ 被**硬杀**时也要有终态：没有 result 行，适配器必须自己合成一个 interrupted', async () => {
  // 这条是 M5 补上的那个「谁都没认领的不变量」。杀完没有任何 `result` 可解析，
  // 于是「用户点了停止」这条最常见的非正常结束路径上会永远等不到终态。
  //
  // 剧本必须用 `no-result` 而**不是** `normal`：后者带着 `RESULT_OK`，中断到达之前
  // 就已经有一个货真价实的终态了 —— 那样断言「合成」其实什么都没验到（我第一版就是这么写错的）。
  const base = createChildRegistry()
  const outcomes: (KillOutcome | null)[] = []
  const registry: ChildRegistry = {
    ...base,
    async killTree(turnId, o) {
      const r = await base.killTree(turnId, o)
      outcomes.push(r)
      return r
    }
  }
  const adapter = createClaudeAdapter({ registry, launch: fakeCli('--fake-scenario=no-result', '--fake-hang', '--fake-on-interrupt=ack-only'), timings: FAST })
  const ctrl = new AbortController()
  registry.registerCancel('t1', ctrl)

  const events: AgentEvent[] = []
  const running = (async () => {
    for await (const ev of adapter.run(ctxOf(), ctrl.signal)) events.push(ev)
  })()

  await waitFor(() => events.some((e) => e.k === 'text_delta'))
  assert.equal(await adapter.interrupt({ turnId: 't1', pid: -1 }), true)
  await running

  // 先确认这真的是「硬杀」那条路径 —— 否则下面那条断言可能只是撞上了别的分支。
  // `ack-only` 让第 1 级必然超时，于是阶梯必须走到 `taskkill`。
  const last = outcomes.at(-1)
  assert.ok(
    last && ['taskkill-graceful', 'taskkill-force', 'sigterm', 'sigkill'].includes(last.stage),
    `必须走到硬杀那一级才叫「被硬杀」，实际 ${last?.stage}`
  )
  assert.equal(last.exited, true)

  // 而这一级是「没有终态行」的 —— 这正是那条不变量存在的理由。
  assert.equal(doneOnce(events).reason, 'interrupted')
  // 用户主动停止**不是**故障：不许为此报一个 error（否则 M9 的停止按钮会弹「出错了」）。
  assert.deepEqual(of(events, 'error'), [])
})

test('★ `interrupt()` 只是 signal 的命令式外壳：它 abort 的就是登记表里那个 controller', async () => {
  const { registry, adapter } = adapterWith(fakeCli('--fake-scenario=no-result', '--fake-hang', '--fake-on-interrupt=ack-only'))
  const ctrl = new AbortController()
  registry.registerCancel('t1', ctrl)

  const running = drain(adapter.run(ctxOf(), ctrl.signal))
  // ★ 必须等到子进程**真的起来了**再按停止。否则这条用例会撞上适配器里那条
  // 「spawn 之前就已经 abort」的早退分支（它也是对的，但那是另一条路径）——
  // 于是这条用例会以 3 毫秒通过，而它本该验的东西一个都没验到。
  await waitFor(() => registry.handleOf('t1') !== null)
  assert.equal(ctrl.signal.aborted, false, '还没按停止，signal 不该是 abort 的')

  await adapter.interrupt({ turnId: 't1', pid: -1 })
  assert.equal(ctrl.signal.aborted, true, '中断就是 abort 那个 signal —— 阶梯因此只有一份实现')
  await running
})

test('中断一个没在跑的轮次 → false（§4.5a 规则 4 的幂等语义）', async () => {
  const { adapter } = adapterWith(fakeCli('--fake-scenario=empty'))
  assert.equal(await adapter.interrupt({ turnId: 'never-existed', pid: -1 }), false)
})

test('进程非零退出且没有终态行 → 先报 nonzero_exit，再给一个合成的 crashed', async () => {
  const { adapter } = adapterWith(fakeCli('--fake-scenario=exit-nonzero'))
  const events = await drain(adapter.run(ctxOf(), new AbortController().signal))

  const errs = of(events, 'error')
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'nonzero_exit')
  assert.ok(errs[0].message.includes('3'), '退出码要说出来')
  assert.equal(doneOnce(events).reason, 'crashed')
})

test('一行都不吐但正常退出 → 终态是 complete，且**不**编造一个错误', async () => {
  // 「它正常地结束了，但我们没读到结局」—— 如实说，比编一个 subtype 诚实。
  const { adapter } = adapterWith(fakeCli('--fake-scenario=empty'))
  const events = await drain(adapter.run(ctxOf(), new AbortController().signal))
  assert.deepEqual(of(events, 'error'), [])
  assert.equal(doneOnce(events).reason, 'complete')
})

// ─────────────────────────────────────────────────────────────
// 起不来 / 找不到
// ─────────────────────────────────────────────────────────────

test('进程起不来（可执行文件不存在）→ spawn_failed + 终态，且**不**抛出去', async () => {
  const { adapter } = adapterWith({ exe: join(tmp, 'definitely-not-here.exe'), preambleArgs: [] })
  const events = await drain(adapter.run(ctxOf(), new AbortController().signal))

  const errs = of(events, 'error')
  assert.equal(errs[0].code, 'spawn_failed')
  assert.equal(errs[0].fatal, true)
  assert.equal(doneOnce(events).reason, 'crashed')
})

test('找不到 CLI → cli_not_found，一句能照着修的人话 + 一个终态', async () => {
  // ⚠️ **必须注入 `resolve`，绝不能让这条用例去问本机。**
  // 我写的第一版没有这个 seam，于是在这台装了 CLI 的机器上，这条用例
  // **真的 spawn 了一个真的 claude.exe**：真凭据、真端点、跑了 178 秒、花了真钱。
  // 那正是 §三 那条「探针绝不能被 `npm test` 扫到」的规矩要防的事，
  // 而我绕过了它 —— 所以适配器现在有一个专门的 `resolve` 注入口（见 §8.8d）。
  const registry = createChildRegistry()
  const adapter = createClaudeAdapter({ registry, resolve: async () => null })
  const events = await drain(adapter.run(ctxOf(), new AbortController().signal))

  const errs = of(events, 'error')
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'cli_not_found')
  assert.equal(errs[0].fatal, true)
  assert.ok(errs[0].message.includes('CODE_CHAT_CLAUDE_PATH'), '要告诉用户怎么指定路径')
  assert.ok(errs[0].message.includes('找过'), '要把「找过哪里」带上，否则用户无从下手')
  assert.equal(doneOnce(events).reason, 'crashed')
})

// ─────────────────────────────────────────────────────────────
// 诊断通道
// ─────────────────────────────────────────────────────────────

test('解析诊断走 `diagnosticsOf`，**不是** error 事件（否则一行噪声会让 UI 弹「出错了」）', async () => {
  const { adapter } = adapterWith(fakeCli('--fake-scenario=noisy'))
  const events = await drain(adapter.run(ctxOf(), new AbortController().signal))

  assert.deepEqual(of(events, 'error'), [], '噪声不许变成错误')
  const diags = adapter.diagnosticsOf('t1')
  assert.ok(diags.some((d) => d.tag === 'non-json-line'), '但必须留下来，否则问题就隐形了')
  assert.ok(diags.some((d) => d.tag === 'unknown-line-type'))
})

test('诊断按轮次隔离，重跑一轮会清空上一轮的', async () => {
  const { adapter } = adapterWith(fakeCli('--fake-scenario=noisy'))
  await drain(adapter.run(ctxOf(), new AbortController().signal))
  const first = adapter.diagnosticsOf('t1').length
  assert.ok(first > 0)

  const { adapter: clean } = adapterWith(fakeCli('--fake-scenario=empty'))
  await drain(clean.run(ctxOf(), new AbortController().signal))
  assert.deepEqual(clean.diagnosticsOf('t1'), [], '这一轮干干净净，不该继承任何东西')
  assert.deepEqual(clean.diagnosticsOf('never-ran'), [], '没跑过的轮次给空数组，不抛')
})

// ─────────────────────────────────────────────────────────────
// 委托出去的两件事
// ─────────────────────────────────────────────────────────────

test('`projectContextSources()` 报出该 agent 认识的那些文件（UI 用它说「记忆读到了吗」）', () => {
  const { adapter } = adapterWith(fakeCli('--fake-scenario=empty'))
  const sources = adapter.projectContextSources()
  assert.ok(sources.some((s) => s.relPath === 'CLAUDE.md'))
  assert.ok(sources.some((s) => s.relPath === '.claude/rules/*.md'))
})

test('`collectProjectContext` 如实委托（真读文件系统）', async () => {
  const { adapter } = adapterWith(fakeCli('--fake-scenario=empty'))
  const ctx = await adapter.collectProjectContext(tmp)
  assert.equal(ctx.rootPath, tmp)
  assert.ok(Array.isArray(ctx.files))
})

test.after(() => {
  rmSync(tmp, { recursive: true, force: true })
})
