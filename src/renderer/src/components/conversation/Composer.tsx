import { useMemo, useState } from 'react'
import type { Mention, WorkspaceMember } from '@shared/entities'
import { useStore } from '../../store'

const EMPTY_MEMBERS: WorkspaceMember[] = []

/** 输入框里那一段「正在 @」的查询：`q` 是 `@` 之后那截还没打完的字。 */
interface MentionQuery {
  q: string
  at: number
}

/**
 * 光标前那一段 `@名字` 的查询词；没在输入 @ 就返回 `null`。
 *
 * ⚠️ **这不是 §3.1 禁的那种「从文本解析」**，两件事必须分清：
 * - 禁的是**运行时**（主进程）从用户发出去的自然语言里**猜** `@` 指向谁 ——
 *   那会遇到「名字里有空格」「改完名旧消息指向谁」这一整类问题；
 * - 这里做的是**输入辅助**：用户在**输入框里**打 `@`，我们弹出候选，他**选**一个 ——
 *   选中是一个**离散的动作**，`mention` 从那一刻起就是结构化的
 *   （`{memberId, kind}`），发出去的正文里那句话**不参与**任何判断。
 *
 * 简化：只看**最后**一个 `@`，且要求它前面是行首或空白；`@` 之后一出现空白
 * 就认为这段已经打完（关掉浮层）。不做真正的光标位置跟踪 —— 那需要受控 selection，
 * 而收益只是「在文本中间补 @ 时浮层位置更准」，不值这个复杂度。
 * 这个简化是**安全**的：判断偏保守 ⇒ 最坏情况是浮层不弹，而不是弹错人。
 */
function mentionQueryAt(text: string): MentionQuery | null {
  const at = text.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(text[at - 1] ?? '')) return null
  const q = text.slice(at + 1)
  if (/\s/.test(q)) return null
  return { q, at }
}

/**
 * 输入区：选一个成员 + 说一句话（+ `@` 别人一起看）。
 *
 * ## `@` 是**采集**，不是解析（§5.1 的跳 1）
 *
 * 打 `@` 弹成员候选 → 选中即插入人名 → 那个成员进 `mentions`（结构化）。
 * **正文里保留人名的字面文本**（`@Nyx`）—— 用户看到的就是他打的那句，
 * 而 `mentions` 是另一份**结构化**的事实，两者不互相派生。
 *
 * ★ 没有从候选里选中的 `@`（用户手打的）**不会被派发** —— 那是刻意的（§3.1），
 * 但**不能是静默的**：文本里出现了没被选中的 `@` 时，下面会出现一行提示。
 * 一条「我 @ 了他但他没收到」的静默失败，比多一行提示贵得多。
 *
 * ## `cc`（抄送）就在 chip 上切
 *
 * `to` = 派一轮；`cc` = 只把这条消息写进对方会话、**不派轮次**（§5.4）。
 * 语义必须实现（否则就是「界面上标了 cc、实际什么都没发生」），
 * 而它的开关放在 chip 上最省事：点 chip 一次就切换，chip 上直接写着当前是什么。
 *
 * ## 停一轮的那个按钮**不在这里**
 *
 * `turn:stop` 目前只有「排队中」那一条分支能用（§4.3b，运行中的那支是 M9）。
 * 把它摆在这儿，用户点下去会得到一条「停不了」的通知 —— 一个位置摆对的按钮
 * 配一个做不到的动作，比没有这个按钮更让人困惑。轮次在排队的场景在 M6b 的界面上
 * 还看不出来（`runtime.queueDepth` 会显示），到 M9 一起做。
 */
export function Composer({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const members = useStore((s) => s.membersByWorkspace[workspaceId] ?? EMPTY_MEMBERS)
  const sendTurn = useStore((s) => s.sendTurn)

  // 选中的成员 id。`null` = 还没选（默认落到第一个可用的）。
  const [picked, setPicked] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /** 用户从候选里选过的成员。**与正文不是同一份状态**（正文可以被改回）。 */
  const [mentions, setMentions] = useState<Mention[]>([])
  /** 浮层里高亮的那一条。 */
  const [nav, setNav] = useState(0)

  const enabled = members.filter((m) => m.enabled)
  // 选中的那个可能已经被移出空间了（另一个窗口干的）—— 那时候回落到第一个，
  // 而不是拿着一个查不到的 id 去发。**不信任本地状态是这里唯一要做对的事。**
  const selected = enabled.find((m) => m.id === picked) ?? enabled[0] ?? null

  const query = mentionQueryAt(text)
  // 自己不能被 @（主进程会拒，但让它在浮层里出现本身就是个诱饵）。
  const candidates = useMemo(() => {
    if (query === null) return []
    const q = query.q.toLowerCase()
    return enabled.filter(
      (m) => m.id !== selected?.id && (q === '' || m.displayName.toLowerCase().includes(q))
    )
  }, [enabled, query, selected?.id])

  /**
   * 还在正文里的那些 mention。**派生、不另存一份** ——
   * 用户把 `@Nyx` 从正文里删掉之后，那条 chip 就不该还在。
   */
  const live = mentions.filter((m) => {
    const name = members.find((x) => x.id === m.memberId)?.displayName
    return name !== undefined && text.includes(`@${name}`)
  })
  /** 正文里有、但**没被选中过**的 `@`（会被提示出来，见文件头）。 */
  const stray = /(^|\s)@\S/.test(text) && live.length === 0

  function pickCandidate(member: WorkspaceMember, kind: Mention['kind']): void {
    if (query === null) return
    // 把正在打的那截换成完整人名 + 一个空格（好接着打字）。
    setText(`${text.slice(0, query.at)}@${member.displayName} `)
    setMentions((prev) =>
      prev.some((m) => m.memberId === member.id)
        ? prev.map((m) => (m.memberId === member.id ? { ...m, kind } : m))
        : [...prev, { memberId: member.id, kind }]
    )
    setNav(0)
  }

  async function submit(): Promise<void> {
    const body = text.trim()
    if (body === '' || selected === null || busy) return
    setBusy(true)
    // 先清空再等结果：发送失败时消息会以一条通知的形式回来，而输入框里
    // **不该**还留着刚才那段字（用户会以为没发出去、再点一次，于是发两遍）。
    setText('')
    setMentions([])
    const turnId = await sendTurn({
      workspaceId,
      memberId: selected.id,
      text: body,
      // 只用**还在正文里**的那些（用户可能把 @Nyx 删了却没删 chip）。
      mentions: live.map((m) => ({ memberId: m.memberId, kind: m.kind }))
    })
    // 失败时把内容还回去 —— 那段字是用户写的，丢了只能重打。
    if (turnId === null) {
      setText(body)
      setMentions(live)
    }
    setBusy(false)
  }

  return (
    <div className="border-edge bg-abyss/80 shrink-0 border-t px-4 py-3 backdrop-blur">
      <div className="neon-frame bg-panel/60 flex flex-col gap-2 rounded-lg px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-ink-faint shrink-0 text-[11px]">以</span>
          {enabled.length === 0 ? (
            <span className="text-ink-faint text-[11.5px]">
              这个空间还没有启用的成员 —— 先去「成员」里加一个。
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              {enabled.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setPicked(m.id)}
                  className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    m.id === selected?.id
                      ? 'bg-neon-cyan/15 text-neon-cyan'
                      : 'text-ink-faint hover:text-ink-dim'
                  }`}
                >
                  {m.displayName}
                </button>
              ))}
            </div>
          )}
          <span className="text-ink-faint ml-auto shrink-0 text-[10px]">
            的身份发言
          </span>
        </div>

        {live.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-ink-faint text-[10px]">通知</span>
            {live.map((m) => {
              const name = members.find((x) => x.id === m.memberId)?.displayName ?? '?'
              return (
                <button
                  key={m.memberId}
                  // 点一下切换「派发 / 抄送」：派发会让对方跑一轮，抄送只让他看见。
                  title="点一下切换：派发（让他接手）↔ 抄送（只让他看到，不派活）"
                  onClick={() =>
                    setMentions((prev) =>
                      prev.map((x) =>
                        x.memberId === m.memberId
                          ? { ...x, kind: x.kind === 'to' ? 'cc' : 'to' }
                          : x
                      )
                    )
                  }
                  className={`rounded px-1.5 py-0.5 font-mono text-[10.5px] ${
                    m.kind === 'to'
                      ? 'bg-neon-cyan/15 text-neon-cyan'
                      : 'bg-white/5 text-ink-dim'
                  }`}
                >
                  @{name}
                  {m.kind === 'cc' ? '（抄送）' : ''}
                </button>
              )
            })}
          </div>
        )}

        <div className="relative flex items-end gap-2">
          {query !== null && candidates.length > 0 && (
            <div className="border-edge bg-panel absolute bottom-full left-0 mb-1 w-64 rounded-md border shadow-lg">
              {candidates.slice(0, 6).map((m, i) => (
                <button
                  key={m.id}
                  onMouseEnter={() => setNav(i)}
                  onClick={() => pickCandidate(m, 'to')}
                  className={`flex w-full items-center justify-between px-2 py-1 text-left text-[12px] ${
                    i === nav ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-ink-dim'
                  }`}
                >
                  <span className="font-mono">{m.displayName}</span>
                  <span className="text-ink-faint text-[10px]">派发</span>
                </button>
              ))}
              <div className="text-ink-faint border-edge border-t px-2 py-1 text-[10px]">
                Enter 派发 · 选中后点 chip 可改成「抄送」
              </div>
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setNav(0)
            }}
            onKeyDown={(e) => {
              // 浮层开着时方向键与 Enter 归它 —— 否则「Enter 发送」会把一条
              // 半截的 `@Ny` 直接发出去，而用户以为自己在选人。
              if (query !== null && candidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setNav((n) => (n + 1) % Math.min(candidates.length, 6))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setNav((n) => (n - 1 + Math.min(candidates.length, 6)) % Math.min(candidates.length, 6))
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  const chosen = candidates[Math.min(nav, candidates.length - 1)]
                  if (chosen) pickCandidate(chosen, 'to')
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setText((t) => `${t} `)
                  return
                }
              }
              // Enter 发送 / Shift+Enter 换行。发送失败时上面会把内容还回来，
              // 所以这里不必额外保护「发送中不许再按」—— `submit` 自己挡了。
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={2}
            disabled={enabled.length === 0}
            placeholder={
              enabled.length === 0
                ? '先添加一个成员'
                : '说点什么…（Enter 发送，Shift+Enter 换行，@ 叫上别的成员）'
            }
            className="text-ink placeholder:text-ink-faint max-h-40 min-h-[2.5rem] flex-1 resize-y bg-transparent text-[13.5px] outline-none disabled:cursor-not-allowed"
          />
          <button
            onClick={() => void submit()}
            disabled={text.trim() === '' || selected === null || busy}
            className="bg-neon-cyan text-void shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        </div>

        {stray && (
          <p className="text-ink-faint text-[10.5px]">
            正文里的 `@` 不会被派发 —— 打 `@` 之后从上面弹出来的候选里选一个才算数。
          </p>
        )}
      </div>
    </div>
  )
}
