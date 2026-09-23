import { useStore } from '../../store'

/**
 * 流式正文。**§4.7 规则 4 的左半边。**
 *
 * ## 它为什么是一个独立组件，而不是 `StreamingRow` 里的一行 JSX
 *
 * 正文与思考是同一轮里**变化频率最高**的两个字段（合批后仍有 ~30Hz）。
 * 如果把正文写在 `StreamingRow` 里，那么每一个 delta 都会重渲染**整张卡片**：
 * 角色头像、工具时间线、diff 块、用量行 —— 全部跟着重建一遍。
 * 抽出来之后，一次 delta 只重渲染这一个 `<p>`。思考面板同理（见 `ThinkingPanel.tsx`）。
 *
 * ## 订阅的取法
 *
 * `s.buffers[turnId]?.text ?? ''` —— 选择器返回的是**字符串**，不是对象。
 * zustand 用 `Object.is` 比结果，所以思考 delta 到达时（`text` 引用没变）这里
 * **一次都不会重渲染**。这正是「各订阅各的字段」这句话在代码上的样子：
 * 靠的是**选择器返回原子值**，不是靠 `React.memo` 或手写的比较函数。
 *
 * ★ 不要改成 `s.buffers[turnId]` 再在组件里取 `.text`：那样它每一帧都会重渲染
 *   （缓冲对象每个 delta 都是新的），规则 4 当场失效 —— 而且失效得**看不出来**，
 *   界面照样是对的，只是慢。
 */
export function StreamingText({ turnId }: { turnId: string }): React.JSX.Element | null {
  const text = useStore((s) => s.buffers[turnId]?.text ?? '')
  const done = useStore((s) => s.buffers[turnId]?.done ?? null)

  // 一个字都还没有时不渲染空段落 —— 一个空的 `<p>` 也会占掉一行高度，
  // 于是卡片会在第一个 delta 到达的瞬间「跳」一下。
  if (text === '') return null

  return (
    <p className="text-ink text-[13.5px] leading-relaxed whitespace-pre-wrap">
      {text}
      {/* ★ 光标就是「还在流」这件事的表现，所以它挂在 `done` 上而不是挂在「有缓冲」上：
          一轮的正文可能在 `done` 帧到达前很久就已经说完，最后那几个词说完了光标就该停。 */}
      {done === null && <span className="typing-cursor" />}
    </p>
  )
}
