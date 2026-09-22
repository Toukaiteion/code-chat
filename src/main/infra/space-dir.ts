import { join } from 'node:path'

/**
 * 空间目录的**命名与布局**（§8.3）—— 纯函数，**刻意不 import electron**。
 *
 * 为什么单独一个模块：`paths.ts` import 了 electron，所以**测试 import 不了它**
 * （`npm test` 走裸 Node）。而「空间名 → 目录名」正是最该被穷举测试的一段逻辑
 * ——Windows 的非法字符、保留名、大小写不敏感、尾部点……每一条都能安静地坑用户。
 * 所以根目录由调用方传进来（生产环境来自 `paths.ts`，测试里来自临时目录），
 * 这里只做纯粹的字符串与路径运算。
 *
 * ⚠️ **目录名一旦定下就不再改**。`workspace:update` 改名**不动磁盘**，三条理由：
 *
 * 1. `<空间>/projects/` 是 clone/copy 的默认落点（§8.3），移动空间目录会让那些项目
 *    记在 DB 里的绝对 `root_path` **全部失效**；
 * 2. M5 起 agent 的 cwd 就落在这些目录里，而 **Windows 拒绝重命名被进程占用的目录**；
 * 3. 半途失败的 rename 会让 DB 与磁盘不一致（而且没法回滚磁盘那一步）。
 *
 * 所以 UI 上必须显示真实的目录路径 —— 不然用户改完名会以为目录也跟着变了。
 */

// ─────────────────────────────────────────────────────────────
// 名字净化
// ─────────────────────────────────────────────────────────────

/** Windows 不允许出现在文件名里的字符（外加 0x00–0x1F 控制字符）。 */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F]/g

/**
 * Windows 的设备名。**即使带扩展名也算保留**（`CON.txt` 同样是 `CON`）。
 * 大小写不敏感。
 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

/** 单段目录名的长度上限。整个绝对路径的长度要靠它留出余量。 */
export const MAX_DIR_NAME = 64

/** 净化后什么都不剩时的兜底（例如用户把空间名打成一串 `***`）。 */
const FALLBACK = 'space'

/**
 * 空间名 → 合法的目录名。
 *
 * **中文原样保留** —— NTFS 支持 Unicode，而且这是个中文应用，
 * 把「前端重构」音译成一串拼音才是真的糟糕。
 */
export function sanitizeDirName(name: string): string {
  let out = name
    .replace(ILLEGAL, '')
    // 连续空白压成一个空格，再掐掉首尾
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 会**悄悄**吃掉结尾的点和空格：`Nova.` 建出来叫 `Nova`，
    // 于是我们以为的路径和真实的路径对不上。自己先去掉，保持可预测。
    .replace(/[. ]+$/, '')

  if (out.length > MAX_DIR_NAME) out = out.slice(0, MAX_DIR_NAME)

  // 保留名判断取第一个点之前的部分：`CON.txt` 也是保留名。
  const stem = out.split('.')[0]?.toLowerCase() ?? ''
  if (RESERVED.has(stem)) out = `_${out}`
  if (out.length > MAX_DIR_NAME) out = out.slice(0, MAX_DIR_NAME)

  return out.length > 0 ? out : FALLBACK
}

/**
 * 在已占用的名字里挑一个不冲突的：`Nova` → `Nova-2` → `Nova-3`……
 *
 * ⚠️ **大小写不敏感地比较**：NTFS 默认大小写不敏感，`Nova` 与 `nova` 是**同一个目录**。
 * 只按区分大小写去重的话，DB 的唯一索引会放行，磁盘上却撞在一起。
 */
export function pickDirName(base: string, taken: ReadonlySet<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())

  if (!used.has(base.toLowerCase())) return base

  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    let stem = base
    if (stem.length + suffix.length > MAX_DIR_NAME) {
      stem = stem.slice(0, MAX_DIR_NAME - suffix.length)
    }
    const candidate = `${stem}${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

// ─────────────────────────────────────────────────────────────
// 布局（§8.3）
// ─────────────────────────────────────────────────────────────

/** 空间目录下的固定结构。顺序即创建顺序。 */
export const SPACE_SUBDIRS = ['memory', 'index', 'blobs', 'logs', 'scratch', 'projects'] as const
export type SpaceSubdir = (typeof SPACE_SUBDIRS)[number]

export interface SpacePaths {
  /** `<workspaceRoot>/<dirName>/` */
  root: string
  /** `workspace.json` 铭牌 */
  manifest: string
  /** 角色级 / 会话级记忆（Markdown，人可读可 diff） */
  memory: string
  /** FTS / 向量索引（可重建） */
  index: string
  /** 大文本外置（§5.8） */
  blobs: string
  logs: string
  /** 无主项目的角色（总览 / 客服）的默认 cwd 与临时产物（§8.5b 三级兜底） */
  scratch: string
  /** clone / copy 未改落点时的默认家 */
  projects: string
}

export function spaceDir(root: string, dirName: string): string {
  return join(root, dirName)
}

export function spacePaths(root: string, dirName: string): SpacePaths {
  const dir = spaceDir(root, dirName)
  return {
    root: dir,
    manifest: join(dir, 'workspace.json'),
    memory: join(dir, 'memory'),
    index: join(dir, 'index'),
    blobs: join(dir, 'blobs'),
    logs: join(dir, 'logs'),
    scratch: join(dir, 'scratch'),
    projects: join(dir, 'projects')
  }
}

// ─────────────────────────────────────────────────────────────
// workspace.json
// ─────────────────────────────────────────────────────────────

export interface ManifestInput {
  id: string
  name: string
  dirName: string
  createdAt: number
}

/**
 * `workspace.json` 的正文 —— **只写铭牌**，不镜像成员与可见性。
 *
 * §8.3 原本把它描述成「空间清单：成员、角色可见性、设置」。M4 **刻意不镜像那些**
 * ——镜像就意味着每次改成员、改可见性都要同步写一遍，迟早会分叉；而 §8.3 自己也说了
 * 「两者冲突时以 DB 为准」。一个注定会过期的第二事实源，比没有更糟：
 * 用户会信它。所以这里只写「这个目录是谁」这件静态事实。
 */
export function buildManifest(input: ManifestInput): string {
  return (
    JSON.stringify(
      {
        format: 1,
        id: input.id,
        name: input.name,
        dirName: input.dirName,
        createdAt: input.createdAt,
        _note:
          '这个目录属于 Code Chat 的一个工作空间。权威数据在 SQLite ' +
          '(userData/code-chat.db)，本文件只是给人看的铭牌，不含项目列表与成员可见性' +
          '（那些会变，镜像在这里迟早过期）。删掉本文件不影响使用。'
      },
      null,
      2
    ) + '\n'
  )
}
