import { createClient, onPush } from '@shared/ipc/client'

/**
 * 渲染进程的 IPC 门面 —— **全仓唯一**的 `window.api` 消费点。
 *
 * 在这里建一次而不是每个组件各建一个：`createClient` 内部缓存了代理对象，
 * 但**跨组件共享同一个门面**才是「依赖数组里的 `api.workspace` 恒等」这件事
 * 真正成立的前提（见 `client.ts` 里的注释）。
 *
 * ⚠️ `window.api` 只有 `invoke` / `on` 两个函数，**没有裸 `ipcRenderer`**（见 `preload/index.ts`）。
 */
export const api = createClient(window.api)

export { onPush }
