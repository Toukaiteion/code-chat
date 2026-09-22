/**
 * M3 验证之二：错误 → 信封的映射。
 *
 * ★ 这个文件存在的根本理由：**`ipcMain.handle` 跨边界时会丢掉自定义错误字段**
 * （只留 message 与序列化后的 stack）。而 M2 的 repository 恰恰靠 `errcode`
 * 区分约束类型（2067 = 唯一约束、787 = 外键…）。靠抛异常等于主动扔掉
 * 唯一能区分「目录已存在」和「成员已有主项目」的信息。
 *
 * 所以这里既测**合成**的 SqliteError（覆盖真实库不好造的分支），
 * 也测**真实**的——直接从一个内存库触发，确认 errcode 真的是我们以为的那些值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../../src/main/persist/index.ts'
import { AppError, NotFoundError, toEnvelope } from '../../src/main/ipc/errors.ts'
import { unwrap, IpcError } from '../../src/shared/ipc/envelope.ts'
import { expectFail, harness, makeActor } from './helpers.ts'

// ─────────────────────────────────────────────────────────────
// 真实的 SqliteError：errcode 到底是什么，实测而不是照记忆写
// ─────────────────────────────────────────────────────────────

test('真实的主键冲突 → E_CONFLICT（实测 errcode 1555）', () => {
  const store = openStore(':memory:')
  // ⚠️ `dirName` 必须显式给且**互不相同**。迁移 0002 加了
  // `UNIQUE INDEX ON workspace(lower(dir_name))`，而默认 `dirName ?? id`
  // 会让两行的 dir_name 一样 —— 于是先撞上的是那个唯一索引（2067），
  // 这条用例就从「主键冲突」悄悄变成了「唯一索引冲突」。显式区分才是它想测的东西。
  store.repos.workspace.create({ id: 'w1', name: 'A', dirName: 'dir-a', now: 1 })

  let caught: unknown
  try {
    store.repos.workspace.create({ id: 'w1', name: '重复的 id', dirName: 'dir-b', now: 2 })
  } catch (err) {
    caught = err
  }

  const envelope = toEnvelope(caught)
  const error = expectFail(envelope)
  assert.equal(error.code, 'E_CONFLICT')
  assert.equal((error.detail as { errcode: number }).errcode, 1555)
})

test('真实的外键违约 → E_FK_MISSING（实测 errcode 787）', () => {
  const store = openStore(':memory:')

  let caught: unknown
  try {
    // workspace_id 指向不存在的空间
    store.repos.project.create({
      id: 'p1',
      workspaceId: '不存在',
      name: 'x',
      rootPath: 'G:/x',
      origin: 'local',
      now: 1
    })
  } catch (err) {
    caught = err
  }

  const error = expectFail(toEnvelope(caught))
  assert.equal(error.code, 'E_FK_MISSING')
  assert.equal((error.detail as { errcode: number }).errcode, 787)
})

test('真实的偏索引冲突 → E_CONFLICT（每空间至多一个路由角色）', () => {
  const store = openStore(':memory:')
  const w = store.repos.workspace.create({ id: 'w1', name: 'A', now: 1 })
  const a1 = store.repos.actor.create({ id: 'a1', name: 'A1', model: 'm', personaPath: 'p', personaHash: 'h', now: 1 })
  const a2 = store.repos.actor.create({ id: 'a2', name: 'A2', model: 'm', personaPath: 'p', personaHash: 'h', now: 1 })
  const m1 = store.repos.member.create({ id: 'm1', workspaceId: w.id, actorId: a1.id, displayName: '一', now: 1 })
  const m2 = store.repos.member.create({ id: 'm2', workspaceId: w.id, actorId: a2.id, displayName: '二', now: 1 })
  store.repos.member.setRouter(m1.id, true, 1)

  let caught: unknown
  try {
    store.repos.member.setRouter(m2.id, true, 1)
  } catch (err) {
    caught = err
  }

  // ★ 这条证明的是 §3.2 那句话：「交给 DB 而不是应用代码」真的生效了。
  const error = expectFail(toEnvelope(caught))
  assert.equal(error.code, 'E_CONFLICT')
  assert.equal((error.detail as { errcode: number }).errcode, 2067)
})

// ─────────────────────────────────────────────────────────────
// 兜底映射的其它分支
// ─────────────────────────────────────────────────────────────

test('SqliteError 里我们没专门处理的 errcode → E_INTERNAL，但 errcode 仍留在 detail', () => {
  const error = expectFail(toEnvelope({ code: 'ERR_SQLITE_ERROR', errcode: 9999, message: '?' }))
  assert.equal(error.code, 'E_INTERNAL')
  assert.equal((error.detail as { errcode: number }).errcode, 9999)
})

test('普通 Error → E_INTERNAL，message 原样带出去', () => {
  const error = expectFail(toEnvelope(new Error('磁盘满了')))
  assert.equal(error.code, 'E_INTERNAL')
  assert.equal(error.message, '磁盘满了')
})

test('AppError 的 code 与 detail 被完整保留（这正是抛异常做不到的事）', () => {
  const error = expectFail(
    toEnvelope(new AppError('E_CONFLICT', '这个目录已经加过了', { projectId: 'p1', rootPath: 'G:/a' }))
  )
  assert.equal(error.code, 'E_CONFLICT')
  assert.deepEqual(error.detail, { projectId: 'p1', rootPath: 'G:/a' })
})

test('NotFoundError 带上 id', () => {
  const error = expectFail(toEnvelope(new NotFoundError('工作空间', 'w9')))
  assert.equal(error.code, 'E_NOT_FOUND')
  assert.deepEqual(error.detail, { id: 'w9' })
})

test('detail 不可序列化时信封本身仍然成立 —— 信封绝不能因为 detail 而失败', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular

  const error = expectFail(toEnvelope(new AppError('E_INTERNAL', '带循环引用', circular)))
  assert.equal(error.code, 'E_INTERNAL')
  assert.equal(typeof error.detail, 'string', '降级成字符串说明，而不是抛出去')
})

test('detail 里的 undefined 值不留在信封里（结构化克隆的行为在不同 Electron 版本上不一致）', () => {
  const error = expectFail(toEnvelope(new AppError('E_INTERNAL', 'x', { a: 1, b: undefined })))
  assert.deepEqual(error.detail, { a: 1 })
})

test('非 Error 的抛出物 → E_INTERNAL，不炸', () => {
  assert.equal(expectFail(toEnvelope('一个字符串')).code, 'E_INTERNAL')
  assert.equal(expectFail(toEnvelope(undefined)).code, 'E_INTERNAL')
})

// ─────────────────────────────────────────────────────────────
// 渲染侧的 unwrap：失败必须抛 IpcError，而不是返回 undefined
// ─────────────────────────────────────────────────────────────

test('unwrap 成功时给数据，失败时抛 IpcError（带着 code 与 detail）', () => {
  assert.equal(unwrap({ ok: true, data: 42 }), 42)

  try {
    unwrap({ ok: false, error: { code: 'E_NOT_FOUND', message: '没了', detail: { id: 'x' } } })
    assert.fail('失败信封必须抛异常')
  } catch (err) {
    assert.ok(err instanceof IpcError, '必须是 IpcError，让调用方能用 instanceof 区分')
    assert.equal(err.code, 'E_NOT_FOUND')
    assert.deepEqual(err.detail, { id: 'x' })
  }
})

// ─────────────────────────────────────────────────────────────
// 端到端：domain 语义翻译留在 handler 层，而不在全局映射器里
// ─────────────────────────────────────────────────────────────

test('handler 层的语义翻译：同一个 UNIQUE 违约，得到的是人话而不是 SQLite 原文', async () => {
  const h = harness()
  await makeActor(h, 'Atlas')

  // 撞的是 actor.name 的 UNIQUE，但用户看到的是「已经有一个叫 Atlas 的角色了」。
  // 注意这里**故意给一个不存在的 personaPath** —— 重名检查在**读文件之前**，
  // 所以先被报出来的是重名。顺序反过来的话，用户会先去修一个根本不是问题的文件。
  const error = expectFail(
    await h.call('actor:create', { name: 'Atlas', model: 'm', personaPath: '不存在的文件.md' })
  )
  assert.equal(error.code, 'E_CONFLICT')
  assert.match(error.message, /已经有一个叫「Atlas」的角色了/)
  assert.doesNotMatch(error.message, /UNIQUE|constraint|2067/i, 'SQLite 原文不该出现在用户可见的文案里')

  // 反证：没写语义翻译的路径上，兜底映射仍然给出正确的**码**，只是文案通用。
  // 这里用真实的唯一违约触发一次 —— 同一个 actor 名字在实体层已挡住，
  // 所以直接对 repository 造成的冲突走 `toEnvelope`。
  const store = h.store
  store.repos.workspace.create({ id: 'w-dup', name: 'A', dirName: 'dir-x', now: 1 })
  let caught: unknown
  try {
    store.repos.workspace.create({ id: 'w-dup', name: 'A', dirName: 'dir-y', now: 2 })
  } catch (err) {
    caught = err
  }
  const generic = expectFail(toEnvelope(caught))
  assert.equal(generic.code, 'E_CONFLICT')
  assert.equal(generic.message, '该操作与已有数据冲突')
  assert.deepEqual(generic.detail, { errcode: 1555 })
})
