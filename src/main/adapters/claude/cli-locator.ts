import { execFile } from 'node:child_process'
import { basename, delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * 找到真正的 `claude.exe`。
 *
 * ## 为什么不能照 §4.4 的字面实现
 *
 * §4.4 写的解析顺序是「用户设置覆盖 → `npm prefix -g` 下的 `…/bin/claude.exe` → `where claude`」。
 * **顺序保留，机制必须换掉** —— 后两步照字面写在 Windows 上是自毁的，本机实测：
 *
 * ```
 * where claude  →  D:\nodejs\node_global\claude        ← 无扩展名的 bash 垫片
 *                  D:\nodejs\node_global\claude.cmd    ← .cmd 垫片
 * where npm     →  D:\nodejs\npm  /  D:\nodejs\npm.cmd  ← 压根没有 npm.exe
 * ```
 *
 * **`claude.exe` 根本不在 PATH 上。** 真身在
 * `D:\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（237,100,192 字节），
 * 同目录还躺着一个自更新残留 `claude.exe.old.1790009891938`。于是：
 *
 * 1. **不能 spawn `npm`**：`npm.exe` 不存在，`execFile('npm', …)` 是 ENOENT；
 *    而 `npm.cmd` 在无 shell 时 spawn 会抛 `EINVAL` —— 正是 `infra/git.ts:35-41`
 *    当初为 git 写 `CANDIDATES` 时踩过并记下来的那个坑（Node ≥20.12 的行为）。
 * 2. **`where claude` 的两条结果恰好都是必须拒绝的垫片**：取无扩展名那条 → ENOENT，
 *    取 `.cmd` 那条 → EINVAL。直接用它等于把「找不到 CLI」变成一句看不懂的 EINVAL。
 *
 * ## 实际机制：拿垫片的位置去反推真身
 *
 * npm 全局包的 Windows 布局是固定的：`<prefix>/claude.cmd` 是垫片，
 * 真身在 `<prefix>/node_modules/<包名>/bin/claude.exe`。而 `where claude` 给的
 * `.cmd` **就在那个 prefix 里** —— 所以它的目录名就是我们要的 prefix，
 * 不需要问 npm、不需要 spawn 任何东西。这比猜目录可靠得多：
 * 本机的 prefix 是 `node_global`（不在 node 目录下），**猜是猜不出来的**。
 *
 * ## 三条自律
 *
 * - **只查文件，不执行它。** §8.7 的方法论教训：探测一个 CLI 不要去跑它。
 *   执行意味着超时、退出码归属、僵尸进程三种成本，而我们对这些信息一点都用不上 ——
 *   我们只想知道「这个路径上有没有那个文件」。存在性与大小足够，真不行还有
 *   「spawn 报 ENOENT 就重解析」这条兜底。
 * - **只认文件名精确等于 `claude.exe`。** 那条 `.old.<时间戳>` 残留必须被排除，
 *   否则自更新之后我们可能一直启动一个旧版本，且毫无征兆。
 * - **找不到返回 `null`**，由调用方给出人话（照 `gitSearchHint()` 的形状）。
 *   「本机没装 CLI」是可预期的处境，不是异常。
 */

const execFileAsync = promisify(execFile)

/** `where.exe` 的输出上限。一个名字不该匹配出这么多行，超了说明是别的东西在刷屏。 */
const MAX_BUFFER = 1024 * 1024

/** 包名——推导真身路径时要用。 */
const PACKAGE = '@anthropic-ai/claude-code'

/** 真身的文件名。**精确匹配**，`claude.exe.old.<ts>` 一律不认。 */
const EXE_NAME = 'claude.exe'

export interface LocatorDeps {
  /** 覆盖值。默认读 `CODE_CHAT_CLAUDE_PATH`；显式给 `null` 表示「没有覆盖」，空串同义。 */
  override?: string | null
  /** 判断一个路径上是不是真的有那个文件。默认查文件系统（**不执行**）。 */
  probe?: (exe: string) => Promise<boolean>
  /** 列出一个名字在 PATH 上的所有匹配。默认 `where.exe`。 */
  runWhere?: (name: string) => Promise<string[]>
  /** node 安装目录，用于一组兜底候选。默认由 `process.execPath` 推出。 */
  nodeDir?: string
  /** Windows 上 npm 的默认全局目录所在（`%APPDATA%`）。给 `null` 表示不试这一组。 */
  appDataDir?: string | null
}

/**
 * 环境变量覆盖 —— 设了就**只用它**，不再查别处。
 *
 * 两条用途，与 `CODE_CHAT_GIT_PATH`（`infra/git.ts:42-54`）逐字同构：
 * ① 用户的 CLI 装在非标准位置时有个正式出口；
 * ② **让「本机没装 CLI」这条分支可以被确定性地测试** —— 否则验它只能靠人肉卸一次 CLI。
 */
function defaultOverride(): string | null {
  const v = process.env.CODE_CHAT_CLAUDE_PATH
  return v && v.trim() ? v.trim() : null
}

/**
 * 文件存在性 —— **刻意不执行**。
 *
 * 大小下限只用来挡零字节的占位文件。真正的完整性校验只能靠「spawn 失败 → 重新解析」，
 * 而那正是 §4.4 已经写下的兜底路径（CLI 会自更新，路径随时可能变）。
 */
async function defaultProbe(exe: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    const st = await stat(exe)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

/** `where.exe` 是**真的 `.exe`**，所以这一步不会踩 `.cmd` 的 EINVAL 坑。 */
async function defaultRunWhere(name: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('where.exe', [name], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: MAX_BUFFER
    })
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    // 「没找到」时 where 返回非零 —— 那是正常结果，不是错误。
    return []
  }
}

/** 由垫片的位置反推真身：`<prefix>/claude.cmd` → `<prefix>/node_modules/…/bin/claude.exe`。 */
function exeFromShim(shimPath: string): string {
  return join(dirname(shimPath), 'node_modules', ...PACKAGE.split('/'), 'bin', EXE_NAME)
}

/** 一组「什么都不知道时也该试一下」的候选（照 npm 在 Windows 上的常见布局）。 */
function blindCandidates(deps: Required<Pick<LocatorDeps, 'nodeDir'>> & LocatorDeps): string[] {
  const out: string[] = []
  const fromNode = (root: string): string =>
    join(root, 'node_modules', ...PACKAGE.split('/'), 'bin', EXE_NAME)
  // node 目录本身（`npm i -g` 装到 node 自己下面时）
  out.push(fromNode(deps.nodeDir))
  // node 目录旁边的 node_global（**本机就是这个布局**，所以这条不是想当然）
  const globalDir = join(deps.nodeDir, 'node_global')
  out.push(fromNode(globalDir))
  out.push(join(globalDir, EXE_NAME))
  if (deps.appDataDir) {
    out.push(fromNode(join(deps.appDataDir, 'npm')))
  }
  return out
}

/**
 * 完整的解析。**不做缓存** —— 缓存由 `resolveClaude()` 那一层负责，
 * 这样测试注入依赖时不可能被另一个测试的缓存污染。
 */
export async function resolveClaudeWith(deps: LocatorDeps = {}): Promise<string | null> {
  const probe = deps.probe ?? defaultProbe
  const override = deps.override === undefined ? defaultOverride() : deps.override
  const runWhere = deps.runWhere ?? defaultRunWhere
  const nodeDir = deps.nodeDir ?? dirname(process.execPath)
  const appDataDir = deps.appDataDir === undefined ? (process.env.APPDATA ?? null) : deps.appDataDir

  // ① 覆盖 —— 设了就只用它，命中不了就返回 null（不悄悄回退到别处）。
  if (override) {
    return (await probe(override)) ? override : null
  }

  // ② 拿 PATH 上的匹配反推真身。`.cmd` 垫片与无扩展名垫片都走这条。
  const matches = await runWhere('claude')
  for (const m of matches) {
    // 直接就是真身（少见但可能：用户把 bin 目录加进了 PATH）。
    // ★ 用 `basename` **精确相等**，不是 `endsWith` —— 后者会放进 `myclaude.exe`。
    // 文件头那条纪律说的是「精确等于」，代码就得是精确等于。
    if (basename(m) === EXE_NAME && (await probe(m))) return m
    // 垫片 → 反推真身。忽略 `.ps1` 之类跟我们无关的垫片，反推出来的路径不存在就算了。
    const derived = exeFromShim(m)
    if (await probe(derived)) return derived
  }

  // ③ 兜底：PATH 上什么都没有时，试几组常见布局。
  for (const c of blindCandidates({ nodeDir, appDataDir })) {
    if (await probe(c)) return c
  }

  return null
}

/**
 * 带缓存的版本。
 *
 * **与 `locateGit()` 刻意不同的一处**：git 那边不缓存（一次 `--version` 只要几十毫秒，
 * 换「刚装完 git 却要重启应用」不划算）。CLI 这边必须缓存 —— 它是 237MB 的原生二进制，
 * 而 §4.4 每轮都要 spawn 一次，每次解析都要走一遍 `where.exe`（一个子进程）。
 * 代价是路径会在 CLI 自更新后变旧，所以配 `invalidateClaudeCache()`：
 * **spawn 报 ENOENT 时调用它并重新解析**（§4.4）。
 */
let cached: string | null = null
let cachedOnce = false

export async function resolveClaude(): Promise<string | null> {
  if (cachedOnce) return cached
  cached = await resolveClaudeWith()
  cachedOnce = true
  return cached
}

/** CLI 自更新会换掉文件（本机那个 `claude.exe.old.<ts>` 就是证据），所以要有这一手。 */
export function invalidateClaudeCache(): void {
  cached = null
  cachedOnce = false
}

/**
 * 「找过哪里」—— 失败时放进 detail，用户能照着修。照 `gitSearchHint()` 的形状。
 *
 * 它是 `async` 的（`gitSearchHint()` 不是），因为「PATH 上到底匹配到了什么」
 * 只有真去问一次才知道 —— 而那个结果恰恰是最有用的一条：本机 `where claude`
 * 返回的两条**都是垫片**，用户看到这个才会明白「PATH 上有 claude」和
 * 「claude.exe 存在」是两件事。
 */
export async function claudeSearchHint(deps: LocatorDeps = {}): Promise<{
  override: string | null
  whereMatches: string[]
  whereMatchDerivations: string[]
  blindCandidates: string[]
  pathEntries: string[]
}> {
  const override = deps.override === undefined ? defaultOverride() : deps.override
  const runWhere = deps.runWhere ?? defaultRunWhere
  const nodeDir = deps.nodeDir ?? dirname(process.execPath)
  const appDataDir = deps.appDataDir === undefined ? (process.env.APPDATA ?? null) : deps.appDataDir
  const whereMatches = await runWhere('claude')
  return {
    override,
    whereMatches,
    // 每个垫片会被反推成哪个真身路径 —— 这是排查「为什么没找到」最关键的一栏。
    whereMatchDerivations: whereMatches.map(exeFromShim),
    blindCandidates: blindCandidates({ nodeDir, appDataDir }),
    pathEntries: (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  }
}
