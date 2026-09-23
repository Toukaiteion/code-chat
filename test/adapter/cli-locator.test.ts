/**
 * M5 验证之二：找到真正的 `claude.exe`。
 *
 * 这一层的价值全在「本机实测出来的那几条反直觉事实」上，所以用例逐条对着它们写：
 *
 * - **`claude.exe` 根本不在 PATH 上。** PATH 上只有两个垫片（无扩展名的 bash 垫片
 *   与 `.cmd`），直接 spawn 它们一个 ENOENT、一个 EINVAL。真身在
 *   `<prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`。
 * - **自更新会留下 `claude.exe.old.<时间戳>`。** 认错了它会一直启动旧版本，且毫无征兆。
 * - **不能 spawn `npm`。** 本机 `npm.exe` 不存在，`npm.cmd` 无 shell 会 EINVAL。
 *
 * 所有用例都注入依赖（`probe` / `runWhere`）—— 真去问 PATH 会让结果随机器而变，
 * 那种测试只能证明「我这台机器是这个样子」，而它恰恰是要被固定下来的东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { claudeSearchHint, resolveClaudeWith } from '../../src/main/adapters/claude/cli-locator.ts'
import type { LocatorDeps } from '../../src/main/adapters/claude/cli-locator.ts'

/** 本机实测的布局，逐字照抄（`node_global` 就是不在 node 目录下的那个 prefix）。 */
const PREFIX = 'D:/nodejs/node_global'
const SHIM_CMD = `${PREFIX}/claude.cmd`
const SHIM_BASH = `${PREFIX}/claude`
const REAL_EXE = join(PREFIX, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')

/** 只有一个路径「存在」的探针。 */
const probeOnly =
  (...existing: string[]) =>
  async (p: string): Promise<boolean> =>
    existing.includes(p)

/** 关掉两组兜底，让用例只测它自己声明的那条路径。 */
const BASE: LocatorDeps = { nodeDir: 'D:/nodejs', appDataDir: null }

test('覆盖值命中：直接用覆盖值', async () => {
  const exe = await resolveClaudeWith({
    ...BASE,
    override: 'E:/elsewhere/claude.exe',
    probe: probeOnly('E:/elsewhere/claude.exe'),
    runWhere: async () => []
  })
  assert.equal(exe, 'E:/elsewhere/claude.exe')
})

test('覆盖值设了但不存在 → null，**不悄悄回退**到别处', async () => {
  // 回退会让「我明明指定了路径」变成一个查不出来的问题：
  // 用户以为用的是他指定的那个，实际用的是 PATH 上碰巧找到的。
  const exe = await resolveClaudeWith({
    ...BASE,
    override: 'E:/nope/claude.exe',
    probe: probeOnly(REAL_EXE),
    runWhere: async () => [SHIM_CMD]
  })
  assert.equal(exe, null)
})

test('★ PATH 上只有 `.cmd` 垫片 → 反推出真身（这是本机唯一能走通的路）', async () => {
  // 直接 spawn 那个 `.cmd` 会抛 EINVAL（Node ≥20.12 无 shell 时的行为），
  // 所以「反推」不是优化，是**唯一可行**的做法。
  const exe = await resolveClaudeWith({
    ...BASE,
    override: null,
    probe: probeOnly(REAL_EXE),
    runWhere: async () => [SHIM_CMD]
  })
  assert.equal(exe, REAL_EXE)
})

test('PATH 上只有无扩展名的 bash 垫片 → 同样反推得出', async () => {
  const exe = await resolveClaudeWith({
    ...BASE,
    override: null,
    probe: probeOnly(REAL_EXE),
    runWhere: async () => [SHIM_BASH]
  })
  assert.equal(exe, REAL_EXE)
})

test('★ `claude.exe.old.<时间戳>` 必须被排除（认错了会一直启动旧版本）', async () => {
  // 本机真的躺着这么一个残留。它既不是真身、也不是能反推的垫片，
  // 于是唯一正确的结果是「没找到」—— 而不是把那个旧文件当成 CLI 启动起来。
  const stale = `${PREFIX}/node_modules/@anthropic-ai/claude-code/bin/claude.exe.old.1790009891938`
  const exe = await resolveClaudeWith({
    ...BASE,
    override: null,
    probe: probeOnly(stale),
    runWhere: async () => [stale]
  })
  assert.equal(exe, null)
})

test('文件名必须**精确**等于 claude.exe：`myclaude.exe` 不算', async () => {
  // `endsWith('claude.exe')` 会放过这个 —— 而「精确匹配」是文件头明写的纪律。
  const exe = await resolveClaudeWith({
    ...BASE,
    override: null,
    probe: probeOnly('D:/tools/myclaude.exe'),
    runWhere: async () => ['D:/tools/myclaude.exe']
  })
  assert.equal(exe, null)
})

test('PATH 上直接就是真身 → 用它，不去反推', async () => {
  const exe = await resolveClaudeWith({
    ...BASE,
    override: null,
    probe: probeOnly(REAL_EXE),
    runWhere: async () => [REAL_EXE]
  })
  assert.equal(exe, REAL_EXE)
})

test('垫片在，但反推出来的真身不存在 → 继续试下一个，最后 null', async () => {
  const exe = await resolveClaudeWith({
    ...BASE,
    override: null,
    probe: async () => false,
    runWhere: async () => [SHIM_BASH, SHIM_CMD]
  })
  assert.equal(exe, null)
})

test('都找不到 → 返回 null，由调用方说人话（本机没装 CLI 是可预期的处境）', async () => {
  const exe = await resolveClaudeWith({ ...BASE, override: null, probe: async () => false, runWhere: async () => [] })
  assert.equal(exe, null)
})

test('兜底候选：PATH 上什么都没有时，`<node>/node_global/...` 这一组要真的被试过', async () => {
  // 本机就是 `node_global` 这个布局，而它**不在 node 目录下**，猜是猜不出来的 ——
  // 所以这条兜底是有实际价值的，值得单独钉住。
  const exe = await resolveClaudeWith({
    override: null,
    nodeDir: 'D:/nodejs',
    appDataDir: null,
    probe: probeOnly(join('D:/nodejs', 'node_global', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')),
    runWhere: async () => []
  })
  assert.ok(exe, '兜底候选应该命中')
})

test('「找过哪里」：每条 PATH 匹配都要附上它被反推成的路径', async () => {
  // 这是排查「为什么没找到」最关键的一栏：本机 `where claude` 返回的两条**都是垫片**，
  // 用户看到「PATH 上有 claude」与「反推出来的 claude.exe 不存在」并排，
  // 才会明白这是两件事。
  const hint = await claudeSearchHint({
    ...BASE,
    override: null,
    runWhere: async () => [SHIM_BASH, SHIM_CMD]
  })
  assert.deepEqual(hint.whereMatches, [SHIM_BASH, SHIM_CMD])
  assert.deepEqual(hint.whereMatchDerivations, [REAL_EXE, REAL_EXE], '两条垫片反推出同一个真身')
  assert.ok(hint.blindCandidates.length > 0)
  assert.ok(hint.pathEntries.length >= 0)
})

test('「找过哪里」：有覆盖值时也要把它报出来（否则用户不知道自己的设置生效没有）', async () => {
  const hint = await claudeSearchHint({ ...BASE, override: 'E:/x/claude.exe', runWhere: async () => [] })
  assert.equal(hint.override, 'E:/x/claude.exe')
})
