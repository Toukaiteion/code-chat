import { dialog, shell } from 'electron'
import { workspacesRoot } from '../infra/paths.ts'
import { locateGit } from '../infra/git.ts'
import type { SysCapabilities } from './registry.ts'

/**
 * `SysCapabilities` 的**真实**实现 —— 本层里**唯一**一个（除传输层外）import electron
 * 的 IPC 文件。
 *
 * 为什么值得单独一个文件：`registry.ts` 有一条极重要的不变量 ——
 * **它不 import electron**。靠这条，`test/ipc/` 才能把整条 IPC 路径
 * （校验 → 分发 → 信封）在裸 Node 下跑完，不用起 Electron、不用点原生对话框。
 * 原生对话框与 `shell` 会打破它，所以它们被关在这一个文件里，
 * 以**注入**的方式交到 handler 手上（与 `now` / `newId` 完全同一套手法）。
 *
 * ⚠️ 关于 `revealPath` 的能力边界，说实话：
 * 它让渲染进程能要求主进程**打开磁盘上任意一个路径**。这不是新的攻击面 ——
 * 渲染进程是我们自己的代码（agent 是另一个进程，够不着 IPC），
 * 而且渲染层本来就能调 `project:addLocal` 去读任意目录。但这句话必须写在这里，
 * 免得日后有人以为这是一道被守住的闸门。
 */
export function createSystemCapabilities(): SysCapabilities {
  return {
    async pickPath(opts) {
      const result = await dialog.showOpenDialog({
        title: opts.title,
        defaultPath: opts.defaultPath,
        properties: [
          opts.mode === 'directory' ? 'openDirectory' : 'openFile',
          // 不污染「最近使用」列表：我们选的是项目目录，不是文档。
          'dontAddToRecent'
        ]
      })
      // 用户取消是**正常结果**，不是错误 —— 返回 null，由上层翻成 `{ path: null }`。
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0] ?? null
    },

    async revealPath(path) {
      // `openPath` 而不是 `showItemInFolder`：我们要的是**打开这个目录**，
      // 不是在资源管理器里选中它。对目录而言前者才是「进去看看」。
      // 成功时返回空字符串，失败时返回一句错误描述 —— 判空即可。
      const err = await shell.openPath(path)
      return err === ''
    },

    workspacesRoot,

    locateGit
  }
}
