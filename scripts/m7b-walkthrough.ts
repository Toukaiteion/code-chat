/**
 * M7b 实机走查 —— `@` 派发、跳数记账、§4.5b 的三条熔断。
 *
 *     npm run walk:m7b:dry                                           # ★ 先跑这个（零成本）
 *     npm run walk:m7b                                               # 真机（真花钱：≈10 轮）
 *     npm run walk:m7b:replay -- --archive=scripts/evidence/m7b-…     # 重放（零成本）
 *     ⚠️ `walk:m7b:replay` 忘了 `--archive` 时**直接报错退出**，不会顺手采集一次。
 *        理由逐字抄 M6b：一个叫 replay 的命令在打错字时花钱，是这把枪自己走火。
 *
 * ## 它与 M7a 走查的关系：骨架逐字照抄，被测物又换了一层
 *
 * CDP 客户端、spawn/硬杀/等待、归档写入、三态 `check`、报告只读归档、`finish()` 收摊 ——
 * 全部逐字沿用 `m7a-walkthrough.ts`（那一套又是从 m6b / m6a 抄来的）。
 * 驱动方式也照旧：**夹具走 IPC，被测动作走界面**（`setup` 用 `window.__m7b.call`，
 * 而「打 `@`、选人、点发送」是真的 `click()`）。
 *
 * 换掉的是场景。M7a 测的是「**发出去的上下文**是什么」（界面上看不见），
 * M7b 测的是「**一轮结束之后又发生了什么**」——`@` 把工作交给下一个人、跳数怎么记、
 * 链空转多久该刹车。它的产物有一半在**库**里（新轮次、转述消息、system 事件）、
 * 一半在**主进程的日志**里（三条熔断的判决），界面上只有一条警告。
 *
 * ## ★ 两个空间，不是随手分的
 *
 * `chainOf` 的判据是**按空间**取的（`turn.listRecentByQueuedAt(workspaceId)`），
 * 而「用户一次 @ 三个人」会造出三条**同深度**的兄弟轮次 —— 那些兄弟会把链切开
 * （`chainOf` 要求 `hop_depth` 逐跳 -1，同深度就断）。所以：
 *
 * | 空间 | 测什么 | 依赖模型吗 |
 * |---|---|---|
 * | **Sable**（4 个成员） | Composer 的 `@` 采集、① 一次 @ 多个成员、⑤ 去重、`cc`、⑥ 并发闸门 | **不依赖** |
 * | **Rill**（2 个成员） | ② A 的回复里 @ B → B 被派发、③ 2 跳警告、④ 4 跳终止 | 依赖（要有回复里那个标记块） |
 *
 * 分成两个空间不是洁癖：Sable 里那批同深度的兄弟轮次一旦混进 Rill，
 * 乒乓链**永远不会被切出来**，于是 ③④ 变成「测了没事」的假象。
 *
 * ## 判据的强度是分级的（这一节是本走查最要紧的自我约束）
 *
 * 1. **不依赖模型的那一半**（采集 / 去重 / cc / 并发闸门 / 跳数记账）：硬断言。
 *    它们的输入全由走查自己决定，所以能判 ✅/❌。
 * 2. **依赖模型的那一半**（agent 之间的接力）：**前提是模型在回复末尾写了 `<mentions>` 块**。
 *    没有块 = 没有派发（§5.4 的失败形态，可观测），于是 ③④ 的**前提不成立** ⇒
 *    如实降级成 `⚠️ 无法判定`，**不许照印 ✅**（§8.8e 规则三）。
 * 3. **「实质性工作」的前提**是这几跳**一个工具都没用**（`tool_start` 事件数 = 0）。
 *    用了工具 ⇒ 空转计数被清零 ⇒ 熔断本就不该触发 ⇒ 同上降级。
 *
 * ## ★ 观测通道（三条，早已在别的走查里被证明存在）
 *
 * - **库转储** `db-A-<phase>.json` —— 轮次 / 消息 / 事件的全部事实。**跳数与转述正文都在里面**，
 *   所以报告可以**完全从归档重判**（§8.8e 纪律）。
 * - **主进程 stderr 的 `[runtime:<tag>]`** —— 三条熔断的判决走 `onWarn`（`fanout:<tag>`）。
 *   它是「判决真的发生了」的唯一直接证据：单测只能证明那个函数返回了什么。
 * - **页面侧的推送钩子** —— `stream:batch` 里的正文（用来断「那一轮到底 @ 了谁」）
 *   与 `app:notice`（用户在界面上看到的那条警告）。走查挂在 preload 桥上，
 *   不经过 React 的 store，所以**别的会话**的推送也收得到
 *   （合批器按 `ActiveView.workspaceId` 抑制，不按 session —— 见 `event-batcher.ts`）。
 *
 * ## 端点限定语（照 §六「M5 实证」的纪律，写最前面）
 *
 * 全部实测跑在**本机当前默认凭据所指向的端点**下（一个 Anthropic 兼容端点，模型名由
 * `--model` 给、默认 `deepseek-flash`，**不是 Anthropic 官方**）。
 * **凭据本身一律不读、不回显、不落档** —— 环境**原样**继承给子进程（`spawn` 不传 `env`）。
 * 而「模型愿不愿意在回复末尾写那个标记块」这条**是端点的行为**，不是本应用的行为 ——
 * 所以 ②③④ 的结论只在这个端点下成立，换端点要重跑。
 *
 * ## 为什么断言不许写在采集里（§8.8d 规则九）
 *
 * 采集（`collect()`）只做两件事：驱动真窗口、把**每一个可观测事实**写进归档。
 * **所有断言都在 `report()` 里，而它只读归档。** 采集崩了也照样出报告。
 *
 * 归档里的五个部分：
 * - `events.jsonl` —— 全部事实（launch / status / batch / ui / probe / live / warn / db …）
 * - `batches.jsonl` —— 只装推送载荷（`stream:batch` / `stream:status` / `workspace:unread`），逐字
 * - `db-A-<phase>.json` —— 库转储（`burst` / `final` / `chain` 三个时点）
 * - `app-A.<stdout|stderr>.log` —— 主进程的两条流（`[ctx] …` 与 `[runtime:…] …` 在这里）
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
 * M7b 有自己的沙箱（`cc-m7b`），与 m6a / m6b / m7a 分开。
 */
const SAND = join(tmpdir(), 'cc-m7b')
const USERDATA = join(SAND, 'userdata')
const SRC = join(SAND, 'src-proj')
/** 两份人设：`plain` 不说 @ 的事（Sable），`rally` 教它接力（Rill）。 */
const PERSONA_PLAIN = join(SAND, 'persona-plain.md')
const PERSONA_RALLY = join(SAND, 'persona-rally.md')
const DB = join(USERDATA, 'code-chat.db')

const CDP_PORT = 9222
const CDP = `http://localhost:${CDP_PORT}`

/** 流式期间的轮询间隔。150ms ≈ 每 4~5 个合批周期看一眼。 */
const POLL_MS = 150

const MODEL = argValue('model') ?? process.env.CODE_CHAT_WALKTHROUGH_MODEL ?? 'deepseek-flash'

/**
 * 干跑：**只开界面、不发轮次**。
 *
 * 它值一个开关，因为走查的地基（构建产物起得来、CDP 连得上、preload 桥在构建版里真的暴露、
 * 夹具走 IPC 全过、对话视图打开后输入区真的在）与「`@` 派发对不对」是两个独立的失败面 ——
 * 地基塌了的时候，真机跑一遍会**花钱**换来一份什么都测不到的报告。
 *
 * ★ 而 M7b 的干跑比 M7a 的更值：**Composer 的 `@` 采集那段可以整个在干跑里跑完**
 * （打字、弹层、选中、chip、切 cc、未选中提示 —— 全都在点「发送」之前），
 * 所以它是**零成本**拿到的第一条硬判据。真正的钱花在「派发出去之后」。
 */
const DRY = process.argv.slice(2).includes('--dry')

/**
 * 「只重放，绝不采集」。没有 `--archive` 就直接退出 —— 理由见文件头。
 */
const REPLAY_ONLY = process.argv.slice(2).includes('--replay')

/**
 * ★ 本次运行的**标记后缀**。
 *
 * 它只有一个用处：让 Sable 那条提示词**每次都不一样**，于是「同一段正文」这件事
 * 只在本run 内成立（去重要求两次发送逐字相同）。重放时报告从归档里读它 ——
 * 「这份报告看的是哪一次采集」因此是可核对的，而不是靠时间戳猜。
 */
const NONCE = argValue('nonce') ?? Math.random().toString(36).slice(2, 6)

/**
 * Sable 那条消息的正文。★ **两次发送必须逐字相同** ——
 *
 * 去重键是 `(目标成员, sha256(要转述给对方的正文))`，正文差一个字节就是另一个键，
 * 而「算不中」的样子是「同一件事被派了两轮」：**它不报错**。
 *
 * 里面**不能有 `@`**：正文里一个没被选中的 `@` 会让 Composer 显出一行提示
 * （那是有意的产品行为），而这里要的是一段干净的正文。
 */
const TEXT_SABLE = `MK7B-${NONCE}：收到就好，不要用任何工具，也不要额外发挥。`

/**
 * Rill 那条消息。★ 它**要求模型在回复末尾写出那个标记块** —— 这是 `@` 派发链的**唯一入口**，
 * 而「模型会不会照着写」本身就是要观测的事情之一（§5.4：没有块 = 没有派发）。
 *
 * ★★ **这一段被第一次真机跑改过一次，改的是最要紧的地方：这里不许出现
 * `<mentions>Wisp</mentions>` 这个字面例子。**
 *
 * 第一次真机跑（归档 `m7b-2026-09-23T17-49-39-397Z`）里它就在这儿，于是：
 * 转述正文**逐字带着用户那句原文**，所以每一跳读到的都有一行现成的
 * 「在最后单独写一行：`<mentions>Wisp</mentions>`」—— 第二跳（Wisp 本人）照抄，
 * 于是它**@ 了它自己**，被 `mention-self` 判掉，链在第 1 跳就断了（`[0,1,1]`，
 * 2 跳警告出现了两次、4 跳终止根本没走到）。
 *
 * ⇒ 用户那句话里**只给意图，不给格式示例**；格式由人设给（人设不进转述）。
 * 这条约束对走查是硬的：**转述会把用户的原文一字不差地传给下一跳**。
 */
const TEXT_RALLY = [
  '不要使用任何工具。',
  '先回一句「收到」。',
  '然后在回复的最后单独写一行，按你人设里那条规则，把这件事交给 Wisp。'
].join('\n')

/**
 * Sable 四个人的人设：**刻意不提 `@` 这件事**。
 *
 * 它们的系统提示词里本来就有 `<collaboration>` 那段协议（`context-builder` 拼的），
 * 所以「不需要别人接手时不要写那一行」这句话它们看得见。这里不说别的，
 * 是为了让「Sable 里没有 agent 之间的链」成为一个**可控的前提**：
 * 那条链一旦出现，A2/A3 的计数判据就一起作废（报告里会如实降级）。
 */
const PERSONA_PLAIN_TEXT = [
  '# 沙箱角色（不回派）',
  '',
  '你是一个测试角色。只做别人明确让你做的事，不寒暄、不额外发挥、不改无关文件。',
  '回复短一点，一两句话就够。'
].join('\n')

/**
 * Rill 两个人的人设：**教它接力**。
 *
 * ★ 这条人设是「A 的回复里 @ B → B 被派发」在真机上唯一可复现的驱动力：
 * 协议那段只说了格式，说不清「什么时候该用」。
 *
 * ★★ 两条规则**必须带优先级**，这是第二次设计（第一次真机跑暴露的）：
 * 转述正文里**逐字带着上一跳的原文**，所以「消息里点了谁的名」这条规则
 * 在第二跳会把名字指回它自己（见 `TEXT_RALLY` 的注释）。
 * 真正能用的线索是**转述的头部那句话**（「【派发】X …@ 了你」），
 * 所以「派发给你的 ⇒ 写给派发给你的人」必须**优先**，并且要**说明理由**——
 * 模型得知道违反它会发生什么（自己派给自己、链断掉）。
 *
 * 最后一句也是从观测来的：第一次真机跑里模型在正文里写了
 * 「（无 <mentions> 行，避免继续空转。）」，于是 `mentions-malformed` 报了一次警
 * —— 那是我们的解析器对「正文里出现这几个字但不成块」的正确反应，
 * 但那一轮本来不必触发它。⇒ 人设里明说**正文里别出现这几个字**。
 */
const PERSONA_RALLY_TEXT = [
  '# 沙箱角色（接力）',
  '',
  '你是一个测试角色。只做别人明确让你做的事，不寒暄、不额外发挥、不改无关文件。',
  '回复短一点，一两句话就够。',
  '',
  '★ 这个空间里有两个成员，同一件事会在你们之间来回交接。',
  '每次回复的**最后**，你都要单独占一行写上这次要交给谁，格式固定是：',
  '',
  '  <mentions>名字</mentions>',
  '',
  '那一行里**只写一个名字**，别的什么都不要写。名字按下面两条规则判断，',
  '**第一条优先于第二条**：',
  '',
  '· 如果这条消息是**别人派发给你的**（它以「【派发】」三个字开头）：',
  '  写**把这件事交给你的那个人**的名字。即使原文里出现了别人的名字也别管它 ——',
  '  写给派发给你的那个人，否则你就变成了自己派给自己，链条会在这里断掉。',
  '· 否则（是你这边的用户直接发的）：写**那条消息里点名的那个人**的名字。',
  '',
  '除了那一行之外，正文里不要再出现 <mentions> 这几个字。'
].join('\n')

/** 沙箱项目里的文件。M7b 不测项目记忆（那是 M7a 的活），所以只要让这个目录像个项目。 */
const SANDBOX_FILES: Record<string, string> = {
  'README.md': `# M7b 沙箱项目\n\n只提供一个能读的目录，走查的判据不在它上面。\n`,
  'a.ts': 'export const x = 1\n'
}

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

/** IPC 那条路上的 `Turn` —— **驼峰**（`TurnSchema` 镜像 `entities.ts`）。 */
interface LiveTurn {
  id: string
  sessionId: string
  workspaceId: string
  status: string
  hopDepth: number
}

interface SchedulerStateLike {
  liveTurns: LiveTurn[]
  queueDepth: number
  dispatchable: number
  slots: { used: number; total: number }
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
 * 页面内的采集器 + **驱动器**。与 m7a 的那份同源，换掉的是被测物那一层。
 *
 * ## 三条纪律（照抄 m6b / m7a，一条都没改）
 *
 * 1. **点击用真 `click()`，不是合成坐标。** `el.click()` 派发的是真的 `MouseEvent`，
 *    React 的合成事件照收 —— 而按屏幕坐标点要先把元素滚进视口、再算坐标，
 *    任何一处布局变化都会让点击落到别的地方，失败的样子是「什么都没发生」。
 * 2. **受控输入必须走原型上的 setter。** 直接 `el.value = x` 在 React 里**不会**
 *    触发 `onChange`，于是输入框看着有字、状态还是空的、点发送什么也不会发生。
 *    ⇒ 它有自己的返回码（`typed` / `mismatch`），干跑里专门有一条判据盯着它。
 * 3. **判据按 DOM 结构，不按文案** —— 唯一一处按中文找的是「发送」按钮，
 *    因为它是走查的**驱动手段**（点它才能发消息），不是被测物。
 *
 * ## ★ M7b 新增的那一块：`@` 候选浮层 / chip / 未选中提示
 *
 * 它们全都在**点发送之前**，所以整段能在干跑里跑完（零成本）。
 * 选择器只认**结构**：浮层是 `div.absolute.bottom-full`（`Composer` 里那个唯一的
 * 绝对定位浮层），chip 是「正文以 `@` 开头的 button」。
 *
 * ⚠️ 这一段在模板字符串里，注释里**不许出现反引号** —— 它会当场把模板截断，
 *    而 tsc 不管模板里的内容，报出来的错在几百行之外。
 *    碰过这段就顺手跑一次 npm run check:helpers（这段的语法错只有它会当场指出来）。
 */
const HELPERS = `
window.__m7b = {
  batch: [], status: [], unread: [], notice: [], hooked: false,
  hook() {
    if (this.hooked) return 'already';
    this.hooked = true;
    window.api.on('stream:batch', (p) => { this.batch.push({ t: Date.now(), p }) });
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
  value(sel) { const e = document.querySelector(sel); return e ? e.value : null },
  headerName() {
    const h = document.querySelector('header');
    if (!h) return null;
    const s = h.querySelector('span.text-sm');
    return s ? s.textContent : null;
  },

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

  // ── M7b：Composer 的 @ 采集（全在点发送之前，干跑也跑得完）──
  //
  // 浮层的判据是**结构**：Composer 里那个绝对定位的候选框（bottom-full）。
  // 候选按钮的正文是「名字 + 派发」两段，所以这里把尾巴那两个字去掉再报名字。
  mentionPopup() {
    const box = document.querySelector('div.absolute.bottom-full');
    if (!box) return { open: false, names: [] };
    const names = Array.prototype.slice.call(box.querySelectorAll('button'))
      .map((b) => (b.textContent || '').replace('派发', '').trim());
    return { open: true, names: names };
  },
  // 从浮层里选一个候选。**按名字精确匹配**，不取第一个 —— 取第一个的话
  // 「候选里有没有发言者自己」这条判据就永远看不出差别。
  clickMention(name) {
    const box = document.querySelector('div.absolute.bottom-full');
    if (!box) return 'no-popup';
    const btn = Array.prototype.slice.call(box.querySelectorAll('button'))
      .filter((b) => (b.textContent || '').replace('派发', '').trim() === name)[0];
    if (!btn) return 'no-candidate';
    btn.click();
    return 'clicked';
  },
  // chip = 正文以 @ 开头的 button（发言者那一排的按钮没有 @ 前缀）。
  chips() {
    return Array.prototype.slice.call(document.querySelectorAll('button'))
      .map((b) => (b.textContent || '').trim())
      .filter((t) => t.charAt(0) === '@');
  },
  // 「正文里的 @ 不会被派发」那行提示在不在。
  strayHint() {
    return Array.prototype.slice.call(document.querySelectorAll('p'))
      .some((p) => (p.textContent || '').indexOf('不会被派发') >= 0);
  },
  // 当前发言者（「以 X 的身份发言」那一排里被选中的那个）。
  // ★ 判据必须**先锚定那一排**（用「的身份发言」那个 span 的父元素），再在里面找
  // 带 neon-cyan 的那个按钮 —— 只按类名在整个文档里搜的话，会搜到别处（比如
  // 「+ 添加」那个按钮），于是这个诊断常年报一个**看起来正常**的错答案。
  speaker() {
    const labels = Array.prototype.slice.call(document.querySelectorAll('span'))
      .filter((s) => (s.textContent || '').trim() === '的身份发言');
    if (labels.length === 0) return null;
    const row = labels[0].parentElement;
    if (!row) return null;
    const hit = Array.prototype.slice.call(row.querySelectorAll('button')).filter(
      (b) => typeof b.className === 'string' && b.className.indexOf('neon-cyan') >= 0
    )[0];
    return hit ? (hit.textContent || '').trim() : null;
  },
  cards() {
    return {
      live: document.querySelectorAll('article.neon-halo').length,
      done: document.querySelectorAll('article.neon-frame:not(.neon-halo)').length
    };
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
  const raw = await evaluate('JSON.stringify(window.__m7b.drain())')
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
    `window.__m7b.call(${JSON.stringify(ch)}, ${JSON.stringify(payload === undefined ? null : payload)})`
  )) as { ok?: boolean; data?: T; error?: unknown } | null
  rec({ kind: 'ipc', label: currentLabel, tag, ch, req: payload ?? null, res: r ?? null, ms: Date.now() - started })
  if (!r || r.ok !== true) throw new Error(`IPC ${ch} 失败（${tag}）：${JSON.stringify(r?.error ?? r)}`)
  return r.data as T
}

async function domSnapshot(tag: string): Promise<void> {
  try {
    const text = await evaluate('window.__m7b.dom()')
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
 * 等到这一轮**终态行落库**，返回「done 帧到达渲染层 → 库里看见终态」的毫秒数
 * （`-1` 表示等到超时还没落）。
 *
 * M7b 用它来确认「那一轮真的结束了」，而不是「界面上看着像结束了」——
 * 扇出与压缩的判定点都在**库干净之后**，所以库那一行是不是终态是硬事实。
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
// 界面驱动
// ─────────────────────────────────────────────────────────────

/** 点一下，并把「点了什么、结果如何」落档。**点不中不抛** —— 那是要如实报告的事实。 */
async function click(tag: string, sel: string, sub?: string): Promise<string> {
  const r = String(
    await evaluate(
      `window.__m7b.click(${JSON.stringify(sel)}, ${JSON.stringify(sub ?? null)})`
    )
  )
  rec({ kind: 'ui', label: currentLabel, tag, action: 'click', sel, sub: sub ?? null, result: r })
  return r
}

/** 往输入框里写一段**完整**的正文（`type()` 是赋值，不是追加）。 */
async function typeInto(tag: string, sel: string, value: string): Promise<string> {
  const r = String(await evaluate(`window.__m7b.type(${JSON.stringify(sel)}, ${JSON.stringify(value)})`))
  // 落档的是**长度**，不是正文：正文是提示词，没意思；而长度能说明「真的写进去了」。
  rec({ kind: 'ui', label: currentLabel, tag, action: 'type', sel, chars: value.length, result: r })
  return r
}

/**
 * 回页面问一句，**结果原样落档**。页面没了、或者返回值不是 JSON，都记一条 `ok:false`，不抛。
 *
 * ★ 它不是断言的替代品：这里只负责「这一刻页面回了什么」，判决全在 `report()` 里。
 */
async function probe(tag: string, expr: string): Promise<unknown> {
  try {
    const text = String(await evaluate(`JSON.stringify(${expr})`))
    let value: unknown = null
    try {
      value = JSON.parse(text)
    } catch {
      value = text
    }
    rec({
      kind: 'probe',
      label: currentLabel,
      tag,
      text: text.length > 500 ? `${text.slice(0, 500)}…（共 ${text.length} 字）` : text,
      ok: true
    })
    return value
  } catch (err) {
    rec({ kind: 'probe', label: currentLabel, tag, text: err instanceof Error ? err.message : String(err), ok: false })
    return null
  }
}

/**
 * ★ **重载渲染进程** —— 这是「夹具走 IPC、场景走界面」这个组合必须付的一次代价。
 *
 * 夹具是走 IPC 建的，而**没有任何推送会告诉渲染层**「现在有空间了」；绕过了界面，
 * 界面就还停在「一个空间都没有」的**首启空态**上（顶栏不渲染、点「对话」没反应）。
 * 重载之后页面把库重新读一遍，夹具就全在界面上了。
 * 代价是 `window.__m7b` 随旧文档一起没了，所以要重新注入。
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
  await evaluate('window.__m7b.hook()')
  /**
   * ★ **桥回来 ≠ 界面画好了。** preload 在 React 挂载**之前**就注入了 `window.api`，
   * 所以上面那个判据会在一张**空 DOM** 上通过 —— 紧接着的「点左栏那个空间」
   * 就会落到 `not-found` 上，而它看起来像「空间没建出来」。判据必须是**界面上真的有了东西**。
   */
  const painted = await waitUntil(
    '左栏画出来',
    async () => {
      try {
        return Number(await evaluate('window.__m7b.count("aside button")')) > 0
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
 * 这些函数全是字符串里的页面侧代码，`tsc` 管不着。
 */
async function smokeHelpers(): Promise<void> {
  const probes = SMOKE_PROBES
  for (const [name, expr] of probes) {
    await probe(`dry.helper.${name}`, expr)
  }
  say(`  页面内辅助函数 跑了 ${probes.length} 个（结果见归档里的 dry.helper.*）`)
}

/** 干跑要跑一遍的页面内辅助函数。**报告要拿它的条数做判据**，所以放在模块级。 */
const SMOKE_PROBES: Array<[string, string]> = [
  ['headerName', 'window.__m7b.headerName()'],
  ['speaker', 'window.__m7b.speaker()'],
  ['count', 'window.__m7b.count("textarea")'],
  ['value', 'window.__m7b.value("textarea")'],
  ['cards', 'window.__m7b.cards()'],
  ['mentionPopup', 'window.__m7b.mentionPopup()'],
  ['clickMention', 'window.__m7b.clickMention("并没有这个人")'],
  ['chips', 'window.__m7b.chips()'],
  ['strayHint', 'window.__m7b.strayHint()'],
  ['dom', 'window.__m7b.dom().slice(0, 40)']
]

/** 页面上的一个布尔查询。页面没了（硬杀、正在关闭）时算「不在」—— 那是等的人该知道的事。 */
async function liveHas(sel: string): Promise<boolean> {
  try {
    return (await evaluate(`window.__m7b.has(${JSON.stringify(sel)})`)) === true
  } catch {
    return false
  }
}

/** 已经被认领过的轮次 id —— `waitOwnTurnId` 用它排除上一轮还活着的那个。 */
const claimedTurnIds = new Set<string>()

/**
 * 认领**用户这一次发送**产生的那一轮。
 *
 * ★★ 为什么不能只看「这个空间新出现的任一帧」（这个脚本的第一版就是这么认的）：
 * 第二次真机跑里它**认错了人** —— 给第二次发送返回的是 **Nyx** 那一轮（`9355fa05`），
 * 因为那一刻空间里有别的活轮次在推帧，谁先到就认谁。而这个 id 会被写进归档当证据，
 * 于是归档里出现一行「A 的轮次 = <别人的轮次>」：**那是假的证据，不是小瑕疵**
 * （§8.8e 的核心纪律就是「报告只读归档」，归档里混进一条假 id，后面所有按它过滤的判据都在撒谎）。
 *
 * ⇒ 换成钉在**库事实**上的判据：用户直接发起的那一轮是
 *   ① 落在**发言者的会话**里、② `hopDepth === 0` 的那一条 —— 两者合起来才唯一
 *   （agent 接力派进同一个会话的轮次，深度必然 > 0；而同一个会话里同时有两条 0 跳轮次
 *   意味着用户连点两次发送，我们本来就串行地等前一轮跑完）。
 *   数据来源是 `runtime:getState` 的活轮次 —— **它带 `hopDepth`**，而推送帧里没有这一列。
 *
 * ★ 轮次跑完就从活轮次里消失了，所以还有一条**降级路**：帧里 `sessionId` 对得上的那一条。
 * 降级路更弱（同一个会话里 agent 接力派进来的轮次也符合），所以 `via` 如实记进归档：
 * 报告里出现 `batch-fallback` 就说明这条 id 不够硬。
 */
async function waitOwnTurnId(
  tag: string,
  label: string,
  ms: number,
  sessionId: string,
  since: number
): Promise<string | null> {
  const from = Date.now()
  for (;;) {
    let mine: LiveTurn[] = []
    try {
      const st = await call<SchedulerStateLike>(`${tag}.own`, 'runtime:getState', null)
      mine = (st?.liveTurns ?? []).filter(
        (t) =>
          t.sessionId === sessionId && Number(t.hopDepth) === 0 && !claimedTurnIds.has(String(t.id))
      )
    } catch {
      mine = []
    }
    if (mine.length === 1) {
      const id = String(mine[0]?.id ?? '')
      claimedTurnIds.add(id)
      rec({ kind: 'note', tag, text: id, via: 'getState' })
      say(
        `  ${label} 的轮次 = ${id}（从 runtime:getState 的活轮次里认的：发言者会话 + 0 跳）`
      )
      return id
    }
    const b = recs
      .slice(since)
      .find(
        (r) =>
          r.kind === 'batch' &&
          r.label === label &&
          (r.payload as BatchLike | undefined)?.sessionId === sessionId
      )
    const viaFrame = (b?.payload as BatchLike | undefined)?.turnId
    if (typeof viaFrame === 'string' && mine.length === 0) {
      claimedTurnIds.add(viaFrame)
      rec({ kind: 'note', tag, text: viaFrame, via: 'batch-fallback' })
      say(`  ${label} 的轮次 = ${viaFrame}（⚠️ 降级路：从帧里认的，只有 sessionId 对得上）`)
      return viaFrame
    }
    if (Date.now() - from > ms) {
      rec({ kind: 'note', tag, text: `等不到 ${label} 的活轮次` })
      say(`  ⏳ 等不到 ${label} 的轮次 id`)
      return null
    }
    await sleep(POLL_MS)
  }
}

// ─────────────────────────────────────────────────────────────
// ★ M7b：活轮次观测
// ─────────────────────────────────────────────────────────────

/** 现在活着的轮次（库里 `queued` + `running`）里属于这个空间的那些。 */
async function liveTurnsOf(tag: string, workspaceId: string): Promise<LiveTurn[]> {
  const st = await call<SchedulerStateLike>(`${tag}.live`, 'runtime:getState', null)
  return (st?.liveTurns ?? []).filter((t) => t.workspaceId === workspaceId)
}

/** 一个会话里那条活轮次的状态；没有就是 `null`。 */
function statusIn(live: readonly LiveTurn[], sessionId: string): string | null {
  return live.find((t) => t.sessionId === sessionId)?.status ?? null
}

/**
 * 等一个「活轮次的形状」出现，返回那一刻的快照（命中与否都返回，**不抛**）。
 *
 * ★ 它是场景 ⑤ 里那条**前提**的采集手段：去重只对 `queued` 的尾部生效，
 * 所以「第二句话发出去的那一刻，A 在跑、B 在排队」这件事必须先被**记下来**，
 * 报告才判得了「running 的那一跳照样被重派」到底测到没有。
 * 等不到就如实记 `hit:false` —— 那一条判据会降级成 `unknown`，不是失败。
 */
async function waitLiveShape(
  tag: string,
  workspaceId: string,
  pred: (live: LiveTurn[]) => boolean,
  ms: number
): Promise<{ hit: boolean; ms: number; live: LiveTurn[] }> {
  const from = Date.now()
  let live: LiveTurn[] = []
  for (;;) {
    live = await liveTurnsOf(`${tag}.poll`, workspaceId)
    if (pred(live)) {
      const shape = { hit: true, ms: Date.now() - from, live }
      rec({ kind: 'note', tag, text: JSON.stringify(shape) })
      return shape
    }
    if (Date.now() - from > ms) {
      const shape = { hit: false, ms: Date.now() - from, live }
      rec({ kind: 'note', tag, text: JSON.stringify(shape) })
      say(`  ⏳ 等不到那个形状（${ms}ms）—— 如实记 hit:false，不抛`)
      return shape
    }
    await sleep(POLL_MS)
  }
}

/**
 * 等到这个空间**安静下来**（连续 3 拍没有活轮次），并顺手观测并发闸门。
 *
 * ★ 并发的判据取 `runtime:getState` 的 `slots.used`（**全局**）与 `queueDepth`
 * （**全局**）—— 那正是 §4.5 的上限所在。报告只断言「从没超过 3」，
 * 以及「确实观察到过排队」：后者才是「闸门真的在拦」的证据（没排过队也可能只是没超过）。
 *
 * ★ `cap` 是**钱闸**：一个失控的乒乓链会自己一直传下去。超过 `cap` 个活轮次就停下、如实记
 * `capped:true`，报告把它当 ❌（熔断没兜住）。**不能靠 `turn:stopAll` 刹车** ——
 * 它对运行中的轮次是 `E_NOT_IMPLEMENTED`（M9），而排队中的那些已经由调度器管着。
 */
async function waitQuiet(
  tag: string,
  workspaceId: string,
  ms: number,
  cap = 64
): Promise<{
  polls: number
  ms: number
  maxSlots: number
  slotsTotal: number
  maxQueued: number
  everQueued: boolean
  peakLive: number
  capped: boolean
}> {
  const from = Date.now()
  const s = {
    polls: 0,
    ms: 0,
    maxSlots: 0,
    slotsTotal: 0,
    maxQueued: 0,
    everQueued: false,
    peakLive: 0,
    capped: false
  }
  let quiet = 0
  for (;;) {
    const st = await call<SchedulerStateLike>(`${tag}.state`, 'runtime:getState', null)
    s.polls++
    s.maxSlots = Math.max(s.maxSlots, Number(st?.slots?.used ?? 0))
    s.slotsTotal = Number(st?.slots?.total ?? 0)
    s.maxQueued = Math.max(s.maxQueued, Number(st?.queueDepth ?? 0))
    if (Number(st?.queueDepth ?? 0) > 0) s.everQueued = true
    const mine = (st?.liveTurns ?? []).filter((t) => t.workspaceId === workspaceId)
    s.peakLive = Math.max(s.peakLive, mine.length)
    if (mine.length >= cap) {
      s.capped = true
      break
    }
    if (mine.length === 0) {
      quiet++
      if (quiet >= 3) break
    } else {
      quiet = 0
    }
    if (Date.now() - from > ms) break
    await sleep(POLL_MS)
  }
  s.ms = Date.now() - from
  rec({ kind: 'note', tag, text: JSON.stringify(s) })
  say(
    `  这个空间安静了：${(s.ms / 1000).toFixed(1)}s，最大并发 ${s.maxSlots}/${s.slotsTotal}，` +
      `最大队列 ${s.maxQueued}${s.capped ? '（**撞到钱闸，停手**）' : ''}`
  )
  return s
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

/**
 * 一批帧里 `text` 帧拼出来的正文 —— 与 `frame-buffer.ts` 里的追加规则同一句话。
 *
 * ★ 它只拼 `text` 帧：`thinking` 帧也在同一批里，而「模型想了什么」不进任何判据
 * （§4.4：thinking 永不进入 `messages`，这里的理由一样 —— 它不是对话）。
 */
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
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }
  writeFileSync(PERSONA_PLAIN, PERSONA_PLAIN_TEXT, 'utf8')
  writeFileSync(PERSONA_RALLY, PERSONA_RALLY_TEXT, 'utf8')

  rec({ kind: 'markers', tag: 'markers', nonce: NONCE, textSable: TEXT_SABLE, textRally: TEXT_RALLY })
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
  say(`  模型            ${MODEL}（端点 = 本机默认凭据所指向的那个，**不是 Anthropic 官方**）`)
  say('  预算闸          --max-budget-usd 0.50（turn-runner 的默认值，每轮一道）')
  say('  两个空间        Sable（4 人，测采集/去重/cc/闸门）· Rill（2 人，测乒乓链）')
}

/**
 * ★ **零成本的静态核对**：扇出的三处接线有没有真的接上。
 *
 * 它必须在这里做、而不是在报告里做，因为报告**只读归档** —— 一个「去读仓库源码」的报告
 * 在别的机器上重放同一份归档时会得到不同的结论。
 *
 * 它是静态的，所以**只值一句话**：`fanout.ts` 真的有没有被装配、被 runner 调用、
 * 被 handler 走用户那条路调用。这条 note 的作用是**把最可能的那一种漏掉挡在花钱之前**
 * （`runtime.ts` 里加了一个字段却忘了在组合根上传它 —— M7a 的 `textReader` 踩过这个形状，
 * 而 M7b 的三处接线少任何一处，「`@` 派发」整个功能就是死的）。
 */
function staticWiringCheck(): void {
  const runtimeFile = join(REPO, 'src', 'main', 'process', 'runtime.ts')
  const runnerFile = join(REPO, 'src', 'main', 'domain', 'turn-runner.ts')
  const handlerFile = join(REPO, 'src', 'main', 'ipc', 'handlers', 'turn.ts')
  const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  const assembled = read(runtimeFile).includes('createFanout')
  const userPath = read(handlerFile).includes('fanoutUserMentions')
  const finishPath = read(runnerFile).includes('onTurnFinished')
  const ok = assembled && userPath && finishPath
  rec({
    kind: 'note',
    tag: 'dry.wiring',
    text: ok ? 'wired' : 'MISSING',
    runtimeFile,
    runnerFile,
    handlerFile,
    assembled,
    userPath,
    finishPath
  })
  say(
    `  组合根接线      createFanout=${String(assembled)} fanoutUserMentions=${String(userPath)} ` +
      `onTurnFinished=${String(finishPath)}（三处少一处，「@ 派发」整个功能就是死的）`
  )
}

interface MemberIds {
  memberId: string
  sessionId: string
}

interface WsIds {
  workspaceId: string
  name: string
  projectId: string
  /** 键 = 显示名。 */
  members: Record<string, MemberIds>
}

interface SetupIds {
  sable: WsIds
  rill: WsIds
}

/**
 * 夹具：**走 IPC**（照 M6a / M6b / M7a）。
 *
 * ★ 这里刻意不点界面建空间 —— 夹具不是被测物。
 * **该走界面的地方（打 `@`、选人、切 cc、点发送）全部走界面**，见 `captureScenario` 与 `composeAndSend`。
 *
 * ★ **不给角色描述**（`roleDescPath` 不传）是**故意的**：`role_desc_path` 可空，
 * 而「NULL 时 `<role>` 整块不出现」是一条产品判决（M7a 的单测钉着它）。
 * 真机上让夹具落在这个状态上，两个空间的每一轮都顺带证一次。
 *
 * ★ 人设分两份（`plain` / `rally`），理由见文件头：Sable 要**没有** agent 之间的链，
 * Rill 要**有**。
 */
async function setup(): Promise<SetupIds> {
  const build = async (name: string, personaPath: string, names: string[]): Promise<WsIds> => {
    const ws = await call<{ id: string; name: string }>(`setup.${name}`, 'workspace:create', { name })
    const proj = await call<{ id: string }>(`setup.${name}.project`, 'project:addLocal', {
      workspaceId: ws.id,
      name: 'sandbox',
      rootPath: SRC
    })
    const members: Record<string, MemberIds> = {}
    for (const display of names) {
      const actor = await call<{ id: string }>(`setup.${name}.actor.${display}`, 'actor:create', {
        name: `${name}-${display}`,
        model: MODEL,
        personaPath,
        effort: 'low'
      })
      const member = await call<{ id: string }>(`setup.${name}.member.${display}`, 'member:create', {
        workspaceId: ws.id,
        actorId: actor.id,
        displayName: display
      })
      /**
       * ★ 这里不能用 `member:setPrimary`：它要求**先收窄可见项目**（「主项目必须是可见项目之一」），
       * 在一个还没配过可见性的成员上直接挂主项目会被拒（`E_CONFLICT`）。
       * `member:setVisibility` 一次把「可见集合 + 主项目」都定了 —— 于是每一轮的 `cwd`
       * 都是那个项目根，被 `@` 派出去的那一轮也一样（cwd 按**被派发方**算）。
       */
      await call(`setup.${name}.vis.${display}`, 'member:setVisibility', {
        memberId: member.id,
        projectIds: [proj.id],
        primaryProjectId: proj.id
      })
      const session = await call<{ id: string } | null>(`setup.${name}.session.${display}`, 'session:getByMember', {
        memberId: member.id
      })
      if (!session) throw new Error(`member:create 之后没有会话（${name}/${display}）—— 与「会话与成员同生」的契约矛盾`)
      members[display] = { memberId: member.id, sessionId: session.id }
    }
    return { workspaceId: ws.id, name, projectId: proj.id, members }
  }

  // ★ 顺序就是发言者的顺序：Composer 默认选 `enabled[0]`，也就是**第一个建的**那个成员。
  const sable = await build('Sable', PERSONA_PLAIN, ['Atlas', 'Nyx', 'Echo', 'Juno'])
  const rill = await build('Rill', PERSONA_RALLY, ['Vex', 'Wisp'])

  /**
   * ★ 视图必须真的切到 Sable：合批器按 `ActiveView.workspaceId` 抑制，
   * 而视图是**内存态**（每次启动都是 null，不落库），所以每次启动都要重设一遍。
   * 漏了这一步，第一批就会被合法地抑制掉，而现象看起来像「流式没通」。
   */
  await call('setup.view', 'view:setActive', {
    workspaceId: sable.workspaceId,
    sessionId: sable.members.Atlas?.sessionId ?? null
  })

  const ids: SetupIds = { sable, rill }
  rec({ kind: 'note', tag: 'ids', text: JSON.stringify(ids) })
  return ids
}

/**
 * ★ **Composer 的 `@` 采集**（§5.1 的跳 1）—— 全是点发送**之前**的事，所以零成本。
 *
 * 它一次走完五件事，每一件都是报告里的一条判据：
 *
 * 1. 打 `@Ny` → 浮层弹出、候选里**没有发言者自己**（自己 @ 自己是个诱饵，主进程也会拒）。
 * 2. 从候选里选 Nyx → 正文被替换成完整人名 + 一个空格。
 * 3. chip 出现，且**点一下切成「抄送」、再点一下切回来**（`kind` 的开关在 chip 上）。
 * 4. 手打一个**没被选中**的 `@` → 正文下方出现那行提示。
 *    ★ 这一条是「失败不能是静默的」那条产品判决的可执行形态：
 *    用户以为他 @ 到了人，而派发只认从浮层里选出来的那些。
 * 5. 最后**把正文清空** —— 采集完的输入框不能把状态留给后面真正的发送。
 */
async function captureScenario(tag: string): Promise<void> {
  const typed = await typeInto(`${tag}.at`, 'textarea', '@Ny')
  await sleep(250)
  await probe(`${tag}.popup`, 'window.__m7b.mentionPopup()')

  const picked = String(await evaluate(`window.__m7b.clickMention('Nyx')`))
  rec({ kind: 'ui', label: currentLabel, tag: `${tag}.pick`, action: 'clickMention', result: picked, typed })
  await sleep(250)
  await probe(`${tag}.chips`, 'window.__m7b.chips()')
  await probe(`${tag}.value`, 'window.__m7b.value("textarea")')

  const toCc = await click(`${tag}.toCc`, 'button', '@Nyx')
  await sleep(200)
  await probe(`${tag}.chipsCc`, 'window.__m7b.chips()')

  const toTo = await click(`${tag}.toTo`, 'button', '@Nyx')
  await sleep(200)
  await probe(`${tag}.chipsBack`, 'window.__m7b.chips()')

  await typeInto(`${tag}.stray`, 'textarea', '@Nobody 你好')
  await sleep(250)
  await probe(`${tag}.strayHint`, 'window.__m7b.strayHint()')

  await typeInto(`${tag}.clear`, 'textarea', '')
  await sleep(200)
  rec({
    kind: 'note',
    tag: `${tag}.done`,
    text: `pick=${picked} toCc=${toCc} toTo=${toTo}`
  })
  say(`  @ 采集         候选 → chip → 切 cc → 切回来 → 未选中提示（全部在点发送之前）`)
}

interface Compose {
  /** 从浮层里挨个选的成员（`to`）。顺序 = 发现顺序。**正文只由这一步决定**。 */
  to: string[]
  /** 选完再点一次 chip 切成「抄送」的成员。★ **必须是 `to` 的子集**（见下）。 */
  cc: string[]
  body: string
}

/**
 * 走界面把正文与 `@` 一起打进去，然后点发送。
 *
 * ★ 两个坑，都写在代码里：
 *
 * 1. **`type()` 是赋值，不是追加** —— 每次都要把「选完这个人之后正文该长什么样」整段算出来
 *    再写进去。所以下面用一个 `composed` 变量累积，而不是一段段往后接。
 * 2. **先从浮层里选人，再打字**：选中会把正文里 `@` 之后的半截**替换**掉
 *    （`pickCandidate` 的 `text.slice(0, at)`），所以人必须在正文之前选完。
 *
 * ★★ 3. **`cc` 的成员必须已经在 `to` 里** —— 这不是限制，是「两次发送的正文逐字相同」那条前提的用法。
 *
 * 为什么：正文里留的是用户看到的那句话（`@Nyx @Echo @Juno …`），而**去重键哈希的正是这句原文**。
 * 把「抄送」实现成「再点一次候选」会往正文里**再追加一个 `@Echo `**（6 个字节），
 * 于是两次发送的正文不同、键不同、去重**从不生效** —— 而它不报错，
 * 现象只是「Juno 被派了两轮、钱花了两遍」（第二次真机跑实测到的就是这个：正文 54 字 vs 48 字）。
 * 切成抄送走的是 chip 的点击，它**不动正文**，只改 `kind` ✓。
 * ⇒ 这里的规则：**先按 `to` 的顺序点一遍候选（正文只由这一步决定），再把 `cc` 那几个人点成抄送。**
 * 一个人的名字在 `cc` 里却不在 `to` 里，就走不成这条路 —— 那是走查自己的程序错误，当场抛，
 * 别让它静默地改掉正文（§8.8e 规则三：算不出来就喊，不许印成 ✅）。
 */
async function composeAndSend(tag: string, c: Compose): Promise<void> {
  const extraCc = c.cc.filter((n) => !c.to.includes(n))
  if (extraCc.length > 0) {
    throw new Error(
      `composeAndSend：${extraCc.join('、')} 在 cc 里却不在 to 里 —— ` +
        '那只能靠「再点一次候选」实现，而它会往正文里追加一个 @名字，破坏「两次发送正文逐字相同」'
    )
  }
  let composed = ''
  for (const name of c.to) {
    const typed = await typeInto(`${tag}.at`, 'textarea', `${composed}@${name.slice(0, 2)}`)
    await sleep(250)
    const picked = String(await evaluate(`window.__m7b.clickMention(${JSON.stringify(name)})`))
    rec({
      kind: 'ui',
      label: currentLabel,
      tag: `${tag}.pick.${name}`,
      action: 'clickMention',
      result: picked,
      typed
    })
    await sleep(200)
    composed = `${composed}@${name} `
  }
  for (const name of c.cc) {
    const r = await click(`${tag}.cc.${name}`, 'button', `@${name}`)
    rec({ kind: 'ui', label: currentLabel, tag: `${tag}.cc.${name}`, action: 'toggleCc', result: r })
    await sleep(150)
  }
  await typeInto(`${tag}.body`, 'textarea', composed + c.body)
  await sleep(250)
  await probe(`${tag}.composed`, 'window.__m7b.chips()')
  const sent = await click(`${tag}.send`, 'button', '发送')
  rec({
    kind: 'note',
    tag: `${tag}.send`,
    text:
      `to=${c.to.join(',')} cc=${c.cc.join(',')} composed=${composed.length} chars ` +
      `body=${c.body.length} chars 全文长度=${(composed + c.body).length}`,
    clicked: sent
  })
  say(
    `  走界面发了一条：@ ${c.to.join('、')}` +
      (c.cc.length > 0 ? `（其中 ${c.cc.join('、')} 是抄送）` : '') +
      `（正文 ${c.body.length} 字、全文 ${(composed + c.body).length} 字，点击=${sent}）`
  )
}

async function collect(dir: string): Promise<void> {
  runDir = dir
  mkdirSync(runDir, { recursive: true })

  rule('M7b 走查 · 准备')
  prepareSandbox()

  rule('启动 A · 夹具')
  launch('A')
  await connectCdp()
  await evaluate(HELPERS)
  const hooked = await evaluate('window.__m7b.hook()')
  rec({ kind: 'note', tag: 'hooked', text: String(hooked) })
  startPump()
  await sleep(700)
  await domSnapshot('A:startup')

  const ids = await setup()
  dumpDb('A', 'setup')
  // ★ 夹具是走 IPC 建的，界面还不知道 —— 重载一次让库重新读进 store（见 `reloadRenderer`）。
  await reloadRenderer()
  const picked = await click('A:pickSable', 'aside button', 'Sable')
  rec({ kind: 'note', tag: 'A:pickSable', text: picked })
  await sleep(400)

  if (DRY) {
    /**
     * 干跑自检：桥在构建版里暴露了吗？对话视图打得开吗？输入区在吗？受控输入通吗？
     * 以及 M7b 独有的两条：**扇出的三处接线**（静态核对）与
     * ★ **Composer 的 `@` 采集**（这一段本来就在点发送之前，所以能在干跑里跑完）。
     *
     * ⚠️ 说清楚干跑**测不到**什么：所有「派发出去之后」的事（转述消息、跳数、去重、
     * 三条熔断）都要真跑轮次才有内容。干跑挡得住「接线漏了 / 采集坏了」，挡不住
     * 「派发的判决错了」。
     */
    staticWiringCheck()
    const before = await evaluate(
      'JSON.stringify({' +
        'api: typeof window.api?.invoke, on: typeof window.api?.on, hooked: window.__m7b.hooked,' +
        'header: window.__m7b.headerName(), speaker: window.__m7b.speaker()' +
        '})'
    )
    rec({ kind: 'note', tag: 'dry.before', text: String(before) })
    say(`  干跑探针（概览）  ${String(before)}`)

    const opened = await openConversation('A:dry')
    const after = await evaluate(
      'JSON.stringify({textarea: window.__m7b.has("textarea"), send: window.__m7b.count("button")})'
    )
    rec({ kind: 'note', tag: 'dry.after', text: String(after), opened })
    say(`  干跑探针（对话）  ${String(after)}`)

    /**
     * ★ 零成本地验一次**发送路径上最脆的那一环：受控输入**（照 M6b）。
     * 直接 `el.value = x` 在 React 里**不触发** `onChange` —— 输入框看着有字、
     * 状态还是空的、点「发送」什么也不会发生，而现象是「点了没反应」。
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

    // ★ M7b 独有的一段：`@` 采集全流程（打字 / 弹层 / 选中 / chip / 切 cc / 未选中提示）。
    await captureScenario('A:dry.capture')
    await smokeHelpers()

    stopPump()
    const pidDry = currentChild?.pid ?? 0
    hardKill('A')
    await waitGone(pidDry)
    rule('干跑结束（**没有发起任何轮次，没花钱**）')
    say('  地基这一层：构建产物起得来、CDP 连得上、preload 桥在构建版里可用、夹具走 IPC 全过、')
    say('  对话视图打得开、输入区与发送按钮都在、受控输入通、扇出三处接线都在、`@` 采集全流程通。')
    say('  ⚠️ **没测到**：派发出去之后的一切（转述消息、跳数、去重、三条熔断）—— 那些要真轮次。')
    say('  下一句才是真机：npm run walk:m7b（真花钱，≈10 轮）。')
    return
  }

  // ══════════════════════════════════════════════════════════
  // 场景组 A · Sable：用户 `@` 的采集与扇出（不依赖模型）
  // ══════════════════════════════════════════════════════════
  rule('Sable · 打开对话 + Composer 的 @ 采集')
  const openedA = await openConversation('A:sable')
  rec({ kind: 'note', tag: 'A:sable.opened', text: String(openedA) })
  await captureScenario('A:sable.capture')

  /**
   * ★ 用户自己发的那一轮落在**发言者的会话**里 —— 这条空间里发言者是 Atlas，
   * 所以「两次发送各自那一轮」= Atlas 会话里两条 0 跳轮次（见 `waitOwnTurnId`）。
   */
  const atlasSessionForSend = ids.sable.members.Atlas?.sessionId ?? ''
  rule('Sable · 第一次发送（@ Nyx、Echo、Juno 三个「派发」）')
  const sinceA1 = recs.length
  await composeAndSend('A:sable.send1', { to: ['Nyx', 'Echo', 'Juno'], cc: [], body: TEXT_SABLE })
  const turnA1 = await waitOwnTurnId(
    'A:sable.send1.turnId',
    'A',
    30000,
    atlasSessionForSend,
    sinceA1
  )
  if (turnA1 === null) throw new Error('点了发送，但那个会话里始终没有出现 0 跳的活轮次 —— 消息没发出去')
  rec({ kind: 'note', tag: 'A:sable.turn1', text: turnA1 })

  /**
   * ★ 等「Nyx 在跑、Juno 在排队」这一瞬间，然后**立刻**发第二条。
   *
   * 为什么非要这个形状：去重只对**尚未执行的尾部**（`queued`）生效。
   * 一次 @ 三个人 + 用户自己那一轮 = 4 条轮次抢 3 个槽位 ⇒ 最后一条（Juno）必然是排队的，
   * 而先跑起来的那两条是 `running`。于是第二条消息里：
   * - 对 Juno：命中去重（尾部里有它）⇒ **不该多建轮次**；
   * - 对 Nyx：**不在**尾部（它在跑）⇒ 照常建一条 ⇒ 这就是那张反向对照。
   *
   * 等不到就如实记 `hit:false`，后面那两条判据降级成 `unknown`（不是失败）。
   */
  rule('Sable · 等到「一个在跑、一个在排队」，然后第二次发送（同一段正文）')
  const nyxSession = ids.sable.members.Nyx?.sessionId ?? ''
  const junoSession = ids.sable.members.Juno?.sessionId ?? ''
  const shape = await waitLiveShape(
    'A:sable.pre2',
    ids.sable.workspaceId,
    (live) => statusIn(live, nyxSession) === 'running' && statusIn(live, junoSession) === 'queued',
    45000
  )
  say(
    `  形状            Nyx=${String(statusIn(shape.live, nyxSession))} ` +
      `Juno=${String(statusIn(shape.live, junoSession))}（hit=${shape.hit}）`
  )
  // ★ 先转储再发第二条：这份 `burst` 是「第一次发送之后」的干净形状。
  dumpDb('A', 'burst')

  const sinceA2 = recs.length
  /**
   * ★★ **`to` 的顺序必须与第一次逐字相同（Nyx、Echo、Juno）** —— 第二次只切 Echo 的 `kind`。
   *
   * 为什么这次序是硬的：正文里留的是「用户看到的那句话」，也就是
   * `@Nyx @Echo @Juno ` —— 而**去重键哈希的正是这句原文**。
   * 第一次真机跑里第二次的 `@` 顺序跟第一次不一样（`@Juno @Nyx @Echo`），
   * 于是正文差了几个字节、键不同、去重**一次都没生效** —— 而它不报错，
   * 现象只是「Juno 被派了两轮」。**这就是「算不中」那种安静失败的样子**，
   * 所以报告里有一条判据专门盯着「两句正文逐字相同」这个前提。
   *
   * 切 `cc` 走的是 chip 的点击（`cc` 那一项），它**不动正文**，只改 `kind` ✓。
   * ⇒ 采集侧也钉死了一条：`cc` 必须是 `to` 的子集，**不许**靠「再点一次候选」来表现抄送
   * （那会往正文里追加一个 `@Echo `——第二次真机跑正是这么毁掉这条判据的，见 `composeAndSend`）。
   */
  await composeAndSend('A:sable.send2', {
    to: ['Nyx', 'Echo', 'Juno'],
    cc: ['Echo'],
    body: TEXT_SABLE
  })
  const turnA2 = await waitOwnTurnId(
    'A:sable.send2.turnId',
    'A',
    30000,
    atlasSessionForSend,
    sinceA2
  )
  if (turnA2 === null) throw new Error('第二次发送也没有出现 0 跳的活轮次 —— 消息没发出去')
  rec({ kind: 'note', tag: 'A:sable.turn2', text: turnA2 })

  rule('Sable · 等这一批跑完（同时观测并发闸门）')
  // 排队的那些会自己排空：`waitQuiet` 的观测摘要（含并发峰值）由它自己落档，报告读 `A:sable.quiet`。
  await waitQuiet('A:sable.quiet', ids.sable.workspaceId, 300000, 12)
  await drain()
  await waitTerminal('A:sable.terminal', turnA1, 15000)
  await sleep(700)
  await drain()
  await pullAppCtx('A')
  await pullAppWarn('A')
  await domSnapshot('A:after-sable')
  dumpDb('A', 'final')

  // ══════════════════════════════════════════════════════════
  // 场景组 B · Rill：agent 之间的链（依赖模型）
  // ══════════════════════════════════════════════════════════
  rule('Rill · 切空间 + 采集一遍（顺带验切换之后发言者回落到第一个人）')
  const pickedRill = await click('A:pickRill', 'aside button', 'Rill')
  rec({ kind: 'note', tag: 'A:pickRill', text: pickedRill })
  await sleep(500)
  const openedB = await openConversation('A:rill')
  rec({ kind: 'note', tag: 'A:rill.opened', text: String(openedB) })
  await captureScenario('A:rill.capture')
  await probe('A:rill.speaker', 'window.__m7b.speaker()')

  rule('Rill · 第一跳：用户 → Vex（回复里会点名 Wisp）')
  const sinceB = recs.length
  /**
   * ★★ **这次发送一个 chip 都不选**（`to: []`）—— 这是 ② 的**最纯形态**。
   *
   * 第一次真机跑里我给这条消息挂了 `@Wisp`，于是同一个人被**两条路**各派了一轮：
   * ① 用户在正文里 @ 了 Wisp（`turn:send` 那条路，深度 0+1 = 1）
   * ② Vex 的回复里也点了 Wisp 的名（`onTurnFinished` 那条路，深度 0+1 = 1）
   * 转述正文不同（一条写「在刚发的那条消息里」、一条写「在它上一轮的回复里」）
   * ⇒ 去重键不同 ⇒ **Wisp 拿到两条同深度、内容重复的轮次**。
   *
   * 那不是缺陷（两条路的依据确实不同），但那**不是 ② 要测的东西** ——
   * ② 测的是「A 的回复里 @ B ⇒ B 被派发」，所以链必须**只由回复驱动**。
   */
  const vexSession = ids.rill.members.Vex?.sessionId ?? ''
  await composeAndSend('A:rill.send', { to: [], cc: [], body: TEXT_RALLY })
  const turnB = await waitOwnTurnId('A:rill.send.turnId', 'A', 30000, vexSession, sinceB)
  if (turnB === null) throw new Error('Rill 那条消息没有出现 0 跳的活轮次 —— 消息没发出去')
  rec({ kind: 'note', tag: 'A:rill.turn1', text: turnB })

  /**
   * ★ 等这条链自己走完（或撞上钱闸）。
   *
   * 4 跳就结束是**设计值**：用户那一跳是 0 跳、之后每一跳 +1，而
   * 连续空转到第 4 跳时会强制终止。所以这个空间最多 4 条轮次 ——
   * `cap=8` 是留给「熔断没兜住」时的钱闸：真到那一步，报告要把它当 ❌ 印出来。
   */
  rule('Rill · 等链走完（2 跳警告、4 跳终止都在这段里）')
  await waitQuiet('A:rill.quiet', ids.rill.workspaceId, 420000, 8)
  await drain()
  await sleep(900)
  await drain()
  await pullAppCtx('A')
  await pullAppWarn('A')
  await domSnapshot('A:after-rill')
  dumpDb('A', 'chain')

  rec({ kind: 'note', tag: 'ids.final', text: JSON.stringify({ ...ids, turnA1, turnA2, turnB }) })

  // ── 收尾：让它走一次正常退出 ──
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
// 观测通道：主进程的两条流
// ─────────────────────────────────────────────────────────────

/** 已经进过归档的 `[ctx]` 行（按 turnId 去重，跨多次调用）。 */
const seenCtx = new Set<string>()
const seenWarn = new Set<string>()

/**
 * 把主进程 stdout 里的 `[ctx] {json}` 行拉进归档。
 *
 * M7b 不判装配形状（那是 M7a 的活），留着它是为了回答一个更弱的问题：
 * **这几轮真的走过装配那一段吗**。它同时是「走查与主进程不在同一个进程里」
 * 这条限制的一个提醒：能看见主进程的 `console.log` 只是因为**它落进了文件**。
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
}

/**
 * 把主进程 stderr 里的 `[runtime:<tag>] …` 行拉进归档。
 *
 * ★ 这是**三条熔断判决的唯一直接证据**：`fanout.ts` 的每个判决都走 `onWarn`，
 * 于是 `[runtime:fanout:ping-pong-warn]` / `[runtime:fanout:ping-pong-terminate]` /
 * `[runtime:fanout:mention-deduped]` 会一字不差地落在这里。
 * 单测只能证明那些函数返回了什么；这一条证明它在**生产路径**上真的发生了。
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

/** 一条 `probe` 记录的返回值（`reportDry` 与 `report` 共用）。 */
function probeOf(tag: string): unknown {
  const r = pick('probe', tag)
  if (!r || r.ok !== true) return undefined
  try {
    return JSON.parse(String(r.text)) as unknown
  } catch {
    return undefined
  }
}

/** 一条 `note` 记录里的 JSON 载荷。 */
function noteOf<T>(tag: string, fallback: T): T {
  const r = pick('note', tag)
  if (!r) return fallback
  try {
    return JSON.parse(String(r.text)) as T
  } catch {
    return fallback
  }
}

type Dump = Record<string, Array<Record<string, unknown>>>

function dumpOf(label: string, phase: string): Dump | undefined {
  const p = join(runDir, `db-${label}-${phase}.json`)
  if (!existsSync(p)) return undefined
  return JSON.parse(readFileSync(p, 'utf8')) as Dump
}

/** 这个空间里的轮次（按 `queued_at` 升序 —— 库转储里没有排序保证，所以要自己排）。 */
function turnsOf(dump: Dump, workspaceId: string): Array<Record<string, unknown>> {
  return (dump.turn ?? [])
    .filter((t) => t.workspace_id === workspaceId)
    .sort((a, b) => Number(a.queued_at ?? 0) - Number(b.queued_at ?? 0))
}

function turnsInSession(dump: Dump, sessionId: string): Array<Record<string, unknown>> {
  return (dump.turn ?? []).filter((t) => t.session_id === sessionId)
}

function msgsInSession(dump: Dump, sessionId: string): Array<Record<string, unknown>> {
  return (dump.message ?? []).filter((m) => m.session_id === sessionId)
}

/** 一条消息的正文（转述消息就是判据的载体）。 */
function bodyOf(dump: Dump, messageId: unknown): string {
  return String((dump.message ?? []).find((m) => m.id === messageId)?.content_text ?? '')
}

/**
 * 干跑的报告。**它只判「地基」** —— 零成本那一层能测到的东西。
 *
 * ★ §8.8e 规则三：**缺证据不许印成 ✅**。M6b 第一次干跑的版本只看了「有没有 error」，
 * 于是它在「顶栏压根没渲染、输入区根本不存在」的情况下印了一句「干跑干净」。
 *
 * ★ M7b 的干跑比 M7a 多一段**真判据**：`@` 采集的五个动作全都发生在点发送之前，
 * 所以它们**能在干跑里判**（而 M7a 那条 `[ctx]` 通道只能等到真机）。
 */
function reportDry(): number {
  failures = 0
  unknowns = 0

  rule('干跑：只判地基（零成本，一个轮次都没发）')
  for (const e of recs.filter((r) => r.kind === 'error')) {
    check('bad', `采集器记到一条错误：[${String(e.tag ?? '?')}] ${String(e.message ?? '')}`)
  }

  const before = (() => {
    try {
      return JSON.parse(String(pick('note', 'dry.before')?.text ?? '{}')) as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  const after = (() => {
    try {
      return JSON.parse(String(pick('note', 'dry.after')?.text ?? '{}')) as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  const reloaded = String(pick('note', 'reload')?.text) === 'true'

  check(
    before.api === 'function' && before.on === 'function' ? 'ok' : 'bad',
    `preload 桥在**构建产物**里可用（invoke=${String(before.api)} on=${String(before.on)}）—— ` +
      'dev 能跑不等于构建版能跑，走查跑的是构建版'
  )
  check(reloaded ? 'ok' : 'bad', '渲染进程重载之后桥又回来了（重载是夹具变成界面可见的唯一手段）')
  check(
    before.hooked === true ? 'ok' : 'bad',
    '推送钩子装上了（`stream:batch` / `stream:status` / `workspace:unread` / `app:notice`）'.replace(/`/g, '')
  )
  check(
    String(pick('note', 'A:pickSable')?.text) === 'clicked' ? 'ok' : 'bad',
    '在左栏点得中空间（装配出来的空间在界面上真的存在）'
  )
  check(
    typeof before.header === 'string' && before.header !== '' && before.header !== 'null' ? 'ok' : 'bad',
    `顶栏渲染出来了、而且显示的是被选中的那个空间的名字：${String(before.header)}`
  )
  check(
    String(pick('note', 'A:dry.pane')?.text) === 'true' && after.textarea === true ? 'ok' : 'bad',
    `点「对话」真的打开了对话视图、输入区在里面（textarea=${String(after.textarea)}）`
  )
  check(Number(after.send) >= 1 ? 'ok' : 'bad', `发送按钮在（页面上共 ${String(after.send)} 个 button）`)

  const typed = pick('note', 'dry.type')
  check(
    typed?.typed === 'typed' && String(typed?.text) === 'false' ? 'ok' : 'bad',
    `受控输入：写进 textarea = ${String(typed?.typed)}，发送按钮因此变为可点（disabled=${String(typed?.text)}）` +
      ' —— `disabled` 还是 true 就说明 React 没收到 onChange，点了发送也不会有任何事发生'.replace(/`/g, '')
  )

  /**
   * ★ M7b 独有的那一条地基：**扇出的三处接线**。
   * 它是静态的（读三份源码），所以只值「接线在不在」这一个问题 ——
   * 但漏掉任何一处，真机那一趟就是在**一个功能是死的**的情况下花钱。
   */
  const wiring = pick('note', 'dry.wiring')
  check(
    String(wiring?.text ?? '') === 'wired' ? 'ok' : 'bad',
    `扇出的三处接线都在（createFanout=${String(wiring?.assembled)} ` +
      `fanoutUserMentions=${String(wiring?.userPath)} onTurnFinished=${String(wiring?.finishPath)}）—— ` +
      `**静态核对**：它不证明判决对，只证明没忘了接（${String(wiring?.runtimeFile ?? '?')} 等三份）`
  )

  // ── ★ `@` 采集（这一段全在点发送之前，所以干跑就能判）──
  rule('干跑 · Composer 的 @ 采集（零成本，也是真机里那一段的重放）')
  const cap = 'A:dry.capture'
  const popup = probeOf(`${cap}.popup`) as { open?: boolean; names?: string[] } | undefined
  const chips = probeOf(`${cap}.chips`) as string[] | undefined
  const value = probeOf(`${cap}.value`)
  const chipsCc = probeOf(`${cap}.chipsCc`) as string[] | undefined
  const chipsBack = probeOf(`${cap}.chipsBack`) as string[] | undefined
  const stray = probeOf(`${cap}.strayHint`)
  const done = pick('note', `${cap}.done`)

  check(
    popup?.open === true && (popup.names ?? []).includes('Nyx') && !(popup.names ?? []).includes('Atlas')
      ? 'ok'
      : 'bad',
    `★ 打 \`@Ny\` 弹出候选浮层、里面有 Nyx、**没有发言者自己**（Atlas）—— ` +
      `实得 open=${String(popup?.open)} names=${JSON.stringify(popup?.names ?? [])}`.replace(/`/g, '')
  )
  check(
    Array.isArray(chips) && chips[0] === '@Nyx' ? 'ok' : 'bad',
    `从候选里选中 ⇒ 正文里出现 chip（实得 ${JSON.stringify(chips ?? [])}）—— ` +
      '★ 这一步是**离散的选中动作**，`mentions` 从这一刻起才是结构化的（§3.1 禁的是从文本里猜）'
  )
  check(
    String(value) === '@Nyx ' ? 'ok' : 'bad',
    `★ 选中把半截 \`@Ny\` 换成了完整人名 + 一个空格（实得 ${JSON.stringify(value)}）—— ` +
      '正文里留的是**用户看到的那句话**，而 mentions 是另一份结构化的事实'.replace(/`/g, '')
  )
  check(
    (chipsCc ?? [])[0] === '@Nyx（抄送）' && (chipsBack ?? [])[0] === '@Nyx' ? 'ok' : 'bad',
    `chip 点一下切成「抄送」、再点一下切回来（实得 ${JSON.stringify(chipsCc ?? [])} → ` +
      `${JSON.stringify(chipsBack ?? [])}）—— \`kind\` 的开关就在这里，而 \`cc\` 的语义**必须实现**，` +
      '否则就是「界面上标了 cc、实际什么都没发生」'.replace(/`/g, '')
  )
  check(
    stray === true ? 'ok' : 'bad',
    '★ 手打一个没被选中的 `@` ⇒ 正文下方出现那行提示（`strayHint`）—— ' +
      '「我 @ 了他但他没收到」这条静默失败，比多一行提示贵得多'.replace(/`/g, '')
  )
  check(
    typeof done?.text === 'string' && String(done.text).includes('toCc=clicked') ? 'ok' : 'bad',
    `采集五步都点到了（${String(done?.text ?? '（没有记录）')}）`
  )

  const helperRecs = recs.filter((r) => r.kind === 'probe' && String(r.tag).startsWith('dry.helper.'))
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
    '⚠️ **干跑测不到**：派发出去之后的一切（转述消息、跳数记账、去重、三条熔断）—— ' +
      '它们都要真轮次才有内容，`report()` 把它们当第一等判据'
  )

  rule('干跑结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '地基干净，可以花真钱了（npm run walk:m7b）' : `${failures} 条不通过 —— **先修地基，再花真钱**`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  return failures
}

// ─────────────────────────────────────────────────────────────
// 真机报告（**只读归档**）
// ─────────────────────────────────────────────────────────────

/** 一段正文里有没有那个标记块 —— 「模型到底 @ 了没」只看这一条。 */
function hasMentionsBlock(text: string): boolean {
  return /<mentions>[\s\S]*?<\/mentions>/.test(text)
}

/**
 * 把一段正文里的**空白折叠成单个空格**再比 —— 用来判「转述逐字带着原文」。
 *
 * 为什么要它：转述是把原文**嵌进一段模板**里（`relayTextOf` 的 `\n\n—— 以下是原文 ——\n\n`），
 * 而模型自己的回复里换行/空行怎么写是不定的。逐字节比对会因为这些空白红成 ❌ ——
 * 那是**判据太窄**，不是产品错了。折叠空白只放宽「怎么排版」，不放过「换了字」。
 */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 一段正文里那个标记块的**内容**（没有就返回空串）。 */
function mentionsBlockOf(text: string): string {
  const m = /<mentions>([\s\S]*?)<\/mentions>/.exec(text)
  return m ? (m[1] ?? '').trim() : ''
}

function report(): number {
  failures = 0
  unknowns = 0

  const ids = noteOf<SetupIds | Record<string, never>>('ids', {})
  const sable = 'sable' in ids ? ids.sable : undefined
  const rill = 'rill' in ids ? ids.rill : undefined
  const env = pick('note', 'env')
  const markers = pick('markers', 'markers')

  const dumpBurst = dumpOf('A', 'burst')
  const dumpFinal = dumpOf('A', 'final')
  const dumpChain = dumpOf('A', 'chain')

  rule('环境（端点限定语写在最前面）')
  say(`  归档            ${runDir}`)
  say(`  沙箱            ${String(env?.sand ?? '?')}`)
  say(`  模型            ${String(env?.model ?? '?')}（端点 = 本机默认凭据所指向的那个）`)
  say(`  标记后缀        ${String(markers?.nonce ?? '（归档里没有 markers 记录）')}`)
  say(`  Sable           4 人（Atlas 发言）· 测采集 / ① 一次 @ 多个 / ⑤ 去重 / cc / ⑥ 并发闸门`)
  say(`  Rill            2 人（Vex 发言）· 测 ② agent 接力 / ③ 2 跳警告 / ④ 4 跳终止`)
  say('  ⚠️ 全部结论只在**本机默认凭据所指向的那个端点**下成立，不是 Anthropic 官方行为。')
  say('     而「模型会不会在回复末尾写 `<mentions>`」**是端点的行为**，不是本应用的行为 ——')
  say('     所以 Rill 那三条只在这个端点下成立，换端点要重跑。')

  check(
    markers !== undefined ? 'ok' : 'bad',
    '归档里有本次的标记后缀与两条消息正文 —— 报告的一半判据是「两次发送的正文逐字相同」，' +
      '丢了它就等于丢了判据'
  )
  check(
    sable !== undefined && rill !== undefined ? 'ok' : 'bad',
    '两个空间的夹具 id 都在归档里'
  )
  if (!sable || !rill) {
    check('bad', '夹具 id 缺失 —— 下面所有按会话/空间过滤的判据都无从谈起')
    return failures
  }

  const atlas = sable.members.Atlas
  const nyx = sable.members.Nyx
  const echo = sable.members.Echo
  const juno = sable.members.Juno
  const vex = rill.members.Vex
  const wisp = rill.members.Wisp
  if (!atlas || !nyx || !echo || !juno || !vex || !wisp) {
    check('bad', '有成员的 id 不在归档里 —— 判不了')
    return failures
  }

  // ══ 观测通道 ═══════════════════════════════════════════════
  rule('观测通道 · 三条都在吗')
  const ctxRecs = recs.filter((r) => r.kind === 'ctx')
  const warns = recs.filter((r) => r.kind === 'warn')
  const warnTags = warns.map((w) => String(w.tag))
  const notices = recs.filter((r) => r.kind === 'notice')
  say(`  [ctx] ${ctxRecs.length} 条 · [runtime:…] ${warns.length} 条 —— [${warnTags.join(' ')}]`)
  say(`  推送到的 app:notice ${notices.length} 条`)
  check(
    ctxRecs.length > 0 ? 'ok' : 'bad',
    `主进程 stdout 里的 \`[ctx]\` 行拉到了 ${ctxRecs.length} 条 —— ` +
      '它只证明这几轮真的走过装配那一段（装配形状本身是 M7a 的判据）'.replace(/`/g, '')
  )

  // ══ Sable · 采集 ═══════════════════════════════════════════
  rule('Sable A1 · Composer 的 @ 采集（真机里那一段）')
  const cap = 'A:sable.capture'
  const popup = probeOf(`${cap}.popup`) as { open?: boolean; names?: string[] } | undefined
  const chips = probeOf(`${cap}.chips`) as string[] | undefined
  const chipsCc = probeOf(`${cap}.chipsCc`) as string[] | undefined
  check(
    popup?.open === true && (popup.names ?? []).includes('Nyx') && !(popup.names ?? []).includes('Atlas')
      ? 'ok'
      : 'bad',
    `候选浮层、里面有 Nyx、没有发言者自己（实得 ${JSON.stringify(popup ?? null)}）`
  )
  check(
    Array.isArray(chips) && chips[0] === '@Nyx' && (chipsCc ?? [])[0] === '@Nyx（抄送）' ? 'ok' : 'bad',
    `chip 出现、点一下切「抄送」（${JSON.stringify(chips ?? [])} → ${JSON.stringify(chipsCc ?? [])}）`
  )

  /**
   * ★ 采集那一段最硬的一条：**库里 `mentions_json` 里的东西，与界面上那三个 chip 逐个对得上**。
   *
   * 它同时是「结构化采集，不是解析文本」的可执行形态：正文里那三个 `@名字` 是给人看的，
   * 派发依据是这一列。两者的成员 id 必须一一对应 —— 对不上就是「界面说派了 A、实际派了 B」。
   */
  const sourceMsg = (dumpFinal?.message ?? []).find(
    (m) =>
      m.id ===
      // ★ 取**最早**的那一条 0 跳轮次（用户手发的那一轮）—— 库转储没有排序保证，
      // 所以这里先按 `queued_at` 排一次；不排的话第二次发送那条会随机赢。
      (((dumpFinal?.turn ?? [])
        .filter((t) => t.session_id === atlas.sessionId && Number(t.hop_depth) === 0)
        .sort((a, b) => Number(a.queued_at ?? 0) - Number(b.queued_at ?? 0))[0] ?? {}) as Record<string, unknown>).trigger_message_id
  )
  let sourceMentions: Array<{ memberId?: string; kind?: string }> = []
  try {
    sourceMentions = JSON.parse(String(sourceMsg?.mentions_json ?? '[]')) as typeof sourceMentions
  } catch {
    sourceMentions = []
  }
  const sourceIds = sourceMentions.map((m) => String(m.memberId ?? '')).sort()
  const wantIds = [nyx.memberId, echo.memberId, juno.memberId].sort()
  check(
    sourceMsgsOk(sourceMsg) && JSON.stringify(sourceIds) === JSON.stringify(wantIds) ? 'ok' : 'bad',
    `★ 第一条用户消息的 \`mentions_json\` = 界面上那三个 chip（${JSON.stringify(sourceMentions)}）—— ` +
      '派发依据是这一列，不是正文里的文本'.replace(/`/g, '')
  )
  check(
    sourceMentions.every((m) => m.kind === 'to') ? 'ok' : 'bad',
    '三个 mention 的 `kind` 都是 `to`（第一次发送里一个 cc 都没有）'
  )

  // ══ Sable · ① 一次 @ 多个成员 ═══════════════════════════════
  rule('Sable A2 · ① 一次 `@` 三个成员 → 三条转述 + 三条 1 跳轮次'.replace(/`/g, ''))
  if (!dumpBurst) {
    check('unknown', '没有 burst 时点的库转储 ⇒ 这一段判不了（转储失败不该算采集失败）')
  } else {
    const burstTurns = turnsOf(dumpBurst, sable.workspaceId)
    const byDepth = (d: number): Array<Record<string, unknown>> =>
      burstTurns.filter((t) => Number(t.hop_depth) === d)
    say(
      `  burst 时点：轮次 ${burstTurns.length} 条，深度分布 ` +
        `${[0, 1].map((d) => `${d}:${byDepth(d).length}`).join(' ')}`
    )
    check(
      burstTurns.length === 4 && byDepth(0).length === 1 && byDepth(1).length === 3 ? 'ok' : 'bad',
      `★ 一次 @ 三个成员 ⇒ 用户那一轮（0 跳）+ **三条 1 跳轮次**（实得 ${burstTurns.length} 条：` +
        `0 跳 ${byDepth(0).length} / 1 跳 ${byDepth(1).length}，期望 4 / 1 / 3）—— ` +
        '跳数在 `turn.create` 之前就算好了（§3.3：`hop_depth` 没有 updater），' +
        '而「用户直接发起 = 0」是链的打断点'.replace(/`/g, '')
    )
    const relayChecks: Array<[string, MemberIds, string]> = [
      ['Nyx', nyx, '【派发】'],
      ['Echo', echo, '【派发】'],
      ['Juno', juno, '【派发】']
    ]
    for (const [name, m, head] of relayChecks) {
      /**
       * ★ **转述按内容认，不按下标。** 库转储是 `SELECT *`，**没有任何排序保证** ——
       * `msgs[0]` 可能是那条助手回复，判据就会随机地红或绿（第一次真机跑的 Echo 就是这么被误报的）。
       * 这里认三件事：`role:'user'`、作者是发言者、正文以「【派发】」开头。
       */
      const relay = msgsInSession(dumpBurst, m.sessionId).find(
        (x) =>
          x.role === 'user' &&
          String(x.author_member_id) === atlas.memberId &&
          String(x.content_text ?? '').includes(head)
      )
      const body = String(relay?.content_text ?? '')
      /**
       * ★★ **那条转述消息就是那一跳的触发消息**（`turn.trigger_message_id`）——
       * 这条关系比「这个会话里有一条 1 跳轮次」硬得多：它同时钉住了
       * 「B 的那一轮是**因为这条转述**才建的」和「跳数记在 `create` 之前」。
       */
      const turn = turnsInSession(dumpBurst, m.sessionId).find(
        (t) => String(t.trigger_message_id) === String(relay?.id)
      )
      check(
        relay !== undefined &&
          body.includes('已由本应用取出') === false &&
          turn !== undefined &&
          Number(turn.hop_depth) === 1 &&
          String(turn.workspace_id) === sable.workspaceId
          ? 'ok'
          : 'bad',
        `${name} 的会话里有一条**转述消息**（作者 = 发言者 Atlas）+ 一条**由它触发**的 1 跳轮次；` +
          `正文开头是「${head}…」（实得 ${quote(body, 60)}）`
      )
    }
    /**
     * ★ 「派给别人的那一轮 `cwd` 按**对方**算」—— 这里四个人都只有同一个项目，
     * 所以四个 cwd 应当**全都等于那个项目根**。它证不了「按对方算」这条论证，
     * 只证得了「派出去的那几轮真的有 cwd」（`turn.cwd` 是 NOT NULL，缺了它 `create` 会炸）。
     */
    const cwds = burstTurns.map((t) => String(t.cwd ?? ''))
    check(
      cwds.every((c) => c === String(env?.projectDir ?? '')) && cwds.length === 4 ? 'ok' : 'bad',
      `派出去的那三轮都有 cwd，且等于项目根（${quote(JSON.stringify(cwds), 120)}）`
    )
  }

  // ══ Sable · ⑤ 去重 + cc + 「running 不算尾部」════════════════
  rule('Sable A3 · ⑤ 去重（同一对内容在排队尾部）+ `cc` + 「running 不算尾部」'.replace(/`/g, ''))
  const pre2 = noteOf<{ hit?: boolean; live?: LiveTurn[] }>('A:sable.pre2', {})
  const nyxAtSend2 = statusIn(pre2.live ?? [], nyx.sessionId)
  const junoAtSend2 = statusIn(pre2.live ?? [], juno.sessionId)
  say(`  第二次发送那一刻：Nyx=${String(nyxAtSend2)} Juno=${String(junoAtSend2)}（hit=${String(pre2.hit)}）`)
  if (!dumpFinal) {
    check('unknown', '没有 final 时点的库转储 ⇒ 这一段判不了')
  } else {
    /**
     * ★★ **先判前提：两次发送的正文必须逐字相同。**
     *
     * 去重键是 `dedupeKeyOf(memberId, sha256(relayTextOf({authorName, kind:'to', body, …})))`，
     * 而 `body` **就是用户那句原文**（`via:'message'` 那一条）。正文差一个字节
     * ——比如两次 `@` 的先后顺序不一样——就是另一个键。
     * **它不报错，只是从不生效**，现象是「同一个人被派了两轮，钱花了两遍」。
     *
     * ⇒ 这条前提必须**自己判**，不能假设。第一次真机跑就是死在这上面：
     * 第二次发送的 chip 顺序与第一次不同，于是下面三条判据全都在测空气。
     * 前提不成立时，去重那两条一律 `unknown`，**不许印成 ✅**（§8.8e 规则三）。
     *
     * ★ 判据取自**用户自己发出的那两条消息**：`role:'user'` **且作者是发言者**、按 `seq` 升序。
     * 为什么必须加作者这一条：**转述消息也是 `role:'user'`**（作者是把它派出去的那个成员），
     * 而 agent 接力写进来的转述也会落进发言者的会话。
     * 第二次真机跑里那个会话有 3 条用户消息（48 / 107 / 54 字）：两次发送 **加上** 一条
     * Echo 接力写进 Atlas 会话的转述 —— 于是「两句正文」这条判据自己先红了，
     * 而真正该红的东西（两次正文是不是同一个字节串）它没测到。
     *
     * ★ 也不能用采集侧认领的 `turnId`（`A:sable.turn1/2`）：第二次真机跑里它认错了人
     * （返回的是 Nyx 那一轮），因为那时空间里有别的活轮次在推帧、谁先到就认谁。
     * **归档里那两行是假证据** —— 报告不该再依赖它们（采集侧也一并修了，见 `waitOwnTurnId`）。
     */
    const ownSends = msgsInSession(dumpFinal, atlas.sessionId)
      .filter((m) => m.role === 'user' && String(m.author_member_id) === atlas.memberId)
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
    const send1Body = String(ownSends[0]?.content_text ?? '')
    const send2Body = String(ownSends[1]?.content_text ?? '')
    const identical = ownSends.length === 2 && send1Body === send2Body && send1Body !== ''
    check(
      identical ? 'ok' : 'bad',
      `★ 两次发送的正文逐字相同（用户自己的消息 ${ownSends.length} 条，${send1Body.length} / ` +
        `${send2Body.length} 字）—— 去重键里哈希的就是这句原文，它不一致的话下面那几条判据全是空的`
    )
    const relayMsgs = msgsInSession(dumpFinal, atlas.sessionId).filter(
      (m) => m.role === 'user' && String(m.author_member_id) !== atlas.memberId
    )
    say(
      `  旁证：Atlas 会话里另外还有 ${relayMsgs.length} 条 ` +
        `\`role:'user'\` 的**转述**（作者 ${relayMsgs.map((m) => String(m.author_member_id).slice(0, 6)).join('/')}，` +
        `长度 ${relayMsgs.map((m) => String(m.content_text ?? '').length).join('/')} 字）—— ` +
        '别人接力写进来的，所以「这个会话里有几条用户消息」不能当判据'.replace(/`/g, '')
    )

    /**
     * ★★ **派出去的东西按「它挂在哪条转述上」认**，不按会话里的轮次总数认。
     *
     * 理由是第二次真机跑实测到的：协作协议写在 `systemPrompt` 里、**对人设中立**，
     * 所以即使 Sable 的人设没有接力指令，agent 之间照样会接力（实测出现了 Nyx@2 → Atlas@2）。
     * 那些轮次与这两次发送无关，却会把「Nyx 3 条」这种数字塞进来。
     *
     * 认法：① 只认**用户这一路**写出的转述 —— 作者是发言者、措辞是「在刚发的那条消息里」
     * （`relayTextOf` 的 `via:'message'` 那一路；agent 接力写出的那条措辞是「在它上一轮的回复里」）；
     * ② 轮次 = `trigger_message_id` **就在这批转述里**的那些。
     * 于是「转述 ↔ 轮次」这条链是**从归档里算得出来的**，不靠任何下标。
     * ★ 转述也按**内容**认，不按下标：库转储是 `SELECT *`，**没有任何排序保证**
     * （第一次真机跑里 Echo 的第二条消息是它自己的助手回复，于是
     * 「cc 实现了吗」被误报成 ❌ —— 那是报告错了，不是产品错了）。
     *
     * ★★ **只能判总量，判不了「哪一次发送派的」** —— 而这正是判据本身要的东西：
     * 两次正文逐字相同时，两条转述的正文也逐字相同，**按内容分不开**；
     * 但「Juno 那里一共出现 2 条转述 / 2 条轮次」这句就已经是判决了。
     */
    const userPathRelaysOf = (sid: string): Array<Record<string, unknown>> =>
      msgsInSession(dumpFinal, sid).filter(
        (m) =>
          m.role === 'user' &&
          String(m.author_member_id) === atlas.memberId &&
          String(m.content_text ?? '').includes('在刚发的那条消息里')
      )
    const turnsOfRelays = (
      sid: string,
      relays: Array<Record<string, unknown>>
    ): Array<Record<string, unknown>> => {
      const ids = new Set(relays.map((r) => String(r.id)))
      return turnsInSession(dumpFinal, sid).filter((t) => ids.has(String(t.trigger_message_id)))
    }
    const nyxRelays = userPathRelaysOf(nyx.sessionId)
    const junoRelays = userPathRelaysOf(juno.sessionId)
    const echoRelays = userPathRelaysOf(echo.sessionId)
    const nyxTurns = turnsOfRelays(nyx.sessionId, nyxRelays)
    const junoTurns = turnsOfRelays(juno.sessionId, junoRelays)
    const echoTurns = turnsOfRelays(echo.sessionId, echoRelays)
    const ccRelays = echoRelays.filter((m) => String(m.content_text ?? '').includes('【抄送】'))

    check(
      nyxTurns.length === 2 && junoTurns.length === 1 && echoTurns.length === 1 ? 'ok' : 'bad',
      `★ 两条消息加起来派出的轮次 / 转述：Nyx ${nyxTurns.length}/${nyxRelays.length}` +
        `（期望 2/2）、Juno ${junoTurns.length}/${junoRelays.length}（期望 1/1）、` +
        `Echo ${echoTurns.length}/${echoRelays.length}（期望 1/2，多出来的那条是抄送）—— ` +
        'Juno 命中去重只建一条，Nyx 在跑所以照常再派一次（同一个人、同一段正文，两条路的结果必须不同）'
    )
    check(
      nyxAtSend2 === 'running' ? 'ok' : 'unknown',
      nyxAtSend2 === 'running'
        ? '★ 前提成立：第二次发送时 Nyx 那一跳**正在跑**，而它照样被重派了一次 —— ' +
          '§4.5b 逐字：「一旦那一跳**已经执行过**，同一个成员**可以**再次被派发」'
        : `⚠️ 第二次发送时 Nyx 那一跳的状态是 ${String(nyxAtSend2)}（不是 running）⇒ ` +
          '「running 不在去重基准里」这一条**这一次没测到**（实得轮次 ' +
          `${nyxTurns.length} 条）；「已终结的不在基准里」是更弱的一条。单测覆盖了 running 那一支`
    )
    check(
      junoAtSend2 === 'queued' && identical
        ? junoTurns.length === 1 && junoRelays.length === 1
          ? 'ok'
          : 'bad'
        : 'unknown',
      junoAtSend2 === 'queued' && identical
        ? `★ 前提成立：Juno 那一跳在**排队**（尾部），第二条消息没有再建轮次、` +
          `也没有再写一条转述（实得轮次 ${junoTurns.length} 条、转述 ${junoRelays.length} 条，期望各 1）` +
          '—— `fanoutOf` 在**派发之前**就把它从目标里摘掉了（`queuedTailOf` 算出同一个键）'.replace(/`/g, '')
        : `⚠️ 去重那一条这一次没测到：Juno 那一跳在第二次发送时的状态是 ${String(junoAtSend2)}` +
          `（期望 queued；hit=${String(pre2.hit)}），两次正文逐字相同 = ${String(identical)}` +
          `（轮次 ${junoTurns.length} 条、转述 ${junoRelays.length} 条）`
    )
    check(
      echoRelays.length === 2 && ccRelays.length === 1 ? 'ok' : 'bad',
      `★ cc 真的实现了吗：Echo 的会话里有 ${echoRelays.length} 条转述（期望 2），` +
        `其中 ${ccRelays.length} 条是抄送（期望 1）—— 抄送那条写的是「` +
        `${quote(String(ccRelays[0]?.content_text ?? '（没有抄送转述）'), 70)}」` +
        '（必须写明「你不需要行动」）。只进 schema 不实现，就是「界面上标了 cc、实际什么都没发生」'.replace(/`/g, '')
    )
    check(
      warnTags.includes('fanout:mention-deduped') ? 'ok' : junoAtSend2 === 'queued' && identical ? 'bad' : 'unknown',
      warnTags.includes('fanout:mention-deduped')
        ? '★ 生产路径上真的报出了 `fanout:mention-deduped` —— 判决发生在 `fanout.ts` 里，不是报告推出来的'.replace(/`/g, '')
        : junoAtSend2 === 'queued' && identical
          ? '❌ 前提都成立（排队中 + 正文逐字相同）却**没有**这条判决 —— 去重在生产路径上没有生效'
          : '⚠️ 归档里没有 `fanout:mention-deduped`，而前提也没成立 ⇒ 去重的**判决**这一次没被观测到'.replace(/`/g, '')
    )
  }

  // ══ Sable · ⑥ 并发闸门 ═════════════════════════════════════
  rule('Sable A4 · ⑥ 广播时同时 running ≤ 3')
  const quiet = noteOf<{
    maxSlots?: number
    slotsTotal?: number
    maxQueued?: number
    everQueued?: boolean
    peakLive?: number
    capped?: boolean
  }>('A:sable.quiet', {})
  say(
    `  观测：${String(quiet.peakLive)} 条活轮次的峰值，最大并发 ${String(quiet.maxSlots)}/` +
      `${String(quiet.slotsTotal)}，最大队列 ${String(quiet.maxQueued)}`
  )
  check(
    quiet.slotsTotal === 3 && Number(quiet.maxSlots ?? 0) <= 3 ? 'ok' : 'bad',
    `★ 并发上限是 3（实得 ${String(quiet.slotsTotal)}），而观测到的最大并发 ${String(quiet.maxSlots)} **从没超过它**`
  )
  check(
    quiet.everQueued === true ? 'ok' : 'unknown',
    quiet.everQueued === true
      ? '★ 观察到过**排队** —— 这才是「闸门真的在拦」的证据（没排过队也可能只是没超过上限）。' +
        '广播风暴那个产品形态（§4.5b 第 3 条）**没有第四个机制**，槽位就是它唯一的闸门'
      : '⚠️ 没观测到排队（探针每 150ms 一拍，可能只是没拍到）⇒ 「闸门真的在拦」这次没测到'
  )

  // ══ Rill · ②③④ ════════════════════════════════════════════
  rule('Rill B1 · ② A 的回复里 @ B → B 被派发（本里程碑最核心的一条）')
  /**
   * ★ 顺带把「切空间」这件事判掉：发言者必须**回落到当前空间的第一个成员**。
   * `picked` 是 Composer 的组件状态，切空间之后它可能还指着**上一个空间**的成员 id
   * —— 回落（`enabled.find(picked) ?? enabled[0]`）就是防那件事的，
   * 而它坏掉的样子是「以 X 的身份发言」那一排谁也选不中 / 或者选中了一个不在这个空间的人。
   */
  const speakerRill = probeOf('A:rill.speaker')
  check(
    speakerRill === 'Vex' ? 'ok' : 'unknown',
    `切到 Rill 之后发言者是该空间的第一个成员（实得 ${JSON.stringify(speakerRill)}，期望 "Vex"）—— ` +
      '「不信任本地状态」在这一处唯一要做对的事'
  )
  if (!dumpChain) {
    check('unknown', '没有 chain 时点的库转储 ⇒ Rill 这一段全部判不了')
  } else {
    const rillTurns = turnsOf(dumpChain, rill.workspaceId)
    const depths = rillTurns.map((t) => Number(t.hop_depth))
    const whoPairs: Array<[string, MemberIds]> = [
      ['Vex', vex],
      ['Wisp', wisp]
    ]
    const memberOf = (t: Record<string, unknown>): string =>
      whoPairs.find(([, m]) => m.sessionId === t.session_id)?.[0] ?? '?'
    say(
      `  Rill 的轮次：${rillTurns.length} 条 —— ` +
        rillTurns.map((t) => `${memberOf(t)}@${String(t.hop_depth)}跳(${String(t.status)})`).join(' → ')
    )
    const t0 = rillTurns[0]
    const reply0 = t0 ? textOf(batchesOf('A', String(t0.id))) : ''
    const block0 = mentionsBlockOf(reply0)
    check(
      hasMentionsBlock(reply0) ? 'ok' : 'bad',
      hasMentionsBlock(reply0)
        ? `★ 第一跳（Vex）的回复末尾有标记块：\`<mentions>${block0}</mentions>\` —— ` +
          '派发的**唯一依据**就是它（§5.4：没有块 = 没有派发，不是猜错）'
        : `❌ 第一跳的回复里**没有** <mentions> 块（我们明确要求过）⇒ 这一条没走到待测的那一刻；` +
          `实得正文：${quote(reply0, 160)}`
    )
    const hop1 = rillTurns[1]
    if (!hop1) {
      check('bad', '★ 没有第二跳 —— 「A 的回复里 @ B → B 被派发」**没有发生**')
    } else {
      const relayBody = bodyOf(dumpChain, hop1.trigger_message_id)
      check(
        String(hop1.session_id) === wisp.sessionId && Number(hop1.hop_depth) === 1 ? 'ok' : 'bad',
        `★ 第二跳落在 **Wisp 的会话**里、深度 1（实得 ${memberOf(hop1)}@${String(hop1.hop_depth)}）—— ` +
          '派给 B 的那一轮 hop_depth = A.hop_depth + 1（§3.3）'
      )
      /**
       * ★ 转述正文的两条判据，方向是相反的，缺一条都测不到东西：
       * - **必须**有「已由本应用取出」：它证明原文末尾那一行**被摘掉了**；
       * - **不许把那一行转述过去**：它是**给机器看的派发指令**，不是给 Wisp 看的对话 ——
       *   转述过去就等于把我们的协议泄漏给下一个 agent（第一次真机跑的链就是死在这上面：
       *   下一个 agent 照着那个格式把自己 @ 了一遍，`mention-self` 把链掐断在 [Vex@0, Wisp@1, Wisp@1]）。
       *
       * ★★ 判据是**整个块 `<mentions>…</mentions>` 不在转述正文里**（`hasMentionsBlock`），
       * 不是「`<mentions>` 这几个字不出现」—— 应用的说明文字里**会**出现这几个字，
       * 而且那是它故意的：它要告诉下一个 agent「这里原本有一条派发指令、已被摘掉」。
       * 第二次真机跑就是被这一条误判成 ❌ 的（报告错了，不是产品错了）。
       */
      const stripped = squash(
        reply0.replace(/<mentions>[\s\S]*?<\/mentions>/, '')
      )
      const carriesOriginal = stripped !== '' && squash(relayBody).includes(stripped)
      check(
        relayBody.includes('【派发】Vex') &&
          relayBody.includes('已由本应用取出') &&
          !hasMentionsBlock(relayBody)
          ? 'ok'
          : 'bad',
        `★ 转述正文：写了「【派发】Vex …@ 了你」、写了「那一行已由本应用取出」、` +
          `**没有**把那一行本身（整个标记块）转述过去（实得 ${quote(relayBody, 120)}）`
      )
      /**
       * ★ 另一半：转述要**逐字带着上一跳的原文**（去掉那一行之后的那些字）。
       * 少了它，上面那条只证明了「块没被转述」—— 而 B 要接的是具体的事，
       * 任何改述都可能丢掉那一件事（`relayTextOf` 的注释逐字写了这一条）。
       */
      check(
        carriesOriginal ? 'ok' : 'unknown',
        carriesOriginal
          ? `★ 转述逐字带着上一跳的原文（去掉那一行之后是「${quote(stripped, 60)}」）—— ` +
            '各成员的会话是分开的，B 能接上这条事，全靠这一条搬运'
          : `⚠️ 转述里找不到**去掉标记块之后**的原文（上一跳的回复是「${quote(reply0, 80)}」，` +
            '去掉那一行是「' + quote(stripped, 80) + '」）⇒ 这一条判不了（可能只是换行/空白的差别）'
      )
    }

    // ── ③ 2 跳警告 ────────────────────────────────────────
    rule('Rill B2 · ③ 2 跳无实质工作 → 警告 + 库里一条 system 事件')
    const rillMsgs = (dumpChain.message ?? []).filter((m) => m.session_id === wisp.sessionId)
    const sysRows = rillMsgs.filter((m) => m.role === 'system')
    const warnRow = sysRows.find((m) => String(m.content_text ?? '').includes('会被自动终止'))
    const toolsUsed = rillTurns.map((t) => {
      const ids = new Set(
        (dumpChain.message ?? []).filter((m) => m.turn_id === t.id).map((m) => String(m.id))
      )
      return (dumpChain.message_event ?? []).filter(
        (e) => ids.has(String(e.message_id)) && e.kind === 'tool_start'
      ).length
    })
    const totalTools = toolsUsed.reduce((a, b) => a + b, 0)
    check(
      totalTools === 0 ? 'ok' : 'unknown',
      totalTools === 0
        ? '★ 前提成立：这几跳**一个工具都没用**（tool_start 合计 0）—— 空转计数才有意义'
        : `⚠️ 这几跳用了 ${totalTools} 个工具 ⇒ 「没有实质性工作」不成立，` +
          '下面的熔断判据一律降级（有动作的跳会把空转计数清零，熔断本就不该触发）'
    )
    check(
      warnRow !== undefined && warnRow.turn_id === null ? 'ok' : totalTools === 0 ? 'bad' : 'unknown',
      warnRow !== undefined
        ? `★ 库里有一条持久的 \`role:'system'\` 事件，落在**链所在的那个会话**（Wisp）里，` +
          `且 \`turn_id\` 是 NULL（实得 ${String(warnRow.turn_id)}）—— ` +
          '它是乒乓的**可见痕迹**；写进空间流会让别的成员也看到'.replace(/`/g, '')
        : '❌ 没有那条 system 事件 —— 2 跳警告只推了一条通知，库里的痕迹丢了'
    )
    check(
      warnRow !== undefined && !/\d/.test(String(warnRow.content_text ?? '')) ? 'ok' : 'unknown',
      warnRow !== undefined
        ? '★ 那条 system 事件的正文里**一个数字都没有** —— `Turn.hopDepth` 逐字：' +
          '「绝不进入提示词上下文」（它在历史里会被当成一条历史消息，所以它自己也不能带跳数）'
        : '⚠️ 拿不到那条 system 事件的正文 ⇒ 这一条判不了'
    )
    check(
      notices.some((n) => (n.payload as { level?: string })?.level === 'warning') ? 'ok' : 'bad',
      '★ 界面上真的收到了一条 `app:notice`（level=warning）—— ' +
        '警告必须**用户看得见**，只在日志里说一声等于没说'
    )
    check(
      warnTags.includes('fanout:ping-pong-warn') ? 'ok' : 'bad',
      warnTags.includes('fanout:ping-pong-warn')
        ? '★ 生产路径上真的报出了 `fanout:ping-pong-warn` —— 判决发生在 `fanout.ts` 里，报告只是读它'.replace(/`/g, '')
        : '❌ 归档里没有 `fanout:ping-pong-warn` —— 判决这一次没有被说出来'.replace(/`/g, '')
    )

    // ── ④ 4 跳终止 ────────────────────────────────────────
    rule('Rill B3 · ④ 4 跳 → 链被强制终止')
    const terminateRow = sysRows.find((m) => String(m.content_text ?? '').includes('已被自动终止'))
    const last = rillTurns[rillTurns.length - 1]
    const replyLast = last ? textOf(batchesOf('A', String(last.id))) : ''
    const lastWanted = mentionsBlockOf(replyLast)
    check(
      rillTurns.length === 4 && JSON.stringify(depths) === JSON.stringify([0, 1, 2, 3]) ? 'ok' : 'bad',
      `★ 链一共 **4 跳**就停了（深度 ${JSON.stringify(depths)}）—— 用户那一跳是 0 跳、之后每跳 +1，` +
        '连续空转到第 4 跳时强制终止，所以**第 5 跳永远不该出现**'.replace(/`/g, '')
    )
    /**
     * ★ **这一条是 ④ 的判决性证据**：终止那一刻，模型**确实又点了一次名**，
     * 而库里没有多出第 5 跳。少了它，「没有第 5 跳」也可能只是「模型这次没写标记块」——
     * 而那两件事的结论完全相反。
     */
    check(
      last !== undefined && hasMentionsBlock(replyLast) ? 'ok' : 'unknown',
      last === undefined
        ? '⚠️ 拿不到最后一跳的正文（没有批次帧）⇒ 这一条判不了'
        : hasMentionsBlock(replyLast)
          ? `★ 最后一跳的回复里**又点了一次名**（\`<mentions>${lastWanted}</mentions>\`），而库里没有第 5 跳 ⇒ ` +
            `**终止分支真的执行了**（不是「模型这次没 @ 人」）。`.replace(/`/g, '')
          : '⚠️ 最后一跳的回复里没有标记块 ⇒ 「没有第 5 跳」也可能只是模型没点名，两者分不开 ⇒ 无法判定'
    )
    check(
      terminateRow !== undefined ? 'ok' : 'bad',
      terminateRow !== undefined
        ? `★ 库里有一条 \`role:'system'\` 的事后记录：${quote(String(terminateRow.content_text ?? ''), 90)}`
        : '❌ 没有「已被自动终止」那条 system 事件 —— 终止这件事在库里没有痕迹'
    )
    check(
      warns.some((w) => String(w.tag) === 'fanout:ping-pong-terminate') ? 'ok' : 'bad',
      '★ 生产路径上真的报出了 `fanout:ping-pong-terminate`（带上了整条链的 `{hopDepth, hadWork}`）'
    )
    /**
     * ★ **「强制终止 ≠ 杀进程」**：终止发生在**某一跳的收尾**，所以那一跳本身是
     * 正常跑完的（`done`、有正文、有成本），而它之后不再有人被派。
     * 判据就是：没有任何一轮是 `failed`，最后一跳是 `done` 且有正文。
     */
    check(
      rillTurns.every((t) => String(t.status) === 'done') && replyLast.length > 0 ? 'ok' : 'bad',
      `★ 四跳全部 \`done\`、最后一跳有正文（${replyLast.length} 字）—— 「强制终止」是` +
        '「不建新轮次 + 取消排队」，**不含** abort 一个正在跑的轮次（那是 M9 的中断阶梯）'.replace(/`/g, '')
    )

    // ── ④ 的「取消排队」那半：本形状下不可达 ───────────────────
    rule('Rill B4 · ④ 的「排队中的同链条轮次被取消」')
    const cancelled = rillTurns.filter((t) => String(t.status) === 'cancelled')
    check(
      cancelled.length > 0 ? 'ok' : 'unknown',
      cancelled.length > 0
        ? `★ 终止时确实有 ${cancelled.length} 条排队中的同链条轮次被取消（${cancelled.map((t) => String(t.id)).join(' ')}）`
        : '⚠️ **这一次没测到**，而这是**形状决定的、不是失败**：线性乒乓链的每一跳都是上一跳结束之后才建的，' +
          '所以终止那一刻队列本来就是空的 —— 这条分支在**本形状下不可达**。' +
          '它的判据在 `test/process/fanout.test.ts`（那里用夹具造出了一个能被链上某一跳认领的 queued 跳）。' +
          '★ 不许把这一条读成「测了没事」。'
    )
    check(
      cancelled.length === 0 ? 'ok' : 'bad',
      cancelled.length === 0
        ? '★ 同时，**没有**任何一跳被误取消 —— 「宁可漏杀不可错杀」在这一形状下也没误伤'
        : '❌ 有线性的链上轮次被取消了，而本形状下队列本该是空的 —— 需要查是谁认领了它'
    )
  }

  // ══ 库里的卫生 ═════════════════════════════════════════════
  rule('库里的卫生（不该出现的那些）')
  /**
   * ★★ 两类信号**必须分开判**，混在一起会把「模型乱写」印成「我们的代码坏了」。
   *
   * 第一类：**只有我们的代码走岔了才会出现**。它们出现就是真 ❌。
   */
  const ownTags = [
    'fanout:chain-tail-missing',
    'fanout:dedupe-basis-skipped',
    'fanout:target-session-missing',
    'fanout:actor-missing'
  ]
  for (const tag of ownTags) {
    check(
      warnTags.includes(tag) ? 'bad' : 'ok',
      `**没有** \`${tag}\` —— 它出现就说明有一条派发路径被迫降级了`.replace(/`/g, '')
    )
  }
  /**
   * 第二类：**模型侧**的行为 —— 「它写的那块不合法 / 它点到了自己」。
   * 应用把它判掉并报出来才是对的（§5.4「失败可观测」），所以**不是我们的 ❌**；
   * 但也**不是 ✅**：我们分不清「模型乱写」与「我们的解析器太窄」。
   * ⇒ 只能到「原样取证、留给人判」这一步，所以是 ⚠️。
   * （第一次真机跑里 `mentions-malformed` 就是这么来的：模型在正文里写了
   * 「（无 <mentions> 行，避免继续空转。）」—— 那是它自己的一句解释，不是块。）
   */
  const modelTags = [
    'fanout:mentions-malformed',
    'fanout:mention-self',
    'fanout:mention-not-a-member',
    'fanout:mention-empty'
  ]
  for (const tag of modelTags) {
    const hit = warns.find((w) => String(w.tag) === tag)
    if (!hit) continue
    check(
      'unknown',
      `⚠️ 出现过 \`${tag}\`：${quote(String(hit.line ?? ''), 150)} —— 这是**模型侧**的行为，` +
        '应用把它判掉并报出来是对的（失败可观测）；但「模型乱写」与「我们的解析器太窄」' +
        '在这里分不开 ⇒ 只取证，不下结论'.replace(/`/g, '')
    )
  }
  if (dumpFinal) {
    /**
     * ★ **一条被实测推翻的假设，如实记下来**（不印成 ✅，也不印成 ❌ —— 它是一个事实）。
     *
     * 原先这里写着「Sable 里没有 2 跳以上的轮次」，理由是「那个空间的人设没有接力指令」。
     * 第二次真机跑把它推翻了：Sable 里出现了 Nyx@2 → Atlas@2。
     * 原因是**协作协议写在 `systemPrompt` 里、对人设中立** —— `PERSONA_PLAIN_TEXT` 没提接力，
     * 但每个成员都读到那条协议，于是「谁被派发了、它就往下派」这件事在每个空间都会发生。
     * ⇒ 这不是缺陷（链本来该由熔断来管），但它意味着**任何按会话数计数的判据都会被链污染**，
     * 所以 A2/A3 的计数已经改成按 `trigger_message_id` 认。
     */
    const sableTurns = turnsOf(dumpFinal, sable.workspaceId)
    const sableDeep = sableTurns.filter((t) => Number(t.hop_depth) >= 2)
    say(
      `  [发现] Sable 里 ${sableTurns.length} 条轮次，其中 ${sableDeep.length} 条是 2 跳以上（` +
        `${sableDeep.map((t) => `@${String(t.hop_depth)}`).join(' ')}）—— 协作协议在 systemPrompt 里、` +
        '**对人设中立**，所以「没有接力指令的人设」照样会接力。不是缺陷，但按会话计数会被它污染'
    )
  }

  // ══ 旁证（**不是断言**）═════════════════════════════════════
  rule('旁证（**不是断言**）')
  for (const n of notices) {
    say(`  [notice] ${quote(JSON.stringify(n.payload), 200)}`)
  }
  for (const d of recs.filter((r) => r.kind === 'dom')) {
    say(`  [${String(d.tag)}] ${quote(String(d.text), 200)}`)
  }
  const texts = recs.filter((r) => r.kind === 'batch')
  say(`  批次帧 ${texts.length} 批（正文都在 batches.jsonl 里，逐字）`)
  /**
   * ★ 把两个空间的**链形状**原样印出来 —— 这是「这一跳是谁派给谁的」最直观的一份证据，
   * 也是报告里那些计数判据的语境（`[0,1,1]` 与 `[0,1,2,3]` 的区别一眼就能看出来）。
   */
  if (dumpChain) {
    const who: Array<[string, MemberIds]> = [
      ['Atlas', atlas],
      ['Nyx', nyx],
      ['Echo', echo],
      ['Juno', juno],
      ['Vex', vex],
      ['Wisp', wisp]
    ]
    for (const [wsName, wsId] of [
      ['Sable', sable.workspaceId],
      ['Rill', rill.workspaceId]
    ] as Array<[string, string]>) {
      const rows = turnsOf(dumpChain, wsId).map((t) => {
        const n = who.find(([, m]) => m.sessionId === t.session_id)?.[0] ?? '?'
        return `${n}@${String(t.hop_depth)}(${String(t.status)})`
      })
      say(`  ${wsName} 的链形状  ${rows.length ? rows.join(' → ') : '（没有轮次）'}`)
    }
  }
  /**
   * ★ 一条**从观测里长出来的**发现（它不是断言，因为它不是缺陷）：
   * 「用户在正文里 @ 一个人」这条最普通的路，本身就可能造出一条 **2 跳的空转链**
   * （用户的 0 跳 + 被派发者的 1 跳），于是第 ① 条熔断会**为一句话的 @ 报警**。
   *
   * ★★ 但**必须按这一趟实际发生的事说**：每条通知都带 `detail.turnId`，
   * 把它映射回库里的那一条轮次，就知道这条警告出自哪个空间、哪一跳。
   * 上一版这里写死了「其中来自 Sable 的那些会说明……」——而第三次真机跑里
   * 那 3 条警告**全部来自 Rill 的 agent 链**、Sable 一条都没有：报告说了它没查过的话。
   * （§8.8e 规则三：缺证据不许印成 ✅，同一个道理 —— 有证据才许下结论。）
   */
  /**
   * ★★ 只挑**熔断**那两条通知（正文里带「协作链」）—— 别的 warning 是别的事
   * （比如 `mention-self`：模型把自己 @ 了）。混在一起会得出错的结论：
   * 第三次真机跑里就有一条 `mention-self` 的 warning，它的 turn 是 **1 跳**，
   * 于是「有几条警告落在 1 跳上」这种判据会把它算进去，而它跟乒乓毫无关系。
   */
  const warnNotices = notices.filter(
    (n) =>
      (n.payload as { level?: string })?.level === 'warning' &&
      String((n.payload as { message?: string })?.message ?? '').includes('协作链')
  )
  if (warnNotices.length > 0) {
    const allTurns = [...(dumpFinal?.turn ?? []), ...(dumpChain?.turn ?? [])]
    const wsShort = (id: string): string =>
      id === sable?.workspaceId ? 'Sable' : id === rill?.workspaceId ? 'Rill' : '(别的空间)'
    const rows = warnNotices.map((n) => {
      const tid = String((n.payload as { detail?: { turnId?: string } })?.detail?.turnId ?? '')
      const t = allTurns.find((x) => String(x.id) === tid)
      return {
        ws: t ? String(t.workspace_id) : '',
        depth: t ? Number(t.hop_depth) : -1
      }
    })
    say(
      `  ★ 本次一共 ${warnNotices.length} 条**熔断**通知：` +
        rows
          .map((r) => `${r.ws === '' ? '(库里查不到这条轮次)' : `${wsShort(r.ws)}@${r.depth}跳`}`)
          .join('、')
    )
    /**
     * ★★ 判据是**警告落在几跳上**，不是「这个空间最深几跳」。
     *
     * 落在 **1 跳**上 ⇒ 这条警告是在链刚走到 `[用户 0 跳, 被派发者 1 跳]` 时弹的，
     * 而**那里面一次 agent 来回都还没有发生**。也就是说：任何一次「没有工具调用」的
     * 单人 `@` 都会在链走到第 2 跳时弹这条警告 —— 包括 Rill 那种真接力链的第一跳
     * （本库 `Rill@1跳` 就是它）。这是阈值定义使然（2 跳 = 链的最短可能长度），
     * 不是实现错了；但用户的体感会是「随手 @ 一个人，就被告诉『连续几跳没有实际动作』」。
     *
     * 落在更深的跳上 ⇒ 那才是真的「来回」；这一趟没观察到浅的那一种就如实说没观察到。
     */
    const firstHop = rows.filter((r) => r.depth === 1)
    say(
      firstHop.length > 0
        ? `  ★ 其中 ${firstHop.length} 条落在 **1 跳**上（${firstHop.map((r) => wsShort(r.ws)).join('、')}）` +
            '—— 链刚走到「用户 0 跳 + 被派发者 1 跳」时弹的，那里面**一次 agent 来回都还没有发生**。' +
            '⇒ 一次没有工具调用的单人 @ 就会看到这条警告（Rill 那种真接力链的第一跳也一样）。' +
            '阈值定义使然，不是实现错了；但这是「用户随手 @ 一个人被告知『连续几跳没有实际动作』」的成因。'
        : '  ★ 这几条**都落在更深的跳上**（≥ 2 跳）—— 本趟**没有**观察到「一句普通的 @ 就报警」那个现象。'
    )
  }

  rule('结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '全部通过' : `${failures} 条不通过`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  say('  ⚠️ 端点限定语：全部结论只在**本机默认凭据所指向的端点**下成立，不是 Anthropic 官方行为。')
  say('  ⚠️ Rill 那三条（②③④）还多一条前提：**模型得在回复末尾写那个标记块**。')
  say('     没写 = 没派发（§5.4 的失败形态，可观测）—— 那时的判据是「无法判定」，不是「通过」。')
  say('  ⚠️ 一条留白：④ 里「终止时取消排队中的同链条轮次」在线性链下**不可达**（见 B4）。')
  return failures
}

/** `mentions_json` 那一列是不是一条像样的 JSON 数组（`sourceMsg` 存在且能解析）。 */
function sourceMsgsOk(msg: Record<string, unknown> | undefined): boolean {
  return msg !== undefined && typeof msg.mentions_json === 'string' && msg.mentions_json.startsWith('[')
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
        '    npm run walk:m7b:replay -- --archive=scripts/evidence/m7b-<时间戳>\n' +
        '故意不带默认值 —— 这个命令**不该**在忘了参数的时候顺手跑一次真采集（那会花钱）。\n'
    )
    return finish(1)
  }
  if (archive) {
    loadArchive(archive)
    rule('M7b 走查 · 重放归档（零成本）')
    return finish(report() === 0 ? 0 : 1)
  }

  const dir = argValue('out') ?? join(EVIDENCE_ROOT, `m7b-${stamp()}`)
  rule('M7b 走查 · 采集')
  say(`  归档目录        ${dir}`)
  say(
    DRY
      ? '  干跑：只开界面、**不发任何轮次**，不花钱。'
      : '  ⚠️ 真花钱：≈10 轮真 CLI（Sable 6 轮 + Rill 4 轮），每轮一道 --max-budget-usd 0.50 的硬闸。'
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
