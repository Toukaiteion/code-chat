/**
 * M0 外壳 —— 只验证「窗口能开 + 视觉方向对不对」。
 * 这里的消息全部是 mock 数据；M6 会替换为真实的 IPC 流式渲染。
 *
 * M3 起左下角多了一个 `IpcSelfCheck`：那是**桥**的探针，不是界面的一部分，
 * 它证明 IPC 通路真的通了（验收标准见 `docs/design.md` §六 M3 行）。
 */
import { useState } from 'react'
import { IpcSelfCheck } from './IpcSelfCheck'

// ── 侧边栏：工作空间列表 ──────────────────────────────────────
function WorkspaceList({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  const spaces = [
    { id: 'nova', name: 'Nova', unread: 0 },
    { id: 'orion', name: 'Orion', unread: 3 }
  ]

  return (
    <aside className="border-edge bg-abyss flex w-60 shrink-0 flex-col border-r">
      <div className="border-edge flex h-14 items-center gap-2 border-b px-4">
        <span className="bg-neon-cyan shadow-neon-cyan size-2 rounded-full shadow-[0_0_10px_var(--color-neon-cyan)]" />
        <span className="text-ink text-sm font-semibold tracking-wide">CODE CHAT</span>
      </div>

      <div className="px-3 py-3">
        <p className="text-ink-faint mb-2 px-1 font-mono text-[10px] tracking-widest uppercase">
          工作空间
        </p>
        <div className="flex flex-col gap-1">
          {spaces.map((s) => {
            const on = s.id === activeId
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`group relative flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  on
                    ? 'bg-panel-2 text-ink'
                    : 'text-ink-dim hover:bg-panel hover:text-ink'
                }`}
              >
                {on && (
                  <span className="bg-neon-cyan absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-r" />
                )}
                <span className="font-medium">{s.name}</span>
                {s.unread > 0 && (
                  <span className="bg-neon-violet text-void rounded-full px-1.5 py-px font-mono text-[10px] font-bold">
                    {s.unread}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <button className="border-edge text-ink-faint hover:border-edge-bright hover:text-ink-dim mt-2 w-full rounded-md border border-dashed px-3 py-2 text-xs transition-colors">
          + 新建工作空间
        </button>
      </div>

      <div className="mt-auto flex flex-col gap-2 p-3">
        <IpcSelfCheck />
        <div className="border-edge bg-panel text-ink-faint rounded-md border px-3 py-2 font-mono text-[10px]">
          M0 外壳 · 视觉验证
        </div>
      </div>
    </aside>
  )
}

// ── 顶部：活跃项目切换器 ──────────────────────────────────────
function TopBar() {
  const projects = ['api-server', 'web-console']
  const [active, setActive] = useState(projects[0])

  return (
    <header className="border-edge bg-abyss/80 flex h-14 shrink-0 items-center gap-4 border-b px-5 backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="text-ink-faint text-xs">当前项目</span>
        <div className="border-edge bg-panel flex items-center gap-1 rounded-md border p-0.5">
          {projects.map((p) => (
            <button
              key={p}
              onClick={() => setActive(p)}
              className={`rounded px-2.5 py-1 font-mono text-xs transition-colors ${
                p === active
                  ? 'bg-neon-cyan/15 text-neon-cyan'
                  : 'text-ink-faint hover:text-ink-dim'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-4 font-mono text-[11px]">
        <span className="text-ink-faint">
          累计 <span className="text-neon-lime">42.1k</span> tok
        </span>
        <span className="text-ink-faint">
          估算 <span className="text-neon-lime">$0.38</span>
        </span>
        <span className="text-ink-faint">
          缓存命中 <span className="text-neon-cyan">67%</span>
        </span>
      </div>
    </header>
  )
}

// ── 推理面板（默认折叠，内容为空时显示状态行）──────────────────
function ThinkingPanel() {
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
function ToolTimeline() {
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
function DiffBlock() {
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
}) {
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

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="border-neon-cyan/30 bg-neon-cyan/8 text-ink max-w-[70%] rounded-xl rounded-br-sm border px-4 py-2.5 text-[13.5px]">
        {text}
      </div>
    </div>
  )
}

// ── 主壳 ─────────────────────────────────────────────────────
export default function App() {
  const [active, setActive] = useState('nova')

  return (
    <div className="bg-void text-ink flex h-screen">
      <WorkspaceList activeId={active} onSelect={setActive} />

      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar />

        <div className="grid-bg flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
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
          </div>
        </div>

        {/* 输入区 */}
        <div className="border-edge bg-abyss/80 shrink-0 border-t px-6 py-4 backdrop-blur">
          <div className="neon-frame bg-panel/60 mx-auto flex max-w-3xl items-center gap-3 rounded-lg px-4 py-3">
            <input
              placeholder="发消息，或 @ 某个角色…"
              className="text-ink placeholder:text-ink-faint flex-1 bg-transparent text-[13.5px] outline-none"
            />
            <span className="border-edge text-ink-faint rounded border px-2 py-0.5 font-mono text-[10px]">
              @ 提及
            </span>
            <button className="bg-neon-cyan text-void rounded-md px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-85">
              发送
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
