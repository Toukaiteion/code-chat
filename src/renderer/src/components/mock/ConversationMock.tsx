/**
 * **M0 视觉稿，M6 替换为真实流式渲染。**
 *
 * 这个文件里的每一个字都是**假的** —— 消息、工具调用、diff、token 数，全是硬编码。
 * 它从 M0 的 `App.tsx` 原样搬过来，唯一目的是别丢掉那条已经定下来的视觉方向：
 * 推理面板折叠、工具时间线、带描边的角色卡片、打字光标。
 *
 * ★ 为什么留着一份假数据而不是直接删掉：
 *   界面骨架与配色是**唯一**没法靠单测验证的东西，删掉就没有参照物了。
 *   代价是必须**处处标明它是假的** —— 所以 `ConversationMock` 自己带一条横幅，
 *   而不是指望调用它的地方记得说一句。假数据伪装成真数据，比没有界面糟得多。
 */
import { useState } from 'react'

// ── 推理面板（默认折叠，内容为空时显示状态行）──────────────────
function ThinkingPanel(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="border-edge/60 mb-3 border-l-2 pl-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-ink-faint hover:text-ink-dim flex items-center gap-1.5 font-mono text-[11px] transition-colors"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        思考
      </button>
      {open && (
        <p className="text-ink-dim mt-1.5 text-[13px] leading-relaxed italic">
          login.ts 里 token 校验是内联的，应该抽成中间件。先看下调用点……
        </p>
      )}
    </div>
  )
}

// ── 工具调用时间线 ────────────────────────────────────────────
function ToolTimeline(): React.JSX.Element {
  const tools = [
    { ok: true, name: 'Read', arg: 'src/auth/login.ts:1-40' },
    { ok: true, name: 'Edit', arg: 'src/auth/login.ts', delta: '+12 −8' }
  ]
  return (
    <div className="mb-3 flex flex-col gap-1">
      {tools.map((t, i) => (
        <div key={i} className="flex items-center gap-2 font-mono text-[11px]">
          <span className="text-neon-lime">✓</span>
          <span className="text-ink-dim w-10">{t.name}</span>
          <span className="text-ink-faint truncate">{t.arg}</span>
          {t.delta && <span className="text-neon-cyan/70 ml-auto shrink-0">{t.delta}</span>}
        </div>
      ))}
    </div>
  )
}

// ── 文件 diff ─────────────────────────────────────────────────
function DiffBlock(): React.JSX.Element {
  const lines = [
    { t: '-', s: 'const t = decode(req.headers.authorization)' },
    { t: '+', s: 'const t = await verifyToken(req.headers.authorization)' }
  ]
  return (
    <div className="border-edge bg-void/60 mb-3 overflow-hidden rounded-md border font-mono text-[11px]">
      <div className="border-edge text-ink-faint border-b px-3 py-1 text-[10px]">
        src/auth/login.ts
      </div>
      {lines.map((l, i) => (
        <div
          key={i}
          className={`px-3 py-0.5 ${
            l.t === '+' ? 'bg-neon-lime/8 text-neon-lime/90' : 'bg-neon-pink/8 text-neon-pink/80'
          }`}
        >
          <span className="mr-2 opacity-60">{l.t}</span>
          {l.s}
        </div>
      ))}
    </div>
  )
}

// ── 一条角色消息 ─────────────────────────────────────────────
function ActorMessage({
  name,
  hue,
  streaming
}: {
  name: string
  hue: 'cyan' | 'violet'
  streaming?: boolean
}): React.JSX.Element {
  const ring = hue === 'cyan' ? 'var(--color-neon-cyan)' : 'var(--color-neon-violet)'
  return (
    <article className={`neon-frame bg-panel/70 rounded-xl p-4 ${streaming ? 'neon-halo' : ''}`}>
      <div className="mb-3 flex items-center gap-2">
        <span
          className="flex size-6 items-center justify-center rounded-md text-[11px] font-bold"
          style={{ background: `color-mix(in oklab, ${ring} 18%, transparent)`, color: ring }}
        >
          ◈
        </span>
        <span className="text-ink text-[13px] font-semibold">{name}</span>
        {streaming && (
          <span className="text-neon-cyan ml-auto flex items-center gap-1.5 font-mono text-[10px]">
            <span className="neon-halo inline-block size-1.5 rounded-full" />
            推理中
          </span>
        )}
      </div>

      <ThinkingPanel />
      <ToolTimeline />
      <DiffBlock />

      <p className="text-ink text-[13.5px] leading-relaxed">
        已重构 login.ts，抽出 token 校验中间件。
        {streaming ? (
          <span className="typing-cursor" />
        ) : (
          <>
            {' '}
            <span className="text-neon-cyan">@Nyx</span> 请 review 边界情况。
          </>
        )}
      </p>
    </article>
  )
}

function UserMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="border-neon-cyan/30 bg-neon-cyan/8 text-ink max-w-[70%] rounded-xl rounded-br-sm border px-4 py-2.5 text-[13.5px]">
        {text}
      </div>
    </div>
  )
}

/** 折叠起来的假对话。默认收起 —— 没人点开时它不该占着一屏。 */
export function ConversationMock(): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-edge bg-panel/30 rounded-lg border border-dashed">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-ink-faint hover:text-ink-dim flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        看看 M0 的对话视觉稿（<span className="text-neon-pink">假数据</span>，M6 才接真实流式渲染）
      </button>

      {open && (
        <div className="grid-bg flex flex-col gap-4 px-4 pt-1 pb-4">
          <div className="text-ink-faint flex items-center gap-3 font-mono text-[10px]">
            <span className="bg-edge h-px flex-1" />
            切换到 api-server
            <span className="bg-edge h-px flex-1" />
          </div>

          <UserMessage text="把 auth 重构一下" />
          <ActorMessage name="Atlas" hue="cyan" streaming />

          <div className="text-ink-faint flex items-center gap-3 font-mono text-[10px]">
            <span className="bg-edge h-px flex-1" />
            Atlas 已结束本轮
            <span className="bg-edge h-px flex-1" />
          </div>

          <ActorMessage name="Nyx" hue="violet" />

          {/* 输入框也只是样子货 —— 对话要等 M6，这里不许发任何东西。 */}
          <div className="neon-frame bg-panel/60 flex items-center gap-3 rounded-lg px-4 py-3">
            <input
              disabled
              placeholder="对话功能将在 M6 开放"
              className="text-ink placeholder:text-ink-faint flex-1 bg-transparent text-[13.5px] outline-none"
            />
            <span className="border-edge text-ink-faint rounded border px-2 py-0.5 font-mono text-[10px]">
              M6
            </span>
            <button
              disabled
              className="bg-neon-cyan text-void cursor-not-allowed rounded-md px-3 py-1.5 text-xs font-semibold opacity-40"
            >
              发送
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
