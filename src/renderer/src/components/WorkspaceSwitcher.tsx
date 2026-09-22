import { useStore } from '../store'

/**
 * 工作空间切换器。真实数据来自 `workspace:list`（经 store），
 * 未读点是 `workspace:unread` 推来的 —— M4 里它必然是 0，
 * 因为没有任何东西会产生未读（对话在 M6）。**但通路是真的**：
 * 一旦 M6 开始推，这里不需要改一行。
 */
export function WorkspaceSwitcher({
  onCreate,
  onManage
}: {
  onCreate: () => void
  onManage: (id: string) => void
}): React.JSX.Element {
  const order = useStore((s) => s.workspaceOrder)
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const unread = useStore((s) => s.unread)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)

  return (
    <div className="border-edge border-b px-3 py-3">
      <p className="text-ink-faint mb-2 px-1 font-mono text-[10px] tracking-widest uppercase">
        工作空间
      </p>

      <div className="flex flex-col gap-1">
        {order.map((id) => {
          const ws = workspaces[id]
          if (!ws) return null
          const on = id === activeId
          const count = unread[id] ?? 0
          return (
            <div key={id} className="group relative flex items-center">
              <button
                onClick={() => setActiveWorkspace(id)}
                className={`flex flex-1 items-center justify-between rounded-md py-2 pr-7 pl-3 text-left text-sm transition-colors ${
                  on ? 'bg-panel-2 text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink'
                }`}
              >
                {on && (
                  <span className="bg-neon-cyan absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-r" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{ws.name}</span>
                {count > 0 && (
                  <span className="bg-neon-violet text-void rounded-full px-1.5 py-px font-mono text-[10px] font-bold">
                    {count}
                  </span>
                )}
              </button>
              <button
                onClick={() => onManage(id)}
                title="重命名 / 删除 / 看空间目录"
                aria-label="工作空间设置"
                className="text-ink-faint hover:text-ink pointer-events-none absolute right-1.5 rounded px-1.5 py-1 text-[11px] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-panel-2 focus-visible:pointer-events-auto focus-visible:opacity-100"
              >
                ⚙
              </button>
            </div>
          )
        })}
      </div>

      <button
        onClick={onCreate}
        className="border-edge text-ink-faint hover:border-edge-bright hover:text-ink-dim mt-2 w-full rounded-md border border-dashed px-3 py-2 text-xs transition-colors"
      >
        + 新建工作空间
      </button>
    </div>
  )
}
