import { useState } from 'react'
import type { TimelineItem } from '@shared/live/frame-buffer'
import { useStore } from '../../store'
import { DiffBlock } from './DiffBlock'

/** 模块级空数组：选择器绝不能在每次调用时新建一个数组（zustand v5 会判定「变了」）。 */
const EMPTY_ITEMS: readonly TimelineItem[] = []

/** 输入摘要。工具入参是任意 JSON，这里只取一个最能说明「它动了什么」的短串。 */
function describeInput(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const o = input as Record<string, unknown>
  // 路径类参数优先 —— 绝大多数工具调用里，用户想知道的就是「它碰了哪个文件」。
  for (const key of ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url']) {
    const v = o[key]
    if (typeof v === 'string') return v
  }
  try {
    const s = JSON.stringify(input)
    return s.length > 120 ? `${s.slice(0, 120)}…` : s
  } catch {
    return ''
  }
}

/** 一条工具调用（含它的结果）。可展开看输出。 */
function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const r = item.result
  const pending = r === null

  /**
   * ★ 没见过 `tool_start` 时 `name` 是 `null`，这时**如实说「未见到这次调用」**，
   * 不许拿工具 id 去猜一个名字。猜出来的名字会被当成事实读 ——
   * 界面会说「它调用了 X」，而我们从没见过那次调用。
   */
  const name = item.name ?? '未知调用'

  return (
    <div className="flex flex-col">
      <button
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-panel-2/60 flex items-center gap-2 rounded px-1 py-0.5 text-left font-mono text-[11px] transition-colors"
        title={item.started ? undefined : '只看到了结果，没看到这次工具的调用帧'}
      >
        <span className={pending ? 'text-ink-faint' : r.ok ? 'text-neon-lime' : 'text-neon-pink'}>
          {pending ? '·' : r.ok ? '✓' : '✗'}
        </span>
        <span className={item.name === null ? 'text-ink-faint italic' : 'text-ink-dim w-16 shrink-0'}>
          {name}
        </span>
        <span className="text-ink-faint truncate">{describeInput(item.input)}</span>
        {r?.truncated === true && (
          <span className="text-neon-pink/70 shrink-0 text-[10px]" title="输出超过上限，这里是截断过的">
            已截断
          </span>
        )}
        {!pending && r.output !== '' && (
          <span className="text-ink-faint ml-auto shrink-0">{open ? '▾' : '▸'}</span>
        )}
      </button>

      {open && r !== null && r.output !== '' && (
        <pre className="border-edge bg-void/60 text-ink-dim mt-1 mb-1 max-h-64 overflow-auto rounded border px-2 py-1.5 text-[10.5px] whitespace-pre-wrap">
          {r.output}
        </pre>
      )}
    </div>
  )
}

/**
 * 工具 / 改动 / 报错的**同一条**时间线，按到达序。
 *
 * ★ 三类东西共用一个数组（`TimelineItem`），不是为了少写一个循环：
 * 「先改文件再报错」与「先报错再改文件」在界面上必须能区分，而分成三个数组
 * 再拼起来的话，那个顺序就丢了 —— 而它正是排查一轮跑歪了的时候最要紧的信息。
 */
export function ToolTimeline({ items }: { items: readonly TimelineItem[] }): React.JSX.Element | null {
  if (items.length === 0) return null

  return (
    <div className="mb-2 flex flex-col gap-0.5">
      {items.map((item, i) => {
        if (item.kind === 'tool') return <ToolRow key={`${item.id}-${i}`} item={item} />
        if (item.kind === 'diff') return <DiffBlock key={i} path={item.path} patch={item.patch} />
        return (
          <div key={i} className="flex items-start gap-2 px-1 font-mono text-[11px]">
            <span className="text-neon-pink shrink-0">!</span>
            <span className="text-ink-dim">{item.message}</span>
            <span className="text-ink-faint shrink-0 text-[10px]">{item.code}</span>
            {item.fatal && (
              <span className="text-neon-pink/70 shrink-0 text-[10px]">本轮已终止</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 在途轮次的时间线 —— 自己订阅。
 *
 * 订阅的是 `items` 那个**数组**（而不是整个缓冲）：它在帧归约里只在真的增删条目时
 * 才换引用（见 `frame-buffer.ts` 里 `TurnBuffer` 上那段说明），所以
 * 正文 delta 到达时这里**一次都不重渲染**。工具时间线是低频的，
 * 而它里面可能嵌着一块几百行的 diff —— 每 33ms 重建一次的代价会非常明显。
 */
export function LiveToolTimeline({ turnId }: { turnId: string }): React.JSX.Element | null {
  const items = useStore((s) => s.buffers[turnId]?.items ?? EMPTY_ITEMS)
  return <ToolTimeline items={items} />
}
