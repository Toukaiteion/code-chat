/**
 * M7c 实机走查 —— 历史压缩：阈值 → 确定性摘要 → 落库 → **下一轮的装配**。
 *
 *     npm run walk:m7c:dry                                          # ★ 先跑这个（零成本）
 *     npm run walk:m7c                                              # 真机（真花钱：3 轮）
 *     npm run walk:m7c:replay -- --archive=scripts/evidence/m7c-…    # 重放（零成本）
 *     ⚠️ `walk:m7c:replay` 忘了 `--archive` 时**直接报错退出**，不会顺手采集一次。
 *        理由逐字抄 M6b / M7b：一个叫 replay 的命令在打错字时花钱，是这把枪自己走火。
 *
 * ## 它要回答的唯一问题
 *
 * M7a 让第二轮记得第一轮，M7b 让成员之间能接力，而 **M7c 是「历史太长时怎么办」**。
 * 这一块的产物有**两半，必须分别取证**：
 *
 * | 那一半 | 在哪看得见 | 本走查的判据 |
 * |---|---|---|
 * | 判决与落库 | **库**（`session.compacted_through_seq` / `rolling_summary` / `message.inject_mode`） | `db-A-t2.json` 等四份转储 |
 * | 「压缩真的生效了」 | **下一轮的装配数组**（界面上、库里都看不见） | `[ctx]` 行里的 `shape.summaryChars` 与 `historyIncluded` |
 *
 * ★ 只取其中一半是不够的，而缺哪一半都不报错：
 * 库里水位线推了、摘要写了，但装配没读它 ⇒ 界面上一切正常，模型却还在读全部历史；
 * 装配读了、库里没写 ⇒ 这一轮好、下一轮水位线又回到 0（同一段历史被折两次）。
 * 所以下面**两条判据成对出现**，缺一条就把那一条如实降级成 `⚠️ 无法判定`。
 *
 * ## ★★ 预判：CLI 自己的压缩**预期一次都不出现**（先写下来，免得它变成结论）
 *
 * `claude` CLI 自己也会压上下文（`compact_boundary` / `compact_result`，见 §8.9-13）。
 * 而这一趟**不该**看见它，理由是算术的：我们设的阈值是 2 条消息，三轮里最多累积
 * 五六条；CLI 自己的阈值以**万级 token** 计。我们**永远先压**。
 *
 * ⇒ 报告里那一条是「**没观测到**」，不是「不存在」。**不许**为了让 `compact_result`
 * 露面去调参数（把 `CODE_CHAT_COMPACTION_N` 调大、或者把三轮拉长到几十轮）——
 * 那会把一条诚实的结论换成一条**造出来的**（§8.8e 的核心纪律：缺证据不许印成 ✅，
 * 反过来也一样：**不许制造证据**）。真机实测结论要以 `--archive` 为准写进 §六。
 *
 * ## ★ env 旋钮：写进**本进程**，不是写进 spawn 的 env
 *
 * 阈值通道是 `CODE_CHAT_COMPACTION_N`（`main/index.ts` 读它 → `RuntimeOptions.compactionLimits`）。
 * 走查在 `prepareSandbox()` 里往 `process.env` 写一个**整数**，然后 `launch()` 照旧
 * **不传 `env`**（子进程原样继承）—— 于是：
 *
 * - `spawn(..., { cwd, stdio })` 那一行**一个字节都不用改**；
 * - 凭据仍然只经过子进程，**走查从不读它**；
 * - 写进环境的只有一个整数，落档的也只有那个整数。
 *
 * ★ 而**非法值**要出声（`compactionLimitsFromEnv` 的判决）：干跑刻意用 `abc`
 * 起一次，断言主进程 stderr 里出现 `[compaction]` 那行 ——
 * 这是零成本下唯一能证明「应用真的读了这个变量」的观测。有效值被采纳则是由
 * 真跑里「**两条就压了**」间接证明的：默认阈值是 20，三轮根本够不着。
 *
 * ## 台子与骨架
 *
 * CDP 客户端、spawn / 硬杀（**只按本脚本自己的 pid**）、归档写入、三态 `check`、
 * 报告只读归档、`finish()` 收摊、`REPLAY_ONLY && !archive` 那道守卫 ——
 * 全部逐字沿用 `m7b-walkthrough.ts`（那一套又是从 m7a / m6b / m6a 抄来的）。
 * 驱动方式照旧：**夹具走 IPC，被测动作走界面**（打字、点「发送」是真的 `click()`）。
 *
 * 场景只有一个：一个空间、**一个成员**、三轮。单成员是**刻意的** ——
 * `@` 扇出会往别的会话里派轮次，而本走查要数的是「这个会话里攒了几条历史」，
 * 多一条来源就多一个说不清的量。人设也刻意不提 `@`。
 *
 * ## 观测通道（三条，早已在别的走查里被证明存在）
 *
 * - **库转储** `db-A-<phase>.json` —— 水位线 / 摘要 / 逐条 `inject_mode` / 轮次与用量都在里面。
 *   报告因此可以**完全从归档重判**。
 * - **主进程 stdout 的 `[ctx] …`** —— 装配形状的**唯一**落档处（界面上看不见它）。
 * - **主进程 stderr 的 `[runtime:compaction:<tag>] …`** —— 压缩自己的判决日志
 *   （`decided` / `compacted` / `read-capped` / `cli-signal` …）。
 *   它是「判决真的发生了」的直接证据：单测只能证明那个函数返回了什么。
 *
 * ## 端点限定语（照 §六「M5 实证」的纪律，写最前面）
 *
 * 全部实测跑在**本机当前默认凭据所指向的端点**下（一个 Anthropic 兼容端点，模型名由
 * `--model` 给、默认 `deepseek-flash`，**不是 Anthropic 官方**）。
 * **凭据本身一律不读、不回显、不落档。**
 *
 * ★ 而这一趟的结论**比 M7b 的弱依赖模型**：压缩只由**我们自己的条数/字符估算**驱动，
 * 模型的输出只决定「正文有多长」。所以「压了没有」这件事与端点的行为**无关** ——
 * 换端点要重跑的只有标定映射表（shape ↔ usage）那一格。
 *
 * ## 为什么断言不许写在采集里（§8.8d 规则九）
 *
 * 采集（`collect()`）只做两件事：驱动真窗口、把**每一个可观测事实**写进归档。
 * **所有断言都在 `report()` / `reportDry()` 里，而它们只读归档。** 采集崩了也照样出报告。
 *
 * 归档里的五个部分：
 * - `events.jsonl` —— 全部事实（launch / status / batch / ui / probe / live / warn / db / ctx / notice …）
 * - `batches.jsonl` —— 只装推送载荷，逐字
 * - `db-A-<phase>.json` —— 库转储（`setup` / `t1` / `t2` / `final` 四个时点）
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
 * M7c 有自己的沙箱（`cc-m7c`），与 m6a / m6b / m7a / m7b 分开。
 */
const SAND = join(tmpdir(), 'cc-m7c')
const USERDATA = join(SAND, 'userdata')
const SRC = join(SAND, 'src-proj')
const PERSONA = join(SAND, 'persona.md')
const DB = join(USERDATA, 'code-chat.db')

const CDP_PORT = 9222
const CDP = `http://localhost:${CDP_PORT}`

/** 流式期间的轮询间隔。150ms ≈ 每 4~5 个合批周期看一眼。 */
const POLL_MS = 150

const MODEL = argValue('model') ?? process.env.CODE_CHAT_WALKTHROUGH_MODEL ?? 'deepseek-flash'

/**
 * 本趟要用的阈值。**2 是能工作的最小值**：低于 2 时「本轮之前」凑不出两条，
 * 压缩永远不会发生；高于 2 就要多跑几轮才跨得过去（多花钱）。
 *
 * ★ 它是**通过环境变量**进应用的（见文件头），而这个默认值刻意是 2 ——
 * 于是「真的压了」这件事在**三轮**里就成立。
 */
const N = Number(argValue('n') ?? '2')

/**
 * 干跑：**只开界面、不发轮次**。
 *
 * ★ M7c 的干跑里有一件事是真的取证：**它刻意用一个非法值起一次应用**，
 * 断言主进程为它出了一声（`[compaction]`）。这是零成本下唯一能证明
 * 「应用真的把这个变量读进去了」的观测 —— 有效值不产生任何输出，
 * 于是「设了有效值但没人读」与「设了有效值且被采纳」在干跑里长得一模一样。
 */
const DRY = process.argv.slice(2).includes('--dry')

/**
 * 「只重放，绝不采集」。没有 `--archive` 就直接退出 —— 理由见文件头。
 */
const REPLAY_ONLY = process.argv.slice(2).includes('--replay')

/**
 * ★ 本次运行的**标记后缀**。
 *
 * 它让三轮的正文**彼此不同、且本次运行独有**，于是报告里那条最要紧的判据
 * （「第二次压缩之后的摘要里**仍然**有第一段」）验的是**具体那一段**，
 * 而不是「摘要非空」这种谁也证明不了的弱命题。
 */
const NONCE = argValue('nonce') ?? Math.random().toString(36).slice(2, 6)

/**
 * 三轮的正文。它们必须：**不带 `@`**（免得触发扇出，见文件头）、**互不相同**、
 * 且**足够长**（一条骨架是「seq + 说话人 + 正文首段」，正文太短时信息量不够）。
 *
 * ★ 共用的那半句要求模型**不要用工具**：用了工具就多一个 `message_event`
 * 与一句「（工具：…）」后缀，摘要文本的形状就多一维，而这一趟要判的是水位线，不是工具。
 */
const BRIEF = '不要使用任何工具，不要寒暄，一两句话回复即可。'
const TEXT_T1 = `MK7C-${NONCE}-T1：${BRIEF}`
const TEXT_T2 = `MK7C-${NONCE}-T2：${BRIEF}`
const TEXT_T3 = `MK7C-${NONCE}-T3：${BRIEF}`

/**
 * 人设：**刻意不提 `@`**。
 *
 * 它的系统提示词里本来就有 `<collaboration>` 那段协议，所以「不需要别人接手时
 * 不要写那一行」这句话它看得见。这里不说别的，是为了让「这个会话的历史只由
 * 用户与这一个成员构成」成为一个**可控的前提** —— 一旦有 agent 之间的接力，
 * 别的会话里会多出轮次，而本走查要判的「攒了几条」就多了一个说不清的量。
 */
const PERSONA_TEXT = [
  '# 沙箱角色（单成员）',
  '',
  '你是一个测试角色。只做别人明确让你做的事，不寒暄、不额外发挥、不改无关文件。',
  '回复短一点，一两句话就够。'
].join('\n')

/** 沙箱项目里的文件。**内容不重要，作用是让 `<files>` 那一块非空**。 */
const SANDBOX_FILES: Record<string, string> = {
  'README.md': '# 沙箱项目\n\nM7c 走查用，随便改。\n',
  'src/index.ts': 'export const answer = 42\n'
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

/** `[ctx]` 行里的装配形状 —— 只抄报告要用的那几列（**不含任何正文**）。 */
interface ShapeLike {
  messageCount?: number
  contentChars?: number
  systemPromptChars?: number
  historyTotal?: number
  historyIncluded?: number
  historySuppressed?: number
  historyExcluded?: number
  compactedThroughSeq?: number
  summaryChars?: number
  projectFiles?: number
  personaBytes?: number | null
  roleDescBytes?: number | null
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
function recPush(
  kind: 'stream:batch' | 'stream:status' | 'workspace:unread',
  payload: unknown
): void {
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
 * ★★ 等**真的那份文档**，不是在等页面目标。
 *
 * 调试目标一出现就 `Runtime.evaluate`，有时会打在一个**尚未提交的**文档上：
 * 那一刻 `page.url` 已经是 `file:///…/index.html`（所以 `connectCdp` 那条 note 看着完全正常），
 * 但真正的加载还没 commit —— 往那个临时上下文里写 `window.__m7c`，
 * 提交时整份上下文被换掉，**写进去的东西一声不响地没了**。
 * 于是下一句 `window.__m7c.hook()` 报 `Cannot read properties of undefined`，
 * 而错误信息指向的是**调用点**，不是那次被吃掉的注入。
 *
 * ⇒ 判据是**文档真的提交并加载完了**：`readyState === 'complete'` 加上 preload 桥在位。
 * （临时文档的 `readyState` 是 `loading`，所以这两条合起来才排得掉它。）
 */
async function waitRealDocument(ms = 30000): Promise<boolean> {
  const ok = await waitUntil(
    '真文档 load 完（preload 桥在位）',
    async () => {
      try {
        if ((await evaluate('document.readyState')) !== 'complete') return false
        return (await evaluate('typeof window.api?.invoke')) === 'function'
      } catch {
        return false
      }
    },
    ms
  )
  rec({ kind: 'note', tag: 'ready', text: String(ok) })
  return ok
}

/**
 * 注入页面内采集器，并**验它站住了**。
 *
 * ★ 为什么要有「验」这一步：`Runtime.evaluate` 成功只说明那段代码在那个上下文里跑完了，
 * 不说明那个上下文还在。上面那条竞态的表现就是**注入成功、然后东西不见了** ——
 * 而不验的话，它会在两三句之后变成一条指向别处的 `undefined` 错误。
 */
async function injectHelpers(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await evaluate(HELPERS)
    if ((await evaluate('typeof window.__m7c')) === 'object') {
      if (i > 0) rec({ kind: 'note', tag: 'helpers', text: `第 ${i + 1} 次才站住` })
      return
    }
    await sleep(300)
  }
  throw new Error('页面内采集器注入不上去（三次都没站住）—— 多半是文档又换了一次')
}

/**
 * 页面内的采集器 + **驱动器**。与 m7b 的那份同源，换掉的是被测物那一层
 * （`@` 采集那一整段这里不需要 —— 本走查不碰 mention）。
 *
 * ## 三条纪律（照抄 m6b / m7a / m7b，一条都没改）
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
 * ⚠️ 这一段在模板字符串里，注释里**不许出现反引号** —— 它会当场把模板截断，
 *    而 tsc 不管模板里的内容，报出来的错在几百行之外。
 *    碰过这段就顺手跑一次 npm run check:helpers（这段的语法错只有它会当场指出来）。
 */
const HELPERS = `
window.__m7c = {
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
  value(sel) { const e = document.querySelector(sel); return e ? e.value : null },
  headerName() {
    const h = document.querySelector('header');
    if (!h) return null;
    const s = h.querySelector('span.text-sm');
    return s ? s.textContent : null;
  },
  cards() {
    return {
      live: document.querySelectorAll('article.neon-halo').length,
      done: document.querySelectorAll('article.neon-frame:not(.neon-halo)').length
    };
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
  // 发送按钮此刻是不是可点的。★ 这是「React 到底收到 onChange 没有」的**唯一硬信号**：
  // 受控输入没生效时输入框看着有字，而按钮还是 disabled、点了什么都不会发生。
  sendDisabled() {
    const b = Array.prototype.slice.call(document.querySelectorAll('button'))
      .filter((e) => (e.textContent || '').indexOf('发送') >= 0)[0];
    return b ? b.disabled : null;
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
  /**
   * ★ **不传 `env`**：那正是「原样继承」——凭据只经过子进程，走查从不读它。
   *
   * 而阈值旋钮**照样到得了**：它在 `prepareSandbox()` 里已经写进了**本进程**的
   * `process.env`，于是随继承一起下去。写进去的只有一个整数（`COMPACTION_N`），
   * 凭据那一半与 M7a/M7b 逐字相同。
   */
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
  const raw = await evaluate('JSON.stringify(window.__m7c.drain())')
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
    `window.__m7c.call(${JSON.stringify(ch)}, ${JSON.stringify(payload === undefined ? null : payload)})`
  )) as { ok?: boolean; data?: T; error?: unknown } | null
  rec({
    kind: 'ipc',
    label: currentLabel,
    tag,
    ch,
    req: payload ?? null,
    res: r ?? null,
    ms: Date.now() - started
  })
  if (!r || r.ok !== true) throw new Error(`IPC ${ch} 失败（${tag}）：${JSON.stringify(r?.error ?? r)}`)
  return r.data as T
}

async function domSnapshot(tag: string): Promise<void> {
  try {
    const text = await evaluate('window.__m7c.dom()')
    rec({
      kind: 'dom',
      label: currentLabel,
      tag,
      text: typeof text === 'string' ? text.slice(0, 3000) : ''
    })
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

// ─────────────────────────────────────────────────────────────
// 界面驱动
// ─────────────────────────────────────────────────────────────

/** 点一下，并把「点了什么、结果如何」落档。**点不中不抛** —— 那是要如实报告的事实。 */
async function click(tag: string, sel: string, sub?: string): Promise<string> {
  const r = String(
    await evaluate(`window.__m7c.click(${JSON.stringify(sel)}, ${JSON.stringify(sub ?? null)})`)
  )
  rec({ kind: 'ui', label: currentLabel, tag, action: 'click', sel, sub: sub ?? null, result: r })
  return r
}

/** 往输入框里写一段**完整**的正文（`type()` 是赋值，不是追加）。 */
async function typeInto(tag: string, sel: string, value: string): Promise<string> {
  const r = String(
    await evaluate(`window.__m7c.type(${JSON.stringify(sel)}, ${JSON.stringify(value)})`)
  )
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
    rec({
      kind: 'probe',
      label: currentLabel,
      tag,
      text: err instanceof Error ? err.message : String(err),
      ok: false
    })
    return null
  }
}

/**
 * ★ **重载渲染进程** —— 这是「夹具走 IPC、场景走界面」这个组合必须付的一次代价。
 *
 * 夹具是走 IPC 建的，而**没有任何推送会告诉渲染层**「现在有空间了」；绕过了界面，
 * 界面就还停在「一个空间都没有」的**首启空态**上（顶栏不渲染、点「对话」没反应）。
 * 重载之后页面把库重新读一遍，夹具就全在界面上了。
 * 代价是 `window.__m7c` 随旧文档一起没了，所以要重新注入。
 */
async function reloadRenderer(): Promise<void> {
  /**
   * ★★ 先给**旧文档**盖一个戳，然后等它消失。
   *
   * 为什么不能用「`window.api` 在不在」当「重载完了」的判据：旧文档在
   * `location.reload()` 之后还会活一会儿，那一刻 `window.api` 当然在 ——
   * 于是判据**立刻**通过，而它验的是**换掉之前的那份文档**。
   * 更糟的是紧接着的重载会把注入一并冲掉，而冲掉之后的症状长在别处。
   * 戳是自证的：它只存在于旧文档里，读不到了就说明**新文档真的提交了**。
   */
  await evaluate('window.__m7cReloadToken = "old"').catch(() => undefined)
  await evaluate('location.reload()').catch(() => undefined)
  const swapped = await waitUntil(
    '新文档提交（旧文档的戳没了）',
    async () => {
      try {
        return (await evaluate('typeof window.__m7cReloadToken')) === 'undefined'
      } catch {
        return false
      }
    },
    30000
  )
  rec({ kind: 'note', tag: 'reload.token', text: String(swapped) })
  if (!swapped) throw new Error('重载之后旧文档一直没被换掉 —— 后面所有界面断言都无从谈起')
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
  await injectHelpers()
  await evaluate('window.__m7c.hook()')
  /**
   * ★ **桥回来 ≠ 界面画好了。** preload 在 React 挂载**之前**就注入了 `window.api`，
   * 所以上面那个判据会在一张**空 DOM** 上通过 —— 紧接着的「点左栏那个空间」
   * 就会落到 `not-found` 上，而它看起来像「空间没建出来」。判据必须是**界面上真的有了东西**。
   */
  const painted = await waitUntil(
    '左栏画出来',
    async () => {
      try {
        return Number(await evaluate('window.__m7c.count("aside button")')) > 0
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
  ['headerName', 'window.__m7c.headerName()'],
  ['count', 'window.__m7c.count("textarea")'],
  ['value', 'window.__m7c.value("textarea")'],
  ['cards', 'window.__m7c.cards()'],
  ['sendDisabled', 'window.__m7c.sendDisabled()'],
  ['text', 'window.__m7c.text("header")'],
  ['dom', 'window.__m7c.dom().slice(0, 40)']
]

/** 页面上的一个布尔查询。页面没了（硬杀、正在关闭）时算「不在」—— 那是等的人该知道的事。 */
async function liveHas(sel: string): Promise<boolean> {
  try {
    return (await evaluate(`window.__m7c.has(${JSON.stringify(sel)})`)) === true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// 等一轮：认领 → 等终态 → 等安静
// ─────────────────────────────────────────────────────────────

/** 已经被认领过的轮次 id —— `waitOwnTurnId` 用它排除上一轮还活着的那个。 */
const claimedTurnIds = new Set<string>()

/**
 * 认领**用户这一次发送**产生的那一轮。
 *
 * ★★ 为什么不能只看「这个空间新出现的任一帧」（m7b 的第一版就是这么认的，然后认错了人）：
 * 那一刻空间里若有别的活轮次在推帧，谁先到就认谁。而这个 id 会被**写进归档当证据** ——
 * 于是归档里出现一行「T2 的轮次 = <别人的轮次>」，报告后面所有按它过滤的判据都在撒谎。
 * 而 M7c 的判据尤其挂在它身上：「压了没有」看的是**这一轮收尾之后**的库，
 * 认错轮次就等于**在不该转储的时刻拍了照**，而那种照片看起来只是「这一轮还没压」。
 *
 * ⇒ 钉在**库事实**上：用户直接发起的那一轮是
 *   ① 落在**发言者的会话**里、② `hopDepth === 0` 的那一条 —— 两者合起来才唯一
 *   （接力派进同一个会话的轮次，深度必然 > 0；同一个会话里同时有两条 0 跳轮次，
 *   意味着用户连点两次发送，而那本来就串行地等前一轮跑完）。
 *   数据来源是 `runtime:getState` 的活轮次 —— **它带 `hopDepth`**，而推送帧里没有这一列。
 *
 * ★ 轮次跑完就从活轮次里消失了，所以还有一条**降级路**：帧里 `sessionId` 对得上的那一条。
 * 它更弱（接力派进来的轮次也符合），所以 `via` 如实记进归档：出现 `batch-fallback`
 * 就说明这条 id 不够硬 —— 本走查是**单成员**，降级路在这里是安全的，但话要说清楚。
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
      say(`  ${label} 的轮次 = ${id}（从 runtime:getState 的活轮次里认的：发言者会话 + 0 跳）`)
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

/**
 * 等这一轮的**终态行落库**（`turn:get` 的 `status` 不再是 `running` / `queued`）。
 *
 * ★★ M7c 为什么非等它不可：压缩跑在 `runner` 的**同步尾段** ——
 * `batcher.endTurn`（提交终态行，`turn-runner.ts:540`）之后紧接着
 * `onTurnFinished`（`:548`），两者之间**没有一个 `await`**。
 * 于是「库里这一轮已是终态」与「压缩那个事务已提交」之间只差几条语句 ——
 * **先等终态、再转储**才是「我拍的是压完之后的世界」。
 * 换成「按时间睡几秒」的话，睡短了拍到半成品、睡长了白花钱，而**两种都看不出来**。
 *
 * ★ 返回的是时延（`lagMs`）：它是「终态行在认领之后多久落库」的读数，与本轮判据无关，
 * 但同一份归档在别的机器上重放时，它能解释长尾。
 */
async function waitTerminal(tag: string, turnId: string, ms: number): Promise<number> {
  const from = Date.now()
  for (;;) {
    let status = ''
    try {
      const row = await call<Record<string, unknown>>(`${tag}.poll`, 'turn:get', { id: turnId })
      status = String(row?.status ?? '')
    } catch {
      status = ''
    }
    if (status !== '' && status !== 'running' && status !== 'queued') {
      const lagMs = Date.now() - from
      rec({ kind: 'note', tag, text: status, lagMs })
      say(`  终态行落库：status=${status}（认领之后 ${lagMs}ms）`)
      return lagMs
    }
    if (Date.now() - from > ms) {
      rec({ kind: 'note', tag, text: `超时仍是 ${status || '（读不到）'}` })
      say(`  ⏳ 等到 ${ms}ms 终态行还是 ${status || '（读不到）'}`)
      return -1
    }
    await sleep(150)
  }
}

// ─────────────────────────────────────────────────────────────
// 活轮次观测
// ─────────────────────────────────────────────────────────────

/**
 * 等到这个空间**安静下来**（连续 3 拍没有活轮次）。
 *
 * ★ 本走查对「安静」的依赖比 M7b 更硬：压缩发生在一轮的**收尾**，
 * 而收尾在 `batcher.endTurn` 之后 —— 所以「库里这一轮的终态与水位线都落好了」
 * 才等于「可以拍下一张转储」。抢在它前面转储会拿到**半成品**，
 * 而那种半成品看起来只是「这一轮还没压」。
 *
 * ★ `cap` 是**钱闸**：本走查只发三轮，`peakLive` 超过 4 就说明有别的东西在派轮次
 * （多半是模型在回复里写了 `<mentions>`）。停下、如实记 `capped:true`，报告把它当 ❌。
 */
async function waitQuiet(
  tag: string,
  workspaceId: string,
  ms: number,
  cap = 4
): Promise<{
  polls: number
  ms: number
  maxSlots: number
  slotsTotal: number
  peakLive: number
  capped: boolean
}> {
  const from = Date.now()
  const s = { polls: 0, ms: 0, maxSlots: 0, slotsTotal: 0, peakLive: 0, capped: false }
  let quiet = 0
  for (;;) {
    const st = await call<SchedulerStateLike>(`${tag}.state`, 'runtime:getState', null)
    s.polls++
    s.maxSlots = Math.max(s.maxSlots, Number(st?.slots?.used ?? 0))
    s.slotsTotal = Number(st?.slots?.total ?? 0)
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
    `  这个空间安静了：${(s.ms / 1000).toFixed(1)}s，峰值活轮次 ${s.peakLive}，` +
      `最大并发 ${s.maxSlots}/${s.slotsTotal}${s.capped ? '（**撞到钱闸，停手**）' : ''}`
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

/** 一批帧里 `usage` 帧的那几个数（本轮的 token 用量）。 */
function usageOf(label: string, turnId: string): Record<string, number> | null {
  const frames = batchesOf(label, turnId)
    .flatMap((b) => b.frames)
    .filter((f) => f.k === 'usage')
  const last = frames[frames.length - 1]
  if (!last) return null
  return {
    in: Number(last['in'] ?? 0),
    out: Number(last['out'] ?? 0),
    cacheRead: Number(last['cacheRead'] ?? 0),
    cacheCreation: Number(last['cacheCreation'] ?? 0)
  }
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
  writeFileSync(PERSONA, PERSONA_TEXT, 'utf8')

  /**
   * ★ 阈值旋钮：写进**本进程**的环境，子进程随继承拿走（见文件头与 `launch`）。
   *
   * ★★ 干跑刻意写一个**非法值**：有效值不产生任何输出，于是「设了但没人读」
   * 与「设了且被采纳」在零成本下**长得一模一样**；而非法值会让应用出一声
   * （`compactionLimitsFromEnv` 的 warn）—— 那一声就是「这个变量真的被读了」的证据。
   * 代价是干跑的这一次启动**不是**真跑的前缀，这一点写进报告，不藏着。
   */
  const knobValue = DRY ? 'abc' : String(N)
  process.env['CODE_CHAT_COMPACTION_N'] = knobValue

  rec({ kind: 'markers', tag: 'markers', nonce: NONCE, textT1: TEXT_T1, textT2: TEXT_T2, textT3: TEXT_T3 })
  rec({
    kind: 'note',
    tag: 'env',
    sand: SAND,
    userData: USERDATA,
    projectDir: SRC,
    model: MODEL,
    maxBudgetUsd: 0.5,
    compactionN: knobValue,
    compactionNValid: !DRY,
    dryInvalidKnob: DRY,
    text: `沙箱 ${SAND}（库 ${DB}，项目 ${SRC}）`
  })
  say(`  沙箱            ${SAND}`)
  say(`  标记后缀        ${NONCE}`)
  say(`  模型            ${MODEL}（端点 = 本机默认凭据所指向的那个，**不是 Anthropic 官方**）`)
  say('  预算闸          --max-budget-usd 0.50（turn-runner 的默认值，每轮一道）')
  say(
    `  压缩阈值        CODE_CHAT_COMPACTION_N=${knobValue}` +
      (DRY
        ? '（★ **刻意非法**：干跑要证明「应用真的读了这个变量」只可能靠它出一声）'
        : `（= ${N}；默认值是 20，三轮够不着 ⇒「压了」本身就证明旋钮被采纳）`)
  )
  say('  空间            Vela（单成员 Atlas，人设不提 `@`）：三轮 = 阈值下 → 跨过 → 下一轮装配')
}

/**
 * ★ **零成本的静态核对**：压缩的三处接线有没有真的接上。
 *
 * 它必须在这里做、而不是在报告里做，因为报告**只读归档** —— 一个「去读仓库源码」的报告
 * 在别的机器上重放同一份归档时会得到不同的结论。
 *
 * 它是静态的，所以**只值一句话**：`compaction.ts` 真的有没有被装配、被 runner 的收尾调用、
 * 以及**顺序**对不对。这条 note 的作用是**把最可能的那一种漏掉挡在花钱之前**
 * （`runtime.ts` 里加了一个字段却忘了在组合根上传它 —— M7a 的 `textReader` 踩过这个形状）。
 *
 * ★★ 顺序那一条**没有任何测试会红**（§4.5a 规则一保证两者互不影响），
 * 所以这里读源码比读行为更靠谱：它至少能在有人调换了两行时出一次声。
 */
function staticWiringCheck(): void {
  const runtimeFile = join(REPO, 'src', 'main', 'process', 'runtime.ts')
  const mainFile = join(REPO, 'src', 'main', 'index.ts')
  const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  const runtimeSrc = read(runtimeFile)
  const mainSrc = read(mainFile)
  const assembled = runtimeSrc.includes('createCompaction')
  const seamAt = runtimeSrc.indexOf('compaction.onTurnFinished(turn)')
  const fanoutAt = runtimeSrc.indexOf('fanout.onTurnFinished(turn, info)')
  const ordered = seamAt >= 0 && fanoutAt >= 0 && seamAt < fanoutAt
  const envKnob = mainSrc.includes('thresholdOverrideFromEnv(process.env)')
  const limitsPassed = runtimeSrc.includes('compactionLimits')
  const ok = assembled && ordered && envKnob && limitsPassed
  rec({
    kind: 'note',
    tag: 'dry.wiring',
    text: ok ? 'wired' : 'MISSING',
    runtimeFile,
    mainFile,
    assembled,
    ordered,
    seamAt,
    fanoutAt,
    envKnob,
    limitsPassed
  })
  say(
    `  组合根接线      createCompaction=${String(assembled)} 压缩在扇出之前=${String(ordered)} ` +
      `env 旋钮被读=${String(envKnob)} 阈值透传=${String(limitsPassed)}`
  )
}

interface WsIds {
  workspaceId: string
  name: string
  projectId: string
  memberId: string
  sessionId: string
}

/**
 * 夹具：**走 IPC**（照 M6a / M6b / M7a / M7b）。
 *
 * ★ 这里刻意不点界面建空间 —— 夹具不是被测物。
 * **该走界面的地方（打字、点发送）全部走界面**，见三轮那一段。
 *
 * ★ **不给角色描述**（`roleDescPath` 不传）是**故意的**：`role_desc_path` 可空，
 * 而「NULL 时 `<role>` 整块不出现」是一条产品判决（M7a 的单测钉着它）。
 * 真机上让夹具落在这个状态上，三轮都顺带证一次。
 */
async function setup(): Promise<WsIds> {
  const ws = await call<{ id: string; name: string }>('setup.ws', 'workspace:create', {
    name: 'Vela'
  })
  const proj = await call<{ id: string }>('setup.project', 'project:addLocal', {
    workspaceId: ws.id,
    name: 'sandbox',
    rootPath: SRC
  })
  const actor = await call<{ id: string }>('setup.actor', 'actor:create', {
    name: 'Vela-Atlas',
    model: MODEL,
    personaPath: PERSONA,
    effort: 'low'
  })
  const member = await call<{ id: string }>('setup.member', 'member:create', {
    workspaceId: ws.id,
    actorId: actor.id,
    displayName: 'Atlas'
  })
  /**
   * ★ 这里不能用 `member:setPrimary`：它要求**先收窄可见项目**（「主项目必须是可见项目之一」），
   * 在一个还没配过可见性的成员上直接挂主项目会被拒（`E_CONFLICT`）。
   * `member:setVisibility` 一次把「可见集合 + 主项目」都定了 —— 于是每一轮的 `cwd`
   * 都是那个项目根，`<files>` 那一块也就非空。
   */
  await call('setup.vis', 'member:setVisibility', {
    memberId: member.id,
    projectIds: [proj.id],
    primaryProjectId: proj.id
  })
  const session = await call<{ id: string } | null>('setup.session', 'session:getByMember', {
    memberId: member.id
  })
  if (!session) {
    throw new Error('member:create 之后没有会话 —— 与「会话与成员同生」的契约矛盾')
  }

  /**
   * ★ 视图必须真的切到这个空间：合批器按 `ActiveView.workspaceId` 抑制，
   * 而视图是**内存态**（每次启动都是 null，不落库），所以每次启动都要重设一遍。
   * 漏了这一步，第一批就会被合法地抑制掉，而现象看起来像「流式没通」。
   */
  await call('setup.view', 'view:setActive', {
    workspaceId: ws.id,
    sessionId: session.id
  })

  const ids: WsIds = {
    workspaceId: ws.id,
    name: 'Vela',
    projectId: proj.id,
    memberId: member.id,
    sessionId: session.id
  }
  rec({ kind: 'note', tag: 'ids', text: JSON.stringify(ids) })
  return ids
}

/**
 * 走界面发一条消息，然后**等它彻底静下来**。
 *
 * ★ 「等静下来」不是礼貌，是判据的前提：压缩发生在一轮的收尾，收尾又在
 * `batcher.endTurn` 之后 —— 抢在它前面转储会拿到**半成品**，而那看起来只是
 * 「这一轮还没压」。所以顺序钉死：**点发送 → 等安静 → 转储**。
 */
async function sendAndSettle(
  tag: string,
  ids: WsIds,
  text: string,
  turnMs: number,
  quietMs: number
): Promise<void> {
  /**
   * ★ 记住点击之前归档到哪儿了：`waitOwnTurnId` 的**降级路**只许看这之后新到的帧 ——
   * 否则上一轮的帧还躺在 `recs` 里，它会顺手认成这一轮的。
   */
  const since = recs.length
  const typed = await typeInto(`${tag}.type`, 'textarea', text)
  await sleep(250)
  const before = await evaluate('window.__m7c.sendDisabled()')
  const sent = await click(`${tag}.send`, 'button', '发送')
  rec({
    kind: 'note',
    tag: `${tag}.send`,
    text: `typed=${typed} disabledBeforeSend=${String(before)} clicked=${sent} chars=${text.length}`
  })
  if (typed !== 'typed' || sent !== 'clicked') {
    throw new Error(
      `${tag}：发送路径没走通（typed=${typed} clicked=${sent}）—— ` +
        '受控输入没生效时输入框看着有字、按钮还是 disabled、点了什么都不发生'
    )
  }
  /**
   * ★★ 三步次序是硬的：**认领 → 等终态 → 等安静**。
   *
   * 少了第一步，`waitQuiet` 会在轮次**还没被派发**的那几百毫秒里看见「这个空间一个活轮次都没有」
   * 而立刻返回 —— 于是转储拍在轮次开始之前，而那张照片**看起来只是「这一轮还没压」**。
   * 少了第二步，转储可能落在 `batcher.endTurn` 与压缩事务之间（那两件事之间没有 await）。
   * 第三步是留给收尾之后可能残余的东西（本走查是单成员，正常应当是空的）。
   */
  const turnId = await waitOwnTurnId(`${tag}.own`, tag, 60000, ids.sessionId, since)
  if (turnId === null) {
    rec({
      kind: 'note',
      tag: `${tag}.nostart`,
      text: '60s 都没认领到这一轮的 id —— 发送可能根本没落成一轮'
    })
    say(`  ⚠️ ${tag}：认领不到轮次 id —— 只能按时间等，报告会从**轮次条数**上看出来`)
    await waitQuiet(`${tag}.quiet`, ids.workspaceId, quietMs)
  } else {
    const lag = await waitTerminal(`${tag}.term`, turnId, turnMs)
    if (lag < 0) say(`  ⚠️ ${tag}：终态行没等到 —— 下面那张转储可能是半成品`)
    await waitQuiet(`${tag}.quiet`, ids.workspaceId, quietMs)
  }
  await drain()
  // ★ 再等一下再拉一次：`[ctx]` 是 `console.log` 出来的，管道里可能还在路上。
  await sleep(500)
  await drain()
}

async function collect(dir: string): Promise<void> {
  runDir = dir
  mkdirSync(runDir, { recursive: true })

  rule('M7c 走查 · 准备')
  prepareSandbox()

  rule('启动 A · 夹具')
  launch('A')
  await connectCdp()
  // ★ 顺序是硬的：先等真文档提交，再注入 —— 否则注入会落在临时上下文里被加载吃掉。
  if (!(await waitRealDocument())) {
    throw new Error('页面一直没 load 完（preload 桥不在）—— 后面所有界面断言都无从谈起')
  }
  await injectHelpers()
  const hooked = await evaluate('window.__m7c.hook()')
  rec({ kind: 'note', tag: 'hooked', text: String(hooked) })
  startPump()
  await sleep(700)
  await domSnapshot('A:startup')

  const ids = await setup()
  dumpDb('A', 'setup')
  // ★ 夹具是走 IPC 建的，界面还不知道 —— 重载一次让库重新读进 store（见 `reloadRenderer`）。
  await reloadRenderer()
  const picked = await click('A:pickVela', 'aside button', 'Vela')
  rec({ kind: 'note', tag: 'A:pickVela', text: picked })
  await sleep(400)

  if (DRY) {
    /**
     * 干跑自检：桥在构建版里暴露了吗？对话视图打得开吗？输入区在吗？受控输入通吗？
     * 以及 M7c 独有的两条：**压缩的三处接线 + 顺序**（静态核对）与
     * ★ **阈值旋钮真的被应用读到了**（靠那个刻意非法的值出一声）。
     *
     * ⚠️ 说清楚干跑**测不到**什么：所有「压了没有 / 摘要是什么 / 下一轮装配读到没有」
     * 都要真轮次才有内容。干跑挡得住「接线漏了 / 旋钮没被读」，挡不住「压缩的判决错了」。
     */
    staticWiringCheck()
    const before = await evaluate(
      'JSON.stringify({' +
        'api: typeof window.api?.invoke, on: typeof window.api?.on, hooked: window.__m7c.hooked,' +
        'header: window.__m7c.headerName()' +
        '})'
    )
    rec({ kind: 'note', tag: 'dry.before', text: String(before) })
    say(`  干跑探针（概览）  ${String(before)}`)

    const opened = await openConversation('A:dry')
    const after = await evaluate(
      'JSON.stringify({textarea: window.__m7c.has("textarea"), send: window.__m7c.count("button")})'
    )
    rec({ kind: 'note', tag: 'dry.after', text: String(after), opened })
    say(`  干跑探针（对话）  ${String(after)}`)

    /**
     * ★ 零成本地验一次**发送路径上最脆的那一环：受控输入**。
     * 直接 `el.value = x` 在 React 里**不触发** `onChange` —— 输入框看着有字、
     * 状态还是空的、点「发送」什么也不会发生。真判断「React 收到了没有」的信号是
     * **发送按钮从 disabled 变成可点**。
     *
     * ⚠️ 这里**只输入、不点发送** —— 点了就是一轮真 CLI，那就是花钱了。
     */
    const typedProbe = await typeInto('A:dry', 'textarea', '干跑：只验输入，不发送')
    await sleep(200)
    const sendBtn = await evaluate('window.__m7c.sendDisabled()')
    rec({ kind: 'note', tag: 'dry.type', text: String(sendBtn), typed: typedProbe })
    say(`  受控输入       typed=${typedProbe}，发送按钮 disabled=${String(sendBtn)}（应为 false）`)

    // ★ 把输入框清掉，别把状态留给后面（干跑不发轮次，但这是纪律）。
    await typeInto('A:dry.clear', 'textarea', '')
    await smokeHelpers()

    // ★ 旋钮那一枪：读主进程 stderr 里有没有 `[compaction] …`。
    await pullAppWarn('A')
    await pullAppKnob('A')

    stopPump()
    const pidDry = currentChild?.pid ?? 0
    hardKill('A')
    await waitGone(pidDry)
    rule('干跑结束（**没有发起任何轮次，没花钱**）')
    say('  地基这一层：构建产物起得来、CDP 连得上、preload 桥在构建版里可用、夹具走 IPC 全过、')
    say('  对话视图打得开、输入区与发送按钮都在、受控输入通、压缩的三处接线与顺序都在、')
    say('  阈值旋钮真的被应用读到了（靠非法值那一声）。')
    say('  ⚠️ **没测到**：压了没有、摘要是什么、下一轮的装配读到没有 —— 那些要真轮次。')
    say('  下一句才是真机：npm run walk:m7c（真花钱，3 轮）。')
    return
  }

  // ══════════════════════════════════════════════════════════
  // 三轮：阈值之下 → 跨过 → 下一轮装配读到摘要
  // ══════════════════════════════════════════════════════════
  rule('Vela · 打开对话')
  const opened = await openConversation('A:vela')
  rec({ kind: 'note', tag: 'A:vela.opened', text: String(opened) })

  /**
   * ★ 第 1 轮：**阈值之下**（「本轮之前」一条历史都没有）⇒ 判决必须是 `nothing-to-fold`，
   * 库里一条都不许动。它是后面两轮的前提：如果第一轮就压了，那说明区间右端算错了。
   */
  rule(`Vela · 第 1 轮（阈值 N=${N}，此时没有任何历史 → 预期不压）`)
  await sendAndSettle('A:t1', ids, TEXT_T1, 240000, 30000)
  dumpDb('A', 't1')

  /**
   * ★ 第 2 轮：**跨过阈值**（「本轮之前」正好 2 条：第 1 轮的请求与回复）⇒ 该压。
   * 这一轮的收尾是本走查的核心事件。
   */
  rule('Vela · 第 2 轮（本轮之前 2 条 → 预期压）')
  await sendAndSettle('A:t2', ids, TEXT_T2, 240000, 30000)
  dumpDb('A', 't2')

  /**
   * ★ 第 3 轮：它的**装配**才是「压缩生效」的判据 —— 数组里 `<summary>` 在位、
   * 被折的历史不在里面。同时它自己的收尾会**再压一次**，于是累积那条判据
   * （第二次的摘要里仍有第一段）也在这份归档里。
   */
  rule('Vela · 第 3 轮（装配里应看到摘要；收尾会再压一次 → 累积）')
  await sendAndSettle('A:t3', ids, TEXT_T3, 240000, 30000)
  dumpDb('A', 'final')

  await pullAppCtx('A')
  await pullAppWarn('A')
  await domSnapshot('A:after')
  rec({ kind: 'note', tag: 'ids.final', text: JSON.stringify(ids) })

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
const seenKnob = new Set<string>()

/**
 * 把主进程 stdout 里的 `[ctx] {json}` 行拉进归档。
 *
 * ★★ 这一条是本走查**第二半判据的唯一来源**：压缩生效与否在库里有证据，
 * 但「装配数组里到底有没有那个 `<summary>` 块」**只有这里看得见** ——
 * 它不进库、不进界面，`shape.summaryChars` 是它在归档里的唯一痕迹。
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
 * ★ 这是**压缩判决的唯一直接证据**：`process/compaction.ts` 的每个判决都走 `onWarn`，
 * 于是 `[runtime:compaction:decided]` / `[compaction:compacted]` /
 * `[compaction:cli-signal]` 会一字不差地落在这里。
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

/**
 * ★ 把主进程 stderr 里的 **`[compaction] …`** 行拉进归档。
 *
 * 这个前缀**不是** `onWarn` 那条路（那是 `[runtime:…]`），而是 `main/index.ts` 里
 * `compactionLimitsFromEnv()` 对**非法旋钮值**的判决 —— 它只在启动期出一次声。
 * 干跑靠它证明「应用真的读了 `CODE_CHAT_COMPACTION_N`」：有效值不产生任何输出，
 * 于是「设了但没人读」与「设了且被采纳」在没有这一枪时长得一模一样。
 */
async function pullAppKnob(label: string): Promise<void> {
  const file = join(runDir, `app-${label}.stderr.log`)
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s.startsWith('[compaction]')) continue
    if (seenKnob.has(s)) continue
    seenKnob.add(s)
    rec({ kind: 'knob', label, line: s.slice(0, 400) })
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

/** 会话那一行（水位线与摘要在它身上）。 */
function sessionOf(dump: Dump, sessionId: string): Record<string, unknown> | undefined {
  return (dump.session ?? []).find((s) => s.id === sessionId)
}

/** 一条消息那一行。 */
function msgOf(dump: Dump, messageId: unknown): Record<string, unknown> | undefined {
  return (dump.message ?? []).find((m) => m.id === messageId)
}

/** 这个会话里的消息，按 seq 升序。 */
function msgsInSession(dump: Dump, sessionId: string): Array<Record<string, unknown>> {
  return (dump.message ?? [])
    .filter((m) => m.session_id === sessionId)
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
}

/** `[ctx]` 记录里按 turnId 取形状。 */
function shapeOf(turnId: string): ShapeLike | undefined {
  const r = recs.find((x) => x.kind === 'ctx' && String(x.turnId) === turnId)
  return r?.shape as ShapeLike | undefined
}

/** 某个（会话级的）阈值数字，从库转储里读。 */
function throughOf(dump: Dump | undefined, sessionId: string): number {
  if (!dump) return -1
  return Number(sessionOf(dump, sessionId)?.compacted_through_seq ?? -1)
}

function summaryOf(dump: Dump | undefined, sessionId: string): string | null {
  if (!dump) return null
  const v = sessionOf(dump, sessionId)?.rolling_summary
  return typeof v === 'string' ? v : null
}

function wrapped(s: string, n = 400): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…（共 ${one.length} 字）` : one
}

/**
 * 干跑的报告。**它只判「地基」** —— 零成本那一层能测到的东西。
 *
 * ★ §8.8e 规则三：**缺证据不许印成 ✅**。M6b 第一次干跑的版本只看了「有没有 error」，
 * 于是它在「顶栏压根没渲染、输入区根本不存在」的情况下印了一句「干跑干净」。
 */
function reportDry(): number {
  failures = 0
  unknowns = 0

  rule('干跑：只判地基（零成本，一个轮次都没发）')
  for (const e of recs.filter((r) => r.kind === 'error')) {
    check('bad', `采集器记到一条错误：[${String(e.tag ?? '?')}] ${String(e.message ?? '')}`)
  }

  const before = noteOf<Record<string, unknown>>('dry.before', {})
  const after = noteOf<Record<string, unknown>>('dry.after', {})
  const reloaded = String(pick('note', 'reload')?.text) === 'true'

  check(
    before['api'] === 'function' && before['on'] === 'function' ? 'ok' : 'bad',
    `preload 桥在**构建产物**里可用（invoke=${String(before['api'])} on=${String(before['on'])}）—— ` +
      'dev 能跑不等于构建版能跑，走查跑的是构建版'
  )
  check(reloaded ? 'ok' : 'bad', '渲染进程重载之后桥又回来了（重载是夹具变成界面可见的唯一手段）')
  check(
    before['hooked'] === true ? 'ok' : 'bad',
    '推送钩子装上了（stream:batch / stream:status / workspace:unread / app:notice）'
  )
  check(
    String(pick('note', 'A:pickVela')?.text) === 'clicked' ? 'ok' : 'bad',
    '在左栏点得中空间（装配出来的空间在界面上真的存在）'
  )
  check(
    typeof before['header'] === 'string' && before['header'] !== '' && before['header'] !== 'null'
      ? 'ok'
      : 'bad',
    `顶栏渲染出来了、而且显示的是被选中的那个空间的名字：${String(before['header'])}`
  )
  check(
    String(pick('note', 'A:dry.pane')?.text) === 'true' && after['textarea'] === true ? 'ok' : 'bad',
    `点「对话」真的打开了对话视图、输入区在里面（textarea=${String(after['textarea'])}）`
  )
  check(
    Number(after['send']) >= 1 ? 'ok' : 'bad',
    `发送按钮在（页面上共 ${String(after['send'])} 个 button）`
  )

  const typed = pick('note', 'dry.type')
  check(
    typed?.['typed'] === 'typed' && String(typed?.['text']) === 'false' ? 'ok' : 'bad',
    `受控输入：写进 textarea = ${String(typed?.['typed'])}，发送按钮因此变为可点` +
      `（disabled=${String(typed?.['text'])}）—— disabled 还是 true 就说明 React 没收到 onChange，` +
      '点了发送也不会有任何事发生'
  )

  /**
   * ★ M7c 独有的那一条地基：**压缩的三处接线 + 顺序**。
   * 它是静态的（读两份源码），所以只值「接线在不在、顺序对不对」这一个问题 ——
   * 但漏掉任何一处，真机那一趟就是在**压缩永远不会发生**的情况下花钱。
   */
  const wiring = pick('note', 'dry.wiring')
  check(
    String(wiring?.text ?? '') === 'wired' ? 'ok' : 'bad',
    `压缩的接线与顺序都在（createCompaction=${String(wiring?.['assembled'])} ` +
      `压缩在扇出之前=${String(wiring?.['ordered'])} env 旋钮被读=${String(wiring?.['envKnob'])} ` +
      `阈值透传=${String(wiring?.['limitsPassed'])}）—— **静态核对**：它不证明判决对，` +
      `只证明没忘了接（${String(wiring?.['runtimeFile'] ?? '?')} 与 ${String(wiring?.['mainFile'] ?? '?')}）`
  )

  /**
   * ★★ 旋钮那一枪：干跑**刻意用非法值**起应用，所以这里必须看到一声。
   *
   * 它证明三件事一起成立：① 这个变量真的被应用读了；② 我们往自己 `process.env`
   * 里写的那一下真的传到了子进程；③ 非法值**不静默**。
   * 缺了它，「有效值被采纳」在零成本下**没有任何观测**（有效值不出声）。
   */
  const knob = recs.filter((r) => r.kind === 'knob')
  const envNote = pick('note', 'env')
  check(
    knob.length > 0 && String(envNote?.['compactionN']) === 'abc' ? 'ok' : 'bad',
    `★ 旋钮真的被应用读到了：\`CODE_CHAT_COMPACTION_N=abc\`（**刻意非法**）⇒ 主进程出一声 ` +
      `「${wrapped(String(knob[0]?.line ?? '（没有这一声）'), 120)}」—— ` +
      '它同时证明了这个变量被读、我们的 process.env 传到了子进程、且非法值不静默回退'
  )

  const helperRecs = recs.filter((r) => r.kind === 'probe' && String(r.tag).startsWith('dry.helper.'))
  const helperBad = helperRecs.filter((r) => r.ok !== true)
  check(
    helperRecs.length === SMOKE_PROBES.length && helperBad.length === 0 ? 'ok' : 'bad',
    `页面内辅助函数全跑通（${helperRecs.length}/${SMOKE_PROBES.length} 个）` +
      (helperBad.length > 0
        ? ` —— 这几个炸了：${helperBad
            .map((r) => `${String(r.tag).replace('dry.helper.', '')}(${String(r.text)})`)
            .join(' ')}`
        : '') +
      '；它们在真机上抛一次就会让采集在**已经花过钱之后**中断'
  )

  const drySetup = dumpOf('A', 'setup')
  check(
    drySetup !== undefined && throughOf(drySetup, String(noteOf<WsIds | Record<string, never>>('ids', {})['sessionId'] ?? '')) === 0
      ? 'ok'
      : 'bad',
    '夹具建完之后水位线是 0（一个轮次都没发，所以它**必须**还没动）'
  )

  check(
    'unknown',
    '⚠️ **干跑测不到**：压了没有、摘要长什么样、下一轮的装配读到没有 —— ' +
      '它们都要真轮次才有内容，`report()` 把它们当第一等判据。' +
      '⚠️ 还有一条更细的：干跑**只能证明应用读了这个变量**，「有效值被采纳」只能由真跑里' +
      '「两条就压了」间接证明（默认阈值 20，三轮够不着）'
  )

  rule('干跑结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '地基干净，可以花真钱了（npm run walk:m7c）' : `${failures} 条不通过 —— **先修地基，再花真钱**`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  return failures
}

// ─────────────────────────────────────────────────────────────
// 真机报告（**只读归档**）
// ─────────────────────────────────────────────────────────────

function report(): number {
  failures = 0
  unknowns = 0

  const ids = noteOf<WsIds | Record<string, never>>('ids', {})
  const sessionId = typeof ids.sessionId === 'string' ? ids.sessionId : ''
  const workspaceId = typeof ids.workspaceId === 'string' ? ids.workspaceId : ''
  const env = pick('note', 'env')
  const markers = pick('markers', 'markers')

  const dSetup = dumpOf('A', 'setup')
  const dT1 = dumpOf('A', 't1')
  const dT2 = dumpOf('A', 't2')
  const dFinal = dumpOf('A', 'final')

  rule('环境（端点限定语写在最前面）')
  say(`  归档            ${runDir}`)
  say(`  沙箱            ${String(env?.sand ?? '?')}`)
  say(`  模型            ${String(env?.model ?? '?')}（端点 = 本机默认凭据所指向的那个）`)
  say(`  标记后缀        ${String(markers?.nonce ?? '（归档里没有 markers 记录）')}`)
  say(`  压缩阈值        CODE_CHAT_COMPACTION_N=${String(env?.compactionN ?? '?')}`)
  say('  空间            Vela（单成员 Atlas）· 三轮 = 阈值下 → 跨过 → 下一轮装配读到摘要')
  say('  ⚠️ 全部结论只在**本机默认凭据所指向的那个端点**下成立，不是 Anthropic 官方行为。')
  say('  ★ 而这一趟的结论**对端点弱依赖**：压缩只由我们自己的条数与字符估算驱动，')
  say('     模型的输出只决定「正文有多长」。换端点要重跑的是最后那张标定表。')

  check(
    markers !== undefined ? 'ok' : 'bad',
    '归档里有本次的标记后缀与三段正文 —— 报告最要紧的那条判据（「第二次压缩之后摘要里仍有第一段」）' +
      '靠它才验得到**具体那一段**，否则只能验「摘要非空」这种谁也证明不了的弱命题'
  )
  check(
    sessionId !== '' && workspaceId !== '' ? 'ok' : 'bad',
    '夹具 id 在归档里'
  )
  if (sessionId === '' || workspaceId === '') {
    check('bad', '夹具 id 缺失 —— 下面所有按会话过滤的判据都无从谈起')
    return failures
  }
  if (!dT1 || !dT2 || !dFinal) {
    check('bad', `转储不全（t1=${String(!!dT1)} t2=${String(!!dT2)} final=${String(!!dFinal)}）—— 判不了`)
    return failures
  }

  const turnsFinal = turnsOf(dFinal, workspaceId)
  const turnIds = turnsFinal.map((t) => String(t.id))
  const ctxRecs = recs.filter((r) => r.kind === 'ctx')
  const warns = recs.filter((r) => r.kind === 'warn')
  const warnTags = warns.map((w) => String(w.tag))
  const notices = recs.filter((r) => r.kind === 'notice')

  // ══ 观测通道 ═══════════════════════════════════════════════
  rule('观测通道 · 三条都在吗')
  say(`  轮次 ${turnIds.length} 条 · [ctx] ${ctxRecs.length} 条 · [runtime:…] ${warns.length} 条`)
  say(`  [runtime:…] 的 tag：[${warnTags.join(' ')}]`)
  say(
    `  推送到的 app:notice ${notices.length} 条 —— **本趟预期就是 0**：` +
      '那一条 warning 只在「CLI 自己压了」的时候发（判据见下面那一段），而它一次都没出现；' +
      '通道本身在 M7b 的归档里被证明是通的，所以这里的 0 是「没有可报的事」，不是「通道坏了」'
  )
  say(
    '  ★ 上面这行是按「tag + 行首一段」去重的**摘要** —— 同一 tag 的多条读数（比如每轮一条的 ' +
      'compaction:decided）在归档里只留第一条。**逐字原文在 app-A.stderr.log 里一条不少**，' +
      '要数「每一轮各判了什么」就去读那一份'
  )
  const turnsAtSetup = dSetup ? turnsOf(dSetup, workspaceId).length : -1
  check(
    turnsAtSetup === 0 ? 'ok' : 'bad',
    `夹具阶段（**第一条轮次之前**）这个空间里有 ${turnsAtSetup} 条轮次 —— 必须是 0，` +
      '它是「下面那 3 条就是本走查发的那 3 条」这个前提的锚点（少了它，多出来的轮次可以怪到夹具头上）'
  )
  check(
    turnIds.length === 3 ? 'ok' : 'bad',
    `三轮都落到库里了（实得 ${turnIds.length} 条）—— 多于 3 条说明有别的东西在派轮次（多半是模型写了 <mentions>）`
  )
  check(
    ctxRecs.length >= 3 ? 'ok' : 'bad',
    `主进程 stdout 里的 [ctx] 行拉到了 ${ctxRecs.length} 条 —— 它是「装配里有没有 <summary>」的**唯一**落档处`
  )
  check(
    warnTags.includes('compaction:decided') ? 'ok' : 'bad',
    `压缩的判决日志在（[${warnTags.filter((t) => t.startsWith('compaction:')).join(' ')}]）—— ` +
      '单测只能证明那个函数返回了什么，这一条证明它在生产路径上真的跑过'
  )

  // ══ T1 · 阈值之下 ══════════════════════════════════════════
  rule('Vela T1 · 阈值之下：一条都不许动')
  const through1 = throughOf(dT1, sessionId)
  const summary1 = summaryOf(dT1, sessionId)
  check(
    through1 === 0 && summary1 === null ? 'ok' : 'bad',
    `第 1 轮收尾之后水位线仍是 0、摘要仍是 null（实得 ${through1} / ${summary1 === null ? 'null' : `「${wrapped(summary1, 60)}」`}）` +
      '—— 「本轮之前」一条历史都没有，所以这一轮**必须**是 nothing-to-fold'
  )
  const t1Msgs = msgsInSession(dT1, sessionId)
  check(
    t1Msgs.every((m) => m.inject_mode === 'full') ? 'ok' : 'bad',
    `第 1 轮之后这个会话里 ${t1Msgs.length} 条消息**全是 full**（没有一条被标成 summary）`
  )

  // ══ T2 · 跨过阈值 ══════════════════════════════════════════
  rule('Vela T2 · 跨过阈值：压了')
  const turns2 = turnsOf(dT2, workspaceId)
  const turn2 = turns2[turns2.length - 1]
  const through2 = throughOf(dT2, sessionId)
  const summary2 = summaryOf(dT2, sessionId)
  check(turns2.length === 2 ? 'ok' : 'bad', `第 2 轮之后库里有 2 条轮次（实得 ${turns2.length}）`)
  check(
    through2 > 0 ? 'ok' : 'bad',
    `★ 第 2 轮收尾之后水位线推到了 ${through2}（阈值 N=${String(env?.compactionN ?? '?')}）—— ` +
      '默认阈值是 20，三轮里**够不着** ⇒ 这一条同时证明旋钮真的被采纳了'
  )
  check(
    summary2 !== null && summary2.length > 0 ? 'ok' : 'bad',
    `★ 摘要落库了（${summary2 === null ? 'null' : `${summary2.length} 字`}）：` +
      `「${wrapped(summary2 ?? '', 220)}」`
  )
  check(
    summary2 !== null && !summary2.includes(String(markers?.textT2 ?? '___')) ? 'ok' : 'bad',
    '★ 第 2 轮的**触发消息不在摘要里** —— 把模型自己的请求折进去，它就会在自己的请求里读到它的转述'
  )
  const trigger2 = msgOf(dT2, turn2?.trigger_message_id)
  check(
    String(trigger2?.inject_mode ?? '') === 'full' ? 'ok' : 'bad',
    `★★ 第 2 轮的触发消息**仍是 full**（实得 ${String(trigger2?.inject_mode ?? '?')}，seq=${String(trigger2?.seq ?? '?')}，水位线=${through2}）` +
      '—— 区间右端是**开**的，这一条就是那个「开」的可执行形态'
  )
  const folded2 = msgsInSession(dT2, sessionId).filter((m) => m.inject_mode === 'summary')
  check(
    folded2.length === 2 ? 'ok' : 'bad',
    `★ 被折的是**恰好两条**（第 1 轮的请求与回复，实得 ${folded2.length} 条）：` +
      `seq=[${folded2.map((m) => String(m.seq)).join(' ')}]`
  )
  const sysRows2 = msgsInSession(dT2, sessionId).filter((m) => m.role === 'system')
  check(
    sysRows2.length === 1 && sysRows2[0]?.turn_id === null ? 'ok' : 'bad',
    `★ 有一条 role=system 的可见行、且它**不带 turn_id**（实得 ${sysRows2.length} 条，` +
      `turn_id=${JSON.stringify(sysRows2[0]?.turn_id ?? null)}）—— 带上它就会被 listByTurn 算成那一轮的产物`
  )

  // ══ T3 · 下一轮的装配 ══════════════════════════════════════
  rule('Vela T3 · 下一轮的装配里 <summary> 在位（这一半库里看不见）')
  const sid1 = shapeOf(turnIds[0] ?? '')
  const sid3 = shapeOf(turnIds[2] ?? '')
  say(
    `  形状对照    T1: summaryChars=${String(sid1?.summaryChars ?? '?')} ` +
      `historyIncluded=${String(sid1?.historyIncluded ?? '?')} compactedThroughSeq=${String(sid1?.compactedThroughSeq ?? '?')}`
  )
  say(
    `              T3: summaryChars=${String(sid3?.summaryChars ?? '?')} ` +
      `historyIncluded=${String(sid3?.historyIncluded ?? '?')} compactedThroughSeq=${String(sid3?.compactedThroughSeq ?? '?')}`
  )
  if (!sid1 || !sid3) {
    check(
      'unknown',
      '⚠️ 第 1 轮或第 3 轮的 [ctx] 形状没拉到 —— 「压缩真的进了数组」这一半**无法判定**' +
        '（库里那一半仍然有效，但缺了它就只能说「压了」，不能说「生效了」）'
    )
  } else {
    check(
      Number(sid1.summaryChars) === 0 && Number(sid1.compactedThroughSeq) === 0 ? 'ok' : 'bad',
      `第 1 轮装配里没有摘要（summaryChars=${String(sid1.summaryChars)}）—— 那时水位线还是 0`
    )
    check(
      Number(sid3.compactedThroughSeq) > 0 ? 'ok' : 'bad',
      `★ 第 3 轮装配时水位线 > 0（实得 ${String(sid3.compactedThroughSeq)}）—— 装配层真的读到了库里的水位线`
    )
    check(
      Number(sid3.summaryChars) > 0 ? 'ok' : 'bad',
      `★★ 第 3 轮装配里 <summary> 块**真的拼进去了**（summaryChars=${String(sid3.summaryChars)}）—— ` +
        '这是「压缩生效」的唯一直接证据：库里写了而装配没读，这一条会为 0'
    )
    check(
      Number(sid3.historySuppressed) > 0 ? 'ok' : 'bad',
      `★ 第 3 轮有 ${String(sid3.historySuppressed)} 条历史被水位线挡在数组之外（实得 ${String(sid3.historySuppressed)}）`
    )
    const ctlTotal = Number(sid3.historyTotal ?? 0)
    const ctlIncluded = Number(sid3.historyIncluded ?? 0)
    check(
      ctlTotal > ctlIncluded ? 'ok' : 'bad',
      `数组比取到的历史短（included=${ctlIncluded} < total=${ctlTotal}）—— ` +
        '被挡掉的那些在数组里真的不在，而不只是「库里标了个状态」'
    )
  }

  // ══ 累积 ═══════════════════════════════════════════════════
  rule('累积 · 第二次压缩不许丢掉第一段')
  const summaryFinal = summaryOf(dFinal, sessionId)
  const throughFinal = throughOf(dFinal, sessionId)
  const t1Text = String(markers?.textT1 ?? '___')
  const t2Text = String(markers?.textT2 ?? '___')
  check(
    summaryFinal !== null && summaryFinal.includes(t1Text.slice(0, 24)) ? 'ok' : 'bad',
    `★★ 第 3 轮又压了一次（水位线 ${throughFinal}）之后，摘要里**仍然有第一段**` +
      `（找的是「${t1Text.slice(0, 24)}…」）—— 第二次折叠丢掉第一轮的样子是` +
      '「水位线一路前进，而摘要里没有它」，它不报错'
  )
  check(
    summaryFinal !== null && summaryFinal.includes(t2Text.slice(0, 24)) ? 'ok' : 'bad',
    `摘要里也有第二段（「${t2Text.slice(0, 24)}…」）—— 新折进来的那些确实进去了`
  )
  check(
    summaryFinal !== null && (summaryFinal.match(/【已折叠的历史摘要】/g) ?? []).length === 1
      ? 'ok'
      : 'bad',
    `★ 摘要里**只有一条标题行**（实得 ${
      summaryFinal === null ? 'null' : (summaryFinal.match(/【已折叠的历史摘要】/g) ?? []).length
    } 条）—— 标题重复是「上一轮的摘要被整段接上去」的样子，而那样它会长得越来越快`
  )
  const totalMsgs = msgsInSession(dFinal, sessionId)
  /**
   * ★★ 真机上第一次看清的一处粗糙：**我们自己的那条折叠说明会被再折一次**。
   *
   * 说明行（`role:'system'`、没有 `turn_id`）本身也是 `message` 里的一行、`inject_mode='full'`，
   * 于是下一次压缩把它当历史折进摘要，得到 `[5] 【系统】 【系统】历史上下文已压缩：seq ≤ 2 …` ——
   * 标签重了一次（`summaryEntryOf` 加一个、行文自带一个）。
   *
   * 为什么**这一趟不改它**：它不撒谎（没有假声明，原文仍在库里），也不多泄露任何东西
   * （那一行本来就作为系统消息进下一轮的上下文）；而改它要么动 `listBySessionBetween`
   * 的谓词、要么给这一行一个专门的标记，两者都要重跑真机（读数会变）——
   * 在里程碑最后一步换掉一条已经印成结论的读数，不划算。**如实记下来，交给下一次判断。**
   */
  const selfFolded =
    summaryFinal === null ? 0 : (summaryFinal.match(/【系统】 【系统】历史上下文已压缩/g) ?? []).length
  say(
    `  ★ 一处如实记下的粗糙：摘要里有 ${selfFolded} 条骨架是**我们自己的折叠说明**被再折了一次` +
      '（形如「[5] 【系统】 【系统】历史上下文已压缩：seq ≤ 2 …」）—— 标签重了一遍，' +
      '而那行内文里的条数是**当时**的读数。不影响正确性（原文仍在库里、也没有假声明），' +
      '但它只在这个规模下才看得见，所以每次重放都要重新看一眼'
  )
  const foldedFinal = totalMsgs.filter((m) => m.inject_mode === 'summary')
  const triggerFinal = msgOf(dFinal, turnsFinal[2]?.trigger_message_id)
  check(
    String(triggerFinal?.inject_mode ?? '') === 'full' ? 'ok' : 'bad',
    `★★ 第 3 轮的触发消息**仍然是 full**（实得 ${String(triggerFinal?.inject_mode ?? '?')}）—— ` +
      '每一轮都要重新证一次：水位线是「本轮之前」，不是「本轮为止」'
  )
  say(
    `  折叠进度    会话里共 ${totalMsgs.length} 条，其中 summary ${foldedFinal.length} 条、` +
      `full ${totalMsgs.filter((m) => m.inject_mode === 'full').length} 条、` +
      `excluded ${totalMsgs.filter((m) => m.inject_mode === 'excluded').length} 条（本趟应当恒为 0）`
  )
  check(
    totalMsgs.every((m) => m.deleted_at === null) ? 'ok' : 'bad',
    '★ 压缩**只改 inject_mode，不删数据** —— 原文仍在库里（这是「模型视角的丢失」，不是真丢）'
  )

  // ══ CLI 自己的压缩 ═════════════════════════════════════════
  rule('CLI 自己的压缩信号（预判：一次都不出现，且不许为它调参数）')
  const cliSignals = warns.filter((w) => String(w.tag) === 'compaction:cli-signal')
  const boundaries = recs.filter(
    (r) => r.kind === 'warn' && String(r.line ?? '').includes('compact-boundary')
  )
  if (cliSignals.length === 0 && boundaries.length === 0) {
    check(
      'ok',
      '★ 如预判：CLI 的 compact_boundary / compact_result **一次都没出现** —— ' +
        '这是算术的必然（我们的阈值是 2 条消息，CLI 的以万级 token 计，我们永远先压），' +
        '**不是**「CLI 不会压缩」。这条判据只在这个沙箱历史规模下成立'
    )
  } else {
    const lines = cliSignals.map((w) => wrapped(String(w.line), 160))
    check(
      cliSignals.length > 0 && cliSignals.every((w) => String(w.line).includes('cli-signal'))
        ? 'ok'
        : 'unknown',
      `观测到 CLI 自己的压缩信号 ${cliSignals.length} 条（这是本次真机**新的**事实，要写进 §六）：` +
        lines.map((l) => `\n        ${l}`).join('')
    )
  }

  // ══ 标定 ═══════════════════════════════════════════════════
  rule('标定映射（shape ↔ usage）—— ★ 这是**上界**，不是「我们拼了多少 token」')
  say('  轮次   historyIncluded/historyTotal  summaryChars  contentChars   in     cacheRead  cacheCreation  合计')
  for (const [i, tid] of turnIds.entries()) {
    const sh = shapeOf(tid)
    const u = usageOf('A', tid)
    const total = (u?.in ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheCreation ?? 0)
    say(
      `  T${i + 1}     ${String(sh?.historyIncluded ?? '?')}/${String(sh?.historyTotal ?? '?')}` +
        `${' '.repeat(Math.max(1, 22 - `${String(sh?.historyIncluded ?? '?')}/${String(sh?.historyTotal ?? '?')}`.length))}` +
        `${String(sh?.summaryChars ?? '?').padEnd(14)}` +
        `${String(sh?.contentChars ?? '?').padEnd(13)}` +
        `${String(u?.in ?? '?').padEnd(7)}${String(u?.cacheRead ?? '?').padEnd(11)}` +
        `${String(u?.cacheCreation ?? '?').padEnd(15)}${total || '?'}`
    )
  }
  say('  ★ 口径：usage 是 CLI **整条请求**的用量，**包含 CLI 自己加的 system prompt 与工具定义**')
  say('     —— 它比「我们拼的上下文」大得多，所以这是**上界**，两者不能互相换算（§5.3a）。')
  say('  ★ 另一条口径：`cacheRead` 非零只说明这一轮**命中了缓存**，它的成因是端点侧的，')
  say('     本走查不为它下任何结论（§5.4 / §8.9-16）。')

  // ══ 收尾 ═══════════════════════════════════════════════════
  rule('收尾')
  const graceful = String(pick('note', 'A:graceful-exit')?.text) === 'true'
  check(graceful ? 'ok' : 'unknown', `应用${graceful ? '正常退出' : '没能正常退出（已硬杀）'}—— 与本轮的判据无关，如实记`)
  for (const o of [through1, through2, throughFinal]) {
    if (o < 0) check('bad', '有一份转储里读不到水位线 —— 那个时点的判据是空转的')
  }

  rule('结束')
  say(`  归档目录：${runDir}`)
  say(
    `  结论     ${failures === 0 ? '全部通过' : `${failures} 条不通过`}` +
      (unknowns ? `（另有 ${unknowns} 条「无法判定」）` : '')
  )
  say('  ⚠️ 端点限定语：全部结论只在**本机默认凭据所指向的端点**下成立，不是 Anthropic 官方行为。')
  say('  ⚠️ 一条留白：本走查只覆盖「同一个会话里攒够条数」这一种触发形态 ——')
  say('     字符硬闸（400k 估算）与读取上限（500 条）在这三轮里都碰不到，它们只有单测。')
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
        '    npm run walk:m7c:replay -- --archive=scripts/evidence/m7c-<时间戳>\n' +
        '故意不带默认值 —— 这个命令**不该**在忘了参数的时候顺手跑一次真采集（那会花钱）。\n'
    )
    return finish(1)
  }
  if (archive) {
    loadArchive(archive)
    rule('M7c 走查 · 重放归档（零成本）')
    return finish(report() === 0 ? 0 : 1)
  }

  const dir = argValue('out') ?? join(EVIDENCE_ROOT, `m7c-${stamp()}`)
  rule('M7c 走查 · 采集')
  say(`  归档目录        ${dir}`)
  say(
    DRY
      ? '  干跑：只开界面、**不发任何轮次**，不花钱。'
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
