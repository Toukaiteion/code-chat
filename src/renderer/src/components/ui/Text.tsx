import type { ReactNode } from 'react'

type Tone = 'ink' | 'warn' | 'good' | 'dim'

const TONES: Record<Tone, string> = {
  ink: 'text-ink font-semibold',
  warn: 'text-neon-pink font-semibold',
  good: 'text-neon-cyan font-semibold',
  dim: 'text-ink-dim'
}

/**
 * 行内强调。
 *
 * ★ 存在的理由很具体：这些文案里到处都是需要**加粗**的短语
 * （「一个字节都不会动」「改名不会移动目录」），而在 JSX 里写 Markdown 的
 * `**…**` 会**原样渲染成星号**。所以强调必须是个组件，不是几个字符。
 *
 * （这是对计划里那份 `ui/` 基元清单的一点补充，原因如上。）
 */
export function Em({ children, tone = 'ink' }: { children: ReactNode; tone?: Tone }): React.JSX.Element {
  return <span className={TONES[tone]}>{children}</span>
}

/** 等宽 + 可整体选中的路径显示。长 Windows 路径必须能换行，否则会把布局撑破。 */
export function PathText({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="text-ink-dim font-mono text-[11px] break-all select-all">{children}</span>
  )
}
