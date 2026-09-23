/**
 * M6b 验证之四：diff 行的分类（`src/shared/live/patch-lines.ts`）。
 *
 * 这里验的不是「解析对不对」，而是**分类错的时候界面不会报错**这件事：
 * 把 `# 整文件写入…` 染成新增行，用户会以为文件里真有那一行；
 * 把一行删减吞掉，他会以为我们的改动比实际小。
 *
 * 夹具是 `tool-diff.ts` 真的会产出的两种形状（那两个 patch 在本文件里
 * 与 `frame-buffer.test.ts` 用的是同一份字面量 —— 同一份语法被两处测试引用，
 * 各自钉住不同的一面）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPatch, countChanges } from '../../src/shared/live/patch-lines.ts'

const EDIT_PATCH =
  '# replace_all：该替换在文件里出现多次，每一处都已被替换\n-export const x = 1\n+export const x = 2'
const WRITE_PATCH = '# 整文件写入：覆盖前的原文未知（未读取文件）\n+第一行\n+第二行'

test('★ `#` 开头的是**注释**，不是内容（不许当成新增行着色）', () => {
  const lines = classifyPatch(WRITE_PATCH)
  assert.deepEqual(lines[0], { kind: 'note', text: '# 整文件写入：覆盖前的原文未知（未读取文件）' })
  assert.equal(lines[1]?.kind, 'add')
  assert.equal(lines[1]?.text, '第一行', '内容里那一个 `+` 必须被剥掉')
})

test('Edit 的形状：注释 + 全部 `-` 再全部 `+`，顺序原样保留', () => {
  assert.deepEqual(classifyPatch(EDIT_PATCH), [
    { kind: 'note', text: '# replace_all：该替换在文件里出现多次，每一处都已被替换' },
    { kind: 'del', text: 'export const x = 1' },
    { kind: 'add', text: 'export const x = 2' }
  ])
})

test('★ 语法之外的行原样留下（`raw`），**不许丢** —— 丢了界面少一行而没人知道', () => {
  // `@@` 与上下文行**不该出现**（格式定死了没有它们），但真出现时：
  // 静默吞掉是最坏的选择，其次是猜它的意思，最好的是如实显示。
  const lines = classifyPatch('@@ -1,3 +1,4 @@\n context line\n+x')
  assert.deepEqual(lines, [
    { kind: 'raw', text: '@@ -1,3 +1,4 @@' },
    { kind: 'raw', text: ' context line' },
    { kind: 'add', text: 'x' }
  ])
})

test('末尾的换行**不是**一行空行（`split` 的残留要被丢掉）', () => {
  // 不丢的话每个 diff 末尾都多一条空转的行 —— 界面上看不出是错，只是每块 diff
  // 都比它该有的样子高一行。
  assert.equal(classifyPatch('+a\n').length, 1)
  assert.equal(classifyPatch('+a').length, 1)
})

test('中间的空行是**真**空行，要留下（空行落到 `raw` 是合法的）', () => {
  assert.deepEqual(classifyPatch('+a\n\n+b'), [
    { kind: 'add', text: 'a' },
    { kind: 'raw', text: '' },
    { kind: 'add', text: 'b' }
  ])
})

test('空 patch → 空数组（不是一条空行）', () => {
  assert.deepEqual(classifyPatch(''), [])
})

test('★ 增删计数只数增删 —— 注释不算进去', () => {
  // 把注释算成改动行，用户看到的数字会比实际大，而他会拿这个数字判断改动规模。
  assert.deepEqual(countChanges(classifyPatch(EDIT_PATCH)), { added: 1, removed: 1 })
  assert.deepEqual(countChanges(classifyPatch(WRITE_PATCH)), { added: 2, removed: 0 })
  assert.deepEqual(countChanges([]), { added: 0, removed: 0 })
})

test('删掉的那一行里含 `+`、新增的那一行里含 `-`（首字符才是分类依据）', () => {
  // 「按包含关系判断」是很自然的写法，而它在这里直接把两次改动对调。
  const lines = classifyPatch('-a + b\n+c - d')
  assert.deepEqual(lines, [
    { kind: 'del', text: 'a + b' },
    { kind: 'add', text: 'c - d' }
  ])
})
