import { buildTimeline } from '@shared/live/timeline'
import { useStore } from '../../store'
import { FailedTurnRow, MessageRow } from './MessageRow'
import { StreamingRow } from './StreamingRow'

const EMPTY_ORDER: string[] = []
const EMPTY_STREAMING: string[] = []

/**
 * 空间时间线。**§4.7 规则 1：只订阅 `order[workspaceId]`。**
 *
 * ## 它订阅的四样，没有一样是按帧变的
 *
 * | 订阅 | 变化时机 |
 * |---|---|
 * | `order[workspaceId]` | 只在 `message:list` 回来时换引用 |
 * | `messages` | 同上（**帧不写这里** —— 帧只写 `buffers`） |
 * | `streamingTurnIds` | 只在轮次**开始/结束**时换引用（见 `live.ts` 那个字段） |
 * | `failuresByTrigger` | 同上 |
 *
 * ★ 这就是「整张列表不随 30Hz 重渲染」的全部机制：**它一次都没订阅到 `buffers` 上**。
 *   如果这里改成订阅 `buffers`（哪怕只是为了数一下有几条在跑），每个 delta
 *   都会把整张列表重建一遍 —— 而界面对得看不出来，只是越跑越卡。
 *
 * ## 三种格子的排法、以及「有缓冲才抑制历史行」那条不变式
 *
 * 全部在 `@shared/live/timeline.ts` 里，那里有完整的论证。搬出去的理由和
 * `frame-buffer.ts` 一样：**那是判断，不是渲染** —— 留在组件里就只能靠
 * 「点开应用看一眼」来验证，而它错起来是**静默**的（正文出现两遍）。
 */
export function MessageList({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const order = useStore((s) => s.order[workspaceId] ?? EMPTY_ORDER)
  const messages = useStore((s) => s.messages)
  const streamingTurnIds = useStore((s) => s.streamingTurnIds ?? EMPTY_STREAMING)
  const failures = useStore((s) => s.failuresByTrigger)

  const entries = buildTimeline({ order, messages, streamingTurnIds, failuresByTrigger: failures })

  if (entries.length === 0) {
    return (
      <div className="text-ink-faint px-4 py-8 text-center text-[13px]">
        这个空间还没有对话。在下面选一个成员，说点什么。
      </div>
    )
  }

  return (
    <div className="grid-bg flex flex-col gap-4 px-4 py-4">
      {entries.map((e) => {
        if (e.kind === 'message') return <MessageRow key={e.id} id={e.id} />
        if (e.kind === 'failed') {
          return <FailedTurnRow key={`failed-${e.triggerMessageId}`} triggerMessageId={e.triggerMessageId} />
        }
        return <StreamingRow key={e.turnId} turnId={e.turnId} />
      })}
    </div>
  )
}
