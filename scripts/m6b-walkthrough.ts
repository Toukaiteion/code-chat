/**
 * M6b 实机走查 —— 流式对话**界面**：看得见 token 流出来、切走切回、硬杀重放、成本常驻。
 *
 *     npm run walk:m6b:dry                                        # ★ 先跑这个（零成本）
 *     npm run walk:m6b                                            # 真机（真花钱：2 轮）
 *     npm run walk:m6b:replay -- --archive=scripts/evidence/m6b-…  # 重放（零成本）
 *     ⚠️ `walk:m6b:replay` 忘了 `--archive` 时**直接报错退出**，不会顺手采集一次。
 *        这一点与 `walk:m6a:replay` 不同 —— 理由写在 `REPLAY_ONLY` 那里。
 *
 * ## 它与 M6a 走查的关系：骨架照抄，驱动方式**反过来**
 *
 * 骨架（CDP 客户端、spawn/硬杀、归档写入、`check` 三态、报告只读归档）逐字沿用
 * `m6a-pipeline-walkthrough.ts`。两处不同，都是 M6b 的性质逼出来的：
 *
 * ① ★ **驱动方式反过来：不是走 IPC，而是走界面。** M6a 没有任何界面变化，它要的是一个
 *    「能收发 IPC 的渲染进程」，所以装配与发轮次全用 `window.api.invoke`。
 *    M6b **的验收对象就是界面** —— 用 IPC 发一轮再去看 DOM，测的是「数据到了没有」，
 *    而不是「用户点得动吗」。所以这里：**装配**仍走 IPC（夹具不是被测物），
 *    但**打开对话视图、输入、发送、点思考面板、切空间**全部是页面里的真 `click()`。
 *    代价是页面内的辅助函数多了一大块（见 `HELPERS`），换来的是断言落在真 DOM 上。
 *
 * ② **只跑两轮**（M6a 三轮）。两个场景各一轮就够：轮次 1 是 Read + Edit
 *    （正文 / 思考 / 工具 / diff / 光标全在这一轮里），轮次 2 是八文件长读
 *    （够长，够到能切走再切回）。成本与 M6a 大致相当。
 *
 * ## 端点限定语（照 §六「M5 实证」开头的纪律，写最前面）
 *
 * 全部实测跑在**本机当前默认凭据所指向的端点**下（一个 Anthropic 兼容端点，
 * 模型名由 `--model` 给、默认 `deepseek-flash`，**不是 Anthropic 官方**）。
 * 所以「思考面板里有没有正文」「一轮花多少钱」这类结论**只在该端点下成立**。
 * **凭据本身一律不读、不回显、不落档** —— 环境**原样**继承给子进程
 * （`spawn` 不传 `env` 就是原样继承），走查只看得到「端点返回了什么」。
 *
 * ## 为什么断言不许写在采集里（§8.8d 规则九）
 *
 * 采集（`collect()`）只做两件事：驱动真窗口、把**每一个可观测事实**写进归档。
 * **所有断言都在 `report()` 里，而它只读归档。** 采集崩了也照样出报告 ——
 * 已经记下来的事实仍然可判。改判据不需要再买一轮，这不是优化，是纪律。
 *
 * 归档里的四个部分：
 * - `events.jsonl` —— 全部事实（launch / status / batch / unread / dom / ui / probe / mut / db …）
 * - `batches.jsonl` —— 只装推送载荷（`stream:batch` / `stream:status` / `workspace:unread`），逐字
 * - `db-<launch>-<phase>.json` —— 库转储
 * - `app-<launch>.<stdout|stderr>.log`、`console.log`
 *
 * ## 五个场景（plan §七 的验收标准本身）
 *
 * 1. 走界面发一轮 → DOM 里**逐字**出现流式正文、光标在流中在/终态撤、
 *    思考面板可折叠且真有内容、工具时间线**有序**、diff 内容正确
 * 2. **30Hz 隔离**：流式期间**已落定的卡片**的 DOM 一个字节都没被改写
 * 3. 切走 → 批次停止 + 未读（切走多久是**问库问出来的**，不是拍一个秒数）；切回 → 重放把
 *    **我们从未收到过的那一段**补进 DOM，且若切回时它还在跑，实时推送也会接着来
 * 4. **硬杀重开** → 历史完整重放：思考要点开才见（那是有损之处）、工具、diff 都在
 * 5. **成本**：概览屏上就常驻显示、标注「估算」、`turnsWithoutUsage` 非零时露出来
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
 * 于是库（`code-chat.db`）与 `workspaces/` 根都在这个目录下。
 * M6a 用 `cc-m6a` —— 两个走查**各有各的沙箱**，因为它们会各自建空间、各自硬杀。
 */
const SAND = join(tmpdir(), 'cc-m6b')
const USERDATA = join(SAND, 'userdata')
const SRC = join(SAND, 'src-proj')
const PERSONA = join(SAND, 'persona.md')
const DB = join(USERDATA, 'code-chat.db')

const CDP_PORT = 9222
const CDP = `http://localhost:${CDP_PORT}`

/**
 * 切走视图之后，允许多久之内还收到该空间的批次。
 *
 * 它不是「容忍 bug」，而是承认「点一下」到「主进程改掉视图」之间隔着一次 IPC：
 * 在我们记下「切走了」的那一刻，主进程可能刚冲掉一批、还没处理那条请求，
 * 而那一批**本来就该发出来**。取 250ms（远大于一次本地 IPC，也正好是拉取周期）。
 */
const VIEW_SWITCH_GRACE_MS = 250

/** 流式期间的轮询间隔。150ms ≈ 每 4~5 个合批周期看一眼，快过终态交接那 250ms。 */
const POLL_MS = 150

const MODEL = argValue('model') ?? process.env.CODE_CHAT_WALKTHROUGH_MODEL ?? 'deepseek-flash'

/**
 * 干跑：**只开界面、不发轮次**。
 *
 * 它值一个开关，因为走查的地基（构建产物起得来、CDP 连得上、preload 桥在构建版里
 * 真的暴露、装配七次 IPC 全过、**对话视图打开后输入区真的在**）与「流式渲染对不对」
 * 是两个独立的失败面 —— 地基塌了的时候，真机跑一遍会**花钱**换来一份什么都测不到的报告。
 */
const DRY = process.argv.slice(2).includes('--dry')

/**
 * 「只重放，绝不采集」。
 *
 * ★ 这一点**与 M6a 不同**，而且是故意不同的：`walk:m6a:replay` 就是
 * `node scripts/m6a-pipeline-walkthrough.ts` —— 忘了跟 `--archive=<目录>` 的话，
 * 它不会报错，它会**开始一次真采集**（真花钱）。npm 脚本传不了必填参数，
 * 所以「忘了参数就白花两轮」是这个形状下的默认后果。
 *
 * M6b 把那个默认反过来：**没有 `--archive` 就直接退出**。
 * 这不是洁癖 —— 一个叫 replay 的命令在打错字时花钱，是这把枪自己走火。
 */
const REPLAY_ONLY = process.argv.slice(2).includes('--replay')

/**
 * 沙箱项目里那几个文件。`a.ts` 是场景 1 要**真被改掉**的那一个。
 *
 * ★ 有八个而不是四个，是被**实测**逼出来的：这个端点快得离谱（四个文件四次 Read
 * 走完只要 6.5s），场景 3 要的「切走 → 收到未读 → 切回，而切回时它**还在跑**」
 * 在四个文件上根本排不下 —— 切回来的那一刻模型已经把剩下三个读完、缓冲里空空如也。
 * 那一轮的终态提交于是拿到一个空缓冲，一个批次都不发（这是对的），
 * 而走查等的是一个**不可能存在**的推送。八个文件把这一轮拉到十几秒，窗口就排得下了。
 *
 * 代价是多读四个小文件的那点 token —— 与「场景 3 能在真机上成立」相比可以忽略。
 */
const SANDBOX_FILES: Record<string, string> = {
  'CLAUDE.md': '# 沙箱项目\n\nM6b 走查用的沙箱项目。它只提供一个「能读、能改」的目录。\n',
  'a.ts': 'export const x = 1\nexport const y = 2\n',
  'b.ts': 'export function add(a: number, b: number): number {\n  return a + b\n}\n',
  'c.ts': "export const NAME = 'code-chat'\nexport const VERSION = '0.1.0'\n",
  'd.ts': 'export type Id = string\nexport interface Node {\n  id: Id\n}\n',
  'e.ts': 'export const NUMBERS = [1, 2, 3, 4]\nexport const EMPTY: readonly number[] = []\n',
  'f.ts': 'export function mul(a: number, b: number): number {\n  return a * b\n}\n',
  'g.ts': "export const GREETING = '你好'\nexport const FAREWELL = '再见'\n",
  'h.ts': 'export interface Pair {\n  left: string\n  right: string\n}\n'
}

const PERSONA_TEXT =
  '# 沙箱角色\n\n你是一个测试角色。只做用户明确让你做的事，不寒暄、不额外发挥、不改无关文件。\n'

// ─────────────────────────────────────────────────────────────
// 两个提示词
// ─────────────────────────────────────────────────────────────

/** 场景 1：**必须真的调 Read 与 Edit**（`file_diff` 的生产者就是那次 Edit）。 */
const PROMPT_ONE = [
  '只做这两件事，不要做别的：',
  '1. 用 Read 工具读当前目录下的 a.ts。',
  '2. 用 Edit 工具把 a.ts 里的 `export const x = 1` 改成 `export const x = 2`。',
  '做完用一句话说明改了什么，不要贴代码。'
].join('\n')

/**
 * 场景 2：这一轮**要够长**，长到我们来得及「切走 → 收到未读 → 切回」，
 * 而**切回时它还在跑**（不然就没有「在途尾巴」可补，也没有「实时推送恢复」可验）。
 *
 * ★ 八个文件（不是四个）是被实测逼出来的，理由写在 `SANDBOX_FILES` 上面。
 *   同时要求「每读完一个就用一句话概括」—— 那让每次往返都**必然产生文本帧**，
 *   于是切走期间一定攒得下东西，`preText` 与 `postText` 之间那个缺口才不是零。
 */
const PROMPT_TWO = [
  '按顺序做，不要跳步：用 Read 工具依次读 a.ts、b.ts、c.ts、d.ts、e.ts、f.ts、g.ts、h.ts 八个文件，',
  '每读完一个就用一句话概括它的内容，最后用一句话总结这八个文件是干什么的。',
  '不要修改任何文件。'
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

/**
 * 一次「看界面」的快照。**采集期的观察单位**。
 *
 * `best*` 是**整个流式过程中见过的最长的那一次**，而不是最后一次：DOM 的更新
 * 与我们的轮询之间有抖动，取「最长」等价于「内容只增不减」，而这是缓冲的语义
 * （`frame-buffer` 的正文只追加）。取最后一次会让一个恰好落在空档上的轮询
 * 把整条断言判成坏的。
 */
interface LiveProbe {
  /** 在途那张卡片（`article.neon-halo`）的全文；为 `null` = 卡片不在。 */
  bestCard: string
  /** 正文那一段（不带斜体的 `<p>`）。 */
  bestText: string
  /** 思考面板的正文（**调用就会点开它**）。 */
  bestThinking: string
  /** 全程见过 `.typing-cursor` 吗。 */
  sawCursor: boolean
  /** 「光标撤了」那一刻的正文与卡片 —— 见 `watchTurn` 的说明。 */
  textAtDone: string | null
  cardAtDone: string | null
  /** 这一轮是怎么结束观察的。 */
  endedBy: 'cursor-gone' | 'done-frame' | 'terminal-status' | 'timeout' | 'no-card'
  ms: number
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
window.__m6b = {
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
  usageTitle() { return window.__m6b.attr('header span[title]', 'title') },
  usageText() { return window.__m6b.text('header span[title]') },

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
    if (window.__m6bObs) window.__m6bObs.disconnect();
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
    window.__m6bObs = obs;
    window.__m6bObsAcc = acc;
    return 'watching';
  },
  watchStop() {
    if (window.__m6bObs) { window.__m6bObs.disconnect(); window.__m6bObs = null }
    const acc = window.__m6bObsAcc || { live: 0, history: 0, list: 0, chrome: 0, byTarget: {}, from: Date.now() };
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
  const raw = await evaluate('JSON.stringify(window.__m6b.drain())')
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
    `window.__m6b.call(${JSON.stringify(ch)}, ${JSON.stringify(payload === undefined ? null : payload)})`
  )) as { ok?: boolean; data?: T; error?: unknown } | null
  rec({ kind: 'ipc', label: currentLabel, tag, ch, req: payload ?? null, res: r ?? null, ms: Date.now() - started })
  if (!r || r.ok !== true) throw new Error(`IPC ${ch} 失败（${tag}）：${JSON.stringify(r?.error ?? r)}`)
  return r.data as T
}

async function domSnapshot(tag: string): Promise<void> {
  try {
    const text = await evaluate('window.__m6b.dom()')
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
      `window.__m6b.click(${JSON.stringify(sel)}, ${JSON.stringify(sub ?? null)})`
    )
  )
  rec({ kind: 'ui', label: currentLabel, tag, action: 'click', sel, sub: sub ?? null, result: r })
  return r
}

async function typeInto(tag: string, sel: string, value: string): Promise<string> {
  const r = String(await evaluate(`window.__m6b.type(${JSON.stringify(sel)}, ${JSON.stringify(value)})`))
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
 * 在界面上完全等价。代价是 `window.__m6b` 随旧文档一起没了，所以要重新注入。
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
  await evaluate('window.__m6b.hook()')
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
        return Number(await evaluate('window.__m6b.count("aside button")')) > 0
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
  ['liveCard', 'window.__m6b.liveCard()'],
  ['liveText', 'window.__m6b.liveText()'],
  ['hasCursor', 'window.__m6b.hasCursor()'],
  ['liveThinking', 'window.__m6b.liveThinking()'],
  ['cards', 'JSON.stringify(window.__m6b.cards())'],
  ['historyRows', 'JSON.stringify(window.__m6b.historyRows())'],
  ['openHistoryThinking', 'window.__m6b.openHistoryThinking(0)'],
  // 场景 4 的靶子。干跑时页面上一条历史行都没有，所以它必然回 `no-row-with-button`
  // —— 那正是要的：这里验的是它**不炸**，不是它点得开。
  ['openFirstHistoryThinking', 'JSON.stringify(window.__m6b.openFirstHistoryThinking())'],
  ['usageText', 'window.__m6b.usageText()'],
  ['usageTitle', 'window.__m6b.usageTitle()'],
  ['headerName', 'window.__m6b.headerName()'],
  ['count', 'window.__m6b.count("textarea")'],
  // 一次完整的探针往返 —— `watchTurn` 每一拍都走这条路，它炸了整轮采集就断了
  [
    'probeLive',
    'JSON.stringify({card: window.__m6b.liveCard(), text: window.__m6b.liveText(),' +
      ' cursor: window.__m6b.hasCursor(), thinking: window.__m6b.liveThinking()})'
  ],
  ['watch', 'window.__m6b.watch()'],
  ['watchStop', 'JSON.stringify(window.__m6b.watchStop())'],
  // 场景 3 那条判据的唯一取数口。它炸了，最精确的那条断言就整条没测到。
  ['sync', 'JSON.stringify(window.__m6b.sync("dry-no-such-turn"))']
]

/** 页面上的一个布尔查询。页面没了（硬杀、正在关闭）时算「不在」—— 那是等的人该知道的事。 */
async function liveHas(sel: string): Promise<boolean> {
  try {
    return (await evaluate(`window.__m6b.has(${JSON.stringify(sel)})`)) === true
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

/** 一次界面探针，**带副作用**（会点开思考面板）—— 说明见 `HELPERS` 外面的第 3 条。 */
async function probeLive(): Promise<{
  card: string | null
  text: string | null
  cursor: boolean | null
  thinking: string | null
}> {
  const raw = await evaluate(
    'JSON.stringify({' +
      'card: window.__m6b.liveCard(),' +
      'text: window.__m6b.liveText(),' +
      'cursor: window.__m6b.hasCursor(),' +
      'thinking: window.__m6b.liveThinking()' +
      '})'
  )
  const d = JSON.parse(String(raw)) as {
    card: string | null
    text: string | null
    cursor: boolean | null
    thinking: string | null
  }
  return d
}

/**
 * 盯着一轮流式跑完，把**过程**记下来。
 *
 * ## 结束观察的判据是「光标撤了」，不是「done 帧到档了」
 *
 * `StreamingText` 的光标挂在 `done` 上：`done !== null` 那一刻光标就没了，
 * 而缓冲还在（终态推送要 250ms 之后才来）。所以「光标刚撤、卡片还在」是一个
 * **窗口**，而且它比「等归档里出现 done 帧」早得多 —— 后者要等 pump 的下一次拉取
 * （最多 250ms），那时卡片可能已经被丢掉了。
 *
 * 抓住这个窗口是有价值的：它是唯一一个能看到「**完整**正文 + 光标已撤」的时刻，
 * 于是一句 `textAtDone === 帧拼出来的正文` 就同时验了两件事 ——
 * 正文逐字送达，且**光标语义**（说完了就停）是对的。
 *
 * ## 为什么取「最长」而不是「最后一次」
 *
 * 缓冲的正文只追加（`frame-buffer` 的语义），所以「见过的最大值」等价于
 * 「最后一次非空」；而「最后一次」会在恰好落在空档上的轮询里变成 `null`，
 * 把一个正确的轮次判成坏的。
 */
async function watchTurn(tag: string, turnId: string, ms: number): Promise<LiveProbe> {
  let bestCard = ''
  let bestText = ''
  let bestThinking = ''
  let sawCursor = false
  let bestLen = 0
  const from = Date.now()
  const result: LiveProbe = {
    bestCard: '',
    bestText: '',
    bestThinking: '',
    sawCursor: false,
    textAtDone: null,
    cardAtDone: null,
    endedBy: 'timeout',
    ms: 0
  }

  for (;;) {
    const p = await probeLive()
    if (p.card !== null && p.card.length > bestCard.length) bestCard = p.card
    if (p.text !== null && p.text.length > bestLen) {
      bestLen = p.text.length
      bestText = p.text
    }
    if (p.thinking !== null && p.thinking.length > bestThinking.length) bestThinking = p.thinking
    if (p.cursor === true) sawCursor = true

    if (p.card === null && sawCursor) {
      // 卡片没了 = 缓冲被丢掉（终态推送处理完了）—— 我们错过了那个窗口。
      result.endedBy = 'no-card'
      break
    }
    if (sawCursor && p.cursor === false) {
      // ★ 目标窗口：光标撤了（done 已到）而卡片还在。
      result.endedBy = 'cursor-gone'
      result.textAtDone = p.text
      result.cardAtDone = p.card
      break
    }
    if (!sawCursor && framesOf(currentLabel, turnId).some((f) => f.k === 'done')) {
      /**
       * 没能等到光标（`done` 一到正文就结束了，整段正文与 `done` 落在同一批里，
       * 光标活不过一拍 150ms）。退回 `done` 帧。
       *
       * ★ 与光标那条路不同，这里**不天然带「正文已完整」的保证**：`done` 帧到档不等于
       * DOM 已经画完那一批（store 更新与 React 提交之间有一拍）。而这个函数的**第一个**
       * 判据就是「DOM 与帧逐字相同」，所以宁可再等一拍、取更长的那一个 ——
       * 否则一次抽签会把一个正确的轮次判成坏的，而那个 ❌ 是要花钱才能重跑的。
       */
      await sleep(POLL_MS)
      const q = await probeLive()
      if (q.card !== null && q.card.length > bestCard.length) bestCard = q.card
      if (q.text !== null && q.text.length > bestLen) {
        bestLen = q.text.length
        bestText = q.text
      }
      if (q.thinking !== null && q.thinking.length > bestThinking.length) bestThinking = q.thinking
      if (q.cursor === true) sawCursor = true
      result.endedBy = 'done-frame'
      break
    }
    /**
     * ★ 最后一道出口：**终态推送**。它永不抑制（`channels.ts` 那条「状态按 workspace
     * 抑制、状态不抑制」的分工），所以它到档就一定意味着这一轮结束了 —— 无论我们
     * 有没有收到 `done` **帧**。
     *
     * 这条出口是被一次真机走查逼出来的：切走切回那一轮，正文最后几秒全在被抑制的
     * 窗口里跑完，`done` 帧跟着一起被抑制掉了。于是上面三条判据一条都不成立，
     * `watchTurn` 抱着一个 5 分钟的窗口空转到天亮 —— 而它本来要观察的那一轮**早就结束了**。
     *
     * 排在最后是**有意**的：光标撤下比终态推送早（那 249–377ms），
     * 能抓到光标窗口就抓，抓不到才退回这一条。
     */
    if (statusesOf(currentLabel, turnId).some((s) => s.status !== 'running' && s.status !== 'queued')) {
      result.endedBy = 'terminal-status'
      break
    }
    if (Date.now() - from > ms) break
    await sleep(POLL_MS)
  }

  result.bestCard = bestCard
  result.bestText = bestText
  result.bestThinking = bestThinking
  result.sawCursor = sawCursor
  result.ms = Date.now() - from
  rec({ kind: 'probe', label: currentLabel, tag, ...result })
  say(
    `  观察 ${Math.round(result.ms / 1000)}s：正文 ${bestText.length} 字 / 思考 ${bestThinking.length} 字 / ` +
      `光标${sawCursor ? '见过' : '没见'} / 结束于 ${result.endedBy}`
  )
  return result
}

/**
 * `running` / `queued` 之外都算终态。**只此一处定义** —— 走查里「这一轮结束了没有」
 * 这个问题在四个地方被问（等终态、盯一轮、场景 3 的收手、报告里数终态）,
 * 四处各写一遍 `!== 'running' && !== 'queued'` 迟早会有一处漏掉 `queued`。
 */
function isTerminalStatus(s: string): boolean {
  return s !== 'running' && s !== 'queued'
}

/**
 * 只读地问一次库：这一轮**已经落了多少条事件行**、其中**多少条是正文**。
 *
 * ★ 用途是让场景 3 的「切走窗口」**自适应**，而不是拍一个秒数 —— 端点是快是慢我们
 * 说了不算。数事件行是**唯一**一个能同时回答「它还在产出吗」和「切走期间产出了多少」的量，
 * 而这两个问题的答案原本都不在推送流里（抑制掉的帧一条都不推送）。
 *
 * ⚠️ 失败返回 `null`（**读不到 ≠ 0 条**）。调用方必须把 `null` 当成「不知道」，
 * 而不能当成「一条都没产」—— 那会把一次读库失败说成「重放没东西可补」。
 */
function turnEventStats(turnId: string): { events: number; text: number } | null {
  try {
    const db = new DatabaseSync(DB, { readOnly: true })
    try {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n, SUM(CASE WHEN e.kind = 'text' THEN 1 ELSE 0 END) AS t " +
            'FROM message_event e JOIN message m ON m.id = e.message_id WHERE m.turn_id = ?'
        )
        .get(turnId) as { n?: number; t?: number } | undefined
      return { events: Number(row?.n ?? 0), text: Number(row?.t ?? 0) }
    } finally {
      db.close()
    }
  } catch {
    return null
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

function statusesOf(label: string, turnId?: string): StatusLike[] {
  return recs
    .filter((r) => r.kind === 'status' && r.label === label)
    .map((r) => r.payload as StatusLike)
    .filter((s) => (turnId === undefined ? true : s.turnId === turnId))
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

/**
 * 夹具：**走 IPC**（照 M6a）。
 *
 * ★ 这里刻意不点界面建空间 —— 夹具不是被测物。M6b 要测的是「对话视图能不能用」，
 * 把十个对话框点一遍换来的是走查的脆弱（每改一次表单布局就废一次），
 * 而它一条断言也不增加。**该走界面的地方（打开对话、输入、发送、切空间、
 * 展开思考）全部走界面**，见下面几个场景。
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
   * `member:setVisibility` 一次把「可见集合 + 主项目」都定了 —— 走的是**收窄**那条路，
   * 于是 §8.4 的可见性模型在走查里是真的被用上了。
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

  // 第二个空间：场景 3 要切到**另一个真的空间**去，而不是切到一个空 id。
  const vega = await call<{ id: string; name: string }>('setup.vega', 'workspace:create', { name: 'Vega' })
  const vproj = await call<{ id: string }>('setup.vegaProject', 'project:addLocal', {
    workspaceId: vega.id,
    name: 'sandbox',
    rootPath: SRC
  })
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
   * 漏了这一步，第一批就会被合法地抑制掉，而现象看起来像「流式没通」。
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

  rule('M6b 走查 · 准备')
  prepareSandbox()

  // ══ 第一次启动：场景 1~5 ════════════════════════════════
  rule('启动 A · 装配 + 场景 1（走界面发一轮：Read + Edit）')
  launch('A')
  await connectCdp()
  await evaluate(HELPERS)
  const hooked = await evaluate('window.__m6b.hook()')
  rec({ kind: 'note', tag: 'hooked', text: String(hooked) })
  startPump()
  await sleep(700)
  await domSnapshot('A:startup')

  const ids = await setup()
  dumpDb('A', 'setup')
  // ★ 夹具是走 IPC 建的，界面还不知道 —— 重载一次让库重新读进 store。
  await reloadRenderer()
  // 重载之后 `App` 的 effect 会选中 `order[0]`，但那**不保证是 Nova**（顺序来自仓库）。
  // 走查自己点一次，把「在看 Nova」这件事变成显式的、被归档的事实。
  const picked = await click('A:pickNova', 'aside button', 'Nova')
  rec({ kind: 'note', tag: 'A:pickNova', text: picked })
  await sleep(400)
  rec({ kind: 'note', tag: 'A:header', text: String(await evaluate('window.__m6b.headerName()')) })

  if (DRY) {
    /**
     * 干跑自检：桥在构建版里暴露了吗？**对话视图打得开吗**（这是 M6b 独有的地基，
     * M6a 没有这一层）？输入区在吗？成本常驻显示出现了吗？—— 全部零成本。
     */
    const before = await evaluate(
      'JSON.stringify({' +
        'api: typeof window.api?.invoke, on: typeof window.api?.on, hooked: window.__m6b.hooked,' +
        'header: window.__m6b.headerName(), usage: window.__m6b.usageText(),' +
        'cards: window.__m6b.cards()' +
        '})'
    )
    rec({ kind: 'note', tag: 'dry.before', text: String(before) })
    say(`  干跑探针（概览）  ${String(before)}`)

    const opened = await openConversation('A:dry')
    const after = await evaluate(
      'JSON.stringify({' +
        'textarea: window.__m6b.has("textarea"),' +
        'send: window.__m6b.count("button"),' +
        'cards: window.__m6b.cards(),' +
        'usage: window.__m6b.usageText()' +
        '})'
    )
    rec({ kind: 'note', tag: 'dry.after', text: String(after), opened })
    say(`  干跑探针（对话）  ${String(after)}`)

    /**
     * ★ 零成本地验一次**发送路径上最脆的那一环：受控输入**。
     *
     * 直接 `el.value = x` 在 React 里**不触发** `onChange` —— 于是输入框看着有字、
     * `text` 状态还是空的、点「发送」什么也不会发生，而现象是「点了没反应」。
     * 真判断「React 收到了没有」的信号是**发送按钮从 disabled 变成可点**
     * （它的 `disabled` 就是 `text.trim() === ''`）。
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
    // 清干净：这个沙箱下一次采集还要用（虽然每次都会重建）。
    await typeInto('A:dry', 'textarea', '')

    await smokeHelpers()

    stopPump()
    const pidDry = currentChild?.pid ?? 0
    hardKill('A')
    await waitGone(pidDry)
    rule('干跑结束（**没有发起任何轮次，没花钱**）')
    say('  地基这一层：构建产物起得来、CDP 连得上、preload 桥在构建版里可用、装配七次 IPC 全过、')
    say('  对话视图打得开、输入区与发送按钮都在、成本那一格有数。')
    say('  下一句才是真机：npm run walk:m6b（真花钱，2 轮）。')
    return
  }

  /**
   * ★ 场景 5 的前半，**在进对话视图之前**取：§5.4 要的是「常驻显示」，
   * 而常驻的意思就是「概览屏上也看得见」。等切过去再取，就只能证明「对话屏上有」。
   */
  const usageEarly = String(await evaluate('window.__m6b.usageText()'))
  const usageTitle = String(await evaluate('window.__m6b.usageTitle()'))
  rec({ kind: 'note', tag: 'A:usage.overview', text: usageEarly, title: usageTitle })
  say(`  概览屏上的成本    ${quote(usageEarly, 60)}`)
  await domSnapshot('A:overview')

  // ── 打开对话视图 ─────────────────────────────────────────
  rule('场景 1 · 打开对话视图，走界面发一轮')
  const opened = await openConversation('A:s1')
  rec({ kind: 'note', tag: 'A:s1.opened', text: String(opened) })

  const since1 = recs.length
  await sendViaUI('A:s1', PROMPT_ONE)
  const turn1 = await waitTurnId('A:s1.turnId', 'A', 30000, since1)
  if (turn1 === null) throw new Error('点了发送，但既没有 stream:status 也没有 stream:batch —— 消息没发出去')

  // 观察窗口从**第一批帧到了之后**开始：这时在途卡片已经建起来了，
  // 计数里就不会混进「卡片刚出现」那几次 DOM 变动。
  await waitUntil('轮次 1 的第一批', () => batchesOf('A', turn1).length > 0, 120000)
  await drain()
  await evaluate('window.__m6b.watch()')
  // 观察结果由 `watchTurn` 自己写进归档 —— 报告只读归档，所以这里不必再接住它的返回值。
  await watchTurn('A:s1.live', turn1, 240000)
  const mut1 = (await evaluate('JSON.stringify(window.__m6b.watchStop())')) as string
  rec({ kind: 'mut', label: 'A', tag: 'A:s1.stream', raw: mut1 })
  say(`  DOM 改写计数      ${mut1}`)

  const gotDone1 = await waitUntil(
    '轮次 1 的 done 帧',
    () => framesOf('A', turn1).some((f) => f.k === 'done'),
    60000
  )
  rec({ kind: 'note', tag: 'A:s1.done-frame', text: String(gotDone1) })
  await drain()
  await waitTerminal('A:s1.terminal', turn1, 15000)
  await sleep(600) // 等界面把缓冲折成历史行
  await domSnapshot('A:after-s1')
  dumpDb('A', 'after-s1')

  // 磁盘侧：那次 Edit 到底有没有真的发生
  const after1 = existsSync(join(SRC, 'a.ts')) ? readFileSync(join(SRC, 'a.ts'), 'utf8') : '(没有这个文件)'
  rec({ kind: 'note', tag: 'A:s1.fileAfter', text: after1, file: join(SRC, 'a.ts') })

  // ── 场景 3：切走 → 抑制 → 切回 → 重放 ────────────────────
  rule('场景 3 · 切走 → 批次停止 + 未读；切回 → 重放把没见过的那一段补进 DOM')
  const since2 = recs.length
  await sendViaUI('A:s2', PROMPT_TWO)
  const turn2 = await waitTurnId('A:s2.turnId', 'A', 30000, since2)
  if (turn2 === null) throw new Error('第二轮没有推送 —— 消息没发出去')

  // 切走之前必须**已经有正文**，否则「切回后补上的那一段」无从谈起。
  const gotText2 = await waitUntil(
    '轮次 2 的第一条 text 帧',
    () => framesOf('A', turn2).some((f) => f.k === 'text' && String(f.d).length > 0),
    120000
  )
  rec({ kind: 'note', tag: 'A:s2.first-text', text: String(gotText2) })
  await drain()
  rec({ kind: 'mark', tag: 'A:s2.awayPre', batches: batchesOf('A', turn2).length })

  // ★ 切走 = 在左栏点**另一个真空间**（Vega 有项目、有成员、有会话）。
  const awayClicked = await click('A:s2.away', 'aside button', 'Vega')
  const awayT = Date.now()
  rec({ kind: 'mark', tag: 'A:s2.away', t: awayT, clicked: awayClicked })

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

  /**
   * ★ 切走多久是**问出来的，不是拍出来的**。
   *
   * 两个愿望互相拉扯：切走得够久，切走期间产出的**正文**才够多（那个缺口才不是零，
   * 后面的「界面 > 推送」才抢得到读数）；切回来得够早，轮次才**还在跑**
   * （否则「实时推送恢复」无从验起，而且缓冲一旦被终态推送丢掉，那一瞬再也抢不回来）。
   * 端点是快是慢我们说了不算，所以只能一边走一边看：**问库**这一轮现在什么状况。
   *
   * ⚠️ 第一版把这两个愿望**拧反了**：它把「还在产出事件行」当成继续待着的理由
   * （`QUIET_MS` 静默才收手），于是一个从头到尾都在产出的轮次会把窗口拉到
   * `AWAY_MAX_MS` —— 而「一直在产出」恰恰是**最该回来**的时候。实测就撞在这上面：
   * 事件行连续到了 12s，回来时那一轮已经 `status done`，切回那一刻缓冲被终态推送丢掉，
   * 界面正文长度 0，「界面 > 推送」一条读数都没抢到。
   *
   * 所以现在的条件是：
   *
   * - **终态到了 → 立刻回来**（再待着只会白白错过，缺口已经不可能变大）；
   * - **满 `AWAY_MIN_MS` 且切走期间**真的有正文**落库 → 回来**（缺口非空，且此刻多半还在跑）；
   * - **满 `AWAY_MAX_MS` → 回来**（兜底，且如实记下 `endedBy: 'max'`）。
   *
   * 「正文」不只是「事件行」：一轮的开头常常是一长段思考，而思考**不产生正文**。
   * 只数事件行的话，切走 2.5s 里可能只落了几条 thinking，回来时缺口里一个字都没有，
   * 「界面 > 推送」照样抢不到。所以这里数的是 `kind = 'text'` 的行。
   *
   * ⚠️ 两个计数都是**从库里读的**，不是从我们收到的帧里数的 —— 抑制掉的帧一条都不推送，
   * 所以「切走期间产出了多少」这个问题在推送流里根本没有答案。这也正是它顺带
   * 证明了的事：那些帧**确实产生了**，只是没来我们这儿。
   */
  const AWAY_MIN_MS = 2500
  const AWAY_MAX_MS = 12000
  const awayStart = turnEventStats(turn2)
  let awayNow = awayStart
  let awayEndedBy = 'max'
  for (;;) {
    await sleep(POLL_MS)
    const n = turnEventStats(turn2)
    if (n !== null) awayNow = n
    const el = Date.now() - awayT
    if (statusesOf('A', turn2).some((s) => isTerminalStatus(s.status))) {
      awayEndedBy = 'terminal'
      break
    }
    if (el >= AWAY_MIN_MS && awayStart !== null && awayNow !== null && awayNow.text > awayStart.text) {
      awayEndedBy = 'text'
      break
    }
    if (el >= AWAY_MAX_MS) {
      awayEndedBy = 'max'
      break
    }
  }
  await drain()
  const awayBatches = batchesOf('A', turn2).length
  rec({
    kind: 'mark',
    tag: 'A:s2.awayEnd',
    t: Date.now(),
    batches: awayBatches,
    endedBy: awayEndedBy,
    eventsBefore: awayStart?.events ?? -1,
    eventsAfter: awayNow?.events ?? -1,
    producedWhileAway:
      awayStart !== null && awayNow !== null ? awayNow.events - awayStart.events : -1,
    textBefore: awayStart?.text ?? -1,
    textAfter: awayNow?.text ?? -1,
    textWhileAway: awayStart !== null && awayNow !== null ? awayNow.text - awayStart.text : -1
  })

  // ★ 切回 = 点 Nova。`ConversationPane` 的 effect 会重跑 `openConversation`，
  //   里面那句 `resumeWorkspace` 就是 `stream:resume` 的调用点 —— 它发生在**渲染进程内部**，
  //   走查看不到那次 IPC，但看得到它的结果（下面那条 DOM 断言）。
  const backClicked = await click('A:s2.back', 'aside button', 'Nova')
  const backT = Date.now()
  rec({ kind: 'mark', tag: 'A:s2.back', t: backT, clicked: backClicked })

  /**
   * ★★ 抢一个瞬间：**界面上的正文 > 我们收到过的全部推送**。
   *
   * 这是「重放真的补进了 DOM」唯一一个不依赖时序巧合的判据。推送只会让正文变长，
   * **永远不会让它超出自己**；所以只要某一刻界面比推送长，多出来的那一段就不可能是推送，
   * 而它也不可能是历史行 —— 这一刻这一轮还在跑，历史行正被 `buildTimeline` 压着
   * （有缓冲的轮次，那条历史行不进列表）。剩下唯一的来源就是 `stream:resume` 的返回。
   *
   * 窗口 4s、间隔 50ms。这个端点上推送是 33ms 一拍，所以「重放已应用、下一批推送还没到」
   * 那个空档有多宽不由我们说了算 —— **抢不到不等于没重放，只等于这一条没测到**，
   * 报告那边按三态说这句话。
   */
  const syncSamples: Array<{
    at: number
    cardLen: number
    textLen: number
    pushLen: number
    delta: number
    batches: number
  }> = []
  let bestSync: (typeof syncSamples)[number] | null = null
  const syncUntil = Date.now() + 4000
  while (Date.now() < syncUntil) {
    let s: { t: number; card: string | null; text: string | null; pushText: string; batches: number }
    try {
      s = JSON.parse(String(await evaluate(`JSON.stringify(window.__m6b.sync(${JSON.stringify(turn2)}))`))) as typeof s
    } catch {
      break
    }
    const sample = {
      // ⚠️ `null` 卡片记成 -1 而不是 0：这两件事完全不同 —— 「卡片不在」= 这一瞬抢不到，
      //    「卡片在但没有正文段」= 抢到了、读数是空的。混成同一个 0 会让报告分不清该说
      //    「没测到」还是「测出来是坏的」。
      cardLen: s.card === null ? -1 : s.card.length,
      at: s.t,
      textLen: (s.text ?? '').length,
      pushLen: s.pushText.length,
      delta: (s.text ?? '').length - s.pushText.length,
      batches: s.batches
    }
    syncSamples.push(sample)
    // ★ 只在**卡片在**的样本里挑最好的一条：卡片不在时 `text` 是 null，
    //   `delta` 会是一个恒为负的假读数，它没资格代表这个窗口。
    if (sample.cardLen >= 0 && (bestSync === null || sample.delta > bestSync.delta)) bestSync = sample
    await sleep(50)
  }
  rec({
    kind: 'mark',
    tag: 'A:s2.sync',
    t: Date.now(),
    samples: syncSamples.length,
    cardsPresent: syncSamples.filter((x) => x.cardLen >= 0).length,
    best: bestSync,
    // 只留前后各三个样本，归档不必装 80 个几乎一样的数
    head: syncSamples.slice(0, 3),
    tail: syncSamples.slice(-3)
  })

  /**
   * 等「切回之后的实时批次」—— 但**同时等终态推送**，因为后者一到，就再没有任何帧会来了。
   *
   * ★ 这两件事必须分开记，不能合成一个 `true`：`live=0` 而终态已经到档，
   * 意思是「这一轮在我们切回来之前就产完了」——**不是**「实时推送坏了」。
   * 把它们说成同一句话，就是拿一个测不到的东西当成测出来是坏的（§8.8e 规则三）。
   */
  const liveWaited = await waitUntil(
    '切回之后的实时批次（或终态推送 —— 后者一到就再没有帧会来了）',
    () =>
      recs.some((r) => r.kind === 'batch' && r.t > backT && (r.payload as BatchLike).turnId === turn2) ||
      statusesOf('A', turn2).some((s) => isTerminalStatus(s.status)),
    60000
  )
  const liveBatches = batchesOf('A', turn2).filter((b) => b.t > backT).length
  rec({
    kind: 'mark',
    tag: 'A:s2.liveAfterBack',
    t: Date.now(),
    live: liveBatches,
    waited: liveWaited,
    terminalSeen: statusesOf('A', turn2).some((s) => isTerminalStatus(s.status))
  })

  const probe2 = await watchTurn('A:s2.live', turn2, 300000)
  const gotDone2 = await waitUntil(
    '轮次 2 的 done 帧',
    () => framesOf('A', turn2).some((f) => f.k === 'done'),
    60000
  )
  rec({ kind: 'note', tag: 'A:s2.done-frame', text: String(gotDone2) })
  await drain()
  await waitTerminal('A:s2.terminal', turn2, 15000)
  await sleep(600)
  await domSnapshot('A:after-s2')
  dumpDb('A', 'after-s2')
  rec({ kind: 'note', tag: 'A:s2.probe', text: JSON.stringify({ textAtDone: (probe2.textAtDone ?? '').length, best: probe2.bestText.length }) })

  // ── 硬杀 ─────────────────────────────────────────────────
  rule('硬杀 A（两轮都跑完了）')
  const pidA = currentChild?.pid ?? 0
  stopPump()
  hardKill('A')
  const goneA = await waitGone(pidA)
  rec({ kind: 'note', tag: 'A:gone', text: String(goneA) })
  dumpDb('A', 'after-hard-kill')

  // ══ 第二次启动：场景 4 ══════════════════════════════════
  rule('启动 B · 场景 4（硬杀重开：历史完整重放）')
  launch('B')
  await connectCdp()
  await evaluate(HELPERS)
  await evaluate('window.__m6b.hook()')
  startPump()
  await sleep(1200)
  await click('B:pickNova', 'aside button', 'Nova')
  await sleep(400)
  await domSnapshot('B:overview')

  const openedB = await openConversation('B:s4')
  rec({ kind: 'note', tag: 'B:s4.opened', text: String(openedB) })
  // 历史行要等 `loadEvents` 一条条读完事件行才折出来 —— 给它时间，并**等它真的到**。
  await waitUntil('历史卡片出现', () => liveHasDoneCards(), 20000)

  const cards = await evaluate('JSON.stringify(window.__m6b.cards())')
  rec({ kind: 'note', tag: 'B:s4.cards', text: String(cards) })
  say(`  重开后的卡片      ${String(cards)}`)

  const histBefore = String(await evaluate('JSON.stringify(window.__m6b.historyRows())'))
  rec({ kind: 'note', tag: 'B:s4.history.before', text: histBefore })
  // ★ 展开**第一条真的有思考按钮**的历史行。历史里没有 `thinking_end` 这个事实，
  //   所以初值**必然是收起**的 —— 这正是 `history.ts` 那处有损之处在界面上的样子，
  //   而它是可以被点开的。哪一条有按钮由库里有没有 `thinking` 事件决定（端点的行为），
  //   所以靶子要当场找，见 `openFirstHistoryThinking`。
  const openedThink = JSON.parse(
    String(await evaluate('JSON.stringify(window.__m6b.openFirstHistoryThinking())'))
  ) as { i: number; wasOpen: boolean; stateAtClick: string }
  await sleep(200)
  const histAfter = String(await evaluate('JSON.stringify(window.__m6b.historyRows())'))
  rec({
    kind: 'note',
    tag: 'B:s4.history.after',
    text: histAfter,
    openResult: openedThink.stateAtClick,
    openIndex: openedThink.i,
    wasOpenBefore: openedThink.wasOpen,
    clicked: openedThink.i
  })
  say(`  展开第 ${String(openedThink.i)} 条思考面板：点击当拍读到 ${openedThink.stateAtClick}（判据看睡过一觉之后的那份快照）`)
  await domSnapshot('B:s4.history')
  dumpDb('B', 'after-reopen')

  // 场景 5 的后半：重开之后成本还在（常驻的第二个含义 —— 它不随进程消失）
  const usageB = String(await evaluate('window.__m6b.usageText()'))
  rec({ kind: 'note', tag: 'B:usage', text: usageB })
  const usageIpc = await call<Record<string, unknown>>('B:s5.usage', 'workspace:usage', {
    workspaceId: ids.nova.id
  })
  rec({ kind: 'note', tag: 'B:s5.usage', text: JSON.stringify(usageIpc) })
  say(`  重开后的成本      ${quote(usageB, 60)}`)
  say(`  workspace:usage   ${JSON.stringify(usageIpc)}`)

  // ── 收尾：让 B 走一次正常退出 ─────────────────────────────
  rule('收尾 · 让 B 正常退出')
  const pidC = currentChild?.pid ?? 0
  let graceful = false
  try {
    await evaluate('window.close()')
    graceful = await waitGone(pidC, 10000)
  } catch {
    graceful = false
  }
  rec({ kind: 'note', tag: 'B:graceful-exit', text: String(graceful) })
  if (!graceful) {
    stopPump()
    hardKill('B')
    await waitGone(pidC)
  } else {
    stopPump()
    currentChild = null
    ws = null
  }
  say(`  B ${graceful ? '正常退出' : '没能正常退出（已硬杀）'} —— 这一条会如实进报告`)

  rule('采集结束')
  say(`  归档目录：${runDir}`)
}

/** 页面上有没有已落定的卡片（历史行折出来了没有）。 */
async function liveHasDoneCards(): Promise<boolean> {
  try {
    const n = Number(await evaluate('window.__m6b.count("article.neon-frame:not(.neon-halo)")'))
    return n > 0
  } catch {
    return false
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

/** 归档里的那一次界面探针。 */
function probeOf(tag: string): LiveProbe | undefined {
  const r = pick('probe', tag)
  if (!r) return undefined
  return r as unknown as LiveProbe
}

interface HistRow {
  hasThinkingButton: boolean
  thinkingOpen: boolean
  thinkingText: string
  text: string
}

function histRowsOf(tag: string): HistRow[] | null {
  const r = pick('note', tag)
  if (!r) return null
  try {
    return JSON.parse(String(r.text)) as HistRow[]
  } catch {
    return null
  }
}

interface MutAcc {
  live: number
  history: number
  /** 消息列表本身（`.grid-bg`），含用户气泡那种 `div`。 */
  list: number
  chrome: number
  byTarget: Record<string, number>
  ms?: number
}

function mutOf(tag: string): MutAcc | null {
  const r = pick('mut', tag)
  if (!r) return null
  try {
    return JSON.parse(String(r.raw)) as MutAcc
  } catch {
    return null
  }
}

/**
 * 干跑的报告。**它只判「地基」** —— 零成本那一层能测到的东西。
 *
 * ★ 它必须**真的判**，不能只检查「有没有报错」。
 * §8.8e 规则三：**缺证据不许印成 ✅**。第一次干跑的版本就是只看了 `kind === 'error'`，
 * 于是它在「顶栏压根没渲染、输入区根本不存在」的情况下印了一句「干跑干净」——
 * 而那正是干跑要挡住的失败（它会让人以为地基没问题，然后花真钱换来一份什么都没测到的报告）。
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
    '在左栏点得中空间（装配出来的两个空间在界面上真的存在）'
  )
  check(
    typeof before.header === 'string' && before.header !== '' && before.header !== 'null'
      ? 'ok'
      : 'bad',
    `顶栏渲染出来了、而且显示的是被选中的那个空间的名字：${String(before.header)} —— ` +
      '它是 `null` 的时候说明界面还停在「一个空间都没有」的空态上'
  )
  check(
    typeof before.usage === 'string' && before.usage.includes('估算') ? 'ok' : 'bad',
    `★ **概览屏上**就有成本那一格：${String(before.usage)} —— §5.4 要的「常驻显示」`
  )
  check(
    String(pick('note', 'dry.after')?.opened) === 'true' && after.textarea === true ? 'ok' : 'bad',
    `点「对话」真的打开了对话视图、输入区在里面（textarea=${String(after.textarea)}）—— ` +
      '这是 M6b 独有的一层地基，M6a 的走查没有它'
  )
  check(
    Number(after.send) >= 1 ? 'ok' : 'bad',
    `发送按钮在（页面上共 ${String(after.send)} 个 button）`
  )
  check(
    (before.cards as { live?: number } | undefined)?.live === 0 ? 'ok' : 'bad',
    '一个轮次都没发，所以没有任何在途卡片'
  )

  /**
   * ★ **受控输入真的进了 React 的状态**。这一条必须在这里过 ——
   * 它在真机上的失败形态是「点了发送没反应」，而那要等到花了钱之后才会看到。
   */
  const typedResult = pick('note', 'dry.type')
  check(
    typedResult?.typed === 'typed' && String(typedResult?.text) === 'false' ? 'ok' : 'bad',
    `受控输入：写进 textarea = ${String(typedResult?.typed)}，发送按钮因此变为可点（disabled=${String(typedResult?.text)}）` +
      ' —— `disabled` 还是 true 就说明 React 没收到 onChange，点了发送也不会有任何事发生'
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

  rule('干跑结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '地基干净，可以花真钱了（npm run walk:m6b）' : `${failures} 条不通过 —— **先修地基，再花真钱**`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  return failures
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
  say('  驱动方式        **界面**（点击 / 输入 / 切空间）—— 装配走 IPC，夹具不是被测物')

  const collectErrs = recs.filter((r) => r.kind === 'error')
  if (collectErrs.length > 0) {
    say(`  ⚠️ 采集器记到 ${collectErrs.length} 条错误 —— 下面的 ❌ 要先怀疑采集，再怀疑产品`)
    for (const e of collectErrs) say(`     [${String(e.tag ?? '?')}] ${String(e.message ?? '')}`)
  }

  const idsNote = pick('note', 'ids')
  const ids = JSON.parse(String(idsNote?.text ?? '{}')) as {
    nova?: { id: string }
    vega?: { id: string }
  }
  const turn1 = pick('note', 'A:s1.turnId')?.text as string | undefined
  const turn2 = pick('note', 'A:s2.turnId')?.text as string | undefined
  if (typeof turn1 !== 'string' || typeof turn2 !== 'string') {
    check('bad', '归档里没有两轮的 turnId —— 「发送」这一步没走通（推送一条都没来），后面的断言无从谈起')
    return failures
  }
  say(`  轮次            1 = ${turn1.slice(0, 8)}…  2 = ${turn2.slice(0, 8)}…`)

  // ══ 场景 1 ═════════════════════════════════════════════════
  rule('场景 1 · 走界面发一轮：正文逐字 / 光标 / 思考 / 工具 / diff')

  const typed1 = pick('ui', 'A:s1.type')?.result
  const clicked1 = pick('ui', 'A:s1.send')?.result
  check(
    typed1 === 'typed' && clicked1 === 'clicked' ? 'ok' : 'bad',
    `界面驱动：写进输入框 = ${String(typed1)}（\`mismatch\` 意味着 React 没收到 onChange —— 见 HELPERS 第 2 条），` +
      `点到「发送」= ${String(clicked1)}`
  )

  const st1 = statusesOf('A', turn1)
  const seq1 = st1.map((s) => s.status)
  check(
    seq1.includes('queued') && seq1.includes('running') ? 'ok' : 'bad',
    `★ \`stream:status\` 推送依次到达：${seq1.join(' → ') || '（一条都没有）'} —— ` +
      '这条通道在 M6a 之前是个**死通道**（有 schema、有白名单、零生产者），M6b 补上了生产者，' +
      '这是它第一次被走查真的用上（连 turnId 都是从它里面认出来的）'
  )
  const s1terminal = st1.find((s) => s.status !== 'queued' && s.status !== 'running')
  check(
    s1terminal !== undefined ? 'ok' : 'bad',
    `终态推送到达：${s1terminal?.status ?? '（没有）'}${s1terminal?.reason ? `/${s1terminal.reason}` : ''}`
  )

  const b1 = batchesOf('A', turn1)
  const f1 = framesOf('A', turn1)
  const text1 = textOf(b1)
  check(b1.length >= 2 ? 'ok' : 'bad', `\`stream:batch\` 到达 ${b1.length} 批（≥2 才算「流式」而不是一次性）`)
  const have1 = f1.length > 0
  if (!have1) check('bad', '一条帧都没收到 —— 流式管道没通')
  const kinds = new Map<string, number>()
  for (const f of f1) kinds.set(f.k, (kinds.get(f.k) ?? 0) + 1)
  say(`  帧的种类        ${[...kinds].map(([k, v]) => `${k}×${v}`).join('  ') || '（无）'}`)

  const probe1 = probeOf('A:s1.live')
  if (!probe1) {
    check('unknown', '归档里没有场景 1 的界面探针 —— 采集没走到观察那一步')
  } else {
    /**
     * ★★ 本走查最要紧的一条：**界面上那一段正文与帧拼出来的正文逐字相同**。
     *
     * 取的是「光标刚撤、卡片还在」那一刻的 DOM（见 `watchTurn`）——
     * 那个时刻正文已经完整（`done` 已到），而缓冲还没被丢掉。
     * 它同时钉住两件事：正文逐字送达，以及**光标语义**（说完了就停）。
     *
     * ★ 它**已经抓到过一个真的缺陷**：第一次真机跑出来是「DOM 45 字 / 帧 66 字」，
     * 缺的正是模型说的第一句。根因在渲染层 `applyBatch` 的纪元那一支 ——
     * 「纪元变了」顺手把**这一批**的帧也丢了，而进程启动后的第一批帧恰好永远走那一支。
     * 修法与它为什么不能揉成一句话，见 `watermark.ts` 的 `planBatch` 与 `§8.8f`。
     * 换句话说：这条断言就是那个缺陷的回归测试，**而且它是唯一能抓到它的地方**
     * （`live` slice 引不到裸 Node 里，见 `test/shared/` 那三个文件的分工）。
     */
    /**
     * ★ 取哪一个 DOM 读数，取决于观察是怎么结束的：
     *
     * - `cursor-gone`：抓到「光标刚撤、卡片还在」那个窗口 → `textAtDone`，
     *   它是**定义上**完整的（`done` 已到、缓冲未丢）；
     * - `done-frame`：没等到光标（整段正文与 `done` 落在同一批里，光标活不过一拍）→
     *   退回 `bestText`，也就是观察窗口里最长的那一次。它**同样是完整的那一份**：
     *   `done` 是这一轮的最后一帧，之后不会再有正文（`watchTurn` 在那条路上还会多等一拍）。
     */
    const observed1 = probe1.textAtDone ?? probe1.bestText
    check(
      observed1 === '' ? 'unknown' : observed1 === text1 ? 'ok' : 'bad',
      `★★ DOM 里那一段正文与帧拼出来的**逐字相同**（DOM ${observed1.length} 字 / 帧 ${text1.length} 字；` +
        `取的是${probe1.textAtDone !== null ? '「光标刚撤、卡片还在」那一刻' : '观察窗口里最长的那一次（没等到光标）'}）` +
        (observed1 !== '' && observed1 !== text1
          ? `\n      DOM：${quote(observed1, 140)}\n      帧： ${quote(text1, 140)}`
          : '') +
        `\n      观察结束于 ${probe1.endedBy}，历时 ${Math.round(probe1.ms / 1000)}s`
    )
    /**
     * ★ 三态。光标**活在两批帧之间**：它在 `done` 帧到档的那一刻撤下，而这一轮的整段正文
     * 有可能和 `done` 落在**同一瞬** —— 那时它存在的时间短于一次轮询（`POLL_MS`），
     * 没看到它就只是没抽中，不是它没出现。
     *
     * ⚠️ 判据第一版数的是「带正文的批次有几批」，**数错了**：这个端点上正文恰好来了 2 批
     * （29 字 + 16 字），看着像「流了挺久」，可两批的 `t` 都是 6671、`done` 是 6672 ——
     * 整段正文和 `done` 相隔 **1 ms**。于是它把「量不出来」判成了「光标没在工作」，
     * 一条 ❌ 就这样凭空长了出来（§8.8e 规则三：测不到的东西不许说成测出来是坏的）。
     *
     * 真正决定「量不量得到」的是**时间**，不是批数：从第一个带正文的批次到 `done`
     * 那一批之间有多宽。窄于一次轮询 → 这一条在本端点上限定了量不出来。
     */
    const textBatchT = b1
      .filter((b) => b.frames.some((f) => f.k === 'text' && String(f.d).length > 0))
      .map((b) => b.t)
    const doneBatchT = b1.filter((b) => b.frames.some((f) => f.k === 'done')).map((b) => b.t)
    const cursorWindowMs =
      textBatchT.length > 0 && doneBatchT.length > 0 ? Math.max(0, doneBatchT[0] - textBatchT[0]) : null
    check(
      probe1.sawCursor ? 'ok' : cursorWindowMs === null ? 'unknown' : cursorWindowMs < POLL_MS ? 'unknown' : 'bad',
      probe1.sawCursor
        ? '流式期间 `.typing-cursor` 出现过 —— 光标就是「还在流」这件事在界面上的表现'
        : cursorWindowMs === null
          ? '流式期间没看到光标，而这一轮**没有**可用来算窗口的正文批次或 `done` 批次 —— 这一条没测到'
          : cursorWindowMs < POLL_MS
            ? `流式期间没看到光标，但**正文的第一批与 \`done\` 只隔 ${cursorWindowMs}ms**` +
              `（正文共 ${textBatchT.length} 批，全挤在这一瞬里）—— 光标活不过一拍 ` +
              `${POLL_MS}ms 的轮询，这一条在本端点上限定了量不出来，不算坏`
            : `流式期间 \`.typing-cursor\` 一次都没出现过，而正文从第一批到 \`done\` 隔了 ` +
              `${cursorWindowMs}ms（${textBatchT.length} 批，够轮询好几拍）—— 光标没在工作`
    )
    check(
      probe1.textAtDone === null ? 'unknown' : 'ok',
      '★ 光标在 `done` 到达时**撤掉**了（观察正是在「光标撤了、卡片还在」那一刻结束的 —— ' +
        '那个窗口只有 ~250ms，抓到它本身就是证据）'
    )

    // 思考面板：可折叠 + 真有内容
    check(
      probe1.bestThinking.length > 0 ? 'ok' : 'unknown',
      `思考面板点开后**有正文**：${probe1.bestThinking.length} 字 —— ${quote(probe1.bestThinking, 120)}` +
        '（本端点每条 assistant 消息都带 thinking 块；换了端点没有思考也不该算坏，见 §2.4-1）'
    )
    /**
     * ★ 折叠这件事在走查里是**被真的做了**的：`liveThinking()` 在面板合着时才点它，
     * 而它在 `thinking_end` 之后必然是合着的。所以「拿到正文」本身就证明了
     * 「收起的面板点得开」。
     */
    check(
      probe1.bestThinking.length > 0 ? 'ok' : 'unknown',
      '★ 「可折叠」是**真的被点过**的：思考面板在 `thinking_end` 后自动收起，' +
        '拿到上面的正文只能靠把它点开（`liveThinking()` 只在合着时点）'
    )

    // 工具时间线**有序**
    const card = probe1.bestCard
    const iRead = card.indexOf('Read')
    const iEdit = card.indexOf('Edit')
    check(
      iRead >= 0 && iEdit >= 0 && iRead < iEdit ? 'ok' : 'bad',
      `工具时间线**按发生顺序**：Read 排在 ${iRead}、Edit 排在 ${iEdit}（前者必须在前）` +
        (iRead < 0 || iEdit < 0 ? ' —— 有一个压根没出现在卡片里' : '')
    )

    // diff 内容
    const hasMinus = card.includes('-export const x = 1')
    const hasPlus = card.includes('+export const x = 2')
    check(
      hasMinus && hasPlus ? 'ok' : 'bad',
      '★ diff 块里就是那次 Edit（一行走、一行来）'
    )
    check(!card.includes('@@') ? 'ok' : 'bad', 'diff 里没有行号 —— 位置未知，不许用数字盖住')
    say(`  在途卡片全文    ${quote(card, 240)}`)
  }

  // 30Hz 隔离
  const mut1 = mutOf('A:s1.stream')
  if (!mut1) {
    check('unknown', '归档里没有 DOM 改写计数 —— 采集没走到测量那一步')
  } else {
    check(
      mut1.live > 0 ? 'ok' : 'bad',
      `流式期间**在途卡片**被改写 ${mut1.live} 次（这证明观察真的覆盖了流式过程）`
    )
    /**
     * ★★ 这条断言是 §4.7 规则 1 在**真机**上的唯一直接证据。
     *
     * 它说的是：整段流式期间，**已经落定的那些卡片**与**消息列表本身**在 DOM 上
     * 一个字节都没被改写。如果 `<MessageList>` 订阅到了缓冲上，它就会随每个 delta
     * 重建整张列表，而重建出来的东西**输出相同** —— 那种重渲染在 DOM 上零痕迹，
     * 本观测看不到。所以这一条是**必要条件、不是充分条件**；
     * 充分的那一半在 `npm test` 里（`MessageList` 从不订阅 `buffers`，
     * `streamingTurnIds` 只在轮次起止换引用）。两半合起来才是一句完整的话。
     */
    check(
      mut1.history === 0 && mut1.list === 0 ? 'ok' : 'bad',
      `★★ 流式期间**已落定的卡片零改写**（${mut1.history} 次）、**消息列表本身零改写**` +
        `（${mut1.list} 次 —— 这一桶连用户气泡那种 \`div\` 也算进来）` +
        '\n      必要而非充分：输出相同的重渲染在 DOM 上零痕迹，充分的那一半在 `npm test` 里' +
        `\n      在途卡片被改写 ${mut1.live} 次、界面其余部分（顶栏概要/成本、侧栏未读）${mut1.chrome} 次 —— 这两处就该刷` +
        `\n      ${Object.entries(mut1.byTarget).map(([k, v]) => `${k}×${v}`).join('  ')}`
    )
  }

  const dbA1 = dumpOf('A', 'after-s1')
  const row1 = (dbA1?.turn ?? []).find((t) => t.id === turn1)
  check(
    row1?.status === 'done' && row1?.terminal_reason === 'complete' ? 'ok' : 'bad',
    `库里的轮次行：status=${String(row1?.status)} terminal_reason=${String(row1?.terminal_reason)}`
  )
  const msg1 = (dbA1?.message ?? []).find((m) => m.turn_id === turn1)
  const dbText1 = String(msg1?.content_text ?? '')
  check(
    dbText1 === text1 && text1 !== '' ? 'ok' : text1 === '' ? 'unknown' : 'bad',
    `★ 落库正文与流式帧**逐字同源**（帧 ${text1.length} 字 / 库 ${dbText1.length} 字）`
  )
  const endedStatus = String(s1terminal?.status ?? '')
  check(
    endedStatus === '' || row1 === undefined
      ? 'unknown'
      : (endedStatus === 'done') === (row1?.status === 'done')
        ? 'ok'
        : 'bad',
    `★ 终态推送与库里的那一行**说的是同一件事**（推送 ${endedStatus} / 库 ${String(row1?.status)}）`
  )
  const fileAfter = String(pick('note', 'A:s1.fileAfter')?.text ?? '')
  check(
    fileAfter.includes('export const x = 2') ? 'ok' : 'bad',
    `★ 磁盘侧：沙箱里的 a.ts 真的被改了 —— 只看 diff 帧是不够的，盘上那个文件才是结果`
  )

  // ══ 场景 3 ═════════════════════════════════════════════════
  rule('场景 3 · 切走抑制与切回重放（界面侧）')
  const away = pick('mark', 'A:s2.away')
  const back = pick('mark', 'A:s2.back')
  const awayT = Number(away?.t ?? 0)
  const backT = Number(back?.t ?? Number.MAX_SAFE_INTEGER)
  const b2 = batchesOf('A', turn2)
  const graceEnd = awayT + VIEW_SWITCH_GRACE_MS
  const leaked = b2.filter((b) => b.t > graceEnd && b.t < backT)

  check(
    String(away?.clicked) === 'clicked' && String(back?.clicked) === 'clicked' ? 'ok' : 'bad',
    `界面驱动：点到 Vega = ${String(away?.clicked)}，点回 Nova = ${String(back?.clicked)}`
  )
  const novaUnread = recs.filter(
    (r) =>
      r.kind === 'unread' &&
      (r.payload as { count: number }).count > 0 &&
      (r.payload as { workspaceId: string }).workspaceId === String(ids.nova?.id ?? '') &&
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

  /**
   * ★ 切走期间产出了多少 —— 这个数**只能从库里读**（抑制掉的帧一条都不推送），
   * 所以它同时是「未读那条的正证据」的量化版：不是「角标闪了一下」，
   * 而是「这段时间库里多了 N 条事件行，我们一条都没收到」。
   */
  const awayEnd = pick('mark', 'A:s2.awayEnd')
  const produced = Number(awayEnd?.producedWhileAway ?? -1)
  const producedText = Number(awayEnd?.textWhileAway ?? -1)
  check(
    produced < 0 ? 'unknown' : produced > 0 ? 'ok' : 'bad',
    produced < 0
      ? '切走期间产出了多少事件行 —— **读不到了**（库打不开），这一条没测到'
      : `★ 切走期间库里多了 ${produced} 条事件行（${String(awayEnd?.eventsBefore)} → ${String(awayEnd?.eventsAfter)}），` +
        `其中正文 ${producedText} 条 —— 而同一个窗口里我们收到的该轮次批次是 0 批 ` +
        `（收手判据是「${String(awayEnd?.endedBy)}」：终态先到就早回，正文落库且满了最短时间也回，` +
        '最多待久了兜底，免得那一轮跑完、缓冲被终态推送丢掉，那个瞬间就再也抢不到了）'
  )

  /**
   * ★★ 「重放补上了我们从未见过的那一段」—— 这是本走查里最精确的一条断言，
   * 而它的判据是**一个瞬间**：界面上的正文比我们收到过的全部推送更长。
   *
   * ## 为什么不能用「最终 DOM」
   *
   * 第一版就是在这一轮结束之后去量 DOM 的，而那条断言**证明不了任何东西**：
   * 那一轮跑完之后界面显示的是**历史行**，而历史行的正文来自库里的 `content_text`
   * —— 它本来就是完整的，重放有没有生效它都长那样。切走期间被抑制的帧，
   * 反倒在被抑制之前就已经折进 `content_text` 了。
   *
   * ## 为什么「界面 > 推送」这一个不等式就够了
   *
   * 推送只会让正文变长，**永远不会让它超出自己**。所以某个瞬间只要界面比推送长，
   * 多出来的那一段就不可能来自推送。它也不可能是历史行：这一刻这一轮还在跑，
   * 而 `buildTimeline` 会压着有缓冲的轮次的历史行（§4.7 规则 7）。
   * 剩下唯一的来源是 `stream:resume` 的返回 —— 那是一次 invoke，不是推送。
   *
   * ⚠️ 采样窗口只有 4s，而这个端点上推送是 33ms 一拍：能不能抢到那个空档不由我们说了算。
   * **抢不到不等于没重放**，只等于这一条没测到 —— 所以是三态，不是是非。
   * （采集那侧两个值是在**同一个 tick** 里取的，见页面上 `sync()` 的注释。）
   */
  const sync = pick('mark', 'A:s2.sync')
  const cardsPresent = Number(sync?.cardsPresent ?? -1)
  const best = (sync?.best ?? null) as
    | { delta: number; textLen: number; pushLen: number; batches: number }
    | null
  check(
    best === null
      ? 'unknown'
      : best.pushLen === 0
        ? 'unknown'
        : best.delta > 0
          ? 'ok'
          : 'bad',
    best === null
      ? cardsPresent === 0
        ? '切回之后界面正文与「收到过的推送」的比较 —— **这一条没测到**：' +
          `${String(sync?.samples)} 个样本里那张卡片一次都不在（这一轮在我们切回来之前就收了尾，` +
          '缓冲随之被终态推送丢掉），要抢的那个瞬间已经过去了'
        : '切回之后界面正文与「收到过的推送」的比较 —— 一个样本都没取到，这一条没测到'
      : best.pushLen === 0
        ? '切回之后界面正文与「收到过的推送」的比较 —— 我们这一轮一帧推送都没收到过，比不了'
        : best.delta > 0
          ? `★★ 切回之后抢到了那个瞬间：界面上的正文 ${best.textLen} 字，而我们收到过的推送一共 ${best.pushLen} 字` +
            ` ——**多出 ${best.delta} 字**，它只可能来自重放（此时该轮还在跑，历史行被压着）`
          : `切回之后 ${String(sync?.samples)} 个样本里（卡片在场 ${String(cardsPresent)} 次），` +
            `界面正文始终**没有**超过收到过的推送（最好的一次 ${best.textLen} 对 ${best.pushLen}，差 ${best.delta} 字）` +
            '—— 按「推送只会让正文变长、永远不会让它超出自己」这条不变式，多出来的那段只可能来自重放，' +
            '而这里一次都没多出来'
  )
  /**
   * ★ 三态，因为「切回之后没有再收到批次」有**两种**成因，而它们该被说成两句不同的话：
   *
   * - 这一轮在我们切回来之前就把话都说完了（终态推送已在档）→ 没有帧可推，**没测到**；
   * - 这一轮还在跑却一帧都不推 → 那才是「实时推送坏了」。
   *
   * 合并成一句就是拿测不到的东西当测出来是坏的（§8.8e 规则三）。
   * 另一头同样不能含糊：`live > 0` 时若我们提前收的手（终态还没到）而它已经推了一批，
   * 那就是干净的 `ok`。
   */
  const liveBack = pick('mark', 'A:s2.liveAfterBack')
  const liveCount = Number(liveBack?.live ?? -1)
  const terminalAtBack = liveBack?.terminalSeen === true
  check(
    liveCount < 0
      ? 'unknown'
      : liveCount > 0
        ? 'ok'
        : terminalAtBack
          ? 'unknown'
          : 'bad',
    liveCount > 0
      ? `切回之后实时推送恢复：又收到了该轮次的 ${liveCount} 批`
      : terminalAtBack
        ? '切回之后实时推送 —— **这一条没测到**：这一轮在我们切回来之前就把帧产完了' +
          '（终态推送已在档，之后再没有任何帧会来）。不是推送坏了，是窗口没排下'
        : '切回之后一帧都没再收到，而这一轮**当时还在跑** —— 实时推送没有恢复'
  )
  const row2 = (dumpOf('A', 'after-s2')?.turn ?? []).find((t) => t.id === turn2)
  /**
   * ★ 轮次 2 的终态按三种情形判，因为**预算闸也是一条合法的出路**：
   * `--max-budget-usd 0.50` 真的踩到时，`status` 是 `failed` + `terminal_reason=budget`
   * —— 那是闸门在正常工作，不是缺陷。
   */
  const r2status = String(row2?.status ?? '')
  const r2reason = String(row2?.terminal_reason ?? '')
  check(
    r2status === 'done' ? 'ok' : r2reason === 'budget' ? 'unknown' : 'bad',
    `轮次 2 的终态：${r2status || '（无行）'}${r2reason ? `/${r2reason}` : ''} —— **切走不影响它跑完**` +
      `（被抑制的只是推送）${r2reason === 'budget' ? '；且它撞上了预算闸，那是闸门在干活' : ''}`
  )
  const postBack = String(pick('note', 'A:s2.probe')?.text ?? '{}')
  say(`  切回后的观察      ${postBack}`)

  // ══ 场景 4 ═════════════════════════════════════════════════
  rule('场景 4 · 硬杀重开：历史完整重放（含思考 / 工具 / diff）')
  const cardsB = pick('note', 'B:s4.cards')?.text as string | undefined
  const cardsObj = (() => {
    try {
      return JSON.parse(String(cardsB ?? '{}')) as { live?: number; done?: number }
    } catch {
      return null
    }
  })()
  check(
    cardsObj === null
      ? 'unknown'
      : cardsObj.live === 0 && (cardsObj.done ?? 0) > 0
        ? 'ok'
        : 'bad',
    `重开后**没有在途卡片**（live=${String(cardsObj?.live)}）而**已落定的有 ${String(cardsObj?.done)} 张** —— ` +
      '历史行自己接管了，重放与历史的重叠在界面上不成立'
  )

  const rowsBefore = histRowsOf('B:s4.history.before')
  const rowsAfter = histRowsOf('B:s4.history.after')
  const noteAfter = pick('note', 'B:s4.history.after')
  const openResult = String(noteAfter?.openResult ?? '')
  const openIndex = Number(noteAfter?.openIndex ?? -1)
  /**
   * ★ 判据取的是**两份快照的差**（点开前 vs 睡过一觉之后），不是采集那一拍回读到的字符串。
   *
   * 为什么：`.click()` 同步派发，React 在那一拍**之后**才提交，所以在函数体里立刻回读 DOM
   * 必然读到点击前的样子 —— 一次真机跑就撞上了：`stateAtClick` 回 `still-closed`，
   * 而 200ms 之后那条历史行开着、里面 23 个字。拿点击当拍的那个字符串做判据，
   * 就会把一次**成功**的点开说成「点不开」（§8.8e 规则三的反面：这不是测不到，
   * 是**量错了时刻**）。
   */
  const beforeRow = openIndex >= 0 ? (rowsBefore?.[openIndex] ?? null) : null
  const afterRow = openIndex >= 0 ? (rowsAfter?.[openIndex] ?? null) : null
  check(
    openIndex < 0
      ? 'unknown'
      : beforeRow === null || afterRow === null
        ? 'unknown'
        : !beforeRow.thinkingOpen && afterRow.thinkingOpen
          ? 'ok'
          : 'bad',
    openIndex < 0
      ? '历史行的思考面板**能点开** —— 一条有思考按钮的历史行都没有，这一条没测到'
      : `历史行的思考面板**能点开**（第 ${String(openIndex)} 条：点开前 ${beforeRow?.thinkingOpen ? '已展开' : '收着'}` +
        ` → 睡过一觉之后 ${afterRow?.thinkingOpen ? '展开了' : '还收着'}；` +
        `采集当拍回读到的是 \`${openResult || '（没记到）'}\`，那个读数**不作数**，` +
        'React 是点击之后才提交的）。靶子是「第一条**真的有**思考按钮的行」，不是写死的第 0 条 —— ' +
        '有没有按钮取决于库里那一轮落没落 `thinking` 事件，那是端点的行为，不是界面的行为'
  )
  /**
   * ★ 「历史里没有 `thinking_end`」——这条在界面上表现为**初值必然是收起的**。
   * 它是 `history.ts` 那处有损之处的**可见形态**，所以要在这里如实指出它，
   * 而不是假装历史与实时长得一模一样。
   */
  check(
    rowsBefore === null
      ? 'unknown'
      : rowsBefore.every((r) => !r.thinkingOpen) && rowsBefore.some((r) => r.hasThinkingButton)
        ? 'ok'
        : 'bad',
    `★ 历史行的思考面板**初值是收起的**（${String(rowsBefore?.filter((r) => r.hasThinkingButton).length)} 条有按钮，` +
      '没有一个默认展开）—— 历史里没有 `thinking_end` 这个事实，所以「展开过」这件事推不出来'
  )

  const liveThinkingLen = probeOf('A:s1.live')?.bestThinking.length ?? 0
  /**
   * ⚠️ 取的是**被点开的那一条**，不是第 0 条 —— 两者在本端点上不是同一行
   * （第 0 条 = 轮次 1，库里一条 `thinking` 事件都没有；有思考的是轮次 2）。
   */
  const thinkRow = openIndex >= 0 ? (rowsAfter?.[openIndex] ?? null) : null
  const histThinking = thinkRow?.thinkingText ?? ''
  /**
   * ★ 「历史里的思考 ⊇ 流式期间看到的思考」。
   *
   * 判据是 `>=` 而不是 `==`：流式期间我们看到的思考取决于**轮询恰好落在哪几拍**上，
   * 而历史折的是全部事件行。所以历史只会更长或相等，**绝不会更短** ——
   * 更短就说明历史那边漏了东西（那才是缺陷）。
   *
   * ⚠️ 另一头也不能张冠李戴：`liveThinkingLen` 是**轮次 1** 流式期间看到的
   * （场景 1 盯的是第一轮），而这里展开的是**有思考的那一行**。两者不是同一轮时，
   * 这个 `>=` 比的就不是同一个东西，只能算「没测到」。本端点上轮次 1 的思考
   * 流式期间是 0 字，所以它恰好退化成 unknown —— 而不是一个假的 ✅。
   */
  let thinkLevel: 'ok' | 'bad' | 'unknown' = 'unknown'
  if (liveThinkingLen > 0 && openIndex === 0) {
    thinkLevel = histThinking.length >= liveThinkingLen ? 'ok' : 'bad'
  }
  check(
    thinkLevel,
    `历史里展开出来的思考 ${histThinking.length} 字（第 ${String(openIndex)} 条）` +
      ` ⊇ 流式期间看到的 ${liveThinkingLen || '?'} 字 —— ` +
      (openIndex === 0
        ? '同源（两者都折自同一批 `message_event` 行；流式那侧受轮询节拍影响只会更短）'
        : `比的不是同一轮（流式那一边盯的是轮次 1，而第 0 条就是轮次 1 且库里没有 \`thinking\` 事件）—— ` +
          '这一条只在两边同轮时才成立，所以按没测到算')
  )
  const histText = rowsAfter?.[0]?.text ?? ''
  check(
    histText.includes('Read') && histText.includes('Edit') ? 'ok' : 'bad',
    '历史行里有工具调用（Read / Edit）—— 重放的不只是正文'
  )
  check(
    histText.includes('+export const x = 2') && !histText.includes('@@') ? 'ok' : 'bad',
    '历史行里有 diff（含那一行新增、且没有行号）'
  )
  check(
    text1 !== '' && histText.includes(text1) ? 'ok' : 'unknown',
    '★ 历史行的正文里含**完整的那一段流式正文**（逐字）—— 硬杀没让它少一个字'
  )
  say(`  历史第 0 条    ${quote(histText, 300)}`)

  const dbB = dumpOf('B', 'after-reopen')
  const persistedKinds = new Set((dbB?.message_event ?? []).map((e) => String(e.kind)))
  check(
    dbB === undefined ? 'unknown' : !persistedKinds.has('thinking_end') ? 'ok' : 'bad',
    `\`thinking_end\` **没有**落库（§8.5a：线上 9 项 / 可持久化 8 项；` +
      `库里实际出现的类型：${[...persistedKinds].sort().join(' / ') || '（没有事件行）'}）`
  )
  const t1RowB = (dbB?.turn ?? []).find((t) => t.id === turn1)
  check(
    t1RowB?.status === 'done' ? 'ok' : 'bad',
    `轮次 1 在库里仍是 done（硬杀没把它变成 running/failed）；实测 ${String(t1RowB?.status)}`
  )
  const ghosts = dbB ? (dbB.turn ?? []).filter((t) => t.status === 'running' || t.status === 'queued') : null
  check(
    ghosts === null ? 'unknown' : ghosts.length === 0 ? 'ok' : 'bad',
    `库里没有 \`running\`/\`queued\` 的幽灵行（${ghosts === null ? '没有库转储可判' : `实测 ${ghosts.length} 条`}）`
  )

  // ══ 场景 5 ═════════════════════════════════════════════════
  rule('场景 5 · 成本常驻显示（标注「估算」，空缺不许冒充成 0）')
  const usageEarly = String(pick('note', 'A:usage.overview')?.text ?? '')
  const usageTitleEarly = String(pick('note', 'A:usage.overview')?.title ?? '')
  check(
    usageEarly.includes('估算') && /\$\d/.test(usageEarly) ? 'ok' : 'bad',
    `★ **概览屏上**就看得见成本：${quote(usageEarly, 60)} —— §5.4 要的是「常驻」，` +
      '而常驻的意思就是「不只在对话屏上有」'
  )
  /**
   * 措辞纪律（§2.4-2）：走第三方端点时 `result.total_cost_usd` 的数值是错的，
   * 所以这个数只能叫**估算**，而且 `title` 里要说清它按什么算、不是什么。
   * 一个看起来像账单的数字会被当成账单用。
   */
  check(
    usageTitleEarly.includes('估算') && usageTitleEarly.includes('不是实际账单')
      ? 'ok'
      : usageTitleEarly === ''
        ? 'unknown'
        : 'bad',
    `★ 口径写在 \`title\` 里：${quote(usageTitleEarly, 160)}`
  )
  check(
    usageTitleEarly.includes('Anthropic') ? 'ok' : 'unknown',
    '`title` 里说明了这个数**是按 Anthropic 官方价目算的** —— 那正是它在此端点上不可信的原因'
  )
  /**
   * ★ M6a 之前 `TopBar` 上那一排数字是**编出来的**（M0 留下的占位符：
   * 假 token 数、假金额、假缓存命中率）。这条断言钉住「它连着真的聚合」——
   * 数字必须是那个 `workspace:usage` 读出来的数，而不是印刷体。
   */
  check(
    /入 \d+/.test(usageTitleEarly) && /出 \d+/.test(usageTitleEarly) ? 'ok' : 'bad',
    `★ 累计 token 是**真读出来的**（\`title\` 里带着「入 N / 出 N token」）：${quote(usageTitleEarly, 90)}`
  )

  const usage = ipcData<{
    turnCount: number
    costUsd: number
    tokensIn: number
    tokensOut: number
    turnsWithoutUsage: number
  }>('B:s5.usage')
  const usageB = String(pick('note', 'B:usage')?.text ?? '')
  check(
    usage === undefined ? 'unknown' : usageB.includes('估算') ? 'ok' : 'bad',
    `重开之后成本还在：${quote(usageB, 60)}（它不随进程消失 —— 那是**库里**的数，不是内存里的）`
  )
  if (usage === undefined) {
    check('unknown', '`workspace:usage` 没调成 —— 这个数只有库能判')
  } else {
    say(
      `  workspace:usage   ${usage.turnCount} 轮 / 入 ${usage.tokensIn} / 出 ${usage.tokensOut} / ` +
        `估算 $${usage.costUsd} / 无用量 ${usage.turnsWithoutUsage} 轮`
    )
    /**
     * ★ `SUM` 会**安静地跳过 `NULL`**，所以「求和」不等于「答案完整」。
     * `turnsWithoutUsage` 就是那只报信的字段：它非零时界面必须露出来，
     * 否则用户拿到一个偏低的数字而**无从知道**（§4.6a 规则二的另一面：空缺不许冒充成 0）。
     */
    const dbB2 = dumpOf('B', 'after-reopen')
    const turnsInDb = dbB2 ? (dbB2.turn ?? []).filter((t) => t.workspace_id === ids.nova?.id) : null
    const expectNoUsage = turnsInDb?.filter((t) => t.cost_usd === null).length ?? null
    check(
      expectNoUsage === null ? 'unknown' : expectNoUsage === usage.turnsWithoutUsage ? 'ok' : 'bad',
      `★ \`turnsWithoutUsage=${usage.turnsWithoutUsage}\` 与库里 \`cost_usd IS NULL\` 的轮次数一致` +
        `（${expectNoUsage === null ? '没有库转储可判' : `实测 ${expectNoUsage}`}）—— ` +
        '它非零就说明上面那个金额**偏低**，而界面必须在数字旁边把这件事说出来'
    )
    check(
      usage.turnsWithoutUsage > 0
        ? usageB.includes('⚠')
          ? 'ok'
          : 'bad'
        : !usageB.includes('⚠')
          ? 'ok'
          : 'bad',
      usage.turnsWithoutUsage > 0
        ? `★ 界面露出来了那个警告（\`⚠${usage.turnsWithoutUsage}\`）：${quote(usageB, 60)}`
        : '没有无用量的轮次，所以界面上**不该**有那个警告 —— 实测没有'
    )
    check(
      usage.turnCount >= 2 ? 'ok' : 'bad',
      `聚合的轮次数 ${usage.turnCount}（≥2：这一趟真跑了两轮）`
    )
  }

  const graceful = String(pick('note', 'B:graceful-exit')?.text) === 'true'
  check(
    graceful ? 'ok' : 'unknown',
    graceful
      ? '第 2 个实例是**正常退出**的（`will-quit` → 合批器冲空 → 关库）'
      : '第 2 个实例没能正常退出，所以「退出时冲空脏缓冲」那条路径**这次没被覆盖**'
  )

  // ══ 旁证 ═══════════════════════════════════════════════════
  rule('旁证：界面上看到了什么（**不是断言**）')
  for (const d of recs.filter((r) => r.kind === 'dom')) {
    say(`  [${String(d.tag)}] ${quote(String(d.text), 300)}`)
  }
  const notices = recs.filter((r) => r.kind === 'notice')
  if (notices.length > 0) {
    say(`  ⚠️ 界面推了 ${notices.length} 条通知（**故意不断言**：通知的到达时机取决于`)
    say('     React 挂载与 CDP 连接的先后，是个真实的竞态——只把它列出来给人看）：')
    for (const n of notices) say(`     ${quote(JSON.stringify(n.payload), 160)}`)
  }

  rule('结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '全部通过' : `${failures} 条不通过`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  say('  ⚠️ 端点限定语：全部结论只在**本机默认凭据所指向的端点**下成立，不是 Anthropic 官方行为。')
  say('  ⚠️ 「已落定卡片零改写」是**必要条件**：输出相同的重渲染在 DOM 上零痕迹。')
  say('     充分的那一半在 `npm test`（`MessageList` 从不订阅 `buffers`）。两半合起来才是完整的一句。')
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
        '    npm run walk:m6b:replay -- --archive=scripts/evidence/m6b-<时间戳>\n' +
        '故意不带默认值 —— 这个命令**不该**在忘了参数的时候顺手跑一次真采集（那会花钱）。\n'
    )
    return finish(1)
  }
  if (archive) {
    loadArchive(archive)
    rule('M6b 走查 · 重放归档（零成本）')
    return finish(report() === 0 ? 0 : 1)
  }

  const dir = argValue('out') ?? join(EVIDENCE_ROOT, `m6b-${stamp()}`)
  rule('M6b 走查 · 采集')
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
