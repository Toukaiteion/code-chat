/**
 * M7a 验证之二：`src/main/domain/context-builder.ts` —— 上下文装配。
 *
 * 这个模块存在的理由是 M7a 探针推翻的那条设计前提。原设计（§4.6）说历史要
 * 「逐条传递，因为 prefix 缓存以消息为界」；**实测是反的**（逐字见 `m7a-probe.ts`
 * 与 `scripts/evidence/m7a-2026-09-23T16-51-08-216Z`）：
 * 写进 stdin 的**多条消息 = 多轮**（3 行 → 2 条 `result`），而内层 `role` 只能是 `user`。
 *
 * 所以这里验的不是「格式对不对」，而是四件**错了不会报错**的事：
 *
 * 1. **cwd 的项目记忆不许进两遍。** CLI 自己会注入 cwd 的 `CLAUDE.md` 与
 *    `.claude/CLAUDE.md`（实测），我们再放一份就是内容重复 —— 白花钱，且
 *    会让模型把同一段约定当成两段。**但 `--add-dir` 目录里的那份必须由我们带**，
 *    因为 CLI 不带它。这一对方向相反的决定是本文件最贵的两条断言。
 * 2. **剔掉的东西要有出处。** 剔了不写进提示词，模型会以为 cwd 没有 `CLAUDE.md`，
 *    于是它可能自己造一份约定（§8.5c 性质 5）。
 * 3. **缓存前缀要保得住。** 第 N 轮的数组必须是第 N+1 轮的**前缀** ——
 *    这是 §4.1 那条「扁平化的纯追加 join 不破坏缓存」的分析，固定成可执行的事实。
 * 4. **压缩的摘要不许被逐条读。** `markCompacted` 把同一段摘要在每条被压掉的
 *    消息上各写一遍，逐条读会把摘要重复 N 遍（§6.4）。权威只有一个：会话水位线。
 *
 * 夹具里的历史正文取自真归档 `scripts/evidence/m5-2026-09-23T12-47-39-267Z/main.ndjson`
 * 里那条最终回答（逐字），不是我想出来的形状 —— 它有换行、有反引号围栏、有中文引号、
 * 有 Windows 反斜杠路径，正好用来钉「正文逐字进、不做任何清洗」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../../src/main/domain/context-builder.ts'
import type {
  ContextBuildDeps,
  ContextBuildInput,
  HistoryMessage
} from '../../src/main/domain/context-builder.ts'
import type { ProjectContext, ProjectContextKind } from '../../src/main/adapters/agent-adapter.ts'
import type { TextReadResult } from '../../src/main/infra/text-file.ts'

/** 归档里那条最终回答，逐字（JSON 转义后的原文，见文件头）。 */
const ARCHIVE_TEXT =
  "三件事逐条如实回答：\n\n**1. 系统提示词里的 `MK-SYS-…` 标记串**\n\n有。原样抄出：\n\n```\nMK-SYS-c19f6\n```\n\n**2. 我能看到的 `CLAUDE.md` 及其 `MK-…` 标记串**\n\n需要区分两种情况，我如实说明：\n\n- **被自动注入到我上下文的**（作为 project instructions）：只有 1 个\n  - `G:\\project\\code-chat\\scripts\\out\\m5-2026-09-23T12-47-39-267Z\\ws\\CLAUDE.md` → 标记 `MK-CWD-7f31a`\n- **注入时没有出现，是我用 Glob 搜出来后主动 Read 的**（即：它们的内容不是我一开始就“看得到”的，是我去读了才有）：\n  - `G:\\project\\code-chat\\scripts\\out\\m5-2026-09-23T12-47-39-267Z\\extra-a\\CLAUDE.md` → 标记 `MK-DIRA-2b90c`\n  - `G:\\project\\code-chat\\scripts\\out\\m5-2026-09-23T12-47-39-267Z\\extra-b\\CLAUDE.md` → 标记 `MK-DIRB-5e4d8`\n\n补充一条事实：我最初尝试用 Glob 枚举 `G:\\project\\code-chat\\scripts\\out\\m5-2026-09-23T12-47-39-267Z\\` 整个目录时**被权限拒绝了**（提示未授予读取权限），所以我没有该目录的完整文件清单；上面 extra-a / extra-b 两个结果，是我改用这两个附加工作目录作为 Glob 根目录才拿到的。除此之外我没有看到其他 `CLAUDE.md`。\n\n**3. 修改 `src/a.ts`**\n\n已真的调用 Edit 工具完成。文件 `...\\ws\\src\\a.ts`：\n\n- 修改前：`export const x = 1`\n- 修改后：`export const x = 2`\n\n工具返回：`The file ...\\ws\\src\\a.ts has been updated successfully.`"

const CWD = 'G:/ws/proj-a'
const ADD = 'G:/ws/proj-b'
const PERSONA = 'G:/ws/personas/nyx.md'
const ROLE = 'G:/ws/roles/reviewer.md'
const PERSONA_HASH = 'h-persona'
const ROLE_HASH = 'h-role'

const CWD_CLAUDE_MD = 'CWD 根的记忆'
const CWD_DOT_CLAUDE_MD = 'CWD 私有目录的记忆'
const CWD_AGENTS_MD = 'AGENTS 的记忆'
const CWD_RULE = '规则的记忆'
const ADD_CLAUDE_MD = '项目B 的记忆'

function okText(path: string, text: string, hash: string): TextReadResult {
  const bytes = Buffer.byteLength(text, 'utf8')
  return { ok: true, path, text, bytes, returnedBytes: bytes, truncated: false, hash }
}

function kindOf(path: string): ProjectContextKind {
  if (path === 'AGENTS.md') return 'agents-md'
  if (path.startsWith('.claude/rules/')) return 'rules'
  return 'claude-md'
}

function ctxOf(
  rootPath: string,
  files: ReadonlyArray<readonly [string, string]>,
  extra: Partial<ProjectContext> = {}
): ProjectContext {
  return {
    rootPath,
    files: files.map(([path, text]) => ({
      kind: kindOf(path),
      path,
      bytes: Buffer.byteLength(text, 'utf8'),
      text
    })),
    truncated: false,
    skipped: [],
    ...extra
  }
}

/**
 * 两条注入缝的假实现。**记下被问了什么** —— 「问了哪些 root」本身就是断言的对象
 * （少问一个 = 那个项目的记忆静默消失）。
 */
function fakeDeps(fixture: {
  projects?: Record<string, ProjectContext>
  texts?: Record<string, TextReadResult>
}): { deps: ContextBuildDeps; asked: { roots: string[]; reads: string[] } } {
  const asked = { roots: [] as string[], reads: [] as string[] }
  const deps: ContextBuildDeps = {
    async readText(path) {
      asked.reads.push(path)
      return (
        fixture.texts?.[path] ?? {
          ok: false,
          path,
          code: 'ENOENT',
          reason: '读取失败（ENOENT）'
        }
      )
    },
    async collectProjectContext(rootPath) {
      asked.roots.push(rootPath)
      return (
        fixture.projects?.[rootPath] ?? { rootPath, files: [], truncated: false, skipped: [] }
      )
    }
  }
  return { deps, asked }
}

/** 默认夹具：cwd 有四个记忆文件、`--add-dir` 有一个、人设与职责都读得到。 */
function stdFixture(): {
  projects: Record<string, ProjectContext>
  texts: Record<string, TextReadResult>
} {
  return {
    projects: {
      [CWD]: ctxOf(CWD, [
        ['CLAUDE.md', CWD_CLAUDE_MD],
        ['.claude/CLAUDE.md', CWD_DOT_CLAUDE_MD],
        ['AGENTS.md', CWD_AGENTS_MD],
        ['.claude/rules/style.md', CWD_RULE]
      ]),
      [ADD]: ctxOf(ADD, [['CLAUDE.md', ADD_CLAUDE_MD]])
    },
    texts: {
      [PERSONA]: okText(PERSONA, '你叫 Nyx，负责后端。', PERSONA_HASH),
      [ROLE]: okText(ROLE, '你负责审查别人写的代码。', ROLE_HASH)
    }
  }
}

function msg(over: Partial<HistoryMessage> & { seq: number }): HistoryMessage {
  return {
    id: `m-${over.seq}`,
    role: 'user',
    authorMemberId: null,
    authorName: null,
    text: `第 ${over.seq} 条`,
    injectMode: 'full',
    ...over
  }
}

function inputOf(over: Partial<ContextBuildInput> = {}): ContextBuildInput {
  return {
    turn: { id: 'turn-1', sessionId: 'sess-1', workspaceId: 'ws-1' },
    actor: { name: 'Nyx', personaPath: PERSONA, personaHash: PERSONA_HASH },
    member: {
      id: 'mem-nyx',
      displayName: 'Nyx',
      roleDescPath: ROLE,
      roleDescHash: ROLE_HASH
    },
    workspace: { name: '示例空间', dirName: 'demo' },
    cwd: CWD,
    cwdSource: 'member-primary',
    addDirs: [ADD],
    projects: [
      { id: 'p-a', name: '项目A', rootPath: CWD },
      { id: 'p-b', name: '项目B', rootPath: ADD }
    ],
    history: [],
    session: { compactedThroughSeq: 0, rollingSummary: null },
    ...over
  }
}

/** 整份提示词（所有条拼起来）—— 「某个字符串在不在上下文里」一律问它。 */
function allText(build: { messages: ReadonlyArray<{ content: string }> }): string {
  return build.messages.map((m) => m.content).join('\n\n')
}

/** 某个子串在整份提示词里出现了几次。 */
function countOf(build: { messages: ReadonlyArray<{ content: string }> }, needle: string): number {
  return allText(build).split(needle).length - 1
}

// ─────────────────────────────────────────────────────────────
// 一、cwd 的那一份不注入（§4.2）—— 本文件最贵的两条断言
// ─────────────────────────────────────────────────────────────

test('★ cwd 的 `CLAUDE.md` 与 `.claude/CLAUDE.md` 都**不**进上下文；`AGENTS.md` 与 rules 照进', async () => {
  const { deps } = fakeDeps(stdFixture())
  const build = await buildContext(inputOf(), deps)
  const text = allText(build)

  // ★ 两个都要剔。§4.2 逐字警告过「只剔根那一份就仍是两遍」，
  // 而探针证明这个警告**说中了** —— `.claude/CLAUDE.md` 也被 CLI 自动注入。
  assert.equal(text.includes(CWD_CLAUDE_MD), false, 'cwd 的 CLAUDE.md 由 CLI 自己带，不许再来一份')
  assert.equal(text.includes(CWD_DOT_CLAUDE_MD), false, '.claude/CLAUDE.md 同样由 CLI 自己带')

  // 没实测过的那几个方向相反：多给一份浪费 token（可恢复），少给一份
  // 会让模型以为项目没有记忆（它会自己造约定 —— 不可恢复）。
  assert.ok(text.includes(CWD_AGENTS_MD), 'AGENTS.md 实测不被自动注入 ⇒ 必须由我们带')
  assert.ok(text.includes(CWD_RULE), '.claude/rules/*.md 未实测 ⇒ 照进')
})

test('★ `--add-dir` 目录的 `CLAUDE.md` **要**进 —— 实测 CLI 不会带它', async () => {
  const { deps } = fakeDeps(stdFixture())
  const build = await buildContext(inputOf(), deps)

  assert.ok(
    allText(build).includes(ADD_CLAUDE_MD),
    '§8.5c 那个用户问题的答案就在这里：add-dir 的项目记忆只能由我们显式带进来'
  )
  // 剔只针对 cwd —— 对 add-dir 也剔就是**少**给一份，方向正好反了。
  assert.equal(build.contextSources.filter((s) => s.suppressed === null).length, 3)
})

test('★ 剔了谁、为什么，三处都有出处：sources / notes / 提示词正文', async () => {
  const { deps } = fakeDeps(stdFixture())
  const build = await buildContext(inputOf(), deps)

  const suppressed = build.contextSources.filter((s) => s.suppressed !== null)
  assert.deepEqual(
    suppressed.map((s) => s.relPath).sort(),
    ['.claude/CLAUDE.md', 'CLAUDE.md'],
    '两个被剔的文件都要在 sources 里留名'
  )
  assert.equal(suppressed.every((s) => s.suppressed === 'cli-auto-injected'), true)

  const note = build.notes.find((n) => n.tag === 'cwd-claude-md-suppressed')
  assert.ok(note, '记一条 note，UI 才有话可说')

  // ★ 第三条是最容易被漏掉的：**模型也得知道**。不写它，模型会以为 cwd 没有
  // CLAUDE.md，于是可能自己造一份约定 —— 那是一个我们看不见的错。
  assert.ok(allText(build).includes('未在此重复注入'), '提示词正文里要说明这件事')
  assert.equal(build.shape.suppressedAutoInjected, 2)
})

// ─────────────────────────────────────────────────────────────
// 二、`<role>` 的缺席必须是「整块不出现」
// ─────────────────────────────────────────────────────────────

test('★ `role_desc_path` 为 NULL → `<role>` 整块不出现（不是空标签）', async () => {
  const { deps } = fakeDeps(stdFixture())
  const build = await buildContext(
    inputOf({
      member: { id: 'mem-nyx', displayName: 'Nyx', roleDescPath: null, roleDescHash: null }
    }),
    deps
  )

  // 空标签是「看起来应该有内容」的承诺 —— 模型会去把它填上；
  // 而 NULL 的含义是「这个成员没有职责描述」，那是**合法状态**，不是缺失。
  assert.equal(build.systemPrompt.includes('<role>'), false)
  assert.equal(build.systemPrompt.includes('</role>'), false)
  assert.equal(build.shape.roleDescBytes, null)

  assert.ok(build.systemPrompt.includes('<persona>'), '人设照在')
  assert.ok(build.systemPrompt.includes('<collaboration>'), '协作协议照在')
})

test('★ 人设读不到：**不抛**、`personaBytes` 为 null、记一条 warn（致命与否由编排层判）', async () => {
  const fixture = stdFixture()
  delete fixture.texts[PERSONA]
  const { deps } = fakeDeps(fixture)

  const build = await buildContext(inputOf(), deps)

  assert.equal(build.shape.personaBytes, null, '编排层就是读这个值决定 fail() 的')
  const note = build.notes.find((n) => n.tag === 'persona-unreadable')
  assert.ok(note)
  assert.equal(note.level, 'warn')
  assert.equal(build.systemPrompt.includes('<persona>'), false)
  // 提示词照样装配出来了 —— 本模块的职责是**如实报告**，不是替编排层做判决。
  assert.ok(allText(build).includes('<env>'))
})

// ─────────────────────────────────────────────────────────────
// 三、压缩：水位线是权威，摘要只出现一次
// ─────────────────────────────────────────────────────────────

test('★ 水位线之下不进数组、`<summary>` 取代它们，且摘要**只出现一次**', async () => {
  const { deps } = fakeDeps(stdFixture())
  const summary = '前两条的摘要：用户要求把 a.ts 的 x 改成 2。'
  const build = await buildContext(
    inputOf({
      history: [msg({ seq: 1 }), msg({ seq: 2 }), msg({ seq: 3 }), msg({ seq: 4 })],
      session: { compactedThroughSeq: 2, rollingSummary: summary }
    }),
    deps
  )
  const text = allText(build)

  assert.equal(build.shape.historySuppressed, 2)
  assert.equal(build.shape.historyIncluded, 2)
  assert.equal(text.includes('第 1 条'), false, '被折叠的消息原文不许出现')
  assert.equal(text.includes('第 2 条'), false)
  assert.ok(text.includes('第 3 条'), '水位线之上的照进')

  assert.ok(text.includes('<summary>'), '摘要要替换掉那些消息')
  // ★ 这一条是判决：`markCompacted` 把同一段摘要在**每条**被压掉的消息上各写一遍，
  // 装配层若逐条读 `summary_text`，N 条被压的消息就会让摘要出现 N 次。
  assert.equal(countOf(build, summary), 1, '同一段摘要只许出现一次')
})

test('★ `inject_mode` 只是诊断：标了 summary 但**在**水位线之上 → 正文照进，且不进摘要', async () => {
  const { deps } = fakeDeps(stdFixture())
  // 这正是 §3.1 那个粒度错位的后果形状：workspace 粒度的 markCompacted 把
  // 另一个成员的消息也标成了 `summary`，而**它的会话水位线没动**。
  // 那些消息的正文是完好的 —— 它们必须照进，否则 B 的历史会静默消失。
  const build = await buildContext(
    inputOf({
      history: [
        msg({ seq: 1, text: '别的话', injectMode: 'summary' }),
        msg({ seq: 2, text: '我要这句' })
      ],
      session: { compactedThroughSeq: 0, rollingSummary: null }
    }),
    deps
  )
  const text = allText(build)

  assert.ok(text.includes('我要这句'))
  assert.equal(text.includes('<summary>'), false, '水位线没动 ⇒ 没有摘要块，摘要文本也不该被读出来')
  assert.equal(build.shape.historyIncluded, 2)
})

test('水位线前进但摘要为空 → 如实记一条 warn，不假装没压缩过', async () => {
  const { deps } = fakeDeps(stdFixture())
  const build = await buildContext(
    inputOf({
      history: [msg({ seq: 1 }), msg({ seq: 2 })],
      session: { compactedThroughSeq: 1, rollingSummary: null }
    }),
    deps
  )

  const note = build.notes.find((n) => n.tag === 'compaction-summary-missing')
  assert.ok(note, '「既没原文也没摘要」是个洞，必须看得见')
  assert.equal(note.level, 'warn')
  assert.equal(allText(build).includes('<summary>'), false, '没有摘要就不许摆一个空的 summary 块')
})

// ─────────────────────────────────────────────────────────────
// 四、缓存与逐字：前缀性质、作者标签、正文不清洗
// ─────────────────────────────────────────────────────────────

test('★ 第 N 轮的数组是第 N+1 轮的**前缀**（§4.1 那条分析的可执行化）', async () => {
  const { deps } = fakeDeps(stdFixture())

  const round1 = await buildContext(
    inputOf({ history: [msg({ seq: 1, text: '把 x 改成 2' })] }),
    deps
  )
  const round2 = await buildContext(
    inputOf({
      history: [
        msg({ seq: 1, text: '把 x 改成 2' }),
        msg({ seq: 2, role: 'assistant', authorMemberId: 'mem-nyx', authorName: 'Nyx', text: '改好了。' }),
        msg({ seq: 3, text: '再检查一下' })
      ]
    }),
    deps
  )

  assert.equal(round1.messages.length, 2)
  assert.equal(round2.messages.length, 4)
  // ★ 这一条错了，缓存就整段失配 —— 而症状只是「账单变贵」，没有任何报错。
  for (let i = 0; i < round1.messages.length; i++) {
    assert.equal(
      round2.messages[i].content,
      round1.messages[i].content,
      `第 ${i} 条必须逐字节不变（纯追加的 join 才有前缀性质）`
    )
  }
})

test('★ 只有「我自己说的」是 assistant；别人的话带作者标签', async () => {
  const { deps } = fakeDeps(stdFixture())
  const build = await buildContext(
    inputOf({
      history: [
        msg({ seq: 1, text: '把 x 改成 2' }),
        msg({ seq: 2, role: 'assistant', authorMemberId: 'mem-atlas', authorName: 'Atlas', text: '我看了下，可以改。' }),
        msg({ seq: 3, role: 'assistant', authorMemberId: 'mem-nyx', authorName: 'Nyx', text: '改好了。' }),
        msg({ seq: 4, role: 'system', text: '工作目录切换了' })
      ]
    }),
    deps
  )

  const [, m1, m2, m3, m4] = build.messages
  assert.equal(m1.role, 'user')
  assert.ok(m1.content.startsWith('【用户】\n'), '人类用户要能与成员区分开')

  // ★ 别人说的话**不是** assistant：这一轮对话里只有一个「我」。
  // 标成 assistant 会让模型以为那些话是它自己说的，于是它会为别人的结论负责。
  assert.equal(m2.role, 'user')
  assert.ok(m2.content.startsWith('【Atlas】\n'))

  // 我说的才是 assistant，而且**不加标签** —— `renderTurnInput` 会加
  // `【你上一轮的回答】`。两边各加一份就是一条行上两个角色标记。
  assert.equal(m3.role, 'assistant')
  assert.equal(m3.content, '改好了。')

  assert.equal(m4.role, 'user')
  assert.ok(m4.content.startsWith('【系统】\n'), '§5.6 的 system 行要能承载')
})

test('★ 归档里的历史正文**逐字**进：不 trim、不清洗、不转义', async () => {
  const { deps } = fakeDeps(stdFixture())
  const build = await buildContext(
    inputOf({ history: [msg({ seq: 1, text: ARCHIVE_TEXT })] }),
    deps
  )
  const last = build.messages[build.messages.length - 1]

  assert.equal(last.content, `【用户】\n${ARCHIVE_TEXT}`)
  assert.equal(last.content.includes('\r'), false, '不做换行归一化')
})

test('★ 项目记忆是 cwd + 每个 add-dir 各问一次，不重复问', async () => {
  const { deps, asked } = fakeDeps(stdFixture())
  await buildContext(inputOf(), deps)

  assert.deepEqual(asked.roots, [CWD, ADD], '顺序稳定（§8.5c：顺序不稳 ⇒ 前缀不稳 ⇒ 缓存失配）')
  assert.deepEqual(asked.reads, [PERSONA, ROLE])
})

test('excluded 的正文不进上下文（该值目前没有生产者，装配层先读它）', async () => {
  const { deps } = fakeDeps(stdFixture())
  const build = await buildContext(
    inputOf({
      history: [msg({ seq: 1, text: '被排除的' }), msg({ seq: 2, text: '留下的' })]
    }),
    deps
  )
  // 换成 excluded 再跑一遍，确认差异只来自那个标记。
  const { deps: deps2 } = fakeDeps(stdFixture())
  const build2 = await buildContext(
    inputOf({
      history: [
        msg({ seq: 1, text: '被排除的', injectMode: 'excluded' }),
        msg({ seq: 2, text: '留下的' })
      ]
    }),
    deps2
  )

  assert.ok(allText(build).includes('被排除的'))
  assert.equal(allText(build2).includes('被排除的'), false)
  assert.equal(build2.shape.historyExcluded, 1)
})
