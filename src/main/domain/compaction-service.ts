import type { AgentDiagnostic } from '../adapters/agent-adapter.ts'
import { historyLabelOf, type HistoryMessage } from './context-builder.ts'

/**
 * §4.6 的**压缩** —— 判决在这里，落地在 `process/compaction.ts`。
 *
 * ## 为什么这个模块存在（它的另一半是 M7a 建好的）
 *
 * M7a 把压缩的**读侧**做完了：`context-builder` 按 `session.compactedThroughSeq`
 * 一刀切过滤历史、把 `rollingSummary` 包进 `<summary>` 块。缺的是**写侧**——
 * 谁来决定压、压到哪、摘要长什么样。那就是本模块。
 *
 * ★ 本模块是**纯的**：给定输入必得同一输出，不碰盘、不碰库、不知道 `Message` 是什么形状。
 * 它只认 `HistoryMessage`（装配层那个类型）——于是「摘要里的角色标签与历史里的
 * 是同一套词」这件事**由构造保证**，不是靠两处各写一遍再祈祷它们不漂移。
 *
 * ★ **零值导入。** `domain/` 下从 `infra/` 取值导入**没有先例**（`context-builder`
 * 与 `turn-runner` 都只有 `import type`）；值导入的先例在编排层（`process/fanout.ts`
 * 用 `sha256Hex`）。而摘要既不做哈希也不读文件，所以这里一个 `infra` 导入都不需要。
 *
 * ## ★★ 四条不许商量的纪律
 *
 * 1. **摘要必须累积。** 第二次压缩要把 `prev` 逐字带上，否则最早那段历史会被
 *    **静默吃掉** —— 库里 `compacted_through_seq` 一路前进，而摘要里没有它，
 *    模型于是以为那段历史从没发生过。这是本模块后果最重的一处：它不报错。
 *    `prev` 的**首行标题**要剥掉（换成新的），**其余一行不许动**。
 * 2. **剥不掉就逐字携带**（`prevUnparsed`）。那条降级路径只损失一个标签，绝不丢字。
 * 3. **超上限时从中间删，并在删除处写一行声明。** 口径是：**丢失可以发生，
 *    但必须自己说出来**。首尾都要保（开头是最早的历史，结尾是最近的）。
 * 4. **声明行永远不许被删**（上限小到荒谬时返回「标题 + 声明」）。
 *
 * ## 确定性：不调模型
 *
 * 摘要是**结构化骨架**，不是自然语言概括：每条历史折成一行
 * `[seq] 【说话人】正文首段（工具：…）`。理由（§4.6 已定）：调模型来概括会让
 * 压缩本身变成一次不可预测、要花钱、还要处理失败的操作；而骨架是**可重放的**——
 * 同一段历史折两次逐字节相同，于是「摘要错了」这件事在单测里就能钉死。
 *
 * ## 阈值都是**估算**，而且这里说的是**字符**不是 token
 *
 * `DEFAULT_COMPACT_CHAR_CEILING` / `DEFAULT_SUMMARY_MAX_CHARS` 是字符数。
 * 真实窗口大小未知（§5.3a 明说：我们查不到模型的实际上下文长度），所以这两个数
 * 是**估算，等 §2.4-3 有实测值再谈**。不要为了显得精确把它们调成别的数 ——
 * 那只会把「估算」伪装成「标定」。
 */

/** 待折条数 **≥** 它就压（是「达到」，不是「超过」）。 */
export const DEFAULT_COMPACT_AT_COUNT = 20

/** 待折正文的**字符**总数 ≥ 它就压（长消息夹在条数阈值里逃掉的那条路）。 */
export const DEFAULT_COMPACT_CHAR_CEILING = 400_000

/** 摘要正文的上限（字符）。超了就从中间删 + 写声明，见纪律 3。 */
export const DEFAULT_SUMMARY_MAX_CHARS = 4_000

/** 一条骨架的上限（字符）。一条 5000 字的正文不许独占整个摘要。 */
export const ENTRY_MAX_CHARS = 200

/**
 * 正文至少要留这么多字，否则**舍工具名、保正文**。
 * 工具名是装饰，正文才是这条骨架的全部价值。
 */
const ENTRY_MIN_TEXT_CHARS = 24

/**
 * 一次压缩最多从库里读多少条待折消息。
 * 撞上它**只压到读到的地方**（水位线绝不假装推到底），并记一条 warn。
 */
export const COMPACT_READ_LIMIT = 500

/** 阈值旋钮。见 `thresholdOverrideFromEnv`。 */
export const COMPACTION_N_ENV = 'CODE_CHAT_COMPACTION_N'

// ─────────────────────────────────────────────────────────────
// 阈值
// ─────────────────────────────────────────────────────────────

export interface CompactLimits {
  compactAtCount: number
  compactAtChars: number
  summaryMaxChars: number
}

export const DEFAULT_COMPACT_LIMITS: CompactLimits = {
  compactAtCount: DEFAULT_COMPACT_AT_COUNT,
  compactAtChars: DEFAULT_COMPACT_CHAR_CEILING,
  summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS
}

/**
 * 合并调用方给的覆盖值。**只覆盖点名的字段** —— 于是走查可以只动条数阈值，
 * 另外两个仍是模块里的那一份（不复制、不漂移）。
 */
export function resolveCompactLimits(partial?: Partial<CompactLimits>): CompactLimits {
  return { ...DEFAULT_COMPACT_LIMITS, ...partial }
}

export interface EnvThresholdRead {
  /** 采纳的值（只覆盖 `compactAtCount`）；`null` = 用默认值。 */
  value: number | null
  /**
   * 非 `null` = 变量**在**，但读不出一个正整数。调用方**必须**把它记成一条 warn。
   * ★ 不许静默回退：静默回退会让「我以为设成了 2」与「实际用的 20」长得一模一样，
   * 而走查里那个差异只表现为「压缩怎么没触发」。
   */
  problem: string | null
}

/**
 * 读 `CODE_CHAT_COMPACTION_N`。
 *
 * ★ 只收**纯十进制正整数**：`Number()` 会把 `'2.5'`、`'1e3'`、`'0x10'`、`' 3 '`
 * 统统收下，于是「这一跑用的阈值是多少」在归档里就对不上了。
 */
export function thresholdOverrideFromEnv(
  env: Readonly<Record<string, string | undefined>>
): EnvThresholdRead {
  const raw = env[COMPACTION_N_ENV]
  if (raw === undefined) return { value: null, problem: null }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return {
      value: null,
      problem: `${COMPACTION_N_ENV}=${JSON.stringify(raw)} 不是一个正整数，这一跑用默认阈值 ${DEFAULT_COMPACT_AT_COUNT}`
    }
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) {
    return { value: null, problem: `${COMPACTION_N_ENV} 的值太大，这一跑用默认阈值 ${DEFAULT_COMPACT_AT_COUNT}` }
  }
  return { value: n, problem: null }
}

// ─────────────────────────────────────────────────────────────
// 该不该压
// ─────────────────────────────────────────────────────────────

export interface CompactFacts {
  /** `session.compacted_through_seq` —— 权威水位线。 */
  waterline: number
  /** 本轮触发消息的 `seq`。区间右端**绝不越过**它（否则会把本轮请求自己折进去）。 */
  triggerSeq: number
  /** 库事实：`seq < triggerSeq` 的最大活 `seq`；没有这样的行时是 `null`。 */
  lastBeforeTriggerSeq: number | null
  /** 待折的骨架（已按 `seq` 升序）。 */
  pending: readonly SummaryEntry[]
  /**
   * 待折消息的**原文字符数**之和。
   *
   * ★★ 必须是**原文**，不是折出来的骨架长度。这条差点写成错的：
   * 骨架每行被截到 `ENTRY_MAX_CHARS`（200）字，而读取上限是 500 条 ⇒
   * 用骨架量的话字符闸最多量到 10 万字，**永远够不到默认的 40 万** ——
   * 一个打不开的闸比没有闸更糟，因为它看起来在工作。
   *
   * 而且这条闸要拦的本来就是「条数少、但每条都很长」那种会话
   * （条数闸拦的是「条数多、每条都短」）：所以它量的是**这些消息原本占多少**。
   */
  pendingChars: number
  /** 这一次读取用的上限（`COMPACT_READ_LIMIT`），用来判「是不是只读了一半」。 */
  readLimit: number
}

export type CompactReason =
  | 'count-threshold'
  | 'char-ceiling'
  | 'below-threshold'
  | 'nothing-to-fold'

export interface CompactDecision {
  compact: boolean
  reason: CompactReason
  /**
   * 压缩后水位线该推到哪。
   *
   * ★★ **这是回显，不是重算。** 区间右端的所有者是那条 SQL（`seq < triggerSeq`
   * 是「不含本轮」的唯一实现），本函数不许自己再算一遍 —— 两处各算一次，
   * 早晚会有一天两边不一致，而那种不一致只会表现为「某一轮的消息莫名消失」。
   * 否决时回显**现有水位线**（不是 0，也不是 `lastBefore`）。
   */
  throughSeq: number
}

export function shouldCompact(facts: CompactFacts, limits: CompactLimits): CompactDecision {
  if (facts.pending.length === 0 || facts.lastBeforeTriggerSeq === null) {
    // 没有可折的（首轮、或者两轮之间只有被 `excluded` 的消息）——正常状态，不是异常。
    return { compact: false, reason: 'nothing-to-fold', throughSeq: facts.waterline }
  }

  // ★ 撞上读取上限时**绝不假装压到底**：右端只能是「读到的那一条」。
  // 用 `>=` 保守处理「恰好读满」：那种情况下两者同值，取小也不会错。
  const capped = facts.pending.length >= facts.readLimit
  const right = capped ? facts.pending[facts.pending.length - 1]!.seq : facts.lastBeforeTriggerSeq

  if (facts.pending.length >= limits.compactAtCount) {
    return { compact: true, reason: 'count-threshold', throughSeq: right }
  }
  if (facts.pendingChars >= limits.compactAtChars) {
    return { compact: true, reason: 'char-ceiling', throughSeq: right }
  }
  return { compact: false, reason: 'below-threshold', throughSeq: facts.waterline }
}

// ─────────────────────────────────────────────────────────────
// 骨架
// ─────────────────────────────────────────────────────────────

export interface SummaryEntry {
  seq: number
  /** 已带好 `【】` 的角色标记（`historyLabelOf` 的产物，与装配层同一套词）。 */
  label: string
  /** 已拍成**单行**的正文首段。 */
  text: string
  /** 这条消息里出现过的工具名。 */
  tools: readonly string[]
}

/** 正文里的换行会被拍平 —— 一行骨架必须真的是**一行**（见 `appendToRollingSummary` 的行模型）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 把一条历史消息折成一条骨架。
 *
 * 返回 `null` 的情形**只有一种**：正文空白**且**没有工具名。
 * ★ 有一条不算数的：正文空白但**有工具名**时要留下（`[7] 【Atlas】（工具：Read）`）——
 * 「它读了三个文件但一句话没说」是真实发生的事，丢掉它就等于改写了历史。
 */
export function summaryEntryOf(
  h: HistoryMessage,
  selfMemberId: string,
  tools: readonly string[]
): SummaryEntry | null {
  const text = oneLine(h.text)
  if (text.length === 0 && tools.length === 0) return null
  return { seq: h.seq, label: historyLabelOf(h, selfMemberId), text, tools }
}

/** 截到 `max` 个字符（含省略号）。`max` 太小时不硬塞省略号。 */
function clip(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 1) return s.slice(0, Math.max(0, max))
  return s.slice(0, max - 1) + '…'
}

/** 一条骨架渲染成的那一行。**导出的理由**：`CompactFacts.pendingChars` 必须用它来量。 */
export function summaryLineOf(e: SummaryEntry): string {
  const head = `[${e.seq}] ${e.label}`
  const tools = e.tools.length > 0 ? `（工具：${e.tools.join('、')}）` : ''
  const budget = ENTRY_MAX_CHARS - head.length - tools.length
  if (budget >= ENTRY_MIN_TEXT_CHARS) {
    return head + (e.text.length > 0 ? ' ' + clip(e.text, budget - 1) : '') + tools
  }
  // 工具名太长太多 ⇒ **保正文、舍工具名**（见 `ENTRY_MIN_TEXT_CHARS`）。
  const textBudget = Math.max(2, ENTRY_MAX_CHARS - head.length - 1)
  return head + (e.text.length > 0 ? ' ' + clip(e.text, textBudget) : '')
}

// ─────────────────────────────────────────────────────────────
// 累积
// ─────────────────────────────────────────────────────────────

const TITLE_OPEN = '【已折叠的历史摘要】seq ≤ '
const TITLE_MID = ' 的历史已折叠成下面这段 '
const TITLE_TAIL = ' 条骨架（每行：[seq] 说话人 正文首段），原文不在你的上下文里。'

const DECL_OPEN = '…（此处省略了 '
const DECL_TAIL = ' 条较早的骨架 —— 原文不在你的上下文里，它们也不在本摘要里）…'

function titleOf(toSeq: number, kept: number): string {
  return `${TITLE_OPEN}${toSeq}${TITLE_MID}${kept}${TITLE_TAIL}`
}

function declOf(dropped: number): string {
  return `${DECL_OPEN}${dropped}${DECL_TAIL}`
}

/** 标题行的长度 —— 不 join 就能算出来，让「从中间删」的每一步是 O(1)。 */
function titleLen(toSeq: number, kept: number): number {
  return (
    TITLE_OPEN.length + String(toSeq).length + TITLE_MID.length + String(kept).length + TITLE_TAIL.length
  )
}

function isDigits(s: string): boolean {
  return /^[0-9]+$/.test(s)
}

/**
 * 这一行是不是**本模块**写的标题行？（精确到首尾，不是「看起来像」）
 *
 * ★ 不用正则：标题里有 `[` `]` 这类正则元字符，手写转义是又一个会静默失配的地方。
 * 用「前缀 + 两段切片 + 数字校验 + 尾后无余」来判断，是**精确匹配**。
 */
function isOwnTitle(line: string): boolean {
  if (!line.startsWith(TITLE_OPEN)) return false
  const rest = line.slice(TITLE_OPEN.length)
  const mid = rest.indexOf(TITLE_MID)
  if (mid < 0) return false
  const after = rest.slice(mid + TITLE_MID.length)
  const tailAt = after.indexOf(TITLE_TAIL)
  if (tailAt < 0 || tailAt + TITLE_TAIL.length !== after.length) return false
  return isDigits(rest.slice(0, mid)) && isDigits(after.slice(0, tailAt))
}

/** 把上一轮的摘要拆成「要携带的行」。剥不掉标题就整段逐字携带（纪律 2）。 */
function carryOf(prev: string | null): { lines: string[]; unparsed: boolean } {
  if (prev === null) return { lines: [], unparsed: false }
  const all = prev.split('\n').filter((l) => l.trim().length > 0)
  if (all.length > 0 && isOwnTitle(all[0]!)) {
    return { lines: all.slice(1), unparsed: false }
  }
  return { lines: all, unparsed: prev.trim().length > 0 }
}

export interface SummaryBuild {
  /** 整段摘要（首行一定是标题行）。 */
  text: string
  /** 本次新折进去的骨架条数。 */
  folded: number
  /** 输出里**实际保留**的骨架行数（含从 `prev` 携带来的）。 */
  kept: number
  /** 因 `maxChars` 被从中间删掉的行数。`0` = 一条没删。 */
  droppedCount: number
  /** 从 `prev` 携带过来的行数（剥掉旧标题之后）。 */
  prevLines: number
  /** `prev` 非空但**没解析出我们的标题** ⇒ 已逐字携带。 */
  prevUnparsed: boolean
  /** 有东西被删了（等价于 `droppedCount > 0`，单独给一份是为了调用方能直接判）。 */
  truncated: boolean
}

/**
 * 把这一段骨架接到上一轮摘要后面，返回**完整**的新摘要。
 *
 * 行模型：第 0 行是标题，其余每行一条骨架；被删的时候在删除处插一行声明。
 * 于是「保留了多少行」与「删了多少行」在文本里都是可数、可核对的。
 *
 * ★ 超上限时的删除是**从中间往外**（头尾都保）：开头是最早的历史，
 * 结尾是最靠近现在的历史，中间那一段的骨架最容易被后来的摘要覆盖。
 * 交替从两侧各删一行，于是头尾长度保持均衡。
 */
export function appendToRollingSummary(input: {
  prev: string | null
  entries: readonly SummaryEntry[]
  /** 新的水位线 —— 进标题。 */
  toSeq: number
  maxChars: number
}): SummaryBuild {
  const carried = carryOf(input.prev)
  const lines = [...carried.lines, ...input.entries.map(summaryLineOf)]
  const n = lines.length

  // 前缀 / 后缀的「join 后长度」增量表 —— 每一步 O(1)，整体 O(n)。
  // 直接每次 join 一遍会是 O(n²)，而 n 可能是 500 条 + 上一轮的几百行。
  const pre = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i]! + (i > 0 ? 1 : 0) + lines[i]!.length
  const suf = new Array<number>(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) suf[i] = lines[i]!.length + (i + 1 < n ? 1 + suf[i + 1]! : 0)

  /** 头 `[0,lo)` + 声明 + 尾 `[hi,n)` 拼起来有多长。 */
  function lenWith(lo: number, hi: number): number {
    const kept = lo + (n - hi)
    const parts: number[] = []
    if (lo > 0) parts.push(pre[lo]!)
    if (lo < hi) parts.push(declOf(hi - lo).length)
    if (hi < n) parts.push(suf[hi]!)
    const body = parts.length === 0 ? 0 : parts.reduce((a, b) => a + b, 0) + (parts.length - 1)
    // 有正文才多一个换行（`title` + '\n' + body）。
    return parts.length === 0 ? titleLen(input.toSeq, kept) : titleLen(input.toSeq, kept) + 1 + body
  }

  const mid = Math.floor(n / 2)
  let lo = mid
  let hi = mid
  let dropHead = true
  while (lo > 0 || hi < n) {
    if (lenWith(lo, hi) <= input.maxChars) break
    if (dropHead && lo > 0) lo--
    else if (hi < n) hi++
    else lo--
    dropHead = !dropHead
  }

  const droppedCount = hi - lo
  const kept = lo + (n - hi)
  const title = titleOf(input.toSeq, kept)

  const parts: string[] = []
  if (lo > 0) parts.push(lines.slice(0, lo).join('\n'))
  // ★ 声明行**永远在里面**：即使头尾都被删空，返回的也是「标题 + 声明」——
  //   一段「什么都没说、却看起来像完整历史」的摘要比一段残缺的摘要坏得多。
  if (droppedCount > 0) parts.push(declOf(droppedCount))
  if (hi < n) parts.push(lines.slice(hi).join('\n'))

  return {
    text: parts.length === 0 ? title : title + '\n' + parts.join('\n'),
    folded: input.entries.length,
    kept,
    droppedCount,
    prevLines: carried.lines.length,
    prevUnparsed: carried.unparsed,
    truncated: droppedCount > 0
  }
}

// ─────────────────────────────────────────────────────────────
// CLI 自己压缩的信号
// ─────────────────────────────────────────────────────────────

export interface CliCompactFacts {
  /** 观测到 `compact_boundary` —— CLI 在我们背后自己压了一次（§8.9-13）。 */
  boundarySeen: boolean
  /** 观测到的压缩结果。`none` = 这一轮没有关于压缩的任何消息。 */
  result: 'none' | 'failed' | 'other'
  /** 诊断原文（我们自己的措辞），只进日志与 notice 的 `detail`。 */
  message: string | null
}

/**
 * 从一轮的诊断里读出 CLI 关于压缩说过的话。
 *
 * ★ 判据是**诊断的 tag**，不是它的正文 ——
 * `stream-json-parser` 已经把 `failed` 与非 `failed` 分成了两个 tag
 * （`compact-failed` / `compact-result`），正文只是给人看的。不去解析正文里那个
 * `：` 后面的原因，是因为那种解析一旦失配就是**静默**得到一个 `null`。
 *
 * `failed` 优先于 `other`：同一轮里两者都出现时，失败是更值得说的那件事。
 */
export function compactFactsFromDiagnostics(diags: readonly AgentDiagnostic[]): CliCompactFacts {
  let boundarySeen = false
  let result: CliCompactFacts['result'] = 'none'
  let message: string | null = null
  for (const d of diags) {
    if (d.tag === 'compact-boundary') {
      boundarySeen = true
    } else if (d.tag === 'compact-failed') {
      result = 'failed'
      message = d.message
    } else if (d.tag === 'compact-result' && result !== 'failed') {
      result = 'other'
      message = d.message
    }
  }
  return { boundarySeen, result, message }
}

export type CompactSurfaceTag = 'compact-boundary-seen' | 'compact-cli-failed'

export interface CompactSurface {
  tag: CompactSurfaceTag
  message: string
}

/**
 * CLI 压缩信号该不该**露面**（§8.9-14 的落地形态）。
 *
 * | boundarySeen | 我们判该压 | CLI result | 结果 |
 * |---|---|---|---|
 * | 真 | 任意 | 任意 | **警告** —— §5.3 的「当作 bug」在实现上只能是「让它可见」 |
 * | 假 | 真 | `failed` | **警告** —— 我们觉得该压，CLI 也压失败了 ⇒ 上下文即将失控 |
 * | 假 | 假 | `failed` | 不露面。`too_few_groups` 是**正常**的（没东西可压） |
 * | 假 | 任意 | 其它 / 无 | 不露面 |
 *
 * ★ 「我们判该压」是这张表里唯一的**合判条件**，它把「CLI 报了个错」与
 * 「这个错对我们意味着什么」分开 —— 少了它，每一轮正常的小对话都会收到
 * 一条「CLI 压缩失败」的警告，而那种警告训出来的是**忽略警告**的习惯。
 *
 * 返回值**不带 `level`**：能露面的两行都只有「警告」一档（不值得警告的那些
 * 已经进了 `null`），由调用方固定发 warning。
 */
export function interpretCompactResult(
  ours: CompactDecision,
  cli: CliCompactFacts
): CompactSurface | null {
  if (cli.boundarySeen) {
    return {
      tag: 'compact-boundary-seen',
      message:
        'CLI 报告了一次我们没要求的上下文压缩（compact_boundary）—— ' +
        '这意味着真实窗口比我们的估算更早见底，我们的阈值需要重估'
    }
  }
  if (cli.result === 'failed' && ours.compact) {
    return {
      tag: 'compact-cli-failed',
      message:
        'CLI 自己的一次上下文压缩失败了，而这一轮的历史长度也已经到了该压缩的程度 —— ' +
        '接下来可能因为上下文过长而失败'
    }
  }
  return null
}
