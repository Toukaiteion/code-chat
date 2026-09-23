/**
 * M6a 实机走查 —— 主进程管道：`turn:send` → 调度 → 合批 → 落库 → 硬杀重放。
 *
 *     npm run walk:m6a                          # 真机跑一遍（真花钱：3 轮真 CLI）
 *     npm run walk:m6a -- --archive=<目录>      # ★ 重放：零成本重出一份报告
 *     npm run walk:m6a -- --dry                 # 只装配、不发轮次（零成本，验地基）
 *
 * ## 它与 M4 走查的关系：手法照抄，两处不同
 *
 * 手法逐字沿用 §七 的 M4 手法 —— `--remote-debugging-port` + 沙箱 `--user-data-dir`，
 * 用 DevTools Protocol 驱动**真实窗口**，不装 Playwright、不改产品代码。两处不同，
 * 都是 M6a 的性质逼出来的：
 *
 * ① **应用由本脚本自己 spawn**，不再要求另开终端跑 `npm run dev`。
 *    M6a **没有任何界面变化**（界面是 M6b），走查需要的是一个**能收发 IPC 的渲染进程**，
 *    而 `out/` 里的构建产物正是它。代价是先要 `npm run build`；换来的是
 *    「一条命令 + 一个归档目录」，没有「另开一个终端」这种人工步骤。
 * ② **它真的会跑真 CLI，真的花钱**（M4 走查不花钱）。所以：每轮 `--max-budget-usd 0.50`
 *    是 `turn-runner` 的默认硬闸，另有墙钟上限；并且它**绝不能被 `npm test` 扫到** ——
 *    glob 是 `test/**\/*.test.ts` 而它在 `scripts/`，两者不相交，这是故意的（§8.8d 规则八）。
 *
 * ## 端点限定语（照 §六「M5 实证」开头的纪律，写最前面）
 *
 * 全部实测跑在**本机当前默认凭据所指向的端点**下（一个 Anthropic 兼容端点，
 * 模型名由 `--model` 给、默认 `deepseek-flash`，**不是 Anthropic 官方**）。
 * 所以「`usage` 的三个新字段有没有值」「thinking 有没有正文」这类结论**只在该端点下成立**。
 * **凭据本身一律不读、不回显、不落档** —— 环境**原样**继承给子进程
 * （`spawn` 不传 `env` 就是原样继承），走查只看得到「端点返回了什么」。
 *
 * ## 为什么断言不许写在采集里（§8.8d 规则九）
 *
 * 采集（`collect()`）只做两件事：驱动真窗口、把**每一个可观测事实**写进归档。
 * **所有断言都在 `report()` 里，而它只读归档。** 采集崩了也照样出报告 ——
 * 已经记下来的事实仍然可判。改判据不需要再买一轮，这不是优化，是纪律：
 * 一个需要重新花钱才能复核的结论，实际上是不复核的。
 *
 * 归档里的四个部分：
 * - `events.jsonl` —— 全部事实（launch / ipc / batch / unread / db / mark / note …）
 * - `batches.jsonl` —— 只装 `stream:batch` 与 `workspace:unread` 的载荷，逐字
 * - `db-<launch>-<phase>.json` —— 库转储（turn / message / message_event …）
 * - `app-<launch>.<stdout|stderr>.log`、`console.log`
 *
 * ## 四个场景（§六 的验收标准本身）
 *
 * 1. 发一轮（含 Read + Edit）→ 批次到达、seq 分配自洽且跨轮次单调、text 被拼接、
 *    `file_diff` 出现**且与磁盘上真被改过的那个文件一致**、`usage` 三个新字段在、
 *    `done.reason = complete`
 * 2. `view:setActive` 切到**另一个真空间** → 批次停止 + `workspace:unread` 到达 →
 *    切回 + `stream:resume` → 在途尾巴重放、实时推送恢复
 * 3. **硬杀**（轮次完成后）→ 同沙箱重开 → 历史完整（含 thinking / 工具 / diff），
 *    且**落库正文与流式帧逐字同源**
 * 4. **硬杀**（轮次运行中）→ 重开 → 该轮 `failed` 且原因如实，**没有幽灵 `running`**
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * 于是库（`code-chat.db`）与 `workspaces/` 根都在这个目录下 ——
 * 中途硬杀、建空间、将来删空间都动不到用户的东西（§七 M4 手法的第②点好处）。
 */
const SAND = join(tmpdir(), 'cc-m6a')
const USERDATA = join(SAND, 'userdata')
const SRC = join(SAND, 'src-proj')
const PERSONA = join(SAND, 'persona.md')
const DB = join(USERDATA, 'code-chat.db')

const CDP_PORT = 9222
const CDP = `http://localhost:${CDP_PORT}`

/**
 * 切走视图之后，允许多久之内还收到该空间的批次。
 *
 * 它不是「容忍 bug」，而是承认 `view:setActive` 是一次 IPC 往返：在我们记下
 * 「切走了」的那一刻，主进程可能刚冲掉一批、还没处理那条请求，而那一批**本来就该发出来**。
 * 取 250ms（远大于一次本地 IPC，也正好是页面拉取的一个周期）。
 */
const VIEW_SWITCH_GRACE_MS = 250

const MODEL = argValue('model') ?? process.env.CODE_CHAT_WALKTHROUGH_MODEL ?? 'deepseek-flash'

/**
 * 干跑：**只装配、不发轮次**。
 *
 * 它值一个开关，因为走查的地基（构建产物起得来、CDP 连得上、preload 桥在构建版里
 * 也真的暴露、装配那七次 IPC 载荷都对）与「管道通不通」是两个独立的失败面 ——
 * 地基塌了的时候，真机跑一遍会**花钱**换来一份什么都测不到的报告。
 * 干跑把这半件事的成本压到零。
 */
const DRY = process.argv.slice(2).includes('--dry')

/** 沙箱项目里那几个文件。`a.ts` 是场景 1 要**真被改掉**的那一个。 */
const SANDBOX_FILES: Record<string, string> = {
  'CLAUDE.md': '# 沙箱项目\n\nM6a 走查用的沙箱项目。它只提供一个「能读、能改」的目录。\n',
  'a.ts': 'export const x = 1\nexport const y = 2\n',
  'b.ts': 'export function add(a: number, b: number): number {\n  return a + b\n}\n',
  'c.ts': "export const NAME = 'code-chat'\nexport const VERSION = '0.1.0'\n",
  'd.ts': 'export type Id = string\nexport interface Node {\n  id: Id\n}\n'
}

const PERSONA_TEXT =
  '# 沙箱角色\n\n你是一个测试角色。只做用户明确让你做的事，不寒暄、不额外发挥、不改无关文件。\n'

// ─────────────────────────────────────────────────────────────
// 三个提示词
// ─────────────────────────────────────────────────────────────

/** 场景 1：**必须真的调 Read 与 Edit**（`file_diff` 的生产者就是那次 Edit）。 */
const PROMPT_ONE = [
  '只做这两件事，不要做别的：',
  '1. 用 Read 工具读当前目录下的 a.ts。',
  '2. 用 Edit 工具把 a.ts 里的 `export const x = 1` 改成 `export const x = 2`。',
  '做完用一句话说明改了什么，不要贴代码。'
].join('\n')

/**
 * 场景 2：这一轮**要够久**，久到我们来得及「切走 → 收到未读 → 切回 → 恢复推送」。
 * 所以它必须跨若干次工具往返；四个文件各读一次正好。
 */
const PROMPT_TWO = [
  '按顺序做，不要跳步：用 Read 工具依次读 a.ts、b.ts、c.ts、d.ts 四个文件，',
  '每读完一个就用一句话概括它的内容，最后用一句话总结这四个文件是干什么的。',
  '不要修改任何文件。'
].join('\n')

/** 场景 4：这一轮**要够久**，久到我们能在它跑到一半时把应用硬杀掉。 */
const PROMPT_THREE = [
  '这是一次压力测试，请慢慢做、不要赶：用 Read 工具依次读 a.ts、b.ts、c.ts、d.ts，',
  '每读一个就写一段不少于 150 字的详细说明（讲清它的结构、可能的用途、可以改进的地方），',
  '四个都写完后再写一段不少于 200 字的总结。不要修改任何文件。'
].join('\n')

// ─────────────────────────────────────────────────────────────
// 归档记录的形状
// ─────────────────────────────────────────────────────────────

/**
 * 一条归档记录。
 *
 * ★ 字段刻意**全部可选**，因为读它的 `report()` 读的是**磁盘上的 JSON**：
 * 给一个精确的联合类型只是在骗自己 —— 报告拿到的是数据，不是代码。
 * 真正的约束在写它的那几个函数上（`rec()` 的调用点），而那是唯一能约束的地方。
 */
interface Rec {
  /** Node 侧时钟。 */
  t: number
  kind: string
  /** 哪一次启动（A / B / C）。 */
  label?: string
  /** 采集侧的语义标签，如 `A:s1.send`。报告靠它定位事实。 */
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
function recPush(kind: 'stream:batch' | 'workspace:unread', payload: unknown): void {
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
// CDP 最小客户端（照 `m4-walkthrough.cjs`，逐字同源）
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
 * 页面内的采集器。
 *
 * ★ M6a **不订阅任何推送**（订阅是 M6b 的活），所以「渲染层到底收到了什么」
 * 只能由走查自己挂监听 —— 走的是 preload 白名单里那条 `window.api.on`，
 * 与 M6b 将来的 `useStreamBatch` 是同一个入口、同一条通道。
 *
 * 采集用**拉取式**（`drain`）而不是推送式：页面把收到的攒起来，走查每 250ms 拉一次并**清空**，
 * 于是每条只进归档一次，且带着**页面自己的时间戳** —— 判断「切走期间有没有漏」
 * 靠的就是它，而不是 Node 侧什么时候去拉的。
 */
const HELPERS = `
window.__m6a = {
  batch: [], unread: [], notice: [], hooked: false,
  hook() {
    if (this.hooked) return 'already'
    this.hooked = true
    window.api.on('stream:batch', (p) => { this.batch.push({ t: Date.now(), p }) })
    window.api.on('workspace:unread', (p) => { this.unread.push({ t: Date.now(), p }) })
    window.api.on('app:notice', (p) => { this.notice.push({ t: Date.now(), p }) })
    return 'hooked'
  },
  drain() {
    return {
      batch: this.batch.splice(0),
      unread: this.unread.splice(0),
      notice: this.notice.splice(0)
    }
  },
  call(ch, payload) { return window.api.invoke(ch, payload) },
  dom() { return document.body.innerText }
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
    throw new Error(
      `找不到构建产物 ${OUT_MAIN} —— 先跑 \`npm run build\`（M6a 没有界面变化，走查跑的是构建产物）`
    )
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
 * ★ 刻意**不加 `/T`**：`/T` 会连子进程一起杀，而场景 4 要观察的恰恰是
 * 「应用死了、`claude.exe` 留在那里」这个已知中间状态（M10 的活）。
 * `/T` 会把那个事实一并抹掉，于是走查再也证明不了它是真的。
 */
function hardKill(label: string): void {
  const child = currentChild
  if (!child?.pid) return
  const pid = child.pid
  spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' })
  rec({ kind: 'kill', label, pid, hard: true })
  say(`  ${label} 被硬杀（pid=${pid}）`)
  currentChild = null
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
  const raw = await evaluate('JSON.stringify(window.__m6a.drain())')
  if (typeof raw !== 'string') return
  const d = JSON.parse(raw) as {
    batch: Array<{ t: number; p: BatchLike }>
    unread: Array<{ t: number; p: { workspaceId: string; count: number } }>
    notice: Array<{ t: number; p: unknown }>
  }
  for (const b of d.batch) {
    rec({ kind: 'batch', label: currentLabel, pageT: b.t, payload: b.p })
    recPush('stream:batch', b.p)
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
    `window.__m6a.call(${JSON.stringify(ch)}, ${JSON.stringify(payload === undefined ? null : payload)})`
  )) as { ok?: boolean; data?: T; error?: unknown } | null
  rec({ kind: 'ipc', label: currentLabel, tag, ch, req: payload ?? null, res: r ?? null, ms: Date.now() - started })
  if (!r || r.ok !== true) throw new Error(`IPC ${ch} 失败（${tag}）：${JSON.stringify(r?.error ?? r)}`)
  return r.data as T
}

async function domSnapshot(tag: string): Promise<void> {
  try {
    const text = await evaluate('window.__m6a.dom()')
    rec({ kind: 'dom', label: currentLabel, tag, text: typeof text === 'string' ? text.slice(0, 2000) : '' })
  } catch {
    // 页面没了就算了 —— DOM 只是旁证
  }
}

/** 等一个条件成立。**不抛**：等不到本身就是要如实报告的事实。 */
async function waitUntil(label: string, pred: () => boolean, ms: number): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    if (pred()) return true
    if (Date.now() - started > ms) {
      say(`  ⏳ 等不到「${label}」（${ms}ms）`)
      return false
    }
    await sleep(150)
  }
}

/**
 * 等这一轮的**终态行落库**，返回「done 帧到达渲染层 → 库里看见终态」的毫秒数
 * （`-1` 表示等到超时还没落）。
 *
 * ★ 它测的是一个**真实的顺序**，第一次真机跑就撞上了：`done` 帧由合批器自己的那次刷新
 * 推出去，而终态行是 `endTurn` 的另一次写入，中间隔着适配器生成器的收尾
 * （`turn-runner` 第 7 步）。所以渲染层看见 `done` 的那一刻，库里那一行**可能还是
 * `running`**，`tokens_in/out` 也还是 null。
 *
 * 这不是「先推送、后落库」——那一帧确实在它自己的事务里先落了库（§4.5a 规则二没破）。
 * 破的是更弱的一条：**同一个事实的两个去向之间有一段可观测的空隙**。
 * 代价很具体：正好在这段空隙里被硬杀，一个**已经跑完**的轮次会在下次启动时
 * 被判成 `failed`。这个窗口有多大，本函数量的就是它 —— 量出来才写进文档。
 */
async function waitTerminal(tag: string, turnId: string, ms: number): Promise<number> {
  const from = Date.now()
  for (;;) {
    const row = await call<Record<string, unknown>>(`${tag}.poll`, 'turn:get', { id: turnId })
    const status = String(row?.status ?? '')
    if (status !== 'running' && status !== 'queued') {
      const lagMs = Date.now() - from
      rec({ kind: 'note', tag: `${tag}`, text: status, lagMs })
      say(`  终态行在 done 帧之后 ${lagMs}ms 落库（status=${status}）`)
      return lagMs
    }
    if (Date.now() - from > ms) {
      rec({ kind: 'note', tag: `${tag}`, text: `超时仍是 ${status}` })
      say(`  ⏳ 等到 ${ms}ms 终态行还是 ${status}`)
      return -1
    }
    await sleep(120)
  }
}

// ─────────────────────────────────────────────────────────────
// 库转储
// ─────────────────────────────────────────────────────────────

function dumpDb(label: string, phase: string): void {
  if (!existsSync(DB)) {
    rec({ kind: 'note', text: `库还不存在，跳过转储 ${label}/${phase}` })
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
    rec({ kind: 'note', text: `打不开库做转储 ${label}/${phase}：${err instanceof Error ? err.message : String(err)}` })
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
    rec({ kind: 'note', text: `转储 ${label}/${phase} 半途失败：${err instanceof Error ? err.message : String(err)}` })
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

// ─────────────────────────────────────────────────────────────
// 采集
// ─────────────────────────────────────────────────────────────

function prepareSandbox(): void {
  rmSync(SAND, { recursive: true, force: true })
  mkdirSync(USERDATA, { recursive: true })
  mkdirSync(SRC, { recursive: true })
  for (const [name, body] of Object.entries(SANDBOX_FILES)) writeFileSync(join(SRC, name), body, 'utf8')
  writeFileSync(PERSONA, PERSONA_TEXT, 'utf8')
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
  say(`  模型            ${MODEL}（端点 = 本机默认凭据所指向的那个，**不是 Anthropic 官方**）`)
  say('  预算闸          --max-budget-usd 0.50（turn-runner 的默认值，每轮一道）')
}

interface SetupIds {
  nova: { id: string; name: string }
  vega: { id: string; name: string }
  memberId: string
  sessionId: string
  vegaSessionId: string | null
}

/** M6a **没有新界面**，所以装配全走 IPC —— 但驱动的是真窗口、真渲染进程。 */
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
   * 沙箱空间只有一个项目，所以「收窄到它」与「全部可见」在这个夹具里等价 ——
   * 但走的是**收窄**那条路，于是 §8.4 的可见性模型在走查里是真的被用上了
   * （`turn-cwd.ts` 的 `--add-dir` 消费者拿到的是一张非空列表）。
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

  // 第二个空间：场景 2 要切到**另一个真的空间**去，而不是切到一个空 id。
  const vega = await call<{ id: string; name: string }>('setup.vega', 'workspace:create', { name: 'Vega' })
  const vproj = await call<{ id: string }>('setup.vegaProject', 'project:addLocal', {
    workspaceId: vega.id,
    name: 'sandbox',
    rootPath: SRC
  })
  // 同一个角色可以在不同空间各当一次成员（`UNIQUE(workspace_id, actor_id)` 是按空间约束的）。
  const vmember = await call<{ id: string }>('setup.vegaMember', 'member:create', {
    workspaceId: vega.id,
    actorId: actor.id,
    displayName: 'Atlas'
  })
  await call('setup.vegaVisibility', 'member:setVisibility', {
    memberId: vmember.id,
    projectIds: [vproj.id],
    primaryProjectId: vproj.id
  })
  const vsession = await call<{ id: string } | null>('setup.vegaSession', 'session:getByMember', {
    memberId: vmember.id
  })

  /**
   * ★ 视图必须真的切到 Nova：合批器按 `ActiveView.workspaceId` 抑制，
   * 而视图是**内存态**（每次启动都是 null，不落库），所以每次启动都要重设一遍。
   * 漏了这一步，第一批就会被合法地抑制掉，而现象看起来像「管道没通」。
   */
  await call('setup.view', 'view:setActive', { workspaceId: nova.id, sessionId: session.id })

  const ids: SetupIds = {
    nova,
    vega,
    memberId: member.id,
    sessionId: session.id,
    vegaSessionId: vsession?.id ?? null
  }
  rec({ kind: 'note', tag: 'ids', text: JSON.stringify(ids) })
  return ids
}

async function collect(dir: string): Promise<void> {
  runDir = dir
  mkdirSync(runDir, { recursive: true })

  rule('M6a 走查 · 准备')
  prepareSandbox()

  // ══ 第一次启动：场景 1 与 2 ═══════════════════════════════
  rule('启动 A · 装配 + 场景 1（一次真实对话：Read + Edit）')
  launch('A')
  await connectCdp()
  await evaluate(HELPERS)
  const hooked = await evaluate('window.__m6a.hook()')
  rec({ kind: 'note', tag: 'hooked', text: String(hooked) })
  startPump()
  await sleep(600)
  await domSnapshot('A:startup')

  const ids = await setup()
  dumpDb('A', 'setup')

  if (DRY) {
    // 地基自检：桥在构建版里暴露了吗？渲染层的推送订阅挂上了吗？
    const probe = await evaluate(
      `JSON.stringify({ api: typeof window.api?.invoke, on: typeof window.api?.on, hooked: window.__m6a.hooked, path: location.pathname })`
    )
    rec({ kind: 'note', tag: 'dry.probe', text: String(probe) })
    say(`  干跑探针        ${String(probe)}`)
    await domSnapshot('A:dry')
    stopPump()
    const pidDry = currentChild?.pid ?? 0
    hardKill('A')
    await waitGone(pidDry)
    rule('干跑结束（**没有发起任何轮次，没花钱**）')
    say('  地基这一层：构建产物起得来、CDP 连得上、preload 桥在构建版里可用、装配七次 IPC 全过。')
    say('  下一句才是真机：npm run walk:m6a（真花钱）。')
    return
  }


  // ── 场景 1 ────────────────────────────────────────────────
  const t1 = await call<{ turnId: string }>('A:s1.send', 'turn:send', {
    workspaceId: ids.nova.id,
    memberId: ids.memberId,
    text: PROMPT_ONE
  })
  say(`  轮次 1 = ${t1.turnId}`)

  const gotDone1 = await waitUntil(
    '轮次 1 的 done 帧',
    () => framesOf('A', t1.turnId).some((f) => f.k === 'done'),
    180000
  )
  rec({ kind: 'note', tag: 'A:s1.done-frame', text: String(gotDone1) })
  await drain()
  // ★ 先等终态行落库再读 —— 见 `waitTerminal` 的说明：done 帧与终态行之间有一段空隙。
  await waitTerminal('A:s1.terminal', t1.turnId, 15000)
  const turn1 = await call<Record<string, unknown>>('A:s1.turnGet', 'turn:get', { id: t1.turnId })
  say(`  轮次 1 终态：status=${String(turn1.status)} reason=${String(turn1.terminalReason)}`)
  // ★ 磁盘侧：那次 Edit 到底有没有真的发生。只信 diff 帧是不够的 ——
  //   帧是**我们**合成的，盘上那个文件才是结果。
  const after1 = existsSync(join(SRC, 'a.ts')) ? readFileSync(join(SRC, 'a.ts'), 'utf8') : '(没有这个文件)'
  rec({ kind: 'note', tag: 'A:s1.fileAfter', text: after1, file: join(SRC, 'a.ts') })
  say(`  a.ts 现在：${quote(after1, 80)}`)
  dumpDb('A', 'after-s1')

  // ── 场景 2 ────────────────────────────────────────────────
  rule('场景 2 · 切走 → 批次停止 + 未读；切回 → 重放 + 实时恢复')
  await call('A:s2.viewNova', 'view:setActive', { workspaceId: ids.nova.id, sessionId: ids.sessionId })
  const t2 = await call<{ turnId: string }>('A:s2.send', 'turn:send', {
    workspaceId: ids.nova.id,
    memberId: ids.memberId,
    text: PROMPT_TWO
  })
  say(`  轮次 2 = ${t2.turnId}`)

  const gotFirst2 = await waitUntil('轮次 2 的第一批', () => batchesOf('A', t2.turnId).length > 0, 120000)
  rec({ kind: 'note', tag: 'A:s2.first-batch', text: String(gotFirst2) })
  await drain()

  const seenBefore = framesOf('A', t2.turnId)
  const lastSeqBefore = seenBefore.length > 0 ? Math.max(...seenBefore.map((f) => f.seq)) : 0
  const epochBefore = batchesOf('A', t2.turnId)[0]?.epoch ?? ''
  rec({ kind: 'mark', tag: 'A:s2.away', lastSeqBefore, epochBefore })

  // ★ 切到**另一个空间**（Vega 有项目、有成员、有会话 —— 不是切到一个空 id）。
  await call('A:s2.viewAway', 'view:setActive', { workspaceId: ids.vega.id, sessionId: ids.vegaSessionId })

  const gotUnread = await waitUntil(
    'Nova 的未读推送',
    () =>
      recs.some(
        (r) =>
          r.kind === 'unread' &&
          (r.payload as { workspaceId: string }).workspaceId === ids.nova.id &&
          (r.payload as { count: number }).count > 0
      ),
    120000
  )
  rec({ kind: 'note', tag: 'A:s2.unread', text: String(gotUnread) })
  // 再等一会儿：切走期间真产生的帧越多，「重放补上的是页面没见过的东西」越结实。
  await sleep(1500)
  await drain()
  rec({ kind: 'mark', tag: 'A:s2.backPre' })

  await call('A:s2.viewBack', 'view:setActive', { workspaceId: ids.nova.id, sessionId: ids.sessionId })
  rec({ kind: 'mark', tag: 'A:s2.back' })

  const resumed = await call<{ epoch: string; matched: boolean; frames: FrameLike[] }>('A:s2.resume', 'stream:resume', {
    sessionId: ids.sessionId,
    epoch: epochBefore,
    fromSeq: lastSeqBefore
  })
  say(`  resume：matched=${resumed.matched} 帧=${resumed.frames.length}`)

  // 「实时恢复」的边界就是 `view:setActive` 那一次调用本身 —— 之后收到的批次才算恢复的。
  const backT = ipcOf('A:s2.viewBack')?.t ?? Date.now()
  const gotResumed2 = await waitUntil(
    '切回之后的实时批次',
    () => recs.some((r) => r.kind === 'batch' && r.t > backT),
    120000
  )
  rec({ kind: 'note', tag: 'A:s2.resumed-live', text: String(gotResumed2) })

  /**
   * ★ 让轮次 2 **跑完**再硬杀。
   *
   * 第一次跑的时候没等它，于是硬杀把它从中间截断了 —— 后果不是「少测了一点」，
   * 而是场景 3 的判据变得**没法解释**：那条 assistant 消息缺 `usage`/`done`，
   * 到底是被杀断了还是落库漏了？报告分不清这两件事，就等于没测。
   * 等它跑完，场景 3 的「历史完整」才是对**两个**跑完的轮次说的。
   */
  const gotDone2 = await waitUntil(
    '轮次 2 的 done 帧',
    () => framesOf('A', t2.turnId).some((f) => f.k === 'done'),
    240000
  )
  rec({ kind: 'note', tag: 'A:s2.done-frame', text: String(gotDone2) })
  await drain()
  await waitTerminal('A:s2.terminal', t2.turnId, 15000)
  dumpDb('A', 'after-s2')
  await domSnapshot('A:after-s2')

  // ── 硬杀（两个轮次都跑完了）──
  rule('硬杀 A')
  const pidA = currentChild?.pid ?? 0
  stopPump()
  hardKill('A')
  const goneA = await waitGone(pidA)
  rec({ kind: 'note', tag: 'A:gone', text: String(goneA) })
  dumpDb('A', 'after-hard-kill')

  // ══ 第二次启动：场景 3（硬杀后重放）+ 场景 4 上半 ═════════
  rule('启动 B · 场景 3（硬杀后历史完整重放）')
  launch('B')
  await connectCdp()
  await evaluate(HELPERS)
  await evaluate('window.__m6a.hook()')
  startPump()
  await sleep(900)
  await domSnapshot('B:startup')

  const live0 = await call<unknown[]>('B:s3.listLive', 'turn:listLive', null)
  rec({ kind: 'note', tag: 'B:s3.liveCount', text: String(live0.length) })
  const msgs = await call<
    Array<{ id: string; role: string; contentText: string | null; turnId: string | null }>
  >('B:s3.msgList', 'message:list', { workspaceId: ids.nova.id, limit: 100 })
  rec({
    kind: 'note',
    tag: 'B:s3.messages',
    text: JSON.stringify(
      msgs.map((m) => ({ id: m.id, role: m.role, turnId: m.turnId, chars: (m.contentText ?? '').length }))
    )
  })
  for (const [i, m] of msgs.filter((x) => x.role === 'assistant').entries()) {
    const events = await call<Array<{ kind: string }>>(`B:s3.events.${i}`, 'message:getEvents', {
      messageId: m.id
    })
    rec({ kind: 'note', tag: `B:s3.eventKinds.${i}`, text: JSON.stringify(events.map((e) => e.kind)) })
  }
  dumpDb('B', 'after-reopen')

  // ── 场景 4 上半：发一轮，停在运行中 ──
  rule('场景 4 上半 · 发一轮，然后趁它还在跑的时候硬杀')
  await call('B:s4.view', 'view:setActive', { workspaceId: ids.nova.id, sessionId: ids.sessionId })
  const t3 = await call<{ turnId: string }>('B:s4.send', 'turn:send', {
    workspaceId: ids.nova.id,
    memberId: ids.memberId,
    text: PROMPT_THREE
  })
  say(`  轮次 3 = ${t3.turnId}`)

  // 轮询到 running：既等到那一刻，也把「它真的在跑」逐次落档。
  let statusNow = ''
  for (let i = 0; i < 80; i++) {
    const row = await call<Record<string, unknown>>('B:s4.poll', 'turn:get', { id: t3.turnId })
    statusNow = String(row.status)
    if (statusNow === 'running' || statusNow !== 'queued') break
    await sleep(400)
  }

  /**
   * ★ 光看到 `status=running` 还不够 —— 那一刻可能一条帧都还没产出、`turn.pid` 还是 null。
   * 那样杀下去的后果，第一次真机跑就显现了：被杀的那一轮**零条事件落库**，
   * 库里也没有 pid 可查，于是走查既证明不了「它会留下半截证据」，也验不了
   * 「M10 靠 pid 收尸」那条路线。等第一条帧 —— 它同时意味着 CLI 真的起来了
   * （`turn-runner` 在第 5 步从一个真实的 pid 上补写 `turn.pid`）。
   */
  const gotMid = await waitUntil('轮次 3 的第一批帧', () => framesOf('B', t3.turnId).length > 0, 120000)
  rec({ kind: 'note', tag: 'B:s4.first-frame', text: String(gotMid) })
  await drain()
  const midFrames = framesOf('B', t3.turnId).length
  const killed = await call<Record<string, unknown>>('B:s4.beforeKill', 'turn:get', { id: t3.turnId })
  say(`  运行中：status=${String(killed.status)}，已收到 ${midFrames} 条帧，pid=${String(killed.pid)}`)
  rec({ kind: 'note', tag: 'B:s4.statusAtKill', text: String(killed.status) })
  dumpDb('B', 'before-kill')

  rule('硬杀 B（轮次 3 运行中）')
  const pidB = currentChild?.pid ?? 0
  stopPump()
  hardKill('B')
  const goneB = await waitGone(pidB)
  rec({ kind: 'note', tag: 'B:gone', text: String(goneB) })
  dumpDb('B', 'after-hard-kill')

  /**
   * ★ 硬杀留下的 `claude.exe`（M10 的活，M6a 不扫）。
   *
   * 走查**就地清理**它，理由不是好看而是省钱：那一轮还没跑完，留着它就还在花用户的钱。
   * pid 取自库里的 `turn.pid`（`turn-runner` 在第一个事件时写入）—— 这正是 M10
   * 「靠 pid 收尸」那条路线的第一次真实使用。清理**之前先确认那个 pid 现在真的是
   * `claude.exe`**：pid 会被复用，不确认就可能误杀无关进程。
   */
  const orphan = findOrphan()
  if (orphan) await reapOrphan(orphan)
  else rec({ kind: 'note', tag: 'orphan', text: '没有发现残留的 claude.exe（要么它自己退了，要么 pid 认不出来）' })

  // ══ 第三次启动：场景 4 下半 ══════════════════════════════
  rule('启动 C · 场景 4 下半（幽灵轮次与如实的原因）')
  launch('C')
  await connectCdp()
  await evaluate(HELPERS)
  await evaluate('window.__m6a.hook()')
  startPump()
  await sleep(1500)
  await domSnapshot('C:startup')
  const t3After = await call<Record<string, unknown>>('C:s4.turnGet', 'turn:get', { id: t3.turnId })
  const liveAfter = await call<unknown[]>('C:s4.listLive', 'turn:listLive', null)
  rec({ kind: 'note', tag: 'C:s4.live', text: String(liveAfter.length) })
  say(`  重开后轮次 3：status=${String(t3After.status)} reason=${String(t3After.terminalReason)}`)
  dumpDb('C', 'after-reopen')

  // 收尾：让 C 走一次**正常退出**（`will-quit` → 合批器冲空 → 关库）。
  // 它覆盖的是硬杀覆盖不到的那条路径：退出时脏缓冲与定时器被同步冲掉。
  rule('收尾 · 让 C 正常退出')
  const pidC = currentChild?.pid ?? 0
  let graceful = false
  try {
    await evaluate('window.close()')
    graceful = await waitGone(pidC, 10000)
  } catch {
    graceful = false
  }
  rec({ kind: 'note', tag: 'C:graceful-exit', text: String(graceful) })
  if (!graceful) {
    stopPump()
    hardKill('C')
    await waitGone(pidC)
  } else {
    stopPump()
    currentChild = null
    ws = null
  }
  say(`  C ${graceful ? '正常退出' : '没能正常退出（已硬杀）'} —— 这一条会如实进报告`)

  rule('采集结束')
  say(`  归档目录：${runDir}`)
}

/** 从库里读运行中那一轮的 pid，并确认那个 pid 现在真的是 `claude.exe`。 */
function findOrphan(): number | null {
  const file = join(runDir, 'db-B-before-kill.json')
  if (!existsSync(file)) return null
  const dump = JSON.parse(readFileSync(file, 'utf8')) as {
    turn: Array<{ pid: number | null; status: string }>
  }
  const pid = dump.turn.find((t) => t.status === 'running' && t.pid)?.pid ?? null
  if (!pid) return null
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  const isClaude = /claude\.exe/i.test(r.stdout ?? '')
  rec({ kind: 'proc', tag: 'orphan-probe', pid, isClaude, text: quote(r.stdout ?? '') })
  return isClaude ? pid : null
}

async function reapOrphan(pid: number): Promise<void> {
  say(`  清理硬杀留下的 claude.exe（pid=${pid}）—— M10 的活，走查就地做掉以免继续花钱`)
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
  await sleep(600)
  rec({
    kind: 'proc',
    tag: 'orphan-reap',
    pid,
    taskkill: quote((r.stdout ?? '') + (r.stderr ?? '')),
    stillAlive: pidAlive(pid)
  })
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

function ipcOf(tag: string): { req: unknown; res: unknown; t: number } | undefined {
  const r = pick('ipc', tag)
  return r ? { req: r.req, res: r.res, t: r.t } : undefined
}

function ipcData<T>(tag: string): T | undefined {
  const res = ipcOf(tag)?.res as { ok?: boolean; data?: T } | undefined
  return res?.ok === true ? res.data : undefined
}

function dumpOf(label: string, phase: string): Record<string, Array<Record<string, unknown>>> | undefined {
  const p = join(runDir, `db-${label}-${phase}.json`)
  if (!existsSync(p)) return undefined
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, Array<Record<string, unknown>>>
}

function report(): number {
  failures = 0
  unknowns = 0

  rule('环境（端点限定语写在最前面）')
  const env = pick('note', 'env')
  say(`  沙箱            ${String(env?.sand ?? '(未知)')}`)
  say(`  模型            ${String(env?.model ?? '(未知)')}  ← 本机默认凭据所指向的端点，**不是 Anthropic 官方**`)
  say(`  预算闸          --max-budget-usd ${String(env?.maxBudgetUsd ?? '?')}（每轮一道）`)
  say('  凭据            未读取、未回显、未落档（只把环境原样继承给子进程）')
  say(`  启动次数        ${recs.filter((r) => r.kind === 'launch').length}`)

  /**
   * ★ **采集器自己的错误也要出现在报告里**，而且**不是断言、是事实**。
   *
   * 起因是重放第一份干跑归档（`m6a-…14-04-48-044Z`）：它死在第 4 步，
   * 而报告只印了一句「归档里缺少某次 turn:send 的结果」——
   * **说的是症状，不是原因**。原因（`E_CONFLICT`）明明就躺在归档里，
   * 却是干跑分支才打印的一段 `say`，重放路径一个字节都不读它。
   *
   * 这正是 §8.8e 规则四的反面：那条讲的是「别把采集失败印成产品失败」，
   * 这条讲的是「**采集失败时，要说清楚是采集自己失败在哪一步**」。
   * 两者合起来才是完整的：报告既不能冤枉产品，也不能让读者自己去归档里刨原因。
   */
  const collectErrs = recs.filter((r) => r.kind === 'error')
  if (collectErrs.length > 0) {
    say(`  ⚠️ 采集器记到 ${collectErrs.length} 条错误 —— 下面的 ❌ 要先怀疑采集，再怀疑产品`)
    for (const e of collectErrs) say(`     [${String(e.tag ?? '?')}] ${String(e.message ?? '')}`)
  }

  const s1send = ipcData<{ turnId: string }>('A:s1.send')
  const s2send = ipcData<{ turnId: string }>('A:s2.send')
  const s4send = ipcData<{ turnId: string }>('B:s4.send')
  if (!s1send || !s2send || !s4send) {
    check('bad', '归档里缺少某次 turn:send 的结果 —— 采集没走到那一步，后面的断言无从谈起')
    return failures
  }

  // ══ 场景 1 ═════════════════════════════════════════════════
  rule('场景 1 · 一轮真实对话：批次 / seq / 拼接 / diff / usage / 终态')
  const b1 = batchesOf('A', s1send.turnId)
  const f1 = framesOf('A', s1send.turnId)
  check(b1.length >= 2 ? 'ok' : 'bad', `\`stream:batch\` 到达 ${b1.length} 批（≥2 才算「流式」而不是一次性）`)
  /**
   * ★ 一条帧都没有时**不提前收场**：场景 3/4 的判据（库里的行、幽灵 `running`）
   * 与「这一轮有没有流出来」是两回事，它们仍然可判。
   * 但凡是「帧为空就自动成立」的判据（空集合上没有 error、空集合上单调）
   * 必须显式回避 —— 否则报告会在最坏的那次运行里给出一片绿。
   */
  const haveFrames = f1.length > 0
  if (!haveFrames) check('bad', '一条帧都没收到 —— 管道没通')
  const kinds = new Map<string, number>()
  for (const f of f1) kinds.set(f.k, (kinds.get(f.k) ?? 0) + 1)
  say(`  帧的种类        ${[...kinds].map(([k, v]) => `${k}×${v}`).join('  ') || '（无）'}`)

  // seq：批内 fromSeq = 首帧号、toSeq ≥ 末帧号（合并保留首个 seq 会跳号），批间严格递增。
  let seqDetail = ''
  for (const [i, b] of b1.entries()) {
    const first = b.frames[0]?.seq
    const last = b.frames[b.frames.length - 1]?.seq ?? b.fromSeq
    if (b.fromSeq !== first) seqDetail ||= `第 ${i + 1} 批 fromSeq=${b.fromSeq} ≠ 首帧 ${String(first)}`
    if (b.toSeq < last) seqDetail ||= `第 ${i + 1} 批 toSeq=${b.toSeq} < 末帧 ${last}`
    const prev = b1[i - 1]
    if (prev && b.fromSeq <= prev.toSeq) {
      seqDetail ||= `第 ${i + 1} 批 fromSeq=${b.fromSeq} 没越过上一批的 toSeq=${prev.toSeq}`
    }
  }
  check(
    !haveFrames ? 'unknown' : seqDetail === '' ? 'ok' : 'bad',
    `帧 seq 分配自洽（首帧 = fromSeq、末帧 ≤ toSeq、批间严格递增）${seqDetail ? ` —— ${seqDetail}` : ''}`
  )

  // ★ 跨轮次单调：同一 session 的第二个轮次，第一帧的号必须**大于**第一轮的最大号。
  const t2frames = framesOf('A', s2send.turnId)
  const maxOf1 = haveFrames ? Math.max(...f1.map((f) => f.seq)) : null
  const minOf2 = t2frames.length ? Math.min(...t2frames.map((f) => f.seq)) : null
  check(
    maxOf1 === null || minOf2 === null ? 'unknown' : minOf2 > maxOf1 ? 'ok' : 'bad',
    `★ 帧 seq **跨轮次单调**（计数器挂在 session 上、不随轮次销毁）：轮次 1 最大 ${maxOf1 ?? '（本轮无帧）'}，轮次 2 最小 ${minOf2 ?? '（本轮无帧）'}`
  )

  // 拼接：真实端点上一个 delta 只有几个字符，出现长帧就是「相邻 delta 被合并」的直接证据。
  const textFrames = f1.filter((f) => f.k === 'text')
  const textTotal = textFrames.reduce((n, f) => n + String(f.d).length, 0)
  const longest = textFrames.reduce((n, f) => Math.max(n, String(f.d).length), 0)
  check(
    textFrames.length > 0 && longest >= 8 ? 'ok' : 'unknown',
    `text 被拼接：${textFrames.length} 条 text 帧、共 ${textTotal} 字、最长一条 ${longest} 字` +
      `（端点一个 delta 只有几个字符，长帧就是合并的证据）`
  )
  const joinedText = textFrames.map((f) => String(f.d)).join('')
  say(`  流式正文        ${quote(joinedText, 200)}`)

  // thinking
  const thinkingFrames = f1.filter((f) => f.k === 'thinking')
  check(
    thinkingFrames.length > 0 ? 'ok' : 'unknown',
    `thinking 帧 ${thinkingFrames.length} 条、共 ${thinkingFrames.reduce((n, f) => n + String(f.d).length, 0)} 字` +
      `（本端点带正文；换了端点没有思考也不该算坏，见 §2.4-1）`
  )
  /**
   * ★ `thinking_end` 比 `thinking` 多，是**这个端点的真实形状**，不是解析器的重发。
   *
   * 查证（零成本，用 M5 的原始流归档）：这个端点的**每一条** assistant 消息都以一个
   * thinking 块开场，而其中一些块**一个 thinking 增量都没有**（
   * `scripts/evidence/m5-2026-09-23T12-47-39-267Z/main.ndjson` 里第 5 条 assistant
   * 消息：0 条 `thinking_delta`、却照样有 `content_block_start(thinking)` 与
   * `content_block_stop`）。解析器为它发一条 `thinking_end` 是**如实**的 ——
   * 一个块真的开了又关。渲染层那一侧要把「没有开启过的 thinking_end」当成空操作。
   */
  const ends = f1.filter((f) => f.k === 'thinking_end').length
  check(
    ends >= 1 ? 'ok' : 'unknown',
    `thinking_end 帧 ${ends} 条（≥ thinking 帧数 ${thinkingFrames.length} 是正常的：` +
      '本端点每条 assistant 消息都以 thinking 块开场，其中有些块没有任何可见增量）'
  )

  // file_diff —— 帧 + **磁盘上那个文件**两半边都要对
  const diffs = f1.filter((f) => f.k === 'file_diff')
  const aDiff = diffs.find((f) => String(f.path).endsWith('a.ts'))
  check(diffs.length > 0 && !!aDiff ? 'ok' : 'bad', `\`file_diff\` 出现 ${diffs.length} 条（目标是 a.ts）`)
  if (aDiff) {
    const patch = String(aDiff.patch)
    say(`  diff 的 path     ${String(aDiff.path)}`)
    say(`  diff 的 patch    ${quote(patch, 240)}`)
    check(
      patch.includes('-export const x = 1') && patch.includes('+export const x = 2') ? 'ok' : 'bad',
      '★ diff 的内容就是那次 Edit（一行走、一行来）'
    )
    check(!patch.includes('@@') ? 'ok' : 'bad', 'patch 里没有行号 —— 位置未知，不许用数字盖住')
  }
  const fileAfter = String(pick('note', 'A:s1.fileAfter')?.text ?? '')
  check(
    fileAfter.includes('export const x = 2') ? 'ok' : 'bad',
    `★ 磁盘侧：沙箱里的 a.ts 真的被改了（现在是 ${quote(fileAfter, 60)}）—— ` +
      '只看 diff 帧是不够的：帧是**我们**合成的，盘上那个文件才是结果'
  )

  // usage 三个新字段
  const usage = f1.find((f) => f.k === 'usage')
  if (!usage) {
    check('bad', '没有 usage 帧')
  } else {
    const nums = ['in', 'out', 'cacheRead', 'cacheCreation', 'thinkingTokens'].filter(
      (k) => typeof usage[k] === 'number'
    )
    check(
      nums.length === 5 ? 'ok' : 'bad',
      `\`usage\` 帧的五个数字字段都在（in=${String(usage.in)} out=${String(usage.out)} ` +
        `cacheRead=${String(usage.cacheRead)} cacheCreation=${String(usage.cacheCreation)} thinkingTokens=${String(usage.thinkingTokens)}）`
    )
    say(
      `  缓存/思考实测   cacheRead=${String(usage.cacheRead)} cacheCreation=${String(usage.cacheCreation)} ` +
        `（非零**不是** M6a 的验收项 —— M7 才要求缓存命中非零）`
    )
  }

  const done1 = f1.find((f) => f.k === 'done')
  check(done1?.reason === 'complete' ? 'ok' : 'bad', `\`done.reason = ${String(done1?.reason)}\`（期望 complete）`)
  const err1 = f1.filter((f) => f.k === 'error')
  check(
    !haveFrames ? 'unknown' : err1.length === 0 ? 'ok' : 'bad',
    `这一轮没有 error 帧（实测 ${err1.length} 条）`
  )
  const tools = f1.filter((f) => f.k === 'tool_start').map((f) => String(f.name))
  say(`  工具调用        ${tools.length ? tools.join(' → ') : '（无）'}`)
  check(tools.includes('Edit') ? 'ok' : 'unknown', `工具序列里有 Edit（${tools.join(' → ') || '空'}）`)

  const dbA1 = dumpOf('A', 'after-s1')
  const row1 = (dbA1?.turn ?? []).find((t) => t.id === s1send.turnId)
  check(
    row1?.status === 'done' && row1?.terminal_reason === 'complete' ? 'ok' : 'bad',
    `库里的轮次行：status=${String(row1?.status)} terminal_reason=${String(row1?.terminal_reason)}`
  )
  /**
   * ★ 终态行比 `done` 帧晚多久。这是**量出来的边界**，不是断言 ——
   * `done` 帧由合批器那次刷新推出，终态行由 `endTurn` 另一次写入，中间隔着
   * 适配器生成器的收尾。两者不是同一个事务，所以有一小段库里还是 `running` 的空隙。
   * 代价：正好在这段里硬杀，一个跑完的轮次会在下次启动被判成 failed（写进文档）。
   */
  const lag1 = Number(pick('note', 'A:s1.terminal')?.lagMs ?? -1)
  say(
    `  终态行滞后    ${lag1 < 0 ? '没等到（超时）' : `${lag1}ms`} —— done 帧先到渲染层，终态行后落库；` +
      '两者隔着适配器生成器的收尾，不是同一个事务'
  )
  check(
    Number(row1?.tokens_in) > 0 || Number(row1?.tokens_out) > 0 ? 'ok' : 'unknown',
    `库里的 token：in=${String(row1?.tokens_in)} out=${String(row1?.tokens_out)}（列名是 tokens_in/out，` +
      '与 `TurnSchema` 的 `tokensIn/tokensOut` 不是一套写法）'
  )
  const textRows1 = (dbA1?.message_event ?? []).filter((e) => e.kind === 'text')
  check(
    textRows1.length > 0 ? 'ok' : 'bad',
    `落库的 text 事件 ${textRows1.length} 行 / ${textRows1.map((e) => String(e.text_blob ?? '')).join('').length} 字`
  )

  // ══ 场景 2 ═════════════════════════════════════════════════
  rule('场景 2 · 切走抑制与切回重放')
  const awayT = ipcOf('A:s2.viewAway')?.t ?? 0
  const backT = ipcOf('A:s2.viewBack')?.t ?? Number.MAX_SAFE_INTEGER
  const graceEnd = awayT + VIEW_SWITCH_GRACE_MS
  const b2 = batchesOf('A', s2send.turnId)
  const leaked = b2.filter((b) => b.t > graceEnd && b.t < backT)
  const novaUnread = recs.filter(
    (r) =>
      r.kind === 'unread' &&
      (r.payload as { count: number }).count > 0 &&
      (r.payload as { workspaceId: string }).workspaceId === String(ipcData<{ id: string }>('setup.nova')?.id ?? '') &&
      r.t >= awayT - 1000
  )
  check(
    novaUnread.length > 0 ? 'ok' : 'bad',
    `★ 切走期间收到了 Nova 的 \`workspace:unread\` ${novaUnread.length} 次` +
      `（${novaUnread.map((r) => `count=${String((r.payload as { count: number }).count)}`).join(' ')}）—— ` +
      '这是「那段时间帧确实产生了」的正证据'
  )
  check(
    b2.length === 0 ? 'unknown' : leaked.length === 0 ? 'ok' : 'bad',
    `切走 ${VIEW_SWITCH_GRACE_MS}ms 之后、切回之前，页面上**再没有**该轮次的批次（实测漏过来 ${leaked.length} 批` +
      (b2.length === 0 ? ' —— 但这一轮压根没收到过批次，所以它证明不了什么' : '') +
      '）'
  )

  const resumeReq = ipcOf('A:s2.resume')?.req as { epoch?: string; fromSeq?: number } | undefined
  const resume = ipcData<{ matched: boolean; frames: FrameLike[]; epoch: string }>('A:s2.resume')
  check(
    resume?.matched === true ? 'ok' : 'bad',
    `\`stream:resume\` matched=${String(resume?.matched)}（同纪元、水位线有效）`
  )
  check(
    resumeReq?.epoch === String(pick('mark', 'A:s2.away')?.epochBefore) ? 'ok' : 'bad',
    `resume 带的是渲染层**当前持有**的那个纪元（${String(resumeReq?.epoch)?.slice(0, 8)}…）`
  )
  const tail = resume?.frames ?? []
  check(tail.length > 0 ? 'ok' : 'bad', `重放到 ${tail.length} 条在途帧（把切走期间错过的那一截补上）`)
  if (tail.length > 0) {
    const fromSeq = Number(resumeReq?.fromSeq ?? -1)
    check(
      Math.min(...tail.map((f) => f.seq)) > fromSeq ? 'ok' : 'bad',
      `重放的全是水位线之后的帧（fromSeq=${fromSeq}，重放最小 seq=${Math.min(...tail.map((f) => f.seq))}）`
    )
    const seen = new Set(framesOf('A', s2send.turnId).map((f) => f.seq))
    const fresh = tail.filter((f) => !seen.has(f.seq))
    check(
      fresh.length > 0 ? 'ok' : 'unknown',
      `其中 ${fresh.length} 条是页面上**从未见过**的 —— 只有抑制真的生效才会这样`
    )
  }
  const resumedLive = String(pick('note', 'A:s2.resumed-live')?.text) === 'true'
  check(
    resumedLive ? 'ok' : 'unknown',
    resumedLive
      ? '切回之后实时推送恢复（又收到了批次）'
      : '切回之后没再收到批次 —— 无法判定（该轮次可能在切回前就结束了）'
  )
  const row2 = (dumpOf('A', 'after-s2')?.turn ?? []).find((t) => t.id === s2send.turnId)
  /**
   * ★ 轮次 2 的终态按三种情形判，因为**预算闸也是一条合法的出路**：
   * `--max-budget-usd 0.50` 真的踩到时，`status` 会是 `failed` + `terminal_reason=budget`
   * —— 那是闸门在正常工作，不是缺陷。把它判成失败，等于在测试里惩罚一个正确的行为。
   */
  const r2status = String(row2?.status ?? '')
  const r2reason = String(row2?.terminal_reason ?? '')
  check(
    r2status === 'done' ? 'ok' : r2reason === 'budget' ? 'unknown' : 'bad',
    `轮次 2 的终态：${r2status || '（无行）'}${r2reason ? `/${r2reason}` : ''} —— 切走**不影响**它跑完，` +
      `被抑制的只是推送${r2reason === 'budget' ? '（这一轮撞上了 --max-budget-usd 的闸，那是闸门在干活；但它的历史因此不完整，后面的判据按轮次 1 的算）' : ''}`
  )

  // ══ 场景 3 ═════════════════════════════════════════════════
  rule('场景 3 · 硬杀之后重开：历史完整、正文同源')
  const dbB = dumpOf('B', 'after-reopen')
  const liveB = ipcData<unknown[]>('B:s3.listLive')
  // ★ 「调了、返回空数组」与「压根没调成」是两回事：后者是「没测到」，不许写成 ✅。
  check(
    liveB === undefined ? 'unknown' : liveB.length === 0 ? 'ok' : 'bad',
    `重开后 \`turn:listLive\` 为空（${liveB === undefined ? '这个调用没有成功过' : `实测 ${liveB.length} 条`}）`
  )
  const t1Row = (dbB?.turn ?? []).find((t) => t.id === s1send.turnId)
  check(
    t1Row?.status === 'done' ? 'ok' : 'bad',
    `轮次 1 在库里仍是 done（硬杀没把它变成 running/failed）；实测 ${String(t1Row?.status)}`
  )
  const persistedKinds = new Set((dbB?.message_event ?? []).map((e) => String(e.kind)))
  check(
    dbB === undefined ? 'unknown' : !persistedKinds.has('thinking_end') ? 'ok' : 'bad',
    `\`thinking_end\` **没有**落库（§8.5a：线上 9 项 / 可持久化 8 项；` +
      `库里实际出现的类型：${[...persistedKinds].sort().join(' / ') || '（没有事件行）'}）`
  )
  const assistantInfo = (
    JSON.parse(String(pick('note', 'B:s3.messages')?.text ?? '[]')) as Array<{
      id: string
      role: string
      turnId: string
      chars: number
    }>
  ).filter((m) => m.role === 'assistant')
  check(assistantInfo.length > 0 ? 'ok' : 'bad', `\`message:list\` 里有 ${assistantInfo.length} 条 assistant 消息`)

  /**
   * ★ 判据要分层，因为**不是每一轮都该有同样的类型**。
   *
   * `text` / `usage` / `done` 是任何**跑完的**轮次都必然有的三个 —— 缺了就是落库漏了。
   * 而 `tool_start` / `file_diff` 取决于那一轮干了什么：轮次 1 是 Read+Edit（该有 diff），
   * 轮次 2 明确说了「不要修改任何文件」（**不该**有 diff）。把它们按同样的尺子量，
   * 会把一个正确的行为判成失败 —— 所以后一类改成量**并集**：两轮加起来，
   * 七种类型一个不许少（§六 的验收原文就是这么说的）。
   */
  const mustHave = ['text', 'usage', 'done']
  const unionKinds = new Set<string>()
  for (const [i, m] of assistantInfo.entries()) {
    const got = JSON.parse(String(pick('note', `B:s3.eventKinds.${i}`)?.text ?? '[]')) as string[]
    for (const k of got) unionKinds.add(k)
    const missing = mustHave.filter((k) => !got.includes(k))
    check(
      missing.length === 0 ? 'ok' : 'bad',
      `消息 #${i + 1}（轮次 ${m.turnId.slice(0, 8)}…，${got.length} 条事件）：${got.join(' / ')}` +
        (missing.length ? ` —— 缺 ${missing.join('、')}` : '')
    )
    if (m.turnId !== s1send.turnId) continue

    check(got.filter((k) => k === 'done').length === 1 ? 'ok' : 'bad', `恰好一条 done 事件`)
    const mine = (dbB?.message_event ?? []).filter((e) => e.message_id === m.id)
    const seqs = mine.map((e) => Number(e.seq)).sort((a, b) => a - b)
    check(
      seqs.length > 0 && seqs.every((v, idx) => v === idx + 1) ? 'ok' : 'bad',
      `\`message_event.seq\` 从 1 连续到 ${seqs.length}（每消息一个独立计数器）`
    )
    // ★ 同源纪律（§2.3）：**流式帧拼出的正文**与**落库的 content_text** 必须逐字相同。
    const dbText = String((dbB?.message ?? []).find((r) => r.id === m.id)?.content_text ?? '')
    check(
      dbText === joinedText ? 'ok' : 'bad',
      `★ 落库正文与流式帧**逐字同源**（帧 ${joinedText.length} 字 / 库 ${dbText.length} 字）` +
        (dbText === joinedText ? '' : `\n      帧：${quote(joinedText, 140)}\n      库：${quote(dbText, 140)}`)
    )
    const joinedRows = mine.filter((e) => e.kind === 'text').map((e) => String(e.text_blob ?? '')).join('')
    check(
      joinedRows === dbText ? 'ok' : 'bad',
      `★ 库里的 text 事件行拼起来 == \`content_text\`（${joinedRows.length} 字 / ${dbText.length} 字）`
    )
    const doneRow = mine.find((e) => e.kind === 'done')
    check(
      String(doneRow?.payload_json ?? '').includes('complete') ? 'ok' : 'bad',
      `done 事件行如实记着终态：${String(doneRow?.payload_json ?? '(缺失)')}`
    )
    say(`  外置到 blob 的事件行：${mine.filter((e) => e.blob_path).length} 条（>256KB 的载荷才外置）`)
  }
  const wantAll = ['thinking', 'text', 'tool_start', 'tool_result', 'file_diff', 'usage', 'done']
  const unionMissing = wantAll.filter((k) => !unionKinds.has(k))
  check(
    assistantInfo.length === 0 ? 'unknown' : unionMissing.length === 0 ? 'ok' : 'bad',
    `★ 整个会话的事件类型**并集**覆盖七种（§六 的验收原文）：${[...unionKinds].sort().join(' / ')}` +
      (unionMissing.length ? ` —— 缺 ${unionMissing.join('、')}` : '')
  )

  // ══ 场景 4 ═════════════════════════════════════════════════
  rule('场景 4 · 运行中硬杀：如实失败，没有幽灵')
  const statusAtKill = String(pick('note', 'B:s4.statusAtKill')?.text)
  check(
    statusAtKill === 'running' ? 'ok' : 'bad',
    `★ 杀之前轮次 3 的状态是 \`${statusAtKill}\` —— **这一条是场景 4 能证明任何事的前提**：` +
      '不是 running 的话，下面两条什么也证明不了'
  )
  const midFrames = framesOf('B', s4send.turnId).length
  check(midFrames > 0 ? 'ok' : 'unknown', `被杀之前已经收到 ${midFrames} 条帧（它确实在跑，不是还没启动）`)
  const killedRow = (dumpOf('B', 'before-kill')?.turn ?? []).find((t) => t.id === s4send.turnId)
  check(
    typeof killedRow?.pid === 'number' ? 'ok' : 'unknown',
    `库里的 \`turn.pid\` = ${String(killedRow?.pid)}（M10 收尸要靠它）`
  )
  const probe = pick('proc', 'orphan-probe')
  if (probe) {
    say(`  孤儿探测        pid=${String(probe.pid)} 是 claude.exe=${String(probe.isClaude)}；${String(probe.text)}`)
  }
  const reap = pick('proc', 'orphan-reap')
  if (reap) {
    say(`  就地清理        ${String(reap.taskkill)}；清理后还在吗=${String(reap.stillAlive)}`)
    check(reap.stillAlive === false ? 'ok' : 'unknown', '硬杀留下的 claude.exe 被就地清掉了（M10 的活，走查临时做）')
  } else {
    say(`  就地清理        ${String(pick('note', 'orphan')?.text ?? '没有残留可清')}`)
  }

  const dbC = dumpOf('C', 'after-reopen')
  const row3 = (dbC?.turn ?? []).find((t) => t.id === s4send.turnId)
  check(row3?.status === 'failed' ? 'ok' : 'bad', `重开后轮次 3 = ${String(row3?.status)}（期望 failed）`)
  check(
    String(row3?.error_text ?? '').includes('没有自动恢复') ? 'ok' : 'bad',
    `失败原因是**如实**的那句：${quote(String(row3?.error_text ?? '(空)'), 140)}`
  )
  /**
   * ★ 判据是「**不是** complete」，不是「非空」。
   *
   * 这一轮是启动清扫判死的（`reapOrphans`），而清扫**给不出** `terminal_reason`：
   * 那个列记的是 **agent 自己报的**终态（`complete`/`interrupted`/`crashed`/`budget`，
   * 见 `turn-runner` 的 `terminalOf`）。应用是**被杀**的，不是 agent 报了什么 ——
   * 硬填一个 `crashed` 会是**我们**对 agent 行为的一个没根据的断言。
   * 所以这里 `null` 是对的：说清这件事的是 `status=failed` 与那句如实的 `error_text`。
   */
  check(
    row3?.terminal_reason !== 'complete' ? 'ok' : 'bad',
    `\`terminal_reason\` = ${String(row3?.terminal_reason)}（**不是** complete；null 是诚实的 —— ` +
      '清扫给不出 agent 报过的终态，硬填一个就是替它说话）'
  )
  const ghosts = dbC ? (dbC.turn ?? []).filter((t) => t.status === 'running' || t.status === 'queued') : null
  check(
    ghosts === null ? 'unknown' : ghosts.length === 0 ? 'ok' : 'bad',
    `库里没有 \`running\`/\`queued\` 的幽灵行（${ghosts === null ? '没有库转储可判' : `实测 ${ghosts.length} 条`}）`
  )
  const liveC = ipcData<unknown[]>('C:s4.listLive')
  check(
    liveC === undefined ? 'unknown' : liveC.length === 0 ? 'ok' : 'bad',
    `\`turn:listLive\` 为空（${liveC === undefined ? '这个调用没有成功过' : `实测 ${liveC.length} 条`}）`
  )
  const turn3 = ipcData<Record<string, unknown>>('C:s4.turnGet')
  check(
    turn3?.status === 'failed' ? 'ok' : 'bad',
    `\`turn:get\` 走 IPC 读到的也是 failed（${String(turn3?.status)}）—— 与库转储一致`
  )
  const killedMsgId = (dbC?.message ?? []).find((m) => m.turn_id === s4send.turnId)?.id
  const keptRows = (dbC?.message_event ?? []).filter((e) => e.message_id === killedMsgId)
  say(
    `  被杀那一轮已落库的事件：${keptRows.length} 条（${[...new Set(keptRows.map((e) => String(e.kind)))].join(' / ') || '无'}）` +
      ' —— 硬杀最多丢 33ms 的增量，终态与正文折叠是同步写的（§2.5）'
  )

  const graceful = String(pick('note', 'C:graceful-exit')?.text) === 'true'
  check(
    graceful ? 'ok' : 'unknown',
    graceful
      ? '第 3 个实例是**正常退出**的（`will-quit` → 合批器冲空 → 关库）'
      : '第 3 个实例没能正常退出，所以「退出时冲空脏缓冲」那条路径**这次没被覆盖**'
  )

  // ══ 旁证 ═══════════════════════════════════════════════════
  rule('旁证：界面上看到了什么（**不是断言**）')
  for (const d of recs.filter((r) => r.kind === 'dom')) {
    say(`  [${String(d.tag)}] ${quote(String(d.text), 240)}`)
  }
  say('  ⚠️ 启动期的 `app:notice`（「已标记为失败（不会自动恢复）」那句）**故意不断言**：')
  say('     它是 `did-finish-load` 时冲给渲染层的，而走查的监听要连上 CDP 之后才挂得起 ——')
  say('     那条通知到没到，取决于 React 挂载与 CDP 连接的先后，是个真实的竞态。')
  say('     所以「失败原因如实」这一条只按**库里/通道里的**事实判，不按界面文案判。')

  rule('结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '全部通过' : `${failures} 条不通过`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  say('  ⚠️ 端点限定语：全部结论只在**本机默认凭据所指向的端点**下成立，不是 Anthropic 官方行为。')
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
 * `main()` 早就返回了，进程却一直停在那里。第一次干跑就是这么卡住的
 * （它同时还把那个应用留在盘上跑着）。所以退出这件事要显式做，不能指望事件循环自然排空。
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
  // 给 stdout 一次冲刷的机会（它接的是管道，写是异步的），再强退。
  await sleep(300)
  process.exit(code)
}

async function main(): Promise<void> {
  const archive = argValue('archive')
  if (archive) {
    loadArchive(archive)
    rule('M6a 走查 · 重放归档（零成本）')
    return finish(report() === 0 ? 0 : 1)
  }

  const dir = argValue('out') ?? join(EVIDENCE_ROOT, `m6a-${stamp()}`)
  rule('M6a 走查 · 采集')
  say(`  归档目录        ${dir}`)
  say(
    DRY
      ? '  干跑：只装配、**不发任何轮次**，不花钱。'
      : '  ⚠️ 真花钱：3 轮真 CLI，每轮一道 --max-budget-usd 0.50 的硬闸。'
  )

  let crashed: unknown = null
  try {
    await collect(dir)
  } catch (err) {
    crashed = err
    rec({ kind: 'error', tag: 'collect', message: err instanceof Error ? err.message : String(err) })
    say(`\n采集中断：${err instanceof Error ? err.message : String(err)}`)
  }

  /** 干跑没有轮次可判，所以**不出报告** —— 一份全 ❌ 的报告会把「地基好不好」淹掉。 */
  if (DRY) {
    const errs = recs.filter((r) => r.kind === 'error')
    for (const e of errs) say(`  干跑里记到一条错误：${String(e.message)}`)
    say(errs.length || crashed ? '  干跑不干净 —— 先修地基，再花真钱。' : '  干跑干净。')
    return finish(errs.length || crashed ? 1 : 0)
  }

  // ★ 采集崩了也要出报告：已经落档的事实仍然可判 —— 这正是「报告是归档的纯函数」的好处。
  const f = report()
  if (crashed) {
    check('bad', '采集中断了 —— 上面没覆盖到的场景一律算未通过')
    return finish(1)
  }
  return finish(f === 0 ? 0 : 1)
}

main().catch(async (err: unknown) => {
  process.stderr.write(`\n走查自己崩了：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  // 崩了也一样要收摊：子进程可能还在跑（那还在花用户的钱）。
  await finish(1)
})
