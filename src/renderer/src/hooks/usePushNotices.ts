import { useEffect } from 'react'
import { onPush } from '../ipc'
import { useStore } from '../store'

/**
 * 订阅主进程推来的两条**低频道**消息：`app:notice` 与 `workspace:unread`。
 *
 * 另外两条推送（`stream:batch` / `stream:status`）M4 **不订阅** —— 对话在 M6 才有，
 * 而现在 `<App>` 就挂在窗口上，订阅一个 30Hz 的通道只会白白接收空数据。
 * 它们跟着 `live` slice 一起在 M6 落地。
 *
 * ⚠️ `onPush` 返回的退订函数**必须**返回出去：`StrictMode` 下 effect 会跑两遍，
 * 不退订就会在同一个 webContents 上挂两个监听器，于是每条通知出现两次 ——
 * 而且这个错**只在开发模式可见**，最容易一路带进生产。
 */
export function usePushNotices(): void {
  const pushNotice = useStore((s) => s.pushNotice)
  const setUnread = useStore((s) => s.setUnread)

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
      onPush(window.api, 'workspace:unread', (u) => setUnread(u.workspaceId, u.count))
    ]

    return () => {
      for (const off of offs) off()
    }
  }, [pushNotice, setUnread])
}
