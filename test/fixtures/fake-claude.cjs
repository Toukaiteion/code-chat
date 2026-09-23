#!/usr/bin/env node
/**
 * 假 CLI —— 一个按剧本吐 NDJSON 的 `claude.exe` 替身。
 *
 * 存在理由：适配层要测的东西**真 CLI 恰好测不了** —— 「不回 ACK」「忽略 SIGTERM」
 * 「吐一行不是 JSON 的东西」「终态行缺字段」这些**专门要测的坏行为**，真的 CLI
 * 一个都不会配合，而它还会花钱、要联网、要 237MB 的磁盘。
 *
 * 用法（由测试的 `CliLaunch.preambleArgs` 注入，见 `claude-adapter.ts` 的文件头）：
 *
 *     spawn(process.execPath, [本文件, ...假旗标, '-p', '--input-format', 'stream-json', ...])
 *
 * ## 两个已知的保留坑（照 §三 记的）
 *
 * - **argv 的形状：假旗标在前面，生产参数原样跟在后面。**
 *   下面一律用 `argv.slice(2)` —— Node 跑脚本时 `argv[0]` 是 node、`argv[1]` 是本文件路径，
 *   两者都不是「CLI 看到的东西」。**摘掉那两个之后，剩下的是** `[假旗标…, 生产参数…]`，
 *   而生产参数那一段与 `claude-adapter.ts` 的 `buildClaudeArgs()` 逐字相等 ——
 *   `claude-adapter.test.ts` 的契约断言正是靠这一点成立的（假旗标在生产里不存在，
 *   所以把它当作 `preamble` 传回去就能还原）。
 *   我原先在这里写的是「argv 比生产多一个前导元素」，**那句话不准**：多出来的那个
 *   前导元素是 `slice(2)` 正好摘掉的东西，不是留在数组里的东西。
 * - **`.cjs` 对 `tsc` 不可见。** 它是纯 JS 且不在任何 tsconfig 的 `include` 里，
 *   所以**打错一个字都只在运行时炸**，而且表现出来是「某个用例超时」这种
 *   最难查的形态。改这个文件时请顺手跑一遍 `npm test`。
 *
 * ## 旗标（一律 `--fake-` 前缀，与生产的参数不会撞名）
 *
 * | 旗标 | 作用 |
 * |---|---|
 * | `--fake-scenario=<名>` | 吐哪一份剧本，见 `SCENARIOS` |
 * | `--fake-hang` | 剧本吐完**不退出**，一直活着（测中断阶梯与合成的终态） |
 * | `--fake-on-interrupt=<ack-only\|graceful\|silent>` | 收到中断请求怎么办，见下 |
 * | `--fake-grandchild=<pid 文件>` | 起一个真的孙进程并把它的 pid 写进文件（测 `taskkill /T`） |
 * | `--fake-split` | 第三行分两次写、中间隔一下（测跨 chunk 切行） |
 * | `--fake-echo-argv=<文件>` | 把收到的生产参数原样写进文件（测 `buildClaudeArgs` 的契约） |
 * | `--fake-echo-prompt=<文件>` | 把 `--append-system-prompt-file` 的内容抄出来（测临时文件的生死） |
 * | `--fake-ignore-sigterm` | 装一个 SIGTERM 处理器（只在 POSIX 上有意义，见下） |
 *
 * ## `--fake-on-interrupt` 的三种反应 —— 这是本文件最要紧的一栏
 *
 * - `graceful`（默认）：**立刻回 ACK，隔一小会儿才吐终态 `result` 并退出。**
 *   这是 §4.4 阶梯第 1 级成功的形态，也**专门用来验「ACK ≠ 完成」**：
 *   适配器若把 ACK 当成结束，就会在终态到达前收尾。
 * - `ack-only`：只回 ACK，然后**永远不吐终态**（配合 `--fake-hang`）。
 *   阶梯第 1 级因此超时，逼出第 2/3 级。
 * - `silent`：连 ACK 都不回（模拟已经卡死在工具里的 CLI）。
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')

const argv = process.argv.slice(2)

function flag(name) {
  const prefix = `--fake-${name}=`
  const hit = argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : null
}
function hasFlag(name) {
  return argv.includes(`--fake-${name}`)
}

const scenario = flag('scenario') ?? 'normal'
const hang = hasFlag('hang')
const onInterrupt = flag('on-interrupt') ?? 'graceful'
const grandchildPidFile = flag('grandchild')
const echoArgvFile = flag('echo-argv')
const split = hasFlag('split')

/** 一个装了 SIGTERM 处理器、因此**拒绝**被 SIGTERM 杀掉的后代（只在 POSIX 上有意义）。 */
const IGNORE_SIGTERM = hasFlag('ignore-sigterm')

// ─────────────────────────────────────────────────────────────
// 剧本
// ─────────────────────────────────────────────────────────────

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'fake-session-0001',
  model: 'fake-model',
  cwd: process.cwd(),
  // §2.3-3：实测报的是 `"default"`，而 `--help` 里没有这个取值 —— 所以这里
  // **故意照实测写**，用来验「不许从上报值反推入参、类型不许是字面量联合」。
  permissionMode: 'default',
  tools: ['Read', 'Edit', 'Bash']
}

const USAGE = {
  input_tokens: 1234,
  output_tokens: 567,
  cache_read_input_tokens: 8901,
  cache_creation_input_tokens: 234,
  output_tokens_details: { thinking_tokens: 42 }
}

const RESULT_OK = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '好的，改完了。',
  duration_ms: 4200,
  usage: USAGE,
  // §2.4-2：这个数在第三方端点上**不可信**。假 CLI 照样给它，用来验它被带出来
  // 且**不参与任何判定**。
  total_cost_usd: 0.0123
}

/** 内容块：text + tool_use。增量与完整块**都发**，用来验去重（§2.3-2）。 */
function normalLines() {
  return [
    INIT,
    { type: 'system', subtype: 'status', status: 'requesting' },

    // ── 一段思考 ──
    { type: 'stream_event', ttft_ms: 812, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看看这个函数' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },

    // ── 一段正文 ──
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '我来修这个空指针。' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },

    // ── 一个工具调用 ──
    { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use' } } },
    // 半截 JSON：**必须被忽略**，不许有人去拼它。
    { type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_pa' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },

    // 完整 assistant 块 —— 增量已经发过的东西**不许**在这里重复发。
    {
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [
          { type: 'thinking', thinking: '先看看这个函数' },
          { type: 'text', text: '我来修这个空指针。' },
          { type: 'tool_use', id: 'toolu_01', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x.y', new_string: 'x?.y' } }
        ]
      }
    },

    // 工具结果：`tool_use_result` 是**顶层**的（§2.2）。
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '已修改 a.ts', is_error: false }] },
      tool_use_result: { file: { filePath: 'a.ts', numLines: 12 } }
    },

    RESULT_OK
  ]
}

/** 没有任何增量的版本 —— 验「完整块补发」那条兜底（见解析器文件头「谁说了算」）。 */
function noPartialLines() {
  return [
    INIT,
    {
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [
          { type: 'text', text: '没有增量，只有完整块。' },
          { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: 'b.ts' } }
        ]
      }
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: '文件内容', is_error: false }] } },
    RESULT_OK
  ]
}

/** 噪声：非 JSON 行、未知类型、意外的 control_response。三样都**不许**变成 error 事件。 */
function noisyLines() {
  return [
    INIT,
    // §2.3-1 实测见过的形态。它必须是**一行字符串**，不能是 JSON。
    // 见 `RAW_LINES`：这一行不走 JSON.stringify。
    { __raw: '[claude-code:unrecognized_model] {"model":"deepseek-flash"}' },
    { type: 'totally_unknown_kind', whatever: 1 },
    { type: 'control_response', request_id: 'unsolicited', response: { subtype: 'success' } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'brand_new_delta', text: '?' } } },
    { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '噪声之后还活着。' }] } },
    RESULT_OK
  ]
}

/** bug #94741：中断后终态 `result` 字段**会缺**。缺了不影响给终态，只影响能否复述最后一句。 */
function truncatedResultLines() {
  return [
    INIT,
    { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '被打断了。' }] } },
    { type: 'result', subtype: 'success', is_error: false, usage: USAGE, total_cost_usd: 0.004 }
    //                    ^^^^ 刻意没有 `result` 字段
  ]
}

/**
 * 「像超预算那样的」终态 —— 用来验**映射规则**（`subtype` 里含 budget → `budget`），
 * ⚠️ **不是**在断言真实 subtype 长什么样：CLI 实际用哪个字符串报超预算**尚未实测**
 * （§4.4 / 探针⑦）。这里用一个含 `budget` 的编造值，验的是「正则命中」这条规则本身。
 */
function budgetLikeLines() {
  return [
    INIT,
    { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '花超了。' }] } },
    { type: 'result', subtype: 'error_max_budget_usd', is_error: true, usage: USAGE, total_cost_usd: 0.5 }
  ]
}

/**
 * 有内容、但**没有任何终态行** —— 配合 `--fake-hang` 用。
 *
 * 这是「硬杀」那条路径唯一有意义的形态：阶梯走到 `taskkill` 之后**根本不会有 `result` 行**，
 * 终态必须由适配器自己合成。用 `normal` 反而验不到 —— 它的剧本里带着 `RESULT_OK`，
 * 于是在中断到达之前就有一个货真价实的终态了（我第一版就是这么写错的）。
 */
function noResultLines() {
  return [INIT, { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '改到一半被打断了。' }] } }]
}

/** 非零退出且**没有终态行** —— 验适配器合成的 `nonzero_exit` + `crashed`。 */
function exitNonzeroLines() {
  return [
    INIT,
    { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '要炸了。' }] } }
  ]
}

const SCENARIOS = {
  normal: normalLines,
  'no-partial': noPartialLines,
  noisy: noisyLines,
  'truncated-result': truncatedResultLines,
  'budget-like': budgetLikeLines,
  'no-result': noResultLines,
  'exit-nonzero': exitNonzeroLines,
  /** 一行都不吐，正常退出 —— 验「它正常地结束了，但我们没读到结局」这个诚实的说法。 */
  empty: () => []
}

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────

function write(line) {
  process.stdout.write(line + '\n')
}

function emit(value) {
  // `__raw` 是给「非 JSON 行」用的逃生口：那一行必须原样写出，不能经过 stringify。
  write(value.__raw !== undefined ? value.__raw : JSON.stringify(value))
}

// 把收到的生产参数留档（测 `buildClaudeArgs` 的契约）。**先写**，免得后面崩掉看不到。
if (echoArgvFile) {
  try {
    fs.writeFileSync(echoArgvFile, JSON.stringify(argv, null, 2), 'utf8')
  } catch (err) {
    process.stderr.write(`假 CLI 写不了 argv 留档：${err.message}\n`)
  }
}

// 把 `--append-system-prompt-file` 指向的那个文件抄一份出来。
//
// ★ 这一手是为了验**临时文件的生命周期**：适配器承诺「写完 → spawn → 进程退出后删」。
// 那个文件在运行结束之后就不在了，所以测试**只能在运行期间**看到它 ——
// 而唯一在运行期间活着、又能读文件系统的东西就是本进程。
// 抄出来的内容要能证明两件事：文件**当时真的存在**，且内容**就是 systemPrompt**。
const echoPromptFile = flag('echo-prompt')
if (echoPromptFile) {
  const i = argv.indexOf('--append-system-prompt-file')
  const src = i >= 0 ? argv[i + 1] : null
  let payload
  if (!src) {
    payload = { found: false, reason: 'argv 里没有 --append-system-prompt-file' }
  } else {
    try {
      payload = { found: true, path: src, content: fs.readFileSync(src, 'utf8') }
    } catch (err) {
      payload = { found: true, path: src, error: err.message }
    }
  }
  try {
    fs.writeFileSync(echoPromptFile, JSON.stringify(payload), 'utf8')
  } catch (err) {
    process.stderr.write(`假 CLI 写不了提示词留档：${err.message}\n`)
  }
}

// ── 孙进程：真的起一个，且让它一直活着，这样 `taskkill /T` 才有东西可收。 ──
//
// ★ **`detached: true` 是刻意的，也是这条用例唯一有意义的形态。**
// 实测（Node 24 / Windows 11 26200）：**非** detached 的孙进程会随根一起死 ——
// 那是继承来的 Job Object 在起作用，不是 Windows 的普遍性质。
// 换句话说，「杀根」在那种情况下**看起来**把树收干净了，于是用例会假绿。
// detached 的孙摘出了那个 job，杀根之后**真的活得下来** —— 只有它才能验出
// 「阶梯第 2 级必须在根还活着的时候发」这条结论。
let grandchild = null
if (grandchildPidFile) {
  grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true
  })
  // 摘掉引用，免得它把本进程的事件循环也拖住。
  grandchild.unref()
  fs.writeFileSync(grandchildPidFile, String(grandchild.pid), 'utf8')
}

// SIGTERM 处理器：装了它，POSIX 上这一级就不会生效，必须升到 SIGKILL。
// ⚠️ Windows 上它**永远收不到** —— 那边的 SIGTERM 是 `TerminateProcess`（硬杀），
// 所以这个旗标在 Windows 上是死代码，而在 POSIX 上才是那唯一能验阶梯升级的手段。
if (IGNORE_SIGTERM) {
  process.on('SIGTERM', () => {
    process.stderr.write('假 CLI：收到 SIGTERM，装作没听见\n')
  })
}

const lines = (SCENARIOS[scenario] ?? SCENARIOS.normal)()

// ── 吐剧本。`--fake-split` 时第三行分两半写，中间隔一下，
//    这样它必然跨两个 `data` 事件 —— 验解析器的行缓冲真的在缓冲。
let i = 0
function pump() {
  while (i < lines.length) {
    if (split && i === 2) {
      const text = JSON.stringify(lines[i])
      const cut = Math.floor(text.length / 2)
      process.stdout.write(text.slice(0, cut))
      i += 1
      setTimeout(() => {
        process.stdout.write(text.slice(cut) + '\n')
        pump()
      }, 30)
      return
    }
    emit(lines[i])
    i += 1
  }
  afterScript()
}
pump()

function afterScript() {
  if (hang || grandchild) return // 一直活着，等被杀
  // `exit-nonzero` 顺带写一行 stderr —— 适配器要把它抄进错误消息里给用户看。
  if (scenario === 'exit-nonzero') {
    process.stderr.write('假 CLI：内部错误，退出码 3\n')
    process.exitCode = 3
  }
  // ★ **必须主动放开 stdin，否则这个进程永远不会退出。**
  // 上面挂了 `data` 监听器，而 stdio 是管道 —— 那个可读流会把事件循环一直拖住，
  // 于是「剧本吐完了」和「进程结束了」变成两件事。表现出来是：
  // 测试等一个永远不来的 exit，整个套件挂死。这是本文件最贵的一个坑。
  //
  // 用 `destroy()` 而不是 `process.exit()`：后者会截断管道里还没冲刷出去的 stdout，
  // 而测试要断言的**正是**那些输出。
  process.stdin.destroy()
}

// ─────────────────────────────────────────────────────────────
// stdin：读 user 消息与中断请求
// ─────────────────────────────────────────────────────────────

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const nl = buffer.indexOf('\n')
    if (nl < 0) break
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stderr.write('假 CLI：stdin 上有一行不是 JSON\n')
      continue
    }
    if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'interrupt') {
      onInterruptRequest(msg.request_id)
    }
  }
})
process.stdin.on('end', () => {
  // 生产里 stdin 一关就代表「没有更多输入了」。假 CLI 不因此退出 ——
  // 它模拟的是那个已经跑起来的 CLI，收尾由剧本和中断阶梯决定。
})

function onInterruptRequest(requestId) {
  if (onInterrupt === 'silent') return
  // ★ 先回 ACK。**回 ACK ≠ 工作结束** —— 我们可能正停在一个跑了一半的 Edit 上。
  // 这一行就是「ACK ≠ 完成」那条纪律的可执行版本：适配器若拿它当结束，就会早收尾。
  write(JSON.stringify({ type: 'control_response', request_id: requestId, response: { subtype: 'success' } }))
  if (onInterrupt === 'ack-only') return

  // 隔一会儿才吐终态，把「ACK 与终态之间有时间差」这段真的演出来。
  setTimeout(() => {
    write(
      JSON.stringify({
        type: 'result',
        subtype: 'interrupted',
        is_error: false,
        // bug #94741 的形态：中断后的终态行没有 `result` 字段。
        usage: USAGE,
        total_cost_usd: 0.009
      })
    )
    setTimeout(() => process.exit(0), 10)
  }, 40)
}
