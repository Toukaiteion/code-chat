/**
 * M4 验证之一：**建空间真的在磁盘上建出那棵树**（§8.3）。
 *
 * 这组用例是「`SysCapabilities` 走注入」那个决定的直接回报：`workspacesRoot()`
 * 在测试里指向一个临时目录，于是「建空间 / 改名 / 撞名 / 删空间」这几条
 * **真的动了磁盘**的路径可以在裸 Node 下跑完 —— 不用起 Electron，
 * 也不会往用户的 `userData/workspaces` 里写任何东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SPACE_SUBDIRS, spacePaths } from '../../src/main/infra/space-dir.ts'
import { NOW, expectOk, harness, makeProject, tmpRoot } from './helpers.ts'
import type { Workspace } from '../../src/shared/entities.ts'

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

test('★ 建空间：当场在磁盘上建出 7 项 + workspace.json 铭牌', async () => {
  const root = tmpRoot()
  const h = harness({ root })

  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))
  assert.equal(ws.dirName, 'Nova')

  const paths = spacePaths(root, 'Nova')
  const entries = (await readdir(paths.root)).sort()
  assert.deepEqual(
    entries,
    [...SPACE_SUBDIRS, 'workspace.json'].sort(),
    '空间目录下应当正好是这七项 + 铭牌'
  )

  // 铭牌内容能被解析，且名字对得上 ——「文件存在」不等于「文件是对的」。
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as Record<string, unknown>
  assert.equal(manifest.id, ws.id)
  assert.equal(manifest.name, 'Nova')
  assert.equal(manifest.dirName, 'Nova')
  assert.equal(manifest.createdAt, NOW)
})

test('撞名：第二个 Nova 落到 Nova-2，且两个目录都在', async () => {
  const root = tmpRoot()
  const h = harness({ root })

  assert.equal(expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' })).dirName, 'Nova')
  assert.equal(
    expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' })).dirName,
    'Nova-2'
  )

  assert.ok(await exists(spacePaths(root, 'Nova').root))
  assert.ok(await exists(spacePaths(root, 'Nova-2').root))
})

test('★ 改名：重写铭牌，但**目录名与目录位置都不动**', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const renamed = expectOk<Workspace>(await h.call('workspace:update', { id: ws.id, name: 'Orion' }))
  assert.equal(renamed.name, 'Orion')
  assert.equal(renamed.dirName, 'Nova', 'dir_name 一经确定就不再变')

  // 目录还在老地方，没有出现 `Orion` 这个目录。
  assert.ok(await exists(spacePaths(root, 'Nova').root), '空间目录不该被移动')
  assert.equal(await exists(spacePaths(root, 'Orion').root), false, '改名不该建出新目录')

  // 铭牌被重写：用户打开 workspace.json 看到的应是新名字。
  const manifest = JSON.parse(
    await readFile(spacePaths(root, 'Nova').manifest, 'utf8')
  ) as Record<string, unknown>
  assert.equal(manifest.name, 'Orion')
  assert.equal(manifest.dirName, 'Nova', '铭牌里也如实写着目录名没变')
})

test('改名时目录不存在（M4 之前建的空间）不报错，也不会顺手建一个', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  // 直接落一行，dirName 是 id —— 正是迁移 0002 给历史行回填出来的形状。
  const old = h.store.repos.workspace.create({ id: 'w-old', name: '旧空间', now: NOW })

  const renamed = expectOk<Workspace>(await h.call('workspace:update', { id: old.id, name: '新名字' }))
  assert.equal(renamed.name, '新名字')
  assert.equal(await exists(spacePaths(root, 'w-old').root), false, '改名不该有建目录的副作用')
})

test('★ workspace:paths 默认只读；ensure:true 才真的建目录', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const old = h.store.repos.workspace.create({ id: 'w-old', name: '旧空间', now: NOW })

  // 默认：如实说「不存在」，而且**不许**改磁盘。
  const dry = expectOk<{ exists: boolean; rootPath: string; projectsPath: string }>(
    await h.call('workspace:paths', { id: old.id })
  )
  assert.equal(dry.exists, false)
  assert.equal(dry.rootPath, spacePaths(root, 'w-old').root)
  assert.equal(
    dry.projectsPath,
    join(spacePaths(root, 'w-old').root, 'projects'),
    '默认落点要能算出 projects/'
  )
  assert.equal(await exists(dry.rootPath), false, '一个叫 paths 的查询不该改磁盘')

  // ensure:true：显式要求落地，返回的 exists 就是 true。
  const made = expectOk<{ exists: boolean; rootPath: string }>(
    await h.call('workspace:paths', { id: old.id, ensure: true })
  )
  assert.equal(made.exists, true)
  assert.deepEqual((await readdir(made.rootPath)).sort(), [...SPACE_SUBDIRS, 'workspace.json'].sort())
})

test('★ 删空间：空间目录**永不删除**，且在报告里说清它留在哪', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const report = expectOk<{
    deleted: boolean
    workspaceDir: string
    workspaceDirExists: boolean
  }>(await h.call('workspace:delete', { id: ws.id }))

  assert.equal(report.deleted, true)
  assert.equal(report.workspaceDir, resolve(spacePaths(root, 'Nova').root))
  assert.equal(report.workspaceDirExists, true)
  assert.ok(await exists(spacePaths(root, 'Nova').root), '空间目录必须留在磁盘上')
  // 内容也还在 —— 不是只留了个空壳。
  assert.ok(await exists(spacePaths(root, 'Nova').scratch))
})

test('删一个不存在的空间：如实回 deleted:false，而不是假装删掉了', async () => {
  const h = harness()
  const report = expectOk<{ deleted: boolean; workspaceDir: string | null }>(
    await h.call('workspace:delete', { id: '没有这个空间' })
  )
  assert.equal(report.deleted, false)
  assert.equal(report.workspaceDir, null)
})

test('project:defaultTarget：算的是 <空间>/projects/<净化后的项目名>，且不碰磁盘', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const { path } = expectOk<{ path: string }>(
    await h.call('project:defaultTarget', { workspaceId: ws.id, name: '我的 项目' })
  )
  assert.equal(path, join(spacePaths(root, 'Nova').projects, '我的 项目'))
  assert.equal(await exists(path), false, '只算路径，不建目录')

  // ★ 项目名是**用户输入**，而它的返回值会被当成路径的单段名字 —— 必须净化，
  //   否则一个带 `..\` 的名字能把默认落点指到空间目录外面去。
  const escaped = expectOk<{ path: string }>(
    await h.call('project:defaultTarget', { workspaceId: ws.id, name: '..\\..\\other' })
  )
  assert.equal(escaped.path, join(spacePaths(root, 'Nova').projects, '....other'))
})

test('deleteCopies 只作用于 copy/clone；local 型永远只是被「如实拒绝」', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  // 两个 local 型项目，路径在磁盘上真的存在（用临时目录里的两个真目录）。
  const a = join(root, 'user-dir-a')
  const b = join(root, 'user-dir-b')
  await h.call('workspace:paths', { id: ws.id, ensure: true })
  const { mkdir } = await import('node:fs/promises')
  await mkdir(a, { recursive: true })
  await mkdir(b, { recursive: true })
  makeProject(h.store, ws.id, 'p-a', 'A', a)
  makeProject(h.store, ws.id, 'p-b', 'B', b)

  const report = expectOk<{
    copies: Array<{ path: string; state: string; reason: string | null }>
  }>(await h.call('workspace:delete', { id: ws.id, deleteCopies: true }))

  assert.equal(report.copies.length, 2)
  for (const copy of report.copies) {
    assert.equal(copy.state, 'kept', 'local 型无论标志如何都不删')
    assert.match(copy.reason ?? '', /原地引用/)
  }
  assert.ok(await exists(a), 'local 目录必须一个字节都不动')
  assert.ok(await exists(b))
})
