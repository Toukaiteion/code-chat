/**
 * §8.5b 的 **cwd 三级兜底** —— 纯函数，**每成员、每轮**解析，不是空间级。
 *
 * ```
 * member 在该空间的 is_primary 项目  →  该项目的 root_path
 *   ↓ 无
 * workspace.active_project_id        →  该项目的 root_path     ← 空间「最近使用」，仅作兜底
 *   ↓ 无
 * <space>/scratch/                   →  无主项目的角色（总览 / 客服）的落点
 * ```
 *
 * ## 为什么粒度必须是**成员**而不是空间
 *
 * §8.5b 的论证：用户故事 1（前后端各配一个专注角色）与故事 2（总览角色）
 * **同时成立**时，任何空间级的单一 cwd 都必然错一半。所以这里读的是
 * `member_project.is_primary` —— 一个每成员一份的事实。
 *
 * ## 它**不碰盘**，这是刻意的
 *
 * 「这个 `root_path` 在盘上还在不在」不是 cwd 解析能回答的问题，也不该由它回答：
 * 那是项目生命周期的事（M4 的删除流程 / 用户在资源管理器里手删）。真不在了，
 * CLI 会以 ENOENT 起不来，而那条失败会如实落进 `turn.error_text` 与一条 `error` 事件
 * —— 一个**说得清**的失败。在这里加一次 `existsSync` 只会把同一个事实变成两个所有者，
 * 而它会随盘上状态在两次调用之间变化（TOCTOU）。
 *
 * ## 第三级为什么必须有
 *
 * 总览 / 客服这类角色**没有主项目**，而 `turn.cwd` 是 `NOT NULL` 的。
 * 少这一级，它们连一轮都发不出去 —— 而「无主项目的角色」恰恰是 §8.5b 的
 * 用户故事 2 的主角。`scratch/` 由 M4 建空间时就建好了（`SPACE_SUBDIRS`）。
 */

export type CwdSource = 'member-primary' | 'workspace-active' | 'scratch'

export interface CwdDecision {
  cwd: string
  /** 命中了哪一级。**要记进诊断与日志** —— 用户问「它到底在哪个目录里跑的」时，这是答案。 */
  source: CwdSource
}

/** 只为解析 cwd 需要的项目信息 —— 刻意不依赖 `Project` 的完整形状。 */
export interface CwdProject {
  id: string
  rootPath: string
}

export interface CwdInput {
  /** `member_project` 里 `is_primary = 1` 的那条指向的项目；没有就是 `null`。 */
  memberPrimaryProjectId: string | null
  /** `workspace.active_project_id`（空间「最近使用」的兜底）。 */
  workspaceActiveProjectId: string | null
  /** 该空间的全部项目（本函数只做 id 查找，不做可见性判断）。 */
  projects: readonly CwdProject[]
  /** `<space>/scratch/` 的绝对路径（`spacePaths(root, dirName).scratch`）。 */
  scratchPath: string
}

export function resolveTurnCwd(input: CwdInput): CwdDecision {
  const byId = new Map(input.projects.map((p) => [p.id, p]))

  if (input.memberPrimaryProjectId) {
    const p = byId.get(input.memberPrimaryProjectId)
    // 找不到项目行（被删了）→ **不静默降级到 scratch**。降级会让 agent 在
    // 一个空目录里跑，而用户以为它在自己的项目里 —— 一个安静的错位置。
    // 落回下一级并让调用方从 `source` 看出没命中主项目，是更诚实的路径。
    if (p) return { cwd: p.rootPath, source: 'member-primary' }
  }

  if (input.workspaceActiveProjectId) {
    const p = byId.get(input.workspaceActiveProjectId)
    if (p) return { cwd: p.rootPath, source: 'workspace-active' }
  }

  return { cwd: input.scratchPath, source: 'scratch' }
}

/**
 * §8.4 的**可见性**，落到 `--add-dir` 上：**所有可见项目**一律挂入。
 *
 * 语义逐字照 `member-repo` 的说明（那段是唯一的事实源，别在这里另立一套）：
 * - 没有任何 `member_project` 行 → 可见空间内**全部**项目（默认）；
 * - 有行 → **只**可见这些。
 *
 * ⚠️ 它是**上下文裁剪，不是安全边界**（§8.4）。UI 上不得宣传为权限控制 ——
 * agent 有 shell，`--add-dir` 之外的东西它一样读得到。
 *
 * 返回的顺序**稳定**：按传入的 `projects` 顺序，且**排除 cwd 自己**
 * （`--add-dir` 一个已经在 cwd 里的目录是多余的，而且会让
 * `claude --help` 输出的可及范围看着比实际大）。
 */
export function resolveAddDirs(
  projects: readonly CwdProject[],
  visibleProjectIds: readonly string[] | null,
  cwd: string
): string[] {
  const visible = visibleProjectIds === null ? null : new Set(visibleProjectIds)
  const out: string[] = []
  for (const p of projects) {
    if (visible && !visible.has(p.id)) continue
    if (p.rootPath === cwd) continue
    out.push(p.rootPath)
  }
  return out
}
