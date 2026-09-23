import type { EventKind, Mention, TurnStatus, WorkspaceMember } from '../../shared/entities.ts'

/**
 * §4.5b 的三条熔断 + §3.3 的跳数记账 —— **这个文件的主体就是那三条规则**。
 *
 * ## 为什么它单独存在，而不是散在 `turn-runner` / `fanout` 里
 *
 * §4.5b 归属更正（M6a 裁定）逐字：这三条的「每一个基准都建立在 `@` 派发链上」，
 * 所以它们从 M5 改派给 M7。而**它们全是纯判断**：给定「链上的跳」和「谁 @ 了谁」，
 * 判决是确定的、与进程状态无关的 —— 这正是本项目里最该往纯逻辑层搬的那一类
 * （`architecture.md` §3.1 规则三：越是错了不报错的判断，越要能单测）。
 * 执行（建轮次、取消排队、落库）在 `process/fanout.ts`，本文件一个字节都不写库。
 *
 * ## 三条规则（§4.5b 逐字）
 *
 * 1. **乒乓**：「A→B→A→B 且每一跳都没有实质性动作……`2` 次 → 弹一条可见警告
 *    （UI 提示 + 一条系统事件，落库）；`4` 次 → **强制终止该链**并如实标明原因。
 *    **豁免与重置**：任一跳里出现实质性工作就**清零计数** —— 否则会把「真的在来回讨论
 *    并推进」的正常协作误杀，这是这类熔断最常见的过头方式（**宁可漏杀，不可错杀**）。」
 * 2. **去重**：「去重基准是**尚未执行的尾部**，不是整条历史……**不要**拿整条 session
 *    做去重基准 —— 那会吃掉「A→B→A 的第二轮复盘」这种正当行为。」
 * 3. **广播风暴不单独设机制**：「广播（N 个成员互相应答）在 ① 的豁免规则下会先被判为
 *    『有实质工作』而放行 —— 所以**并发槽位（默认 3）才是它真正的闸门**，无需第四套机制。」
 *    ⇒ **本文件里没有、也不该有第四个机制。** 这条注释在这里的作用就是拦住下一个人
 *    （「要不要给广播加个上限？」的答案在 §4.5b 里，是「不」）。
 *    走查里有一条断言盯着这件事：`fanoutOf` **不因成员数而拒绝**。
 *
 * ## ★ 诚实边界：「有新信息」判不了，只判「有动作」
 *
 * §4.5b 原文要求「没有文件改动、没有工具调用、**没有新信息**」。前两条可观测
 * （`message_event` 里有没有 `tool_start` / `file_diff`），**第三条不可判定**：
 * 「这一跳有没有带来新信息」需要一个语义比较器，我们没有，而且装作有会得到
 * 一个**看起来正常**的错误判决 —— 那正是本项目最贵的那类 bug。
 * ⇒ 只把「有工具调用 / 有文件改动」当作实质工作，`WORK_EVENT_KINDS` 是它的唯一出处。
 * 后果如实记：**一次纯粹的信息交换（模型真在推理、但没碰工具）会被算成空转**，
 * 于是链可能在 4 跳处被终止。这是**明知**的偏严方向，与 §4.5b 的「宁可漏杀」相反 ——
 * 写下来，不藏。
 *
 * ## ★ 「强制终止该链」**不是**杀进程
 *
 * 这一条必须写死在模块里，因为它最容易被实现成 `kill`：
 *
 * > 「强制终止该链」= ① 本轮的扇出被取消（**不建新轮次**）+ ② 链上仍 `queued` 的轮次被取消。
 * > **它不包含 abort 一个正在跑的轮次。**
 *
 * 正在跑的那一轮的产物是**合法的** —— 它确实是那条链上的那一跳，只是它之后不该再有。
 * 运行中轮次的中断是 M9 的活（§4.4b 的中断阶梯）。
 * 本文件只产出 `action: 'terminate'`；怎么落地的纪律在 `process/fanout.ts`。
 *
 * ## ★ 跳数只是**显示用**的状态，绝不进提示词
 *
 * `entities.ts` 的 `Turn.hopDepth` 逐字：「**绝不进入提示词上下文** —— 压缩只压对话内容，
 * 不压控制状态，否则 agent 会丢掉『自己卡住了』这个认知」。
 * ⇒ 本文件产出的任何**要落成消息正文**的句子（熔断的 system 事件）里
 * **一个跳数数字都不能出现**（用「连续几轮」这种说法），数字只进 `notes` / 日志 / 推送的 detail。
 * `fanout.ts` 写库时同样只写 `relayTextOf()` 的产物，它不带跳数。
 *
 * ## 链的判据：`hop_depth` 的单调递增后缀 —— **跨 session**
 *
 * ```
 * 链 = 本空间内、按 queued_at 升序的轮次里，hop_depth 逐跳 -1 的那一段后缀
 * ```
 *
 * ★ **「本空间内」而不是「本 session 内」**（这一条修正了 M7 计划书 §5.2 的措辞，逐字见下）：
 * 计划书写的是「本 session 内」，但 §3.3 定死了 `派给 B 的那一轮 hop_depth = A.hop_depth + 1`
 * —— 跳数是**沿链全局**递增的。而 A↔B 的乒乓**天然跨两个 session**（每个成员一个会话），
 * 于是 A 的会话里只有 0、2、4 跳，B 的会话里只有 1、3、5 跳：**按 session 走那条
 * 「逐跳 +1」的后缀，两边都只有一跳，熔断永远不可能触发。**
 * ⇒ 链的判据必须是跨 session、按 `queued_at` 全局排序的后缀。
 * 依据是 §3.3 与 §4.5b 的原文，不是口味。
 *
 * 已执行过的跳才算跳：`queued` / `running` 的轮次**对判链不可见** —— 它们既不算一跳
 * （实质工作还没落定，把「还没跑的跳」当成空转就是往错杀方向走），也**不占位**
 * （所以一条正在排队的兄弟轮次不会把链切开）。
 * **代价是这一步会漏**，两种形状都不报错：
 * ① 同空间里另有一条并发的 @ 链交错时，链上某两跳在 `queued_at` 序里被别人的轮次隔开，
 *    两边都会在隔开处断开（漏杀）；
 * ② 已执行的那一段里**缺了一级**（深度 d 没有已执行的行、却有 d+1 的行 —— 那只可能是
 *    另一条链上同深度的轮次还没跑完）时，后缀断在那里，同样判不出来。
 * 两者都是「宁可漏杀，不可错杀」的直接代价，如实记着。
 *
 * **记录被否决的方案**：内存里维护链状态（照 `scheduler.ts` 的 `busySessions` 先例）
 * 更省查询，但进程重启后链状态丢失、计数从 0 开始 —— 会让「一个安静的丢失」成为可能。
 * 用库里的 `hop_depth` 则**报告可以从归档重判**（§8.8e 纪律）。
 */

// ─────────────────────────────────────────────────────────────
// ① 标记块：assistant 的 mentions 从哪来（§5.4 决策 2 的落地）
// ─────────────────────────────────────────────────────────────

/**
 * `<mentions>Nyx,Atlas</mentions>` —— **由我们定义、位置固定、无歧义**的机器可读块。
 *
 * `systemPrompt` 里逐字给出了它的格式（`context-builder.ts` 的 `COLLABORATION_PROTOCOL`），
 * 所以模型是在**我们指定的位置**写它。这**不是** §3.1 禁的那种解析 ——
 * §3.1 禁的是「从用户输入的自然语言里猜 `@` 指向谁」。
 * 失败因此可观测：**没有那一块 = 没有派发**，而不是猜错。
 */

/** 全部匹配（`String.matchAll` 需要 `g`；`lastIndex` 的坑由每次新建正则避开）。 */
const MENTIONS_BLOCK = /<mentions>([\s\S]*?)<\/mentions>/g

/** 孤立的开/闭标签 —— 用来把「模型写坏了」与「模型没写」分开。 */
const MENTIONS_BROKEN = /<\/?mentions>/

export interface MentionsParse {
  /** 解析出来的名字，**原样**（未解析成成员）—— 解析成成员要知道成员表，那是 `fanoutOf` 的事。 */
  names: string[]
  /**
   * - `none`：没有标记块 ⇒ **不派发**（这是设计里的正常结局，不是错误）
   * - `ok`：有块且有名字
   * - `empty`：有块但里面没有名字（模型写了 `<>`）—— 同样不派发，但值得记一条 note
   * - `malformed`：出现了孤立的 `<mentions>` / `</mentions>` —— 模型写坏了
   */
  status: 'none' | 'ok' | 'empty' | 'malformed'
}

/**
 * 取**最后一个**标记块 —— 协议要求它单独写在一行的末尾。
 *
 * 为什么是最后一个：模型有可能在正文里**引用**这个格式（解释它、举例），
 * 而协议规定真正的派发行在**最后**。取最后一个与协议同序，
 * 取第一个则会把「举例说明」当成真派发 —— 那是一种**看起来正常**的错。
 */
export function parseMentionsBlock(text: string): MentionsParse {
  const all = [...text.matchAll(MENTIONS_BLOCK)]
  if (all.length === 0) {
    return { names: [], status: MENTIONS_BROKEN.test(text) ? 'malformed' : 'none' }
  }
  const raw = all[all.length - 1]?.[1] ?? ''
  // 协议逐字要求「多个用**英文**逗号分隔」。中文逗号照样切开（模型常写），
  // 但**不静默**：调用方会从 `names` 里看不出这件事，所以这里用一个明确的
  // 替换 + 下面 `fanoutOf` 的 note 一起把它变成可见的（§4.3a 拒绝静默失败）。
  const names = raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const unique = [...new Set(names)]
  if (unique.length === 0) return { names: [], status: 'empty' }
  return { names: unique, status: 'ok' }
}

/**
 * 把标记块从正文里删掉（`<mentions>` 本身连同前后空行）。
 *
 * ★ 用途只有一个：**转述给别人时**（`relayTextOf`）。原会话的历史里**一个字都不改** ——
 * §5.4：「历史正文**原样带上**（模型看得见「@Nyx」这个词，那本来就是对话的一部分）」。
 * 理由（转发要删、历史要留，两件事不矛盾）：那一行是**我们与派发方之间**的机器指令，
 * 也是我们自己在协议里写明「不会显示给用户」的那一行；把它转发给下游模型，
 * 等于把「谁该被派发」这个已经做过的决定**再交给下游模型猜一次** —— 它会照抄。
 */
export function stripMentionsBlock(text: string): string {
  return text.replace(MENTIONS_BLOCK, '').replace(/\n{3,}/g, '\n\n').trimEnd()
}

// ─────────────────────────────────────────────────────────────
// ② 实质工作：只判「有动作」
// ─────────────────────────────────────────────────────────────

/**
 * 算作「实质性工作」的事件类型。**这是这条规则在全仓库的唯一出处** ——
 * `turn-runner`（算刚结束那一跳）与 `process/fanout`（算链上更早的跳）都读它，
 * 各写一份就会出现「同一跳在两处被判成不同结果」那种安静的错。
 *
 * `tool_result` 不算：它总是跟着一个 `tool_start`，算上它只会重复计数。
 * `text` / `thinking` 不算：那是「说了话」，正是本条要判的空转。
 */
export const WORK_EVENT_KINDS: readonly EventKind[] = ['tool_start', 'file_diff']

/**
 * 「这一轮的回复正文」= 它**最后一条** `assistant` 消息。
 *
 * ★ 这个定义只有一个所有者：M7b 的 `<mentions>` 解析与转述都必须读同一段文本 ——
 * 两处各写一遍（「最后一条 assistant」「所有 assistant 拼起来」）会出现
 * 「我们解析的是 A 段、转述给别人的是 B 段」那种安静的错。
 * ★ **不读 `thinking`**：那是模型的推理，不是它对别人说的话（§4.6a 规则三的同一件事）。
 * `contentText` 本来就是已剔除 thinking 的那一份（`event-batcher` 只把 `text` 帧折进正文）。
 */
export function replyTextOf(messages: readonly { role: string; contentText: string | null }[]): string {
  const replies = messages.filter((m) => m.role === 'assistant')
  const last = replies[replies.length - 1]
  return last?.contentText ?? ''
}

/**
 * 一轮结束时交给扇出的**全部事实**。
 *
 * ★ 它由 `turn-runner` 一次读完（它已经读过一遍那一轮的产物）后传出 —— 刻意**不含 store**，
 * 于是拿到它的人（`process/fanout.ts`）不可能再去读一遍「这一轮说了什么」，
 * 「回复是哪一条」这件事因此只有一个所有者（`replyTextOf`）。
 * 类型声明放在 `domain/` 而不是 `process/`：`domain` 不许 import `process`（依赖只向下），
 * 而 `turn-runner` 要签这个名。
 */
export interface TurnFinishedInfo {
  /** 回复里解析出来的标记块。 */
  mentions: MentionsParse
  /** 这一轮的回复正文（`replyTextOf` 的产物）。 */
  replyText: string
  /** 这一跳有没有实质工作（`WORK_EVENT_KINDS`）。 */
  hadWork: boolean
}

// ─────────────────────────────────────────────────────────────
// ③ 跳数（§3.3）
// ─────────────────────────────────────────────────────────────

/**
 * 用户直接发起的那一轮 = 0。
 *
 * ★ 它同时是**链的打断点**（§5.2）：用户插一句话就开了一条新的链，
 * 于是「上一段已经空转了三跳」不会被算进这一段。所以这个 0 不是「默认值」，
 * 是一个**语义**：`hop_depth === 0` 当且仅当这一轮完全由用户直接发起。
 */
export const USER_INITIATED_HOP_DEPTH = 0

/** 由 `@` 派发的一轮：派出它的那一跳 + 1（§3.3 逐字）。 */
export function hopDepthOf(parentHopDepth: number): number {
  return parentHopDepth + 1
}

// ─────────────────────────────────────────────────────────────
// ④ 链（跨 session，见文件头）
// ─────────────────────────────────────────────────────────────

/**
 * 判链只要这三样。刻意**不用 `Turn`**：`Turn` 有十几个字段，
 * 而这个判决只该看得见「谁、多深、跑完了没」—— 单测因此不必造一整个 `Turn`。
 */
export interface ChainTurn {
  turnId: string
  hopDepth: number
  status: TurnStatus
}

/**
 * 从一批**按 `queued_at` 升序**的轮次里，切出以最后一条结尾的链。
 *
 * 规则：从尾部往前走，每一步要求 `hopDepth` 恰好比后一条小 1；不满足就停。
 * 用户发起的 0 跳能接在 1 跳前面（那就是链的根）；而两条 0 跳相邻时，
 * 后者（更晚的那条）会被切出来单独成链 —— **正是「用户打断递增」的意思**。
 *
 * `queued` / `running` 对判链**不可见**（不算一跳、也不占位）：见文件头那两条代价。
 */
export function chainOf(turns: readonly ChainTurn[]): ChainTurn[] {
  const done = turns.filter((t) => t.status !== 'queued' && t.status !== 'running')
  const tail = done[done.length - 1]
  if (!tail) return []
  const chain: ChainTurn[] = [tail]
  for (let i = done.length - 2; i >= 0; i--) {
    const prev = done[i]
    const head = chain[0]
    if (!prev || !head || prev.hopDepth !== head.hopDepth - 1) break
    chain.unshift(prev)
  }
  return chain
}

// ─────────────────────────────────────────────────────────────
// ⑤ 乒乓熔断（第 1 条）
// ─────────────────────────────────────────────────────────────

/** 2 跳空转 → 可见警告。 */
export const PING_PONG_WARN_HOPS = 2
/** 4 跳空转 → 强制终止该链。 */
export const PING_PONG_TERMINATE_HOPS = 4

export interface ChainHop {
  turnId: string
  hopDepth: number
  hadWork: boolean
}

export type PingPongAction = 'none' | 'warn' | 'terminate'

export interface PingPongVerdict {
  action: PingPongAction
  /**
   * 链尾**连续**空转的跳数（数到第一个有实质工作的跳为止）——
   * 这就是 §4.5b「任一跳里出现实质性工作就清零计数」的落地形态：
   * 不需要维护一个可变计数器，**数一遍后缀**就是那个计数器的值。
   */
  emptyHops: number
  /** 给人看的判决说明（进 note / 日志）。**不含跳数数字**时也要能读懂。 */
  message: string
}

/**
 * §4.5b 第 1 条。
 *
 * ★ 投影成两个**精确**阈值，而不是「≥ 就报」：
 * - `emptyHops === 2` 才警告：`≥ 2` 会让 3 跳那一次再弹一遍同样的警告（噪音），
 *   而它要说的那句话在 2 跳时已经说完了。
 * - `emptyHops >= 4` 才终止：用 `≥` 而不是 `==` 是因为**终止必须兜住**——
 *   万一某一跳因为别的路径没能终止，下一跳不能就这么放过去。
 */
export function pingPongOf(hops: readonly ChainHop[]): PingPongVerdict {
  let emptyHops = 0
  for (let i = hops.length - 1; i >= 0; i--) {
    if (hops[i]?.hadWork) break
    emptyHops++
  }

  if (emptyHops >= PING_PONG_TERMINATE_HOPS) {
    return {
      action: 'terminate',
      emptyHops,
      message: '这条协作链连续几跳都没有任何实际动作（既没有工具调用，也没有文件改动），本轮之后不再往下派发'
    }
  }
  if (emptyHops === PING_PONG_WARN_HOPS) {
    return {
      action: 'warn',
      emptyHops,
      message: '这条协作链已经连续几跳没有任何实际动作（只有来回发言）。再往后仍然如此的话，它会被自动终止'
    }
  }
  return { action: 'none', emptyHops, message: '链上有实质工作，或空转跳数未到阈值' }
}

// ─────────────────────────────────────────────────────────────
// ⑥ 去重（第 2 条）
// ─────────────────────────────────────────────────────────────

/**
 * 去重键 = `(目标成员, 本轮内容哈希)`。
 *
 * ★ **哈希由调用方算**（本文件在 `domain/` 里，不 import `node:crypto`）。
 * 内容指**要转述给对方的正文**（`relayTextOf` 的产物）：它决定了那一轮会看到什么，
 * 也正是「同一件事被派了两次」的那个「事」。
 */
export function dedupeKeyOf(memberId: string, contentHash: string): string {
  return `${memberId}:${contentHash}`
}

/** 尚未执行的尾部的一条。`running` 的**不算尾部**（§4.5b：已经执行过了 ⇒ 可以再派）。 */
export interface QueuedTailEntry {
  memberId: string
  dedupeKey: string
}

// ─────────────────────────────────────────────────────────────
// ⑦ 名字 / mention → 成员（规则 ①-④）
// ─────────────────────────────────────────────────────────────

export interface FanoutNote {
  tag: string
  level: 'info' | 'warn'
  message: string
  detail?: unknown
}

/**
 * 一条 mention 的**问题**，没有问题时返回 `null`。
 *
 * ★ 四条判据在这里**只有这一份实现**，而它有两个调用方，两者的**失败语义刻意不同**：
 *
 * - `handlers/turn.ts`（用户结构化 @）：有问题 ⇒ **`E_INVALID_PAYLOAD`，整条消息发不出去**。
 *   用户当场就能改 —— 静默丢掉一个他明确点的人，是界面在说谎。
 * - `fanoutOf`（agent 回复里的 @）：有问题 ⇒ **丢这一条 + 记一条 note，其余照常派**。
 *   agent 的一轮产物不能因为「它 @ 了一个停用的成员」而作废 —— 那会连它已经做完的
 *   工作一起丢掉；但也不能当作没发生（note 会进日志、`notes` 会进推送的 detail）。
 *
 * 判据只有一份、反应不同 —— 这是 §4.5a 规则一「单一所有者」的形态：
 * 分叉的是**动作**，不是**规则**。
 */
export function mentionProblemOf(input: {
  memberId: string
  selfMemberId: string
  members: readonly WorkspaceMember[]
}): FanoutNote | null {
  const member = input.members.find((m) => m.id === input.memberId)
  if (!member) {
    return {
      tag: 'mention-not-a-member',
      level: 'warn',
      message: `@ 的目标不在这个空间里（记不到它的名字），已跳过`,
      detail: { memberId: input.memberId }
    }
  }
  if (member.id === input.selfMemberId) {
    return {
      tag: 'mention-self',
      level: 'warn',
      message: `「${member.displayName}」@ 了它自己，已跳过（那会是一条自己派给自己的链）`,
      detail: { memberId: member.id }
    }
  }
  if (!member.enabled) {
    return {
      tag: 'mention-disabled',
      level: 'warn',
      message: `「${member.displayName}」已停用，没有派给它`,
      detail: { memberId: member.id }
    }
  }
  return null
}

/**
 * 名字 → 结构化 mention（agent 回复那条路）。
 *
 * 匹配策略：**先精确、再大小写不敏感**。后者是模型最常见的偏差（`nyx` vs `Nyx`），
 * 而它**不静默**：用到了会记一条 `mention-name-case` note。
 * 名字里有空格、改过名之类的问题在这里**不猜** —— 匹配不上就是不派发 + 一条 note。
 */
export function resolveMentions(input: {
  names: readonly string[]
  selfMemberId: string
  members: readonly WorkspaceMember[]
}): { mentions: Mention[]; notes: FanoutNote[] } {
  const notes: FanoutNote[] = []
  const mentions: Mention[] = []
  const seen = new Set<string>()

  for (const name of input.names) {
    const exact = input.members.find((m) => m.displayName === name)
    // 大小写不敏感这一遍只在**唯一命中**时才用：两个成员只差大小写时宁可判不出来
    // （判不出来 = 不派发 + 一条 note，而猜错 = 派给了错的人）。
    const loose = exact ? [] : input.members.filter((m) => m.displayName.toLowerCase() === name.toLowerCase())
    const member = exact ?? (loose.length === 1 ? loose[0] : undefined)

    if (!member) {
      notes.push(
        loose.length > 1
          ? {
              tag: 'mention-ambiguous-name',
              level: 'warn',
              message: `回复里 @ 了「${name}」，本空间有 ${loose.length} 个成员的名字只在大小写上不同，分不清是哪一个，已跳过`,
              detail: { name, candidates: loose.map((m) => m.displayName) }
            }
          : {
              tag: 'mention-unknown-name',
              level: 'warn',
              message: `回复里 @ 了「${name}」，但本空间没有叫这个名字的成员，已跳过`,
              detail: { name }
            }
      )
      continue
    }
    if (!exact) {
      notes.push({
        tag: 'mention-name-case',
        level: 'info',
        message: `回复里的「${name}」按大小写不敏感匹配到了「${member.displayName}」`,
        detail: { name, matched: member.displayName }
      })
    }

    const problem = mentionProblemOf({ memberId: member.id, selfMemberId: input.selfMemberId, members: input.members })
    if (problem) {
      notes.push(problem)
      continue
    }
    if (seen.has(member.id)) continue
    seen.add(member.id)
    mentions.push({ memberId: member.id, kind: 'to' })
  }

  return { mentions, notes }
}

// ─────────────────────────────────────────────────────────────
// ⑧ 扇出判决
// ─────────────────────────────────────────────────────────────

export interface FanoutInput {
  selfMemberId: string
  /** **含停用的**全部成员 —— 「已停用」这条判据要能报出来，所以不能只给启用的。 */
  members: readonly WorkspaceMember[]
  /** 结构化 mention（用户那条路已经是结构化的；agent 那条路先过 `resolveMentions`）。 */
  wanted: readonly Mention[]
  /** 尚未执行的尾部（`turn.listLive()` 里 `status === 'queued'` 的那些）。 */
  queuedTail: readonly QueuedTailEntry[]
  /** 本轮要转述的正文哈希（`dedupeKeyOf` 的另一半）。 */
  contentHash: string
}

export interface FanoutTarget {
  memberId: string
  displayName: string
  kind: Mention['kind']
}

export interface FanoutPlan {
  targets: FanoutTarget[]
  notes: FanoutNote[]
}

/**
 * 「这一轮 @ 出去的东西，最终要做什么」—— 判决与执行分开：这里只**算**。
 *
 * 顺序（① 判定点是**扇出之前**，见 §5.3）：本函数只管验证与去重；
 * 乒乓（⑤）的判定在它**之前**由调用方做，因为终止时**连它都不该被调用**。
 *
 * ★ **广播不在这里拦**（§4.5b 第 3 条）：本函数**不因成员数而拒绝**。
 * 走查有一条断言盯着这件事，单测里也有一条反向对照。
 */
export function fanoutOf(input: FanoutInput): FanoutPlan {
  const notes: FanoutNote[] = []
  const targets: FanoutTarget[] = []
  const queuedKeys = new Set(input.queuedTail.map((q) => q.dedupeKey))
  const seen = new Set<string>()

  for (const want of input.wanted) {
    const problem = mentionProblemOf({
      memberId: want.memberId,
      selfMemberId: input.selfMemberId,
      members: input.members
    })
    if (problem) {
      notes.push(problem)
      continue
    }
    const member = input.members.find((m) => m.id === want.memberId)
    if (!member) continue // `mentionProblemOf` 已经报过；这里只是让类型收窄。
    if (seen.has(member.id)) continue
    seen.add(member.id)

    // 去重只对 `to` 有意义：`cc` 不建轮次，也就没有「同一轮被排两次」这件事。
    if (want.kind === 'to' && queuedKeys.has(dedupeKeyOf(member.id, input.contentHash))) {
      notes.push({
        tag: 'mention-deduped',
        level: 'info',
        message: `「${member.displayName}」手上已经排着同样内容的一轮（还没开始跑），这次没有重复派`,
        detail: { memberId: member.id }
      })
      continue
    }

    targets.push({ memberId: member.id, displayName: member.displayName, kind: want.kind })
  }

  return { targets, notes }
}

// ─────────────────────────────────────────────────────────────
// ⑨ 转述正文
// ─────────────────────────────────────────────────────────────

export interface RelayInput {
  authorName: string
  kind: Mention['kind']
  /** 派发方的原文（agent 的回复，或用户那条消息）。 */
  body: string
  /** 被 @ 的那一轮的来源：回复里 @ 的，还是用户消息里 @ 的。 */
  via: 'reply' | 'message'
  /** 原文里有没有 `<mentions>` 块被删掉（`stripMentionsBlock` 干的事）。 */
  stripped: boolean
}

/**
 * 落到对方会话里的那条 `role: 'user'` 消息的正文。
 *
 * 为什么需要它：**各成员的会话是分开的**，所以 B 看不到 A 的回复 ——
 * 除非我们把 A 的原话**搬一条**进 B 的会话。搬的是原话本身（不是摘要、不是改述），
 * 理由：B 要接的是具体的事，任何改述都可能丢掉那一件事。
 *
 * 头部一句话说清三件事：谁、因为什么、要不要行动。`cc` 的最后一句尤其重要 ——
 * 「不需要行动」这四个字不写，被抄送者会以为自己在被派活。
 */
export function relayTextOf(input: RelayInput): string {
  const where = input.via === 'reply' ? '在它上一轮的回复里' : '在刚发的那条消息里'
  const head =
    input.kind === 'cc'
      ? `【抄送】${input.authorName} ${where}抄送了你 —— 你不需要行动，只是让你知道。`
      : `【派发】${input.authorName} ${where} @ 了你，把这件事交给你。`
  const stripped = input.stripped
    ? '\n\n（它原文末尾的 `<mentions>` 那一行已由本应用取出 —— 那是派发指令，不是给你看的。）'
    : ''
  return `${head}${stripped}\n\n—— 以下是原文 ——\n\n${input.body}`
}
