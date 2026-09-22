import { useEffect, type ReactNode } from 'react'

/**
 * 模态框。
 *
 * 三条细节都不是装饰：
 * - `Esc` 关闭：误开的唯一体面出口（而且不管焦点在哪都要能用，所以监听在 window 上）。
 * - 点遮罩关闭：用 `onMouseDown` 而不是 `onClick` —— 否则「在框内按下、拖到框外松开」
 *   会被当成点遮罩，正在填的表单就没了。
 * - 内容区自己滚（`max-h`），页面本身不滚：卡片外的布局不该因为一个长表单而跳动。
 */
export function Dialog({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide = false
}: {
  open: boolean
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="bg-void/70 fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={`border-edge bg-abyss neon-frame flex max-h-[82vh] flex-col overflow-hidden rounded-xl border shadow-2xl ${
          wide ? 'w-full max-w-2xl' : 'w-full max-w-lg'
        }`}
      >
        <header className="border-edge flex shrink-0 items-start gap-3 border-b px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-ink text-sm font-semibold">{title}</h2>
            {subtitle && (
              <div className="text-ink-faint mt-1 text-[11px] leading-relaxed">{subtitle}</div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-ink-faint hover:bg-panel-2 hover:text-ink -mt-1 rounded px-1.5 py-0.5 text-sm transition-colors"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="border-edge bg-panel/40 flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
