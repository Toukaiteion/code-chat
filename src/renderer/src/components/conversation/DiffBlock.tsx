import { classifyPatch, countChanges } from '@shared/live/patch-lines'

/**
 * 一块文件改动。**不是 unified diff** —— 格式由 `src/main/domain/tool-diff.ts` 定死：
 * 内容行以 `-`/`+` 开头，`#` 开头的是我们自己的注释，**没有 `@@`、没有行号、没有上下文行**。
 *
 * ★ 这里**不自己算行号**。位置是未知的，那件事被如实表达（不显示行号），
 * 而不是被一个编出来的数字盖住。算行号看起来是「顺手把界面做完整」，
 * 实际上是让用户拿一个错误的位置去核对我们的改动 —— 比不显示更糟。
 *
 * ★ 注释行**单独一种样式**：把它染成新增行，用户会以为文件里真有一行
 * `# 整文件写入：覆盖前的原文未知（未读取文件）`。
 */
export function DiffBlock({ path, patch }: { path: string; patch: string }): React.JSX.Element {
  const lines = classifyPatch(patch)
  const { added, removed } = countChanges(lines)

  return (
    <div className="border-edge bg-void/60 mb-2 overflow-hidden rounded-md border font-mono text-[11px]">
      <div className="border-edge text-ink-faint flex items-center gap-2 border-b px-3 py-1 text-[10px]">
        <span className="text-ink-dim truncate">{path}</span>
        <span className="ml-auto shrink-0">
          {added > 0 && <span className="text-neon-lime/80">+{added}</span>}
          {added > 0 && removed > 0 && ' '}
          {removed > 0 && <span className="text-neon-pink/80">−{removed}</span>}
          {added === 0 && removed === 0 && <span>无内容行</span>}
        </span>
      </div>

      <div className="overflow-x-auto">
        {lines.map((l, i) => {
          if (l.kind === 'note') {
            return (
              <div key={i} className="text-ink-faint px-3 py-0.5 text-[10px] italic">
                {l.text}
              </div>
            )
          }
          if (l.kind === 'raw') {
            // 语法之外的行：原样显示，不着色。**不许丢**（见 `patch-lines.ts`）。
            return (
              <div key={i} className="text-ink-faint px-3 py-0.5 whitespace-pre">
                {l.text}
              </div>
            )
          }
          const add = l.kind === 'add'
          return (
            <div
              key={i}
              className={`px-3 py-0.5 whitespace-pre ${
                add ? 'bg-neon-lime/8 text-neon-lime/90' : 'bg-neon-pink/8 text-neon-pink/80'
              }`}
            >
              <span className="mr-2 opacity-60 select-none">{add ? '+' : '-'}</span>
              {l.text}
            </div>
          )
        })}
      </div>
    </div>
  )
}
