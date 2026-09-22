import { useEffect, useState } from 'react'
import { api, onPush } from './ipc'
import { IpcError } from '@shared/ipc/envelope'

/**
 * M3 验收自检。**不是功能**，是「桥到底通没通」的一次性探针，
 * M4 起真实界面接手后连同这个组件一起删掉。
 *
 * 三条探针各自证明一件事：
 *
 * 1. `workspace:list` → **真数据**（M3 的验收标准：空库应为 `[]`）
 * 2. 不存在的 id → **失败信封被翻译成 `IpcError`**，而不是让界面崩掉
 * 3. `project:clone` → **未实现通道返回带里程碑号的明确报错**，
 *    而不是 Electron 那句含糊的 `No handler registered`
 *    —— 这条正是「不填桩」那个决定的可验证后果
 */

interface Probe {
  label: string
  result: string
  ok: boolean
}

async function probe(label: string, fn: () => Promise<string>): Promise<Probe> {
  try {
    return { label, result: await fn(), ok: true }
  } catch (err) {
    if (err instanceof IpcError) {
      return { label, result: `${err.code}：${err.message}`, ok: false }
    }
    return { label, result: `非 IPC 错误：${String(err)}`, ok: false }
  }
}

export function IpcSelfCheck(): React.JSX.Element {
  const [probes, setProbes] = useState<Probe[]>([])

  useEffect(() => {
    let alive = true

    void (async () => {
      const results = await Promise.all([
        probe('workspace:list', async () => {
          const spaces = await api.workspace.list()
          // ★ M3 的验收标准就是这一行：空库 → []。
          console.log(`workspace:list → ${JSON.stringify(spaces)}`)
          return `${spaces.length} 个工作空间`
        }),

        probe('workspace:update(不存在)', async () => {
          const w = await api.workspace.update({ id: 'no-such-workspace', name: 'x' })
          return `意外成功了：${w.id}`
        }),

        probe('project:clone', async () => {
          const p = await api.project.clone({
            workspaceId: 'no-such-workspace',
            name: 'x',
            remoteUrl: 'https://example.com/x.git',
            targetPath: 'G:/tmp/x'
          })
          return `意外成功了：${p.id}`
        })
      ])

      if (alive) setProbes(results)

      // 白名单的实证：这里应该只有 ['invoke', 'on']，**没有 ipcRenderer**。
      console.log('[ipc 自检] window.api 的键：', Object.keys(window.api ?? {}))
    })()

    // 启动期通知（例如「数据库打不开」）走这条通道。
    const off = onPush(window.api, 'app:notice', (n) => {
      console[n.level === 'error' ? 'error' : 'log'](`[app:${n.level}] ${n.message}`, n.detail ?? '')
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <div className="border-edge bg-panel/60 rounded-md border px-3 py-2 font-mono text-[10px]">
      <div className="text-ink-faint mb-1">M3 IPC 自检</div>
      {probes.length === 0 ? (
        <div className="text-ink-faint">探测中…</div>
      ) : (
        probes.map((p) => (
          <div key={p.label} className="flex gap-2">
            <span className={p.ok ? 'text-neon-lime' : 'text-neon-pink'}>{p.ok ? '✓' : '✗'}</span>
            <span className="text-ink-dim shrink-0">{p.label}</span>
            <span className="text-ink-faint truncate">{p.result}</span>
          </div>
        ))
      )}
    </div>
  )
}
