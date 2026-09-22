/**
 * `m3-ipc-error-probe.cjs` 的 preload。
 * 只暴露一个 `invoke`，**绝不暴露裸 ipcRenderer** —— 与 `src/preload/index.ts` 同一条纪律，
 * 顺手也验证了 contextBridge 下 `ipcRenderer.invoke` 的异常行为。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('probe', {
  invoke: (channel) => ipcRenderer.invoke(channel)
})
