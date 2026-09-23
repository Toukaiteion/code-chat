/**
 * `file_diff.patch` 的**行分类**（纯逻辑，裸 Node 可测）。
 *
 * 格式的所有者是 `src/main/domain/tool-diff.ts`，这里是它的**读者**。
 * 那份语法只有三条，而三条都很容易被读者自己「补全」成另一套东西：
 *
 * 1. 内容行以 `-`（删）或 `+`（增）开头；
 * 2. `#` 开头的是**我们自己写的注释**（例如「整文件写入：覆盖前的原文未知」），
 *    **不是**文件内容 —— 把它当成内容着色，用户会以为文件里真有一行 `# 整文件…`；
 * 3. **没有 `@@`、没有行号、没有上下文行**。位置是未知的，那件事被如实表达，
 *    不该被读者算一个数字盖住。
 *
 * 所以这个模块**只做一件事**：按首字符分类。它不解析、不编号、不补上下文。
 *
 * ★ 为什么值得单独一个文件加一组用例：分类错了**不会报错**。
 * 界面会照常渲染，只是把注释染成了新增行、或者把一行删减悄悄吞掉 ——
 * 而 diff 是用户唯一用来核对我们到底改了什么的东西。
 */

export type PatchLine =
  /** 新增行。`text` **不含** 首字符那个 `+`。 */
  | { kind: 'add'; text: string }
  /** 删除行。`text` **不含** 首字符那个 `-`。 */
  | { kind: 'del'; text: string }
  /** `#` 开头的注释行。`text` 含 `#`。 */
  | { kind: 'note'; text: string }
  /**
   * 既不是 `+`/`-` 也不是 `#` 的行。
   *
   * ★ **不许丢掉它。** 它意味着生产方给出了语法之外的东西（版本不一致、格式被改）。
   * 静默吞掉的话，界面上少一行而没人知道；原样显示至少让用户看见「这里有个怪东西」。
   * 空行也会落到这里 —— 那是合法的。
   */
  | { kind: 'raw'; text: string }

/**
 * 把 patch 切成行并分类。
 *
 * ⚠️ 末尾的那个空串要被丢掉：`'a\nb\n'.split('\n')` 得到 `['a','b','']`，
 * 而那个 `''` **不是一行空行**，是分隔符的残留。不丢的话每个 diff 末尾都会
 * 多出一条空转的行。（中间的连续空行是真空行，照常保留。）
 */
export function classifyPatch(patch: string): PatchLine[] {
  if (patch === '') return []
  const raw = patch.split('\n')
  if (raw[raw.length - 1] === '') raw.pop()

  return raw.map((line): PatchLine => {
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) }
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) }
    if (line.startsWith('#')) return { kind: 'note', text: line }
    return { kind: 'raw', text: line }
  })
}

/**
 * 增删行数，用于时间线上那个 `+12 −8` 的小结。
 *
 * ★ 只数 `add` / `del`。`note` 与 `raw` **不计入** —— 把注释算成改动行，
 * 用户看到的数字会比实际改动大，而他会拿这个数字去判断这次改动有多大。
 */
export function countChanges(lines: readonly PatchLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added += 1
    else if (l.kind === 'del') removed += 1
  }
  return { added, removed }
}
