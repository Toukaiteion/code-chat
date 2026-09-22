import { BrowserWindow, ipcMain } from 'electron'
import { ALL_CHANNELS } from '../../shared/ipc/channels.ts'
import type { IpcTransport } from './transport.ts'

/**
 * `IpcTransport` 的 Electron 实现 —— **全仓唯一 import electron 的 IPC 文件**
 * （`context.ts` 只 import `node:crypto`，`registry.ts` 谁也不 import）。
 * 这条纪律换来的是：校验、信封、错误映射、未实现通道的处理全部能在裸 Node 下单测。
 */
export function createElectronTransport(): IpcTransport {
  return {
    handle(channel, listener) {
      // 不用 `event.sender` 做任何授权判断 —— 窗口是我们自己开的，
      // 且 `view:setActive` 之类的状态本来就允许渲染层写。
      // 通道白名单在 preload 侧收口（`channels.ts` 派生），这里不做二次限制。
      ipcMain.handle(channel, (_event, payload: unknown) => listener(payload))
    },

    /**
     * M3 是**广播**到所有窗口。跨空间抑制（§4.3：非活跃空间的批次直接丢弃）
     * 属于 M6 的 event-batcher，届时这里收窄到具体 `webContents`。
     *
     * `isDestroyed()` 检查是必须的：窗口关闭与推送之间存在真实的竞态，
     * 往已销毁的 webContents 发送会抛 `Object has been destroyed`。
     */
    send(channel, payload) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      }
    },

    dispose() {
      // 退出时不 removeHandler 也不影响进程消亡，但测试里会重复建 registry，
      // 留着这个钩子免得测试之间互相串台。
      for (const channel of ALL_CHANNELS) ipcMain.removeHandler(channel)
    }
  }
}
