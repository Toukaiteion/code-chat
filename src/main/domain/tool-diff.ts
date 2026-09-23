import { isAbsolute, relative } from 'node:path'

/**
 * `file_diff` 的合成器 —— §8.9-17 点名的**所有者**，M6a 落地。
 *
 * ## 为什么它必须存在
 *
 * `docs/design.md` §2.2 的「CLI 输出行 → 我们的帧」映射表里，**没有任何一行产出
 * `file_diff`**。适配层拿到的只有 `Edit` / `Write` 的 `tool_use.input` 里那两个字符串。
 * 于是这个事件类型有一个已定的形状、一个已定的渲染位、**零个生产者**：
 * 不写这段合成，`file_diff` 就会一直是「契约里有、永远收不到」的那个状态 ——
 * 而那种缺失不会报错，只会让界面安静地少一块。
 *
 * ## 它刻意**不读文件**
 *
 * 最诱人的做法是：拿到 `file_path` 就去盘上读原文，算出准确的行号和上下文。
 * **不做，而且这不是偷懒**：
 *
 * 1. 我们拿到的时刻是 `tool_use`，而**工具真的执行发生在之后** —— 读到的文件
 *    是「改动前」还是「改动后」取决于时序，我们无从知道。编出来的行号会把
 *    「我猜的位置」伪装成「它的位置」。
 * 2. Agent 在跑，它自己也在改这些文件。任何一次读都是 TOCTOU。
 * 3. `Edit` 的输入里**已经有**原文与新文，读文件不会多出任何信息，
 *    只会多出一份可能与输入不一致的第二事实源。
 *
 * 所以 patch 里**没有 `@@` 头、没有行号**（见下面的格式说明）。
 * 「位置是未知的」这件事被如实表达，而不是被一个数字盖住。
 *
 * ## `file_diff.patch` 的格式（M6a 定义，M6b 的渲染方按此实现）
 *
 * ```
 * -原文的一行
 * +新文的一行
 * # 以 # 开头的是我们自己的注释
 * ```
 *
 * - **内容行的首字符永远是 `-` 或 `+`**，所以 `#` 注释行不可能与内容混淆
 *   （哪怕原文本身有一行是 `# 注释`，它也会长成 `-# 注释`）。
 * - **没有 `@@` 与行号**：理由是上面那三条。
 * - 没有「未变行」的 ` ` 前缀行 —— 我们不知道上下文，编不出来。
 *
 * 这不是一个合法的 unified diff，**它也不假装是**。它的读者是渲染层，
 * 需要的是「哪些行没了、哪些行来了」，而这正是它如实给出的东西。
 */

/** 合成结果。`path` 已经是**展示用**的相对路径（见 `displayPath`）。 */
export interface SynthesizedDiff {
  path: string
  patch: string
}

/**
 * 认识「会改文件」的工具名。
 *
 * ⚠️ 表里**只有实测见过的两个**（§2.2 的归档里出现过 `Edit`；`Write` 是它的同族）。
 * 不认识的一律返回 `null`，由 `looksLikeEditor()` 报警 —— 见那个函数的说明。
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** 真的实现了映射的工具名 —— 上表的一个子集。 */
const MAPPED_TOOLS = new Set(['Edit', 'Write'])

/**
 * 「这个名字看起来会改文件，但我们没有它的映射表」。
 *
 * ★ 这个函数存在的**唯一**理由，是让 §8.9-17 那种缺失**再也无法安静地复发**：
 * `file_diff` 当年的问题不是「算错了」，而是「没有任何东西会产生它，也没有任何东西
 * 会抱怨」。所以调用方（`event-batcher`）在遇到这类工具时应记一条 `warn` 诊断 ——
 * 于是一个「工具改了文件、界面上却什么都没有」的情况会留下痕迹，
 * 而不是等用户来问「你刚才是不是改了东西」。
 */
export function looksLikeEditor(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName) && !MAPPED_TOOLS.has(toolName)
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/**
 * 把一串文本拆成 diff 行。
 *
 * ★ 尾随换行的处理是这里唯一容易错的地方：`"a\nb\n"` 是**两行**，不是三行。
 * 不处理的话每次编辑都会多出一行空的 `+`，界面上看是「文件末尾多了一个空行」——
 * 一个用户会当成真改动去排查的假象。
 */
function toLines(text: string, prefix: '-' | '+'): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').map((l) => `${prefix}${l}`)
}

/**
 * 绝对路径 → 展示用的相对路径。
 *
 * 在 `cwd` 之下就相对化（界面上短、且与用户看到的项目结构一致），
 * 否则原样返回绝对路径。`cwd` 为空、或者解析出的相对路径要往上爬（`..`）时，
 * **一律保留绝对路径** —— 一个以 `../../..` 开头的「相对路径」比绝对路径更难读，
 * 而且它其实是在说「这个文件不在你这个项目的目录里」，那正是该被看见的信息。
 */
export function displayPath(filePath: string, cwd: string | null): string {
  if (!cwd) return filePath
  if (!isAbsolute(filePath)) return filePath
  const rel = relative(cwd, filePath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return filePath
  // Windows 上用正斜杠展示：与 git、与用户看惯的路径写法一致。
  return rel.split('\\').join('/')
}

/**
 * 从 `tool_use` 的输入合成一条可渲染的 diff。
 *
 * 返回 `null` 的三种情况，**它们不是同一件事**，调用方要区别对待：
 * 1. 这个工具本来就不改文件（`Read`、`Bash`……）→ 正常，什么都不做；
 * 2. 名字看起来会改文件但没映射表 → 调用方应记 `warn` 诊断（见 `looksLikeEditor`）；
 * 3. 形状不对（缺 `file_path` 等）→ 同上，这也是一种「我们没接住」。
 */
export function synthesizeFileDiff(
  toolName: string,
  input: unknown,
  cwd: string | null = null
): SynthesizedDiff | null {
  const o = asObj(input)
  if (!o) return null

  const rawPath = str(o.file_path)
  if (!rawPath) return null
  const path = displayPath(rawPath, cwd)

  if (toolName === 'Edit') {
    const oldText = str(o.old_string)
    const newText = str(o.new_string)
    if (oldText === null || newText === null) return null

    const lines: string[] = []
    // `replace_all` 会改变**语义**，却不改变**行** —— 一段补丁在两处生效和三处生效，
    // 逐行看是一模一样的。不写这一行的话，用户会以为只改了一处。
    if (o.replace_all === true) {
      lines.push('# replace_all：该替换在文件里出现多次，每一处都已被替换')
    }
    lines.push(...toLines(oldText, '-'), ...toLines(newText, '+'))
    return { path, patch: lines.join('\n') }
  }

  if (toolName === 'Write') {
    const content = str(o.content)
    if (content === null) return null
    const lines = [
      // 覆盖前的原文**无从得知** —— 我们没读文件，而且读也读不到「它写之前」那份。
      // 编一整份「删除」出来的话，界面会显示一个我们从未见过的原文。
      '# 整文件写入：覆盖前的原文未知（未读取文件）',
      ...toLines(content, '+')
    ]
    return { path, patch: lines.join('\n') }
  }

  return null
}
