import { join } from 'node:path'
import { app } from 'electron'

/**
 * 磁盘位置的**唯一**事实源。
 *
 * ★ 全部走 `app.getPath('userData')` 拼绝对路径 —— **绝不用相对路径或 `__dirname`**：
 * 开发时它们指向仓库，打包后指向 `app.asar` 内部（只读、且随版本被替换）。
 * 两者都是「开发时能用、装完就丢数据」的经典陷阱（§4.2）。
 *
 * ⚠️ 这里是**可移植性**决定，不是安全决定（§8.4 的边界声明）：
 * agent 有 shell，能读到 userData。把 DB 藏在别处在这套架构下做不到
 * —— 我们不假装能解决它。
 */

/** `app.getPath('userData')` 在 app ready 之前调用会抛。所有函数都要求 ready 之后调。 */
function userData(): string {
  return app.getPath('userData')
}

/** `userData/code-chat.db`（§4.2）。 */
export function dbPath(): string {
  return join(userData(), 'code-chat.db')
}

/** `userData/blobs/<workspaceId>/<messageId>.md`（§5.8）。目录本身由写入方按需 `mkdir`。 */
export function blobsRoot(): string {
  return join(userData(), 'blobs')
}

/**
 * ★ §8.3 的 `<workspaceRoot>` —— **M3 刻意留空、M4 定下来的那个决定**。
 *
 * `userData/workspaces/`，与 DB 同一个笼子。备选是 `app.getPath('documents')/code-chat`，
 * 权衡后没选：clone/copy 的默认落点 `<空间>/projects/`（§8.3）里装的是**真实的代码**，
 * 而 `Documents` 下多一棵树会混进用户自己的文档管理（同步盘、备份工具、搜索索引），
 * 且用户对这个应用的预期是「数据都在 AppData 里」——与已经在那里落了户的 DB、blobs 一致。
 *
 * 代价说清楚（**不是安全决定**，§8.4 的边界声明）：
 * 这个位置在资源管理器里默认不可见，所以 UI **必须**显示真实路径，
 * 并提供「在资源管理器中打开」。这不是把东西藏起来当安全措施 ——
 * agent 有 shell，能读到 userData；我们不假装能解决它。
 *
 * ⚠️ 拼空间路径**不要**在这里做 —— 用 `space-dir.ts` 的 `spacePaths()`。
 * 它不 import electron，所以能被测到（净化目录名那段逻辑尤其需要）。
 */
export function workspacesRoot(): string {
  return join(userData(), 'workspaces')
}
