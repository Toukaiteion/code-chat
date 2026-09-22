import { useState } from 'react'
import type { Project, WorkspaceMember } from '@shared/entities'
import { useStore } from '../store'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Field, PathInput, Select, TextInput } from './ui/Field'
import { Em } from './ui/Text'

const EMPTY_MEMBERS: WorkspaceMember[] = []
const EMPTY_PROJECTS: Project[] = []

/** 侧边栏里的成员列表。点一行在右侧看详情（职责文件 + 可见性）。 */
export function MemberList({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const members = useStore((s) => s.membersByWorkspace[workspaceId] ?? EMPTY_MEMBERS)
  const actors = useStore((s) => s.actors)
  const projects = useStore((s) => s.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS)
  const visibility = useStore((s) => s.visibilityByMember)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const setMemberEnabled = useStore((s) => s.setMemberEnabled)
  const [adding, setAdding] = useState(false)

  return (
    <div className="border-edge border-t px-3 py-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-ink-faint font-mono text-[10px] tracking-widest uppercase">成员</p>
        <button
          onClick={() => setAdding(true)}
          className="text-ink-faint hover:text-neon-cyan font-mono text-[10px] transition-colors"
          title="把一个全局角色以某个身份加进这个空间"
        >
          + 添加
        </button>
      </div>

      {members.length === 0 ? (
        <p className="text-ink-faint px-1 text-[11px] leading-relaxed">
          还没有成员。成员 = 一个全局的「角色」在本空间里的身份（显示名、职责、可见项目）。
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {members.map((m) => {
            const actor = actors.find((a) => a.id === m.actorId)
            const on = selection?.kind === 'member' && selection.id === m.id
            const primaryId = visibility[m.id]?.primaryProjectId ?? null
            const primary = projects.find((p) => p.id === primaryId)
            return (
              <div
                key={m.id}
                className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors ${
                  on ? 'bg-panel-2' : 'hover:bg-panel'
                }`}
              >
                <button
                  onClick={() => select({ kind: 'member', id: m.id })}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span
                      className={`truncate text-[12.5px] font-medium ${
                        m.enabled ? 'text-ink' : 'text-ink-faint line-through'
                      }`}
                    >
                      {m.displayName}
                    </span>
                    {m.isRouter && (
                      <Badge tone="violet" title="路由角色：每空间至多一个（§3.2）">
                        路由
                      </Badge>
                    )}
                  </span>
                  <span className="text-ink-faint w-full truncate font-mono text-[10px]">
                    {actor?.name ?? m.actorId}
                    {primary ? ` · 主项目 ${primary.name}` : ''}
                  </span>
                </button>

                <button
                  onClick={() => void setMemberEnabled(m.id, !m.enabled)}
                  title={m.enabled ? '停用：本轮起不再参与' : '启用'}
                  className={`shrink-0 rounded px-1 font-mono text-[10px] transition-colors ${
                    m.enabled
                      ? 'text-neon-lime hover:bg-panel-2'
                      : 'text-ink-faint hover:bg-panel-2'
                  }`}
                >
                  {m.enabled ? '启用' : '停用'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <AddMemberDialog open={adding} workspaceId={workspaceId} onClose={() => setAdding(false)} />
    </div>
  )
}

/** 把全局角色加进本空间。**Actor 是全局的，成员是每空间的**（§2.4）。 */
function AddMemberDialog({
  open,
  workspaceId,
  onClose
}: {
  open: boolean
  workspaceId: string
  onClose: () => void
}): React.JSX.Element {
  const actors = useStore((s) => s.actors)
  const createMember = useStore((s) => s.createMember)
  const loadActors = useStore((s) => s.loadActors)
  const busy = useStore((s) => s.pending['member:create'] === true)

  const [actorId, setActorId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [roleDescPath, setRoleDescPath] = useState('')

  const actor = actors.find((a) => a.id === actorId) ?? actors[0] ?? null
  const effectiveActorId = actor?.id ?? ''

  return (
    <Dialog
      open={open}
      title="把角色加入这个工作空间"
      subtitle={
        <>
          角色是<Em>全局</Em>的「人」，跨空间复用；加入空间后产生的是<Em>成员</Em>
          —— 显示名、职责文件、可见项目都在成员这一层，各空间互不影响。
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy || !effectiveActorId}
            onClick={() => {
              void createMember({
                workspaceId,
                actorId: effectiveActorId,
                displayName: displayName.trim() || actor?.name || '成员',
                roleDescPath: roleDescPath.trim() || null
              }).then((created) => {
                if (created) {
                  setDisplayName('')
                  setRoleDescPath('')
                  onClose()
                }
              })
            }}
          >
            {busy ? '添加中…' : '加入'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {actors.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-ink-dim text-[12px] leading-relaxed">
              还没有任何角色。角色是全局的，先在 <Em>角色库</Em> 里建一个（需要一个人设 Markdown 文件）。
            </p>
            <Button onClick={() => void loadActors()}>刷新角色列表</Button>
          </div>
        ) : (
          <>
            <Field label="角色">
              <Select value={effectiveActorId} onChange={(e) => setActorId(e.target.value)}>
                {actors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.model}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="在这个空间里的显示名" hint="留空就用角色名。同一个角色在不同空间可以有不同身份。">
              <TextInput
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={actor?.name ?? ''}
              />
            </Field>
            <Field
              label="职责文件（可选）"
              hint="一段追加进 system prompt 的说明（§4.6）。路径与内容指纹都由主进程读、主进程算。"
            >
              <PathInput
                value={roleDescPath}
                onChange={setRoleDescPath}
                mode="file"
                title="选择职责文件（Markdown）"
                placeholder="留空表示没有"
              />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  )
}
