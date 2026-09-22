import { useState } from 'react'
import type { Project, ProjectOrigin } from '@shared/entities'
import { useStore } from '../store'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Checkbox, TextInput } from './ui/Field'
import { Empty } from './ui/Empty'
import { Em } from './ui/Text'

/**
 * ★ 模块级常量：zustand v5 的选择器如果每次都返回**新建的数组**，
 * 每次渲染都会被判成「变了」，直接无限重渲染。所以空数组必须是同一个引用。
 */
const EMPTY_PROJECTS: Project[] = []

/**
 * 来源徽标。三种来源的含义**必须**在界面上有区别可见 ——
 * 它们决定了「谁拥有这个目录」，也就是删空间时会发生什么（§8.2）。
 */
export function OriginBadge({ origin }: { origin: ProjectOrigin }): React.JSX.Element {
  if (origin === 'local') {
    return (
      <Badge tone="cyan" title="原地引用：这是你自己的目录，我们只登记，不复制也不移动">
        原地引用
      </Badge>
    )
  }
  if (origin === 'copy') {
    return (
      <Badge tone="violet" title="复制：我们复制出来的副本，删空间时可以一并删掉">
        复制
      </Badge>
    )
  }
  return (
    <Badge tone="lime" title="克隆：git clone 出来的副本，删空间时可以一并删掉">
      克隆
    </Badge>
  )
}

/** 侧边栏里的项目列表。点击一行在右侧看详情。 */
export function ProjectList({
  workspaceId,
  onAdd
}: {
  workspaceId: string
  onAdd: () => void
}): React.JSX.Element {
  const projects = useStore((s) => s.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const activeProjectId = useStore((s) => s.workspaces[workspaceId]?.activeProjectId ?? null)

  return (
    <div className="px-3 py-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-ink-faint font-mono text-[10px] tracking-widest uppercase">项目</p>
        <button
          onClick={onAdd}
          className="text-ink-faint hover:text-neon-cyan font-mono text-[10px] transition-colors"
          title="用三种方式之一把项目加进来"
        >
          + 添加
        </button>
      </div>

      {projects.length === 0 ? (
        <p className="text-ink-faint px-1 text-[11px] leading-relaxed">
          还没有项目。三种导入方式：原地引用一个已有目录 / 复制一份 / git clone。
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {projects.map((p) => {
            const on = selection?.kind === 'project' && selection.id === p.id
            return (
              <button
                key={p.id}
                onClick={() => select({ kind: 'project', id: p.id })}
                className={`flex flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors ${
                  on ? 'bg-panel-2 text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink'
                }`}
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium">{p.name}</span>
                  {p.id === activeProjectId && (
                    <Badge tone="cyan" title="当前项目：空间里 cwd 的二级兜底（§8.5b）">
                      当前
                    </Badge>
                  )}
                  <span className="ml-auto">
                    <OriginBadge origin={p.origin} />
                  </span>
                </span>
                <span className="text-ink-faint w-full truncate font-mono text-[10px]" title={p.rootPath}>
                  {p.rootPath}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 右侧的单个项目详情：路径、来源、重命名、移除。 */
export function ProjectDetail({
  workspaceId,
  projectId
}: {
  workspaceId: string
  projectId: string
}): React.JSX.Element {
  const project = useStore(
    (s) => (s.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS).find((p) => p.id === projectId) ?? null
  )
  const activeProjectId = useStore((s) => s.workspaces[workspaceId]?.activeProjectId ?? null)
  const setActiveProject = useStore((s) => s.setActiveProject)
  const renameProject = useStore((s) => s.renameProject)
  const removeProject = useStore((s) => s.removeProject)
  const revealPath = useStore((s) => s.revealPath)
  const select = useStore((s) => s.select)

  const [name, setName] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleteCopy, setDeleteCopy] = useState(false)

  // 选中项消失（被删掉、或切了空间）时不留空壳。
  if (!project) {
    return <Empty title="这个项目已经不在了" hint="它可能刚被移除，或者你换了工作空间。" />
  }

  const editable = project.origin !== 'local'

  return (
    <section className="border-edge bg-panel/40 flex flex-col gap-4 rounded-xl border p-5">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-ink text-sm font-semibold">{project.name}</h2>
          <OriginBadge origin={project.origin} />
          {project.id === activeProjectId && (
            <Badge tone="cyan" title="空间里 cwd 的二级兜底（§8.5b）">
              当前项目
            </Badge>
          )}
        </div>
        <p className="text-ink-faint text-[11px] leading-relaxed">
          {project.origin === 'local' ? (
            <>
              这是一个<Em tone="good">原地引用</Em>：agent 会直接在你的真实目录里读和写。
            </>
          ) : (
            '这是我们创建的副本，删掉它不影响你的原始目录。'
          )}
        </p>
      </header>

      <dl className="flex flex-col gap-2 font-mono text-[11px]">
        <Row label="绝对路径">
          <span className="text-ink-dim break-all select-all">{project.rootPath}</span>
        </Row>
        {project.remoteUrl && (
          <Row label="远端">
            <span className="text-ink-dim break-all select-all">{project.remoteUrl}</span>
          </Row>
        )}
        {project.defaultBranch && (
          <Row label="分支">
            <span className="text-ink-dim">{project.defaultBranch}</span>
          </Row>
        )}
        <Row label="加入时间">
          <span className="text-ink-dim">{new Date(project.createdAt).toLocaleString()}</span>
        </Row>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void revealPath(project.rootPath)}>在资源管理器中打开</Button>
        {project.id === activeProjectId ? (
          <Button onClick={() => void setActiveProject(workspaceId, null)}>取消「当前项目」</Button>
        ) : (
          <Button onClick={() => void setActiveProject(workspaceId, project.id)}>
            设为当前项目
          </Button>
        )}
      </div>

      <hr className="border-edge" />

      <div className="flex flex-col gap-2">
        <p className="text-ink-dim text-[11px]">重命名（只改显示名，不动磁盘上的目录）</p>
        <div className="flex items-center gap-2">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={project.name}
          />
          <Button
            disabled={name.trim().length === 0}
            onClick={() => {
              void renameProject(project.id, name.trim()).then((ok) => {
                if (ok) setName('')
              })
            }}
          >
            保存
          </Button>
        </div>
      </div>

      <hr className="border-edge" />

      {confirming ? (
        <div className="border-neon-pink/30 bg-neon-pink/5 flex flex-col gap-3 rounded-md border p-3">
          <p className="text-[12px] leading-relaxed">
            从工作空间里移除「{project.name}」？
          </p>
          {editable ? (
            <Checkbox
              checked={deleteCopy}
              onChange={setDeleteCopy}
              label="同时删除磁盘上的副本目录"
              hint={`会删除：${project.rootPath}`}
            />
          ) : (
            <p className="text-ink-faint text-[11px] leading-relaxed">
              这是原地引用的目录 —— <Em tone="good">它不会被删除</Em>，无论你在这里勾什么。
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              onClick={() => {
                void removeProject(project.id, editable && deleteCopy).then((ok) => {
                  if (ok) {
                    setConfirming(false)
                    setDeleteCopy(false)
                    select(null)
                  }
                })
              }}
            >
              确认移除
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          从工作空间移除…
        </Button>
      )}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-3">
      <dt className="text-ink-faint w-16 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}
