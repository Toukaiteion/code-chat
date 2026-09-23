import { readFile, readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { ProjectContext, ProjectContextFile, ProjectContextKind } from '../agent-adapter.ts'

/**
 * `collectProjectContext` 的实现（§8.5c）。
 *
 * 它回答的是那个用户提出来的问题：**「一个角色通过 `--add-dir` 关联了多个项目，
 * 但拿不到那些目录的 CLAUDE.md 吧」** —— 原设计让 cwd 同时承担「工具的相对路径基准」
 * 和「项目持久化上下文的来源」两个职责，而这个抽象把后者拆了出来。
 * 于是 `--add-dir` 降级成纯粹的**工具可及范围**，它带进 CLAUDE.md 只是副产品。
 *
 * ## 四条实现纪律
 *
 * - **`~/.claude/CLAUDE.md` 不扫**（§8.5c 表格）。那是用户**全局**的记忆，
 *   不属于任何项目；把它当项目上下文注入，等于每个项目都悄悄带上用户的私人配置。
 * - **顺序是确定的**（排序 + 固定的扫描表顺序）。这不是审美：注入内容会影响提示词前缀，
 *   而前缀一变，**缓存就整段失配**（§4.6/§5.4）。同一棵树两次扫描必须给出同一个顺序。
 * - **单文件失败一律跳过并记档**，不抛。`.claude/rules/*.md` 完全可能匹配到一个**目录**
 *   （名字里带 `.md` 的目录），那是 `EISDIR`；而 §8.5c 的性质 5 承诺了
 *   「项目记忆没被读到」是一个**可见**的状态 —— 静默跳过就把它变回安静的失效。
 * - **不写任何「去重」逻辑。** §8.5c 说得很明确：`--add-dir` 带进的 CLAUDE.md 与
 *   我们显式注入的同一份**会不会重复**，要用两个可区分的标记字符串实测一次才能判定
 *   （探针④），**结论出来前不许写去重**。这里只有「读文件」一件事。
 */

/** 每个文件的默认截断上限（§8.5c：16KB）。 */
export const FILE_CAP_BYTES = 16 * 1024

/** `projectContextSources()` 的返回值 —— UI 用它显示「这个项目的记忆被读到了吗」。 */
export const PROJECT_CONTEXT_SOURCES: ReadonlyArray<{ kind: ProjectContextKind; relPath: string }> = [
  { kind: 'claude-md', relPath: 'CLAUDE.md' },
  { kind: 'claude-md', relPath: '.claude/CLAUDE.md' },
  { kind: 'agents-md', relPath: 'AGENTS.md' },
  { kind: 'rules', relPath: '.claude/rules/*.md' },
  { kind: 'cursorrules', relPath: '.cursorrules' },
  { kind: 'cursorrules', relPath: '.cursor/rules/*' },
  { kind: 'copilot', relPath: '.github/copilot-instructions.md' }
]

interface Candidate {
  kind: ProjectContextKind
  /** 相对 rootPath 的路径（用 `/` 分隔，展示与注入都用它）。 */
  relPath: string
}

/** 扫一个目录下的**文件**。目录一律跳过 —— 见文件头第三条纪律（`EISDIR` 的防线）。 */
async function listDir(absDir: string, relDir: string, filter?: (name: string) => boolean): Promise<string[]> {
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    // 目录不存在是常态（大部分项目没有 `.claude/rules/`），不是异常，**不记档**。
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (filter && !filter(e.name)) continue
    // 目录在这里被挡掉 —— 这就是 `EISDIR` 的防线，不让它走到 readFile。
    if (!e.isFile()) continue
    out.push(posix.join(relDir, e.name))
  }
  // 确定性顺序，见文件头第二条纪律。
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return out
}

/** 按 §8.5c 的表格列出所有候选（顺序即优先级）。 */
async function listCandidates(rootPath: string): Promise<Candidate[]> {
  const out: Candidate[] = []
  const push = (kind: ProjectContextKind, relPath: string): void => {
    out.push({ kind, relPath })
  }

  // 项目级 CLAUDE.md（**不含** `~/.claude/CLAUDE.md`，见文件头第一条纪律）。
  push('claude-md', 'CLAUDE.md')
  push('claude-md', '.claude/CLAUDE.md')
  push('agents-md', 'AGENTS.md')

  // `.claude/rules/*.md` —— 只收 `.md`（§8.5c 表格写的就是 `*.md`）。
  for (const r of await listDir(join(rootPath, '.claude', 'rules'), '.claude/rules', (n) => n.endsWith('.md'))) {
    push('rules', r)
  }

  push('cursorrules', '.cursorrules')
  // `.cursor/rules/*` —— 表格写的是 `*`，所以任何扩展名都收（Cursor 用的是 `.mdc`）。
  for (const c of await listDir(join(rootPath, '.cursor', 'rules'), '.cursor/rules')) {
    push('cursorrules', c)
  }

  push('copilot', '.github/copilot-instructions.md')

  return out
}

async function readCandidate(rootPath: string, c: Candidate, cap: number): Promise<ProjectContextFile | { skipped: string }> {
  const abs = join(rootPath, c.relPath)
  try {
    const st = await stat(abs)
    if (!st.isFile()) return { skipped: '不是普通文件' }
    const buf = await readFile(abs)
    const truncated = buf.byteLength > cap
    // 按**字节**切，不按字符切 —— 否则一个多字节字符会被切一半。
    // 边界上可能留一个 U+FFFD 替换字符，可接受（总比丢一行好）。
    const text = truncated ? buf.subarray(0, cap).toString('utf8') : buf.toString('utf8')
    return { kind: c.kind, path: c.relPath, bytes: buf.byteLength, text }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '未知错误'
    // ENOENT 是常态（这个项目没有这个文件），**不记档**；其余（EISDIR/EACCES/……）要记。
    if (code === 'ENOENT') return { skipped: '__enoent__' }
    return { skipped: String(code) }
  }
}

export async function collectProjectContext(
  rootPath: string,
  opts: { cap?: number } = {}
): Promise<ProjectContext> {
  const cap = opts.cap ?? FILE_CAP_BYTES
  const files: ProjectContextFile[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  let truncated = false

  const candidates = await listCandidates(rootPath)
  for (const c of candidates) {
    const res = await readCandidate(rootPath, c, cap)
    if ('skipped' in res) {
      if (res.skipped !== '__enoent__') skipped.push({ path: c.relPath, reason: res.skipped })
      continue
    }
    if (res.bytes > cap) truncated = true
    files.push(res)
  }

  return { rootPath, files, truncated, skipped }
}
