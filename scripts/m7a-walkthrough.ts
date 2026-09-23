/**
 * M7a 实机走查 —— **上下文装配**：第 2 轮记得第 1 轮、人设真的进了提示词、cwd 的 `CLAUDE.md` 只进一遍。
 *
 *     npm run walk:m7a:dry                                          # ★ 先跑这个（零成本）
 *     npm run walk:m7a                                              # 真机（真花钱：2 轮）
 *     npm run walk:m7a:replay -- --archive=scripts/evidence/m7a-…    # 重放（零成本）
 *     ⚠️ `walk:m7a:replay` 忘了 `--archive` 时**直接报错退出**，不会顺手采集一次。
 *        理由逐字抄 M6b：一个叫 replay 的命令在打错字时花钱，是这把枪自己走火。
 *
 * ## 它与 M6b 走查的关系：骨架逐字照抄，被测物换了一层
 *
 * CDP 客户端、spawn/硬杀/等待、归档写入、三态 `check`、报告只读归档、`finish()` 收摊 —— 全部
 * 逐字沿用 `m6b-walkthrough.ts`（那一套又是从 `m6a-pipeline-walkthrough.ts` 抄来的）。
 * 驱动方式也照 M6b：**夹具走 IPC，被测动作走界面**（`setup` 用 `window.__m7a.call`，
 * 而「输入 + 点发送」是真的 `click()`）。
 *
 * 换掉的是场景：M6b 测「流出来的东西长什么样」，M7a 测「**发出去的东西是什么**」——
 * 一个在渲染层看得见（`stream:batch`），另一个**在界面上完全看不见**。
 *
 * ## ★ 观测通道：`onContextBuilt` → 主进程 stdout → 归档
 *
 * 装配产物（`ContextBuild`）过去只在内存里，`db-*.json` 看不到它，界面上也没有任何痕迹 ——
 * 于是「这一轮到底发了什么」是一个**零观测**的事实。M7a 为此加了一条注入缝：
 * `RuntimeOptions.onContextBuilt(turnId, shape)`（形状照 `onWarn`），`main/index.ts` 把它写成
 * **一行** `console.log('[ctx] ' + JSON.stringify({turnId, shape}))`。
 *
 * 走查这一侧不去评价它「该不该走日志」，而是利用一条**已经在归档里被证明存在**的事实：
 * 主进程的 `console.log` 会落进 `app-<label>.stdout.log`（M6b 的归档里
 * `[main] 数据库已就绪：…` 就在那儿）。`pullAppCtx()` 把 `[ctx] ` 行解析成
 * `kind:'ctx'` 记录进 `events.jsonl` —— 于是**报告仍然只读归档**，重放零成本。
 *
 * ★ 传的是 `ContextShape`，**不含任何正文**：够回答「装配对不对」，不够泄露用户的项目内容。
 *   （把提示词全文写进归档是另一类错误 —— 归档是要进版本库的。）
 *
 * ## 四个场景与它们的**判据强度**
 *
 * 1. **第一轮**：装配形状从 `[ctx]` 断（人设进了、系统提示词非空、项目记忆进了几份）。
 * 2. ★ **第二轮记得第一轮**。这一条的全部价值在于**判据不能自己骗自己**，所以两个行为判据
 *    都锚在**只可能来自历史**的串上：
 *    - 第一轮的**用户消息**里有一个本轮现编的标记 `MK7A-R1-<本次后缀>`（第二轮问它）；
 *    - 第一轮的**回答**里有一个**模型自己编的 4 位数字**（第二轮问它）。
 *      这个数**不在第一轮的提示词里** —— 所以它可以被算出来但**不可能被抄到**，
 *      除非第一轮的回答真的在数组里。这一条是本里程碑的头号验收。
 * 3. **装配形状的第二轮**：`messageCount` / `historyIncluded` 比第一轮多、`contentChars` 变长、
 *    而 `systemPromptChars` **不变**（系统提示词是稳定前缀 —— §4.6 缓存论证的可执行形态）。
 * 4. ★ **cwd 的 `CLAUDE.md` 只进一遍**。分两半，**必须分开说**：
 *    - **我们这一半（硬断言）**：`suppressedAutoInjected = 2`（`CLAUDE.md` 与 `.claude/CLAUDE.md`）、
 *      `projectFiles = 2`（`AGENTS.md` 与 `.claude/rules/notes.md`）——
 *      也就是 cwd 那份**没有**进我们拼的 `<project_context>`。
 *    - **CLI 那一半（行为证据）**：提示词里**不含** `MK7A-CWD-…`，而模型若逐字复述了它，
 *      唯一可能的来源就是 CLI 自己把它带进了上下文。
 *
 * ### 为什么这条行为判据成立，以及它靠什么成立
 *
 * ★ 它成立的前提是「**这一轮没有用过任何工具**」。模型一旦自己去 `Read` 了 `CLAUDE.md`，
 * 复述就变得毫无信息量（读到的内容与自动注入的内容长得一模一样）。
 * 所以 `report()` 把「tool_start 事件数 = 0」当作判据的**前提**来查：
 * 前提不成立时这两条判**降级成 `unknown`**，而不是照印 ✅（§8.8e 规则三）。
 *
 * 顺带测到一件 M7a 探针没定论的事：**`.claude/CLAUDE.md` 会不会被 CLI 自动注入**。
 * 探针那一轮的阳性对照没成立，所以它的「没被注入」结论**不可信**（那条结论已作废）。
 * 本走查的标记判据是**不需要动工具**就能出结论的，代价只有一轮对话。
 *
 * ### 本走查**判不了**的那半：行类型
 *
 * §8.5c-1 与 M7a 探针用的是**行类型**判据（标记出现在 `main.ndjson` 的 `assistant` 消息里、
 * 且之前没有任何 `tool_result`）—— 那要求拿到 CLI 的**逐行原始输出**。
 * 走查不持有它：CLI 是应用的主进程 spawn 的，走查只看得见渲染层收到的东西。
 * ⇒ 行类型判据留在 `scripts/m7a-probe.ts`（`scripts/evidence/m7a-*`），
 *   这里做的是**端到端**的那一半（模型到底看没看见）。两者不是同一件事，别互相冒充。
 *
 * ## 端点限定语（照 §六「M5 实证」的纪律，写最前面）
 *
 * 全部实测跑在**本机当前默认凭据所指向的端点**下（一个 Anthropic 兼容端点，模型名由
 * `--model` 给、默认 `deepseek-flash`，**不是 Anthropic 官方**）。所以「缓存命中了没有」
 * 这类结论**只在该端点下成立**。**凭据本身一律不读、不回显、不落档** ——
 * 环境**原样**继承给子进程（`spawn` 不传 `env` 就是原样继承）。
 *
 * ## 为什么断言不许写在采集里（§8.8d 规则九）
 *
 * 采集（`collect()`）只做两件事：驱动真窗口、把**每一个可观测事实**写进归档。
 * **所有断言都在 `report()` 里，而它只读归档。** 采集崩了也照样出报告。
 *
 * 归档里的五个部分：
 * - `events.jsonl` —— 全部事实（launch / status / batch / dom / ui / probe / ctx / warn / db …）
 * - `batches.jsonl` —— 只装推送载荷（`stream:batch` / `stream:status` / `workspace:unread`），逐字
 * - `db-<launch>-<phase>.json` —— 库转储
 * - `app-<launch>.<stdout|stderr>.log` —— 主进程的两条流（`[ctx] …` 与 `[runtime:…] …` 在这里）
 * - `console.log` —— 走查自己说过的话
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

// ─────────────────────────────────────────────────────────────
// 常量与路径
// ─────────────────────────────────────────────────────────────

const REPO = join(import.meta.dirname, '..')
const ELECTRON_EXE = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT_MAIN = join(REPO, 'out', 'main', 'index.js')
const EVIDENCE_ROOT = join(import.meta.dirname, 'evidence')

/**
 * 沙箱。**它保证走查碰不到用户的真数据**：`--user-data-dir` 指向这里，
 * 于是库（`code-chat.db`）与 `workspaces/` 根都在这个目录下。
 * M7a 有自己的沙箱（`cc-m7a`），与 `cc-m6a` / `cc-m6b` 分开。
 */
const SAND = join(tmpdir(), 'cc-m7a')
const USERDATA = join(SAND, 'userdata')
const SRC = join(SAND, 'src-proj')
const PERSONA = join(SAND, 'persona.md')
const DB = join(USERDATA, 'code-chat.db')

const CDP_PORT = 9222
const CDP = `http://localhost:${CDP_PORT}`

/** 流式期间的轮询间隔。150ms ≈ 每 4~5 个合批周期看一眼，快过终态交接那 250ms。 */
const POLL_MS = 150

const MODEL = argValue('model') ?? process.env.CODE_CHAT_WALKTHROUGH_MODEL ?? 'deepseek-flash'

/**
 * 干跑：**只开界面、不发轮次**。
 *
 * 它值一个开关，因为走查的地基（构建产物起得来、CDP 连得上、preload 桥在构建版里真的暴露、
 * 装配七次 IPC 全过、**对话视图打开后输入区真的在**）与「发出去的上下文对不对」是两个独立的
 * 失败面 —— 地基塌了的时候，真机跑一遍会**花钱**换来一份什么都测不到的报告。
 */
const DRY = process.argv.slice(2).includes('--dry')

/**
 * 「只重放，绝不采集」。
 *
 * ★ 这一点与 `walk:m6a:replay` 不同，而且是故意不同的：那个命令忘了跟 `--archive=<目录>`
 * 时不会报错，它会**开始一次真采集**（真花钱）。npm 脚本传不了必填参数，
 * 所以「忘了参数就白花两轮」是那个形状下的默认后果。M6b 把那个默认反过来，
 * M7a 照抄：**没有 `--archive` 就直接退出**。
 * 这不是洁癖 —— 一个叫 replay 的命令在打错字时花钱，是这把枪自己走火。
 */
const REPLAY_ONLY = process.argv.slice(2).includes('--replay')

/**
 * ★ 本次运行的**标记后缀**。
 *
 * 它让「模型复述了一串标记」变成一件**不可能碰巧发生**的事：标记串本身是本轮现编的，
 * 项目文件里除了它没有别的内容会让人复述。重放时报告从归档里读它 ——
 * 于是「这份报告看的是哪一次采集」是可核对的，而不是靠时间戳猜。
 */
const NONCE = argValue('nonce') ?? Math.random().toString(36).slice(2, 6)

/**
 * 四个标记，四份文件，**四种不同的证据含义**（这一层区分是本次走查的主要智力内容）：
 *
 * | 标记 | 在哪 | 我们注入吗 | 模型复述它 ⇒ 说明 |
 * |---|---|---|---|
 * | `MK7A-CWD-…` | `CLAUDE.md`（cwd 根） | **不** | CLI 自己把它带进来了 |
 * | `MK7A-DOTCLAUDE-…` | `.claude/CLAUDE.md` | **不** | 同上（**探针没定论的那一条**） |
 * | `MK7A-AGENTS-…` | `AGENTS.md` | 注入 | 至少有一份进去了（**分不清是谁的**） |
 * | `MK7A-RULES-…` | `.claude/rules/notes.md` | 注入 | **我们这条注入缝通了**（阳性对照） |
 *
 * 前两条是**可判**的（被我们剔了，只能来自 CLI）；第三条**不可判**（两边都可能带，如实标注）；
 * 第四条是**阳性对照** —— 它要是都不出现，那这次采集的装配就是坏的，
 * 前两条的「没被注入」结论也随之作废（与探针那一轮的阳性对照失败同一类错误）。
 */
const MARKERS = {
  cwd: `MK7A-CWD-${NONCE}`,
  dotclaude: `MK7A-DOTCLAUDE-${NONCE}`,
  agents: `MK7A-AGENTS-${NONCE}`,
  rules: `MK7A-RULES-${NONCE}`
} as const

/**
 * 写进 `.claude/rules/notes.md` 的填充段。
 *
 * ★ 它存在只有一个理由：**把装配出来的提示词撑过缓存的最小长度**。
 * 缓存那条验收（场景 3 的第 3 条判据）在几百字的提示词上必然是 0 ——
 * 而那时候的 0 什么也不说明。长度是这条判据的**前提**，前提不满足就只配印 `unknown`。
 * 生成而不是写字面量：120 行足够长，而写在代码里的话这个文件会变成一坨噪声。
 */
const RULES_FILLER = Array.from(
  { length: 120 },
  (_, i) => `- 约定 ${i + 1}：这一行没有含义，它只是为了让装配出来的提示词足够长。`
).join('\n')

/** 沙箱项目里的文件。前四份是**标记的载体**，`a.ts` 只让这个项目看起来像个项目。 */
const SANDBOX_FILES: Record<string, string> = {
  'CLAUDE.md': `# 沙箱项目\n\n本项目记忆标记：${MARKERS.cwd}\n\nM7a 走查用的沙箱项目，只提供一个能读的目录。\n`,
  'AGENTS.md': `# AGENTS.md\n\n本项目记忆标记：${MARKERS.agents}\n`,
  '.claude/CLAUDE.md': `# .claude/CLAUDE.md\n\n本项目记忆标记：${MARKERS.dotclaude}\n`,
  '.claude/rules/notes.md': `# 项目约定（填充）\n\n本项目记忆标记：${MARKERS.rules}\n\n${RULES_FILLER}\n`,
  'a.ts': 'export const x = 1\n'
}

const PERSONA_TEXT =
  '# 沙箱角色\n\n你是一个测试角色。只做用户明确让你做的事，不寒暄、不额外发挥、不改无关文件。\n'

// ─────────────────────────────────────────────────────────────
// 两个提示词
// ─────────────────────────────────────────────────────────────

/**
 * 第一轮。三件事，**每一件都是一个判据的输入**：
 *
 * - 第 1 件：复述所有 `MK7A-` 标记 ⇒ 场景 4 的行为判据（前提：本轮没用工具）。
 * - 第 2 件：编一个 4 位数字 ⇒ 第二轮要引用它。★ **它不在提示词里**，这是关键。
 * - 第 3 件：原样写下 `MK7A-R1-<后缀>` ⇒ 第二轮要引用它。它**在第一轮的提示词里**，
 *   所以两条判据分别覆盖「历史里的用户消息」与「历史里的助手消息」两条路。
 */
const PROMPT_R1 = [
  '只做这三件事，一步都不要多做。',
  '★ **不要使用任何工具、不要读任何文件** —— 只用你现在上下文里已有的内容回答。',
  '1. 把当前上下文里能看到的**所有** `MK7A-` 开头的标记串**逐字**列出来，一个都不要漏，不要改写、不要翻译。',
  '2. 随便编一个 4 位数字（1000~9999 之间），写在单独一行，前缀 `NUM=`。',
  `3. 在最后单独一行原样写下：MK7A-R1-${NONCE}`
].join('\n')

/**
 * 第二轮。★ 两个问题的答案**都不在本提示词里**：
 *
 * 1. 那个 4 位数字只存在于第一轮的**回答**里 ⇒ 答对 ⇒ 助手消息真的在历史数组里。
 * 2. `MK7A-R1-…` 只存在于第一轮的**提示词**里（而它现在是一条 user 历史行）⇒
 *    答对 ⇒ 用户消息真的在历史数组里。
 *
 * 两句话合起来才是「第二轮记得第一轮」。少任何一条，都可能只是「模型自己算出来的」。
 */
const PROMPT_R2 = [
  '不要使用任何工具，只回答这两个问题，每个答案单独一行：',
  '1. 我上一轮让你编的那个 4 位数字是多少？只写 `NUM=` 加那个数字。',
  `2. 我上一轮让你在最后一行原样写下的那串标记是什么？原样写出来（形如 MK7A-R1-…）。`
].join('\n')

// ─────────────────────────────────────────────────────────────
// 归档记录的形状
// ─────────────────────────────────────────────────────────────

/**
 * 一条归档记录。
 *
 * ★ 字段刻意**全部可选**，因为读它的 `report()` 读的是**磁盘上的 JSON**：
 * 给一个精确的联合类型只是在骗自己 —— 报告拿到的是数据，不是代码。
 */
interface Rec {
  t: number
  kind: string
  label?: string
  tag?: string
  [k: string]: unknown
}

interface FrameLike {
  seq: number
  k: string
  [k: string]: unknown
}

interface BatchLike {
  v: number
  t: number
  workspaceId: string
  sessionId: string
  turnId: string
  actorId: string
  epoch: string
  fromSeq: number
  toSeq: number
  frames: FrameLike[]
}

interface StatusLike {
  workspaceId: string
  sessionId: string
  turnId: string
  status: string
  reason?: string | null
}

// ─────────────────────────────────────────────────────────────
// 归档写入
// ─────────────────────────────────────────────────────────────

let runDir = ''
let recs: Rec[] = []

function rec(r: Omit<Rec, 't'>): Rec {
  const full = { t: Date.now(), ...r } as Rec
  recs.push(full)
  appendFileSync(join(runDir, 'events.jsonl'), JSON.stringify(full) + '\n', 'utf8')
  return full
}

/** 只装推送载荷的那一份 —— 文件名就是它的承诺，所以别的东西不进这个文件。 */
function recPush(kind: 'stream:batch' | 'stream:status' | 'workspace:unread', payload: unknown): void {
  appendFileSync(
    join(runDir, 'batches.jsonl'),
    JSON.stringify({ t: Date.now(), kind, payload }) + '\n',
    'utf8'
  )
}

const say = (s = ''): void => {
  process.stdout.write(s + '\n')
  if (runDir) appendFileSync(join(runDir, 'console.log'), s + '\n', 'utf8')
}

const rule = (title: string): void => {
  say()
  say(`──── ${title} ${'─'.repeat(Math.max(4, 70 - title.length))}`)
}

const quote = (s: string, n = 200): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…（共 ${one.length} 字）` : one
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function argValue(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// ─────────────────────────────────────────────────────────────
// CDP 最小客户端（照 `m4-walkthrough.cjs` / `m6a-pipeline-walkthrough.ts`，逐字同源）
// ─────────────────────────────────────────────────────────────

interface CdpTarget {
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

let ws: WebSocket | null = null
let cdpSeq = 0
const waiting = new Map<number, Pending>()

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++cdpSeq
  const sock = ws
  if (!sock) return Promise.reject(new Error('CDP 还没连上'))
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    sock.send(JSON.stringify({ id, method, params }))
  })
}

async function connectCdp(timeoutMs = 40000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      const list = (await (await fetch(`${CDP}/json/list`)).json()) as CdpTarget[]
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page?.webSocketDebuggerUrl) {
        const sock = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise<void>((res, rej) => {
          sock.onopen = () => res()
          sock.onerror = () => rej(new Error('CDP 连接失败'))
        })
        sock.onmessage = (ev: MessageEvent) => {
          const msg = JSON.parse(String(ev.data)) as {
            id?: number
            error?: { message: string }
            result?: unknown
          }
          if (msg.id && waiting.has(msg.id)) {
            const p = waiting.get(msg.id) as Pending
            waiting.delete(msg.id)
            if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`))
            else p.resolve(msg.result)
          }
        }
        ws = sock
        rec({ kind: 'note', tag: 'cdp', text: `CDP 已连上：${page.url}` })
        return
      }
    } catch {
      // 还没起来，继续等
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等不到渲染进程的调试目标（${timeoutMs}ms）—— 应用起来了吗？`)
    }
    await sleep(250)
  }
}

async function evaluate(expression: string): Promise<unknown> {
  const r = (await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })) as { exceptionDetails?: { exception?: { description?: string } }; result?: { value?: unknown } }
  if (r.exceptionDetails) {
    throw new Error(`页面内异常：${r.exceptionDetails.exception?.description ?? '未知'}`)
  }
  return r.result?.value
}

/**
 * 页面内的采集器 + **驱动器**。M6b 与 M6a 最大的差别就在这里。
 *
 * ## 三条纪律
 *
 * 1. **点击用真 `click()`，不是合成坐标。** `el.click()` 派发的是一个真的
 *    `MouseEvent`，React 的合成事件照收 —— 而按屏幕坐标点（`Input.dispatchMouseEvent`）
 *    要先把元素滚进视口、再算坐标，任何一处布局变化都会让点击落到别的地方，
 *    而失败的样子是「什么都没发生」，最难查。
 * 2. **受控输入必须走原型上的 setter。** 直接 `el.value = x` 在 React 里**不会**
 *    触发 `onChange`（React 记着上一次的值，判定「没变」）—— 于是输入框看着有字、
 *    `text` 状态还是空的，点发送什么也不会发生。这是本次走查唯一一个「看着成了其实没成」
 *    的地方，所以它有自己的返回码（`typed` / `mismatch`）。
 * 3. **`liveThinking()` 有副作用（会点开面板），这是有意的。** 思考面板在
 *    `thinking_end` 之后**自动收起**，所以「一直开着」是做不到的：想看到它的正文，
 *    就得在流式过程中反复点开。它同时也是对「可折叠」这条验收的真实验证。
 *
 * ## 判据全部按 DOM 结构，不按文案
 *
 * 在途卡片 = `article.neon-halo`（`StreamingRow` 独有），已落定卡片 =
 * `article.neon-frame:not(.neon-halo)`（`MessageRow`）。**不按中文文案找元素** ——
 * 文案会改，而改文案不该让走查失败。
 */
const HELPERS = `
window.__m7a = {
  batch: [], status: [], unread: [], notice: [], hooked: false,
  // ★ 推送到过的正文，**只增不清**（drain() 会把上面那四个数组掏空，不能拿它们算总数）。
  //   键是 turnId。它存在的唯一理由是 sync()：把「界面上的正文」与「我们收到过的正文」
  //   放进**同一个 tick** 里比较。
  //   ⚠️ 这一段在模板字符串里，注释里**不许出现反引号** —— 它会当场把模板截断，
  //   而 tsc 不管模板里的内容，报出来的错在几百行之外。
  //   碰过这段就顺手跑一次 npm run check:helpers（这段的语法错只有它会当场指出来）。
  pushText: {}, pushCount: {},
  hook() {
    if (this.hooked) return 'already';
    this.hooked = true;
    window.api.on('stream:batch', (p) => {
      this.batch.push({ t: Date.now(), p });
      const id = p && p.turnId;
      if (id) {
        this.pushCount[id] = (this.pushCount[id] || 0) + 1;
        this.pushText[id] = (this.pushText[id] || '') +
          (p.frames || []).filter((f) => f.k === 'text').map((f) => f.d).join('');
      }
    });
    window.api.on('stream:status', (p) => { this.status.push({ t: Date.now(), p }) });
    window.api.on('workspace:unread', (p) => { this.unread.push({ t: Date.now(), p }) });
    window.api.on('app:notice', (p) => { this.notice.push({ t: Date.now(), p }) });
    return 'hooked';
  },
  drain() {
    return {
      batch: this.batch.splice(0), status: this.status.splice(0),
      unread: this.unread.splice(0), notice: this.notice.splice(0)
    };
  },
  call(ch, payload) { return window.api.invoke(ch, payload) },
  dom() { return document.body.innerText },

  // ── 查 ──
  count(sel) { return document.querySelectorAll(sel).length },
  has(sel) { return document.querySelector(sel) !== null },
  text(sel) { const e = document.querySelector(sel); return e ? e.textContent : null },
  attr(sel, name) { const e = document.querySelector(sel); return e ? e.getAttribute(name) : null },
  headerName() {
    const h = document.querySelector('header');
    if (!h) return null;
    const s = h.querySelector('span.text-sm');
    return s ? s.textContent : null;
  },
  // 「估算 $x ⚠N」那个 span 的 title —— 口径写在里面。
  // header 里带 title 的 span 只有它一个（另外两处标题挂在 button 上），所以选择器不会歧义。
  usageTitle() { return window.__m7a.attr('header span[title]', 'title') },
  usageText() { return window.__m7a.text('header span[title]') },

  // ── 点与输入 ──
  click(sel, sub) {
    const list = Array.prototype.slice.call(document.querySelectorAll(sel));
    const el = sub === undefined ? list[0]
      : list.filter((e) => (e.textContent || '').indexOf(sub) >= 0)[0];
    if (!el) return 'not-found';
    el.click();
    return 'clicked';
  },
  type(sel, value) {
    const el = document.querySelector(sel);
    if (!el) return 'not-found';
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === value ? 'typed' : 'mismatch';
  },

  // ── 在途那一轮 ──
  liveCard() { const a = document.querySelector('article.neon-halo'); return a ? a.textContent : null },
  // 正文那一段：带光标时锚在光标上，光标撤了（done 已到、缓冲还在）就退回
  // 「卡片里最后一段不带 italic 的 <p>」—— 思考面板那段是 italic。
  liveText() {
    const a = document.querySelector('article.neon-halo');
    if (!a) return null;
    const c = a.querySelector('.typing-cursor');
    let p = c ? c.closest('p') : null;
    if (!p) {
      const ps = Array.prototype.slice.call(a.querySelectorAll('p'))
        .filter((x) => x.className.indexOf('italic') < 0);
      p = ps.length ? ps[ps.length - 1] : null;
    }
    return p ? p.textContent : null;
  },
  hasCursor() {
    const a = document.querySelector('article.neon-halo');
    return a ? a.querySelector('.typing-cursor') !== null : null;
  },
  /**
   * ★ 在**同一个 tick** 里同时取「界面上的正文」与「我们收到过的正文」。
   *
   * 为什么非要同一个 tick：切回空间之后，「重放补上的那一段」和「紧接着推来的新帧」
   * 会在几十毫秒内先后进入正文，分开两次取的话中间那几毫秒里到的推送就会混进来，
   * 于是「界面比推送多出来的那一段」这个差就什么都证明不了。
   * 页面侧 JS 是单线程的，函数体里没有 await —— 这两个值之间不会有任何东西插进来。
   *
   * 判据的形状：**推送只会让界面上的正文变长，永远不会让它超出自己**。
   * 所以只要某个瞬间「界面 > 推送」，多出来的那一段就**不可能**来自推送 ——
   * 剩下唯一的来源是重放（stream:resume 的返回，那是一次 invoke，不是推送）。
   */
  sync(turnId) {
    const a = document.querySelector('article.neon-halo');
    let p = null;
    if (a) {
      const c = a.querySelector('.typing-cursor');
      p = c ? c.closest('p') : null;
      if (!p) {
        const ps = Array.prototype.slice.call(a.querySelectorAll('p'))
          .filter((x) => x.className.indexOf('italic') < 0);
        p = ps.length ? ps[ps.length - 1] : null;
      }
    }
    return {
      t: Date.now(),
      card: a ? a.textContent : null,
      text: p ? p.textContent : null,
      pushText: this.pushText[turnId] || '',
      batches: this.pushCount[turnId] || 0
    };
  },
  // ⚠️ 有副作用：面板合着就点开。理由见 HELPERS 外面的第 3 条。
  liveThinking() {
    const a = document.querySelector('article.neon-halo');
    if (!a) return null;
    const btn = Array.prototype.slice.call(a.querySelectorAll('button'))
      .filter((b) => (b.textContent || '').indexOf('思考') >= 0)[0];
    if (!btn) return null;
    if (!a.querySelector('p.italic')) btn.click();
    const p = a.querySelector('p.italic');
    return p ? p.textContent : '';
  },
  // 在途 / 已落定各几张卡片
  cards() {
    return {
      live: document.querySelectorAll('article.neon-halo').length,
      done: document.querySelectorAll('article.neon-frame:not(.neon-halo)').length
    };
  },

  // ── 已落定的历史行 ──
  historyRows() {
    return Array.prototype.slice.call(
      document.querySelectorAll('article.neon-frame:not(.neon-halo)')
    ).map((a) => {
      const btn = Array.prototype.slice.call(a.querySelectorAll('button'))
        .filter((b) => (b.textContent || '').indexOf('思考') >= 0)[0];
      const p = a.querySelector('p.italic');
      return {
        hasThinkingButton: !!btn,
        thinkingOpen: !!p,
        thinkingText: p ? p.textContent : '',
        text: a.textContent
      };
    });
  },
  // 点开第 i 条历史行的思考面板。**返回点开之后的状态**，让调用方能立刻断言。
  openHistoryThinking(i) {
    const arts = Array.prototype.slice.call(
      document.querySelectorAll('article.neon-frame:not(.neon-halo)')
    );
    const a = arts[i];
    if (!a) return 'no-card';
    const btn = Array.prototype.slice.call(a.querySelectorAll('button'))
      .filter((b) => (b.textContent || '').indexOf('思考') >= 0)[0];
    if (!btn) return 'no-button';
    if (!a.querySelector('p.italic')) btn.click();
    return a.querySelector('p.italic') ? 'open' : 'still-closed';
  },
  /**
   * ★ 点开**第一条真的有思考按钮**的历史行，并把它收在第几条报回来。
   *
   * 为什么不能写死第 0 条：思考按钮的有无取决于**库里那一轮有没有 thinking 事件**
   * ——而那是端点的行为，不是界面的行为。本机这个端点上，同一个短轮次两次跑出来
   * 就不一样（一次库里一条 thinking 事件都没有、一次有两条）；于是「第 0 条」
   * 有时候有按钮、有时候没有，拿它当靶子得到的是端点行为，不是界面行为。
   *
   * 走查该问的是「历史行的思考面板点得开吗」，不是「第 0 条有没有按钮」。
   *
   * ⚠️ **返回的 stateAtClick 不是判据**，它只是诊断信息：btn.click() 是同步派发、
   * React 在**这一拍之后**才提交，所以在函数体里立刻回读 DOM 必然读到点击前的样子。
   * 这一条是被一次真机跑打脸的 —— 它回了 still-closed，而 200ms 之后那条历史行
   * 明明开着、里面 23 个字。判据要读**睡过一觉之后**的 historyRows()，
   * 报告那边就是从 before / after 两份快照里算的。
   */
  openFirstHistoryThinking() {
    const arts = Array.prototype.slice.call(
      document.querySelectorAll('article.neon-frame:not(.neon-halo)')
    );
    for (let i = 0; i < arts.length; i++) {
      const a = arts[i];
      const btn = Array.prototype.slice.call(a.querySelectorAll('button'))
        .filter((b) => (b.textContent || '').indexOf('思考') >= 0)[0];
      if (!btn) continue;
      const wasOpen = !!a.querySelector('p.italic');
      if (!wasOpen) btn.click();
      return {
        i: i,
        wasOpen: wasOpen,
        // 只作诊断：见上面那段警告。判据是睡过一觉之后的那份 historyRows()。
        stateAtClick: a.querySelector('p.italic') ? 'open' : 'still-closed'
      };
    }
    return { i: -1, wasOpen: false, stateAtClick: 'no-row-with-button' };
  },

  // ── 30Hz 隔离：DOM 改写计数器 ──
  //
  // 按改动**落在哪儿**分四桶，因为「该不该变」对这四处是不同的答案：
  //
  //   live     在途卡片（\`article.neon-halo\`）—— **该**被改写，不然就是流式断了
  //   history  已落定的助手卡片 —— 断言必须是 **0**
  //   list     消息列表本身（\`.grid-bg\`，把用户气泡也算进来）—— 断言必须是 **0**
  //   chrome   界面其余部分（顶栏的运行概要/成本、侧栏未读）—— **该**被改写
  //
  // ⚠️ 用户气泡**不是** \`article\`（\`MessageRow\` 里用户那一支渲染的是个 \`div\`），
  //    所以它落进 \`list\` 而不是 \`history\`。少了 \`list\` 这一桶，
  //    「用户那句话有没有被跟着重画」就没人看着了。
  watch() {
    if (window.__m7aObs) window.__m7aObs.disconnect();
    const acc = { live: 0, history: 0, list: 0, chrome: 0, byTarget: {}, from: Date.now() };
    function bucket(t) {
      const el = t && t.nodeType === 1 ? t : (t ? t.parentElement : null);
      if (!el || !el.closest) return 'chrome';
      const art = el.closest('article');
      if (art) return art.classList.contains('neon-halo') ? 'live' : 'history';
      return el.closest('.grid-bg') ? 'list' : 'chrome';
    }
    function desc(t) {
      const el = t && t.nodeType === 1 ? t : (t ? t.parentElement : null);
      if (!el) return '(text)';
      const cls = typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      return el.tagName.toLowerCase() + cls;
    }
    const obs = new MutationObserver(function (muts) {
      for (let i = 0; i < muts.length; i++) {
        const m = muts[i];
        const b = bucket(m.target);
        acc[b]++;
        const k = b + ' ' + m.type + ' @ ' + desc(m.target);
        acc.byTarget[k] = (acc.byTarget[k] || 0) + 1;
      }
    });
    obs.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true
    });
    window.__m7aObs = obs;
    window.__m7aObsAcc = acc;
    return 'watching';
  },
  watchStop() {
    if (window.__m7aObs) { window.__m7aObs.disconnect(); window.__m7aObs = null }
    const acc = window.__m7aObsAcc || { live: 0, history: 0, list: 0, chrome: 0, byTarget: {}, from: Date.now() };
    acc.ms = Date.now() - acc.from;
    return acc;
  }
};
'ok'
`

// ─────────────────────────────────────────────────────────────
// 应用进程：起、停、拉取
// ─────────────────────────────────────────────────────────────

let currentLabel = 'A'
let currentChild: ChildProcess | null = null
let pump: NodeJS.Timeout | null = null

function launch(label: string): void {
  if (!existsSync(ELECTRON_EXE)) throw new Error(`找不到 electron：${ELECTRON_EXE}`)
  if (!existsSync(OUT_MAIN)) {
    throw new Error(`找不到构建产物 ${OUT_MAIN} —— 先跑 \`npm run build\`（走查跑的是构建产物）`)
  }
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USERDATA}`, '.']
  // ★ 不传 `env`：那正是「原样继承」——凭据只经过子进程，走查从不读它。
  const child = spawn(ELECTRON_EXE, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  currentChild = child
  currentLabel = label
  rec({ kind: 'launch', label, pid: child.pid ?? null, args, userData: USERDATA, cwd: REPO })
  const sink = (which: 'stdout' | 'stderr') => (buf: Buffer) => {
    appendFileSync(join(runDir, `app-${label}.${which}.log`), buf.toString('utf8'), 'utf8')
  }
  child.stdout?.on('data', sink('stdout'))
  child.stderr?.on('data', sink('stderr'))
  say(`  应用 ${label} 起来了：pid=${child.pid ?? '?'}`)
}

function pidAlive(pid: number): boolean {
  if (!pid) return false
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' })
  return (r.stdout ?? '').includes(String(pid))
}

/**
 * 硬杀 —— 不给任何优雅退出的机会（Windows 上是 `TerminateProcess`）。
 *
 * ★ **只杀本脚本自己 spawn 出来的那个 pid**，不用 `/IM` 之类的模式匹配：
 * 模式匹配会顺手动到用户自己开着的那个窗口（甚至别的 Electron 应用）。
 * 采集器对自己的子进程负责，也只对它们负责。
 */
function hardKill(label: string): void {
  const child = currentChild
  if (!child?.pid) return
  const pid = child.pid
  spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' })
  rec({ kind: 'kill', label, pid, hard: true })
  say(`  ${label} 被硬杀（pid=${pid}）`)
  currentChild = null
  try {
    ws?.close()
  } catch {
    // 连接已经没了就算了
  }
  ws = null
}

/** 等进程真的退出：死掉与**库文件句柄被释放**之间有窗口，而下一个实例要开同一个库。 */
async function waitGone(pid: number, ms = 20000): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    if (!pidAlive(pid)) return true
    if (Date.now() - started > ms) return false
    await sleep(200)
  }
}

function startPump(): void {
  if (pump) clearInterval(pump)
  pump = setInterval(() => {
    void drain().catch(() => {
      // 页面没了（被硬杀）—— 不是错误，剩下的事实靠归档里已有的说话
    })
  }, 250)
}

function stopPump(): void {
  if (pump) clearInterval(pump)
  pump = null
}

/** 把页面攒下的推送拉进归档。**先落档、后返回**，所以 `wait*` 看得见它们。 */
async function drain(): Promise<void> {
  const raw = await evaluate('JSON.stringify(window.__m7a.drain())')
  if (typeof raw !== 'string') return
  const d = JSON.parse(raw) as {
    batch: Array<{ t: number; p: BatchLike }>
    status: Array<{ t: number; p: StatusLike }>
    unread: Array<{ t: number; p: { workspaceId: string; count: number } }>
    notice: Array<{ t: number; p: unknown }>
  }
  for (const b of d.batch) {
    rec({ kind: 'batch', label: currentLabel, pageT: b.t, payload: b.p })
    recPush('stream:batch', b.p)
  }
  for (const s of d.status) {
    rec({ kind: 'status', label: currentLabel, pageT: s.t, payload: s.p })
    recPush('stream:status', s.p)
  }
  for (const u of d.unread) {
    rec({ kind: 'unread', label: currentLabel, pageT: u.t, payload: u.p })
    recPush('workspace:unread', u.p)
  }
  for (const n of d.notice) rec({ kind: 'notice', label: currentLabel, pageT: n.t, payload: n.p })
}

/** 一次 IPC 调用。**请求、结果、耗时全部落档** —— 报告只读归档。 */
async function call<T = unknown>(tag: string, ch: string, payload: unknown): Promise<T> {
  const started = Date.now()
  const r = (await evaluate(
    `window.__m7a.call(${JSON.stringify(ch)}, ${JSON.stringify(payload === undefined ? null : payload)})`
  )) as { ok?: boolean; data?: T; error?: unknown } | null
  rec({ kind: 'ipc', label: currentLabel, tag, ch, req: payload ?? null, res: r ?? null, ms: Date.now() - started })
  if (!r || r.ok !== true) throw new Error(`IPC ${ch} 失败（${tag}）：${JSON.stringify(r?.error ?? r)}`)
  return r.data as T
}

async function domSnapshot(tag: string): Promise<void> {
  try {
    const text = await evaluate('window.__m7a.dom()')
    rec({ kind: 'dom', label: currentLabel, tag, text: typeof text === 'string' ? text.slice(0, 3000) : '' })
  } catch {
    // 页面没了就算了 —— DOM 只是旁证
  }
}

/**
 * 等一个条件成立。**不抛**：等不到本身就是要如实报告的事实。
 *
 * 判据可以是 async 的（有些判据要回页面里问一句），所以这里 `await` 它 ——
 * 少了这个 `await`，一个 `Promise` 永远是真值，条件就变成了「立刻成立」，
 * 而那样等出来的东西**看起来完全正常**。
 */
async function waitUntil(
  label: string,
  pred: () => boolean | Promise<boolean>,
  ms: number
): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    if (await pred()) return true
    if (Date.now() - started > ms) {
      say(`  ⏳ 等不到「${label}」（${ms}ms）`)
      return false
    }
    await sleep(POLL_MS)
  }
}

/**
 * 等这一轮的**终态行落库**，返回「done 帧到达渲染层 → 库里看见终态」的毫秒数
 * （`-1` 表示等到超时还没落）。
 *
 * ★ M6b 复用它的理由与 M6a 不同：这里量的是**界面折叠**与**库里落定**之间的关系。
 * `stream:status` 的终态推送与终态行也不是同一个事务 —— 界面在收到推送后丢缓冲、
 * 重读历史，而此刻库里那一行可能刚好落定或者刚好还没。这个窗口有多大，
 * 决定了「丢缓冲之后历史行能不能立刻接上」会不会露出空档。
 */
async function waitTerminal(tag: string, turnId: string, ms: number): Promise<number> {
  const from = Date.now()
  for (;;) {
    const row = await call<Record<string, unknown>>(`${tag}.poll`, 'turn:get', { id: turnId })
    const status = String(row?.status ?? '')
    if (status !== 'running' && status !== 'queued') {
      const lagMs = Date.now() - from
      rec({ kind: 'note', tag, text: status, lagMs })
      say(`  终态行在 done 帧之后 ${lagMs}ms 落库（status=${status}）`)
      return lagMs
    }
    if (Date.now() - from > ms) {
      rec({ kind: 'note', tag, text: `超时仍是 ${status}` })
      say(`  ⏳ 等到 ${ms}ms 终态行还是 ${status}`)
      return -1
    }
    await sleep(120)
  }
}

// ─────────────────────────────────────────────────────────────
// 界面驱动（M6b 特有的那一半）
// ─────────────────────────────────────────────────────────────

/** 点一下，并把「点了什么、结果如何」落档。**点不中不抛** —— 那是要如实报告的事实。 */
async function click(tag: string, sel: string, sub?: string): Promise<string> {
  const r = String(
    await evaluate(
      `window.__m7a.click(${JSON.stringify(sel)}, ${JSON.stringify(sub ?? null)})`
    )
  )
  rec({ kind: 'ui', label: currentLabel, tag, action: 'click', sel, sub: sub ?? null, result: r })
  return r
}

async function typeInto(tag: string, sel: string, value: string): Promise<string> {
  const r = String(await evaluate(`window.__m7a.type(${JSON.stringify(sel)}, ${JSON.stringify(value)})`))
  // 落档的是**长度**，不是正文：正文是提示词，没意思；而长度能说明「真的写进去了」。
  rec({ kind: 'ui', label: currentLabel, tag, action: 'type', sel, chars: value.length, result: r })
  return r
}

/**
 * ★ **重载渲染进程** —— 这是「夹具走 IPC、场景走界面」这个组合必须付的一次代价。
 *
 * 夹具是走 IPC 建的（见 `setup` 的说明），而**没有任何推送会告诉渲染层**
 * 「现在有空间了」。真实的用户是点着界面建的空间，那时 store 自然是新的；
 * 我们绕过了界面，于是界面还停在「一个空间都没有」的**首启空态**上 ——
 * 实测下来是：`TopBar` 整个不渲染（`headerName()` 得到 `null`、成本那一格不存在）、
 * 点「对话」什么也不会发生（没有输入区）。而这些**看起来都像 M6b 的缺陷**。
 *
 * 重载之后页面把库重新读一遍，夹具就全在界面上了 —— 与「用户点着建出来」
 * 在界面上完全等价。代价是 `window.__m7a` 随旧文档一起没了，所以要重新注入。
 *
 * ★ 这一步**没有**任何测试替身：它是真的重启了一次渲染进程。
 */
async function reloadRenderer(): Promise<void> {
  await evaluate('location.reload()').catch(() => undefined)
  const ok = await waitUntil(
    '页面重载完成（preload 桥回来）',
    async () => {
      try {
        return (await evaluate('typeof window.api?.invoke')) === 'function'
      } catch {
        return false
      }
    },
    30000
  )
  rec({ kind: 'note', tag: 'reload', text: String(ok) })
  if (!ok) throw new Error('页面重载之后 preload 桥没回来 —— 后面所有界面断言都无从谈起')
  await evaluate(HELPERS)
  await evaluate('window.__m7a.hook()')
  /**
   * ★ **桥回来 ≠ 界面画好了。** preload 在 React 挂载**之前**就注入了 `window.api`，
   * 所以我们上面那个判据会在一张**空 DOM** 上通过 —— 紧接着的「点左栏那个空间」
   * 就会落到 `not-found` 上（第一次干跑实测如此），而它看起来像「空间没建出来」。
   * 判据必须是**界面上真的有了东西**。
   */
  const painted = await waitUntil(
    '左栏画出来',
    async () => {
      try {
        return Number(await evaluate('window.__m7a.count("aside button")')) > 0
      } catch {
        return false
      }
    },
    20000
  )
  if (!painted) throw new Error('渲染进程重载之后左栏一直没画出来')
  say('  渲染进程重载完成，夹具已在界面上')
}

/** 打开对话视图：点顶栏的「对话」，等输入区真的出现。 */
async function openConversation(tag: string): Promise<boolean> {
  const clicked = await click(`${tag}.view`, 'header button', '对话')
  if (clicked !== 'clicked') {
    rec({ kind: 'note', tag: `${tag}.view`, text: `点不到「对话」按钮：${clicked}` })
    return false
  }
  const ok = await waitUntil('对话视图的输入区', () => liveHas('textarea'), 10000)
  rec({ kind: 'note', tag: `${tag}.pane`, text: String(ok) })
  await domSnapshot(`${tag}.pane`)
  return ok
}

/**
 * **把每一个要用的页面内辅助函数都跑一遍**，只记结果、不判。
 *
 * ★ 这是干跑里最值钱的一段：走查是**单向**的 —— 真机上任何一个辅助函数抛异常，
 * 都会让 `collect()` 在**已经花过钱**之后中断，而报告只剩下一半的场景。
 * 这些函数全是字符串里的页面侧代码，`tsc` 管不着，所以「跑一遍看看会不会炸」
 * 是唯一能在掏钱之前做完的检查。
 */
async function smokeHelpers(): Promise<void> {
  const probes = SMOKE_PROBES
  for (const [name, expr] of probes) {
    try {
      const v = await evaluate(expr)
      rec({ kind: 'note', tag: `dry.helper.${name}`, text: String(v), ok: true })
    } catch (err) {
      rec({
        kind: 'note',
        tag: `dry.helper.${name}`,
        text: err instanceof Error ? err.message : String(err),
        ok: false
      })
    }
  }
  say(`  页面内辅助函数 跑了 ${probes.length} 个（结果见归档里的 dry.helper.*）`)
}

/** 干跑要跑一遍的页面内辅助函数。**报告要拿它的条数做判据**，所以放在模块级。 */
const SMOKE_PROBES: Array<[string, string]> = [
  ['liveCard', 'window.__m7a.liveCard()'],
  ['liveText', 'window.__m7a.liveText()'],
  ['hasCursor', 'window.__m7a.hasCursor()'],
  ['liveThinking', 'window.__m7a.liveThinking()'],
  ['cards', 'JSON.stringify(window.__m7a.cards())'],
  ['historyRows', 'JSON.stringify(window.__m7a.historyRows())'],
  ['openHistoryThinking', 'window.__m7a.openHistoryThinking(0)'],
  // 场景 4 的靶子。干跑时页面上一条历史行都没有，所以它必然回 `no-row-with-button`
  // —— 那正是要的：这里验的是它**不炸**，不是它点得开。
  ['openFirstHistoryThinking', 'JSON.stringify(window.__m7a.openFirstHistoryThinking())'],
  ['usageText', 'window.__m7a.usageText()'],
  ['usageTitle', 'window.__m7a.usageTitle()'],
  ['headerName', 'window.__m7a.headerName()'],
  ['count', 'window.__m7a.count("textarea")'],
  // 一次完整的探针往返 —— `watchTurn` 每一拍都走这条路，它炸了整轮采集就断了
  [
    'probeLive',
    'JSON.stringify({card: window.__m7a.liveCard(), text: window.__m7a.liveText(),' +
      ' cursor: window.__m7a.hasCursor(), thinking: window.__m7a.liveThinking()})'
  ],
  ['watch', 'window.__m7a.watch()'],
  ['watchStop', 'JSON.stringify(window.__m7a.watchStop())'],
  // 场景 3 那条判据的唯一取数口。它炸了，最精确的那条断言就整条没测到。
  ['sync', 'JSON.stringify(window.__m7a.sync("dry-no-such-turn"))']
]

/** 页面上的一个布尔查询。页面没了（硬杀、正在关闭）时算「不在」—— 那是等的人该知道的事。 */
async function liveHas(sel: string): Promise<boolean> {
  try {
    return (await evaluate(`window.__m7a.has(${JSON.stringify(sel)})`)) === true
  } catch {
    return false
  }
}

/** 走界面发一轮：写进 textarea → 点「发送」。 */
async function sendViaUI(tag: string, prompt: string): Promise<void> {
  const typed = await typeInto(`${tag}.type`, 'textarea', prompt)
  const clicked = await click(`${tag}.send`, 'button', '发送')
  rec({
    kind: 'note',
    tag: `${tag}.send`,
    text: `typed=${typed} clicked=${clicked}`,
    chars: prompt.length
  })
  say(`  走界面发了一轮（输入 ${prompt.length} 字，typed=${typed}）`)
}

/**
 * 认领这一轮的 `turnId`。
 *
 * ★ 走界面发送时**没有 `turn:send` 的返回值**可用 —— 发送是渲染进程自己发的 IPC，
 * 走查看不见。所以 turnId 只能从**推送**里认：`stream:status` 的 `queued`
 * 或第一条 `stream:batch`。这正是 M6b 补上的那个生产者第一次被**走查**用上，
 * 它同时也证明了那条通道不再是死的。
 *
 * ★ `since` 是**必须**的：第二轮要找的是「**这次发送之后**新出现的」推送。
 * 不加这个下界，`recs.find` 会拿到第一轮的记录 —— 于是第二轮在走查眼里
 * 也叫 `turn-1`，而所有按 `turnId` 过滤的断言会静默地全部落在第一轮上。
 */
async function waitTurnId(
  tag: string,
  label: string,
  ms: number,
  since: number
): Promise<string | null> {
  const from = Date.now()
  for (;;) {
    const s = recs.slice(since).find((r) => r.kind === 'status' && r.label === label)
    const b = recs.slice(since).find((r) => r.kind === 'batch' && r.label === label)
    const viaStatus = (s?.payload as StatusLike | undefined)?.turnId
    const id = viaStatus ?? (b?.payload as BatchLike | undefined)?.turnId
    if (typeof id === 'string') {
      rec({ kind: 'note', tag, text: id, via: viaStatus === id ? 'status' : 'batch' })
      say(`  ${label} 的轮次 = ${id}（从 ${viaStatus === id ? 'status' : 'batch'} 推送里认出来的）`)
      return id
    }
    if (Date.now() - from > ms) {
      rec({ kind: 'note', tag, text: `等不到 ${label} 的任何推送` })
      say(`  ⏳ 等不到 ${label} 的轮次 id`)
      return null
    }
    await sleep(POLL_MS)
  }
}

// ─────────────────────────────────────────────────────────────
// 库转储
// ─────────────────────────────────────────────────────────────

function dumpDb(label: string, phase: string): void {
  if (!existsSync(DB)) {
    rec({ kind: 'note', label, text: `库还不存在，跳过转储 ${label}/${phase}` })
    return
  }
  const file = `db-${label}-${phase}.json`
  /**
   * ★ 转储**不许**把采集带崩。库此刻正被应用持着（WAL 模式下读是安全的，但
   * 任何一次读失败都不该让整轮走查白花钱）—— 失败就如实记进归档，
   * 报告那边会把缺的那份转储当成「没测到」，而不是「测到是坏的」。
   */
  let db: DatabaseSync
  try {
    db = new DatabaseSync(DB, { readOnly: true })
  } catch (err) {
    rec({
      kind: 'note',
      label,
      text: `打不开库做转储 ${label}/${phase}：${err instanceof Error ? err.message : String(err)}`
    })
    return
  }
  try {
    const tables = [
      'workspace',
      'project',
      'actor',
      'workspace_member',
      'member_project',
      'session',
      'turn',
      'message',
      'message_event'
    ]
    const dump: Record<string, unknown[]> = {}
    const counts: Record<string, number> = {}
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM ${t}`).all() as unknown[]
      dump[t] = rows
      counts[t] = rows.length
    }
    writeFileSync(join(runDir, file), JSON.stringify(dump, null, 2), 'utf8')
    rec({ kind: 'db', label, phase, file, counts })
    say(`  库转储 ${file}：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  } catch (err) {
    rec({
      kind: 'note',
      label,
      text: `转储 ${label}/${phase} 半途失败：${err instanceof Error ? err.message : String(err)}`
    })
  } finally {
    db.close()
  }
}

// ─────────────────────────────────────────────────────────────
// 采集期读取（与报告期共用同一套函数）
// ─────────────────────────────────────────────────────────────

function batchesOf(label: string, turnId?: string): BatchLike[] {
  return recs
    .filter((r) => r.kind === 'batch' && r.label === label)
    .map((r) => r.payload as BatchLike)
    .filter((b) => (turnId === undefined ? true : b.turnId === turnId))
}

function framesOf(label: string, turnId?: string): FrameLike[] {
  return batchesOf(label, turnId).flatMap((b) => b.frames)
}

/** 一批帧里 `text` 帧拼出来的正文 —— 与 `frame-buffer.ts` 里的追加规则同一句话。 */
function textOf(batches: readonly BatchLike[]): string {
  return batches.flatMap((b) => b.frames).filter((f) => f.k === 'text').map((f) => String(f.d)).join('')
}

// ─────────────────────────────────────────────────────────────
// 采集
// ─────────────────────────────────────────────────────────────

function prepareSandbox(): void {
  rmSync(SAND, { recursive: true, force: true })
  mkdirSync(USERDATA, { recursive: true })
  mkdirSync(SRC, { recursive: true })
  for (const [name, body] of Object.entries(SANDBOX_FILES)) {
    const abs = join(SRC, name)
    // `.claude/rules/notes.md` 这类嵌套路径要**先建目录** —— `writeFileSync` 不会替我们建。
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }
  writeFileSync(PERSONA, PERSONA_TEXT, 'utf8')

  /**
   * ★ 标记落档。**报告判据的一半来自这里** —— 目标是「模型复述的串与沙箱里写的那一串
   * 逐字相同」，而报告只读归档，所以四个标记必须进归档。
   * 它同时也是重放的依据：报告看的是哪一次采集，靠这一条对齐。
   */
  rec({ kind: 'markers', tag: 'markers', nonce: NONCE, markers: MARKERS, dir: SRC })

  rec({
    kind: 'note',
    tag: 'env',
    sand: SAND,
    userData: USERDATA,
    projectDir: SRC,
    model: MODEL,
    maxBudgetUsd: 0.5,
    text: `沙箱 ${SAND}（库 ${DB}，项目 ${SRC}）`
  })
  say(`  沙箱            ${SAND}`)
  say(`  标记后缀        ${NONCE}`)
  say(`  项目记忆文件    ${Object.keys(SANDBOX_FILES).filter((f) => f !== 'a.ts').join('、')}`)
  say(`  模型            ${MODEL}（端点 = 本机默认凭据所指向的那个，**不是 Anthropic 官方**）`)
  say('  预算闸          --max-budget-usd 0.50（turn-runner 的默认值，每轮一道）')
}

/**
 * ★ **零成本的静态核对**：装配的观测缝有没有真的接在组合根上。
 *
 * 它必须在这里做、而不是在报告里做，因为报告**只读归档** —— 一个「去读仓库源码」的报告
 * 在别的机器上重放同一份归档时会得到不同的结论。
 *
 * 它是静态的，所以**只值一句话**：`onContextBuilt` 真的有没有被 `main/index.ts` 转出去，
 * 要到真机上第一条 `[ctx]` 行出现才算验过。这条 note 的作用是**把最可能的那一种漏掉
 * 挡在花钱之前**（加了一个 `RuntimeOptions` 字段却忘了在组合根上传它 —— 这正是 M7a-3
 * 里 `textReader` 踩过的形状）。
 */
function staticWiringCheck(): void {
  const file = join(REPO, 'src', 'main', 'index.ts')
  const txt = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const found = txt.includes('onContextBuilt')
  rec({ kind: 'note', tag: 'dry.wiring', text: found ? 'wired' : 'MISSING', file })
  say(`  组合根接线      onContextBuilt ${found ? '在' : '**不在**'} ${file}`)
}

interface SetupIds {
  nova: { id: string; name: string }
  memberId: string
  sessionId: string
}

/**
 * 夹具：**走 IPC**（照 M6a / M6b）。
 *
 * ★ 这里刻意不点界面建空间 —— 夹具不是被测物。M7a 要测的是「发出去的上下文是什么」，
 * 把十个对话框点一遍换来的只有走查的脆弱。**该走界面的地方（打开对话、输入、发送）
 * 全部走界面**，见 `collect`。
 *
 * ★ 不给角色描述（`roleDescPath` 不传）是**故意的**：`role_desc_path` 可空，
 * 而「NULL 时 `<role>` 整块不出现、不是印一个空标签」是一条产品判决。
 * 真机上让夹具落在这个状态上，报告才能断它。非 NULL 的那条路在单测里
 * （`test/domain/context-builder.test.ts`）。
 */
async function setup(): Promise<SetupIds> {
  const nova = await call<{ id: string; name: string }>('setup.nova', 'workspace:create', { name: 'Nova' })
  const proj = await call<{ id: string }>('setup.project', 'project:addLocal', {
    workspaceId: nova.id,
    name: 'sandbox',
    rootPath: SRC
  })
  const actor = await call<{ id: string }>('setup.actor', 'actor:create', {
    name: 'Atlas',
    model: MODEL,
    personaPath: PERSONA,
    effort: 'low'
  })
  const member = await call<{ id: string }>('setup.member', 'member:create', {
    workspaceId: nova.id,
    actorId: actor.id,
    displayName: 'Atlas'
  })
  /**
   * ★ 这里不能用 `member:setPrimary`：它要求**先收窄可见项目**（「主项目必须是可见项目之一」），
   * 在一个还没配过可见性的成员上直接挂主项目会被拒（`E_CONFLICT`）。
   * `member:setVisibility` 一次把「可见集合 + 主项目」都定了。
   *
   * ★ 这一步同时决定了 `turn.cwd` —— 而 `cwd` 是场景 4 的整个靶子（cwd 的 `CLAUDE.md` 不注入）。
   */
  await call('setup.novaVisibility', 'member:setVisibility', {
    memberId: member.id,
    projectIds: [proj.id],
    primaryProjectId: proj.id
  })
  const session = await call<{ id: string } | null>('setup.session', 'session:getByMember', {
    memberId: member.id
  })
  if (!session) throw new Error('member:create 之后没有会话 —— 这与「会话与成员同生」的契约矛盾')

  /**
   * ★ 视图必须真的切到 Nova：合批器按 `ActiveView.workspaceId` 抑制，
   * 而视图是**内存态**（每次启动都是 null，不落库），所以每次启动都要重设一遍。
   * 漏了这一步，第一批就会被合法地抑制掉，而现象看起来像「流式没通」。
   */
  await call('setup.view', 'view:setActive', { workspaceId: nova.id, sessionId: session.id })

  const ids: SetupIds = { nova, memberId: member.id, sessionId: session.id }
  rec({ kind: 'note', tag: 'ids', text: JSON.stringify(ids) })
  return ids
}

// ─────────────────────────────────────────────────────────────
// ★ M7a 新增的观测通道：主进程的两条流
// ─────────────────────────────────────────────────────────────

/** 已经进过归档的 `[ctx]` 行（按 turnId 去重，跨多次调用）。 */
const seenCtx = new Set<string>()
const seenWarn = new Set<string>()

/**
 * 把主进程 stdout 里的 `[ctx] {json}` 行拉进归档。
 *
 * ★ 为什么是**主进程的 stdout**：`onContextBuilt` 是主进程里的一个回调，走查与它不在同一个
 * 进程里、也拿不到它的返回值。而「主进程的 `console.log` 会落进 `app-<label>.stdout.log`」
 * 这一条**不是猜的** —— M6b 的归档里 `[main] 数据库已就绪：…` 就在那个文件里
 * （`scripts/evidence/m6b-2026-09-23T15-37-47-776Z/app-A.stdout.log`）。
 *
 * ★ 重试是必须的：stdout 是**管道**，写入到落盘之间有一次刷新。
 * 那一行在装配时（CLI 还没启动）就已经写了，所以正常情况下它比终态早得多 —— 但归档里
 * 「没测到」与「测到是坏的」是两回事（§8.8e 规则三），所以这里要**等一下**再说没有。
 */
async function pullAppCtx(label: string): Promise<void> {
  const file = join(runDir, `app-${label}.stdout.log`)
  for (let i = 0; i < 12; i++) {
    if (existsSync(file)) {
      let got = 0
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const s = line.trim()
        if (!s.startsWith('[ctx] ')) continue
        try {
          const d = JSON.parse(s.slice('[ctx] '.length)) as { turnId?: unknown; shape?: unknown }
          const id = String(d.turnId ?? '')
          if (!id || seenCtx.has(id)) continue
          seenCtx.add(id)
          rec({ kind: 'ctx', label, turnId: id, shape: d.shape })
          got++
        } catch {
          // 半行（正好在写入中途读到）—— 下一拍再读
        }
      }
      if (got > 0) {
        say(`  装配形状        拉了 ${got} 条 [ctx] 进归档`)
        return
      }
    }
    await sleep(250)
  }
  rec({ kind: 'note', tag: 'ctx-missing', label, text: `等不到 ${label} 新出现的 [ctx] 行` })
  say('  ⚠️ 等不到新的 [ctx] 行 —— 观测通道本身可能没通')
}

/**
 * 把主进程 stderr 里的 `[runtime:<tag>] …` 行拉进归档。
 *
 * 它是**已有的**通道（M6a/M6b 的 `adapter-diag:*` 就走这里），M7a 白捡两件事：
 * - **该出现的**：`context:cwd-claude-md-suppressed` —— §8.5c 性质 5 要求「剔了什么」可见，
 *   而这是它在**生产路径**上真的被说出来的证据（单测只能证明那个函数返回了 note）。
 * - **不该出现的**：`history-window-capped` 之类。
 *
 * ⚠️ 按（tag + 行首一段）去重：同一条 info note 每一轮都会重发一次，而报告问的是「在不在」。
 */
async function pullAppWarn(label: string): Promise<void> {
  const file = join(runDir, `app-${label}.stderr.log`)
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s.startsWith('[runtime:')) continue
    const end = s.indexOf(']')
    if (end < 0) continue
    const tag = s.slice('[runtime:'.length, end)
    const key = `${tag}|${s.slice(end + 1, end + 90)}`
    if (seenWarn.has(key)) continue
    seenWarn.add(key)
    rec({ kind: 'warn', label, tag, line: s.slice(0, 400) })
  }
}

/**
 * 等一轮跑完，然后把这一轮能拉的两条主进程通道拉进归档。
 *
 * 顺序是硬的：**先 done 帧 → 再终态推送 → 再睡觉 → 再拉主进程**。
 * 最后那个 `sleep` 不是保险，是给两件事留时间：界面把缓冲折成历史行
 * （下一轮的 `listRecentBySession` 要读它），以及 `[ctx]` 那行落盘。
 */
async function settle(tag: string, label: string, turnId: string): Promise<boolean> {
  const gotDone = await waitUntil(
    `${tag}.done`,
    () => framesOf(label, turnId).some((f) => f.k === 'done'),
    180000
  )
  rec({ kind: 'note', tag: `${tag}.done-frame`, text: String(gotDone) })
  await drain()
  await waitTerminal(`${tag}.terminal`, turnId, 15000)
  await sleep(700)
  await drain()
  await pullAppCtx(label)
  await pullAppWarn(label)
  return gotDone
}

async function collect(dir: string): Promise<void> {
  runDir = dir
  mkdirSync(runDir, { recursive: true })

  rule('M7a 走查 · 准备')
  prepareSandbox()

  rule('启动 A · 装配')
  launch('A')
  await connectCdp()
  await evaluate(HELPERS)
  const hooked = await evaluate('window.__m7a.hook()')
  rec({ kind: 'note', tag: 'hooked', text: String(hooked) })
  startPump()
  await sleep(700)
  await domSnapshot('A:startup')

  const ids = await setup()
  dumpDb('A', 'setup')
  // ★ 夹具是走 IPC 建的，界面还不知道 —— 重载一次让库重新读进 store（见 `reloadRenderer`）。
  await reloadRenderer()
  const picked = await click('A:pickNova', 'aside button', 'Nova')
  rec({ kind: 'note', tag: 'A:pickNova', text: picked })
  await sleep(400)

  if (DRY) {
    /**
     * 干跑自检：桥在构建版里暴露了吗？对话视图打得开吗？输入区在吗？
     * 以及 M7a 独有的那一条：**观测缝接上了吗**（静态核对，见 `staticWiringCheck`）。
     *
     * ★ 说清楚干跑**测不到**什么：`[ctx]` 那条通道要**真跑一轮**才会有内容 ——
     * 装配只在轮次里发生。所以干跑能挡的是「接线漏了」这一类，挡不住「那一行的格式错了」。
     * 那一条要等真机上第一条 `[ctx]` 行才算验过（`report()` 把它当成第一等判据）。
     */
    staticWiringCheck()
    const before = await evaluate(
      'JSON.stringify({' +
        'api: typeof window.api?.invoke, on: typeof window.api?.on, hooked: window.__m7a.hooked,' +
        'header: window.__m7a.headerName()' +
        '})'
    )
    rec({ kind: 'note', tag: 'dry.before', text: String(before) })
    say(`  干跑探针（概览）  ${String(before)}`)

    const opened = await openConversation('A:dry')
    const after = await evaluate(
      'JSON.stringify({textarea: window.__m7a.has("textarea"), send: window.__m7a.count("button")})'
    )
    rec({ kind: 'note', tag: 'dry.after', text: String(after), opened })
    say(`  干跑探针（对话）  ${String(after)}`)

    /**
     * ★ 零成本地验一次**发送路径上最脆的那一环：受控输入**（照 M6b）。
     * 直接 `el.value = x` 在 React 里**不触发** `onChange` —— 输入框看着有字、
     * `text` 状态还是空的、点「发送」什么也不会发生，而现象是「点了没反应」。
     * 真判断「React 收到了没有」的信号是**发送按钮从 disabled 变成可点**。
     *
     * ⚠️ 这里**只输入、不点发送** —— 点了就是一轮真 CLI，那就是花钱了。
     */
    const typedProbe = await typeInto('A:dry', 'textarea', '干跑：只验输入，不发送')
    await sleep(200)
    const sendBtn = await evaluate(
      '(function(){var b=Array.prototype.slice.call(document.querySelectorAll("button"))' +
        '.filter(function(e){return (e.textContent||"").indexOf("发送")>=0})[0];' +
        'return b ? b.disabled : null})()'
    )
    rec({ kind: 'note', tag: 'dry.type', text: String(sendBtn), typed: typedProbe })
    say(`  受控输入       typed=${typedProbe}，发送按钮 disabled=${String(sendBtn)}（应为 false）`)
    await typeInto('A:dry', 'textarea', '')

    await smokeHelpers()

    stopPump()
    const pidDry = currentChild?.pid ?? 0
    hardKill('A')
    await waitGone(pidDry)
    rule('干跑结束（**没有发起任何轮次，没花钱**）')
    say('  地基这一层：构建产物起得来、CDP 连得上、preload 桥在构建版里可用、夹具走 IPC 全过、')
    say('  对话视图打得开、输入区与发送按钮都在、组合根上接了 onContextBuilt。')
    say('  ⚠️ **没测到**：`[ctx]` 那条观测通道要真跑一轮才有内容 —— 那是下一句的事。')
    say('  下一句才是真机：npm run walk:m7a（真花钱，2 轮）。')
    return
  }

  // ══ 第一轮 ════════════════════════════════════════════════
  rule('第一轮 · 走界面发一轮（不用工具 + 复述标记 + 编一个 4 位数字）')
  const opened = await openConversation('A:r1')
  rec({ kind: 'note', tag: 'A:r1.opened', text: String(opened) })

  const since1 = recs.length
  await sendViaUI('A:r1', PROMPT_R1)
  const turn1 = await waitTurnId('A:r1.turnId', 'A', 30000, since1)
  if (turn1 === null) throw new Error('点了发送，但既没有 stream:status 也没有 stream:batch —— 消息没发出去')
  await waitUntil('轮次 1 的第一批', () => batchesOf('A', turn1).length > 0, 180000)
  await drain()
  await settle('A:r1', 'A', turn1)
  await domSnapshot('A:after-r1')
  dumpDb('A', 'after-r1')

  // ══ 第二轮：同一个会话、同一个成员 ══════════════════════════
  rule('第二轮 · 同一个会话问第一轮的事（历史数组唯一能提供答案）')
  const since2 = recs.length
  await sendViaUI('A:r2', PROMPT_R2)
  const turn2 = await waitTurnId('A:r2.turnId', 'A', 30000, since2)
  if (turn2 === null) throw new Error('第二轮没有推送 —— 消息没发出去')
  await waitUntil('轮次 2 的第一批', () => batchesOf('A', turn2).length > 0, 180000)
  await drain()
  await settle('A:r2', 'A', turn2)
  await domSnapshot('A:after-r2')
  dumpDb('A', 'after-r2')

  rec({ kind: 'note', tag: 'ids.final', text: JSON.stringify({ ...ids, turn1, turn2 }) })

  // ── 收尾：让它走一次正常退出（硬杀重开那一条 M6a/M6b 已经覆盖了）──
  rule('收尾 · 让 A 正常退出')
  const pidA = currentChild?.pid ?? 0
  let graceful = false
  try {
    await evaluate('window.close()')
    graceful = await waitGone(pidA, 10000)
  } catch {
    graceful = false
  }
  rec({ kind: 'note', tag: 'A:graceful-exit', text: String(graceful) })
  stopPump()
  if (graceful) {
    currentChild = null
    ws = null
  } else {
    hardKill('A')
    await waitGone(pidA)
  }
  say(`  A ${graceful ? '正常退出' : '没能正常退出（已硬杀）'} —— 这一条会如实进报告`)

  rule('采集结束')
  say(`  归档目录：${runDir}`)
}
// ─────────────────────────────────────────────────────────────
// 报告（**只是归档的函数**）
// ─────────────────────────────────────────────────────────────

let failures = 0
let unknowns = 0

/** 三态，照 `m5-probe.ts` 的 `check`：**「没测到」与「测到是坏的」是两回事**。 */
function check(level: 'ok' | 'bad' | 'unknown', text: string): void {
  if (level === 'bad') failures++
  if (level === 'unknown') unknowns++
  const mark = level === 'ok' ? '✅' : level === 'bad' ? '❌' : '⚠️'
  say(`  ${mark} ${text}`)
}

function loadArchive(dir: string): void {
  runDir = dir
  recs = []
  const file = join(dir, 'events.jsonl')
  if (!existsSync(file)) throw new Error(`归档里没有 events.jsonl：${file}`)
  let bad = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      recs.push(JSON.parse(line) as Rec)
    } catch {
      bad++
    }
  }
  if (bad > 0) say(`  ⚠️ events.jsonl 里有 ${bad} 行不是 JSON（崩在写一半），已跳过`)
}

function pick(kind: string, tag?: string): Rec | undefined {
  return recs.find((r) => r.kind === kind && (tag === undefined || r.tag === tag))
}

function dumpOf(label: string, phase: string): Record<string, Array<Record<string, unknown>>> | undefined {
  const p = join(runDir, `db-${label}-${phase}.json`)
  if (!existsSync(p)) return undefined
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, Array<Record<string, unknown>>>
}
/**
 * 干跑的报告。**它只判「地基」** —— 零成本那一层能测到的东西。
 *
 * ★ §8.8e 规则三：**缺证据不许印成 ✅**。M6b 第一次干跑的版本只看了「有没有 error」，
 * 于是它在「顶栏压根没渲染、输入区根本不存在」的情况下印了一句「干跑干净」。
 * 这里同形地多加一条：**观测缝的接线**（静态核对，见 `staticWiringCheck`）。
 *
 * ★ 也要说清楚它**测不到**什么：`[ctx]` 那条通道要真跑一轮才有内容 ——
 * 装配只在轮次里发生。干跑挡得住「接线漏了」，挡不住「那一行格式错了」。
 */
function reportDry(): number {
  failures = 0
  unknowns = 0

  rule('干跑：只判地基（零成本，一个轮次都没发）')
  for (const e of recs.filter((r) => r.kind === 'error')) {
    check('bad', `采集器记到一条错误：[${String(e.tag ?? '?')}] ${String(e.message ?? '')}`)
  }

  const probe = (tag: string): Record<string, unknown> => {
    const r = pick('note', tag)
    try {
      return JSON.parse(String(r?.text ?? '{}')) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const before = probe('dry.before')
  const after = probe('dry.after')
  const reloaded = String(pick('note', 'reload')?.text) === 'true'

  check(
    before.api === 'function' && before.on === 'function' ? 'ok' : 'bad',
    `preload 桥在**构建产物**里可用（invoke=${String(before.api)} on=${String(before.on)}）—— ` +
      'dev 能跑不等于构建版能跑，走查跑的是构建版'
  )
  check(reloaded ? 'ok' : 'bad', '渲染进程重载之后桥又回来了（重载是夹具改成界面可见的唯一手段）')
  check(
    before.hooked === true ? 'ok' : 'bad',
    '推送钩子装上了（`stream:batch` / `stream:status` / `workspace:unread` / `app:notice`）'
  )
  check(
    String(pick('note', 'A:pickNova')?.text) === 'clicked' ? 'ok' : 'bad',
    '在左栏点得中空间（装配出来的空间在界面上真的存在）'
  )
  check(
    typeof before.header === 'string' && before.header !== '' && before.header !== 'null'
      ? 'ok'
      : 'bad',
    `顶栏渲染出来了、而且显示的是被选中的那个空间的名字：${String(before.header)}`
  )
  check(
    String(pick('note', 'dry.after')?.opened) === 'true' && after.textarea === true ? 'ok' : 'bad',
    `点「对话」真的打开了对话视图、输入区在里面（textarea=${String(after.textarea)}）`
  )
  check(Number(after.send) >= 1 ? 'ok' : 'bad', `发送按钮在（页面上共 ${String(after.send)} 个 button）`)

  const typedResult = pick('note', 'dry.type')
  check(
    typedResult?.typed === 'typed' && String(typedResult?.text) === 'false' ? 'ok' : 'bad',
    `受控输入：写进 textarea = ${String(typedResult?.typed)}，发送按钮因此变为可点（disabled=${String(typedResult?.text)}）` +
      ' —— `disabled` 还是 true 就说明 React 没收到 onChange，点了发送也不会有任何事发生'
  )

  /**
   * ★ M7a 独有的那一条地基：**装配的观测缝有没有接在组合根上**。
   * 它是静态的（读 `src/main/index.ts` 的源码），所以只值「接线在不在」这一个问题 ——
   * 但漏掉它，真机那一趟就是在**没有观测通道**的情况下花钱。
   */
  const wired = String(pick('note', 'dry.wiring')?.text ?? '')
  check(
    wired === 'wired' ? 'ok' : 'bad',
    `组合根上接了 \`onContextBuilt\`（${String(pick('note', 'dry.wiring')?.file ?? '?')}）—— ` +
      '**静态核对**：它不证明那一行的运行时格式对，只证明没忘了接'
  )

  const helperRecs = recs.filter((r) => r.kind === 'note' && String(r.tag).startsWith('dry.helper.'))
  const helperBad = helperRecs.filter((r) => r.ok !== true)
  check(
    helperRecs.length === SMOKE_PROBES.length && helperBad.length === 0 ? 'ok' : 'bad',
    `页面内辅助函数全跑通（${helperRecs.length}/${SMOKE_PROBES.length} 个）` +
      (helperBad.length > 0
        ? ` —— 这几个炸了：${helperBad.map((r) => `${String(r.tag).replace('dry.helper.', '')}(${String(r.text)})`).join(' ')}`
        : '') +
      '；它们在真机上抛一次就会让采集在**已经花过钱之后**中断'
  )

  check(
    'unknown',
    '⚠️ **干跑测不到**：`[ctx]` 那条观测通道要真跑一轮才有内容（装配只在轮次里发生）—— ' +
      '它是真机第一件事，`report()` 把它当第一等判据'
  )

  rule('干跑结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '地基干净，可以花真钱了（npm run walk:m7a）' : `${failures} 条不通过 —— **先修地基，再花真钱**`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  return failures
}

// ─────────────────────────────────────────────────────────────
// 报告期读取（只读归档：`events.jsonl` + `batches.jsonl` + `db-*.json`）
// ─────────────────────────────────────────────────────────────

/** 磁盘上那个 `ContextShape`。报告读的是 JSON，所以这里是一份**结构描述**，不是那个类型。 */
interface ShapeLike {
  messageCount: number
  contentChars: number
  systemPromptChars: number
  historyTotal: number
  historyIncluded: number
  historySuppressed: number
  compactedThroughSeq: number
  projectFiles: number
  projectFileBytes: number
  suppressedAutoInjected: number
  personaBytes: number | null
  roleDescBytes: number | null
}

/** 归档里这一轮的装配形状。**没有** ⇔ `onContextBuilt` 那条通道没通。 */
function shapeOf(turnId: string): ShapeLike | null {
  const r = recs.find((x) => x.kind === 'ctx' && x.turnId === turnId)
  return r ? (r.shape as ShapeLike) : null
}

/** 一轮的 `usage` 帧汇总。**没有帧**与「帧里全是 0」是两回事，所以返回 `null` 而不是零值。 */
function usageOf(label: string, turnId: string): { frames: number; cacheRead: number } | null {
  const us = framesOf(label, turnId).filter((f) => f.k === 'usage')
  if (us.length === 0) return null
  return {
    frames: us.length,
    cacheRead: us.reduce((a, f) => a + Number(f.cacheRead ?? 0), 0)
  }
}

type Dump = Record<string, Array<Record<string, unknown>>>

/** 这一轮的消息 id 集合（`message_event` 只带 `message_id`，没有 `turn_id`）。 */
function messageIdsOf(dump: Dump, turnId: string): Set<string> {
  return new Set(
    (dump.message ?? []).filter((m) => m.turn_id === turnId).map((m) => String(m.id))
  )
}

/**
 * 这一轮用了几个工具（`tool_start` 事件数）。
 *
 * ★ 它是场景 4 那两条行为判据的**前提**，不是一个附带指标：模型一旦自己去读了
 * `CLAUDE.md`，「它复述了标记」就不再说明「CLI 把它带进了上下文」。
 * 前提不成立时那两条判**降级成 `unknown`**，不许照印 ✅。
 */
function toolStartsOf(dump: Dump | undefined, turnId: string): number | null {
  if (!dump) return null
  const ids = messageIdsOf(dump, turnId)
  return (dump.message_event ?? []).filter(
    (e) => ids.has(String(e.message_id)) && e.kind === 'tool_start'
  ).length
}

/** 从一段正文里取「模型自己编的那个 4 位数字」：优先 `NUM=dddd`，否则退到最后一个 4 位数。 */
function inventedNumber(text: string): string | null {
  const tagged = /NUM=\s*(\d{4})/.exec(text)
  if (tagged) return tagged[1]
  const all = text.match(/\b\d{4}\b/g)
  return all && all.length > 0 ? all[all.length - 1] : null
}

function report(): number {
  failures = 0
  unknowns = 0

  const ids = (() => {
    try {
      return JSON.parse(String(pick('note', 'ids')?.text ?? '{}')) as {
        nova?: { id: string }
        sessionId?: string
      }
    } catch {
      return {}
    }
  })()
  const markersRec = pick('markers', 'markers') as
    | (Rec & { nonce?: string; markers?: Record<string, string> })
    | undefined
  const markers = markersRec?.markers ?? {}
  const nonce = String(markersRec?.nonce ?? '')
  const r1Marker = `MK7A-R1-${nonce}`

  const turn1 = String(pick('note', 'A:r1.turnId')?.text ?? '')
  const turn2 = String(pick('note', 'A:r2.turnId')?.text ?? '')
  const text1 = turn1 ? textOf(batchesOf('A', turn1)) : ''
  const text2 = turn2 ? textOf(batchesOf('A', turn2)) : ''
  const dump1 = dumpOf('A', 'after-r1')
  const dump2 = dumpOf('A', 'after-r2')

  rule('环境（端点限定语写在最前面）')
  say(`  归档            ${runDir}`)
  say(`  沙箱            ${String(pick('note', 'env')?.sand ?? '?')}`)
  say(`  模型            ${String(pick('note', 'env')?.model ?? '?')}（端点 = 本机默认凭据所指向的那个）`)
  say(`  标记后缀        ${nonce || '（归档里没有 markers 记录）'}`)
  say(`  第一轮 turnId   ${turn1 || '（没有）'}`)
  say(`  第二轮 turnId   ${turn2 || '（没有）'}`)
  say('  ⚠️ 全部结论只在**本机默认凭据所指向的那个端点**下成立，不是 Anthropic 官方行为。')

  check(
    markersRec !== undefined ? 'ok' : 'bad',
    '归档里有四个标记（`markers` 记录）—— 报告的一半判据是「模型复述的串与沙箱里那一串逐字相同」，' +
      '丢了它就等于丢了判据'
  )

  // ══ 观测通道 ═══════════════════════════════════════════════
  rule('观测通道 · 装配形状有没有真的出来')
  const ctxRecs = recs.filter((r) => r.kind === 'ctx')
  check(
    ctxRecs.length > 0 ? 'ok' : 'bad',
    `主进程 stdout 里的 \`[ctx]\` 行拉到了 ${ctxRecs.length} 条` +
      (ctxRecs.length === 0
        ? ' —— **这条通道没通**，下面所有装配断言都无从谈起（先查 `main/index.ts` 的 `onContextBuilt`）'
        : '')
  )

  // ══ 第一轮 ═══════════════════════════════════════════════
  rule('第一轮 · 装配（人设 / 系统提示词 / 项目记忆）')
  const s1 = turn1 ? shapeOf(turn1) : null
  const s2 = turn2 ? shapeOf(turn2) : null

  check(
    turn1 !== '' && text1.length > 0 ? 'ok' : 'bad',
    `第一轮跑完了、有正文（${text1.length} 字）`
  )
  if (!s1) {
    check('bad', '第一轮没有装配形状 —— 观测通道没通，下面这一整段都判不了')
  } else {
    check(
      s1.personaBytes !== null && s1.personaBytes > 0 ? 'ok' : 'bad',
      `★ 人设文件**真的进了上下文**（${String(s1.personaBytes)} 字节）—— ` +
        '`persona_path` 是角色的唯一身份来源；读不到时 `turn-runner` 会让这一轮直接失败'
    )
    /**
     * ★ 这一条是 **M6a 的回归判据**：M6a 那一版往 CLI 传的 `systemPrompt` 是**空串**。
     * 「非空」在这里不是修辞，它是「`<persona>`/`<role>`/协作协议真的拼出来了」。
     */
    check(
      s1.systemPromptChars > 0 ? 'ok' : 'bad',
      `★ 系统提示词非空（${s1.systemPromptChars} 字）—— M6a 那一版是空串，这是回归判据`
    )
    check(
      s1.roleDescBytes === null ? 'ok' : 'bad',
      `角色描述没配 ⇒ \`roleDescBytes === null\`（实得 ${JSON.stringify(s1.roleDescBytes)}）—— ` +
        '`role_desc_path` 可空，NULL 时 `<role>` 要**整块不出现**，不是印一个空标签'
    )
    check(
      s1.compactedThroughSeq === 0 ? 'ok' : 'bad',
      `第一轮的水位线是 0（实得 ${s1.compactedThroughSeq}）—— 一次压缩都还没发生过`
    )
    check(
      s1.historyIncluded === 1 && s1.historyTotal === 1 && s1.messageCount === 2
        ? 'ok'
        : 'bad',
      `第一轮的历史只有**本轮那一条触发消息**（historyIncluded=${s1.historyIncluded} / ` +
        `historyTotal=${s1.historyTotal} / messageCount=${s1.messageCount}，期望 1 / 1 / 2）`
    )
    // ── 场景 4 的「我们这一半」：cwd 的 CLAUDE.md 没进我们拼的 <project_context> ──
    /**
     * ★ 判到的是**计数**，不是**文件名清单** —— `ContextShape` 里没有 `relPaths`
     * （`onContextBuilt` 只传 shape，不含正文，也不含文件身份）。
     * 所以「剔掉的正是那两个」这一步靠的是：沙箱里**可被自动注入的候选恰好只有那两个**
     * （`AUTO_INJECTED_FROM_CWD` 就是一个二元集合），外加 `context:cwd-claude-md-suppressed`
     * 那条 warn 的 tag 名把语义钉住了。**身份**这一层是构造推出来的，不是归档记下来的。
     */
    check(
      s1.suppressedAutoInjected === 2 && s1.projectFiles === 2 ? 'ok' : 'bad',
      `★ cwd 的 \`CLAUDE.md\` 与 \`.claude/CLAUDE.md\` **没进**我们拼的 \`<project_context>\`：` +
        `suppressedAutoInjected=${s1.suppressedAutoInjected}（期望 2）、projectFiles=${s1.projectFiles}（期望 2：` +
        '`AGENTS.md` 与 `.claude/rules/notes.md`）—— 这就是「cwd 的 CLAUDE.md 只进一遍」里**我们负责的那一半**' +
        '（★ 归档只记计数，不记文件名：那几个文件名是从沙箱构造 + `AUTO_INJECTED_FROM_CWD` 这个二元集合推出来的）'
    )
    check(
      s1.projectFileBytes > 0 ? 'ok' : 'bad',
      `项目记忆的字节数非零（${s1.projectFileBytes} 字节）—— 0 的话说明用户的项目记忆一条都没进`
    )
  }

  // ══ 场景 4 的「CLI 那一半」：标记复述 ═════════════════════
  rule('第一轮 · CLI 有没有把 cwd 的项目记忆自己带进来（标记判据）')
  const tools1 = toolStartsOf(dump1, turn1)
  check(
    tools1 === 0 ? 'ok' : 'unknown',
    tools1 === null
      ? '没有库转储，判不了这一轮用没用工具 —— 下面的复述判据一律降级'
      : tools1 === 0
        ? '★ 第一轮**一个工具都没用**（tool_start=0）—— 这是下面四条判据成立的前提'
        : `⚠️ 第一轮用了 ${tools1} 个工具 ⇒ 它可能**自己读到了**那些文件，` +
          '于是「复述了标记」不再说明「CLI 把它带进了上下文」。下面四条一律降级成「无法判定」'
  )

  const recite = (key: string, label: string, why: string): void => {
    const marker = String(markers[key] ?? '')
    if (!marker) {
      check('bad', `${label}：归档里没有这个标记，判不了`)
      return
    }
    const seen = text1.includes(marker)
    if (tools1 !== 0) {
      check('unknown', `${label}（${why}）—— 前提不成立（用过工具），无法判定`)
      return
    }
    check(
      seen ? 'ok' : 'bad',
      `${label}：模型${seen ? '逐字复述了' : `**没有**复述`} \`${marker}\` —— ${why}`
    )
  }

  /**
   * ★ 四条标记判据的**强度是不同的**，所以每条都自带一句「所以它说明什么」：
   * 前两条我们剔了（只能来自 CLI）、第三条两边都可能带（不可判）、第四条是阳性对照。
   */
  recite('cwd', 'cwd 的 CLAUDE.md', '我们剔了它，提示词里没有这一串 ⇒ 来源只能是 CLI 自己带的')
  recite(
    'dotclaude',
    'cwd 的 .claude/CLAUDE.md',
    '★ 探针没定论的那一条：我们剔了它。复述 ⇒ CLI 确实会注入它（剔除是对的）；' +
      '没复述 ⇒ 这份文件**两边的路都没走通**（我们剔了、CLI 也没带），内容真的丢了'
  )
  recite('agents', 'AGENTS.md', '我们注入了它，但 CLI 也可能带 ⇒ 复述只说明「至少有一份进去了」，分不清是谁的')
  const rulesMarker = String(markers['rules'] ?? '')
  const controlOk = rulesMarker !== '' && text1.includes(rulesMarker)
  check(
    tools1 !== 0 ? 'unknown' : controlOk ? 'ok' : 'bad',
    `★ **阳性对照**：我们注入的 \`.claude/rules/notes.md\` 标记（\`${rulesMarker}\`）` +
      `${controlOk ? '被复述了' : '**没被复述**'} ⇒ ` +
      (controlOk
        ? '`<project_context>` 这条注入缝真的通了，上面几条「没被注入」的结论才有依据'
        : '**装配这一侧是坏的** ⇒ 上面各条「cwd 的 CLAUDE.md 没被注入」的结论**据此不可信**')
  )

  // ══ 第二轮 ═══════════════════════════════════════════════
  rule('第二轮 · 它记不记得第一轮（本里程碑的头号验收）')
  check(turn2 !== '' && text2.length > 0 ? 'ok' : 'bad', `第二轮跑完了、有正文（${text2.length} 字）`)

  const num = inventedNumber(text1)
  /**
   * ★ 触发行的取法：**不能按 `message.turn_id` 找**。
   *
   * `handlers/turn.ts:54/64` 的顺序是「先 `message.append`（用户那句话），再 `turn.create`」
   * —— 所以用户那一行的 `turn_id` 是 **NULL**（写它的时候轮次还不存在），
   * 指回来的方向是 `turn.trigger_message_id`。
   *
   * 第一版按 `turn_id === turn1 && role === 'user'` 过滤，**恒为空**；而空串会让下面两条
   * 判据降级成 ⚠️，于是一个「取不到」被读成「没测到」—— 本里程碑的头号验收就这样
   * 被自己的报告工具吃掉了（模型明明答对了 `NUM=`）。这正是 §8.9-9 那个形状：
   * 一个错的答案不会自己消失，它只是等着第一个调用方来捡。
   */
  const trigger1 = (() => {
    const tid = (dump1?.turn ?? []).find((t) => t.id === turn1)?.trigger_message_id
    if (typeof tid !== 'string' || tid === '') return ''
    return String((dump1?.message ?? []).find((m) => m.id === tid)?.content_text ?? '')
  })()

  check(
    num !== null ? 'ok' : 'unknown',
    num === null
      ? '第一轮**没有**编出那个 4 位数字 ⇒ 「它是不是从第一轮的回答里抄的」这一条判不了'
      : `第一轮编的数 = \`${num}\`（从第一轮的回答里取出来的）`
  )
  /**
   * ★ 前提：那个数**两轮的提示词里都没有**。
   *
   * 只查第一轮是不够的 —— 下面那条判据说的是「**唯一的**来源是助手历史行」，
   * 而这句话只有在**第二轮的触发行也不含它**时才成立（第二轮要是自己把数写进了提示词，
   * 答对就什么都证明不了）。所以两轮的触发行都要查，缺一轮就是缺一条前提。
   */
  const trigger2 = (() => {
    const tid = (dump2?.turn ?? []).find((t) => t.id === turn2)?.trigger_message_id
    if (typeof tid !== 'string' || tid === '') return ''
    return String((dump2?.message ?? []).find((m) => m.id === tid)?.content_text ?? '')
  })()
  const inTrigger1 = num !== null && trigger1.includes(num)
  const inTrigger2 = num !== null && trigger2.includes(num)
  const triggersKnown = trigger1 !== '' && trigger2 !== ''
  check(
    num === null || !triggersKnown ? 'unknown' : inTrigger1 || inTrigger2 ? 'bad' : 'ok',
    num === null
      ? '第一轮**没有**编出那个 4 位数字 ⇒ 下面的前提与判据都不成立'
      : !triggersKnown
        ? `拿不到触发行正文（第一轮 \`${trigger1 === '' ? '缺' : '有'}\` / 第二轮 \`${trigger2 === '' ? '缺' : '有'}\`）⇒ 前提没法查`
        : inTrigger1 || inTrigger2
          ? `⚠️ 那个数**在提示词里**（第一轮 ${String(inTrigger1)} / 第二轮 ${String(inTrigger2)}）⇒ ` +
            '下面那条判据退化成「提示词在历史里」，判据作废'
          : `★ 前提成立：\`${num}\` **两轮的提示词里都没有**（第一轮 / 第二轮都查过）` +
            '—— 它只可能来自第一轮的**回答**'
  )
  if (num !== null && triggersKnown && !inTrigger1 && !inTrigger2) {
    check(
      text2.includes(num) ? 'ok' : 'bad',
      `★★ **第二轮答出了那个数（\`${num}\`）** —— 它不在两轮的提示词里，` +
        '所以唯一的来源就是「第一轮的**回答**作为助手消息进了历史数组」。' +
        '这一条是本里程碑的头号验收。'
    )
  } else {
    check('unknown', '★ 头号验收（助手历史行）这次没测到 —— 前置条件不成立')
  }
  check(
    r1Marker !== '' && text2.includes(r1Marker) ? 'ok' : 'bad',
    `★ 第二轮也答出了第一轮**提示词**里那串标记（\`${r1Marker}\`）—— ` +
      '它是第一轮的**用户消息**，现在得是一条 user 历史行 ⇒ 用户历史行也在数组里'
  )

  // ══ 装配形状的对照 ═══════════════════════════════════════
  rule('装配形状 · 两轮并排（追加式 / 稳定前缀）')
  if (!s1 || !s2) {
    check('bad', '两轮的装配形状不齐 —— 观测通道没通，这一段判不了')
  } else {
    say(
      `  第一轮  messageCount=${s1.messageCount} contentChars=${s1.contentChars} ` +
        `historyIncluded=${s1.historyIncluded} systemPromptChars=${s1.systemPromptChars}`
    )
    say(
      `  第二轮  messageCount=${s2.messageCount} contentChars=${s2.contentChars} ` +
        `historyIncluded=${s2.historyIncluded} systemPromptChars=${s2.systemPromptChars}`
    )
    check(
      s2.historyIncluded === 3 && s2.historyTotal === 3 && s2.messageCount === 4
        ? 'ok'
        : 'bad',
      `★ 第二轮的历史 = **第一轮的触发行 + 第一轮的回答 + 第二轮的触发行**（historyIncluded=${s2.historyIncluded} / ` +
        `historyTotal=${s2.historyTotal} / messageCount=${s2.messageCount}，期望 3 / 3 / 4）`
    )
    /**
     * ★ 这一条只能判到「**在长**」，判不到「**逐字节前缀**」—— 两件事不是一回事。
     *
     * 「长度增长」不蕴含「前缀关系」（同样的长度可以装着完全不同的内容），而
     * 「第 N 轮的输出是第 N+1 轮输出的字节前缀」正是 §4.6 那套缓存论证的地基。
     * **本走查看不见它**：`[ctx]` 里只有 `ContextShape`（故意的，不含正文），
     * 归档里没有提示词原文。钉住那条性质的地方是单测
     * （`test/domain/context-builder.test.ts`），不是这里。
     *
     * ⇒ 所以这里如实印到「追加」，**不**顺手把它读成「前缀」。
     */
    check(
      s2.contentChars > s1.contentChars ? 'ok' : 'bad',
      `数组在**长**：第二轮的 contentChars（${s2.contentChars}）比第一轮（${s1.contentChars}）长，` +
        `条数 ${s1.messageCount} → ${s2.messageCount} ⇒ 历史是**追加**进去的，不是每轮重建的` +
        '（更弱的结论，但这是归档能支持的；「逐字节前缀」归档判不了，见这条上方的注释）'
    )
    check(
      s2.systemPromptChars === s1.systemPromptChars && s1.systemPromptChars > 0 ? 'ok' : 'bad',
      `系统提示词两轮**等长**（${s1.systemPromptChars} 与 ${s2.systemPromptChars} 个字符）—— ` +
        '它是那个「稳定前缀」：每轮都在变的前缀会让缓存永远命中不了（§4.6）' +
        '（★ 等长是**必要条件不是同一份**；「逐字节相同」要 hash，而 `[ctx]` 里没有）'
    )
    check(
      s2.suppressedAutoInjected === 2 && s2.projectFiles === 2 ? 'ok' : 'bad',
      `第二轮的项目记忆装配与第一轮一致（suppressed=${s2.suppressedAutoInjected} / files=${s2.projectFiles}）—— ` +
        '同一个文件在两轮里得到不同的处理，就是「装配不确定」'
    )
    check(
      s2.compactedThroughSeq === 0 ? 'ok' : 'bad',
      `第二轮的水位线还是 0（实得 ${s2.compactedThroughSeq}）—— 压缩是 M7c 的事`
    )
  }

  // ══ 缓存命中 ═════════════════════════════════════════════
  rule('缓存命中（**端点相关**，见 §8.9-16）')
  const u2 = turn2 ? usageOf('A', turn2) : null
  const u1 = turn1 ? usageOf('A', turn1) : null
  /**
   * ★ 判据不是「cacheRead > 0 就印 ✅」那么粗：
   * - 没有 `usage` 帧 ⇒ **没测到**（端点没上报），不是「没命中」。
   * - 有帧且命中 ⇒ 「前缀真的命中了缓存」的直接证据。
   * - 有帧但全 0 ⇒ **只有提示词够长时**才算有话说。短提示词本来就在缓存的最小长度之下，
   *   那时候的 0 什么也不说明 —— 前提不成立就不许判（§8.8e 规则三）。
   *
   * ★★ 而本轮把这条判据**再往下压了一级**：这个端点上报的 `cacheRead`
   * **不是「本请求命中了自己上一条前缀」那个意思**。四条同日归档：
   *
   * 1. **自定义前缀 + 新进程 = 0，两次独立运行都是**（`m7a-2026-09-23T16-48-08-427Z` 与
   *    `…16-51-08-216Z` 的 arm B：`input_tokens=20307 / cache_read=0`）——而这两次运行里
   *    **系统提示词逐字节相同**（sha `e6066a2897c53106`），工具表也相同，也就是说
   *    本该命中的那一段连续前缀一模一样，仍然 0。
   * 2. **只有同进程续写才非零**（同归档 arm D 的第二次请求：`input_tokens=301 /
   *    cache_read=21120`）。
   * 3. 而那个 21120 **大于**该进程第一次请求的 `input_tokens`（20181）——
   *    算术上不可能是「本请求前缀里命中的一段」。
   * 4. pre-M7a 那个 `cacheRead=37248` 是**跨项目、跨提示词、跨进程的常量**（m6a/m6b 四次运行
   *    全是它），且只在 `systemPrompt` 是**空串**时出现。
   *
   * ⇒ 结论：**「cacheRead 非零」在本端点上不可作为验收判据**（§7.2 ② 因此在本端点判不了），
   * 而**不是**「M7a 把缓存弄坏了」—— 装配侧的前缀纪律仍然在（`envBlock` 不含时间戳、
   * 历史纯追加、系统提示词两轮等长），只是它在这个端点换不到证据。
   * **绝不许**拿 M6b 那个 37248 当基线：那是**另一个配置**（空系统提示词）下的数，
   * 拿它对照会把一个端点事实判成我们的 bug —— 这一条是这份报告里最容易自欺的地方。
   */
  const longEnough = (s2?.contentChars ?? 0) >= 4000
  if (!u1 && !u2) {
    check('unknown', '两轮都没有 `usage` 帧 ⇒ 这个端点没上报用量，缓存命中**没测到**（不是「没命中」）')
  } else {
    say(
      `  第一轮 usage 帧 ${String(u1?.frames ?? 0)} 条，cacheRead ${String(u1?.cacheRead ?? 0)}；` +
        `第二轮 ${String(u2?.frames ?? 0)} 条，cacheRead ${String(u2?.cacheRead ?? 0)}`
    )
    const hit = (u2?.cacheRead ?? 0) > 0 || (u1?.cacheRead ?? 0) > 0
    check(
      hit ? 'ok' : 'unknown',
      `★ \`cacheRead\`：第一轮 ${String(u1?.cacheRead ?? 0)}、第二轮 ${String(u2?.cacheRead ?? 0)}` +
        (hit
          ? ' ⇒ 命中了：那个端点的缓存键确实落在前缀上'
          : longEnough
            ? ' ⇒ **两轮都没命中**，而这不是装配的错、也不是「没测到」：' +
              '同上四点（自定义前缀在新进程里恒为 0、同进程续写才非零、那个非零值比它自己的输入还大、' +
              '旧值只在空系统提示词时出现）⇒ **本端点的这个字段无法用来验收前缀缓存**，如实记为「判不了」' +
              '（§7.2 ② 在本端点悬空；本里程碑只在这一条上留白，其余判据不受影响）'
            : ` ⇒ 提示词只有 ${String(s2?.contentChars ?? 0)} 字，**大概率在缓存的最小长度之下** —— ` +
              '这时候的 0 什么也不说明，判不了')
    )
    // ★ 非空但短提示词与「长提示词也不命中」是两件事，后者更有信息量，所以分别说清楚。
    if (!hit && longEnough) {
      say('  ⚠️ 这条留白**不是「测了没事」**：它的原始事实是 cacheRead=0，只是归因不了。')
    }
  }

  // ══ 库里的事实 ═══════════════════════════════════════════
  rule('库里的事实（`db-*.json`）')
  if (!dump2) {
    check('unknown', '没有 after-r2 的库转储，这一段判不了')
  } else {
    const wsId = String(ids.nova?.id ?? '')
    const turns = (dump2.turn ?? []).filter((t) => t.workspace_id === wsId)
    const session = (dump2.session ?? []).find((s) => s.id === ids.sessionId)
    const msgs = (dump2.message ?? []).filter((m) => m.session_id === ids.sessionId)
    const users = msgs.filter((m) => m.role === 'user').length
    const assistants = msgs.filter((m) => m.role === 'assistant').length

    say(`  turn ${turns.length} 条 / message ${msgs.length} 条（user ${users} / assistant ${assistants}）`)
    check(turns.length === 2 ? 'ok' : 'bad', `两轮都进了库（turn=${turns.length}）`)
    check(
      turns.every((t) => Number(t.hop_depth) === 0) ? 'ok' : 'bad',
      '两轮的 `hop_depth` 都是 0（用户手动发起的一轮就是 0 —— 跳数记账是 M7b 的事）'
    )
    check(
      users === 2 && assistants === 2 ? 'ok' : 'bad',
      `每条消息各落一行：user ${users} / assistant ${assistants}（期望 2 / 2）—— ` +
        '助手回答**单独成行**是历史数组的前提（拍进同一条的话它就不是一条能被序列化的历史）'
    )
    check(
      session?.compacted_through_seq === 0 && (session?.rolling_summary ?? null) === null
        ? 'ok'
        : 'bad',
      `会话的压缩水位线是 0、滚动摘要为空（${String(session?.compacted_through_seq)} / ` +
        `${JSON.stringify(session?.rolling_summary ?? null)}）—— 压缩是 M7c 的事`
    )
    /**
     * ★ 库里那一行的正文必须与**流出来的正文**逐字相同：下一轮看到的就是库里那一行，
     * 两者一旦分叉，「第二轮记得第一轮」测的就不是用户看到的那个回答。
     */
    const stored1 = String(
      msgs.find((m) => m.turn_id === turn1 && m.role === 'assistant')?.content_text ?? ''
    )
    check(
      stored1 !== '' && stored1 === text1 ? 'ok' : 'bad',
      `★ 第一轮落库的助手正文与流出来的**逐字相同**（${stored1.length} 与 ${text1.length} 字符）—— ` +
        '分叉的话，第二轮读到的就不是用户看过的那个回答'
    )
    const seqs = msgs.map((m) => Number(m.seq))
    check(
      seqs.length === msgs.length && seqs.every((v, i) => i === 0 || v > seqs[i - 1]) ? 'ok' : 'bad',
      `消息的 \`seq\` 严格递增（${seqs.join(' → ')}）—— 历史数组的顺序判据就是它`
    )
  }

  // ══ 生产路径上的 warn ════════════════════════════════════
  rule('生产路径上的 warn（主进程 stderr，**不是**记忆里的 note）')
  const warns = recs.filter((r) => r.kind === 'warn')
  say(`  收到 ${warns.length} 条：[${warns.map((w) => String(w.tag)).join(' ')}]`)
  check(
    warns.some((w) => String(w.tag) === 'context:cwd-claude-md-suppressed') ? 'ok' : 'bad',
    '★ `context:cwd-claude-md-suppressed` 真的被**说出来了** —— §8.5c 性质 5 要求' +
      '「项目记忆没被读到」是一个可见状态；单测只能证明那个函数返回了 note，' +
      '这一条证明它在生产路径上真的到了输出'
  )
  check(
    warns.some((w) => String(w.tag) === 'history-window-capped') ? 'bad' : 'ok',
    '★ **没有** `history-window-capped` —— 两轮一共三条历史，远不到那个取数上限；' +
      '它出现就意味着取数窗口被截断了，而那是「压缩跟不上」的第一个症状'
  )
  check(
    warns.some((w) => String(w.tag) === 'history-missing-trigger') ? 'bad' : 'ok',
    '**没有** `history-missing-trigger` —— 触发行必须在历史窗口里（不在就说明取数逻辑错了）'
  )

  // ══ 旁证 ═════════════════════════════════════════════════
  rule('旁证（**不是断言**）')
  say(`  第一轮的正文（前 200 字）：${quote(text1, 200)}`)
  say(`  第二轮的正文（前 200 字）：${quote(text2, 200)}`)
  for (const d of recs.filter((r) => r.kind === 'dom')) {
    say(`  [${String(d.tag)}] ${quote(String(d.text), 200)}`)
  }
  const notices = recs.filter((r) => r.kind === 'notice')
  if (notices.length > 0) {
    say(`  ⚠️ 界面推了 ${notices.length} 条通知（**故意不断言**：到达时机取决于 React 挂载与 CDP 的先后）：`)
    for (const n of notices) say(`     ${quote(JSON.stringify(n.payload), 160)}`)
  }

  rule('结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '全部通过' : `${failures} 条不通过`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  say('  ⚠️ 端点限定语：全部结论只在**本机默认凭据所指向的端点**下成立，不是 Anthropic 官方行为。')
  say('  ⚠️ **一条留白**：`cacheRead`（§7.2 ②）在本端点上判不了 —— 原始事实是两轮都为 0，')
  say('     但同日归档证明这个字段不能用来验收前缀缓存（见「缓存命中」那一段）。')
  say('     ⚠️ 不许把它记成「测了没事」，也不许拿 M6b 的 37248 当基线（那是空系统提示词的配置）。')
  say('  ⚠️ 行类型判据（标记出现在 assistant 消息里、之前没有 tool_result）不在本走查里 ——')
  say('     它要 CLI 的逐行原始输出，那是 `scripts/m7a-probe.ts` 的活。这里做的是端到端那一半。')
  return failures
}
// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

/**
 * 收摊，然后**强制退出**。
 *
 * ★ 不加这一步，采集一旦中途抛错，脚本会挂着不退：应用子进程的 stdout/stderr 管道
 * 是我们自己建的两个活动句柄，只要它还活着，Node 的事件循环就不会空 ——
 * `main()` 早就返回了，进程却一直停在那里。M6a 的第一次干跑就是这么卡住的。
 * 所以退出这件事要显式做，不能指望事件循环自然排空。
 */
async function finish(code: number): Promise<never> {
  stopPump()
  const pid = currentChild?.pid
  if (pid) {
    hardKill(currentLabel)
    await waitGone(pid, 5000)
  }
  try {
    ws?.close()
  } catch {
    // 连接已经没了就算了
  }
  ws = null
  await sleep(300)
  process.exit(code)
}
async function main(): Promise<void> {
  const archive = argValue('archive')
  if (REPLAY_ONLY && !archive) {
    process.stderr.write(
      '只重放模式（--replay）需要归档目录：\n' +
        '    npm run walk:m7a:replay -- --archive=scripts/evidence/m7a-<时间戳>\n' +
        '故意不带默认值 —— 这个命令**不该**在忘了参数的时候顺手跑一次真采集（那会花钱）。\n'
    )
    return finish(1)
  }
  if (archive) {
    loadArchive(archive)
    rule('M7a 走查 · 重放归档（零成本）')
    return finish(report() === 0 ? 0 : 1)
  }

  const dir = argValue('out') ?? join(EVIDENCE_ROOT, `m7a-${stamp()}`)
  rule('M7a 走查 · 采集')
  say(`  归档目录        ${dir}`)
  say(
    DRY
      ? '  干跑：只开界面、**不发任何轮次**，不花钱。'
      : '  ⚠️ 真花钱：2 轮真 CLI，每轮一道 --max-budget-usd 0.50 的硬闸。'
  )

  let crashed: unknown = null
  try {
    await collect(dir)
  } catch (err) {
    crashed = err
    rec({ kind: 'error', tag: 'collect', message: err instanceof Error ? err.message : String(err) })
    say(`\n采集中断：${err instanceof Error ? err.message : String(err)}`)
  }

  /**
   * 干跑出的是**另一份报告**（`reportDry`）—— 它没有轮次可判，
   * 硬套正常路径那份报告只会得到一屏「没测到」，把真正要看的「地基好不好」淹掉。
   */
  if (DRY) {
    const f = reportDry()
    return finish(f === 0 && crashed === null ? 0 : 1)
  }

  // ★ 采集崩了也要出报告：已经落档的事实仍然可判 —— 这正是「报告是归档的纯函数」的好处。
  const f = report()
  if (crashed) {
    check('bad', '采集中断了 —— 上面没覆盖到的场景一律算未通过')
    return finish(1)
  }
  return finish(f === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\n走查自己崩了：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  )
  // 崩了也一样要收摊：子进程可能还在跑（那还在花用户的钱）。
  void finish(1)
})
