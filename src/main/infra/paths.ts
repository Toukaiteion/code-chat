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

// ─────────────────────────────────────────────────────────────
// 尚未落地
//
// §8.3 的 `<workspaceRoot>/<空间名>/` 布局里，**`workspaceRoot` 本身在文档里
// 没有定位置**（只写了它下面是 `<空间名>/`）。M3 也不需要它 —— 本里程碑
// 不通文件系统，`project:addLocal` 只校验用户给的那个目录。
//
// 刻意**不**在这里先猜一个（`documents/code-chat` 还是 `userData/workspaces`），
// 因为那会变成一个「设计文档没写、代码里却已经定了」的既成事实，
// 而它关系到用户的文件会不会出现在他预期的位置。留到 M4 的导入流程里定。
// ─────────────────────────────────────────────────────────────
