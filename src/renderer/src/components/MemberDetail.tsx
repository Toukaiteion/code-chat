import { useState } from 'react'
import type { Project } from '@shared/entities'
import { useStore } from '../store'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Checkbox, Field, PathInput } from './ui/Field'
import { Em } from './ui/Text'

const EMPTY_PROJECTS: Project[] = []

/**
 * 成员详情：职责文件 + 可见项目（§8.4）。
 *
 * ★ 这个文件里最要紧的不是功能，而是**文案**。三条纪律（§3.4 / §8.4 / §5.6）在这里
 *   逐条落地，而且都是**常驻说明**、不是一闪而过的提示：
 *
 *   1. 可见项目**只是上下文裁剪**，让角色专注，**不是安全机制**。
 *      必须说清：agent 跑在一个带 shell 的进程里，它读得到这个进程读得到的一切，
 *      包括你没勾的那些项目。让人以为「没勾 = 读不到」是这里唯一真正危险的错误。
 *   2. 谈及硬底 deny 列表时只能说「能静态判定的路径是硬的，动态构造的不是」，
 *      **绝不能**把它说成「安全」。
 *   3. 改可见性**将在下一轮生效** —— `--add-dir` 是启动参数，改不了已经在跑的进程。
 *
 *   还有一条反直觉语义：`isRestricted === false` 时后端返回的 `ids` 是**空数组**，
 *   意思是「**可见全部**」而不是「什么都看不见」。空数组和「一个都不勾」
 *   在勾选框上长得一模一样，所以这里**不允许**把勾全部取消 —— 见 `toggle()`。
 */
export function MemberDetail({
  workspaceId,
  memberId
}: {
  workspaceId: string
  memberId: string
}): React.JSX.Element {
  const member = useStore(
    (s) => (s.membersByWorkspace[workspaceId] ?? []).find((m) => m.id === memberId) ?? null
  )
  const actor = useStore((s) =>
    member ? (s.actors.find((a) => a.id === member.actorId) ?? null) : null
  )
  const projects = useStore((s) => s.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS)
  const vis = useStore((s) => s.visibilityByMember[memberId] ?? null)

  const setMemberEnabled = useStore((s) => s.setMemberEnabled)
  const setMemberRouter = useStore((s) => s.setMemberRouter)
  const setMemberRoleDesc = useStore((s) => s.setMemberRoleDesc)
  const setVisibility = useStore((s) => s.setVisibility)
  const clearVisibility = useStore((s) => s.clearVisibility)
  const removeMember = useStore((s) => s.removeMember)
  const pushNotice = useStore((s) => s.pushNotice)

  const [roleDesc, setRoleDesc] = useState('')
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  if (!member) {
    return (
      <p className="text-ink-faint text-[12px]">
        这个成员已经不在了 —— 它可能刚被移除，或者你换了工作空间。
      </p>
    )
  }

  const restricted = vis?.isRestricted === true
  const picked = vis?.ids ?? []
  const primaryId = vis?.primaryProjectId ?? null

  function toggle(projectId: string, on: boolean): void {
    const next = on ? [...picked, projectId] : picked.filter((id) => id !== projectId)
    if (next.length === 0) {
      // ★ 这里**必须拒绝**，而不是照做：后端把「一行可见行都没有」定义成
      //   「可见全部项目」，所以「全部取消勾选」的实际效果是**放开**而不是**收紧**。
      //   而在界面上，「全部取消勾选」和「可见全部」长得一模一样 ——
      //   默默做一件和用户以为的相反的事，是这里唯一不能接受的选项。
      pushNotice({
        level: 'warning',
        message: '不能把勾全部取消',
        detail:
          '在这个系统里，「一个可见项目都不指定」的意思是「看见全部项目」（默认状态），' +
          '而不是「什么都看不见」。想回到那个状态，请点上面的「恢复默认（全部可见）」。'
      })
      return
    }
    // 取消勾选的是主项目 → 主项目必须同时可见，所以顺手清掉（§8.5b：cwd 不能指向看不见的目录）。
    const nextPrimary = primaryId && next.includes(primaryId) ? primaryId : null
    void setVisibility(memberId, next, nextPrimary)
  }

  return (
    <section className="border-edge bg-panel/40 flex flex-col gap-5 rounded-xl border p-5">
      {/* ── 头部 ── */}
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-ink text-sm font-semibold">{member.displayName}</h2>
          {member.isRouter && <Badge tone="violet">路由</Badge>}
          {!member.enabled && <Badge tone="dim">已停用</Badge>}
        </div>
        <p className="text-ink-faint text-[11px] leading-relaxed">
          角色 <Em tone="dim">{actor?.name ?? member.actorId}</Em> · {actor?.agentKind ?? '?'} ·{' '}
          {actor?.model ?? '?'} · effort {actor?.effort ?? '?'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void setMemberEnabled(member.id, !member.enabled)}>
            {member.enabled ? '停用这个成员' : '启用这个成员'}
          </Button>
          <Button onClick={() => void setMemberRouter(member.id, !member.isRouter)}>
            {member.isRouter ? '取消路由角色' : '设为路由角色'}
          </Button>
        </div>
      </header>

      <hr className="border-edge" />

      {/* ── 职责文件 ── */}
      <div className="flex flex-col gap-2">
        <Field
          label="职责文件"
          hint="追加进这个成员 system prompt 的一段说明（§4.6）。内容变了会同时更新指纹 —— 那会让可缓存前缀失效，下一轮重建缓存。"
        >
          <PathInput
            value={roleDesc}
            onChange={setRoleDesc}
            mode="file"
            title="选择职责文件（Markdown）"
            placeholder={member.roleDescPath ?? '留空表示没有'}
          />
        </Field>
        <p className="text-ink-faint font-mono text-[10.5px] break-all">
          {member.roleDescPath
            ? `当前：${member.roleDescPath}（指纹 ${member.roleDescHash?.slice(0, 12) ?? '无'}…）`
            : '当前：没有职责文件'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            disabled={roleDesc.trim().length === 0}
            onClick={() => {
              void setMemberRoleDesc(member.id, roleDesc.trim()).then((ok) => {
                if (ok) setRoleDesc('')
              })
            }}
          >
            保存职责文件
          </Button>
          <Button
            variant="ghost"
            disabled={!member.roleDescPath}
            onClick={() => void setMemberRoleDesc(member.id, null)}
          >
            清空
          </Button>
        </div>
      </div>

      <hr className="border-edge" />

      {/* ── 可见项目 ── */}
      <div className="flex flex-col gap-3">
        <p className="text-ink-dim text-[11px] font-medium">可见项目</p>

        <p className="text-[12px] leading-relaxed">
          {restricted ? (
            <>
              当前：<Em tone="good">只可见 {picked.length} 个项目</Em>
            </>
          ) : (
            <>
              当前：<Em tone="good">可见空间内全部项目</Em>（没有收窄）
            </>
          )}
        </p>

        {restricted && (
          <div>
            <Button variant="ghost" onClick={() => void clearVisibility(member.id)}>
              恢复默认（全部可见）
            </Button>
          </div>
        )}

        {projects.length === 0 ? (
          <p className="text-ink-faint text-[11px] leading-relaxed">
            这个空间还没有项目 —— 先在侧边栏加一个项目，可见性才有东西可收窄。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((p) => {
              const on = picked.includes(p.id)
              return (
                <li key={p.id} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Checkbox
                      checked={on}
                      onChange={(next) => toggle(p.id, next)}
                      label={
                        <span className="font-mono text-[11.5px]">
                          {p.name}
                          <span className="text-ink-faint"> · {p.origin}</span>
                        </span>
                      }
                      hint={<span className="font-mono text-[10px] break-all">{p.rootPath}</span>}
                    />
                  </div>
                  {/* 主项目 = cwd 的一级来源（§8.5b）。未勾选的项目不能当主项目。 */}
                  <label
                    className={`flex shrink-0 items-center gap-1 text-[11px] ${
                      on && restricted ? 'text-ink-dim cursor-pointer' : 'text-ink-faint opacity-40'
                    }`}
                    title={
                      restricted
                        ? '主项目决定这个成员的工作目录（cwd 的一级来源，§8.5b）'
                        : '要指定主项目，得先把这个成员收窄成「只可见部分项目」'
                    }
                  >
                    <input
                      type="radio"
                      name={`primary-${member.id}`}
                      className="accent-neon-cyan size-3.5"
                      checked={primaryId === p.id}
                      disabled={!on || !restricted}
                      onChange={() => void setVisibility(memberId, picked, p.id)}
                    />
                    主项目
                  </label>
                </li>
              )
            })}
          </ul>
        )}

        {restricted && (
          <Button variant="ghost" onClick={() => void setVisibility(memberId, picked, null)}>
            清除主项目标记
          </Button>
        )}

        {/* ── ★ 三条纪律，逐条印在界面上 ── */}
        <div className="border-edge bg-void/40 flex flex-col gap-2 rounded-md border px-3 py-2.5">
          <p className="text-[11px] leading-relaxed">
            <Em>可见项目只用于让角色「专注」</Em> —— 少装点上下文，仅此而已。
            它<Em>不是</Em>安全机制：角色跑在一个带 shell 的进程里，
            这个进程读得到的东西它就读得到，
            <Em tone="warn">包括你没有勾选的那些项目</Em>。
          </p>
          <p className="text-ink-faint text-[11px] leading-relaxed">
            应用层另有一份硬底黑名单（删库、改 git 配置之类），但要说实话：
            <Em tone="dim">能静态判定的路径是硬的，动态构造的不是。</Em>
            它挡得住手滑，挡不住有意绕路。
          </p>
          <p className="text-ink-faint text-[11px] leading-relaxed">
            改动<Em tone="dim">将在下一轮生效</Em> —— 可见项目是通过启动参数
            <span className="font-mono"> --add-dir </span>
            传给 agent 进程的，改不了已经在跑的那一轮。
          </p>
          <p className="text-ink-faint text-[11px] leading-relaxed">
            这里也没有「只读」这种模式：可见与不可见是同一条边界，
            可见的项目就是能读能写。
          </p>
          <p className="text-ink-faint text-[11px] leading-relaxed">
            可见项目是<Em tone="dim">每空间独立</Em>的：换一个工作空间，
            同一个角色可以是完全不同的配置。
          </p>
        </div>
      </div>

      <hr className="border-edge" />

      {/* ── 移除 ── */}
      <div className="flex flex-col gap-2">
        <p className="text-neon-pink text-[11px] font-medium">移除成员</p>
        <p className="text-ink-faint text-[11px] leading-relaxed">
          只是让他从这个空间退出：他的会话与消息会一并删除，但那个全局的「角色」本身还在，别的空间不受影响。
        </p>
        {confirmingRemove ? (
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              onClick={() => {
                void removeMember(member.id).then((ok) => {
                  if (ok) setConfirmingRemove(false)
                })
              }}
            >
              确认移除「{member.displayName}」
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
              取消
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="danger" onClick={() => setConfirmingRemove(true)}>
              移除成员…
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
