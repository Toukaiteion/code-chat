/**
 * M2 验证之一：迁移器。
 *
 * 计划里的验收标准是「迁移重跑幂等」。这里额外覆盖三条**失败模式**，
 * 因为幂等本身很容易做到，难的是出错时不要静默带病前进。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations, currentVersion, MIGRATIONS } from '../../src/main/persist/migrations/index.ts'
import { migration0001 } from '../../src/main/persist/migrations/0001-init.ts'
import type { Migration } from '../../src/main/persist/migrations/types.ts'

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

test('全新库：一次跑完所有迁移', () => {
  const db = freshDb()
  const result = runMigrations(db)
  assert.deepEqual(result.applied, MIGRATIONS.map((m) => m.version))
  assert.equal(result.from, 0)
  assert.equal(result.to, MIGRATIONS[MIGRATIONS.length - 1].version)
  db.close()
})

test('幂等：第二次调用是 no-op', () => {
  const db = freshDb()
  runMigrations(db)
  const before = currentVersion(db)

  const second = runMigrations(db)

  assert.deepEqual(second.applied, [], '重跑不应再执行任何迁移')
  assert.equal(second.from, before)
  assert.equal(second.to, before)
  assert.equal(currentVersion(db), before)
  db.close()
})

test('账本记录了每个迁移的名字与时间', () => {
  const db = freshDb()
  runMigrations(db)
  const rows = db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string; applied_at: number }[]
  assert.equal(rows.length, MIGRATIONS.length)
  for (const r of rows) {
    assert.ok(r.name.length > 0, `版本 ${r.version} 的 name 不应为空`)
    assert.ok(r.applied_at > 0, `版本 ${r.version} 的 applied_at 应为正数`)
  }
  db.close()
})

test('库版本高于代码时必须拒绝启动，而不是静默继续', () => {
  const db = freshDb()
  runMigrations(db)
  // 模拟用户装了更旧的版本：库里出现一个代码不认识的更高版本
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
    999,
    'from-the-future',
    Date.now()
  )

  assert.throws(() => runMigrations(db), /版本 999 高于本应用已知的最高版本/)
  db.close()
})

test('单个迁移失败时回滚，DB 停在上一版本（不留半新半旧）', () => {
  const db = freshDb()
  const ok: Migration = {
    version: 1,
    name: 'ok',
    up: 'CREATE TABLE t1(a INTEGER)'
  }
  const bad: Migration = {
    version: 2,
    name: 'bad',
    // 第二条语句非法 → 整个迁移应回滚，连 t2 都不该留下
    up: 'CREATE TABLE t2(a INTEGER); CREATE TABLE t2(a INTEGER);'
  }

  assert.throws(() => runMigrations(db, [ok, bad]), /迁移 2_bad 执行失败，已回滚/)

  assert.equal(currentVersion(db), 1, '账本应停在第 1 版')
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 't%'")
    .all() as { name: string }[]
  assert.deepEqual(
    tables.map((t) => t.name),
    ['t1'],
    't2 必须被回滚掉'
  )
  db.close()
})

/**
 * ★ v1 → v2 的**升级**路径（M4 新增 0002 时补的）。
 *
 * 这条不是形式主义：用户机器上那个 `userData/code-chat.db` 现在**就是 v1**，
 * 里面还有 M3 期间建出来的空间。装上新版本后第一次启动走的就是这条路径 ——
 * 它必须在**有数据**的库上正确，而不只是在空库上正确。
 */
test('★ v1 → v2 升级：回填 dir_name、建唯一索引，且已有数据不丢', () => {
  const db = freshDb()

  // 1) 先用**只有 0001** 的列表造一个 v1 库 —— 等价于用户现在手里的库。
  assert.deepEqual(runMigrations(db, [migration0001]).applied, [1])

  // 2) 塞几行 M3 时代建的空间（那时没有 dir_name 这一列）。
  const insert = db.prepare(
    `INSERT INTO workspace (id, name, active_project_id, created_at, updated_at, archived_at)
     VALUES (?, ?, NULL, ?, ?, NULL)`
  )
  insert.run('w-old-1', '旧空间一', 100, 100)
  insert.run('w-old-2', '旧空间二', 200, 200)

  // 3) 升到最新版本。
  const result = runMigrations(db)
  assert.deepEqual(result.applied, [2], '只应补跑 0002')
  assert.equal(result.from, 1)
  assert.equal(result.to, 2)

  // 4) 数据还在，且 dir_name 被回填成 id。
  const rows = db
    .prepare('SELECT id, name, dir_name FROM workspace ORDER BY created_at')
    .all() as { id: string; name: string; dir_name: string | null }[]
  assert.equal(rows.length, 2, '升级不能丢数据')
  assert.deepEqual(
    rows.map((r) => [r.id, r.name, r.dir_name]),
    [
      ['w-old-1', '旧空间一', 'w-old-1'],
      ['w-old-2', '旧空间二', 'w-old-2']
    ],
    '历史行的 dir_name 回填成 id —— 与 workspace-repo 的 dirName ?? id 是同一条规则'
  )

  // 5) 唯一索引真的建出来了，而且是**大小写不敏感**的表达式索引。
  const index = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_workspace_dir_name'")
    .get() as { sql: string } | undefined
  assert.ok(index, 'idx_workspace_dir_name 必须存在')
  assert.match(index.sql, /lower\(dir_name\)/, '索引必须建在 lower(dir_name) 上（NTFS 大小写不敏感）')

  db.close()
})

test('★ v2 的唯一索引确实拦得住大小写不同的同名目录', () => {
  const db = freshDb()
  runMigrations(db)
  const insert = db.prepare(
    `INSERT INTO workspace (id, name, dir_name, active_project_id, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, NULL, ?, ?, NULL)`
  )
  insert.run('w1', 'Nova', 'Nova', 1, 1)

  // 磁盘上 `Nova` 与 `nova` 是**同一个目录**，所以 DB 也必须当成同一个。
  assert.throws(
    () => insert.run('w2', 'nova 小写', 'nova', 2, 2),
    /UNIQUE|constraint/i,
    '大小写不同的同名目录必须被索引拦下 —— 否则就是「DB 放行、磁盘撞车」'
  )
  db.close()
})

test('迁移列表本身的静态校验：乱序 / 重复 / 空 up 都要在开发期就炸', () => {
  const db = freshDb()
  const m = (version: number, name = `m${version}`, up = 'SELECT 1'): Migration => ({
    version,
    name,
    up
  })

  assert.throws(() => runMigrations(db, [m(2), m(1)]), /必须按版本升序/)
  assert.throws(() => runMigrations(db, [m(1), m(1)]), /版本号 1 重复/)
  assert.throws(() => runMigrations(db, [m(1, 'x', '   ')]), /up 为空/)
  assert.throws(() => runMigrations(db, [m(0)]), /必须是 ≥1 的整数/)
  db.close()
})
