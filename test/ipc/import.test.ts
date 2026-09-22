/**
 * M4 验证之二：**三种导入方式**里的后两种（§8.2）—— 复制与克隆。
 *
 * 两种都是**真操作**：真目录复制、真 `git clone`。所以这组用例同时也在
 * 证明「`project:copy` / `project:clone` 不再是 defer」这句话是真的
 * （那条清单化的断言在 `registry.test.ts` 里）。
 *
 * ★ clone 的「远端」用的是**本地仓库路径**，因此整组用例**离线可跑** ——
 * 测试不该依赖网络，也不该依赖某个远端仓库一直存在。
 * 需要真 git 在 PATH 上（这几个用例本来就依赖它）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { COPY_SKIP_DIRS } from '../../src/main/infra/fs-ops.ts'
import { spacePaths } from '../../src/main/infra/space-dir.ts'
import {
  commitCount,
  expectFail,
  expectOk,
  harness,
  makeGitRepo,
  tmpRoot
} from './helpers.ts'
import type { Project, Workspace } from '../../src/shared/entities.ts'

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 造一个「像一个真项目」的源目录：源码 + `.git` + 可重装产物。 */
async function makeSourceTree(dir: string): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(dir, 'dist'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })

  await writeFile(join(dir, 'src', 'index.ts'), 'export const a = 1\n')
  await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), '// 依赖\n')
  await writeFile(join(dir, 'dist', 'bundle.js'), '// 构建产物\n')
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
}

// ─────────────────────────────────────────────────────────────
// project:copy
// ─────────────────────────────────────────────────────────────

test('★ copy：保留 .git、跳过 node_modules/dist，源码逐字节一致', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const source = join(root, 'source-tree')
  await makeSourceTree(source)
  const target = join(spacePaths(root, 'Nova').projects, '副本')

  const project = expectOk<Project>(
    await h.call('project:copy', {
      workspaceId: ws.id,
      name: '副本',
      sourcePath: source,
      targetPath: target
    })
  )

  assert.equal(project.origin, 'copy')
  assert.equal(project.rootPath, target)
  // ★ 我们没跟任何远端说过话，所以这两列**留 null** —— 填一个只能是编的。
  assert.equal(project.remoteUrl, null)
  assert.equal(project.defaultBranch, null)

  // 保留的：源码与 `.git`（历史是拷贝不出来的）。
  assert.equal(await readFile(join(target, 'src', 'index.ts'), 'utf8'), 'export const a = 1\n')
  assert.ok(await exists(join(target, '.git', 'HEAD')), '★ .git 必须保留')

  // 跳过的：可重装产物。
  assert.equal(await exists(join(target, 'node_modules')), false, 'node_modules 应当被跳过')
  assert.equal(await exists(join(target, 'dist')), false, 'dist 应当被跳过')

  // 源目录**一个字节都没动**（复制不是移动）。
  assert.ok(await exists(join(source, 'node_modules')))
  assert.ok(await exists(join(source, 'dist')))
})

test('★ 跳过清单是按**目录**判定的 —— 一个叫 build 的文件不该被丢掉', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const source = join(root, 'source-with-file')
  await mkdir(source, { recursive: true })
  // `build` 在跳过清单里 —— 但它是用户写的**脚本**，不是构建产物。
  await writeFile(join(source, 'build'), '#!/bin/sh\necho hi\n')
  await writeFile(join(source, 'README.md'), '# hi\n')

  const target = join(root, 'copy-with-file')
  expectOk(await h.call('project:copy', {
    workspaceId: ws.id,
    name: 'x',
    sourcePath: source,
    targetPath: target
  }))

  assert.equal(
    await readFile(join(target, 'build'), 'utf8'),
    '#!/bin/sh\necho hi\n',
    '同名的**文件**不是构建产物，静默丢掉它是数据丢失'
  )
})

test('copy：跳过清单是具名导出的，UI 才能把它显示给用户', () => {
  // 这不是形式主义：静默跳过会让用户以为整个目录都复制过来了。
  assert.ok(COPY_SKIP_DIRS.includes('node_modules'))
  assert.ok(COPY_SKIP_DIRS.includes('dist'))
  assert.equal(COPY_SKIP_DIRS.includes('.git'), false, '.git 恰恰**不能**在清单里')
})

test('copy：目标已存在且非空 → E_CONFLICT，且不去动那个目录', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const source = join(root, 'source-tree')
  await makeSourceTree(source)
  const target = join(root, 'occupied')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'keep.txt'), '别动我\n')

  const error = expectFail(
    await h.call('project:copy', {
      workspaceId: ws.id,
      name: 'x',
      sourcePath: source,
      targetPath: target
    })
  )
  assert.equal(error.code, 'E_CONFLICT')
  assert.match(error.message, /不是空的/)
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), '别动我\n', '已有的东西不能被碰')
})

test('★ copy：目标在源里面 → E_INVALID_PAYLOAD（否则会递归复制自己）', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const source = join(root, 'source-tree')
  await makeSourceTree(source)

  for (const target of [join(source, 'inner'), join(source, 'a', 'b')]) {
    const error = expectFail(
      await h.call('project:copy', {
        workspaceId: ws.id,
        name: 'x',
        sourcePath: source,
        targetPath: target
      })
    )
    assert.equal(error.code, 'E_INVALID_PAYLOAD', `${target} 在源里面，必须被拦下`)
  }
  // 目标 == 源也一样
  assert.equal(
    expectFail(
      await h.call('project:copy', {
        workspaceId: ws.id,
        name: 'x',
        sourcePath: source,
        targetPath: source
      })
    ).code,
    'E_INVALID_PAYLOAD'
  )
})

test('copy：源不存在 → E_NOT_FOUND；源是文件 → E_INVALID_PAYLOAD', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  assert.equal(
    expectFail(
      await h.call('project:copy', {
        workspaceId: ws.id,
        name: 'x',
        sourcePath: join(root, '不存在'),
        targetPath: join(root, 't1')
      })
    ).code,
    'E_NOT_FOUND'
  )

  const aFile = join(root, 'a.txt')
  await writeFile(aFile, 'x')
  assert.equal(
    expectFail(
      await h.call('project:copy', {
        workspaceId: ws.id,
        name: 'x',
        sourcePath: aFile,
        targetPath: join(root, 't2')
      })
    ).code,
    'E_INVALID_PAYLOAD'
  )
})

// ─────────────────────────────────────────────────────────────
// project:clone
// ─────────────────────────────────────────────────────────────

test('★ clone：本地仓库当远端（离线可跑），完整克隆拿到历史', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const remote = await makeGitRepo(join(root, 'remote-repo'))
  assert.equal(await commitCount(remote), 2)

  const target = join(spacePaths(root, 'Nova').projects, '克隆来的')
  const project = expectOk<Project>(
    await h.call('project:clone', {
      workspaceId: ws.id,
      name: '克隆来的',
      remoteUrl: remote,
      targetPath: target
    })
  )

  assert.equal(project.origin, 'clone')
  assert.equal(project.rootPath, target)
  assert.equal(project.remoteUrl, remote, 'remoteUrl 如实记下用户给的 URL')
  // ★ 分支是**克隆之后读出来的**，不是猜的 `main`。
  assert.equal(project.defaultBranch, 'main')

  // ★ 「完整克隆」不是一句口号：不加 `--depth` 才会把两笔提交都带过来。
  //   浅克隆会让 agent 看不到历史，而那是事后很难改回来的取舍。
  assert.equal(await commitCount(target), 2, '必须是完整克隆（不加 --depth）')

  /**
   * ⚠️ 这里**不能**断言逐字节等于 `'second\n'` —— 实测在本机拿到的是 `'second\r\n'`。
   *
   * 原因不是 bug，而是 §8.2 那条决定的**直接可见后果**：克隆用的是**用户本机的 git**，
   * 我们刻意不清空他的配置。本机 git 的**系统级**配置里有 `core.autocrlf=true`
   * （Git for Windows 的默认值），于是签出时把 LF 换成了 CRLF ——
   * 用户手敲一次 `git clone` 会得到一模一样的结果，这才是对的行为。
   *
   * 对比之下，造仓库的那个测试助手（`makeGitRepo`）是**完全隔离**的
   * （`GIT_CONFIG_NOSYSTEM=1` + `core.autocrlf=false`），所以仓库里存的是 LF。
   * 两条路径的差异正好把这件事照出来了。
   */
  assert.match(await readFile(join(target, 'SECOND.md'), 'utf8'), /^second\r?\n$/)
})

test('clone：目标已存在且非空 → E_CONFLICT（目标为空则放行）', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))
  const remote = await makeGitRepo(join(root, 'remote-repo'))

  const occupied = join(root, 'occupied')
  await mkdir(occupied, { recursive: true })
  await writeFile(join(occupied, 'x.txt'), 'x')

  const error = expectFail(
    await h.call('project:clone', {
      workspaceId: ws.id,
      name: 'x',
      remoteUrl: remote,
      targetPath: occupied
    })
  )
  assert.equal(error.code, 'E_CONFLICT')
  assert.match(error.message, /不是空的/)

  // 空目录是允许的 —— git 自己能往空目录里克隆。
  const empty = join(root, 'empty-target')
  await mkdir(empty, { recursive: true })
  assert.ok(
    expectOk(
      await h.call('project:clone', {
        workspaceId: ws.id,
        name: 'x',
        remoteUrl: remote,
        targetPath: empty
      })
    )
  )
})

test('clone：远端不存在时如实报错，并尽力回收半成品目录', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const target = join(root, 'never-created')
  const error = expectFail(
    await h.call('project:clone', {
      workspaceId: ws.id,
      name: 'x',
      remoteUrl: join(root, '没有这个仓库'),
      targetPath: target
    })
  )
  assert.equal(error.code, 'E_INTERNAL')
  assert.match(error.message, /克隆失败/)

  // 留个半成品比留个空目录更糟：用户下一次会撞上「目标已存在」而不知道为什么。
  assert.equal(await exists(target), false, '失败的克隆目录应被回收')
  // 也确认一下没有落库。
  assert.deepEqual(expectOk<unknown[]>(await h.call('project:list', { workspaceId: ws.id })), [])
})

test('★ clone：找不到 git 时给出人话错误，并说清**找过哪里**', async () => {
  const root = tmpRoot()
  // `gitPath: null` 就是「本机没装 git」—— 这条分支能自动跑，正是
  // `SysCapabilities` 走注入换来的。否则验它只能靠人肉卸一次 git。
  const h = harness({ root, gitPath: null })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const error = expectFail(
    await h.call('project:clone', {
      workspaceId: ws.id,
      name: 'x',
      remoteUrl: 'https://example.com/x.git',
      targetPath: join(root, 't')
    })
  )
  assert.equal(error.code, 'E_NOT_FOUND')
  assert.match(error.message, /找不到 git/)
  assert.match(error.message, /CODE_CHAT_GIT_PATH/, '要告诉用户那个正式的出口')

  const hint = error.detail as { candidates: string[]; pathEntries: string[] }
  assert.ok(Array.isArray(hint.candidates) && hint.candidates.length > 0, 'detail 里要带上找过的名字')
  assert.ok(Array.isArray(hint.pathEntries), 'detail 里要带上查过的 PATH')

  // 关键：连目录都不该建出来 —— 我们压根没走到那一步。
  assert.equal(await exists(join(root, 't')), false)
})

// ─────────────────────────────────────────────────────────────
// project:remove 的副本处理
// ─────────────────────────────────────────────────────────────

test('★ project:remove：copy 型副本只在显式要求时删，其余情况留下并说明', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))
  const source = join(root, 'source-tree')
  await makeSourceTree(source)

  // ① 不勾选 → 留下，并说明原因。
  const kept = expectOk<Project>(
    await h.call('project:copy', {
      workspaceId: ws.id,
      name: '留着的',
      sourcePath: source,
      targetPath: join(root, 'copy-kept')
    })
  )
  const keptReport = expectOk<{ deleted: boolean; copy: { state: string; reason: string | null } }>(
    await h.call('project:remove', { id: kept.id })
  )
  assert.equal(keptReport.deleted, true)
  assert.equal(keptReport.copy.state, 'kept')
  assert.match(keptReport.copy.reason ?? '', /没有勾选/)
  assert.ok(await exists(kept.rootPath), '没勾选就不该删')

  // ② 勾选 → 真的删掉，状态是 removed。
  const doomed = expectOk<Project>(
    await h.call('project:copy', {
      workspaceId: ws.id,
      name: '要删的',
      sourcePath: source,
      targetPath: join(root, 'copy-doomed')
    })
  )
  const removedReport = expectOk<{ deleted: boolean; copy: { state: string } }>(
    await h.call('project:remove', { id: doomed.id, deleteCopy: true })
  )
  assert.equal(removedReport.copy.state, 'removed')
  assert.equal(await exists(doomed.rootPath), false, '勾了就该真的删掉')
  assert.ok(await exists(source), '源目录照样一个字节都不动')
})

test('project:remove：目录已经不在时记 absent，而不是假装删掉了', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))
  const source = join(root, 'source-tree')
  await makeSourceTree(source)

  const project = expectOk<Project>(
    await h.call('project:copy', {
      workspaceId: ws.id,
      name: 'x',
      sourcePath: source,
      targetPath: join(root, 'copy-gone')
    })
  )
  await rm(project.rootPath, { recursive: true, force: true })

  const report = expectOk<{ copy: { state: string } }>(
    await h.call('project:remove', { id: project.id, deleteCopy: true })
  )
  assert.equal(report.copy.state, 'absent', '「本来就不在」不是「我们删的」')
})

test('project:list 同时展示三种来源', async () => {
  const root = tmpRoot()
  const h = harness({ root })
  const ws = expectOk<Workspace>(await h.call('workspace:create', { name: 'Nova' }))

  const localDir = join(root, 'local-dir')
  await mkdir(localDir, { recursive: true })
  const source = join(root, 'source-tree')
  await makeSourceTree(source)
  const remote = await makeGitRepo(join(root, 'remote-repo'))

  expectOk(await h.call('project:addLocal', { workspaceId: ws.id, name: '原地', rootPath: localDir }))
  expectOk(
    await h.call('project:copy', {
      workspaceId: ws.id,
      name: '复制',
      sourcePath: source,
      targetPath: join(root, 'copy-1')
    })
  )
  expectOk(
    await h.call('project:clone', {
      workspaceId: ws.id,
      name: '克隆',
      remoteUrl: remote,
      targetPath: join(root, 'clone-1')
    })
  )

  const projects = expectOk<Project[]>(await h.call('project:list', { workspaceId: ws.id }))
  assert.deepEqual(
    projects.map((p) => p.origin).sort(),
    ['clone', 'copy', 'local'],
    '★ 验收标准里的「三种方式各加一个项目」'
  )
})
