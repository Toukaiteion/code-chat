/**
 * 帧水位线 + 纪元 + 「这一轮我够不够格自己渲染」的**状态机**（纯逻辑，裸 Node 可测）。
 *
 * ## 为什么这件事需要一个模块，而不是一个 `useRef` 里的数字
 *
 * 因为它是整个 M6b 里唯一一处**错了不会报错、只会让界面永远不动或悄悄重复**的地方。
 * 三条 `seq` 轴（§4.3-2）里，帧 `seq` 是唯一能当水位线的那条 —— 而它**不落库**，
 * 所以它推不出来，只能由「我收到过什么」记下来。记错的表现是：
 * 数字偏小 → 每批帧都被判成旧的、界面静默冻住；数字偏大 → 一段内容永远收不到。
 *
 * ## ★ `epoch` 只能**学到**，不能自己造（§4.7 的所有权表）
 *
 * 它的所有者是主进程的合批器（每进程铸造一次），这里只负责持有与回传。
 * 「自己造一个」的唯一后果是 `stream:resume` 一律返回 `matched: false` + 空帧 ——
 * 而那个结果**看起来和一个正常的空回复一模一样**，所以这个错误会活得很久。
 *
 * ## ★★ 重放能拿到多少：**只有当你从这一轮的第一帧要起**（读 `event-batcher` 得到）
 *
 * `beginTurn` 在**新一轮的第一帧**到来时做两件事：把上一轮的在途帧丢掉
 * （`retainedFrom = max(retainedFrom, s.seq)`），并把回放环清空。
 * 而 `resume()` 有三道判断：
 *
 * ```
 * epochIn !== epoch        → matched:false + 空帧
 * fromSeq  >  s.seq        → matched:false + 空帧
 * fromSeq  <  s.retainedFrom → matched:false + 空帧
 * ```
 *
 * 三条推论，每一条都直接决定了 M6b 的做法：
 *
 * 1. **环里只有「当前这一轮」的帧。** 上一轮的帧在它自己那一轮结束、下一轮开始时被丢掉。
 * 2. **`fromSeq: 0` 只有在本会话于本进程里的第一轮才拿得到整轮**：
 *    那时 `retainedFrom` 还是 0；一旦跑过一轮，`retainedFrom` 就 > 0 → `matched:false`。
 * 3. **用「我自己的水位线」去问，拿到的永远是尾巴**（`seq > fromSeq` 的那一段）。
 *
 * 推论 3 是第一版协议踩过的坑，值得写清楚它错在哪：`watermarks[sessionId]` 是
 * **跨轮次**的（它只增不减），所以「我有一条水位线」**不等于**「我看着这一轮从头开始」。
 * 按推论 3 去问，切回来时拿到的是**半截**正文，而 `frame-buffer` 那条不变式
 * （一个轮次要由帧渲染，就得从第一帧起由帧渲染）会让这半截缓冲**盖住**已经完整的历史行
 * —— 用户看到的是「回答只有最后一段」。
 *
 * 所以这里记两样**按轮次**的东西（`turns`），它们才是重放协议真正需要的：
 *
 * - `startSeq`：**这一轮的第一帧之前的那个水位线**。它就是主进程那边的 `retainedFrom`
 *   （当我们看着上一轮跑到结束时），拿它去问就能要到**整轮**；
 * - `fromStart`：我们**有没有见到这一轮的第一帧**。为假时不许建缓冲（见下）。
 *
 * ## ★ `fromStart` 为假时**不许建缓冲**，让历史行自己显示
 *
 * 那是「新进程打开一个已经在跑的轮次」那一类：我们没有它的开头，而缓冲一旦存在就会
 * 抑制历史行（`live.ts` 的那条不变式），于是界面只剩半截。
 * 退化成历史行是**正确**的：`content_text` 就是这一轮到目前为止的正文。
 * 代价是它在轮次结束前不再增长（历史只在轮次终态后重读），这一条**已知且记在文档里**。
 */
import type { StreamBatch, StreamFrame } from './frame-buffer.ts'

/** 一次 `stream:resume` 的响应形状（与 `schemas.ts` 的 `res` 逐字一致）。 */
export interface ResumeResponse {
  epoch: string
  matched: boolean
  frames: StreamFrame[]
}

/**
 * 渲染层对**某个会话的当前这一轮**的记忆。三个字段都只对「当前这一轮」有意义，
 * 换轮次时整体重算。
 */
export interface TurnWatch {
  /** 当前正在看的轮次 id。它与下一批的 `turnId` 不同，就说明换轮了。 */
  turnId: string
  /**
   * 这一轮**起始处**的水位线（= 上一轮结束时我们拥有的水位线）。
   *
   * ★ 拿它去 `stream:resume` 能要到**整轮**；拿 `watermark` 去要只能要到尾巴。
   * 两者差在「我离开期间它已经说出去的那一段」，而那段恰恰是用户最想看到的。
   */
  startSeq: number
  /**
   * 我们见到这一轮的**第一帧**了吗。
   *
   * 判据只有一条：这一轮我们见到的**第一批帧**的 `fromSeq` 是否就落在 `startSeq` 上
   * （`fromSeq <= startSeq + 1`）。为假 ⇒ 我们是从中间接上的 ⇒ **不许建缓冲**。
   *
   * ⚠️ 这个判断只在**第一次见到这一轮**时做一次，之后一直沿用。
   * 「每次拿 `fromSeq` 现算」看着更简单，其实是错的：`fromSeq` 每批都往后走，
   * 第二批就会被判成「没见到开头」，于是第一个 delta 之后界面就再也不建缓冲了。
   */
  fromStart: boolean
}

/**
 * 渲染层对「流」的全部记忆。
 *
 * ⚠️ `watermarks` 的值是**已应用过的最大 `toSeq`**，不是「最后一帧的 seq」——
 * 合并保留首个 seq，所以被分配后又被合并掉的号会被跳过，`toSeq` 是计数器高水位。
 * 拿末帧的 seq 当水位线的后果：下一次 `resume` 会把自己以为漏掉的那一段**再要一遍**。
 */
export interface StreamCursor {
  /** 本进程的纪元。`null` = 还没学到（此时**不能**重放，见文件头）。 */
  readonly epoch: string | null
  /** sessionId → 已应用过的最大 `toSeq`。没有条目 = 从没见过这个 session 的帧。 */
  readonly watermarks: Readonly<Record<string, number>>
  /** sessionId → 当前这一轮的记忆。纪元一变整体作废。 */
  readonly turns: Readonly<Record<string, TurnWatch>>
}

export function emptyCursor(): StreamCursor {
  return { epoch: null, watermarks: {}, turns: {} }
}

/** 帧里最大的 `seq`。空数组返回 `null`（**不是 0** —— 0 会伪装成一个合法水位线）。 */
export function maxFrameSeq(frames: readonly StreamFrame[]): number | null {
  let max: number | null = null
  for (const f of frames) if (max === null || f.seq > max) max = f.seq
  return max
}

export interface EpochUpdate {
  cursor: StreamCursor
  /**
   * 纪元**变了**（或这是第一次学到）。
   *
   * ★ 为真时调用方必须**丢掉全部缓冲**：旧缓冲的正文是按旧编号的帧拼的，
   * 而编号已经换了纪元 —— 继续拿新帧往上面追加，拼出来的是两段不同编号体系的文字。
   */
  epochChanged: boolean
}

/** 学到纪元。纪元一变，**所有水位线与轮次记忆整体作废**（它们属于上一套编号）。 */
export function learnEpoch(cursor: StreamCursor, epoch: string): EpochUpdate {
  if (cursor.epoch === epoch) return { cursor, epochChanged: false }
  return { cursor: { epoch, watermarks: {}, turns: {} }, epochChanged: true }
}

/**
 * 收到一批实时帧 → 推进水位线，并在**换轮次的那一批**上重算 `turns`。
 *
 * ★ **实时批次不过滤**，这条不是省事：主进程已经决定好发什么了
 * （抑制在合批器里做，§4.3）。渲染侧再按 seq 过滤一遍，只会在
 * 「合并跳号」之类的正常情形下把自己筛出空档。
 */
export function observeBatch(cursor: StreamCursor, batch: StreamBatch): EpochUpdate {
  const { cursor: c, epochChanged } = learnEpoch(cursor, batch.epoch)
  const sessionId = batch.sessionId
  const before = c.watermarks[sessionId] ?? 0
  const watch = c.turns[sessionId]

  return {
    cursor: {
      epoch: c.epoch,
      // ★ 取 `max` 不是防御性写法，是**语义如此**：水位线的含义是「我有了到这儿为止的内容」，
      // 而一批新收到的帧只会让这个「到这儿为止」往前进，不可能往回退。
      // （同一个纪元内 `toSeq` 本来就单调，所以两者平时相等；取 max 是为了让
      // 「含义」与「代码」是同一句话，而不是让某个异常值把水位线拉回去、
      // 于是下一次 `resume` 把已经有的那段再要一遍。）
      watermarks: { ...c.watermarks, [sessionId]: Math.max(before, batch.toSeq) },
      // 已经看着这一轮 → 记忆原样保留（`fromStart` 只判定一次，见 `TurnWatch`）。
      turns:
        watch !== undefined && watch.turnId === batch.turnId
          ? c.turns
          : {
              ...c.turns,
              [sessionId]: {
                turnId: batch.turnId,
                // 换轮那一刻的水位线就是这一轮的起点。它等于主进程的 `retainedFrom`
                // —— 前提是上一轮我们看到了底（没看到的话 `startSeq` 会偏小，
                // 而偏小的后果是 `matched:false`，那是一条**安全**的退路）。
                startSeq: before,
                // 只看这一批：把 `fromSeq` 与 `startSeq` 对齐，就是「从头看起」的定义。
                fromStart: batch.fromSeq <= before + 1
              }
            }
    },
    epochChanged
  }
}

/**
 * 要不要重放、拿什么去重放。返回 `null` = **不重放**。
 *
 * 只有一种情况不重放：**还不知道纪元**（新进程刚起来还没收到任何一批帧，
 * 也就没处去学纪元）。那时发什么都是空帧，见文件头。
 *
 * ⚠️ 「这个 session 没有水位线」**不再是**不重放的理由，这一条是 M6b 落地时改的：
 * 没有水位线时 `fromSeq` 只能给 `0`，而在**本会话于本进程的第一轮**上
 * `0` 恰好是那个对的答案（`retainedFrom` 还是 0）—— 一次就能把整轮要回来，
 * 界面直接从流式渲染接上。给 `0` 在别的轮次上会得到 `matched:false`，
 * 那是一个**安全的**空手而归：调用方据此退回历史渲染。
 *
 * ## `hasBuffer` 决定问哪一头
 *
 * - **手里已经有这一轮的缓冲**（看着它跑、中途切走又切回来）→ 只能要**尾巴**
 *   （`watermark`）。要整轮会把这轮已应用过的帧**再折一遍**，正文出现两遍。
 * - **手里没有**（这一轮是新看到的 / 是在别处跑着的）→ 要**整轮**（`startSeq`），
 *   因为 `frame-buffer` 那条不变式要求缓冲从第一帧起。
 */
export function resumePlan(
  cursor: StreamCursor,
  sessionId: string,
  hasBuffer: boolean
): { epoch: string; fromSeq: number } | null {
  if (cursor.epoch === null) return null
  const from = hasBuffer
    ? (cursor.watermarks[sessionId] ?? 0)
    : (cursor.turns[sessionId]?.startSeq ?? 0)
  return { epoch: cursor.epoch, fromSeq: from }
}

/**
 * 收到一批实时帧之后，**该对缓冲做哪几件事**。
 *
 * ★ 这三件事必须**分开说**，而这是 M6b 真机走查用一次真实损失换来的：
 * 第一版把它们揉成了一句「纪元变了 → 清空缓冲，这一批也丢掉」，其中
 * `resetBuffers` 针对的是**旧**缓冲（按上一套编号拼的），而 `useFrames` 说的是**这一批**
 * —— 它带的就是新纪元（`batch.epoch` 正是刚被学到的那个），凭什么丢。
 *
 * 揉在一起的后果是：**进程启动后的第一批帧永远被吃掉**（纪元的第一个消息就是学它），
 * 于是每次开应用，那一轮回答的**开头**都缺一段。走查量到的形状是「DOM 45 字 / 帧 66 字」，
 * 缺的正是模型说的第一句 —— 而界面显示的是一个**完整的、只是更短的**回答，
 * 所以它不像出错，只是内容悄悄少了一截。
 *
 * 这个函数存在的理由就是让那次教训**留在类型里**：`useFrames` 恒为真，
 * 想让「纪元变了」顺带把帧也丢掉，就得先把这个字段改成假 —— 而测试会当场拦下。
 */
export interface BatchPlan {
  /** 旧缓冲是否全部作废。纪元变了（含第一次学到）就是真的。 */
  resetBuffers: boolean
  /** 这一批的帧收不收。**恒为真**，见上面那段。 */
  useFrames: boolean
  /** 允不允许**新建**缓冲。为假时这一批的帧照收，只是没有缓冲可接（也就无处可收）。 */
  createBuffer: boolean
}

/**
 * 三个判断的合流处。
 *
 * ⚠️ 顺序上有个陷阱：`hasBuffer` 应当是**纪元作废之后**的处境 ——
 * 纪元一变，那个轮次的缓冲已经不存在了。调用方先在 `resetBuffers` 之下取
 * 「这个 turnId 还有没有缓冲」，再把结果传进来，两者才是同一件事。
 */
export function planBatch(
  watch: TurnWatch | undefined,
  turnId: string,
  hasBuffer: boolean,
  epochChanged: boolean
): BatchPlan {
  // 「没见到这一轮的第一帧」→ 不许**新建**缓冲（`fromStart` 的说明见 `TurnWatch`）。
  // 手里已经有缓冲的照常追加：那种情况下我们是从头看着的，中途切走又切回来而已。
  const midTurnJoin =
    !hasBuffer && watch !== undefined && watch.turnId === turnId && !watch.fromStart
  return { resetBuffers: epochChanged, useFrames: true, createBuffer: !midTurnJoin }
}

export interface ResumeOutcome {
  cursor: StreamCursor
  /**
   * `true` → `frames` 可用，接在已有缓冲后面。
   *
   * `false` → **这条水位线作废了**。调用方必须：丢掉该 session 的缓冲、
   * 让对应的历史行自己显示、**并且不重试** ——
   * 重试永远推不出正确的水位线（§4.3 明写），它只会一直返回 `false`。
   * 三种成因（纪元不同 / 水位线超前 / 环里已经淘汰）在契约上就**塌成同一个响应**，
   * 因为渲染层的动作三者完全一样。
   */
  accepted: boolean
}

/**
 * 应用一次 `stream:resume` 的结果。
 *
 * 成功时水位线推到**收到的最后一帧**（没有帧就保持原值 —— 那是「我离开期间它没产出任何东西」，
 * 一个完全正常的情形，不是失败）。
 *
 * ★ 注意这里推的是**帧的 seq**，而实时路径推的是 `toSeq`。两者**不是同一个算法，
 * 也不需要是**：帧 seq 是单调分配后可能被合并跳过的，所以随便取哪个都只能是个下界，
 * 而水位线的语义本来就是「我已经有了到这儿为止的内容」。下次实时批次的 `fromSeq`
 * 只会**严格更大**，所以不会因为取了下界而把新帧误判成旧的。
 */
export function applyResume(
  cursor: StreamCursor,
  sessionId: string,
  res: ResumeResponse
): ResumeOutcome {
  if (!res.matched) {
    // 换上新纪元（响应里那个就是主进程**当前**的），并把这个 session 的两份记忆**都删掉**。
    // 删而不是「设成某个数」：我们确实不知道任何正确的值，设一个就会在下一轮
    // `resumePlan` 里伪装成「有一条可用水位线」。
    // 轮次记忆也要删 —— 它的 `startSeq` 正是这次被证伪的那个值。
    const watermarks = { ...cursor.watermarks }
    delete watermarks[sessionId]
    const turns = { ...cursor.turns }
    delete turns[sessionId]
    return { cursor: { epoch: res.epoch, watermarks, turns }, accepted: false }
  }

  const last = maxFrameSeq(res.frames)
  if (last === null) {
    return { cursor: { epoch: res.epoch, watermarks: cursor.watermarks, turns: cursor.turns }, accepted: true }
  }
  return {
    cursor: {
      epoch: res.epoch,
      watermarks: { ...cursor.watermarks, [sessionId]: Math.max(last, cursor.watermarks[sessionId] ?? 0) },
      turns: cursor.turns
    },
    accepted: true
  }
}
