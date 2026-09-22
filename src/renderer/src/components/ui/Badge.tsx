import type { ReactNode } from 'react'

type Tone = 'cyan' | 'violet' | 'pink' | 'lime' | 'dim'

const TONES: Record<Tone, string> = {
  cyan: 'border-neon-cyan/35 text-neon-cyan bg-neon-cyan/10',
  violet: 'border-neon-violet/35 text-neon-violet bg-neon-violet/10',
  pink: 'border-neon-pink/35 text-neon-pink bg-neon-pink/10',
  lime: 'border-neon-lime/35 text-neon-lime bg-neon-lime/10',
  dim: 'border-edge text-ink-faint bg-panel'
}

/** 小徽标。项目来源、成员角色标记都用它 —— 一处定义，全应用同一种蓝/紫/绿的含义。 */
export function Badge({
  tone = 'dim',
  children,
  title
}: {
  tone?: Tone
  children: ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={`shrink-0 rounded border px-1.5 py-px font-mono text-[10px] leading-4 ${TONES[tone]}`}
    >
      {children}
    </span>
  )
}
