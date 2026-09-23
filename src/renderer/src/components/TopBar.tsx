import { useEffect } from 'react'
import type { Project } from '@shared/entities'
import { useStore } from '../store'
import { Button } from './ui/Button'

const EMPTY_PROJECTS: Project[] = []

/**
 * 顶栏。
 *
 * ★ 「当前项目」这个切换器接的是 **`workspace:setActive`**，不是 `project:setActive`
 *   —— 通道清单里**没有**后者（§4.3）。因为「当前项目」不是项目自己的属性，
 *   而是**空间**的属性（`workspace.active_project_id`），它是 cwd 的二级兜底（§8.5b）。
 *   这个区别在界面上体现为：切换它是在改这个空间的状态，不是在改项目。
 *
 * ★ 右上角那一排数字都是**真的**：来自 `runtime:getState` 与 `workspace:usage`。
 *   M0 那版摆的是编出来的累计 token / 估算金额 / 缓存命中率 —— 它们看起来最像
 *   「产品」，也最容易让人以为系统已经在跑。
 *
 * ★ **成本那个数必须标「估算」（§2.4-2）。** 走第三方端点时 `result.total_cost_usd`
 *   的数值是错的，我们现在显示的是**按 Anthropic 官方价目算出来的**估值，
 *   不是账单。措辞上写「估算」而不是「花费」，`title` 里把口径说全 ——
 *   一个看起来像账单的数字会被当成账单用。
 */
export function TopBar({
  workspaceId,
  onManage
}: {
  workspaceId: string
  onManage: () => void
}): React.JSX.Element {
  const ws = useStore((s) => s.workspaces[workspaceId] ?? null)
  const projects = useStore((s) => s.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS)
  const setActiveProject = useStore((s) => s.setActiveProject)
  const runtime = useStore((s) => s.runtime)
  const loadRuntime = useStore((s) => s.loadRuntime)
  const usage = useStore((s) => s.usage)
  const loadUsage = useStore((s) => s.loadUsage)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)

  // 只读、幂等 —— StrictMode 跑两遍无害。
  useEffect(() => {
    void loadRuntime()
  }, [loadRuntime])

  /**
   * 用量随空间走。
   *
   * ★ 在**这里**读，而不是跟 `openConversation` 一起只在对话视图里读：
   *   概览页也该看得见它（§5.4 修正条第 2 款要的是「常驻显示」）。
   *   每轮终态后 `live.applyStatus` 会再刷一次（§6.2 的刷新时机就这两处，不加定时器）。
   */
  useEffect(() => {
    void loadUsage(workspaceId)
  }, [workspaceId, loadUsage])

  const activeId = ws?.activeProjectId ?? null

  return (
    <header className="border-edge bg-abyss/80 flex h-14 shrink-0 items-center gap-4 border-b px-5 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-ink text-sm font-semibold">{ws?.name ?? '—'}</span>
        <span className="bg-edge h-4 w-px" />
        <span className="text-ink-faint shrink-0 text-xs">当前项目</span>
        <div className="border-edge bg-panel flex min-w-0 items-center gap-1 overflow-x-auto rounded-md border p-0.5">
          <button
            onClick={() => void setActiveProject(workspaceId, null)}
            className={`shrink-0 rounded px-2.5 py-1 font-mono text-xs transition-colors ${
              activeId === null ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-ink-faint hover:text-ink-dim'
            }`}
            title="不指定：cwd 会退到空间目录（§8.5b 的二级兜底）"
          >
            未指定
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => void setActiveProject(workspaceId, p.id)}
              className={`shrink-0 rounded px-2.5 py-1 font-mono text-xs transition-colors ${
                p.id === activeId ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-ink-faint hover:text-ink-dim'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-4 font-mono text-[11px]">
        {/* 概览 / 对话。**空间级**的两屏 —— 对话流是整个空间的时间线，
            不是任何一个成员或项目的属性，所以它的开关在这里而不在详情面板里。 */}
        <div className="border-edge bg-panel flex items-center gap-0.5 rounded-md border p-0.5">
          {(
            [
              ['overview', '概览'],
              ['conversation', '对话']
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${
                view === v ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-ink-faint hover:text-ink-dim'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {runtime === null ? (
          <span className="text-ink-faint">运行状态读取中…</span>
        ) : (
          <>
            <span className="text-ink-faint">
              运行中 <span className="text-neon-lime">{runtime.slots.used}</span>
              <span className="text-ink-faint">/{runtime.slots.total}</span>
            </span>
            <span className="text-ink-faint">
              队列 <span className="text-neon-lime">{runtime.queueDepth}</span>
            </span>
          </>
        )}

        {/*
          ★ 累计成本。§5.4 修正条第 2 款要的是「从第一天起常驻显示」——
            可见的运行时成本是防失控链最便宜的护栏，所以它在**每一屏**上都在。

          ★ 标签是「估算」不是「花费」（§2.4-2）：这个数按 Anthropic 官方价目算，
            不代表实际账单，而在第三方端点上 `total_cost_usd` 本身就是错的。
            `title` 里把口径说全，因为一个看起来像账单的数字会被当成账单用。

          ★ `turnsWithoutUsage` 非零时**必须**露出来：`SUM` 会安静地跳过 NULL 的轮次
            （失败 / 被中断 / 进程被杀的那些），于是这个数字**偏低**而用户无从知道
            （§4.6a 规则二的另一面：空缺不许冒充成 0）。
        */}
        {usage === null ? (
          <span className="text-ink-faint">用量读取中…</span>
        ) : (
          <span
            className="text-ink-faint"
            title={
              `按 Anthropic 官方价目算出的估算值，不是实际账单。\n` +
              `累计 ${usage.turnCount} 轮：入 ${usage.tokensIn} / 出 ${usage.tokensOut} token。` +
              (usage.turnsWithoutUsage > 0
                ? `\n⚠️ 另有 ${usage.turnsWithoutUsage} 轮没有用量数据（失败、被中断或进程被杀），` +
                  `所以这个数**偏低**。`
                : '')
            }
          >
            估算 <span className="text-neon-cyan">${usage.costUsd.toFixed(4)}</span>
            {usage.turnsWithoutUsage > 0 && (
              // 不是装饰：它在说「上面这个数不完整」。没有它，用户会把一个偏低的数字当成全部。
              <span className="text-neon-pink/80"> ⚠{usage.turnsWithoutUsage}</span>
            )}
          </span>
        )}

        <Button size="sm" onClick={onManage} title="重命名 / 删除 / 看空间目录">
          设置
        </Button>
      </div>
    </header>
  )
}
