import { chmod, cp, readdir, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { COPY_SKIP_DIRS } from '../../shared/copy-policy.ts'

/**
 * 文件系统操作 —— 复制、探测、删除，以及**路径包含关系**这类纯判断。
 *
 * 不 import electron（所以测试进得来），也不认识上层的错误语义
 * （抛原生错误，由 handler 翻译成人话）—— 与 `git.ts` 同一套分界线。
 *
 * 这个文件里几乎每一段都在处理**同一个主题**：我们删的不是自己的临时文件，
 * 而是用户磁盘上的真实目录。所以：
 *
 * - 删除**从不假装成功**：删不掉要带回原因，而不是回一个 `true`；
 * - 「本来就不在」与「我们删掉了」是两件事，调用方必须能分辨（见 `removeQuietly`）；
 * - 一切都**大小写不敏感**地比较路径 —— 这是 Windows，`C:\Work` 与 `c:\work` 是同一个地方。
 */

// ─────────────────────────────────────────────────────────────
// 路径判断（纯字符串，不碰磁盘）
// ─────────────────────────────────────────────────────────────

/**
 * 归一化成可比较的形状：绝对化 + 平台相关的大小写折叠。
 *
 * ⚠️ **不解析软链接**。这意味着「同一个目录的两个链接路径」在下面会被判成不相干。
 * 这是有意接受的：解析软链接要碰磁盘（于是这些函数不再是纯的、也不再能在断言里
 * 随手调用），而且真实的误删场景是**前缀包含**（把 `C:\work` 当成 `C:\work\proj`
 * 的上级删掉），不是链接。
 */
function norm(p: string): string {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** 同一个路径（大小写不敏感）。 */
export function isSamePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

/**
 * `child` 是否在 `parent` **里面**（严格：相等不算）。
 *
 * 末尾补分隔符再比前缀，否则 `C:\work` 会「包含」`C:\workshop` —— 少一个分隔符
 * 就是删错一个目录。
 */
export function isPathInside(parent: string, child: string): boolean {
  const p = norm(parent)
  const c = norm(child)
  if (p === c) return false
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 盘根（`C:\`、`/`）。删这个等于格式化磁盘，任何删除路径上都该被拦下。 */
export function isFilesystemRoot(p: string): boolean {
  const r = resolve(p)
  return parse(r).root === r
}

/** `refuseRemoval` 需要知道的「哪些地方绝对不许删」。 */
export interface RemovalScope {
  /** `<workspaceRoot>`，即 `userData/workspaces`。 */
  root: string
  /** 本空间自己的目录。行不存在时传 `null`。 */
  wsDir: string | null
  /** **全库**所有 `origin='local'` 项目的根目录（见 `project-repo.localRootPaths`）。 */
  localRoots: readonly string[]
}

/**
 * 判断一个目录**不许删**的理由。返回 `null` 表示可以删。
 *
 * ★ 这道闸存在的意义：要删的路径来自数据库里的一行，而**一行被改坏的记录
 * 就能让我们去 `rm -rf` 一个完全不相干的地方**。所以每一次都重新证明一遍
 * 「这确实是我们自己造出来的那种东西」。
 *
 * 最要紧的是最后一条：待删目录**包含任何一个 `origin='local'` 项目的目录**时拒绝。
 * 那是「删空间时顺带清副本」把用户真实源码删掉的最短路径。
 *
 * ⚠️ 只看「包含」方向（等于 / 是它的上级），**不看「在它里面」** ——
 * `<空间>/projects/<项目>` 正当且必然在空间目录里，那是默认落点。
 */
export function refuseRemoval(target: string, scope: RemovalScope): string | null {
  if (!isAbsolute(target)) return '不是绝对路径，拒绝删除'
  if (isFilesystemRoot(target)) return '这是一个盘根，拒绝删除'

  if (isSamePath(target, scope.root) || isPathInside(target, scope.root)) {
    return '这个路径包含工作空间根目录，拒绝删除'
  }
  if (
    scope.wsDir !== null &&
    (isSamePath(target, scope.wsDir) || isPathInside(target, scope.wsDir))
  ) {
    return '这个路径包含空间目录本身，拒绝删除'
  }

  for (const local of scope.localRoots) {
    if (isSamePath(target, local)) {
      return `这个路径是一个「原地引用」项目的目录（${local}），拒绝删除`
    }
    if (isPathInside(target, local)) {
      return `这个路径包含了原地引用项目的目录（${local}），拒绝删除`
    }
  }

  return null
}

// ─────────────────────────────────────────────────────────────
// 探测
// ─────────────────────────────────────────────────────────────

export interface PathState {
  exists: boolean
  isDirectory: boolean
  /**
   * 目录存在且**没有任何条目**。`exists === false` 时恒为 `false`。
   *
   * 只用于「能不能往这儿放东西」这一个判断 —— 不递归、不看权限。
   */
  isEmpty: boolean
}

export async function pathState(p: string): Promise<PathState> {
  try {
    const info = await stat(p)
    if (!info.isDirectory()) return { exists: true, isDirectory: false, isEmpty: false }
    const entries = await readdir(p)
    return { exists: true, isDirectory: true, isEmpty: entries.length === 0 }
  } catch {
    // 权限不足（EACCES）与不存在在这里合并处理：对调用方而言，
    // 「读不到、看不见」与「没有」在**能否往里放**这件事上没有区别，
    // 而两者的区分在真正动手时的报错里会出现。不要在这里编一个更细的结论。
    return { exists: false, isDirectory: false, isEmpty: false }
  }
}

// ─────────────────────────────────────────────────────────────
// 复制
// ─────────────────────────────────────────────────────────────

/**
 * 复制时跳过的目录名（**按 basename 匹配，任意深度**）。
 *
 * ★ 定义搬去了 `shared/copy-policy.ts`：**渲染进程必须显示这张清单**，
 *   而它 import 不了 `src/main/**`。这里保留同名再导出，让主进程侧
 *   （以及 `test/ipc/import.test.ts`）的既有引用继续有效，事实源仍然只有一份。
 */
export { COPY_SKIP_DIRS }

export function isSkippedDirName(name: string): boolean {
  return COPY_SKIP_DIRS.includes(name)
}

/**
 * 整树复制。**调用方必须先保证 `target` 不存在或为空** ——
 * `fs.cp` 对非空目标会静默合并，而「合并」不是用户要的（他要的是一个干净的副本）。
 * 那句人话由 handler 说（`E_CONFLICT`），这里不做重复判断。
 *
 * 不返回统计：M4 **没有进度、不能取消**（§8.2 的边界），一个「复制了多少个文件」
 * 的数字既不能中断操作也不能预估剩余时间，只会变成另一个会过期的说法。
 */
export async function copyTree(opts: { source: string; target: string }): Promise<void> {
  const sourceAbs = resolve(opts.source)

  await cp(sourceAbs, opts.target, {
    recursive: true,
    force: true,
    // 目标已由调用方确认为空/不存在，所以「撞上已存在的文件」只能是并发写入，
    // 那时报错比覆盖更诚实。
    errorOnExist: true,
    filter: async (src) => {
      // 根目录自己**永远不跳**：用户完全可以把一个叫 `dist` 的目录当源来导入，
      // 那时按名字跳过根等于复制出一个空目录 —— 一个安静得可怕的失败。
      if (isSamePath(src, sourceAbs)) return true
      if (!isSkippedDirName(basename(src))) return true

      // ★ 名字在清单里，还要**确认它是目录**才跳。
      //   `build` 同样可以是用户写的一个脚本，静默丢掉它是数据丢失。
      try {
        return !(await stat(src)).isDirectory()
      } catch {
        // stat 失败就照拷，让 `cp` 自己去报错 —— 在这里猜一个结论只会掩盖真正的原因。
        return true
      }
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 删除
// ─────────────────────────────────────────────────────────────

export interface RemoveResult {
  removed: boolean
  /** 没删掉的原因（人话）。`removed === true` 时为 `null`。 */
  reason: string | null
}

/**
 * 尽力删掉一棵树。**永远不抛** —— 删不掉是一种要如实上报的结果，不是异常。
 *
 * ⚠️ 调用方要先自己判断「它本来就在不在」（用 `pathState`）：这里带 `force: true`，
 * 目标是**不存在**时会直接算成功（`force` 会吞掉 ENOENT）。于是
 * `removed === true` 的真实含义是「**现在它不在了**」——
 * 想区分「我们删的」与「本来就不在」，就得先探一次。这不是含糊，是刻意的：
 * 让 ENOENT 变成错误，会让「清理一个已经被删掉的目录」这条正常路径失败。
 *
 * ★ Windows 上的一次额外尝试：`EPERM` 最常见的原因**不是权限**，而是
 * **只读属性** —— 而 git 的 pack/object 文件天然带只读位。也就是说，
 * 我们最常删的恰好就是最容易被这个属性绊住的东西（clone 出来的仓库）。
 * 所以撞上 EPERM/EACCES 时，先把整棵树的只读位清掉再删一次。
 * （Windows 上 `chmod` 只切换只读属性，不影响 ACL —— 正是这里需要的那个语义。）
 */
export async function removeQuietly(p: string): Promise<RemoveResult> {
  try {
    await rmWithRetries(p)
    return { removed: true, reason: null }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      await clearReadOnly(p)
      try {
        await rmWithRetries(p)
        return { removed: true, reason: null }
      } catch (err2) {
        return { removed: false, reason: describeFsError(err2) }
      }
    }
    return { removed: false, reason: describeFsError(err) }
  }
}

/** `maxRetries` 是给 Windows 的：杀毒软件与索引器会短暂占用刚写出来的文件。 */
async function rmWithRetries(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/**
 * 递归清掉只读位。单个条目失败**不中断** —— 目的是「多救回来一些」，
 * 不是「精确报告哪一项没清掉」（真删不掉时外层会把原因报出来）。
 */
async function clearReadOnly(dir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        await chmod(child, 0o700)
        await clearReadOnly(child)
      } else {
        await chmod(child, 0o600)
      }
    } catch {
      // 单个条目失败就跳过：它是「没救回来的一条」，不是「整棵放弃」的理由。
    }
  }
  try {
    await chmod(dir, 0o700)
  } catch {
    // 同上。
  }
}

/** 把原生错误拼成一句能直接放进 `reason` 的人话。 */
export function describeFsError(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  const code = e?.code
  const message = e?.message ?? String(err)
  return code ? `${code}：${message}` : message
}
