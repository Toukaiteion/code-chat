import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import { promisify } from 'node:util'

/**
 * 调用本机 `git` —— **只在导入时用**。
 *
 * §1.5 给这条划了上界：「除导入外不做任何 git 操作」。所以这里只有三个动作：
 * 找到 git、克隆一次、读一下当前分支。没有 status、没有 commit、没有 worktree
 * （§8.6 专门论证过为什么不用 worktree 当导入机制）。
 *
 * 三个刻意的选择：
 *
 * 1. **`execFile` 且 `shell:false`**：URL 与路径走 argv，不拼命令串。
 *    用户给的远端 URL 是外部输入，把它拼进 shell 命令串等于开一个注入口。
 * 2. **`GIT_TERMINAL_PROMPT=0`**：终端提示符在 GUI 里**看不见** ——
 *    一个要密码的克隆会安静地挂死，用户只看到界面卡住。而凭据管理器
 *    （Windows 上是 GCM）不走终端提示，所以私有仓库照常能用。
 * 3. **不清空用户的全局 git 配置**：我们用的就是用户本机的 git，
 *    他的 proxy、凭据、`core.autocrlf` 理应生效。偷偷换一套配置会让
 *    克隆结果和他手敲 `git clone` 不一样。
 *
 * ⚠️ M4 边界：**没有进度、不能取消**。复制跳过 `node_modules` 之后通常很小，
 * 但大仓库的克隆就是会安静地转很久。这条要如实写进文档，不许含糊。
 */

const execFileAsync = promisify(execFile)

/** 输出上限。克隆的 stdout/stderr 不该有这么多，超了说明是别的东西在刷屏。 */
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * 定位 git 时按顺序试的可执行文件名。
 *
 * ⚠️ Windows 上刻意**只给 `.exe`**：Node ≥20.12 在没有 shell 时 spawn `.cmd`/`.bat`
 * 会直接抛 `EINVAL`（Node 修了当年那个 CVE 之后的行为）。`where git` 在本机返回的
 * 就是 `.exe`，而如果我们去试一个 `.cmd`，失败原因会变成一句看不懂的 EINVAL，
 * 而不是「找不到 git」。
 */
const CANDIDATES = process.platform === 'win32' ? ['git.exe'] : ['git']

/**
 * 环境变量覆盖 —— 设了就**只用它**，不再查 PATH。
 *
 * 两条用途，都很实在：
 * 1. 用户的 git 装在非标准位置（便携版、scoop 之外的自定义目录）时有个正式出口，
 *    不必改系统 PATH；
 * 2. **让「本机没装 git」这条分支可以被确定性地测试** —— 否则验它只能靠人肉卸一次 git。
 *    指向一个不存在的文件 → `locateGit()` 返回 null → handler 给出人话错误。
 */
function overridePath(): string | null {
  const v = process.env.CODE_CHAT_GIT_PATH
  return v && v.trim() ? v.trim() : null
}

export interface GitRunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  /** 进程压根没起来（ENOENT 等）时的原因。 */
  spawnError: string | null
}

/**
 * 找 `git` 可执行文件。找不到返回 `null` —— **由调用方给出人话**，
 * 这里不抛，因为「本机没装 git」是一种可预期的处境，不是异常。
 *
 * 只查 PATH，不做 `where`/`which` 之类的 shell 调用（也就不会引入 shell）。
 * §8.9 的既有纪律是不靠 PATH 猜东西 —— 但 git 就是由 PATH 定义的，
 * 差别在于：找不到时我们要**说清楚找过哪里**，而不是让 spawn 抛个 `ENOENT`。
 *
 * **刻意不缓存**：一次 `--version` 大约几十毫秒，而一个克隆动辄几秒；
 * 用缓存换回来的那点时间，不值得让「用户刚装完 git 却还要重启应用」这种事发生。
 */
export async function locateGit(): Promise<string | null> {
  const forced = overridePath()
  if (forced) {
    return (await probe(forced)) ? forced : null
  }
  for (const name of CANDIDATES) {
    if (await probe(name)) return name
  }
  return null
}

async function probe(exe: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(exe, ['--version'], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: MAX_BUFFER
    })
    return stdout.trim().startsWith('git version')
  } catch {
    return false
  }
}

/** 「找过哪里」——失败时放进 `detail`，用户能照着修。 */
export function gitSearchHint(): {
  override: string | null
  candidates: string[]
  pathEntries: string[]
} {
  return {
    override: overridePath(),
    candidates: CANDIDATES,
    pathEntries: (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  }
}

/**
 * 完整克隆（**不加 `--depth`**）。浅克隆会让 agent 看不到历史，
 * 而「看不到历史」是事后很难改回来的取舍（要 `fetch --unshallow`）。
 *
 * @param targetPath 目标目录。调用方**必须先确认它不存在或为空** ——
 *                   git 对非空目标的报错很含糊，我们自己在 handler 里说人话。
 */
export async function cloneRepo(opts: {
  gitPath: string
  remoteUrl: string
  targetPath: string
  branch?: string | null
}): Promise<GitRunResult> {
  const args = ['clone']
  if (opts.branch) args.push('--branch', opts.branch)
  args.push('--', toGitPath(opts.remoteUrl), toGitPath(opts.targetPath))

  return run(opts.gitPath, args, ['-c', 'core.longpaths=true'])
}

/**
 * Windows 路径 → git 认的形状。反斜杠在 git 的参数里会被当转义符，
 * 是经典坑：`G:\tmp\x` 传进去 git 会看到 `G:tmpx`。
 *
 * 对 URL 也无害（`\` 在 URL 里本来就没有含义），所以两边都过一遍。
 */
export function toGitPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 克隆完读一下真的落在哪个分支上 —— 用它填 `default_branch`，而不是猜 `main`。 */
export async function currentBranch(gitPath: string, repoPath: string): Promise<string | null> {
  const res = await run(gitPath, ['-C', toGitPath(repoPath), 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (!res.ok) return null
  const branch = res.stdout.trim()
  // 分离头指针时 rev-parse 会回 'HEAD' —— 那不是分支名，如实回 null。
  return branch && branch !== 'HEAD' ? branch : null
}

async function run(
  gitPath: string,
  args: string[],
  leading: string[] = []
): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(gitPath, [...leading, ...args], {
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        // 见文件头第 2 条：不许弹终端提示。
        GIT_TERMINAL_PROMPT: '0',
        // 我们不是终端，别让 git 输出进度动画（那会把 stderr 撑爆）。
        GIT_ASKPASS: ''
      }
    })
    return { ok: true, code: 0, stdout, stderr, spawnError: null }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }
    // execFile 失败时 err.code 是**退出码**（数字）；进程没起来时是字符串（'ENOENT'）。
    const isSpawnFailure = typeof e.code === 'string' && !Number.isFinite(Number(e.code))
    return {
      ok: false,
      code: isSpawnFailure ? null : Number(e.code),
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
      spawnError: isSpawnFailure ? (e.code as string) : null
    }
  }
}

/**
 * 克隆失败时**尽力**回收半成品目录。
 *
 * git 自己通常会把失败的目标目录清掉，但不是所有失败路径都如此
 * （网络中断、被 Ctrl-C、磁盘满）。留着半成品比留着空目录更糟：
 * 用户下一次会看到「目标已存在」而不知道为什么。
 *
 * 回收失败**不吞**：调用方要把路径如实告诉用户。
 */
export async function bestEffortRemoveDir(path: string): Promise<boolean> {
  const { rm } = await import('node:fs/promises')
  try {
    await rm(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 给 detail 用：把一大段 stderr 截成还能看的一小截。 */
export function tail(text: string, maxLines = 8): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  return lines.slice(-maxLines).join('\n')
}

/** 一行人话摘要（取 stderr 第一行有内容的）。 */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? ''
}
