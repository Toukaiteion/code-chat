import type { WorkspaceMember } from '@shared/entities'
import { useStore } from '../../store'

const EMPTY_MEMBERS: WorkspaceMember[] = []

/**
 * 角色的方块头像 + 名字。
 *
 * ★ **查不到就说查不到。** `memberId` 为空（在途重放拿不到 `actorId` —— 帧上不带它，
 *   见 `live.ts` 的 `resumeWorkspace`）或成员已被移出空间时，显示「未知成员」，
 *   配色退回中性灰。
 *
 * 这不是偷懒的兜底：拿 `sessionId` 去反推一个角色、或者按到达顺序轮流上色，
 * 都会让用户看到**一个看起来确定的错误答案**。而「未知成员」是在如实说
 * 「这条消息是谁发的，我这边不知道」—— 用户由此知道该去核对什么。
 */
export function ActorChip({
  workspaceId,
  memberId
}: {
  workspaceId: string
  memberId: string
}): React.JSX.Element {
  const member = useStore(
    (s) => (s.membersByWorkspace[workspaceId] ?? EMPTY_MEMBERS).find((m) => m.id === memberId) ?? null
  )

  if (member === null) {
    return (
      <span className="text-ink-faint flex items-center gap-2 text-[13px]">
        <span className="border-edge text-ink-faint flex size-6 items-center justify-center rounded-md border text-[11px]">
          ?
        </span>
        未知成员
      </span>
    )
  }

  /*
   * 名字里取一个字当头像。**不按 id 取模挑颜色** —— 那种配色在换一批成员之后
   * 会整体错位，而它看起来又很确定。这里按 `isRouter` 分两色，是一个**真的事实**：
   * 路由角色在空间里至多一个（偏索引保证），它本来就该显眼。
   */
  return (
    <span className="flex items-center gap-2">
      <span
        className={`flex size-6 items-center justify-center rounded-md font-mono text-[11px] font-bold ${
          member.isRouter
            ? 'bg-neon-violet/15 text-neon-violet'
            : 'bg-neon-cyan/15 text-neon-cyan'
        }`}
      >
        {member.displayName.slice(0, 1)}
      </span>
      <span className="text-ink text-[13px] font-semibold">{member.displayName}</span>
      {member.isRouter && (
        <span className="text-neon-violet/70 font-mono text-[10px]" title="路由角色：负责把请求派给其他成员">
          路由
        </span>
      )}
    </span>
  )
}
