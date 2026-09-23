import { useEffect, useRef } from 'react'
import { useStore } from '../../store'
import { MessageList } from './MessageList'
import { Composer } from './Composer'

const EMPTY_ORDER: string[] = []

/**
 * 空间级对话视图：消息区占满高度，输入区钉在底部。
 *
 * ## 它为什么是全高的一屏，而不是概览页里的一块
 *
 * 聊天流是**空间级单一时间线**（`UNIQUE (workspace_id, seq)` 就是为它建的，§4.2）。
 * 它会长到几百条 —— 嵌在一个还带着项目列表、成员卡片的页面里，那个滚动条
 * 一会儿属于对话、一会儿属于页面，用户永远搞不清自己在滚哪儿。
 *
 * ## 两个 effect，都是**只读**的
 *
 * 1. `openConversation`：历史 + 用量 + 运行概要，然后把在途的尾巴接上；
 * 2. `loadEvents`：给每条可见消息折它的完整过程（思考 / 工具 / diff）。
 *
 * 第二个 effect 的依赖是 `[order, runtime]`，看起来有点怪，理由是：
 * **「这一轮的轮次行落定了没有」这个问题的答案在 `runtime` 里**，而轮次一进终态
 * `runtime` 就会跟着 `stream:status` 刷新。所以这两个依赖合起来恰好覆盖
 * 「有新消息了」与「某一轮结束了」这两个时机 —— 而它们正是该去折历史的时刻。
 *
 * `loadEvents` 自己记着「试过没有」（`eventsAttempted`），所以这个循环
 * 重复跑是**免费**的：绝大部分迭代就是一次 map 查找。
 */
export function ConversationPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const openConversation = useStore((s) => s.openConversation)
  const loadEvents = useStore((s) => s.loadEvents)
  const order = useStore((s) => s.order[workspaceId] ?? EMPTY_ORDER)
  const runtime = useStore((s) => s.runtime)
  const streamingTurnIds = useStore((s) => s.streamingTurnIds)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void openConversation(workspaceId)
  }, [workspaceId, openConversation])

  useEffect(() => {
    for (const id of order) void loadEvents(id)
  }, [order, runtime, loadEvents])

  /**
   * 新内容到了就贴到底部。
   *
   * ⚠️ **这是一个已知的粗略**：它只在轮次开始/结束、以及历史重载时贴一次，
   * 流式过程中**不跟着走**。真的 30Hz 跟随需要这个容器订阅到缓冲上，
   * 而那正是 §4.7 规则 1 要挡住的那件事（整棵树跟着 30Hz 重渲染）。
   * 想同时要「跟随」和「不订阅」，需要把滚动容器做成一个独立订阅缓冲的叶子 ——
   * 那是下一个里程碑的事，记在 `docs/design.md` §4.7 的已知边界里。
   *
   * 不无脑贴底：用户往上翻看历史时，新消息**不该**把他拽回底部。
   * 判据是「现在离底部够近」，而不是「是不是他自己滚的」—— 后者要跟踪一整套
   * 手势状态，而它换来的差别只在「刚好离底部 40px」这种情形上。
   */
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [order, streamingTurnIds])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl">
          <MessageList workspaceId={workspaceId} />
        </div>
      </div>
      <Composer workspaceId={workspaceId} />
    </div>
  )
}
