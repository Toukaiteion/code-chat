/**
 * M5 验证之三：`collectProjectContext`（§8.5c）。
 *
 * 这一层回答的是用户提出的那个问题 ——「一个角色通过 `--add-dir` 关联了多个项目，
 * 但拿不到那些目录的 CLAUDE.md 吧」。它要读的是**项目的记忆**，所以两条性质比功能更重要：
 *
 * - **顺序必须确定。** 读到的内容会进提示词前缀，而前缀一变缓存就整段失配（§4.6）。
 *   同一棵树扫两次给出不同顺序，等于缓存命中率随机。
 * - **「没读到」必须可见。** §8.5c 性质 5 承诺了这个状态可见，所以失败要记进 `skipped`，
 *   不能安静吞掉 —— 安静的失效正是这一整块设计想消灭的东西。
 *
 * 用例用真文件系统（`mkdtemp` 下的临时目录），不 mock `fs`：这一层的正确性
 * 几乎全在「哪个路径上的东西才算数」上，mock 掉 fs 就等于把要测的东西换成了我的假设。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { FILE_CAP_BYTES, collectProjectContext } from '../../src/main/adapters/claude/project-context.ts'

// ─────────────────────────────────────────────────────────────
// 脚手架
// ─────────────────────────────────────────────────────────────

/** 内容：字符串照写；数字表示「这么多字节的 x」（用来造超限文件）。 */
type Spec = Record<string, string | number>

/** 在临时目录里造一棵树、跑一段、然后删掉。 */
async function withProject<T>(spec: Spec, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'code-chat-ctx-'))
  try {
    for (const [rel, content] of Object.entries(spec)) {
      const abs = join(root, ...rel.split('/'))
      await mkdir(dirname(abs), { recursive: true })
      // 目录：值以 `/` 结尾时只建目录（用来造「名叫 x.md 的目录」这种坑）。
      if (rel.endsWith('/') || content === '') {
        await mkdir(abs, { recursive: true })
        continue
      }
      await writeFile(abs, typeof content === 'number' ? 'x'.repeat(content) : content, 'utf8')
    }
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const relPaths = (files: Array<{ path: string }>): string[] => files.map((f) => f.path)

// ─────────────────────────────────────────────────────────────
// 五种来源
// ─────────────────────────────────────────────────────────────

test('§8.5c 的五类文件全都认得，且顺序就是扫描表的顺序', async () => {
  await withProject(
    {
      'CLAUDE.md': 'a',
      '.claude/CLAUDE.md': 'b',
      'AGENTS.md': 'c',
      '.claude/rules/one.md': 'd',
      '.claude/rules/two.md': 'e',
      '.cursorrules': 'f',
      '.cursor/rules/style.mdc': 'g',
      '.github/copilot-instructions.md': 'h'
    },
    async (root) => {
      const ctx = await collectProjectContext(root)
      assert.deepEqual(relPaths(ctx.files), [
        'CLAUDE.md',
        '.claude/CLAUDE.md',
        'AGENTS.md',
        // 目录内按名字排序 —— 顺序确定是缓存命中的前提。
        '.claude/rules/one.md',
        '.claude/rules/two.md',
        '.cursorrules',
        '.cursor/rules/style.mdc',
        '.github/copilot-instructions.md'
      ])
      assert.deepEqual(
        ctx.files.map((f) => f.kind),
        ['claude-md', 'claude-md', 'agents-md', 'rules', 'rules', 'cursorrules', 'cursorrules', 'copilot']
      )
      assert.equal(ctx.truncated, false)
      assert.deepEqual(ctx.skipped, [])
      assert.equal(ctx.rootPath, root)
    }
  )
})

test('两类的扩展名过滤：`.claude/rules` 只收 .md，`.cursor/rules` 什么都收（Cursor 用 .mdc）', async () => {
  await withProject(
    {
      '.claude/rules/keep.md': 'x',
      '.claude/rules/skip.txt': 'x',
      '.cursor/rules/a.mdc': 'x',
      '.cursor/rules/b.txt': 'x'
    },
    async (root) => {
      const ctx = await collectProjectContext(root)
      assert.deepEqual(relPaths(ctx.files), ['.claude/rules/keep.md', '.cursor/rules/a.mdc', '.cursor/rules/b.txt'])
    }
  )
})

test('**绝不**去读用户全局的 ~/.claude/CLAUDE.md —— 那是私人配置，不属于任何项目', async () => {
  // 这条只能间接验：把「根之外」的东西放好，确认一个都不进结果。
  // 直接断言「没读 homedir」需要 mock fs，而那样测的是我的 mock 而不是代码。
  await withProject({ 'sub/CLAUDE.md': 'x', 'CLAUDE.md': 'y' }, async (root) => {
    const ctx = await collectProjectContext(join(root, 'sub'))
    assert.deepEqual(relPaths(ctx.files), ['CLAUDE.md'], '只认识根下的那一份')
    assert.ok(
      ctx.files.every((f) => resolve(root, 'sub', f.path).startsWith(resolve(root, 'sub') + sep)),
      '每个结果都必须落在请求的根之内'
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 截断
// ─────────────────────────────────────────────────────────────

test('超过 16KB 截断：`bytes` 是**截断前**的，`truncated` 置位', async () => {
  await withProject({ 'CLAUDE.md': FILE_CAP_BYTES + 500 }, async (root) => {
    const ctx = await collectProjectContext(root)
    assert.equal(ctx.truncated, true)
    assert.equal(ctx.files[0].bytes, FILE_CAP_BYTES + 500, 'UI 要说「被截掉了多少」就得知道原始大小')
    assert.equal(ctx.files[0].text.length, FILE_CAP_BYTES)
  })
})

test('正好等于上限：不算截断（边界不能差一个字节）', async () => {
  await withProject({ 'CLAUDE.md': FILE_CAP_BYTES }, async (root) => {
    const ctx = await collectProjectContext(root)
    assert.equal(ctx.truncated, false)
    assert.equal(ctx.files[0].bytes, FILE_CAP_BYTES)
  })
})

test('按字节切，不按字符切 —— 多字节字符不会被切坏成乱码', async () => {
  // 一个中文字 3 字节。上限若是按字符算，这里会多读出一大截。
  await withProject({ 'CLAUDE.md': '中'.repeat(100) }, async (root) => {
    const ctx = await collectProjectContext(root, { cap: 30 })
    assert.equal(ctx.files[0].bytes, 300, '原始字节数如实记录')
    assert.equal(ctx.files[0].text, '中'.repeat(10), '30 字节 = 10 个整字')
  })
})

// ─────────────────────────────────────────────────────────────
// 失败与跳过
// ─────────────────────────────────────────────────────────────

test('ENOENT **不算**跳过 —— 大部分项目本来就没有那些文件', async () => {
  // 把「没有这个文件」记成跳过，会让 `skipped` 在几乎每个项目里都非空，
  // 于是它就不再是信号了。
  await withProject({ 'CLAUDE.md': 'only this one' }, async (root) => {
    const ctx = await collectProjectContext(root)
    assert.deepEqual(ctx.skipped, [])
    assert.equal(ctx.files.length, 1)
  })
})

test('★ 一个名叫 CLAUDE.md 的**目录**：跳过并记档，不是静默失效', async () => {
  // §8.5c 性质 5 承诺「项目记忆没被读到」是可见状态。
  // 这里若不记档，用户会看到一个成功的、空的上下文 —— 那就是安静的失效。
  await withProject({ 'CLAUDE.md/': '', 'AGENTS.md': 'ok' }, async (root) => {
    const ctx = await collectProjectContext(root)
    assert.deepEqual(relPaths(ctx.files), ['AGENTS.md'])
    assert.deepEqual(
      ctx.skipped.map((s) => s.path),
      ['CLAUDE.md']
    )
    assert.ok(ctx.skipped[0].reason, '要给得出原因')
  })
})

test('`.claude/rules/` 里混一个**目录**：不当候选，也不抛', async () => {
  // 名字里带 `.md` 的目录是真实存在的形态。`listDir` 用 dirent 的 `isFile()`
  // 挡在 `readFile` 前面，所以它连候选都不是 —— 这是**对的**：它不是「读不到的记忆」，
  // 它压根不是一个记忆文件。
  await withProject({ '.claude/rules/real.md': 'x', '.claude/rules/fake.md/': '', '.claude/rules/fake.md/inner.md': 'y' }, async (root) => {
    const ctx = await collectProjectContext(root)
    assert.deepEqual(relPaths(ctx.files), ['.claude/rules/real.md'])
    assert.deepEqual(ctx.skipped, [])
  })
})

test('空项目：一个文件都没有，但也不报错', async () => {
  await withProject({}, async (root) => {
    const ctx = await collectProjectContext(root)
    assert.deepEqual(ctx.files, [])
    assert.deepEqual(ctx.skipped, [])
    assert.equal(ctx.truncated, false)
  })
})

test('根目录不存在：不抛，返回空结果（调用方决定怎么呈现）', async () => {
  const ctx = await collectProjectContext(join(tmpdir(), 'code-chat-definitely-not-here-9f3a'))
  assert.deepEqual(ctx.files, [])
  assert.deepEqual(ctx.skipped, [])
})

// ─────────────────────────────────────────────────────────────
// 确定性 —— 缓存命中的前提
// ─────────────────────────────────────────────────────────────

test('扫两次给出**逐字节相同**的顺序（顺序不确定 = 缓存命中率随机）', async () => {
  await withProject(
    { '.claude/rules/zeta.md': '1', '.claude/rules/alpha.md': '2', '.claude/rules/mid.md': '3', 'CLAUDE.md': '4' },
    async (root) => {
      const a = await collectProjectContext(root)
      const b = await collectProjectContext(root)
      assert.deepEqual(relPaths(a.files), relPaths(b.files))
      assert.deepEqual(relPaths(a.files), [
        'CLAUDE.md',
        '.claude/rules/alpha.md',
        '.claude/rules/mid.md',
        '.claude/rules/zeta.md'
      ])
    }
  )
})

test('不写任何去重逻辑：同一份内容在两个位置就是两条记录（探针④未出结论前不许猜）', async () => {
  // §8.5c 明说：「`--add-dir` 带进的 CLAUDE.md 与显式注入的同一份会不会重复」
  // 要用两个可区分的标记串实测一次才能判定。结论出来前不许写去重 —— 这条钉住它。
  await withProject({ 'CLAUDE.md': 'same', '.claude/CLAUDE.md': 'same' }, async (root) => {
    const ctx = await collectProjectContext(root)
    assert.equal(ctx.files.length, 2, '两份都留着，由实测结论决定要不要合并')
  })
})

test('相对路径一律用 `/` 分隔（进提示词与 UI 展示都用它，不掺平台分隔符）', async () => {
  await withProject({ '.claude/rules/a.md': 'x' }, async (root) => {
    const ctx = await collectProjectContext(root)
    for (const f of ctx.files) {
      assert.ok(!f.path.includes('\\'), `${f.path} 里不该有反斜杠`)
      assert.equal(f.path, relative(root, join(root, f.path)).split(sep).join('/'))
    }
  })
})
