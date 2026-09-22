import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// M3 会在这里挂上真正的 IPC 桥（workspace:* / project:* / turn:* / stream:*）。
// M0 只验证 contextBridge 通路是通的。
const api = {}

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
