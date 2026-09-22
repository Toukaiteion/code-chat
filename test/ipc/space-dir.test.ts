/**
 * `infra/space-dir.ts` 的穷举测试 —— **纯函数，不碰磁盘**。
 *
 * 这个文件是「把磁盘布局逻辑从 `paths.ts` 里拆出来」那个决定的直接回报：
 * `paths.ts` import 了 electron，测试进不去；而「空间名 → 目录名」正是
 * **最该被穷举**的一段 —— Windows 的非法字符、保留设备名、尾部点与空格、
 * 大小写不敏感……每一条都能安静地坑用户（建出来的目录和他以为的不是同一个），
 * 而且都不会报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  buildManifest,
  MAX_DIR_NAME,
  pickDirName,
  sanitizeDirName,
  spaceDir,
  spacePaths,
  SPACE_SUBDIRS
} from '../../src/main/infra/space-dir.ts'

// ─────────────────────────────────────────────────────────────
// sanitizeDirName
// ─────────────────────────────────────────────────────────────

test('sanitizeDirName：剥掉 Windows 非法字符', () => {
  assert.equal(sanitizeDirName('a<b>c:d"e/f\\g|h?i*j'), 'abcdefghij')
  // 控制字符（含 \t \n \0）直接**去掉**而不是换成空格 —— 它们本来就不是内容。
  assert.equal(sanitizeDirName('a\u0000b\tc\nd'), 'abcd')
})

test('sanitizeDirName：中文原样保留 —— 这是个中文应用', () => {
  // 音译成拼音才是真的糟糕：用户在资源管理器里认不出自己的空间。
  assert.equal(sanitizeDirName('前端重构'), '前端重构')
  assert.equal(sanitizeDirName('Nova 计划'), 'Nova 计划')
})

test('sanitizeDirName：首尾空白与连续空白归一', () => {
  assert.equal(sanitizeDirName('  Nova   Orion  '), 'Nova Orion')
})

test('sanitizeDirName：尾部的点和空格必须去掉 —— Windows 会悄悄吃掉它们', () => {
  // 不去的话，我们以为的路径是 `Nova.`，磁盘上却是 `Nova` —— 两者对不上，
  // 而且**不会有任何报错**。
  assert.equal(sanitizeDirName('Nova.'), 'Nova')
  assert.equal(sanitizeDirName('Nova...'), 'Nova')
  assert.equal(sanitizeDirName('Nova '), 'Nova')
  assert.equal(sanitizeDirName('Nova . . '), 'Nova')
})

test('sanitizeDirName：Windows 保留设备名要避开（大小写不敏感，且带扩展名也算）', () => {
  for (const bad of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    const out = sanitizeDirName(bad)
    assert.notEqual(out.toLowerCase(), bad.toLowerCase(), `${bad} 是保留设备名，不能直接用`)
    assert.equal(out, `_${bad}`)
  }
  // `CON.txt` 的**主名**是 CON，同样保留。
  assert.equal(sanitizeDirName('CON.txt'), '_CON.txt')
  // 只是**以**保留名开头则没问题。
  assert.equal(sanitizeDirName('console'), 'console')
})

test('sanitizeDirName：净化后什么都不剩 → 兜底为 space', () => {
  assert.equal(sanitizeDirName('***'), 'space')
  assert.equal(sanitizeDirName('   '), 'space')
  assert.equal(sanitizeDirName('...'), 'space')
  assert.equal(sanitizeDirName(''), 'space')
})

test('sanitizeDirName：超长要截断到 64 字符', () => {
  const long = 'x'.repeat(200)
  assert.equal(sanitizeDirName(long).length, MAX_DIR_NAME)
  // 保留名加前缀后也可能超长 —— 那一步之后再截一次（否则会超出上限）。
  assert.ok(sanitizeDirName(`CON.${'y'.repeat(200)}`).length <= MAX_DIR_NAME)
})

// ─────────────────────────────────────────────────────────────
// pickDirName
// ─────────────────────────────────────────────────────────────

test('pickDirName：不冲突就用原名', () => {
  assert.equal(pickDirName('Nova', new Set()), 'Nova')
  assert.equal(pickDirName('Nova', new Set(['Orion'])), 'Nova')
})

test('pickDirName：撞了就往后加序号 —— Nova → Nova-2 → Nova-3', () => {
  assert.equal(pickDirName('Nova', new Set(['Nova'])), 'Nova-2')
  assert.equal(pickDirName('Nova', new Set(['Nova', 'Nova-2'])), 'Nova-3')
  // 中间被占也无所谓，一直往后找。
  assert.equal(pickDirName('Nova', new Set(['Nova', 'Nova-3'])), 'Nova-2')
})

test('★ pickDirName：大小写不敏感 —— NTFS 上 Nova 与 nova 是同一个目录', () => {
  // 这条是「DB 放行、磁盘撞车」的经典来源：SQLite 的普通唯一索引区分大小写，
  // NTFS 不区分。两边必须用同一套规则。
  assert.equal(pickDirName('nova', new Set(['Nova'])), 'nova-2')
  assert.equal(pickDirName('NOVA', new Set(['nova'])), 'NOVA-2')
})

test('pickDirName：加序号后仍然不超长', () => {
  const base = 'x'.repeat(MAX_DIR_NAME)
  const out = pickDirName(base, new Set([base]))
  assert.ok(out.length <= MAX_DIR_NAME, `${out.length} 不该超过 ${MAX_DIR_NAME}`)
  assert.match(out, /-2$/)
})

// ─────────────────────────────────────────────────────────────
// 布局
// ─────────────────────────────────────────────────────────────

test('spaceDir / spacePaths：一个空间目录 + 七项', () => {
  const root = join('C:', 'root')
  assert.equal(spaceDir(root, 'Nova'), join(root, 'Nova'))

  const paths = spacePaths(root, 'Nova')
  assert.equal(paths.root, join(root, 'Nova'))
  assert.equal(paths.manifest, join(root, 'Nova', 'workspace.json'))
  for (const sub of SPACE_SUBDIRS) {
    assert.equal(paths[sub], join(root, 'Nova', sub), `${sub} 的路径算错了`)
  }
})

test('SPACE_SUBDIRS 与 §8.3 的结构一致（顺序即创建顺序）', () => {
  assert.deepEqual(
    [...SPACE_SUBDIRS],
    ['memory', 'index', 'blobs', 'logs', 'scratch', 'projects']
  )
})

// ─────────────────────────────────────────────────────────────
// workspace.json
// ─────────────────────────────────────────────────────────────

test('buildManifest：能解析、带格式号、**不含**会过期的成员与可见性', () => {
  const text = buildManifest({ id: 'w1', name: 'Nova', dirName: 'Nova', createdAt: 123 })

  // 末尾换行：让它是个正常的文本文件，人改了之后 git diff 也好看。
  assert.ok(text.endsWith('\n'))

  const parsed = JSON.parse(text) as Record<string, unknown>
  assert.equal(parsed.format, 1)
  assert.equal(parsed.id, 'w1')
  assert.equal(parsed.name, 'Nova')
  assert.equal(parsed.dirName, 'Nova')
  assert.equal(parsed.createdAt, 123)
  assert.equal(typeof parsed._note, 'string')

  /**
   * ★ 这是对 §8.3 原描述的**有意修订**，所以钉在测试里：
   * 铭牌里**不镜像**成员与可见性 —— 那会变成一个会悄悄过期的第二事实源
   * （§8.3 自己也说冲突时以 DB 为准）。用户会信一个写在磁盘上的清单。
   */
  assert.equal('members' in parsed, false, '铭牌不该镜像成员')
  assert.equal('projects' in parsed, false, '铭牌不该镜像项目')
  assert.equal('visibility' in parsed, false, '铭牌不该镜像可见性')
})
