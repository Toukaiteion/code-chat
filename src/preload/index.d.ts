import type { ElectronAPI } from '@electron-toolkit/preload'
import type { RawBridge } from '../shared/ipc/client.ts'

/**
 * ★ 渲染进程**只能看到这个文件**里的 `window.api`。
 *
 * 它是 `RawBridge`（两个泛型函数），**不是** `Api`（那套 `api.workspace.list()`
 * 的门面）。门面由渲染侧 `createClient(window.api)` 自己造一次 ——
 * 因为门面的类型推导依赖 `contract.ts`，把它写进这里等于让 preload 的
 * 声明文件承担整个契约的表面积。
 *
 * 这样安排还有个好处：渲染侧拿到的是 `Promise<Res>` + 失败抛 `IpcError`，
 * 而桥本身保持「窄」—— 一个只有两个方法的边界比一个 44 个方法的边界好审得多。
 */
declare global {
  interface Window {
    electron: ElectronAPI
    api: RawBridge
  }
}

export {}
