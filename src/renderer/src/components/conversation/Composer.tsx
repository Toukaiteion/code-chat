import { useState } from 'react'
import type { WorkspaceMember } from '@shared/entities'
import { useStore } from '../../store'

const EMPTY_MEMBERS: WorkspaceMember[] = []

/**
 * 输入区：选一个成员 + 说一句话。
 *
 * ## ★ 成员是**选**出来的，不是从文本里解析出来的
 *
 * M0 的视觉稿里写着「@Nyx 请 review 边界情况」，很容易让人以为输入框应该解析 `@`。
 * **不做，那是 M7**（§3.1：结构化 mention，运行时**永不解析文本**）。
 * 在那之前，成员用一个选择器指定，`turn:send` 的 `mentions` 一律不带。
 *
 * 这条不是省事：解析 `@` 会引入一整类「名字里有空格」「改完名旧消息里的 @ 指向谁」
 * 的问题，而它们的正确答案都要求 mention 在**写入时**就结构化 —— 也就是 M7 要做的。
 * 现在先解析一遍，等于把那个坑挖好再填。
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

  const enabled = members.filter((m) => m.enabled)
  // 选中的那个可能已经被移出空间了（另一个窗口干的）—— 那时候回落到第一个，
  // 而不是拿着一个查不到的 id 去发。**不信任本地状态是这里唯一要做对的事。**
  const selected = enabled.find((m) => m.id === picked) ?? enabled[0] ?? null

  async function submit(): Promise<void> {
    const body = text.trim()
    if (body === '' || selected === null || busy) return
    setBusy(true)
    // 先清空再等结果：发送失败时消息会以一条通知的形式回来，而输入框里
    // **不该**还留着刚才那段字（用户会以为没发出去、再点一次，于是发两遍）。
    setText('')
    const turnId = await sendTurn({ workspaceId, memberId: selected.id, text: body })
    // 失败时把内容还回去 —— 那段字是用户写的，丢了只能重打。
    if (turnId === null) setText(body)
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

        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
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
              enabled.length === 0 ? '先添加一个成员' : '说点什么…（Enter 发送，Shift+Enter 换行）'
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
      </div>
    </div>
  )
}
