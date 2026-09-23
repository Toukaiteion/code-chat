import { useEffect, useState } from 'react'
import { useStore } from '../../store'

/**
 * 推理面板（只读的展示件）。**§4.7 规则 4 的右半边。**
 *
 * `open` 由外面给，因为它有两个来源：实时的缓冲（`thinkingOpen`）与历史的固定收起
 * （`history.ts` 那条有损之处）。组件本身不该知道消息是从哪儿来的。
 *
 * ★ 推理内容**只存在于 `message_event` 表**，上下文装配从不读它（§4.2 的**结构性排除**，
 *   不是靠过滤条件排除的）。所以这里渲染出来的东西永远不可能被送回模型 ——
 *   这不是一条需要在这里把关的规矩，它在上游就是不可能的。
 */
export function ThinkingPanel({
  text,
  open,
  onToggle
}: {
  text: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  if (text === '') return null

  return (
    <div className="border-edge/60 mb-3 border-l-2 pl-3">
      <button
        onClick={onToggle}
        className="text-ink-faint hover:text-ink-dim flex items-center gap-1.5 font-mono text-[11px] transition-colors"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        思考
      </button>
      {open && (
        <p className="text-ink-dim mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap italic">
          {text}
        </p>
      )}
    </div>
  )
}

/**
 * 在途轮次的推理面板 —— 自己订阅、自己管展开态。
 *
 * ## 两个订阅，各自原子
 *
 * `thinking` 与 `thinkingOpen` **分开订阅**：合上之后继续到达的思考 delta
 * 不该让这个组件重渲染一次（它此刻只显示一个「思考」两个字）。
 * 合成一个选择器返回对象的话，两件事就被绑在同一个引用上了。
 *
 * ## 用户的展开/收起要**优先**，但新的一段思考会把它作废
 *
 * `thinking_end` 到达后自动收起（`frame-buffer` 里做的），用户也可以手动点开看。
 * 麻烦的是这两者会打架：手动点开一段旧的思考后，模型开始了**第二段**思考
 * （工具调用之间很常见），此时 `thinkingOpen` 变回 `true` —— 而如果用户的
 * 「收起」还压在上面，第二段内容就会在一个合着的面板里**无声地流过去**。
 *
 * 所以用户的手势存成 `override`，并且**在 `thinkingOpen` 变回 `true` 时清掉**。
 * 面板的所有者始终是模型的状态，用户只是在两次到达之间借它一下。
 */
export function LiveThinking({ turnId }: { turnId: string }): React.JSX.Element | null {
  const thinking = useStore((s) => s.buffers[turnId]?.thinking ?? '')
  const thinkingOpen = useStore((s) => s.buffers[turnId]?.thinkingOpen ?? false)

  // `null` = 没有用户手势，听模型的。
  const [override, setOverride] = useState<boolean | null>(null)

  useEffect(() => {
    if (thinkingOpen) setOverride(null)
  }, [thinkingOpen])

  return (
    <ThinkingPanel
      text={thinking}
      open={override ?? thinkingOpen}
      onToggle={() => setOverride(!(override ?? thinkingOpen))}
    />
  )
}
