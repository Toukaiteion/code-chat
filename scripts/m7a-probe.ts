/**
 * M7a 探针：**`--input-format stream-json` 的 stdin 到底能不能收多条消息。**
 *
 * ## ★ 实测结论（2026-09-23 两次真跑，`scripts/evidence/m7a-2026-09-23T16-48-*` 与 `…16-51-*`）
 *
 * （顺手记一笔：上面那个通配**不能写成「16-4 紧跟一个星号再紧跟一个斜杠」**——
 * 那个两字符序列会提前闭合本段块注释，
 * 于是整个文件从那里往下被当成代码，`tsc` 报的错误落在**二十行之外**一个看着完全正常的地方。
 * 与 M6b 被咬过两次的裸反引号是同一类错：`tsc` 不看注释和模板字符串**里面**的内容。）
 *
 * 那把原来那个断言**推翻了**，逐字如下：
 *
 * 1. **内层 `message.role` 只能是 `'user'`。** 写 `assistant` →
 *    `Error: Expected message role 'user', got 'assistant'`；写 `system` → 同形报错。
 *    ⇒ **§4.6 那个「`messages` 是 `{role:'user'|'assistant'}` 数组」的形态不成立。**
 * 2. **一行的上下文只能装在一行里。** 3 条 user 行给出 **2 条 `result`**，切在 `1 | {2,3}`：
 *    第 1 轮的模型只看得见第 1 行的标记，第 2 轮看得见全部三条，且第 2 轮
 *    `cache_read_input_tokens ≈ 21k` —— 它**接着第 1 轮的会话**在跑。
 *    ⇒ 这个协议是**多轮对话**协议，不是「一轮的多条消息」协议。
 *    ⇒ 3 行给 2 条（不是 3 条）说明**切点由缓冲区里已经躺了几行决定**，不归我们管 ——
 *    「取决于时序」比「一定是 N」更糟：换台机器/换个负载就可能给出不同的轮数。
 * 3. **`.claude/CLAUDE.md` 也被自动注入**（与根 `CLAUDE.md` 一样），`AGENTS.md` 没有。
 *    ⇒ §4.2 逐字警告的「只剔根那一份就仍是两遍」**说中了**。
 *
 * **⇒ 对 M7a 的后果**：`context-builder` 的产物必须是**一条** user 行，
 * 由 `renderTurnInput()` 那样拼成（它是纯追加的 `join('\n\n')`，第 N 轮是第 N+1 轮的字节前缀，
 * 所以**不破坏前缀缓存**）。§4.4e 的「`run()` 恰好一次 `done`」**没有被推翻**，
 * 但保住它的原因变了：不是 CLI 保证一行的上下文只算一轮，而是**我们只发一行**。
 *
 * 三条都只在**本机默认端点**（`api.deepseek.com/anthropic`）下成立，不是 Anthropic 官方行为。
 * 同一次真跑里 stderr 还有 `[claude-code:unrecognized_model] {"model":"deepseek-flash"}`——
 * 探针的默认模型名在这个端点上不被识别，但轮次照常跑完。那个串**与上面三条无关**，
 * 记在这里只是为了下次看到它时不必重新怀疑一遍。
 *
 * ## 它测的是什么，以及为什么非测不可
 *
 * §4.6 的整个上下文装配方案建立在一个**从未实测过的断言**上：
 * 「stdin 的 stream-json 输入本来就支持多条消息，包括 assistant 角色的历史」。
 * `design.md:1173` 是这么写的，但那是**断言**，不是实测 —— 五处代码/文档都标着它未实测
 * （`control-protocol.ts` 文件头的「M5 的一处明知故犯」、`claude-adapter.ts:48-52`、
 * `design.md` §4.4e 末与 §8.9 待办第 19 条、`architecture.md:642`）。
 *
 * 现状是：生产侧 `claude-adapter.ts` 往 stdin **只写一行**，
 * 由 `renderTurnInput()` 把消息数组拍平成一块文本。真正的历史装配是 M7 的活，
 * 而它必须先知道「数组能不能原样送出去」。
 *
 * ## ★ 失败模式不是「被拒绝」，是「被接受成 N 轮」
 *
 * ★ **这一条已经被实测证实了**（上面第 2 条）—— 但它**不是**靠这条推理发现的，
 * 是 D 臂顺手抓到的：A 臂被拒后，本来没人知道「多条 user 行」会怎样。
 *
 * 这是我读完 §4.4e 才想明白的一条：如果 CLI 把每一条 user 行当成**一次新的 `-p` 轮**，
 * 它会吐出 N 条 `result`。这个后果**比拒绝严重得多**，而且**会被现有代码掩盖**：
 * `claude-adapter.ts` 消费到 `done` 就 `closeStdinOnResult`（默认 `true`）
 * **在第一行上 `stdin.end()`**，于是 result #2..N 可能被我们自己掐掉。
 * 症状是「一轮用户消息在界面上变成一条被折叠的助手消息，成本只记了 1/N」——
 * 一个安静的、看起来完全正常的错。
 *
 * 所以**本探针单条价值最高的断言是：数归档里 `type:"result"` 的行数。**
 *
 * ## 为什么不能用 stdout 的行类型判「多发了几条」
 *
 * 因为 **CLI 不回显我们写进 stdin 的 user 行**。这已对 M5 全部归档独立复核过：
 * `main.ndjson` 里 9 条 `type:"user"` 行**全部**是 `tool_result`，
 * `stdin-on.ndjson` 里 **0 条** user 行。⇒ 「多发了一行」这件事在输出侧没有回声。
 *
 * 所以判据只能靠**只存在于注入侧的随机标记串 + 模型逐字复述**
 * （`m5-probe.ts` 的 `MK-SYS-c19f6` 那次成功先例证明了这条路可走：
 * 标记只存在于注入侧，模型**没有任何工具**能读到它）。
 *
 * ## 四臂
 *
 * | 臂 | 写进去的 | 期望 | 判什么 |
 * |---|---|---|---|
 * | **A** | 3 行：user(历史) / **assistant**(历史) / user(本轮) | **拒** | **负对照**：assistant 角色被拒（实测已成立） |
 * | **B** | 1 行：`renderTurnInput()` 的**现产扁平文本**（含同样三个标记） | **1 条** | 生产现状。**唯一能承载一轮上下文的形状**，也是自动注入补测的载体 |
 * | **C** | 2 行：`role:'system'` 的历史行 / user(本轮) | **拒** | **负对照**：`role:'system'` 被拒（实测已成立），§5.6 的落法要改 |
 * | **D** | 3 行：**全是 user**（历史 / 上一条回答 / 本轮） | **多条** | **负对照**：3 行 → 2 条 result（切在 `1\|{2,3}`）⇒ 整轮上下文只能是一条 |
 *
 * ★ **D 臂是补 A 臂的空白**：A 同时改了两件事（行数、role），而失败信息指向 role。
 * 所以第一次真跑**没有**测到「多条 user 行」行不行 —— 而那正是「数组装配走不走得通」的关键。
 * D 与 A 只差那一个 role 字节，正好把变量隔离出来，**它给出了最关键的那条否证**。
 *
 * A/C/D 三臂的期望值都是**在真跑之后**按实测改的（见文件头）。它们现在守的是
 * 「哪天 CLI 改了，这份结论要重判」—— 都是**回归断言**，不再是待测假设。
 * 被拒的臂**不判标记复述**：整轮没跑，标记当然一个都不在，列出来只会印假 ❌。
 *
 * ## 顺带补测：另外几个项目记忆文件会不会被 CLI 自动注入
 *
 * §8.5c-1 实测出**一条不对称**：cwd 的 `CLAUDE.md` 被 CLI 自动注入，
 * 而 `--add-dir` 目录里的 `CLAUDE.md` 整轮从未进上下文。
 * 但那个实测**只覆盖了 `CLAUDE.md` 一份**，而 `PROJECT_CONTEXT_SOURCES` 有七个路径。
 * 如果 CLI 也自动注入 `.claude/CLAUDE.md`，那么 M7a 只剔根目录那份就是**内容进两遍**。
 * 所以工作区里同时放 `.claude/CLAUDE.md` 与 `AGENTS.md`，各埋一个标记，
 * 判据仍是**行类型**（第一次出现在 `assistant` 行且之前没有 `tool_result` = 自动注入）。
 * 实测：`.claude/CLAUDE.md` **也被注入** —— 只剔根那份的担心是**真的**。
 *
 * ## 两条纪律
 *
 * 1. **报告是归档的纯函数**，`--archive=<dir>` 零成本重判。改判据不需要再买一轮
 *    —— 一个需要重新花钱才能复核的结论，实际上是不复核的。
 * 2. **`--dry` 先跑**：打印每条臂将要写进 stdin 的逐行载荷与 argv，**一个字节都不 spawn**。
 *
 * ## ★ 本探针比 m5-probe 多做的一件事：**把注入侧也落档**
 *
 * m5-probe 只落 stdout（`onRawChunk`）。但重放时若不归档**输入**，
 * 报告就**无法知道自己在看哪条臂** —— 「A 臂应该有几行」这个判据只能来自输入。
 * 所以每条臂额外写一份 `stdin-<label>.jsonl`（逐行载荷原文）。
 * 这是 §8.8e 规则三（证据缺失不许印成 ✅）往前推一步。
 *
 * **stderr 也是同一天补进归档的**：「被拒」在 stdout 侧的痕迹只是「0 行」，
 * 它证明得了「被拒」却证明不了**为什么** —— 而理由逐字在 stderr 里。
 * 一个重放时不可复核的结论，实际上是不复核的。
 *
 *     npm run probe:m7a:dry     # 零成本：打印载荷与 argv
 *     npm run probe:m7a         # ★ 花钱：真 CLI，四条臂
 *     npm run probe:m7a -- --archive=scripts/evidence/m7a-<时间戳>
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildClaudeArgs } from '../src/main/adapters/claude/claude-adapter.ts'
import { claudeSearchHint, resolveClaude } from '../src/main/adapters/claude/cli-locator.ts'
import { renderTurnInput, userMessageLine } from '../src/main/adapters/claude/control-protocol.ts'
import type { TurnContext } from '../src/main/adapters/agent-adapter.ts'

// ─────────────────────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────────────────────

interface ProbeArgs {
  model: string
  budget: number
  turnTimeoutMs: number
}

function argValue(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const DRY = process.argv.slice(2).includes('--dry')

function parseArgs(): ProbeArgs {
  return {
    // 模型名**没有默认值可猜**：这台机器上默认凭据指向的端点认哪个名字，只有跑一次才知道。
    model: argValue('model') ?? process.env.CODE_CHAT_PROBE_MODEL ?? 'deepseek-flash',
    budget: Number(argValue('budget') ?? '0.5'),
    turnTimeoutMs: Number(argValue('turn-timeout-ms') ?? '180000')
  }
}

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────

const say = (s = ''): void => {
  process.stdout.write(s + '\n')
}
const rule = (title: string): void => {
  say()
  say(`──── ${title} ${'─'.repeat(Math.max(4, 66 - title.length))}`)
}
const quote = (s: string, n = 200): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…（共 ${one.length} 字）` : one
}
/** 一项结论。三态是刻意的：**「没测到」与「测到是坏的」是两回事**，不许合并。 */
function check(level: 'ok' | 'bad' | 'unknown', text: string): void {
  const mark = level === 'ok' ? '✅' : level === 'bad' ? '❌' : '⚠️'
  say(`  ${mark} ${text}`)
}

// ─────────────────────────────────────────────────────────────
// 归档
// ─────────────────────────────────────────────────────────────

/**
 * 归档目录。**刻意不叫 `out/`** —— 仓库根的 `.gitignore` 里有一条 `out/`
 * （本意是 electron-vite 的构建产物），而 gitignore 的模式**匹配任意层级**，
 * 于是 `scripts/out/` 会被**安静地忽略掉**：证据在盘上，却永远进不了版本库，
 * 而「留档」这件事看起来是做了的。
 */
const EVIDENCE_ROOT = join(import.meta.dirname, 'evidence')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUN_DIR = join(EVIDENCE_ROOT, `m7a-${STAMP}`)

const stdoutPathOf = (label: string): string => join(RUN_DIR, `${label}.ndjson`)
const stdinPathOf = (label: string): string => join(RUN_DIR, `stdin-${label}.jsonl`)
/**
 * ★ stderr 也归档。原先它只在内存里、只当「观测那一轮的副产品」打印。
 * 但「被拒」这件事的**理由**（`Expected message role 'user', got 'assistant'`）
 * **只在 stderr 里**：stdout 侧的证据是「0 行」，它证明了「被拒」却证明不了「为什么」。
 * 于是重放时那条结论不可复核 —— 而复核正是归档存在的理由（§8.8e 规则三）。
 */
const stderrPathOf = (label: string): string => join(RUN_DIR, `stderr-${label}.txt`)

// ─────────────────────────────────────────────────────────────
// 标记与工作区
// ─────────────────────────────────────────────────────────────

/** 每次跑重新掷一遍后缀 —— 旧归档与新归档混起来时，一眼能看出不是同一次。 */
const newNonce = (): string => Math.random().toString(16).slice(2, 7)

const markersOf = (nonce: string) =>
  ({
    /** 历史里那条 user 行（只存在于注入侧）。 */
    histU: `MK-HIST-U-${nonce}`,
    /** 历史里那条 assistant 行。 */
    histA: `MK-HIST-A-${nonce}`,
    /** 本轮的触发行。★ 这条必须单独有一个，否则 1/2 的成功可能是「前几行被当轮次、最后一行才是答案」的假象。 */
    cur: `MK-CUR-${nonce}`,
    /** C 臂那条 system 行。 */
    sysArm: `MK-SYSARM-${nonce}`,
    /** cwd 的 CLAUDE.md —— **已知**会被自动注入，这里是对照组。 */
    root: `MK-ROOT-${nonce}`,
    /** cwd 的 .claude/CLAUDE.md —— 未知，补测。 */
    dotClaude: `MK-DOTCLAUDE-${nonce}`,
    /** cwd 的 AGENTS.md —— 未知，补测。 */
    agents: `MK-AGENTS-${nonce}`
  }) as const

type Markers = ReturnType<typeof markersOf>
type MarkerKey = keyof Markers

let NONCE = newNonce()
let MARKERS: Markers = markersOf(NONCE)

/**
 * ★ 重放时必须把后缀**换回归档那一次的**。
 *
 * 这一条是 2026-09-23 那份归档第一次重放时抓出来的，症状极具误导性：
 * 报告印的标记是 `MK-HIST-U-d034e`，而模型答复里逐字写着 `MK-HIST-U-4b290`，
 * 于是每一条标记断言都判成「一次都没出现」，**而正确答案就印在它下面一行**。
 *
 * 根因是 `NONCE` 在模块加载时新掷：它是**代码里的常量**，不在归档里。
 * 于是「报告是归档的纯函数」这句话在最要紧的地方**是假的** ——
 * 一个重放会得到不同结论的报告，等于没有重放。
 * ⇒ 现在重放时从归档的 `stdin-*.jsonl` 里把它**读回来**（那是它唯一的出处）。
 */
function useNonce(n: string): void {
  NONCE = n
  MARKERS = markersOf(n)
}

/**
 * 从归档里把那次的后缀反推出来。
 *
 * 判据是 `MK-<名字>-<后缀>` 这个形状本身 —— 它由本文件定义，所以反推是可靠的。
 * 取**多数**而不是第一个：万一某次跑写了别的串进来，多数票更稳。
 */
function nonceFromArchive(stdinRaws: readonly string[]): string | null {
  const tally = new Map<string, number>()
  for (const raw of stdinRaws) {
    for (const m of raw.matchAll(/MK-[A-Z]+(?:-[A-Z]+)*?-([0-9a-f]{4,8})\b/g)) {
      tally.set(m[1], (tally.get(m[1]) ?? 0) + 1)
    }
  }
  let best: string | null = null
  let bestN = 0
  for (const [n, c] of tally) if (c > bestN) [best, bestN] = [n, c]
  return best
}

interface Workspace {
  root: string
}

async function makeWorkspace(): Promise<Workspace> {
  const root = join(RUN_DIR, 'ws')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, '.claude'), { recursive: true })

  await writeFile(join(root, 'CLAUDE.md'), `# 探针工作区\n\n本项目记忆标记：${MARKERS.root}\n`, 'utf8')
  await writeFile(
    join(root, '.claude', 'CLAUDE.md'),
    `# 探针工作区（.claude 版）\n\n本项目记忆标记：${MARKERS.dotClaude}\n`,
    'utf8'
  )
  await writeFile(join(root, 'AGENTS.md'), `# 探针工作区（AGENTS）\n\n本项目记忆标记：${MARKERS.agents}\n`, 'utf8')
  await writeFile(join(root, 'src', 'a.ts'), 'export const x = 1\n', 'utf8')
  return { root }
}

const SYSTEM_PROMPT = [
  '你是一个用于验收的探针 agent。请严格按用户要求逐项如实回答，不要猜测、不要补充。',
  '你没有必要调用任何工具 —— 这一轮要测的正是「你一开始就知道什么」。'
].join('\n')

/**
 * 三条臂共用的**本轮**提示词。
 *
 * ⚠️ 刻意问「在做任何工具调用之前就已经看到的」，不问「你现在能看到的」——
 * 后者会让模型去 Glob+Read 一遍，于是「自动注入」与「工具读到」在自述里长得一模一样。
 * §8.5c-1 记着这个坑：M5 第一版就是这么把两个 `--add-dir` 的 CLAUDE.md 印成「都进上下文了」的。
 * **模型的自述只能当旁证，真正的判据在归档的行类型里。**
 */
function currentPrompt(): string {
  return [
    // ★ 本轮自己的标记**必须**在这条载荷里。
    // 没有它，「历史那两行被接受了」与「只有最后一行被接受了」在归档里长得一模一样 ——
    // 也就是说，前两行的 ✅ 可能是「前几行被当轮次、最后一行才是答案」的假象。
    `（本轮触发行，标记 ${MARKERS.cur}。）`,
    '',
    '请只做一件事，不要调用任何工具：',
    '',
    '把你**在这一轮开始、做任何工具调用之前**就已经在上下文里看到的、',
    '形如 `MK-…` 的标记串，逐字列出来，并说明你是在哪一类内容里看到的',
    '（系统提示词 / 工作区记忆 / 前面的对话）。',
    '',
    '没看到就说没看到，**不要猜、不要去读文件凑答案**。'
  ].join('\n')
}

/** C 臂用：照 `userMessageLine()` 改内层 role（见文件头对这两条形状的说明）。 */
function systemMessageLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'system', content: [{ type: 'text', text }] }
  })
}

interface Arm {
  label: string
  title: string
  why: string
  /** 逐行写进 stdin 的 **NDJSON 原文**（不带换行符）。 */
  lines: string[]
  /**
   * 这一臂**预期**CLI 怎么对待它。三种形态，都是在 2026-09-23 真跑之后按实测写死的：
   *
   * - `'reject'`  —— 内层 `message.role` 不是 `'user'`：CLI **在解析 stdin 阶段就拒掉整轮**
   *   （stderr 逐字 `Error: Expected message role 'user', got 'assistant'`，stdout **0 行**）。
   * - `'one-turn'` —— **一条** user 行：恰好 1 条 `result`。这是唯一能承载「一轮上下文」的形状。
   * - `'multi-turn'` —— **多条** user 行：吐出**不止一条** `result`（实测 3 行 → 2 条，切在 1|{2,3}）。
   *   这不是「多条要小心用」，是**不能这么用**。
   *
   * ★ 三个值都不是「我们想要它怎样」，而是**回归断言**：它们守的是
   * 「哪天 CLI 改了这些行为，这份结论要重判」。A/C/D 三臂因此都是负对照。
   */
  expect: 'reject' | 'one-turn' | 'multi-turn'
  /** 这一臂**应该**写进去几行 —— 重放时报告拿它判「归档里的输入是不是这一臂」。 */
  expectLines: number
  /**
   * 这一臂**自己**埋进去的标记（key 索引 `MARKERS`，值是这个标记代表什么）。
   *
   * ★ 必须逐臂声明，不能全局一张表：三条臂埋的标记本来就不同，
   * 用一张全局表去查，C 臂那两个根本不存在的标记会印出两条**假的 ❌** ——
   * 「我这一臂没埋它」与「埋了但没送到」是两回事，而它们在报告里长得一模一样。
   */
  expectMarkers: Array<[MarkerKey, string]>
}

function arms(): Arm[] {
  const prompt = currentPrompt()

  // A 与 B 用的是**同一组三条消息**，只是编码方式不同 —— 这样差异只能归因于「编码」。
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: `（历史）上一轮用户说过这句话。标记 ${MARKERS.histU}。` },
    { role: 'assistant', content: `（历史）我上一轮回答过这句话。标记 ${MARKERS.histA}。` },
    { role: 'user', content: prompt }
  ]

  return [
    {
      label: 'A-multi',
      title: '多条消息（含 assistant 历史）—— 负对照',
      why: '§4.6 原本押在它身上。实测**被拒**（内层 role 必须是 user），现在是回归断言。',
      lines: [
        userMessageLine(history[0].content),
        // 助手行：形状与 userMessageLine 对称，只改内层 role。
        JSON.stringify({ type: 'user', message: { role: 'assistant', content: [{ type: 'text', text: history[1].content }] } }),
        userMessageLine(history[2].content)
      ],
      expect: 'reject',
      expectLines: 3,
      // 被拒的臂**不判标记复述** —— 整轮都没跑，标记当然一个都不在。
      // 在这里列标记只会印出假 ❌：那与「埋了但没送到」长得一模一样（见 `Arm.expectMarkers` 的注释）。
      expectMarkers: []
    },
    {
      label: 'B-flat',
      title: '单条扁平文本（生产现状，对照臂）',
      why: '生产现在就是这么发的。它是**唯一**已知能跑通的形状 —— 所以它同时是自动注入补测的载体。',
      lines: [userMessageLine(renderTurnInput(history))],
      expect: 'one-turn',
      expectLines: 1,
      // 与 A 臂**同一组内容**，只是编码不同 —— 所以两者都成功才说明「多条没有额外收益」。
      expectMarkers: [
        ['histU', '历史 user 段'],
        ['histA', '历史 assistant 段'],
        ['cur', '本轮段']
      ]
    },
    {
      label: 'C-system',
      title: 'role:system 的历史行 —— 负对照',
      why: '§5.6 要求项目切换落成 message(role=system)。实测**被拒**，§5.6 的落法要改。',
      lines: [
        systemMessageLine(`（系统事件）工作目录已切换。标记 ${MARKERS.sysArm}。`),
        userMessageLine(prompt)
      ],
      expect: 'reject',
      expectLines: 2,
      // 同 A 臂：被拒的臂不判标记。
      expectMarkers: []
    },
    {
      label: 'D-multi-user',
      title: '多条消息（**全是 user 角色**）—— 负对照',
      why:
        '★ 这一臂补的是 A 臂**意外没答上**的那个问题。A 同时改了两件事（行数、role），' +
        '而它的失败信息指向 role ⇒ 「多条 user 行」到底行不行，第一次真跑没测到。' +
        '实测：**3 行 → 2 条 result**（切在 1|{2,3}）⇒ 整轮的上下文**只能是一条 user 行**。',
      lines: [
        userMessageLine(history[0].content),
        // ★ 同一条内容，**role 仍是 user** —— 与 A 臂只差这一个字节。
        userMessageLine(history[1].content),
        userMessageLine(history[2].content)
      ],
      expect: 'multi-turn',
      expectLines: 3,
      // 三条标记确实都进了上下文（第 2 轮的模型看得见全部三条）—— 所以标记判据仍然成立，
      // 它在这里证明的是「内容送到了」，而不是「送到了一条上下文里」。
      expectMarkers: [
        ['histU', '历史 user 行'],
        ['histA', '上一条回答（本臂里编码成 user 行）'],
        ['cur', '本轮触发行']
      ]
    }
  ]
}

// ─────────────────────────────────────────────────────────────
// 独立复读（不经过我们自己的解析器）
// ─────────────────────────────────────────────────────────────

type Json = Record<string, unknown>

function asObj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null ? (v as Json) : null
}

interface MarkerHit {
  marker: string
  /** 第几行（1 起）。 */
  line: number
  /** 那一行的 `type`。 */
  type: string
  /**
   * ★ 这条标记**之前**有没有出现过 `tool_result`。
   * `false` + 出现在 `assistant` 行 = **它在模型做任何工具调用之前就在上下文里** = 自动注入。
   */
  afterToolResult: boolean
  excerpt: string
}

interface ArmAnalysis {
  totalLines: number
  nonJsonLines: string[]
  typeHist: Array<[string, number]>
  /** ★★ 本探针的头号数字。 */
  resultCount: number
  resultSubtypes: string[]
  numTurns: number | null
  isError: boolean | null
  errorText: string | null
  /** 模型最终答复的正文（从 `assistant` 行的 content 块里拼）。 */
  assistantText: string
  markerHits: MarkerHit[]
}

function analyzeArm(raw: string): ArmAnalysis {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const parsed: Array<{ no: number; o: Json }> = []
  const nonJsonLines: string[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      const o = asObj(JSON.parse(lines[i]))
      if (o) parsed.push({ no: i + 1, o })
      else nonJsonLines.push(lines[i])
    } catch {
      nonJsonLines.push(lines[i])
    }
  }

  const typeHist = new Map<string, number>()
  const resultSubtypes: string[] = []
  const texts: string[] = []
  const markerHits: MarkerHit[] = []
  let resultCount = 0
  let numTurns: number | null = null
  let isError: boolean | null = null
  let errorText: string | null = null
  let sawToolResult = false

  const allMarkers = Object.values(MARKERS) as string[]

  for (const { no, o } of parsed) {
    const type = typeof o.type === 'string' ? o.type : '(无 type)'
    typeHist.set(type, (typeHist.get(type) ?? 0) + 1)

    const msg = asObj(o.message)
    const content = msg ? msg.content : null
    if (Array.isArray(content)) {
      for (const c of content) {
        const b = asObj(c)
        if (!b) continue
        if (b.type === 'tool_result') sawToolResult = true
        if (b.type === 'text' && typeof b.text === 'string' && type === 'assistant') texts.push(b.text)
      }
    }

    if (type === 'result') {
      resultCount++
      if (typeof o.subtype === 'string') resultSubtypes.push(o.subtype)
      if (typeof o.num_turns === 'number' && numTurns === null) numTurns = o.num_turns
      if (typeof o.is_error === 'boolean' && isError === null) isError = o.is_error
      if (typeof o.result === 'string' && errorText === null && o.is_error === true) errorText = o.result
    }

    // 标记：扫这一行的 JSON 原文。一条行里可能有多个标记，都要记。
    const lineText = JSON.stringify(o)
    for (const m of allMarkers) {
      if (!lineText.includes(m)) continue
      // 同一条标记在同一行里只记一次
      if (markerHits.some((h) => h.marker === m && h.line === no)) continue
      markerHits.push({
        marker: m,
        line: no,
        type,
        afterToolResult: sawToolResult,
        excerpt: quote(lineText, 220)
      })
    }
  }

  return {
    totalLines: lines.length,
    nonJsonLines,
    typeHist: [...typeHist.entries()].sort((a, b) => b[1] - a[1]),
    resultCount,
    resultSubtypes,
    numTurns,
    isError,
    errorText,
    assistantText: texts.join('\n'),
    markerHits
  }
}

// ─────────────────────────────────────────────────────────────
// 真跑一条臂
// ─────────────────────────────────────────────────────────────

interface ArmResult {
  label: string
  /** 我们**实际**写进 stdin 的行 —— 独立于 `arm.lines`，因为「想写」和「写成功」是两回事。 */
  wroteLines: string[]
  writeFailures: number
  archivePath: string
  stdinArchivePath: string
  raw: string
  analysis: ArmAnalysis
  wallMs: number
  exitCode: number | null
  timedOut: boolean
  stderr: string
}

/** 等子进程真的结束。到点返回 `false`（调用方负责硬杀）。 */
function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => {
      if (!done) {
        done = true
        resolve(false)
      }
    }, ms)
    child.once('close', () => {
      if (!done) {
        done = true
        clearTimeout(t)
        resolve(true)
      }
    })
  })
}

async function runArm(exe: string, ws: Workspace, args: ProbeArgs, arm: Arm): Promise<ArmResult> {
  const promptFile = join(RUN_DIR, `system-${arm.label}.txt`)
  await writeFile(promptFile, SYSTEM_PROMPT, 'utf8')

  const ctx: TurnContext = {
    turnId: arm.label,
    sessionId: `m7a-${arm.label}`,
    cwd: ws.root,
    // 这一项**不被使用** —— 探针自己写 stdin，绕开适配器的单行写入。
    // 留着它是为了让 `buildClaudeArgs` 拿到一份形状完整的 ctx（它读 model/effort/permissionMode/addDirs）。
    messages: [{ role: 'user', content: '(探针自己写 stdin，这一项不使用)' }],
    systemPrompt: SYSTEM_PROMPT,
    model: args.model,
    effort: 'low',
    permissionMode: 'acceptEdits',
    maxBudgetUsd: args.budget,
    addDirs: []
  }
  // ★ 用**生产**的 argv 构造函数 —— 探针要测的是那条真实契约，不是我自己拼的一份。
  const argv = buildClaudeArgs(ctx, promptFile)

  const t0 = Date.now()
  const child = spawn(exe, argv, { cwd: ws.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

  const out: string[] = []
  const err: string[] = []
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (t: string) => out.push(t))
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (t: string) => err.push(t))

  // ★ 逐行写进 stdin，**写完立刻 end()**。
  // 这一步是刻意的：只有让它见到 EOF，它才会把「它到底打算产出几条 result」全部吐完然后退出。
  // 不 end 的话，按 §8.9 已实测的结论，它会在终态之后一直等着我们（那是另一件事，M5 已测过）。
  const wroteLines: string[] = []
  let writeFailures = 0
  for (const line of arm.lines) {
    try {
      child.stdin?.write(line + '\n')
      wroteLines.push(line)
    } catch {
      writeFailures++
    }
  }
  child.stdin?.end()

  const exited = await waitExit(child, args.turnTimeoutMs)
  let timedOut = false
  if (!exited) {
    timedOut = true
    say(`  ⏱️ 墙钟超时（${args.turnTimeoutMs}ms）—— 硬杀。只点名这一个 pid，不用模式匹配。`)
    if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { encoding: 'utf8' })
    await waitExit(child, 8000)
  }

  const wallMs = Date.now() - t0
  const raw = out.join('')

  // 归档**三边**都落：输出侧、注入侧、以及「被拒的理由」那一侧。缺了注入侧，
  // 重放时报告不知道自己看的是哪条臂；缺了 stderr，重放时「为什么被拒」不可复核。
  const stdoutPath = stdoutPathOf(arm.label)
  const stdinPath = stdinPathOf(arm.label)
  const stderrPath = stderrPathOf(arm.label)
  const stderrRaw = err.join('')
  await writeFile(stdoutPath, raw, 'utf8')
  await writeFile(stdinPath, wroteLines.map((l) => l + '\n').join(''), 'utf8')
  await writeFile(stderrPath, stderrRaw, 'utf8')

  return {
    label: arm.label,
    wroteLines,
    writeFailures,
    archivePath: stdoutPath,
    stdinArchivePath: stdinPath,
    raw,
    analysis: analyzeArm(raw),
    wallMs,
    exitCode: child.exitCode,
    timedOut,
    stderr: stderrRaw
  }
}

// ─────────────────────────────────────────────────────────────
// 报告 —— ★ 只读归档
// ─────────────────────────────────────────────────────────────

/**
 * 一条臂的断言。**只吃归档里的东西**（`stdout.ndjson` + `stdin.jsonl`），
 * 不吃任何「观测那一轮时的副产品」（墙钟、退出码）。
 * 所以 `--archive` 重放能给出**同样的**结论。
 */
function reportArm(
  arm: Arm,
  stdoutRaw: string,
  stdinRaw: string,
  extra: { wallMs?: number; timedOut?: boolean; stderr?: string } = {}
): void {
  rule(`臂 ${arm.label}：${arm.title}`)
  say(`  这一臂在判什么  ${arm.why}`)

  const a = analyzeArm(stdoutRaw)
  const wrote = stdinRaw.split(/\r?\n/).filter((l) => l.trim())

  say(`  注入侧          归档里 ${wrote.length} 行，本臂应该 ${arm.expectLines} 行`)
  if (extra.wallMs !== undefined) {
    say(`  墙钟            ${extra.wallMs}ms${extra.timedOut ? '（⚠️ 触碰了墙钟超时 —— 这一轮是被我们打断的，不是它自己结束的）' : ''}`)
  }

  // ★ §8.8e 规则三：证据缺失不许印成 ✅。
  // 输入对不上时，下面每一条断言都失去依据 —— 所以先在这里拦住。
  if (wrote.length !== arm.expectLines) {
    check('bad', `归档里的输入是 ${wrote.length} 行，而这一臂应该写 ${arm.expectLines} 行 —— 归档与臂对不上，下面每一条断言都不成立`)
    say('      （多半是归档目录张冠李戴，或者写 stdin 时失败了。别基于这一份下任何结论。）')
    return
  }
  check('ok', `注入侧与本臂一致（${wrote.length} 行）—— 下面各条有依据了`)

  say(`  输出侧          ${a.totalLines} 行 JSON，${a.nonJsonLines.length} 行非 JSON`)
  say(`  行类型直方图    ${a.typeHist.map(([t, n]) => `${t}×${n}`).join('  ')}`)
  if (a.nonJsonLines.length) {
    for (const l of a.nonJsonLines.slice(0, 3)) say(`      非 JSON：${quote(l, 160)}`)
  }

  // ── 负对照臂：判「是不是被拒了」 ──
  if (arm.expect === 'reject') {
    say()
    if (a.totalLines === 0) {
      check('ok', 'CLI **在解析 stdin 阶段就把整轮拒了**（归档 0 行输出）—— 与实测一致，负对照成立。')
      if (extra.stderr?.trim()) say(`      stderr 逐字：${quote(extra.stderr, 300)}`)
      else say('      ⚠️ 归档里没有 stderr —— 「被拒」成立，但**为什么**被拒这次拿不到（§8.8e 规则三）。')
      say('      ⇒ 这**不是**「被忽略」，也**不是**「被接受成 N 轮」：整轮没跑，一个字都没产出。')
    } else {
      check(
        'bad',
        `预期被拒，实际产出了 ${a.totalLines} 行、${a.resultCount} 条 \`result\` ` +
          '—— **前提变了**。§8.9-19 那条结论（内层 role 必须是 user）要重判，别照抄。'
      )
      if (extra.stderr?.trim()) say(`      stderr：${quote(extra.stderr, 200)}`)
    }
    say(`  模型答复        （负对照臂不判正文）`)
    return
  }

  // ── ★★ 头号断言：result 的行数 ──
  say()
  if (a.resultCount === 0) {
    check('unknown', '一条 `result` 都没有 —— 这是**没测到**，不是「没问题」。这一轮没跑到能下结论的地方。')
    if (extra.stderr?.trim()) say(`      stderr 逐字：${quote(extra.stderr, 300)}`)
  } else if (arm.expect === 'one-turn') {
    if (a.resultCount === 1) {
      check('ok', '**1 行 → 恰好 1 条 `result`** —— 这是**唯一已知能承载「一轮上下文」的形状**。')
      say('      ⇒ `context-builder` 的产物必须是**一条** user 行，不能是数组。')
    } else {
      check(
        'bad',
        `预期 1 条 \`result\`，实际 ${a.resultCount} 条 —— **「一行一轮」这个前提变了**，§8.9-19 要重判。`
      )
    }
  } else {
    // expect === 'multi-turn'：负对照。判它**是不是仍然**吐多条。
    if (a.resultCount >= 2) {
      check(
        'ok',
        `**${arm.expectLines} 行 → ${a.resultCount} 条 \`result\`** —— 与实测一致，负对照成立：` +
          '多条 user 行**不是**「一轮的多条消息」，CLI 把它们拆成了多轮。'
      )
      say('      ⇒ 3 行给 2 条（而不是 3 条）说明**切点由缓冲区里已经躺了几行决定**，不归我们管。')
      say('         「取决于时序」比「一定是 N」更糟：同一份输入换个负载就可能给出不同的轮数。')
      say('      ⇒ 而且它**会被现有代码掩盖**：`claude-adapter.ts` 的 `closeStdinOnResult`')
      say('         在第一个 `done` 上就 `stdin.end()`，result #2..N 根本读不到。')
      say('         症状是「一轮消息只记了 1/N 的成本」—— 安静的、看起来正常的错。')
    } else if (a.resultCount === 1) {
      check(
        'bad',
        `预期多条 \`result\`，实际只有 1 条 —— **前提变了**：多条 user 行现在被当成了一轮。` +
          '这会让「整轮只能发一行」这条结论失效，§8.9-19 要重判，别照抄。'
      )
    } else {
      check('unknown', '一条 `result` 都没有 —— 这一臂这次**没测到**，不是「没问题」。')
    }
  }

  say(`  subtype         ${a.resultSubtypes.join(', ') || '（无）'}`)
  say(`  num_turns       ${a.numTurns === null ? '（无）' : String(a.numTurns)}`)
  if (a.isError) {
    say(`  is_error        true —— CLI 自报失败：${quote(a.errorText ?? '(没给原因)', 300)}`)
    say('      ⚠️ 这一轮失败了，下面关于标记的每一条都只是「没测到」。')
  }

  // ── 标记的复述 ──
  say()
  for (const [key, what] of arm.expectMarkers) {
    const m = MARKERS[key]
    const hit = a.markerHits.find((h) => h.marker === m)
    const recited = a.assistantText.includes(m)
    if (hit && !hit.afterToolResult) {
      check('ok', `${what} 的标记（${m}）出现在第 ${hit.line} 行的 \`${hit.type}\` 里，且**之前没有 tool_result** ⇒ 它一开始就在上下文里`)
    } else if (hit) {
      check('ok', `${what} 的标记（${m}）出现在第 ${hit.line} 行的 \`${hit.type}\` 里（在 tool_result 之后 —— 这一轮它调工具了）`)
    } else if (recited) {
      check('unknown', `${what} 的标记（${m}）**模型复述了**，但归档里没有任何一行含它 —— 自述与归档对不上，只能当旁证`)
    } else {
      check('bad', `${what} 的标记（${m}）在归档里**一次都没出现**，模型也没复述 ⇒ 这一行没被接受`)
    }
  }
  say(`  模型答复        ${quote(a.assistantText, 400) || '（没有 assistant 正文）'}`)
}

/**
 * 顺带补测：七个项目记忆路径里，除了根 `CLAUDE.md`，还有哪些也被自动注入。
 *
 * ★ `sources` 收**全部**臂，而不是点名一条 —— 这条是 2026-09-23 那次真跑补的。
 * 原先它固定读 A 臂，而 A 臂恰恰是**唯一 0 行输出**的那一条：
 * 于是阳性对照（根 `CLAUDE.md`）报「没成立」，另两条报「没被注入」——
 * 三条结论全是**空的归档喂出来的**。阳性对照诚实地喊了 ❌（这个设计是对的，
 * 它就是为这一天准备的），但底下的原因是「读错了臂」，不是「注入行为变了」。
 * ⇒ 现在：谁跑出了 `result` 就用谁；一条都没有，就如实说这件事**本次没测到**。
 */
function reportAutoInjection(sources: ReadonlyArray<{ label: string; raw: string }>): void {
  rule('补测：另外几个项目记忆文件会不会被 CLI 自动注入')
  say('  §8.5c-1 只实测了根 `CLAUDE.md`（被自动注入）与 `--add-dir` 里的（不进）。')
  say('  其余路径**没测过** —— 而不测就是默认，默认就是内容进两遍。')
  say('')

  const usable = sources
    .map((s) => ({ label: s.label, a: analyzeArm(s.raw) }))
    .filter((s) => s.a.resultCount > 0)
    // 优先取**一行一轮**的那条臂：它是生产形状，模型看到的东西与线上最接近。
    // 其余按 result 条数降序兜底（上下文越全越能看见所有标记）。
    .sort((x, y) => {
      const rank = (l: string): number => (arms().find((z) => z.label === l)?.expect === 'one-turn' ? 1 : 0)
      return rank(y.label) - rank(x.label) || y.a.resultCount - x.a.resultCount
    })

  if (usable.length === 0) {
    check('bad', '**本次没有一条臂跑出 `result`** —— 自动注入这件事这次**没测到**。别把下面当成结论。')
    say('      ⇒ 这通常意味着所有臂都被 stdin 解析拒了，或者全踩了墙钟闸。')
    return
  }

  const picked = usable[0]
  say(`  判据取自臂 ${picked.label}（它是跑出 result 的那一条；有 ${usable.length} 条可选）`)
  say('  判据仍是**行类型**：标记第一次出现在 `assistant` 行、且**之前没有 tool_result** ⇒ 一开始就在上下文里。')
  say('')

  const a = picked.a
  const cases: Array<[MarkerKey, string, boolean]> = [
    // key, 文件, 是不是**阳性对照**
    ['root', 'CLAUDE.md', true],
    ['dotClaude', '.claude/CLAUDE.md', false],
    ['agents', 'AGENTS.md', false]
  ]

  for (const [key, file, isControl] of cases) {
    const m = MARKERS[key]
    const hit = a.markerHits.find((h) => h.marker === m)
    const injected = hit !== undefined && !hit.afterToolResult && hit.type === 'assistant'
    const tail = isControl ? '（**阳性对照**：§8.5c-1 已实测它会被注入）' : '（M7a 补测项 —— §8.5c-1 当时没测这一份）'

    if (injected) {
      check(
        isControl ? 'ok' : 'bad',
        `${file} —— 第 ${hit.line} 行 \`assistant\` 里出现，**之前没有 tool_result** ⇒ **被自动注入**了${tail}`
      )
      if (!isControl) say('      ⇒ `context-builder` 必须**剔除自己那一份**，否则同一份内容进两遍。')
    } else if (hit) {
      check('unknown', `${file} —— 第 ${hit.line} 行 \`${hit.type}\` 里出现（在 tool_result 之后）⇒ 判不出是自动注入还是工具读的`)
    } else if (isControl) {
      // ★ 对照没成立时，**它自己就是一条 ❌**：后面那些「没被注入」的结论全都不可信了。
      check(
        'bad',
        `${file} —— **阳性对照没成立**：归档里一次都没出现它，而 §8.5c-1 已实测它会被注入。` +
          '这一轮要么跑得不对、要么端点变了 —— 下面几条「没被注入」的结论**据此不可信**。'
      )
    } else {
      check('ok', `${file} —— 归档里没有它 ⇒ 没被自动注入${tail}`)
    }
  }
  say('')
  say('  ⇒ 「被自动注入」的文件，`context-builder` 必须**剔除自己那一份**，否则同一份内容进两遍。')
}

function reportEnvironment(args: ProbeArgs, exe: string | null): void {
  rule('环境')
  say(`  node            ${process.version} (${process.platform} ${process.arch})`)
  say(`  CLI             ${exe ?? '❌ 没找到（剩下的都跑不了）'}`)
  say(`  模型            ${args.model}`)
  say(`  每臂预算硬闸    $${args.budget}  ⇒ 三条臂最坏 $${(args.budget * 3).toFixed(2)}`)
  say('                  ⚠️ §2.4-2：这个端点上的 cost 字段不可信，真正的兜底是墙钟超时')
  say(`  墙钟上限        ${args.turnTimeoutMs}ms / 臂`)
  say(`  本次标记后缀    ${NONCE}（重放时拿它确认归档与报告是同一次）`)
  // ── 端点溯源：只报「设了没有」，**绝不回显凭据本身** ──
  const envFlag = (k: string): string => (process.env[k] ? '已设置' : '未设置（不打印内容）')
  say(`  ANTHROPIC_BASE_URL      ${process.env.ANTHROPIC_BASE_URL ?? '未设置'}`)
  say(`  ANTHROPIC_AUTH_TOKEN    ${envFlag('ANTHROPIC_AUTH_TOKEN')}`)
  say(`  ANTHROPIC_API_KEY       ${envFlag('ANTHROPIC_API_KEY')}`)
  say('  ↑ 环境变量都没设时，凭据来自 CLI 自己的配置文件 —— **探针不读那个文件、也不回显任何凭据**。')
}

// ─────────────────────────────────────────────────────────────
// 干跑
// ─────────────────────────────────────────────────────────────

function dryRun(ws: Workspace, args: ProbeArgs): void {
  rule('干跑（--dry）：**一个字节都不 spawn**')
  say('  下面打印的是每条臂**将要写进 stdin 的逐行载荷**与生产 argv。')
  say('  载荷或 argv 拼错时，这一步的代价是零 —— 而真跑一轮的代价是钱。')
  say('')

  const promptFile = join(RUN_DIR, `system-<label>.txt`)
  const ctx: TurnContext = {
    turnId: '<label>',
    sessionId: 'm7a-<label>',
    cwd: ws.root,
    messages: [{ role: 'user', content: '(探针自己写 stdin，这一项不使用)' }],
    systemPrompt: SYSTEM_PROMPT,
    model: args.model,
    effort: 'low',
    permissionMode: 'acceptEdits',
    maxBudgetUsd: args.budget,
    addDirs: []
  }
  say('  ── argv（**逐字来自 `buildClaudeArgs()`**）──')
  for (const a of buildClaudeArgs(ctx, promptFile)) say(`      ${a}`)
  say('')

  for (const arm of arms()) {
    const want =
      arm.expect === 'reject'
        ? '预期：**被拒**（负对照）'
        : arm.expect === 'one-turn'
          ? '预期：**恰好 1 条 result**'
          : '预期：**多于 1 条 result**（负对照）'
    say(`  ── 臂 ${arm.label}：${arm.title}（${arm.lines.length} 行，${want}）──`)
    say(`     ${arm.why}`)
    for (let i = 0; i < arm.lines.length; i++) {
      say(`     第 ${i + 1} 行：${quote(arm.lines[i], 300)}`)
      // 逐行必须是合法 JSON —— 拼错了在这里就现形，不用等到真跑。
      try {
        JSON.parse(arm.lines[i])
      } catch (e) {
        say(`       ❌ 这一行不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    say('')
  }

  say('  ── 工作区里埋的标记 ──')
  for (const [k, v] of Object.entries(MARKERS)) say(`     ${k.padEnd(10)} ${v}`)
  say('')
  say('  干跑到此为止。要真跑：npm run probe:m7a（**会花钱**）')
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

async function replay(dir: string): Promise<void> {
  rule('重放模式（--archive）：以下结论全部来自归档，**本次没有 spawn 任何进程、没有花钱**')
  say(`  归档目录        ${dir}`)
  say('  ⚠️ 重放拿不到的东西：墙钟、退出码。')
  say('     它们不是归档的内容，是**观测那一轮时**的副产品。这里如实标成「重放不可得」。')
  say('     （stderr 原先也在这一列 —— 后来归档了，因为「被拒的理由」只在它里面。）')
  say('')

  // ★ 先把后缀从归档里读回来，**再**去构造臂。
  // 顺序是硬的：`arms()` 的载荷里就编着标记，反过来的话每条标记断言都会被判错。
  // 这里扫的是目录里实际存在的 `stdin-*.jsonl`，而不是代码里的臂清单 ——
  // 这样「归档里有什么」由归档自己说了算，加臂/删臂不会让旧归档读不出后缀。
  let nonceSource = '(没扫到 stdin 归档)'
  try {
    const names = (await readdir(dir)).filter((n) => n.startsWith('stdin-') && n.endsWith('.jsonl')).sort()
    const raws: string[] = []
    for (const n of names) raws.push(await readFile(join(dir, n), 'utf8'))
    const n = nonceFromArchive(raws)
    if (n) {
      useNonce(n)
      nonceSource = `${n}（从 ${names.length} 份 stdin 归档里反推）`
    }
  } catch {
    // 目录读不了 —— 下面的臂循环会给出更准确的报错，这里不抢它的戏。
  }
  say(`  标记后缀        ${nonceSource}`)
  say('                  ⚠️ 它是**代码里的常量**，不在归档里；不从归档反推的话，')
  say('                     重放会把每条标记都判成「没出现」—— 而正确答案就印在下面一行。')
  say('')

  // ★ 「这一臂这次没跑」与「这一步的证据拿不到」是两回事，不许合并：
  //   前者是**归档自己的范围**（老归档里没有后加的臂），后者才是失败。
  //   合并的代价很具体：加一条新臂会让**所有旧归档**从「可重放」变成「读不了」，
  //   而一个读不了的归档与一个没归档过的归档长得一模一样。
  const present: Array<{ label: string; raw: string }> = []
  let missing = 0
  for (const arm of arms()) {
    try {
      const stdoutRaw = await readFile(join(dir, `${arm.label}.ndjson`), 'utf8')
      const stdinRaw = await readFile(join(dir, `stdin-${arm.label}.jsonl`), 'utf8')
      let stderrRaw: string | undefined
      try {
        stderrRaw = await readFile(join(dir, `stderr-${arm.label}.txt`), 'utf8')
      } catch {
        // stderr 是后加的归档项 —— 老归档没有它，不算失败（见上面那段）。
      }
      reportArm(arm, stdoutRaw, stdinRaw, { stderr: stderrRaw })
      present.push({ label: arm.label, raw: stdoutRaw })
    } catch {
      missing++
      say(`  ⚠️ 臂 ${arm.label} 不在这份归档里 —— 这一臂**这一次没跑过**，不是「跑了但证据丢了」。`)
      say('     （多半是这份归档早于这条臂被加进来的时间。重判它需要重跑。）')
    }
  }

  if (present.length === 0) {
    say(`  ❌ 归档里一条臂都读不出来：${dir}`)
    say('     既不是缺一两条臂（那是 ⚠️），也不是某一份文件读不到 —— 是**这整个目录不对**。')
    process.exit(1)
  }
  if (missing > 0) {
    say('')
    say(`  ⚠️ 上面有 ${missing} 条臂不在这次归档里。这一份报告**只覆盖跑过的那些**。`)
  }
  reportAutoInjection(present)
}

async function main(): Promise<void> {
  const args = parseArgs()

  // 重放要在建目录、找 CLI 之前分叉 —— 它两样都不需要。
  const archive = argValue('archive')
  if (archive) {
    await replay(archive)
    return
  }

  await mkdir(RUN_DIR, { recursive: true })
  const ws = await makeWorkspace()

  if (DRY) {
    reportEnvironment(args, '(干跑不找 CLI)')
    say(`  工作区          ${ws.root}`)
    dryRun(ws, args)
    return
  }

  const exe = await resolveClaude()
  reportEnvironment(args, exe)
  say(`  工作区          ${ws.root}`)
  say(`  落档目录        ${RUN_DIR}`)

  if (!exe) {
    rule('找不到 CLI，剩下的都跑不了')
    const hint = await claudeSearchHint()
    say(`  找过：${hint.blindCandidates.join('\n        ')}`)
    say(`  PATH 上的 claude：${hint.whereMatches.join(', ') || '（无）'}`)
    process.exit(1)
  }

  rule('真跑（**这一步会花钱**）')
  say(`  ${arms().length} 条臂，每条一次独立 spawn。写完 stdin 立刻 end()，让它把话说完。`)
  say('  ⚠️ 负对照臂（预期被拒）**一样花钱** —— 它们也真的 spawn 了一次 CLI。')
  say('')

  const results: ArmResult[] = []
  for (const arm of arms()) {
    say(`▶ 臂 ${arm.label} —— ${arm.title}`)
    const r = await runArm(exe, ws, args, arm)
    results.push(r)
    if (r.writeFailures > 0) say(`  ⚠️ 有 ${r.writeFailures} 行写 stdin 失败`)
    if (r.stderr.trim()) say(`  stderr：${quote(r.stderr, 300)}`)
  }

  say('')
  say('═'.repeat(72))
  rule('报告（只读归档）')
  for (const r of results) {
    const stdinRaw = await readFile(r.stdinArchivePath, 'utf8')
    reportArm(arms().find((a) => a.label === r.label) as Arm, r.raw, stdinRaw, {
      wallMs: r.wallMs,
      timedOut: r.timedOut,
      stderr: r.stderr
    })
  }
  reportAutoInjection(results.map((r) => ({ label: r.label, raw: r.raw })))

  rule('结束')
  say('  归档都在上面那个目录里。**结论只在「本机默认端点」下成立**，不是 Anthropic 官方行为。')
  say('  回写 docs/design.md §4.6 / §8.9-19 时逐条带上端点限定语。')
  say('  重判不需要再花钱：npm run probe:m7a -- --archive=' + RUN_DIR)
}

main().catch((err: unknown) => {
  process.stderr.write(`\n探针自己崩了：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
