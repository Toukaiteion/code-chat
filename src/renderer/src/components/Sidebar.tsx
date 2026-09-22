import { useStore } from '../store'
import { Button } from './ui/Button'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { ProjectList } from './ProjectList'
import { MemberList } from './MemberList'

/**
 * 左栏。它自己**几乎不碰 store** —— 三段内容各自订阅自己需要的东西，
 * 于是成员列表里的一次勾选不会让空间切换器跟着重渲染。
 *
 * ★ 「角色库」的入口挂在这里的**底部**，不是空间里：角色是全局的（§2.4），
 *   放进某个空间的区域里会让人以为换空间它就没了。
 */
export function Sidebar({
  workspaceId,
  onCreateWorkspace,
  onManageWorkspace,
  onAddProject,
  onOpenActors
}: {
  /** 可以是 `null`：有空间但还没选中（首帧、或刚删掉当前空间）。 */
  workspaceId: string | null
  onCreateWorkspace: () => void
  onManageWorkspace: (id: string) => void
  onAddProject: () => void
  onOpenActors: () => void
}): React.JSX.Element {
  const workspacesEmpty = useStore((s) => s.workspaceOrder.length === 0)

  return (
    <aside className="border-edge bg-abyss flex w-60 shrink-0 flex-col border-r">
      <div className="border-edge flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-neon-cyan size-2 rounded-full shadow-[0_0_10px_var(--color-neon-cyan)]" />
        <span className="text-ink text-sm font-semibold tracking-wide">CODE CHAT</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        <WorkspaceSwitcher onCreate={onCreateWorkspace} onManage={onManageWorkspace} />

        {workspaceId !== null && (
          <>
            <hr className="border-edge" />
            <ProjectList workspaceId={workspaceId} onAdd={onAddProject} />
            <hr className="border-edge" />
            <MemberList workspaceId={workspaceId} />
          </>
        )}

        {workspacesEmpty && (
          <p className="text-ink-faint px-1 text-[11px] leading-relaxed">
            还没有工作空间。建一个之后，这里会出现项目列表和成员列表。
          </p>
        )}
      </div>

      <div className="border-edge flex shrink-0 flex-col gap-2 border-t p-3">
        <Button size="sm" onClick={onOpenActors} title="全局角色：跨工作空间复用">
          角色库
        </Button>
        {/* M0 那格写的是「M0 外壳 · 视觉验证」。现在界面是真的了，标记也换成真的。 */}
        <p className="text-ink-faint px-1 font-mono text-[10px]">M4 · 空间与项目</p>
      </div>
    </aside>
  )
}
