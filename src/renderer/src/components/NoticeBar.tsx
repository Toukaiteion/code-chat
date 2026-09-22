import { useStore } from '../store'
import type { Notice } from '../store'

const TONES: Record<Notice['level'], { frame: string; mark: string; text: string }> = {
  error: { frame: 'border-neon-pink/40 bg-neon-pink/8', mark: '✕', text: 'text-neon-pink' },
  warning: { frame: 'border-amber-400/40 bg-amber-400/8', mark: '!', text: 'text-amber-300' },
  info: { frame: 'border-edge bg-panel/70', mark: '·', text: 'text-ink-faint' }
}

function clock(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

/**
 * 全应用**唯一**的错误出口（`toNotice`）在界面上的落点。
 *
 * 形态是刻意的：
 * - **不自动消失**。里面装的是「空间已删除，但有一个副本没删掉：<路径>」这类
 *   用户必须看到、可能要照着去处理的信息；一条 5 秒后自己跑掉的提示等于没说。
 * - `detail` 用 `whitespace-pre-line` 渲染 —— 主进程给的是多行文本，
 *   压成一行会让路径和原因糊在一起。
 */
export function NoticeBar(): React.JSX.Element | null {
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotice)

  if (notices.length === 0) return null

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-5 pt-3">
      {notices.map((n) => {
        const tone = TONES[n.level]
        return (
          <div
            key={n.id}
            className={`flex items-start gap-2.5 rounded-md border px-3 py-2 ${tone.frame}`}
          >
            <span className={`mt-px font-mono text-[11px] ${tone.text}`}>{tone.mark}</span>
            <div className="min-w-0 flex-1">
              <p className="text-ink text-[12px] leading-relaxed">{n.message}</p>
              {n.detail && (
                <p className="text-ink-faint mt-0.5 font-mono text-[10.5px] leading-relaxed break-all whitespace-pre-line">
                  {n.detail}
                </p>
              )}
            </div>
            <span className="text-ink-faint shrink-0 font-mono text-[10px]">{clock(n.at)}</span>
            <button
              onClick={() => dismiss(n.id)}
              aria-label="关闭这条提示"
              className="text-ink-faint hover:text-ink shrink-0 px-1 text-xs transition-colors"
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
