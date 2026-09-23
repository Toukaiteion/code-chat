import { useEffect } from 'react'
import { onPush } from '../ipc'
import { useStore } from '../store'

/**
 * 订阅主进程推来的**全部四条**消息（§4.3 的推送白名单，刻意只有四条）。
 *
 * ★ M4 只订阅了其中两条（`app:notice` / `workspace:unread`），文件头当时写着
 *   「另外两条留给 M6」。M6b 让那句话成真 —— 四条齐了，而那条白名单不必再加一条。
 *
 * 分工：
 * - `app:notice` / `workspace:unread` → 两条低频道，直接写进 `ui`；
 * - `stream:batch` → `live.applyBatch`，**30Hz 热路径**，全程同步；
 * - `stream:status` → `live.applyStatus`，兼作 `runtime:getState` 的变更信号（§3.6）。
 *
 * ⚠️ `onPush` 返回的退订函数**必须**返回出去：`StrictMode` 下 effect 会跑两遍，
 * 不退订就会在同一个 webContents 上挂两个监听器，于是每条通知出现两次 ——
 * 而 `stream:batch` 出现两次的后果比「看到两条通知」严重得多：
 * 同一批帧会被折两遍，界面上的正文**逐字重复**一遍。
 * 这个错只在开发模式可见，最容易一路带进生产。
 *
 * ★ 整个应用**只挂这一处**。任何组件自己再订阅一次 `stream:batch` 都会
 * 把上面那个「折两遍」的问题重新引进来，而且只在开发模式下才看得见。
 */
export function usePushNotices(): void {
  const pushNotice = useStore((s) => s.pushNotice)
  const setUnread = useStore((s) => s.setUnread)
  const applyBatch = useStore((s) => s.applyBatch)
  const applyStatus = useStore((s) => s.applyStatus)

  useEffect(() => {
    // zustand 的动作引用是稳定的，所以这个 effect 实际上只跑一次（每轮挂载一次）。
    const offs = [
      onPush(window.api, 'app:notice', (n) => {
        pushNotice({
          level: n.level,
          message: n.message,
          detail: n.detail === undefined ? undefined : String(n.detail)
        })
      }),
      onPush(window.api, 'workspace:unread', (u) => setUnread(u.workspaceId, u.count)),
      onPush(window.api, 'stream:batch', (batch) => applyBatch(batch)),
      onPush(window.api, 'stream:status', (status) => applyStatus(status))
    ]

    return () => {
      for (const off of offs) off()
    }
  }, [pushNotice, setUnread, applyBatch, applyStatus])
}
