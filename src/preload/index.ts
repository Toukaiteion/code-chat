import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { INVOKE_CHANNELS, PUSH_CHANNELS } from '../shared/ipc/channels.ts'
import type { RawBridge } from '../shared/ipc/client.ts'

/**
 * 渲染进程唯一的对外窗口。
 *
 * ★ 纪律：**绝不暴露裸 `ipcRenderer`**。一旦暴露，渲染层（以及任何注入到页面里的
 * 第三方脚本）就能对任意通道发任意载荷，`channels.ts` 那份契约就成了一张废纸。
 *
 * 白名单**从 `channels.ts` 派生**，不是手写的一份副本 —— 单一事实源，
 * 所以 preload 与主进程的通道清单**不可能**分叉。
 */
const INVOKE_SET = new Set<string>(INVOKE_CHANNELS)
const PUSH_SET = new Set<string>(PUSH_CHANNELS)

/** 退订时把包装过的监听器换成原始的那个，否则 `removeListener` 找不到它。 */
const listeners = new Map<Function, (_e: unknown, payload: unknown) => void>()

const api: RawBridge = {
  async invoke(channel, payload) {
    if (!INVOKE_SET.has(channel)) {
      // 这里**不抛异常**，而是回一个失败信封 —— 契约里每一个 invoke 都返回信封，
      // 破了这条会让渲染层的 `unwrap` 拿到一个裸 rejection，处理方式与其它通道全不一样。
      return {
        ok: false,
        error: {
          code: 'E_INVALID_PAYLOAD',
          message: `未知的 IPC 通道：${channel}`,
          detail: { channel }
        }
      }
    }
    return ipcRenderer.invoke(channel, payload)
  },

  on(channel, listener) {
    if (!PUSH_SET.has(channel)) {
      console.error(`[preload] 拒绝订阅未知的推送通道：${channel}`)
      return () => {}
    }

    const wrapped = (_e: unknown, payload: unknown): void => listener(payload)
    listeners.set(listener, wrapped)
    ipcRenderer.on(channel, wrapped)

    return () => {
      const w = listeners.get(listener)
      if (w) {
        ipcRenderer.removeListener(channel, w)
        listeners.delete(listener)
      }
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] contextBridge 暴露失败', error)
  }
} else {
  // @ts-expect-error contextIsolation 关闭时的降级路径
  window.electron = electronAPI
  // @ts-expect-error 同上
  window.api = api
}
