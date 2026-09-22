/**
 * M1 关键验证 —— 整个持久化选型押在这个脚本上。
 *
 * 目的：证明 `node:sqlite` 在 Electron 的 Node 运行时里可用，且 FTS5 编译在内。
 * 若这里失败，立刻改用 better-sqlite3，不要继续写持久化代码。
 *
 * 跑法（Git Bash）：
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/m1-sqlite-check.cjs
 * 期望输出最后一行：M1 PASS
 */
const assert = require('node:assert')

function main() {
  console.log('electron:', process.versions.electron ?? '(非 Electron 运行时)')
  console.log('node    :', process.versions.node)

  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(':memory:')

  // 模拟真实连接设置，确认这些 PRAGMA 在该版本上都被接受
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  // 1. 基本往返
  db.exec('CREATE TABLE t(a INTEGER, b TEXT)')
  db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'hello')
  const rows = db.prepare('SELECT * FROM t').all()
  console.log('roundtrip:', JSON.stringify(rows))

  // ★ 实测发现：node:sqlite 返回的行是 **null-prototype 对象**，不是普通对象。
  // 后果必须写进 repository 纪律里：
  //   - assert.deepStrictEqual / 结构化克隆 会因此失败（本脚本最初就栽在这）
  //   - row.hasOwnProperty(...) 之类会抛 TypeError
  //   - JSON.stringify、对象展开、zod 校验都正常
  // 所以 repository 必须把行**显式映射成已知形状**再往上层传，不能原样透传。
  const proto = Object.getPrototypeOf(rows[0])
  console.log('row prototype:', proto === null ? 'null（非 Object.prototype）' : 'Object.prototype')
  assert.strictEqual(proto, null, 'node:sqlite 行的原型不再是 null —— 上面的纪律需要重新评估')

  assert.deepStrictEqual(
    rows.map((r) => ({ ...r })),
    [{ a: 1, b: 'hello' }]
  )

  // 2. 外键约束真的生效（不只是被接受了）
  db.exec('CREATE TABLE parent(id TEXT PRIMARY KEY)')
  db.exec(
    'CREATE TABLE child(id TEXT PRIMARY KEY, pid TEXT REFERENCES parent(id) ON DELETE CASCADE)'
  )
  let fkEnforced = false
  try {
    db.prepare('INSERT INTO child VALUES (?, ?)').run('c1', '不存在')
  } catch {
    fkEnforced = true
  }
  console.log('foreign_keys enforced:', fkEnforced)
  assert.ok(fkEnforced, 'PRAGMA foreign_keys = ON 没有生效 —— 级联删除会静默失效')

  // 3. FTS5
  db.exec('CREATE VIRTUAL TABLE ft USING fts5(body)')
  db.prepare('INSERT INTO ft VALUES (?)').run('neon cyberpunk workspace')
  const hits = db.prepare("SELECT body FROM ft WHERE ft MATCH 'cyberpunk'").all()
  console.log('fts5:', JSON.stringify(hits))
  assert.strictEqual(hits.length, 1)

  // 4. WAL —— 计划里写方在 UI 线程，这条是必需的
  const file = require('node:path').join(require('node:os').tmpdir(), `m1-wal-${process.pid}.db`)
  const dbf = new DatabaseSync(file)
  const mode = dbf.prepare('PRAGMA journal_mode = WAL').get()
  console.log('journal_mode:', JSON.stringify(mode))
  dbf.close()
  require('node:fs').rmSync(file, { force: true })
  require('node:fs').rmSync(file + '-wal', { force: true })
  require('node:fs').rmSync(file + '-shm', { force: true })

  // 5. 偏索引（idx_member_router 用到）
  db.exec('CREATE TABLE m(ws TEXT, is_router INTEGER)')
  db.exec('CREATE UNIQUE INDEX im ON m(ws) WHERE is_router = 1')
  db.prepare('INSERT INTO m VALUES (?, 1)').run('w1')
  let partialWorks = false
  try {
    db.prepare('INSERT INTO m VALUES (?, 1)').run('w1')
  } catch {
    partialWorks = true
  }
  console.log('partial unique index:', partialWorks)
  assert.ok(partialWorks, '偏索引未生效 —— 每空间至多一个路由角色将失去 DB 保证')

  db.close()
  console.log('\nM1 PASS —— node:sqlite 可用于持久化层，无需 better-sqlite3')
}

try {
  main()
} catch (err) {
  console.error('\nM1 FAIL:', err && err.message)
  console.error(err)
  process.exit(1)
}
