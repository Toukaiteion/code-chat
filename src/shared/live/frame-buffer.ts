/**
 * 帧 → 在途轮次的缓冲。**纯逻辑：零 DOM、零 electron、零运行时 import。**
 *
 * ## 它在整条链路里的位置
 *
 * 合批器（主进程）把 200 delta/s 拼成 ~30Hz 的批；这里把那些批**折进一个可渲染的
 * 轮次状态**。两者是同一件事的两半：那边管「什么时候发」，这边管「收到之后是什么」。
 *
 * 放在 `src/shared/` 而不是 `renderer/` 的**唯一**理由是可测：仓库里没有渲染层测试
 * （没有 jsdom、没有 vitest），`npm test` 是裸 Node。而这里恰好是整个 M6b 里最容易错的
 * 部分 —— 帧合并、工具配对、`thinking_end` 折叠、未知帧 —— 每一件都是纯函数。
 * 留在组件里的话，它们只能靠「点开应用看一眼」来验证。
 *
 * `import type` 是**真的**类型导入：`contract.ts` 全是 `import type`，
 * 所以这个模块编译出来没有任何 require，裸 Node 直接跑得动。
 *
 * ## ★ 一条贯穿全文件的不变式：**缓冲的正文只来自帧，从不来自历史**
 *
 * 历史里的 `message.content_text` 与帧是**同一份字节的两个去向**（§2.3 明写要同源），
 * 所以很诱人：拿 `content_text` 当起始值，再把新帧追加上去。**不做**，因为两者
 * 描述的是**不同时刻的同一个流**：
 *
 * - `content_text` 是**每次刷新**（~33ms）折进去的，它对应「所有 seq ≤ s.seq 的帧」；
 * - 而渲染层手里的水位线是「**我收到过的**最大 toSeq」，两者只在刷新边界上相等。
 *
 * 于是「先用历史播种、再追加帧」会在这两种情况下**安静地重复或缺口**：
 * 帧被抑制期间（切走）历史已经折进去了，切回来重放会**再追加一遍**；
 * 反过来，重放从中间接上时历史比水位线新，会**缺一段**。
 * 这两种都不会报错，只会让界面上的文字比真实的多一块或少一块。
 *
 * 所以：**一个轮次要由帧渲染，就必须从它的第一帧开始由帧渲染。**
 * 做不到的时候（新进程打开一个已经在跑的轮次 —— 见 `watermark.ts` 的说明）就
 * **不建缓冲**，让历史行自己显示。那个选择在 `live` slice 里落成一句话：
 * **有缓冲才抑制历史行**。
 */
import type { AgentErrorCode, TerminalReason } from '../entities.ts'
import type { PushOf } from '../ipc/contract.ts'

export type StreamBatch = PushOf<'stream:batch'>
export type StreamFrame = StreamBatch['frames'][number]

type UsageFrame = Extract<StreamFrame, { k: 'usage' }>

/** 一次工具调用的结果。`truncated` 为真时 `output` 是**截断过的**（§5.8）。 */
export interface ToolResult {
  ok: boolean
  output: string
  truncated: boolean
}

/**
 * 时间线上的一个非正文条目，**按到达序**排列。
 *
 * 三类东西共用一条时间线，因为它们在第一轮实现里就该按发生顺序排 ——
 * 分开存成三个数组的话，「先改文件再报错」与「先报错再改文件」在界面上会看不出区别。
 */
export type TimelineItem =
  | {
      kind: 'tool'
      id: string
      /**
       * 见过 `tool_start` 吗。
       *
       * ★ 为假时下面两个字段是 `null`/`undefined`，而**界面必须如实说「没见到调用」**，
       * 不许拿工具 id 去猜名字。重放从中间接上就会出现这种条目（§4.6a 规则一：
       * 算不出来就说算不出来，不要编一个看起来合理的）。
       */
      started: boolean
      name: string | null
      input: unknown
      result: ToolResult | null
    }
  | {
      kind: 'diff'
      path: string
      /**
       * `tool-diff.ts` 定死的格式（那个文件是**所有者**，这里是读者）：
       * 内容行的首字符永远是 `-` 或 `+`；`#` 开头的是**我们自己的注释**；
       * **没有 `@@`、没有行号、没有上下文行**。
       *
       * 渲染方（`DiffBlock.tsx`）按这个语法着色，**绝不自己去算行号** ——
       * 位置是未知的，那件事被如实表达，不该被一个数字盖住。
       */
      patch: string
    }
  | { kind: 'error'; code: AgentErrorCode; message: string; fatal: boolean }

/**
 * 一轮对话的在途状态。
 *
 * ★ **`text` 与 `thinking` 必须是两个字段，不能合成一个字符串列表。**
 * §4.7 规则 4 要求思考 delta **不触发正文节点重渲染** —— 那只有在
 * 「两个字段各自能被单独订阅」时才成立。下面的 `applyFrame` 因此
 * **只重建被改动的那一个**：`text` 变化时 `thinking` 保持同一个字符串引用，
 * 反之亦然。全量重建对象是允许的（字符串是同一个引用），
 * **重建数组则不行**（`items` 只在真的增删时才换引用）。
 */
export interface TurnBuffer {
  readonly turnId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly actorId: string
  /** 流式正文。**只来自 `text` 帧**（见文件头那条不变式）。 */
  readonly text: string
  /** 流式思考内容。**只来自己方渲染**，绝不进上下文（§4.2 的结构性排除）。 */
  readonly thinking: string
  /** 思考面板是否展开。`thinking_end` 到达后收起；**再来了新思考就重新展开**。 */
  readonly thinkingOpen: boolean
  readonly items: readonly TimelineItem[]
  readonly usage: UsageFrame | null
  /** `done` 帧的结束原因。非空 = **正文已经结束**（但库里那一行可能还是 running，见下）。 */
  readonly done: TerminalReason | null
}

/** 建缓冲需要的那几个 id。全部来自 `stream:batch` —— 帧上不带它们。 */
export interface TurnIds {
  turnId: string
  sessionId: string
  workspaceId: string
  actorId: string
}

export function emptyBuffer(ids: TurnIds): TurnBuffer {
  return {
    turnId: ids.turnId,
    sessionId: ids.sessionId,
    workspaceId: ids.workspaceId,
    actorId: ids.actorId,
    text: '',
    thinking: '',
    // 初值为 `true`：第一段思考 delta 到达时应当能看见它。
    // 没有思考的那一轮 `thinking` 恒为空，面板根本不会渲染，所以这个初值不会
    // 泄漏成一个空面板。
    thinkingOpen: true,
    items: [],
    usage: null,
    done: null
  }
}

/** 按到达序找最后一个同 id 的工具条目。找不到返回 -1。 */
function lastToolIndex(items: readonly TimelineItem[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it && it.kind === 'tool' && it.id === id) return i
  }
  return -1
}

function withItem(items: readonly TimelineItem[], index: number, next: TimelineItem): TimelineItem[] {
  const out = items.slice()
  out[index] = next
  return out
}

/**
 * 单帧归约。**导出它**是为了让测试能逐帧喂，而不是只能一批一批喂 ——
 * 「批内相邻同类帧」和「跨批同类帧」是两种情形，混在一起测就看不出区别了。
 */
export function applyFrame(buf: TurnBuffer, f: StreamFrame): TurnBuffer {
  switch (f.k) {
    case 'text':
      // 空 delta 不动引用：它会白白让订阅 `text` 的组件重渲染一次。
      return f.d === '' ? buf : { ...buf, text: buf.text + f.d }

    case 'thinking':
      // ★ 重新展开：`thinking_end` 之后可能还有第二段思考（工具调用之间会发生），
      // 那时候把新内容塞进一个收起的面板里 = 用户看不见它，而它明明来了。
      return f.d === '' ? buf : { ...buf, thinking: buf.thinking + f.d, thinkingOpen: true }

    case 'thinking_end':
      return buf.thinkingOpen ? { ...buf, thinkingOpen: false } : buf

    case 'tool_start': {
      const i = lastToolIndex(buf.items, f.id)
      const existing = i >= 0 ? buf.items[i] : undefined
      // 少见但要有定义：先见到 result、后见到 start（重放从中间接上）。
      // 补全那一条，而不是**再压一条** —— 压两条的话界面上会出现两次同一个调用。
      if (existing && existing.kind === 'tool' && !existing.started) {
        return {
          ...buf,
          items: withItem(buf.items, i, { ...existing, started: true, name: f.name, input: f.input })
        }
      }
      return {
        ...buf,
        items: [
          ...buf.items,
          { kind: 'tool', id: f.id, started: true, name: f.name, input: f.input, result: null }
        ]
      }
    }

    case 'tool_result': {
      const result: ToolResult = { ok: f.ok, output: f.output, truncated: f.truncated === true }
      const i = lastToolIndex(buf.items, f.id)
      const existing = i >= 0 ? buf.items[i] : undefined
      if (existing && existing.kind === 'tool') {
        return { ...buf, items: withItem(buf.items, i, { ...existing, result }) }
      }
      // 没见过这次调用。**名字留空**，让界面说「未见到调用」——
      // 拿 id 去猜一个工具名是最容易犯的错，猜出来的名字会被当成事实读。
      return {
        ...buf,
        items: [
          ...buf.items,
          { kind: 'tool', id: f.id, started: false, name: null, input: undefined, result }
        ]
      }
    }

    case 'file_diff':
      // `patch` **原样透传**，一个字符都不动（见 `TimelineItem` 上那段说明）。
      return { ...buf, items: [...buf.items, { kind: 'diff', path: f.path, patch: f.patch }] }

    case 'error':
      return {
        ...buf,
        items: [...buf.items, { kind: 'error', code: f.code, message: f.message, fatal: f.fatal }]
      }

    case 'usage':
      // **覆盖，不是累加。** 一轮只发一条 usage（`event-batcher` 的 `usageFrame()` 从终态
      // `result` 造它），所以「累加」会把同一轮的用量算两遍。真来了第二条时，
      // 后到的那条才是终态的，覆盖它是对的。
      return { ...buf, usage: f }

    case 'done':
      return { ...buf, done: f.reason }

    default:
      // ★ 这个分支**必须有**，尽管 `StreamFrame` 是闭合联合、TS 认为上面的 case 已穷尽。
      // 理由是推送路径**不做校验**：`client.ts` 的 `onPush` 直接
      // `bridge.on(channel, listener as …)`，把载荷原样交给监听器 —— 没有 zod。
      // 所以一个我们不认识的帧（主进程版本更新、或线上格式被改）会真的走到这里。
      // 静默忽略是对的：一个看不懂的帧不该让整个轮次的渲染崩掉。
      return buf
  }
}

/**
 * 一批帧折进缓冲。**这是渲染层唯一的写入口**（`live` slice 里没有第二个）。
 *
 * - `buf` 为 `null` 且 `frames` 非空 → 新建一个缓冲；
 * - `buf` 为 `null` 且 `frames` 为空 → **返回 `null`**，不建空缓冲。
 *   这一条很重要：空缓冲会让历史行被抑制，于是一个什么都没有的轮次
 *   会把已有的历史行**藏起来**。
 */
export function applyFrames(
  buf: TurnBuffer | null,
  ids: TurnIds,
  frames: readonly StreamFrame[]
): TurnBuffer | null {
  if (frames.length === 0) return buf
  let next = buf ?? emptyBuffer(ids)
  for (const f of frames) next = applyFrame(next, f)
  return next
}
