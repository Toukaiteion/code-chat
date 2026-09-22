import type { ReactNode } from 'react'

/**
 * 空态。**必须带上「下一步能做什么」** —— 一句「暂无数据」等于把用户扔在原地。
 * 所以 `hint` 不是可选的装饰，它就是这个组件存在的一半理由。
 */
export function Empty({
  title,
  hint,
  action
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="border-edge/70 text-ink-faint flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center">
      <p className="text-ink-dim text-[12.5px]">{title}</p>
      {hint && <div className="max-w-md text-[11px] leading-relaxed">{hint}</div>}
      {action}
    </div>
  )
}
