import { useEffect } from 'react'
import { useStore } from '../store'
import { Button } from './ui/Button'
import { Em, PathText } from './ui/Text'

/**
 * 没选中任何成员/项目时的主区：这个空间**在磁盘上长什么样**，以及怎么进对话。
 *
 * ★ 为什么空间目录必须显示在这里：工作空间根目录被决定放在 `app.getPath('userData')`
 *   下面 —— 那是资源管理器里**看不见**的位置。用户的所有「东西到底在哪」的直觉
 *   在这里都不成立，所以「它在哪 + 一键打开」是欠他的交代，不是可选装饰。
 *
 * ★ M0 那份**假对话视觉稿**（`components/mock/ConversationMock.tsx`，194 行硬编码数据）
 *   在 M6b 删掉了 —— 真对话看得见了，它的视觉语汇由 `components/conversation/` 继承。
 *   留着会是最糟的那种东西：一份**看起来像真的**假数据，摆在一个真的旁边。
 */
export function WorkspaceOverview({
  workspaceId,
  onAddProject,
  onOpenConversation
}: {
  workspaceId: string
  onAddProject: () => void
  onOpenConversation: () => void
}): React.JSX.Element {
  const paths = useStore((s) => s.pathsByWorkspace[workspaceId] ?? null)
  const loadWorkspacePaths = useStore((s) => s.loadWorkspacePaths)
  const revealPath = useStore((s) => s.revealPath)
  const projects = useStore((s) => s.projectsByWorkspace[workspaceId])
  const members = useStore((s) => s.membersByWorkspace[workspaceId])

  // 只读、幂等（**不传 `ensure`** → 不会在磁盘上建任何东西）。StrictMode 跑两遍无害。
  useEffect(() => {
    void loadWorkspacePaths(workspaceId)
  }, [workspaceId, loadWorkspacePaths])

  return (
    <div className="flex flex-col gap-4">
      <section className="border-edge bg-panel/40 flex flex-col gap-3 rounded-xl border p-5">
        <h2 className="text-ink text-sm font-semibold">空间目录</h2>

        {paths ? (
          <>
            <div className="flex flex-col gap-1.5 font-mono text-[11px]">
              <PathText>{paths.rootPath}</PathText>
              <span className="text-ink-faint break-all">项目落点 {paths.projectsPath}</span>
              <span className="text-ink-faint break-all">临时目录 {paths.scratchPath}</span>
            </div>
            <p className="text-ink-faint text-[11px] leading-relaxed">
              这棵目录建在应用数据目录下（<Em tone="dim">不是</Em>文档目录）——
              资源管理器里默认看不到它，所以这里给了「打开目录」。
              {paths.exists ? '' : '（它当前不在磁盘上，多半是这个空间建得比 M4 还早。）'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void revealPath(paths.rootPath)}>在资源管理器中打开</Button>
              {!paths.exists && (
                <Button onClick={() => void loadWorkspacePaths(workspaceId, true)}>建出这棵目录</Button>
              )}
            </div>
          </>
        ) : (
          <p className="text-ink-faint text-[11px]">读取中…</p>
        )}

        <hr className="border-edge" />

        <div className="flex flex-wrap items-center gap-4 text-[11px]">
          <span className="text-ink-faint">
            项目 <span className="text-ink-dim font-mono">{projects?.length ?? 0}</span>
          </span>
          <span className="text-ink-faint">
            成员 <span className="text-ink-dim font-mono">{members?.length ?? 0}</span>
          </span>
          <Button size="sm" onClick={onAddProject}>
            + 添加项目
          </Button>
        </div>
      </section>

      <section className="border-edge bg-panel/40 flex flex-col gap-3 rounded-xl border p-5">
        <h2 className="text-ink text-sm font-semibold">对话</h2>
        <p className="text-[12px] leading-relaxed">
          <Em>这个空间里所有成员的对话在同一条时间线上</Em> —— 你以某个成员的身份说话，
          回答按发生顺序插进同一条流，跨成员、跨项目。
        </p>
        <p className="text-ink-faint text-[11px] leading-relaxed">
          运行中的那一轮会<Em tone="dim">逐字流式显示</Em>：思考面板、工具调用、
          文件改动，都按它们真实发生的顺序排。累计成本在顶栏，标注「估算」。
        </p>
        {/* M0 那份假对话视觉稿（`components/mock/`）到 M6b 退休了 —— 它的视觉语汇
            由 `components/conversation/` 继承，这里换成通往真对话的入口。 */}
        <div>
          <Button size="sm" onClick={onOpenConversation}>
            去对话 →
          </Button>
        </div>
      </section>
    </div>
  )
}
