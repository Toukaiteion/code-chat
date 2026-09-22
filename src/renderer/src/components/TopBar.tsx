import { useEffect } from 'react'
import type { Project } from '@shared/entities'
import { useStore } from '../store'
import { Button } from './ui/Button'

const EMPTY_PROJECTS: Project[] = []

/**
 * 顶栏。
 *
 * ★ 「当前项目」这个切换器接的是 **`workspace:setActive`**，不是 `project:setActive`
 *   —— 通道清单里**没有**后者（§4.3）。因为「当前项目」不是项目自己的属性，
 *   而是**空间**的属性（`workspace.active_project_id`），它是 cwd 的二级兜底（§8.5b）。
 *   这个区别在界面上体现为：切换它是在改这个空间的状态，不是在改项目。
 *
 * ★ 右上角那三个数字是**真的**：来自 `runtime:getState`。M0 那版摆的是编出来的
 *   累计 token / 估算金额 / 缓存命中率 —— 它们看起来最像「产品」，也最容易让人
 *   以为系统已经在跑。现在没有调度器，数字就诚实地是 0。
 */
export function TopBar({
  workspaceId,
  onManage
}: {
  workspaceId: string
  onManage: () => void
}): React.JSX.Element {
  const ws = useStore((s) => s.workspaces[workspaceId] ?? null)
  const projects = useStore((s) => s.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS)
  const setActiveProject = useStore((s) => s.setActiveProject)
  const runtime = useStore((s) => s.runtime)
  const loadRuntime = useStore((s) => s.loadRuntime)

  // 只读、幂等 —— StrictMode 跑两遍无害。
  useEffect(() => {
    void loadRuntime()
  }, [loadRuntime])

  const activeId = ws?.activeProjectId ?? null

  return (
    <header className="border-edge bg-abyss/80 flex h-14 shrink-0 items-center gap-4 border-b px-5 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-ink text-sm font-semibold">{ws?.name ?? '—'}</span>
        <span className="bg-edge h-4 w-px" />
        <span className="text-ink-faint shrink-0 text-xs">当前项目</span>
        <div className="border-edge bg-panel flex min-w-0 items-center gap-1 overflow-x-auto rounded-md border p-0.5">
          <button
            onClick={() => void setActiveProject(workspaceId, null)}
            className={`shrink-0 rounded px-2.5 py-1 font-mono text-xs transition-colors ${
              activeId === null ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-ink-faint hover:text-ink-dim'
            }`}
            title="不指定：cwd 会退到空间目录（§8.5b 的二级兜底）"
          >
            未指定
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => void setActiveProject(workspaceId, p.id)}
              className={`shrink-0 rounded px-2.5 py-1 font-mono text-xs transition-colors ${
                p.id === activeId ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-ink-faint hover:text-ink-dim'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-4 font-mono text-[11px]">
        {runtime === null ? (
          <span className="text-ink-faint">运行状态读取中…</span>
        ) : (
          <>
            <span className="text-ink-faint">
              运行中 <span className="text-neon-lime">{runtime.slots.used}</span>
              <span className="text-ink-faint">/{runtime.slots.total}</span>
            </span>
            <span className="text-ink-faint">
              队列 <span className="text-neon-lime">{runtime.queueDepth}</span>
            </span>
            <span className="text-ink-faint" title="累计用量与成本要等 M6 的 usage 事件，现在不编数字">
              用量 <span className="text-ink-faint">M6</span>
            </span>
          </>
        )}
        <Button size="sm" onClick={onManage} title="重命名 / 删除 / 看空间目录">
          设置
        </Button>
      </div>
    </header>
  )
}
