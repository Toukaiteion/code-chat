import { useState } from 'react'
import { useStore } from '../../store'
import { ActorChip } from './ActorChip'
import { ThinkingPanel } from './ThinkingPanel'
import { ToolTimeline } from './ToolTimeline'

/**
 * 一条**已落定**的消息。§4.7 规则 2：这个组件**只订阅自己那一条**。
 *
 * 订阅两个键，都是按自己的 id 取的**引用稳定的值**：
 * - `messages[id]` —— 消息本体（对象引用，只在真正重载那一条时变）；
 * - `historyBuffers[id]` —— 它折好的完整过程（`undefined` → 还没读回来）。
 *
 * 第二个订阅不违背规则 2 的用意：判据是「别的行变化时这一行不许重渲染」，
 * 而这两个键都带着自己的 id。整张列表以 30Hz 重渲染的那条路依然是关闭的
 * （`MessageList` 不去订阅缓冲，见那个文件）。
 *
 * ## 两种渲染形态
 *
 * - **有 `historyBuffers[id]`**（事件行已经折好）：思考面板 + 工具时间线 + 正文，
 *   与在途那条 `<StreamingRow>` 长得**一模一样** —— 因为折出来的就是同一个类型
 *   （`history.ts` 存在的全部理由）。
 * - **没有**：只渲染 `contentText`。这不是降级到「少了点东西」，
 *   `content_text` 与帧是**同一个字节的两个去向**（§2.3），正文一个字都不缺，
 *   少的只是思考、工具调用与 diff 那些**过程**。用户自己发的消息永远走这一支
 *   （它们没有事件行），所以这条路径是常用的，不是异常路径。
 */
export function MessageRow({ id }: { id: string }): React.JSX.Element | null {
  const msg = useStore((s) => s.messages[id] ?? null)
  const buf = useStore((s) => s.historyBuffers[id] ?? null)
  /** 历史行的思考面板展开态。历史里没有 `thinking_end` 这个事实，所以初值是收起。 */
  const [thinkingOpen, setThinkingOpen] = useState(false)

  if (msg === null) return null

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="border-neon-cyan/30 bg-neon-cyan/8 text-ink max-w-[70%] rounded-xl rounded-br-sm border px-4 py-2.5 text-[13.5px] whitespace-pre-wrap">
          {msg.contentText ?? ''}
        </div>
      </div>
    )
  }

  const text = buf !== null && buf.text !== '' ? buf.text : (msg.contentText ?? '')
  const memberId = msg.authorMemberId ?? ''

  return (
    <article className="neon-frame bg-panel/70 rounded-xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <ActorChip workspaceId={msg.workspaceId} memberId={memberId} />
      </div>

      {buf !== null && (
        <>
          <ThinkingPanel
            text={buf.thinking}
            open={thinkingOpen}
            onToggle={() => setThinkingOpen((v) => !v)}
          />
          <ToolTimeline items={buf.items} />
        </>
      )}

      {text !== '' && (
        <p className="text-ink text-[13.5px] leading-relaxed whitespace-pre-wrap">{text}</p>
      )}
    </article>
  )
}

/**
 * 一条**没有任何正文**的轮次 —— 它在产出第一个字之前就失败了。
 *
 * ★ 这个组件存在的理由很具体：`event-batcher` 只在**有事件行**时才惰性建那条
 * assistant 消息，于是一轮在产出任何东西之前就失败（撞预算闸、适配器报错、
 * 执行器崩溃）时，`message:list` 里**根本没有行** —— 界面上它完全不存在，
 * 用户只看到自己那条消息石沉大海。`live.ts` 的 `failuresByTrigger` 就是为它建的。
 *
 * 措辞上**不猜原因**：`terminalReason` 是库里记下的原话，照抄；`errorText` 有就带上。
 * 编一句「模型拒绝了」之类的解释会让用户按错误的假设去排查。
 */
export function FailedTurnRow({
  triggerMessageId
}: {
  triggerMessageId: string
}): React.JSX.Element | null {
  // ⚠️ 取的是**触发消息的 id**，不是轮次 id —— `failuresByTrigger` 就是按前者索引的
  //    （理由见 `live.ts` 那个字段：时间线上的位置是「回答该出现的地方」）。
  const turn = useStore((s) => s.failuresByTrigger[triggerMessageId] ?? null)
  if (turn === null) return null

  const label =
    turn.status === 'failed'
      ? '这一轮失败了'
      : turn.status === 'interrupted'
        ? '这一轮被中断了'
        : '这一轮被取消了'

  return (
    <div className="border-neon-pink/30 bg-neon-pink/5 rounded-lg border border-dashed px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-neon-pink text-[12px] font-semibold">{label}</span>
        {turn.terminalReason !== null && (
          <span className="text-ink-faint font-mono text-[10px]">{turn.terminalReason}</span>
        )}
      </div>
      {/* 一个字都没有产出 —— 明说，否则用户会以为内容还在下面没加载出来。 */}
      <p className="text-ink-faint mt-1 text-[11.5px]">
        它没有产出任何内容，所以消息列表里没有它这一条。
      </p>
      {turn.errorText !== null && (
        <pre className="text-ink-dim mt-2 max-h-40 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap">
          {turn.errorText}
        </pre>
      )}
    </div>
  )
}
