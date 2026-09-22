import { useEffect, useState } from 'react'
import { COPY_SKIP_DIRS } from '@shared/copy-policy'
import { useStore } from '../store'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Field, PathInput, TextInput } from './ui/Field'
import { Em } from './ui/Text'

type Mode = 'local' | 'copy' | 'clone'

const MODES: Array<{ id: Mode; label: string; blurb: string }> = [
  {
    id: 'local',
    label: '原地引用',
    blurb: '直接指向你已经有的目录。只登记一行，不复制、不移动。'
  },
  { id: 'copy', label: '复制到别处', blurb: '复制一份放到你指定的位置，原目录一个字节都不动。' },
  { id: 'clone', label: 'git clone', blurb: '从远端拉一份完整的克隆（含全部历史）。' }
]

/**
 * 添加项目 —— **一条流程，三个分支**（§8.2）。
 *
 * 它做成一个对话框而不是三个，是因为这三条路对用户来说是**同一件事的三种取舍**
 * （要不要动我的原目录？历史要不要？），摆在一起才比得出来。
 *
 * 两条贯穿全组件的纪律：
 *
 * 1. **每个路径都是可编辑的文本框**，旁边才是「选择…」按钮。原生对话框只是便利，
 *    不是唯一入口 —— 既照顾用户自己的目录排布习惯，也让「填一个路径」这件事
 *    不必依赖一条主进程才能提供的对话框。
 * 2. **代价写在按钮旁边，不是写在这里**：原地引用会改你的真实目录、复制会跳过
 *    一批目录、克隆要联网。用户点「添加」之前就该看到它们。
 */
export function AddProjectDialog({
  open,
  workspaceId,
  onClose
}: {
  open: boolean
  workspaceId: string
  onClose: () => void
}): React.JSX.Element | null {
  const addLocalProject = useStore((s) => s.addLocalProject)
  const copyProject = useStore((s) => s.copyProject)
  const cloneProject = useStore((s) => s.cloneProject)
  const defaultTarget = useStore((s) => s.defaultTarget)
  const pending = useStore((s) => s.pending)

  const [mode, setMode] = useState<Mode>('local')
  const [name, setName] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [targetTouched, setTargetTouched] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [branch, setBranch] = useState('')

  // 每次打开都从空白开始。
  useEffect(() => {
    if (!open) return
    setMode('local')
    setName('')
    setLocalPath('')
    setSourcePath('')
    setTargetPath('')
    setTargetTouched(false)
    setRemoteUrl('')
    setBranch('')
  }, [open])

  /**
   * 自动填默认落点：`<空间目录>/projects/<项目名>`。
   *
   * ⚠️ 这是**只读**调用（`project:defaultTarget` 只算路径、不碰磁盘），
   *    所以 StrictMode 下跑两遍完全无害 —— 这正是「effect 里可以做读、不可以做写」
   *    那条纪律的正面例子。（M3 被自动创建空间的写操作咬过一次。）
   *    用户一旦自己动过目标框（`targetTouched`），就再也不覆盖他的输入。
   */
  useEffect(() => {
    if (!open || mode === 'local' || targetTouched) return
    const trimmed = name.trim()
    if (trimmed.length === 0) return

    let alive = true
    void defaultTarget(workspaceId, trimmed).then((path) => {
      if (alive && path) setTargetPath(path)
    })
    return () => {
      alive = false
    }
  }, [open, mode, name, targetTouched, workspaceId, defaultTarget])

  if (!open) return null

  const busy =
    pending['project:addLocal'] === true ||
    pending['project:copy'] === true ||
    pending['project:clone'] === true

  const canSubmit =
    name.trim().length > 0 &&
    (mode === 'local'
      ? localPath.trim().length > 0
      : mode === 'copy'
        ? sourcePath.trim().length > 0 && targetPath.trim().length > 0
        : remoteUrl.trim().length > 0 && targetPath.trim().length > 0)

  function submit(): void {
    const trimmedName = name.trim()
    if (mode === 'local') {
      void addLocalProject({
        workspaceId,
        name: trimmedName,
        rootPath: localPath.trim()
      }).then((p) => p && onClose())
      return
    }
    if (mode === 'copy') {
      void copyProject({
        workspaceId,
        name: trimmedName,
        sourcePath: sourcePath.trim(),
        targetPath: targetPath.trim()
      }).then((p) => p && onClose())
      return
    }
    void cloneProject({
      workspaceId,
      name: trimmedName,
      remoteUrl: remoteUrl.trim(),
      targetPath: targetPath.trim(),
      defaultBranch: branch.trim() || null
    }).then((p) => p && onClose())
  }

  return (
    <Dialog
      open={open}
      title="添加项目"
      subtitle="三种方式，代价不同。选一个，路径都可以手写。"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy || !canSubmit} onClick={submit}>
            {busy ? '处理中…' : '添加'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* ── 三选一 ── */}
        <div className="flex flex-col gap-1.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors ${
                mode === m.id
                  ? 'border-neon-cyan/40 bg-neon-cyan/8'
                  : 'border-edge hover:border-edge-bright'
              }`}
            >
              <span className="flex items-center gap-2 text-[12.5px] font-medium">
                <span
                  className={`inline-block size-2 rounded-full ${
                    mode === m.id ? 'bg-neon-cyan' : 'border-edge-bright border'
                  }`}
                />
                {m.label}
              </span>
              <span className="text-ink-faint pl-4 text-[11px] leading-relaxed">{m.blurb}</span>
            </button>
          ))}
        </div>

        <Field label="项目名" hint="列表上显示的名字。它也是默认落点的目录名（会被净化）。">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：api-server"
          />
        </Field>

        <hr className="border-edge" />

        {mode === 'local' && (
          <>
            <Field label="目录">
              <PathInput
                value={localPath}
                onChange={setLocalPath}
                mode="directory"
                title="选择要原地引用的目录"
                placeholder="C:\path\to\your\project"
              />
            </Field>
            <div className="border-neon-pink/30 bg-neon-pink/5 rounded-md border px-3 py-2.5">
              <p className="text-[11.5px] leading-relaxed">
                <Em tone="warn">agent 会直接改这个目录</Em>
                —— 它就是你的真实工作目录，没有副本可以回退。
              </p>
              <p className="text-ink-faint mt-1 text-[11px] leading-relaxed">
                反过来说：删工作空间、删项目都<Em tone="dim">不会动它一个字节</Em>
                （这是硬约束，不是「尽量」）。
              </p>
            </div>
          </>
        )}

        {mode === 'copy' && (
          <>
            <Field label="源目录">
              <PathInput
                value={sourcePath}
                onChange={setSourcePath}
                mode="directory"
                title="选择要复制的源目录"
                placeholder="C:\path\to\source"
              />
            </Field>
            <Field label="目标目录" hint="默认是 <空间目录>/projects/<项目名>，可以改到任何地方，包括空间目录外面。">
              <PathInput
                value={targetPath}
                onChange={(next) => {
                  setTargetTouched(true)
                  setTargetPath(next)
                }}
                mode="directory"
                title="选择目标目录"
                placeholder="目标位置"
              />
            </Field>
            <SkipNotice source={sourcePath} />
          </>
        )}

        {mode === 'clone' && (
          <>
            <Field label="远端 URL" hint="https 或 git@ 都行。凭据用你本机 git 的（凭据管理器 / SSH key），我们不接管。">
              <TextInput
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder="https://example.com/team/repo.git"
                spellCheck={false}
                className="font-mono text-[11.5px]"
              />
            </Field>
            <Field label="目标目录" hint="和复制一样：默认落在 <空间目录>/projects/ 下，可以改。">
              <PathInput
                value={targetPath}
                onChange={(next) => {
                  setTargetTouched(true)
                  setTargetPath(next)
                }}
                mode="directory"
                title="选择目标目录"
                placeholder="目标位置"
              />
            </Field>
            <Field label="分支（可选）" hint="留空就用远端的默认分支。填了就相当于 git clone --branch <名字>。">
              <TextInput
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="留空 = 远端默认分支"
                spellCheck={false}
                className="font-mono text-[11.5px]"
              />
            </Field>
            <div className="border-edge bg-void/40 rounded-md border px-3 py-2.5">
              <p className="text-[11.5px] leading-relaxed">
                这是<Em>完整克隆</Em>（不加 <span className="font-mono">--depth</span>）——
                历史都在，agent 看得到。代价是慢，而且<Em tone="dim">没有进度条、不能取消</Em>。
              </p>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}

/** 复制会跳过什么。**必须显示** —— 静默跳过会让用户以为整棵树都复制过来了。 */
function SkipNotice({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="border-edge bg-void/40 rounded-md border px-3 py-2.5">
      <p className="text-[11.5px] leading-relaxed">
        会跳过这些<Em>可重装</Em>的目录（按目录名匹配，任意深度）：
      </p>
      <p className="text-ink-dim mt-1 font-mono text-[10.5px] break-all">
        {COPY_SKIP_DIRS.join('、')}
      </p>
      <p className="text-ink-faint mt-1 text-[11px] leading-relaxed">
        <span className="font-mono">.git</span> <Em>会保留</Em> —— 历史拷不出来的，
        丢了就是丢了。同名的<Em tone="dim">文件</Em>（比如一个叫{' '}
        <span className="font-mono">build</span> 的脚本）不会被跳过。
      </p>
      <p className="text-ink-faint mt-1 text-[11px] leading-relaxed">
        源目录{source.trim() ? `：${source.trim()}` : ''}一个字节都不会动。
        复制本身<Em tone="dim">没有进度条、不能取消</Em>。
      </p>
    </div>
  )
}
