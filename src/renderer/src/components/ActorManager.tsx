import { useEffect, useState } from 'react'
import { AGENT_KINDS, EFFORT_LEVELS, type Actor, type AgentKind, type EffortLevel } from '@shared/entities'
import { useStore } from '../store'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Field, PathInput, Select, TextInput } from './ui/Field'
import { Em } from './ui/Text'

/**
 * 角色库（全局的「人」，§2.4）。
 *
 * ★ 它**不属于任何空间**，所以入口挂在侧边栏底部而不是空间相关的位置 ——
 *   界面上把它放进某个空间里，就会让人以为换空间它就不在了。
 *
 * 人设文件是这个角色的 system prompt 主体（§4.6），所以「换人设」是**独立的一步**
 * （`actor:setPersona`），并在界面上如实说明它会改掉内容指纹。
 */
export function ActorManagerDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const actors = useStore((s) => s.actors)
  const loadActors = useStore((s) => s.loadActors)
  const removeActor = useStore((s) => s.removeActor)
  const setActorPersona = useStore((s) => s.setActorPersona)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [personaId, setPersonaId] = useState<string | null>(null)

  // 打开就刷新一次：角色是全局的，别的窗口/别的入口都可能改过它。**只读、幂等**。
  useEffect(() => {
    if (open) void loadActors()
  }, [open, loadActors])

  // 每次打开从列表态开始。
  useEffect(() => {
    if (open) {
      setCreating(false)
      setEditingId(null)
      setPersonaId(null)
    }
  }, [open])

  if (!open) return null

  return (
    <Dialog
      open={open}
      title="角色库"
      subtitle={
        <>
          角色是<Em>全局</Em>的「人」，跨工作空间复用。把一个角色加进某个空间，
          产生的是那个空间里的<Em>成员</Em> —— 显示名、职责、可见项目都在成员那一层。
        </>
      }
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            + 新建角色
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {creating && <ActorForm actor={null} onDone={() => setCreating(false)} />}

        {actors.length === 0 && !creating ? (
          <div className="border-edge text-ink-faint rounded-lg border border-dashed px-4 py-5 text-center">
            <p className="text-ink-dim text-[12.5px]">还没有任何角色</p>
            <p className="mt-2 text-[11px] leading-relaxed">
              建一个角色需要三样：名字、模型（自由文本，写你的 settings.json 里的别名）、
              以及一个<Em tone="dim">人设 Markdown 文件</Em>。
            </p>
          </div>
        ) : (
          actors.map((a) =>
            editingId === a.id ? (
              <ActorForm
                key={a.id}
                actor={a}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <div
                key={a.id}
                className="border-edge bg-panel/40 flex flex-col gap-2 rounded-lg border px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-ink text-[12.5px] font-semibold">{a.name}</span>
                  <Badge tone="dim">{a.agentKind}</Badge>
                  <Badge tone="dim">{a.effort}</Badge>
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="sm" onClick={() => setEditingId(a.id)}>
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setPersonaId(personaId === a.id ? null : a.id)}
                    >
                      换人设
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void removeActor(a.id)}
                    >
                      删除
                    </Button>
                  </span>
                </div>
                <p className="text-ink-faint text-[11px] leading-relaxed">
                  模型 <Em tone="dim">{a.model}</Em>
                </p>
                <p className="text-ink-faint font-mono text-[10.5px] break-all">
                  人设 {a.personaPath} · 指纹 {a.personaHash.slice(0, 12)}…
                </p>

                {personaId === a.id && (
                  <PersonaSwitcher
                    actor={a}
                    onDone={() => setPersonaId(null)}
                    onPick={setActorPersona}
                  />
                )}
              </div>
            )
          )
        )}
      </div>
    </Dialog>
  )
}

/** 新建（`actor === null`）与编辑共用一个表单 —— 字段几乎一样，分成两份只会漂移。 */
function ActorForm({ actor, onDone }: { actor: Actor | null; onDone: () => void }): React.JSX.Element {
  const createActor = useStore((s) => s.createActor)
  const updateActor = useStore((s) => s.updateActor)
  const busy = useStore(
    (s) => s.pending['actor:create'] === true || s.pending['actor:update'] === true
  )

  const [name, setName] = useState(actor?.name ?? '')
  const [model, setModel] = useState(actor?.model ?? '')
  const [agentKind, setAgentKind] = useState<AgentKind>(actor?.agentKind ?? 'claude')
  const [effort, setEffort] = useState<EffortLevel>(actor?.effort ?? 'high')
  const [personaPath, setPersonaPath] = useState('')

  const isNew = actor === null
  const canSubmit =
    name.trim().length > 0 && model.trim().length > 0 && (isNew ? personaPath.trim().length > 0 : true)

  return (
    <div className="border-neon-cyan/30 bg-neon-cyan/5 flex flex-col gap-3 rounded-lg border px-3 py-3">
      <p className="text-[12px] font-medium">{isNew ? '新建角色' : `编辑「${actor.name}」`}</p>

      <Field label="名字" hint="全局唯一。同一个「人」在多个空间里可以有不同显示名，但名字只有这一个。">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Atlas" />
      </Field>

      <Field
        label="模型"
        hint="自由文本，不是枚举（§2.4）—— 你的 settings.json 把别名映射到哪个端点都行，换端点时不该要我们改代码。"
      >
        <TextInput
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="例如：claude-sonnet-5"
          spellCheck={false}
          className="font-mono text-[11.5px]"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="agent">
          <Select value={agentKind} onChange={(e) => setAgentKind(e.target.value as AgentKind)}>
            {AGENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="effort">
          <Select value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
            {EFFORT_LEVELS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {isNew && (
        <Field
          label="人设文件"
          hint="这个角色的 system prompt 主体（Markdown）。路径与内容指纹都由主进程读、主进程算 —— 渲染侧没有文件系统。"
        >
          <PathInput
            value={personaPath}
            onChange={setPersonaPath}
            mode="file"
            title="选择人设文件（Markdown）"
            placeholder="C:\path\to\persona.md"
          />
        </Field>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          disabled={busy || !canSubmit}
          onClick={() => {
            if (isNew) {
              void createActor({
                name: name.trim(),
                model: model.trim(),
                personaPath: personaPath.trim(),
                agentKind,
                effort
              }).then((a) => a && onDone())
              return
            }
            void updateActor({
              id: actor.id,
              name: name.trim(),
              model: model.trim(),
              effort,
              agentKind
            }).then((ok) => ok && onDone())
          }}
        >
          {busy ? '保存中…' : isNew ? '创建' : '保存'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
    </div>
  )
}

/** 换人设是独立的一步：它读文件、算指纹，而指纹一变可缓存前缀就失效（§4.6）。 */
function PersonaSwitcher({
  actor,
  onPick,
  onDone
}: {
  actor: Actor
  onPick: (id: string, path: string) => Promise<boolean>
  onDone: () => void
}): React.JSX.Element {
  const [path, setPath] = useState('')
  const busy = useStore((s) => s.pending['actor:setPersona'] === true)

  return (
    <div className="border-edge flex flex-col gap-2 rounded-md border px-2.5 py-2.5">
      <p className="text-ink-faint text-[11px] leading-relaxed">
        换人设<Em tone="dim">会让内容指纹变</Em>，也就是让这个角色的可缓存前缀失效
        —— 下一轮会重新建立缓存。这是对的：人设变了，缓存本来就不该复用。
      </p>
      <PathInput
        value={path}
        onChange={setPath}
        mode="file"
        title="选择新的人设文件（Markdown）"
        placeholder={actor.personaPath}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || path.trim().length === 0}
          onClick={() => void onPick(actor.id, path.trim()).then((ok) => ok && onDone())}
        >
          {busy ? '更换中…' : '更换'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
    </div>
  )
}
