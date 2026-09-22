import { useEffect, useState } from 'react'
import type { Project } from '@shared/entities'
import { useStore } from '../store'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Checkbox, Field, TextInput } from './ui/Field'
import { Em, PathText } from './ui/Text'
import { OriginBadge } from './ProjectList'

const EMPTY_PROJECTS: Project[] = []

/**
 * 新建 / 改名 / 删除 / 看空间目录 —— 四件事都围绕「一个空间」，所以放同一个组件。
 *
 * ★ 删除那段是**验收标准的用户可见面**：动的是磁盘上的真实目录，
 *   所以删除之前先把「会发生什么」一条条摆出来，删完再把「实际发生了什么」报回去
 *   （报告由 store 的 `summarizeDeleteReport` 推成一条通知）。
 */
export function WorkspaceDialog({
  open,
  mode,
  workspaceId,
  onClose
}: {
  open: boolean
  /** `create` = 建一个新的；`manage` = 管指定的那个。 */
  mode: 'create' | 'manage'
  workspaceId: string | null
  onClose: () => void
}): React.JSX.Element | null {
  const createWorkspace = useStore((s) => s.createWorkspace)
  const renameWorkspace = useStore((s) => s.renameWorkspace)
  const deleteWorkspace = useStore((s) => s.deleteWorkspace)
  const loadWorkspacePaths = useStore((s) => s.loadWorkspacePaths)
  const revealPath = useStore((s) => s.revealPath)
  const pending = useStore((s) => s.pending)

  const ws = useStore((s) => (workspaceId ? (s.workspaces[workspaceId] ?? null) : null))
  const paths = useStore((s) => (workspaceId ? (s.pathsByWorkspace[workspaceId] ?? null) : null))
  const projects = useStore((s) =>
    workspaceId ? (s.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS) : EMPTY_PROJECTS
  )

  const [name, setName] = useState('')
  const [deleteCopies, setDeleteCopies] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // 打开「管理」时拉一次真实路径。**只读、幂等**，所以 StrictMode 跑两遍无害。
  // （不传 `ensure` → 这个调用**不会**在磁盘上建任何东西，那正是那条开关的全部意义。）
  useEffect(() => {
    if (open && mode === 'manage' && workspaceId) void loadWorkspacePaths(workspaceId)
  }, [open, mode, workspaceId, loadWorkspacePaths])

  // 每次打开都从空白开始：留着上一次输入的内容会让「新建」变成一次惊吓。
  useEffect(() => {
    if (open) {
      setName('')
      setDeleteCopies(false)
      setConfirmingDelete(false)
    }
  }, [open])

  if (!open) return null

  if (mode === 'create') {
    const busy = pending['workspace:create'] === true
    return (
      <Dialog
        open={open}
        title="新建工作空间"
        subtitle={
          <>
            空间目录会<Em>当场</Em>建出来（不是等第一次用到它）。
            中文名字没问题；Windows 不接受的字符会被去掉，撞名会自动加序号。
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
              disabled={busy || name.trim().length === 0}
              onClick={() => {
                void createWorkspace(name.trim()).then((created) => {
                  if (created) onClose()
                })
              }}
            >
              {busy ? '正在建…' : '建出来'}
            </Button>
          </>
        }
      >
        <Field
          label="显示名"
          hint="改名只改显示名，不会移动磁盘上的目录 —— 所以创建时定下的目录名之后一直不变。"
        >
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Nova"
          />
        </Field>
      </Dialog>
    )
  }

  if (!ws) return null

  const renaming = pending['workspace:update'] === true
  const removing = pending['workspace:delete'] === true
  const copies = projects.filter((p) => p.origin !== 'local')
  const locals = projects.filter((p) => p.origin === 'local')

  return (
    <Dialog
      open={open}
      title={`工作空间设置 · ${ws.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button
            variant="outline"
            disabled={!paths}
            onClick={() => {
              if (paths) void revealPath(paths.rootPath)
            }}
          >
            在资源管理器中打开
          </Button>
          <Button
            variant="primary"
            disabled={renaming || name.trim().length === 0}
            onClick={() => void renameWorkspace(ws.id, name.trim())}
          >
            {renaming ? '保存中…' : '保存名字'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="显示名">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={ws.name} />
        </Field>

        {/* ── 空间目录：用户把根目录选在了资源管理器里看不见的 userData，所以必须显示真实路径 ── */}
        <div className="flex flex-col gap-2">
          <p className="text-ink-dim text-[11px] font-medium">空间目录</p>
          {paths ? (
            <>
              <PathText>{paths.rootPath}</PathText>
              <p className="text-ink-faint text-[11px] leading-relaxed">
                目录名是「{ws.dirName}」，<Em>改名不会移动它</Em> —— M5 起 agent 的工作目录就在这棵树下，
                移动它会让所有项目的绝对路径失效。
                {paths.exists ? '' : '（这个目录当前不在磁盘上，多半是 M4 之前建的空间。）'}
              </p>
              {!paths.exists && (
                <div>
                  <Button onClick={() => void loadWorkspacePaths(ws.id, true)}>立即建出目录</Button>
                </div>
              )}
            </>
          ) : (
            <p className="text-ink-faint text-[11px]">读取中…</p>
          )}
        </div>

        <hr className="border-edge" />

        {/* ── 删除：先把「会发生什么」摆出来 ── */}
        <div className="flex flex-col gap-3">
          <p className="text-neon-pink text-[11px] font-medium">删除这个工作空间</p>
          <p className="text-ink-faint text-[11px] leading-relaxed">
            会删掉空间本身、它的成员、以及那些成员的全部会话与消息。
          </p>

          {locals.length > 0 && (
            <div className="border-neon-cyan/25 bg-neon-cyan/5 rounded-md border px-3 py-2">
              <p className="text-[11px] leading-relaxed">
                这 {locals.length} 个<Em tone="good">原地引用</Em>的目录属于你，
                <Em tone="good">一个字节都不会动</Em>：
              </p>
              <ul className="text-ink-faint mt-1 flex flex-col gap-0.5 font-mono text-[10.5px] break-all">
                {locals.map((p) => (
                  <li key={p.id}>· {p.rootPath}</li>
                ))}
              </ul>
            </div>
          )}

          {copies.length > 0 ? (
            <>
              <Checkbox
                checked={deleteCopies}
                onChange={setDeleteCopies}
                label={`同时删除这 ${copies.length} 个副本目录`}
                hint="它们是我们复制/克隆出来的，删掉不影响你的原始目录。不勾选的话它们会留在磁盘上。"
              />
              <ul className="flex flex-col gap-1">
                {copies.map((p) => (
                  <li key={p.id} className="flex items-start gap-2 font-mono text-[10.5px]">
                    <OriginBadge origin={p.origin} />
                    <span className="text-ink-faint break-all">{p.rootPath}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-ink-faint text-[11px]">这个空间没有可删除的副本目录。</p>
          )}

          <p className="text-ink-faint text-[11px] leading-relaxed">
            空间目录本身<Em>永远不会被删</Em> —— 删完它仍留在磁盘上，位置见上面。
          </p>

          {confirmingDelete ? (
            <div className="flex items-center gap-2">
              <Button
                variant="danger"
                disabled={removing}
                onClick={() => {
                  void deleteWorkspace(ws.id, deleteCopies).then((report) => {
                    if (report) onClose()
                  })
                }}
              >
                {removing ? '删除中…' : '确认删除，我知道会发生什么'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                再想想
              </Button>
            </div>
          ) : (
            <div>
              <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
                删除这个工作空间…
              </Button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
