import { useStore } from '../../store'
import { ActorChip } from './ActorChip'
import { LiveThinking } from './ThinkingPanel'
import { LiveToolTimeline } from './ToolTimeline'
import { StreamingText } from './StreamingText'

/**
 * 在途的那一轮。**§4.7 规则 3。**
 *
 * ## 它自己**不是**那个 30Hz 的组件
 *
 * 规则 3 的原话是「这一轮由 `<StreamingRow>` 单独呈现，它是唯一以 30Hz 重渲染的东西」。
 * 落地时这里收得更紧一点：**连它也不随 delta 重渲染**。
 *
 * 做法还是在选择器上 —— 这个组件订阅的四个值全是**低频且原子**的：
 *
 * | 订阅 | 变化时机 |
 * |---|---|
 * | `actorId` | 一轮之内恒定 |
 * | `items` | 只在工具调用/改动/报错**增删**时换引用 |
 * | `usage` | 一轮一次 |
 * | `done` | 一轮一次 |
 *
 * 正文与思考**不在这个列表里** —— 它们各自在自己的组件里订阅（`StreamingText` /
 * `LiveThinking`），所以一个 delta 只重渲染那一个 `<p>` 或那一个面板。
 *
 * 这样比规则 3 的原话少重渲染一整张卡片（头像、时间线、diff、用量表头），
 * 而规则 3 真正要防的事（整张 `<MessageList>` 跟着 30Hz 跑）两版都防住了。
 * 这条收紧记在 `docs/design.md` §4.7。
 *
 * ## `actorId` 可能是空串
 *
 * 切回来重放时帧上没有角色 id（`stream:batch` 不带它），那时 `ActorChip` 显示
 * 「未知成员」。**不猜** —— 猜一个角色会让用户以为这条回答出自某个它其实没做过的成员。
 */
export function StreamingRow({ turnId }: { turnId: string }): React.JSX.Element | null {
  const actorId = useStore((s) => s.buffers[turnId]?.actorId ?? '')
  const workspaceId = useStore((s) => s.buffers[turnId]?.workspaceId ?? '')
  const usage = useStore((s) => s.buffers[turnId]?.usage ?? null)
  const done = useStore((s) => s.buffers[turnId]?.done ?? null)

  // 缓冲在这一帧刚好被丢掉（终态推送与 React 的渲染错开一拍）—— 不渲染任何东西。
  if (workspaceId === '') return null

  return (
    <article className="neon-frame neon-halo bg-panel/70 rounded-xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <ActorChip workspaceId={workspaceId} memberId={actorId} />
        {done === null && (
          <span className="text-neon-cyan ml-auto flex items-center gap-1.5 font-mono text-[10px]">
            <span className="neon-halo inline-block size-1.5 rounded-full" />
            推理中
          </span>
        )}
      </div>

      <LiveThinking turnId={turnId} />
      <LiveToolTimeline turnId={turnId} />
      <StreamingText turnId={turnId} />

      {/* 用量一轮只发一条（`frame-buffer` 里是**覆盖**不是累加），所以这里就一行。 */}
      {usage !== null && (
        <div className="text-ink-faint mt-3 flex items-center gap-3 font-mono text-[10px]">
          <span>入 {usage.in}</span>
          <span>出 {usage.out}</span>
          {usage.thinkingTokens > 0 && <span>思考 {usage.thinkingTokens}</span>}
          {usage.cacheRead > 0 && <span>缓存命中 {usage.cacheRead}</span>}
          {usage.costUsd !== undefined && <span>本轮 ≈${usage.costUsd.toFixed(4)}（估算）</span>}
        </div>
      )}
    </article>
  )
}
