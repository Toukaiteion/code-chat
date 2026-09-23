#!/usr/bin/env node
/**
 * 探针⑤用的**最小 MCP stdio server** —— 只暴露一个工具 `probe_ping`。
 *
 * 为什么要有它：§8.9-11 问的是「`--mcp-config` 能不能动态挂载、内联 JSON 在 Windows 上
 * 会不会被当成路径」，而这两个问题**必须有一个真的 server 才测得出来** ——
 * 没有 server 的话，「挂载成功」和「配置被忽略」在输出上长得一模一样。
 *
 * 它自己也是一个观测点：**本进程被 spawn 过没有、被调用过没有**，都写进 `--log` 那个文件。
 * 于是即使模型最后没去调这个工具，我们也能区分「配置没生效」和「生效了但模型没调」——
 * 这两种失败长得一样，但修法完全不同。
 *
 * ## 协议：stdio 上的逐行 JSON-RPC（MCP 2024-11-05）
 *
 * `initialize` → `notifications/initialized` → `tools/list` → `tools/call`。
 * 只实现这四条；其余一律回 `-32601`。**不引任何依赖** —— 这是探针，不是产品代码。
 *
 * 它不在任何 tsconfig 的 `include` 里（`scripts/fixtures/*.cjs`），所以对 `tsc` 不可见，
 * 打错字只在运行时炸。与 `test/fixtures/fake-claude.cjs` 是同一类坑。
 */
const fs = require('node:fs')

const argv = process.argv.slice(2)
const logFile = (() => {
  const i = argv.indexOf('--log')
  return i >= 0 ? argv[i + 1] : null
})()

/** 埋在这条工具返回值里的标记 —— 探针靠它在模型的话里找「这个工具真的被调用了」。 */
const MARKER = (() => {
  const i = argv.indexOf('--marker')
  return i >= 0 ? argv[i + 1] : 'MK-MCP-DEFAULT'
})()

function log(line) {
  if (!logFile) return
  try {
    fs.appendFileSync(logFile, line + '\n', 'utf8')
  } catch {
    /* 探针不因为留档失败而挂掉 */
  }
}

log(`启动 pid=${process.pid} marker=${MARKER}`)

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const TOOL = {
  name: 'probe_ping',
  description: '返回一个固定的标记串。用于确认 MCP server 已被成功挂载并可调用。',
  inputSchema: { type: 'object', properties: {}, required: [] }
}

function handle(msg) {
  const { id, method, params } = msg
  // 通知（没有 id）不需要回包。
  if (id === undefined || id === null) {
    log(`通知 ${method}`)
    return
  }
  switch (method) {
    case 'initialize':
      log(`initialize protocolVersion=${params && params.protocolVersion}`)
      send({
        jsonrpc: '2.0',
        id,
        result: {
          // 回一个我们能说清楚的版本；客户端不接受会自己再协商。
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'm5-probe', version: '1.0.0' }
        }
      })
      return
    case 'tools/list':
      log('tools/list')
      send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } })
      return
    case 'tools/call': {
      const name = params && params.name
      log(`tools/call ${name}`)
      if (name !== TOOL.name) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `没有这个工具：${name}` } })
        return
      }
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `MCP 工具已调用，标记：${MARKER}` }] }
      })
      return
    }
    default:
      log(`未实现 ${method}`)
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现：${method}` } })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch (err) {
      log(`坏行：${err.message}`)
    }
  }
})
process.stdin.on('end', () => {
  log('stdin 关闭，退出')
  process.exit(0)
})
