/**
 * 应用外壳 —— **只做组合与布局**，不含业务逻辑。
 *
 * M0 那个 287 行的假壳（硬编码 nova/orion、编出来的 token 数与金额）已经拆干净：
 * 数据全部来自 store（store 再调 IPC），视觉骨架与配色沿用 M0 定下的方向。
 *
 * 这里的三个 effect 全部**只读、幂等**：拉列表、拉运行时概要。StrictMode 会把它们
 * 各跑两遍，重复读一次没有副作用 —— 而「写入」一次都不许出现在 effect 里
 * （M3 被自动建空间的写操作咬过一次）。
 */
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { usePushNotices } from './hooks/usePushNotices'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { NoticeBar } from './components/NoticeBar'
import { FirstRun } from './components/FirstRun'
import { WorkspaceOverview } from './components/WorkspaceOverview'
import { WorkspaceDialog } from './components/WorkspaceDialog'
import { AddProjectDialog } from './components/AddProjectDialog'
import { ActorManagerDialog } from './components/ActorManager'
import { MemberDetail } from './components/MemberDetail'
import { ProjectDetail } from './components/ProjectList'
import { Empty } from './components/ui/Empty'

/** 哪个对话框开着。一次只可能开一个，所以用一个字段而不是三个布尔。 */
type Dialog =
  | { kind: 'workspace'; mode: 'create' | 'manage'; workspaceId: string | null }
  | { kind: 'project' }
  | { kind: 'actors' }
  | null

export default function App(): React.JSX.Element {
  usePushNotices()

  const order = useStore((s) => s.workspaceOrder)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const selection = useStore((s) => s.selection)
  const loadWorkspaces = useStore((s) => s.loadWorkspaces)
  const loadActors = useStore((s) => s.loadActors)
  const loadProjects = useStore((s) => s.loadProjects)
  const loadMembers = useStore((s) => s.loadMembers)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)

  const [dialog, setDialog] = useState<Dialog>(null)

  // 启动时把全局数据读一遍。**只读、幂等**，StrictMode 跑两遍无害。
  useEffect(() => {
    void loadWorkspaces()
    void loadActors()
  }, [loadWorkspaces, loadActors])

  /**
   * 选一个空间来看。
   *
   * 这只改**纯 UI 状态**（在看哪个空间），不写库、不碰磁盘，所以放在 effect 里是安全的。
   * 它同时兜住两种情况：刚启动还没选，以及——**当前空间刚被删掉**。
   * 后者很重要：删完之后 `activeWorkspaceId` 变成 `null`，如果这里不接一手，
   * 界面会停在一个空壳上，用户得自己再点一次。
   */
  useEffect(() => {
    if (activeWorkspaceId === null && order.length > 0) setActiveWorkspace(order[0])
  }, [activeWorkspaceId, order, setActiveWorkspace])

  // 切空间就把这个空间的两份列表拉齐（成员、项目）。同样**只读、幂等**。
  useEffect(() => {
    if (activeWorkspaceId === null) return
    void loadProjects(activeWorkspaceId)
    void loadMembers(activeWorkspaceId)
  }, [activeWorkspaceId, loadProjects, loadMembers])

  // 一个空间都没有 —— 首启空态占满整屏，侧边栏里本来也没东西可摆。
  //
  // ★ 这一屏**也必须**把 NoticeBar 渲染出来。删掉最后一个空间时，界面会立刻落到这一屏，
  //   而「副本删了几个、哪些没删掉、空间目录还留在哪」那条报告正是这一刻推出来的 ——
  //   少渲染它，就等于把整个里程碑最要紧的那句交代吞掉。
  //   （这是实机走查发现的：空间删掉了、页面回到了空态，而删除报告一个字都没露过面。）
  //   浮在右上角是因为这一屏没有可容纳提示条的布局，而它下面那张卡片是居中的。
  if (order.length === 0) {
    return (
      <>
        <FirstRun onCreate={() => setDialog({ kind: 'workspace', mode: 'create', workspaceId: null })} />
        <div className="fixed top-0 right-0 z-40 w-[min(560px,calc(100vw-2rem))]">
          <NoticeBar />
        </div>
        <WorkspaceDialog
          open={dialog?.kind === 'workspace' && dialog.mode === 'create'}
          mode="create"
          workspaceId={null}
          onClose={() => setDialog(null)}
        />
      </>
    )
  }

  return (
    <div className="bg-void text-ink flex h-screen">
      <Sidebar
        workspaceId={activeWorkspaceId}
        onCreateWorkspace={() => setDialog({ kind: 'workspace', mode: 'create', workspaceId: null })}
        onManageWorkspace={(id) => setDialog({ kind: 'workspace', mode: 'manage', workspaceId: id })}
        onAddProject={() => setDialog({ kind: 'project' })}
        onOpenActors={() => setDialog({ kind: 'actors' })}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {activeWorkspaceId !== null && (
          <TopBar
            workspaceId={activeWorkspaceId}
            onManage={() =>
              setDialog({ kind: 'workspace', mode: 'manage', workspaceId: activeWorkspaceId })
            }
          />
        )}

        {/* 提示条放在滚动区**外面**：里面装的是「有副本没删掉」这类要照做的信息，
            滚上去就看不见了。 */}
        <NoticeBar />

        <div className="grid-bg flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            {activeWorkspaceId === null ? (
              // 只在「有空间但一个都没选中」的这一帧出现 —— 上一段的 effect 会立刻补上。
              // 不写「加载中」：那不是正在发生的事，实话是「还没选」。
              <Empty title="还没有选中工作空间" hint="在左边点一个。" />
            ) : selection === null ? (
              <WorkspaceOverview
                workspaceId={activeWorkspaceId}
                onAddProject={() => setDialog({ kind: 'project' })}
              />
            ) : selection.kind === 'member' ? (
              // `key` 是必须的：不换 key 的话，从一个成员切到另一个时
              // 内部的 `useState`（职责文件草稿、二次确认）会留在原地，
              // 「确认移除」的勾会跟着跑到下一个人身上。
              <MemberDetail
                key={selection.id}
                workspaceId={activeWorkspaceId}
                memberId={selection.id}
              />
            ) : (
              <ProjectDetail
                key={selection.id}
                workspaceId={activeWorkspaceId}
                projectId={selection.id}
              />
            )}
          </div>
        </div>
      </main>

      <WorkspaceDialog
        open={dialog?.kind === 'workspace'}
        mode={dialog?.kind === 'workspace' ? dialog.mode : 'create'}
        workspaceId={dialog?.kind === 'workspace' ? dialog.workspaceId : null}
        onClose={() => setDialog(null)}
      />
      {activeWorkspaceId !== null && (
        <AddProjectDialog
          open={dialog?.kind === 'project'}
          workspaceId={activeWorkspaceId}
          onClose={() => setDialog(null)}
        />
      )}
      <ActorManagerDialog open={dialog?.kind === 'actors'} onClose={() => setDialog(null)} />
    </div>
  )
}
