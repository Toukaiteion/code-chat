/**
 * M4 验证之三：**§六 的验收标准本身**。
 *
 * > `origin='local'` 的项目**删空间后目录仍在**
 *
 * 这条为什么值得单独一个文件、单独一组用例：它是整个里程碑里**唯一一条
 * 一旦做错就没有补救机会**的约束 —— 删掉的是用户自己的源码目录，
 * 没有回收站、没有撤销。所以这里不满足于「测过」，而是：
 *
 * 1. 用**哨兵文件的内容 + mtime + 目录条目**三重比对「逐字节仍在」；
 * 2. 把「副本清理」那条路上**每一道闸**都单独撞一次，确认它真的拦得住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { isSamePath, removeQuietly } from '../../src/main/infra/fs-ops.ts'
import { spacePaths } from '../../src/main/infra/space-dir.ts'
import { NOW, expectOk, harness, tmpRoot } from './helpers.ts'
import type { ProjectOrigin, Workspace } from '../../src/shared/entities.ts'

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 记下「这个目录是什么样」—— 用来事后证明它**一个字节都没动**。 */
async function fingerprint(dir: string): Promise<{
  entries: string[]
  content: string
  mtimeMs: number
  size: number
}> {
  const info = await stat(join(dir, 'sentinel.txt'))
  return {
    entries: (await readdir(dir)).sort(),
    content: await readFile(join(dir, 'sentinel.txt'), 'utf8'),
    mtimeMs: info.mtimeMs,
    size: info.size
  }
}

async function makeSentinelDir(dir: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sentinel.txt'), text, 'utf8')
}

/** 直接落一行项目 —— 用来造 `copy`/`clone` 型，或者造出正常人建不出来的路径。 */
function seedProject(
  h: ReturnType<typeof harness>,
  workspaceId: string,
  id: string,
  name: string,
  rootPath: string,
  origin: ProjectOrigin
): void {
  h.store.repos.project.create({ id, workspaceId, name, rootPath, origin, now: NOW })
}

// ─────────────────────────────────────────────────────────────
// ★★ 验收标准
// ─────────────────────────────────────────────────────────────

test('★★ 验收标准：删空间后，origin=local 的目录逐字节仍在', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  // 用户的目录**在空间目录外面**（这才是常态：原地引用的是他已有的工程）。
  const userDir = join(tmpRoot(), '我的真实项目')
  await makeSentinelDir(userDir, '这些字节不许被动\n')
  await writeFile(join(userDir, 'code.ts'), 'export const keep = true\n')

  expectOk(
    await h.call('project:addLocal', { workspaceId: ws.id, name: '真实项目', rootPath: userDir })
  )
  const before = await fingerprint(userDir)

  // 连勾都不勾 → 删
  const report = expectOk<{
    deleted: boolean
    copies: Array<{ state: string }>
    workspaceDir: string
  }>(await h.call('workspace:delete', { id: ws.id }))

  assert.equal(report.deleted, true)
  assert.equal(report.copies.length, 1)
  assert.equal(report.copies[0].state, 'kept')

  const after = await fingerprint(userDir)
  assert.deepEqual(after.entries, before.entries, '目录条目一致')
  assert.equal(after.content, before.content, '内容逐字节一致')
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs, 'mtime 没变 = 连写都没写过')

  // 记录没了，目录还在 —— 这两件事必须同时为真。
  assert.deepEqual(expectOk(await h.call('workspace:list')), [])
})

test('★★ 验收标准（更硬的一版）：勾了「同时删除副本」，local 目录照样不动', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const userDir = join(tmpRoot(), '用户的目录')
  await makeSentinelDir(userDir, '不许动\n')
  expectOk(await h.call('project:addLocal', { workspaceId: ws.id, name: 'x', rootPath: userDir }))

  const before = await fingerprint(userDir)
  const report = expectOk<{ copies: Array<{ state: string; reason: string | null }> }>(
    await h.call('workspace:delete', { id: ws.id, deleteCopies: true })
  )

  // ★ 不只是「没删」，而是**明确说清了为什么没删** —— 用户勾了却什么都没发生，
  //   界面上一声不响是最糟的交互。
  assert.equal(report.copies[0].state, 'kept')
  assert.match(report.copies[0].reason ?? '', /原地引用/)

  assert.deepEqual(await fingerprint(userDir), before, 'local 目录必须逐字节不动')
})

test('★ 副本只在勾选时被删；没勾时连碰都不碰', async () => {
  const root = tmpRoot()
  const h = harness({ root })

  // ① 不勾选
  const ws1 = expectOk<Workspace>(await h.call('workspace:create', { name: '甲' }))
  const dir1 = join(tmpRoot(), '甲-副本')
  await makeSentinelDir(dir1, '副本一\n')
  seedProject(h, ws1.id, 'p1', '副本', dir1, 'copy')

  const r1 = expectOk<{ copies: Array<{ state: string }> }>(
    await h.call('workspace:delete', { id: ws1.id })
  )
  assert.equal(r1.copies[0].state, 'kept')
  assert.ok(await exists(dir1), '没勾选就不该删')

  // ② 勾选
  const ws2 = expectOk<Workspace>(await h.call('workspace:create', { name: '乙' }))
  const dir2 = join(tmpRoot(), '乙-副本')
  await makeSentinelDir(dir2, '副本二\n')
  seedProject(h, ws2.id, 'p2', '副本', dir2, 'clone')

  const r2 = expectOk<{ copies: Array<{ state: string }> }>(
    await h.call('workspace:delete', { id: ws2.id, deleteCopies: true })
  )
  assert.equal(r2.copies[0].state, 'removed')
  assert.equal(await exists(dir2), false, '勾了就该真的删掉')
})

test('副本已经不在磁盘上 → absent，既不是成功也不是失败', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))
  seedProject(h, ws.id, 'p1', '早就没了', join(tmpRoot(), '不存在'), 'copy')

  const report = expectOk<{ copies: Array<{ state: string; reason: string | null }> }>(
    await h.call('workspace:delete', { id: ws.id, deleteCopies: true })
  )
  assert.equal(report.copies[0].state, 'absent')
  assert.equal(report.copies[0].reason, null)
})

// ─────────────────────────────────────────────────────────────
// ★ 每一道闸各撞一次
// ─────────────────────────────────────────────────────────────

test('★ 闸一：盘根被拒绝删除', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  // 用当前盘根（win32 上是 `G:\`，posix 上是 `/`）—— 不写死，跟着跑测试的机器走。
  const driveRoot = parse(resolve(process.cwd())).root
  seedProject(h, ws.id, 'p1', '盘根', driveRoot, 'copy')

  const report = expectOk<{ copies: Array<{ state: string; reason: string | null }> }>(
    await h.call('workspace:delete', { id: ws.id, deleteCopies: true })
  )
  assert.equal(report.copies[0].state, 'failed')
  assert.match(report.copies[0].reason ?? '', /盘根/)
  assert.ok(await exists(driveRoot), '盘根当然还在')
})

test('★ 闸二：包含 workspaceRoot 的路径被拒绝删除', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  // `workspacesRoot` 的**上级**：删它等于连所有空间一起端掉。
  seedProject(h, ws.id, 'p1', '太宽了', parse(root).root, 'copy')

  const report = expectOk<{ copies: Array<{ state: string; reason: string | null }> }>(
    await h.call('workspace:delete', { id: ws.id, deleteCopies: true })
  )
  // 盘根那一闸会先命中（`root` 的上级就是盘根）—— 只要拦下来了就对。
  assert.equal(report.copies[0].state, 'failed')
  assert.ok(report.copies[0].reason)

  // 再试一个**不是**盘根、但包含 workspaceRoot 的路径。用一个新的空间 ——
  // 上面那个连同它的项目行已经被级联删掉了，再往里塞项目只会撞外键。
  const ws2 = expectOk<Workspace>(await h.call('workspace:create', { name: '另一个' }))
  const parent = join(root, '..')
  seedProject(h, ws2.id, 'p2', '上级', parent, 'copy')

  const report2 = expectOk<{ copies: Array<{ state: string; reason: string | null }> }>(
    await h.call('workspace:delete', { id: ws2.id, deleteCopies: true })
  )
  assert.equal(report2.copies[0].state, 'failed')
  assert.match(report2.copies[0].reason ?? '', /工作空间根目录/)
  assert.ok(await exists(root), 'workspaceRoot 一个字节都不能少')
})

test('★ 闸三：空间目录本身被拒绝删除', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))
  const wsDir = spacePaths(root, 'Nova').root

  seedProject(h, ws.id, 'p1', '空间目录', wsDir, 'copy')

  const report = expectOk<{ copies: Array<{ state: string; reason: string | null }> }>(
    await h.call('workspace:delete', { id: ws.id, deleteCopies: true })
  )
  assert.equal(report.copies[0].state, 'failed')
  assert.match(report.copies[0].reason ?? '', /空间目录/)
  assert.ok(await exists(wsDir))
})

test('★ 闸四（最要紧的一道）：包含 local 项目目录的路径被拒绝删除', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const outside = tmpRoot()
  const userProject = join(outside, 'user-project')
  await makeSentinelDir(userProject, '真实源码\n')

  // 本空间一个 local 项目 + 一个路径更宽的 copy 副本。
  expectOk(
    await h.call('project:addLocal', { workspaceId: ws.id, name: '真实', rootPath: userProject })
  )
  seedProject(h, ws.id, 'p-wide', '宽副本', outside, 'copy')

  const report = expectOk<{
    copies: Array<{ path: string; state: string; reason: string | null }>
  }>(await h.call('workspace:delete', { id: ws.id, deleteCopies: true }))

  const wide = report.copies.find((c) => c.path === resolve(outside))
  assert.ok(wide)
  assert.equal(wide.state, 'failed')
  assert.match(wide.reason ?? '', /原地引用/)

  // ★ 真正要证明的：用户的源码完好无损。
  assert.equal(await readFile(join(userProject, 'sentinel.txt'), 'utf8'), '真实源码\n')
})

test('闸四查的是**全库**的 local 项目，不只看本空间', async () => {
  const root = tmpRoot()
  const h = harness({ root })

  // 空间乙里有一个 local 项目……
  const ws2 = expectOk<Workspace>(await h.call('workspace:create', { name: '乙' }))
  const outside = tmpRoot()
  await makeSentinelDir(join(outside, '乙的项目'), '乙的源码\n')
  expectOk(
    await h.call('project:addLocal', {
      workspaceId: ws2.id,
      name: '乙的',
      rootPath: join(outside, '乙的项目')
    })
  )

  // ……而**空间甲**的一个副本恰好指着它的上级。
  const ws1 = expectOk<Workspace>(await h.call('workspace:create', { name: '甲' }))
  seedProject(h, ws1.id, 'p-wide', '宽副本', outside, 'copy')

  const report = expectOk<{ copies: Array<{ state: string; reason: string | null }> }>(
    await h.call('workspace:delete', { id: ws1.id, deleteCopies: true })
  )
  assert.equal(report.copies[0].state, 'failed', '只在当前空间里查是不够的')
  assert.ok(await exists(join(outside, '乙的项目')), '别的空间的用户目录同样不能被删')
})

test('副本路径变成一个文件时，拒绝删除而不是把它删掉', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const filePath = join(tmpRoot(), '其实是文件')
  await writeFile(filePath, 'x')

  seedProject(h, ws.id, 'p1', '文件', filePath, 'copy')
  const report = expectOk<{ copies: Array<{ state: string; reason: string | null }> }>(
    await h.call('workspace:delete', { id: ws.id, deleteCopies: true })
  )
  assert.equal(report.copies[0].state, 'failed')
  assert.match(report.copies[0].reason ?? '', /不是一个目录/)
  assert.ok(await exists(filePath))
})

// ─────────────────────────────────────────────────────────────
// removeQuietly 本身
// ─────────────────────────────────────────────────────────────

test('removeQuietly：只读文件也删得掉（Windows 上 git 的 pack 文件天然只读）', async () => {
  const dir = tmpRoot()
  const nested = join(dir, 'repo', '.git', 'objects')
  await mkdir(nested, { recursive: true })
  const readonlyFile = join(nested, 'pack-abc.pack')
  await writeFile(readonlyFile, 'binary-ish')
  const { chmod } = await import('node:fs/promises')
  await chmod(readonlyFile, 0o444)

  const result = await removeQuietly(dir)
  assert.equal(result.removed, true, `删不掉的话删空间就会留下一堆只读的 .git`)
  assert.equal(result.reason, null)
  assert.equal(await exists(dir), false)
})

test('removeQuietly：目标本来就不在也算「现在它不在了」（force 吞掉 ENOENT）', async () => {
  const result = await removeQuietly(join(tmpRoot(), '从来就不存在'))
  assert.equal(result.removed, true)
})

test('removeQuietly：删不掉时带回原因，而不是假装成功', async () => {
  // 一个**确定失败**的路径：NUL 字节在 Windows 上是非法路径字符，
  // `fs.rm` 会抛 ERR_INVALID_ARG_VALUE。用它把「失败分支」逼出来 ——
  // 而失败分支的要点是**它返回而不是抛**：删不掉是一种要上报的结果，不是异常。
  const result = await removeQuietly('C:\\bad\u0000name')

  assert.equal(result.removed, false)
  assert.ok(result.reason && result.reason.length > 0, '失败必须带上人话原因')
})

test('isSamePath 在 Windows 上大小写不敏感', async () => {
  if (process.platform !== 'win32') return
  assert.equal(isSamePath('C:\\Work\\Proj', 'c:\\work\\proj'), true)
  assert.equal(isSamePath('C:\\work', 'C:\\workshop'), false)
})
