import type { Migration } from './types.ts'

/**
 * 0002 —— `workspace.dir_name`（§8.3，M4）。
 *
 * M4 是第一个真正通文件系统的里程碑：建空间要当场在
 * `<workspaceRoot>/<dirName>/` 下落一棵树，所以「这个空间对应哪一层目录」
 * 必须有个**稳定**的答案。
 *
 * 为什么存下来而不是每次从 `name` 推：
 * - 目录名要去重（`Nova` 撞了就有 `Nova-2`），纯函数推不出「我是第几个」；
 * - 改名**不动目录**（三条理由见 `infra/space-dir.ts`），所以目录名一经确定就与
 *   `name` 解耦了 —— 从 `name` 推的话，用户改完名会发现我们算出的路径指向一个不存在的地方。
 *
 * 为什么历史行回填成 `id`：M4 之前建的空间**磁盘上根本没有目录**（那时不通文件系统），
 * 所以不存在「与既有目录保持一致」的约束，拿 id 当目录名既无害又稳定。
 * 这条回填规则与 `workspace-repo.ts` 里 `dirName ?? id` 的兜底是**同一条规则**。
 *
 * 为什么唯一索引建在 `lower(dir_name)` 上：**NTFS 默认大小写不敏感**，
 * `Nova` 与 `nova` 在磁盘上是同一个目录，而 SQLite 的普通唯一索引区分大小写 ——
 * 不处理这个落差就会「DB 放行、磁盘撞车」。`pickDirName` 那边同样按小写归一化比较。
 */
const migration0002: Migration = {
  version: 2,
  name: 'workspace-dir-name',
  up: /* sql */ `
-- SQLite 的 ADD COLUMN 加不了 NOT NULL（除非给常量默认值），所以列在 SQL 层是可空的。
-- 紧跟着的 UPDATE 把它填满；映射层还有一次 ?? id 兜底（防手工改库）。
ALTER TABLE workspace ADD COLUMN dir_name TEXT;

-- 历史行：M4 之前没有目录，用 id 当目录名。id 唯一，所以这一步天然满足下面的唯一索引。
UPDATE workspace SET dir_name = id WHERE dir_name IS NULL;

-- 表达式索引：一个空间目录只能属于一个空间，且大小写不敏感（见文件头）。
CREATE UNIQUE INDEX idx_workspace_dir_name ON workspace (lower(dir_name));
`
}

export { migration0002 }
