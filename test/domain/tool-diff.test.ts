/**
 * M6a 验证之二：`file_diff` 的**合成器**（`src/main/domain/tool-diff.ts`）。
 *
 * 这个模块存在的唯一理由是 §8.9-17：`file_diff` 有一个已定的形状、一个已定的渲染位，
 * 却在 M5 结束时**零个生产者** —— 一个「契约里有、永远收不到」的事件类型。
 * 那种缺失不会报错，只会让界面安静地少一块。
 *
 * 所以这里验的重点不是"diff 格式对不对"，而是三件更容易出错的事：
 *
 * 1. **它不许猜位置**：patch 里没有行号、没有 `@@`，因为工具真的执行发生在之后，
 *    任何一次读文件都是 TOCTOU（那个文件的说明里写了三条理由）。
 * 2. **它不许编原文**：`Write` 覆盖之前的原文我们从未见过，编一整份"删除"出来
 *    就是在展示一个不存在的改动。
 * 3. **不认识的东西要能上报**：`looksLikeEditor()` 是让这类缺失"再也无法安静复发"
 *    的那一半 —— 只做 `null` 的话，界面上少一块和"本来就没有"完全无法区分。
 *
 * 夹具用的是 `scripts/evidence/m5-2026-09-23T12-47-39-267Z/main.ndjson` 里那次
 * **真的 Edit**（逐字），不是我想出来的形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  displayPath,
  looksLikeEditor,
  synthesizeFileDiff
} from '../../src/main/domain/tool-diff.ts'

/** 归档里那次 Edit 的 workspace 根，逐字。 */
const ARCHIVE_CWD = 'G:\\project\\code-chat\\scripts\\out\\m5-2026-09-23T12-47-39-267Z\\ws'

/** 归档里那次 Edit 的 `input`，逐字。 */
const ARCHIVE_EDIT_INPUT = {
  replace_all: false,
  file_path: `${ARCHIVE_CWD}\\src\\a.ts`,
  old_string: 'export const x = 1',
  new_string: 'export const x = 2'
}

// ─────────────────────────────────────────────────────────────
// 一、真归档的那次 Edit
// ─────────────────────────────────────────────────────────────

test('★ 归档里那次真实 Edit：一行走、一行来，路径被相对化', () => {
  const d = synthesizeFileDiff('Edit', ARCHIVE_EDIT_INPUT, ARCHIVE_CWD)
  assert.ok(d)
  assert.equal(d.path, 'src/a.ts', '在 cwd 之下就相对化 —— 用户看的是项目结构，不是盘符')
  assert.equal(d.patch, ['-export const x = 1', '+export const x = 2'].join('\n'))
})

test('★ patch 里**没有**行号、没有 `@@` —— 位置是未知的，不许用数字盖住', () => {
  const d = synthesizeFileDiff('Edit', ARCHIVE_EDIT_INPUT, ARCHIVE_CWD)
  assert.ok(d)
  assert.ok(!d.patch.includes('@@'), '编出来的行号会把「我猜的位置」伪装成「它的位置」')
  assert.ok(!/^\d/m.test(d.patch), '连一个行号似的数字都不该出现')
})

test('内容行的首字符永远是 `-` 或 `+`（所以 `#` 注释不可能与内容混淆）', () => {
  // 构造一个原文里**本身就有** `# 注释` 的编辑 —— 这正是最容易撞车的形状。
  const d = synthesizeFileDiff(
    'Edit',
    { file_path: 'G:/w/a.py', old_string: '# 注释\nx = 1', new_string: 'x = 2' },
    'G:/w'
  )
  assert.ok(d)
  assert.equal(d.patch, ['-# 注释', '-x = 1', '+x = 2'].join('\n'), '原文的 # 必须长成 -#')
})

test('多处替换会在 patch 头上如实标注 —— 逐行看，改一处和改三处一模一样', () => {
  const d = synthesizeFileDiff(
    'Edit',
    { file_path: 'G:/w/a.ts', old_string: 'x', new_string: 'y', replace_all: true },
    'G:/w'
  )
  assert.ok(d)
  assert.match(d.patch.split('\n')[0] ?? '', /^# replace_all/, '不写这一行，用户会以为只改了一处')
})

test('`replace_all: false` 时那行注释**不出现**（默认情形不许被噪声污染）', () => {
  const d = synthesizeFileDiff('Edit', ARCHIVE_EDIT_INPUT, ARCHIVE_CWD)
  assert.ok(d)
  assert.ok(!d.patch.includes('replace_all'))
})

// ─────────────────────────────────────────────────────────────
// 二、Write：不许编出「覆盖前的原文」
// ─────────────────────────────────────────────────────────────

test('★ Write：全是 `+` 行，且**明说**覆盖前的原文未知', () => {
  const d = synthesizeFileDiff('Write', { file_path: 'G:/w/new.ts', content: 'a\nb\n' }, 'G:/w')
  assert.ok(d)
  assert.equal(d.path, 'new.ts')
  assert.equal(
    d.patch,
    ['# 整文件写入：覆盖前的原文未知（未读取文件）', '+a', '+b'].join('\n'),
    '★ 不许编一份删除出来的原文 —— 我们从未见过它'
  )
})

test('Write 的空文件：只有那句注释，没有假的空行', () => {
  const d = synthesizeFileDiff('Write', { file_path: 'G:/w/empty.ts', content: '' }, 'G:/w')
  assert.ok(d)
  assert.equal(d.patch.split('\n').length, 1)
})

// ─────────────────────────────────────────────────────────────
// 三、尾随换行 —— 唯一容易算错的地方
// ─────────────────────────────────────────────────────────────

test('★ `"a\\nb\\n"` 是**两行**，不是三行 —— 否则每次编辑都多出一个空行', () => {
  // 一个用户会当成真改动去排查的假象：文件末尾"多了一个空行"。
  const d = synthesizeFileDiff('Edit', { file_path: 'G:/w/a.ts', old_string: 'a\nb\n', new_string: 'c\n' }, 'G:/w')
  assert.ok(d)
  assert.equal(d.patch, ['-a', '-b', '+c'].join('\n'))
})

test('没有尾随换行时也不多算一行', () => {
  const d = synthesizeFileDiff('Edit', { file_path: 'G:/w/a.ts', old_string: 'a\nb', new_string: 'c' }, 'G:/w')
  assert.ok(d)
  assert.equal(d.patch, ['-a', '-b', '+c'].join('\n'))
})

test('原文为空串 → 一个 `-` 行都不产生（新增，不是"删了一行空的"）', () => {
  const d = synthesizeFileDiff('Edit', { file_path: 'G:/w/a.ts', old_string: '', new_string: '新内容' }, 'G:/w')
  assert.ok(d)
  assert.equal(d.patch, '+新内容')
})

// ─────────────────────────────────────────────────────────────
// 四、路径展示
// ─────────────────────────────────────────────────────────────

test('cwd 为空时保留绝对路径（宁可长，不可瞎猜）', () => {
  assert.equal(displayPath('G:/w/a.ts', null), 'G:/w/a.ts')
})

test('cwd 之外的文件保留绝对路径 —— 以 `..` 开头的"相对路径"比绝对路径更难读', () => {
  // 而且它其实是在说「这个文件不在你这个项目的目录里」，那正是该被看见的信息。
  assert.equal(displayPath('G:/other/a.ts', 'G:/w'), 'G:/other/a.ts')
})

test('Windows 上的分隔符统一成正斜杠 —— 与 git、与用户看惯的写法一致', () => {
  assert.equal(displayPath('G:\\w\\src\\a.ts', 'G:\\w'), 'src/a.ts')
})

test('本来就是相对路径的，原样返回（不拿 cwd 再拼一次）', () => {
  assert.equal(displayPath('src/a.ts', 'G:/w'), 'src/a.ts')
})

// ─────────────────────────────────────────────────────────────
// 五、认不出来的时候：`null` + 一条能报警的诊断依据
// ─────────────────────────────────────────────────────────────

test('不改文件的工具 → `null`，且**不**算「看起来会改文件」', () => {
  assert.equal(synthesizeFileDiff('Read', { file_path: 'G:/w/a.ts' }, 'G:/w'), null)
  assert.equal(synthesizeFileDiff('Bash', { command: 'rm -rf' }, 'G:/w'), null)
  assert.equal(looksLikeEditor('Read'), false)
  assert.equal(looksLikeEditor('Bash'), false)
})

test('★ 会改文件但没有映射表 → `null` **且** `looksLikeEditor` 为真（调用方据此报警）', () => {
  // 这是 §8.9-17 那种缺失"再也无法安静复发"的那一半：只返回 null 的话，
  // 「工具改了文件、界面上什么都没有」与「本来就没改」在界面上完全一样。
  assert.equal(synthesizeFileDiff('MultiEdit', { file_path: 'G:/w/a.ts' }, 'G:/w'), null)
  assert.equal(looksLikeEditor('MultiEdit'), true)
  assert.equal(looksLikeEditor('NotebookEdit'), true)
  // 有映射表的那两个不许被误报成"没映射"。
  assert.equal(looksLikeEditor('Edit'), false)
  assert.equal(looksLikeEditor('Write'), false)
})

test('形状不对（缺 file_path / 少了 new_string）→ `null`，不是崩、也不是半条 diff', () => {
  assert.equal(synthesizeFileDiff('Edit', {}, 'G:/w'), null)
  assert.equal(synthesizeFileDiff('Edit', { file_path: 'G:/w/a.ts' }, 'G:/w'), null)
  assert.equal(synthesizeFileDiff('Edit', null, 'G:/w'), null)
  assert.equal(synthesizeFileDiff('Edit', '不是对象', 'G:/w'), null)
  assert.equal(synthesizeFileDiff('Edit', ['数组也不行'], 'G:/w'), null)
  assert.equal(synthesizeFileDiff('Write', { file_path: 'G:/w/a.ts' }, 'G:/w'), null, 'Write 要 content')
})

test('`replace_all` 不是布尔时按 `false` 处理 —— 只有 `=== true` 才算', () => {
  const d = synthesizeFileDiff(
    'Edit',
    { file_path: 'G:/w/a.ts', old_string: 'x', new_string: 'y', replace_all: 'yes' },
    'G:/w'
  )
  assert.ok(d)
  assert.ok(!d.patch.includes('replace_all'), '不该凭一个真值就宣称「多处已替换」')
})
