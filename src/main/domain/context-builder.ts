import type { InjectMode, Message, MessageRole } from '../../shared/entities.ts'
import type { ProjectContext, ProjectContextKind } from '../adapters/agent-adapter.ts'
import type { TextReadResult } from '../infra/text-file.ts'
import type { CwdSource } from './turn-cwd.ts'

/**
 * §4.6 的**上下文装配** —— 把「一轮要发给 CLI 的全部内容」算出来。
 *
 * ## ★ 形状由实测决定：产物最终必须是**一条** user 行
 *
 * 原设计（§4.6）说历史要「逐条传递」，因为「prefix 缓存以消息为界」。
 * **2026-09-23 的 M7a 探针把这条推翻了**，逐字见 `scripts/m7a-probe.ts` 的文件头
 * 与两份归档 `scripts/evidence/m7a-2026-09-23T16-48-08-427Z`（3 臂）
 * 和 `scripts/evidence/m7a-2026-09-23T16-51-08-216Z`（4 臂，含 `stderr-*.txt`）：
 *
 * 1. **stdin 内层 `message.role` 只能是 `'user'`。** 写 `assistant` / `system` →
 *    CLI 在**解析 stdin 阶段就把整轮拒掉**（stderr 逐字
 *    `Error: Expected message role 'user', got 'assistant'`，stdout **0 行**）。
 * 2. **多条 user 行不是「一轮的多条消息」。** 3 行 → **2 条 `result`**，切在 `1 | {2,3}`
 *    （第 1 轮的模型只看得见第 1 行；第 2 轮看得见全部三条，且它那一条的
 *    `cache_read_input_tokens ≈ 21k` —— 它接着第 1 轮的会话在跑）。
 *    ⇒ 那个协议是**多轮对话**协议。发 N 行 = 发 N 轮，**不是**一轮的 N 条上下文。
 *
 * ⇒ 所以本模块的产物**不是**给 stdin 的行，而是 `TurnContext.messages` 那个数组，
 * 由适配器用 `renderTurnInput()` 拍平、`userMessageLine()` 包成**恰好一行**写出去
 * （`claude-adapter.ts` 的 spawn 段）。**数组留在 `TurnContext` 上是对的**：
 * 它是层间的编码，不是线上格式；拍平只发生在最后一行代码上。
 *
 * ★ 本模块因此**零 runtime import**（见 §4.3）—— 连 `renderTurnInput` 都不 import，
 * 因为**标签的所有权必须唯一**：`【你上一轮的回答】` 由 `renderTurnInput` 负责，
 * `【作者】`/`【系统】`/`【用户】` 由本模块负责（见 `labelOf`）。两边各加一份
 * 就会出现「一条历史行上有两个角色标记」的冲突，而那正是 §4.5a 规则一禁的形状。
 *
 * ## ★ 前缀缓存为什么仍然成立（这一条是本节存在的理由之一）
 *
 * §4.6 原文说「单块 blob 方案里 `<env>`+`<summary>`+`<recent>` 每轮整体重写
 * → 前缀每轮都在变 → 缓存永远命中不了」。**那句话把「编码」和「内容策略」混成了一件。**
 *
 * `renderTurnInput()` 是 `map().join('\n\n')` —— 一个**纯追加**的拼接。
 * 于是本模块的输出满足：**第 N 轮的 `messages` 是第 N+1 轮的数组前缀**，
 * 因而第 N 轮的提示词**逐字节是**第 N+1 轮的前缀（prelude 在同一段对话里是常量）。
 * 真正会破坏缓存的是**重写前缀里的内容**（比如每轮都变的 git 状态，见 §4.4），
 * 不是「拼成一块」。这两条性质都有单测钉着。
 *
 * ## 它**不抛错**
 *
 * 照 `turn-cwd.ts` 的先例：一切处境进 `notes`。
 * **致命与否的判决不在这里** —— 人设文件读不到时本函数只记一条 `warn`，
 * 由 `turn-runner` 决定要不要 `fail()`。理由：把「这是不是致命」留在编排层
 * （它已经有 `fail()` 出口和三条同形先例），本函数保持单一职责，也才测得到。
 *
 * ## 它**不碰盘**，除了通过注入的 `deps`
 *
 * `node:fs/promises` 其实不在 `domain/` 的禁令里（禁令只管 `electron` / `node:sqlite`）。
 * 读文件仍然走注入，是因为**单测不该碰真文件系统** ——
 * 「第 1 个文件缺失、第 2 个超限」这种处境要能直接构造出来。
 * 附带的好处才是「读文件只有一个所有者」（`infra/text-file.ts`）。
 */

/**
 * ★ §4.2：**cwd 的这一份不进 `<project_context>`，因为 CLI 自己会带进去。**
 *
 * 依据是 M7a 探针的实测（判据是**行类型**：标记第一次出现在 `assistant` 行、
 * 且之前没有任何 `tool_result` —— 说明它一开始就在上下文里，不是工具读来的）：
 *
 * | 文件 | 会不会被 CLI 自动注入 |
 * |---|---|
 * | `<cwd>/CLAUDE.md` | **会**（§8.5c-1 已实测） |
 * | `<cwd>/.claude/CLAUDE.md` | **会**（M7a 探针补测出来的） |
 * | `<cwd>/AGENTS.md` | 不会（M7a 探针补测） |
 * | `--add-dir` 目录里的 `CLAUDE.md` | 不会（§8.5c-1 已实测） |
 *
 * ★ **必须两个都在表里。** §4.2 逐字警告过：「只剔根那一份就仍是两遍」——
 * 而探针证明这个警告**说中了**：`.claude/CLAUDE.md` 确实也被注入。
 *
 * 其余四个路径（`.claude/rules/*.md`、`.cursorrules`、`.cursor/rules/*`、
 * `.github/copilot-instructions.md`）**没有实测**，所以照常注入：
 * 多注入一份的代价是浪费 token（可恢复），少注入一份的代价是模型以为项目没有记忆
 * （它可能自己造一份约定 —— 不可恢复）。这个不对称决定了默认方向。
 */
const AUTO_INJECTED_FROM_CWD: ReadonlySet<string> = new Set(['CLAUDE.md', '.claude/CLAUDE.md'])

/** 人设与职责描述文件的注入上限。超出会截断并记一条 note（**不静默截断**）。 */
export const CONTEXT_FILE_CAP_BYTES = 16 * 1024

/** 一条历史消息 —— 装配只需要这些，刻意不给它 `Message` 的完整形状。 */
export interface HistoryMessage {
  id: string
  seq: number
  role: MessageRole
  /** `null` = 人类用户（空间流里的那种）。 */
  authorMemberId: string | null
  /** 作者的成员显示名；作者已被移除时为 `null`。 */
  authorName: string | null
  /**
   * 正文。
   *
   * ★ **`thinking` 永远不在这个字段里** —— 那是**结构性**的，不是靠过滤：
   * `message_event` 是 thinking 唯一的落点，而装配只读 `message`（§4.2）。
   * 所以本模块一行过滤代码都不需要，它拿到的就是已经被排除过的文本。
   */
  text: string
  /** 逐条诊断字段。装配**不拿它当权威** —— 见 `compactedThroughSeq` 的说明。 */
  injectMode: InjectMode
}

export interface ContextProject {
  id: string
  name: string
  rootPath: string
}

/**
 * 把库里那条 `Message` 变成装配看得懂的 `HistoryMessage`。
 *
 * ★ 它**只有一个所有者**（M7c 起）：`turn-runner` 装配历史时用它，压缩折骨架时也用它。
 * 两处各写一份的后果不是报错，而是**模型看到谁在说话**这件事在两处慢慢分叉 ——
 * 摘要里写着 `（已移除的成员）`，历史里却写着名字，而没人会发现。
 *
 * `nameOf` 是注入的（本模块不碰库）：调用方通常在里面套一个缓存，
 * 一段历史里作者只有两三个。
 */
export function historyMessageOf(
  m: Message,
  nameOf: (memberId: string) => string | null
): HistoryMessage {
  return {
    id: m.id,
    seq: m.seq,
    role: m.role,
    authorMemberId: m.authorMemberId,
    // 作者为空 = 人类用户（空间流里的那种），不需要查名字。
    authorName: m.authorMemberId === null ? null : nameOf(m.authorMemberId),
    // `content_text` 可为 NULL（M6a 起流式折叠总是写它，但列本身可空）——
    // 空正文会被装配层丢掉，这里如实给空串而不是编一个占位符。
    text: m.contentText ?? '',
    injectMode: m.injectMode
  }
}

export interface ContextBuildInput {
  turn: { id: string; sessionId: string; workspaceId: string }
  actor: { name: string; personaPath: string; personaHash: string }
  /** `id` 用来判「历史上哪条是我说的」，所以它必须在。 */
  member: { id: string; displayName: string; roleDescPath: string | null; roleDescHash: string | null }
  workspace: { name: string; dirName: string }
  /** 已解析好的工作目录（`resolveTurnCwd` 的产物）。 */
  cwd: string
  cwdSource: CwdSource
  addDirs: readonly string[]
  /** 该空间的全部项目（用来把 `rootPath` 翻成项目名）。 */
  projects: readonly ContextProject[]
  /** **按 `seq` 升序**，**含本轮触发消息**（它是最后一条）。 */
  history: readonly HistoryMessage[]
  session: {
    /**
     * ★ **压缩水位的权威**。`message.inject_mode = 'summary'` 只是它的**冗余诊断**：
     * `markCompactedBySession` 会把同一段摘要**在每条被压掉的消息上各写一遍**
     * （`SET inject_mode='summary', summary_text=?`），逐条读它会把摘要重复 N 遍。
     * 而水位线是**单值**的、session 级的 —— 一刀切，没有重复的可能（§6.4）。
     */
    compactedThroughSeq: number
    rollingSummary: string | null
  }
}

/**
 * ★ **注入缝**（§2.5 那个结构性障碍的解法）。
 *
 * 两条都是「本模块不能自己做的事」：读文件会碰盘（单测不该碰），
 * 收项目记忆要看目录（同上）。把它们做成参数，本模块就是**纯的** ——
 * 给定输入必得同一输出，于是「装配错了」这件事可以被单测钉死，
 * 而不是只能在真机上观察。
 */
export interface ContextBuildDeps {
  readText(path: string, capBytes?: number): Promise<TextReadResult>
  collectProjectContext(rootPath: string): Promise<ProjectContext>
}

export interface ContextNote {
  tag: string
  level: 'info' | 'warn'
  message: string
  detail?: unknown
}

/** 一个项目记忆文件的**去向** —— 进了提示词，还是被剔了、为什么。 */
export interface ContextSourceRef {
  rootPath: string
  projectName: string | null
  kind: ProjectContextKind
  relPath: string
  bytes: number
  truncated: boolean
  /**
   * 非 `null` 表示**这份没有被注入**，值是原因。
   * 目前只有一种：`'cli-auto-injected'`（CLI 会自己带，注进去就是两遍）。
   */
  suppressed: 'cli-auto-injected' | null
}

/**
 * ★ 装配的**形状摘要**，**不含任何正文**。
 *
 * 它存在的理由是「这一轮到底发了什么」现在**没有任何落档处** ——
 * 装配产物只在内存里，`db-*.json` 看不到它。走查要能观察它，而
 * **不能把提示词全文写进归档**（那里面有用户的项目内容）。
 * 所以这里只放长度与条数：够回答「装配对不对」，不够泄露内容。
 */
export interface ContextShape {
  /** 逐条消息的条数（含 prelude 那一条）。 */
  messageCount: number
  /** 各条正文的字符数之和，**不含** `\n\n` 分隔符 —— 所以它不是最终提示词的长度，别当前者用。 */
  contentChars: number
  systemPromptChars: number
  historyTotal: number
  historyIncluded: number
  /** 被压缩水位线挡掉的条数。 */
  historySuppressed: number
  /** 被逐条 `inject_mode = 'excluded'` 挡掉的条数（该值目前没有生产者）。 */
  historyExcluded: number
  compactedThroughSeq: number
  /**
   * `<summary>` 块**实际贡献的字符数**（没注入 = 0）。
   *
   * ★ 它是对「块在位」的**直接**观测。用 `compactedThroughSeq > 0` 去推断会漏掉
   * 「水位线前进了但摘要为空」（`compaction-summary-missing` 那条 warn 的处境）——
   * 那时水位线为真而块不在，推断会说「有摘要」。
   */
  summaryChars: number
  projectFiles: number
  projectFileBytes: number
  /** 被 CLI 自动注入因而**没进提示词**的文件数（见 `AUTO_INJECTED_FROM_CWD`）。 */
  suppressedAutoInjected: number
  personaBytes: number | null
  roleDescBytes: number | null
}

export interface ContextBuild {
  /**
   * ★ 交给 `TurnContext.messages` 的数组。
   *
   * 消费方用 `renderTurnInput()` 把它拍平、`userMessageLine()` 包成**恰好一行**
   * 写进 stdin（见文件头：N 行 = N 轮，不是一轮的 N 条）。
   */
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  /** `--append-system-prompt-file` 的内容。 */
  systemPrompt: string
  notes: readonly ContextNote[]
  contextSources: readonly ContextSourceRef[]
  shape: ContextShape
}

const CWD_SOURCE_LABEL: Record<CwdSource, string> = {
  'member-primary': '该成员的主项目',
  'workspace-active': '空间的「最近使用」项目（兜底）',
  scratch: '无主项目的落点（scratch/，兜底）'
}

/**
 * 除「我自己说的话」之外的每一条，都要带上**作者标签**。
 *
 * ★ **标签的所有权要唯一。** 本函数负责 `【系统】`/`【用户】`/`【我】`/`【作者名】`；
 * **`【你上一轮的回答】` 由 `renderTurnInput()` 负责**（它给每个 `assistant` 元素加）。
 * 所以「我自己说的」那一条**这里不加标签** —— 加了两边就重复了。
 *
 * ★ **导出**（M7c 起）：压缩用的骨架（`domain/compaction-service.ts`）也要给每条历史
 * 贴同一个标签。那是**同一个词表的两处使用**，不是两个词表 ——
 * 摘要是**折叠过的历史**，模型会在摘要里读 `【我】`、在历史里读 `【Atlas】`；
 * 两边各写一份的话，漂移不会报错，只会让模型以为摘要是别人写的。
 */
export function historyLabelOf(h: HistoryMessage, selfMemberId: string): string {
  if (h.role === 'system') return '【系统】'
  if (h.authorMemberId === null) return '【用户】'
  if (h.authorMemberId === selfMemberId) return '【我】'
  return `【${h.authorName ?? '（已移除的成员）'}】`
}

/**
 * 把历史编成 `TurnContext.messages` 的形态。
 *
 * ★ **角色判定：只有「我自己说过的话」才是 `assistant`。**
 * 别的成员说的话在 CLI 眼里就是 `user` 侧的内容 —— 因为这一轮对话里只有一个「我」，
 * 也就是 `systemPrompt` 里那个人设。把别人的话标成 `assistant` 会让模型
 * 以为那些话是它自己说的，于是它会为别人的结论负责。
 *
 * 于是「@ 了谁」这件事**靠正文里的字面文本表达**（§5.4：历史正文原样带上，
 * 组合式的 mentions 不去重写正文）—— 模型看到的就是用户看到的。
 */
function toRenderableMessages(
  history: readonly HistoryMessage[],
  selfMemberId: string
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history.map((h) => {
    const mine = h.role === 'assistant' && h.authorMemberId === selfMemberId
    // `mine` 时**不加标签** —— `renderTurnInput` 会加 `【你上一轮的回答】`，见 `historyLabelOf`。
    if (mine) return { role: 'assistant' as const, content: h.text }
    return { role: 'user' as const, content: `${historyLabelOf(h, selfMemberId)}\n${h.text}` }
  })
}

/** `<env>` 块。**全是已解析的事实**（`resolveTurnCwd` / `resolveAddDirs` 的产物），**不碰盘**。 */
function envBlock(input: ContextBuildInput): string {
  const lines: string[] = ['<env>']
  lines.push(`工作空间：${input.workspace.name}`)
  lines.push(`工作目录：${input.cwd}`)
  lines.push(`　（来源：${CWD_SOURCE_LABEL[input.cwdSource]}）`)
  lines.push('可见项目：')
  if (input.projects.length === 0) {
    lines.push('　（无）')
  } else {
    for (const p of input.projects) {
      const here = p.rootPath === input.cwd ? '　← 当前工作目录' : ''
      lines.push(`　· ${p.name} — ${p.rootPath}${here}`)
    }
  }
  lines.push('附加目录（--add-dir，仅供工具访问，不是上下文来源）：')
  if (input.addDirs.length === 0) lines.push('　（无）')
  else for (const d of input.addDirs) lines.push(`　· ${d}`)
  return lines.join('\n')
}

/** 收集结果 —— 装配真正要的那几件，连同「剔了谁、为什么」。 */
interface ProjectBlock {
  text: string
  sources: ContextSourceRef[]
  notes: ContextNote[]
  fileCount: number
  fileBytes: number
  suppressed: number
}

async function projectBlock(
  roots: readonly { rootPath: string; projectName: string | null }[],
  cwd: string,
  deps: ContextBuildDeps
): Promise<ProjectBlock> {
  const sources: ContextSourceRef[] = []
  const notes: ContextNote[] = []
  const sections: string[] = []
  let fileCount = 0
  let fileBytes = 0
  let suppressed = 0

  for (const { rootPath, projectName } of roots) {
    const ctx = await deps.collectProjectContext(rootPath)
    const title = projectName ? `项目「${projectName}」` : '目录'
    const body: string[] = []

    for (const f of ctx.files) {
      // ★ 只对 **cwd** 剔除：`--add-dir` 目录里的 CLAUDE.md 实测**不会**被自动注入，
      // 剔了就是**少**给模型一份项目记忆（见 `AUTO_INJECTED_FROM_CWD` 的表）。
      const isCwd = rootPath === cwd
      if (isCwd && AUTO_INJECTED_FROM_CWD.has(f.path)) {
        suppressed++
        sources.push({
          rootPath,
          projectName,
          kind: f.kind,
          relPath: f.path,
          bytes: f.bytes,
          truncated: false,
          suppressed: 'cli-auto-injected'
        })
        continue
      }
      fileCount++
      fileBytes += f.bytes
      sources.push({
        rootPath,
        projectName,
        kind: f.kind,
        relPath: f.path,
        bytes: f.bytes,
        // `ProjectContextFile` **没有**逐文件的 truncated 标记（只有项目级的），
        // 所以按「返回的文本比原始字节短」反推。`project-context.ts` 就是按字节切的。
        truncated: Buffer.byteLength(f.text, 'utf8') < f.bytes,
        suppressed: null
      })
      body.push(`### ${f.path}（${f.bytes} 字节）`)
      body.push(f.text)
      body.push('')
    }

    // ★ 剔了什么都必须**写进提示词**：否则模型会以为这个工作目录没有 CLAUDE.md，
    // 于是它可能自己造一份、或者干脆不提项目约定（§8.5c 性质 5 在这一层的应用）。
    const suppressedHere = sources.filter((s) => s.rootPath === rootPath && s.suppressed !== null)
    if (suppressedHere.length > 0) {
      body.push(
        `（注：${suppressedHere.map((s) => s.relPath).join('、')} 未在此重复注入 —— ` +
          '本次运行的工作目录由 CLI 自动带上它们，这里再放一份会让同一份内容出现两遍。）'
      )
      body.push('')
      notes.push({
        tag: 'cwd-claude-md-suppressed',
        level: 'info',
        message: `工作目录的 ${suppressedHere.map((s) => s.relPath).join('、')} 未注入：CLI 会自己带进来`,
        detail: { rootPath, relPaths: suppressedHere.map((s) => s.relPath) }
      })
    }

    // 读失败的文件（`EISDIR` 之类）**必须可见**（§8.5c 性质 5）。
    // `ENOENT` 不算 —— 大部分项目本来就没有那些文件。
    for (const s of ctx.skipped) {
      notes.push({
        tag: 'project-context-skipped',
        level: 'warn',
        message: `${rootPath} 的 ${s.path} 没读到（${s.reason}）`,
        detail: { rootPath, path: s.path, reason: s.reason }
      })
    }
    if (ctx.truncated) {
      notes.push({
        tag: 'project-context-truncated',
        level: 'info',
        message: `${rootPath} 有文件超过注入上限，已按字节截断`,
        detail: { rootPath }
      })
    }

    const header = `## ${title} — ${rootPath}`
    const rest = body.join('\n').trimEnd()
    sections.push(rest ? `${header}\n${rest}` : `${header}\n（这个项目没有可注入的记忆文件。）`)
  }

  return { text: sections.join('\n\n'), sources, notes, fileCount, fileBytes, suppressed }
}

/**
 * 协作协议 —— 稳定、可缓存的那一段。
 *
 * ★ `<mentions>` 的格式**必须逐字写在这里**（§5.4）：我们的派发依据是一个
 * **由我们定义、位置固定、无歧义**的机器可读块，而不是从自然语言里猜 `@` 指向谁
 * （§3.1 禁的是后者）。失败因此是可观测的：**没有那块 = 没有派发**，不是猜错。
 */
const COLLABORATION_PROTOCOL = [
  '<collaboration>',
  '你在一个多角色的协作工作空间里。历史消息里【】里的是说话的那个成员的名字。',
  '',
  '· 需要某位成员接手时，在回复的**最后**单独写一行：',
  '  <mentions>Nyx,Atlas</mentions>',
  '  多个用英文逗号分隔。这一行**不会显示给用户**，是本应用分派工作的唯一依据。',
  '· 不需要别人接手时，**不要写这一行**。',
  '</collaboration>'
].join('\n')

/**
 * 人设 / 职责描述 —— 一个字都读不到时**不抛**，记一条 note 让编排层判决。
 *
 * `roleDescPath === null` 时**整块不出现**，不是空标签：
 * 一个空的 `<role></role>` 是「看起来应该有内容」的**承诺**，模型会去把它填上；
 * 而 NULL 的含义本来就是「这个成员没有职责描述」—— 那是合法的状态，不是缺失。
 */
async function readPersonaAndRole(
  input: ContextBuildInput,
  deps: ContextBuildDeps
): Promise<{
  systemPrompt: string
  notes: ContextNote[]
  personaBytes: number | null
  roleDescBytes: number | null
}> {
  const notes: ContextNote[] = []
  const blocks: string[] = []

  const persona = await deps.readText(input.actor.personaPath, CONTEXT_FILE_CAP_BYTES)
  let personaBytes: number | null = null
  if (persona.ok) {
    personaBytes = persona.bytes
    blocks.push(['<persona>', persona.text.trimEnd(), '</persona>'].join('\n'))
    if (persona.truncated) {
      notes.push({
        tag: 'persona-truncated',
        level: 'warn',
        message: `人设文件超过 ${CONTEXT_FILE_CAP_BYTES} 字节，已截断注入（原文 ${persona.bytes} 字节）`,
        detail: { path: persona.path, bytes: persona.bytes, cap: CONTEXT_FILE_CAP_BYTES }
      })
    }
    // hash 与库里那个对不上 = 建立之后文件被改过。**是事实，不是错误**，
    // 但用户会想知道「它现在用的是哪一版」，所以记一条 info。
    if (persona.hash !== input.actor.personaHash) {
      notes.push({
        tag: 'persona-changed-since-create',
        level: 'info',
        message: '人设文件在角色建立之后被改过（内容 hash 与库里记录的不一致）',
        detail: { path: persona.path, stored: input.actor.personaHash, actual: persona.hash }
      })
    }
  } else {
    // ★ 致命与否**不在这里判** —— `turn-runner` 读 `personaBytes === null` 决定 fail。
    notes.push({
      tag: 'persona-unreadable',
      level: 'warn',
      message: `人设文件读不到：${persona.reason}（${persona.path}）`,
      detail: { path: persona.path, code: persona.code }
    })
  }

  let roleDescBytes: number | null = null
  const rolePath = input.member.roleDescPath
  if (rolePath !== null) {
    const role = await deps.readText(rolePath, CONTEXT_FILE_CAP_BYTES)
    if (role.ok) {
      roleDescBytes = role.bytes
      blocks.push(['<role>', role.text.trimEnd(), '</role>'].join('\n'))
      if (role.truncated) {
        notes.push({
          tag: 'role-desc-truncated',
          level: 'warn',
          message: `职责描述文件超过 ${CONTEXT_FILE_CAP_BYTES} 字节，已截断注入（原文 ${role.bytes} 字节）`,
          detail: { path: role.path, bytes: role.bytes, cap: CONTEXT_FILE_CAP_BYTES }
        })
      }
      if (role.hash !== input.member.roleDescHash) {
        notes.push({
          tag: 'role-desc-changed-since-create',
          level: 'info',
          message: '职责描述文件在成员建立之后被改过（内容 hash 与库里记录的不一致）',
          detail: { path: role.path, stored: input.member.roleDescHash, actual: role.hash }
        })
      }
    } else {
      // 不致命：`role_desc_path` 可空，NULL 本来就是合法状态，
      // 而「有路径但读不到」与「压根没配」对模型是同一件事（都没有职责描述）。
      notes.push({
        tag: 'role-desc-unreadable',
        level: 'warn',
        message: `职责描述文件读不到：${role.reason}（${role.path}）`,
        detail: { path: role.path, code: role.code }
      })
    }
  }

  blocks.push(COLLABORATION_PROTOCOL)
  return { systemPrompt: blocks.join('\n\n'), notes, personaBytes, roleDescBytes }
}

/**
 * 装配一轮的上下文。
 *
 * 返回值的 `messages` 就是全部 —— 调用方把它交给 `TurnContext`，
 * **不要自己再拆成多行写进 stdin**（见文件头：N 行 = N 轮）。
 */
export async function buildContext(
  input: ContextBuildInput,
  deps: ContextBuildDeps
): Promise<ContextBuild> {
  const notes: ContextNote[] = []

  // ── 1. 历史：水位线一刀切 ──
  const through = input.session.compactedThroughSeq
  const included: HistoryMessage[] = []
  let suppressedByWatermark = 0
  let excluded = 0
  for (const h of input.history) {
    if (h.seq <= through) {
      suppressedByWatermark++
      continue
    }
    // ★ 水位线是**权威**，`inject_mode` 只是诊断 —— 但 `'excluded'` 是个例外：
    // 它表达的是「这一条无论如何都不进」，与水位线无关（§6.4）。
    // 它目前**没有生产者**，这里读它是为了让第一个生产者出现时不必再改装配层。
    if (h.injectMode === 'excluded') {
      excluded++
      continue
    }
    if (h.text.trim().length === 0) continue
    included.push(h)
  }

  // ── 2. 前缀：`<env>` + `<project_context>` + `<summary?>` ──
  //
  // ★ `messages[0]` 是 prelude，**不是一条历史消息**。这样数组天然保持
  // 「纯追加」：第 N+1 轮只是在尾部多 push 几条，前缀一个字节都不动。
  const prelude: string[] = [envBlock(input)]

  // 注入哪些项目：cwd 自己（它可能是 scratch，那就不是项目）+ 全部 `--add-dir` 目录。
  // `--add-dir` 目录里的 CLAUDE.md **实测不会被 CLI 自动注入**，所以那些项目记忆
  // 只能由我们显式带进来 —— 这正是 §8.5c 那个用户问题的答案。
  const projectRoots: Array<{ rootPath: string; projectName: string | null }> = []
  const seen = new Set<string>()
  const byRoot = new Map(input.projects.map((p) => [p.rootPath, p]))
  for (const r of [input.cwd, ...input.addDirs]) {
    if (seen.has(r)) continue
    seen.add(r)
    projectRoots.push({ rootPath: r, projectName: byRoot.get(r)?.name ?? null })
  }

  const proj = await projectBlock(projectRoots, input.cwd, deps)
  notes.push(...proj.notes)
  prelude.push('<project_context>')
  prelude.push(proj.text || '（没有任何可见项目提供记忆文件。）')
  prelude.push('</project_context>')

  let summaryChars = 0
  if (through > 0 && input.session.rollingSummary) {
    // ★ 措辞要如实说它是**压缩产物**，别让模型把摘要当原文读。
    //
    // ★★ M7c 修正：这里**原先自己拼了一句说明**，而那句话里的条数是
    // `suppressedByWatermark` —— 它是**本窗口内**被挡掉的条数（窗口上限
    // `historyLimit`，默认 200），却被写成了「seq ≤ N 的 X 条消息」。
    // 长会话下它会把 500 条说成 200 条，而且与摘要正文里那个准确的条数
    // **同场矛盾**——M7a 那会儿 `through > 0` 在生产里不可达，所以它没有机会撒谎。
    //
    // 现在说明由**摘要自己**给出（`compaction-service` 的标题行，它数的是真的折了几条），
    // 这里只负责包一层标签。**一个事实只有一个所有者**：否则两处各算一遍，
    // 早晚会有一天两边不一致，而那种不一致只会表现为「模型看到的条数不对」。
    prelude.push('<summary>')
    prelude.push(input.session.rollingSummary)
    prelude.push('</summary>')
    // 这个块在提示词里**逐字**长这样（prelude 是用 `\n\n` 拼的），所以按它算，
    // 不用「加上分隔符的估算」——`shape` 是要拿去和归档里的读数对账的。
    summaryChars =
      '<summary>'.length + 2 + input.session.rollingSummary.length + 2 + '</summary>'.length
  } else if (through > 0) {
    // 水位线前进但摘要为空 —— **这是不一致**，如实报，不假装没有压缩过。
    notes.push({
      tag: 'compaction-summary-missing',
      level: 'warn',
      message: `压缩水位线是 ${through}，但会话上没有摘要文本 —— 被折叠的历史这次既没原文也没摘要`,
      detail: { sessionId: input.turn.sessionId, compactedThroughSeq: through }
    })
  }

  // ── 3. 正文：prelude 打头，历史逐条追加 ──
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: prelude.join('\n\n') },
    ...toRenderableMessages(included, input.member.id)
  ]

  // ── 4. 系统提示词 ──
  const sys = await readPersonaAndRole(input, deps)
  notes.push(...sys.notes)

  let contentChars = 0
  for (const m of messages) contentChars += m.content.length

  return {
    messages,
    systemPrompt: sys.systemPrompt,
    notes,
    contextSources: proj.sources,
    shape: {
      messageCount: messages.length,
      contentChars,
      systemPromptChars: sys.systemPrompt.length,
      historyTotal: input.history.length,
      historyIncluded: included.length,
      historySuppressed: suppressedByWatermark,
      historyExcluded: excluded,
      compactedThroughSeq: through,
      summaryChars,
      projectFiles: proj.fileCount,
      projectFileBytes: proj.fileBytes,
      suppressedAutoInjected: proj.suppressed,
      personaBytes: sys.personaBytes,
      roleDescBytes: sys.roleDescBytes
    }
  }
}
