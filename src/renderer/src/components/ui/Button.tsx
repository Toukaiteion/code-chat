import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-neon-cyan text-void font-semibold hover:opacity-85',
  outline: 'border border-edge text-ink-dim hover:border-edge-bright hover:text-ink',
  ghost: 'text-ink-faint hover:bg-panel-2 hover:text-ink',
  // 删除类动作用它。**只是配色**，真正的护栏在主进程（拒绝删盘根、拒绝碰 local 目录…）。
  danger: 'border border-neon-pink/40 text-neon-pink hover:bg-neon-pink/10'
}

const SIZES: Record<Size, string> = {
  sm: 'px-2 py-1 text-[11px] rounded',
  md: 'px-3 py-1.5 text-xs rounded-md'
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export function Button({
  variant = 'outline',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: Props): React.JSX.Element {
  return (
    <button
      // 默认 `type="button"`：这些按钮大多在表单里，而 `type` 缺省是 `submit`，
      // 忘记写就会在回车时把整个对话框提交掉 —— 这个坑不值得每次都踩一遍。
      type={type}
      className={`inline-flex shrink-0 items-center gap-1.5 transition-colors disabled:pointer-events-none disabled:opacity-40 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    />
  )
}
