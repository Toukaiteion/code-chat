/**
 * M6a 验证之三：cwd 的三级兜底与 `--add-dir` 的可见性（`src/main/domain/turn-cwd.ts`）。
 *
 * 两个纯函数，加起来是「这一轮**在哪个目录里跑**、以及它**还能看见哪些目录**」。
 * 它们容易被当成纯粹的字符串处理，其实各自带着一条产品判决：
 *
 * - 第一级的粒度是**成员**而不是空间。空间级的单一 cwd 在「前后端各配一个专注角色」
 *   与「总览角色」同时存在时**必然错一半**（§8.5b）。
 * - 第三级 `scratch/` **必须**存在：总览 / 客服角色没有主项目，而 `turn.cwd` 是
 *   `NOT NULL` —— 少这一级它们连一轮都发不出去，而它们正是用户故事 2 的主角。
 *
 * 两个**不做**的事同样是判决，所以也要有反向对照：
 * 它不碰盘（盘上有没有是项目生命周期的事，不是 cwd 解析的事），
 * 也不把 `--add-dir` 当安全边界（§8.4：agent 有 shell，读得到的东西远不止这些）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAddDirs, resolveTurnCwd } from '../../src/main/domain/turn-cwd.ts'

const SCRATCH = 'G:/spaces/Nova/scratch'
const P_API = { id: 'p-api', rootPath: 'G:/work/api-server' }
const P_WEB = { id: 'p-web', rootPath: 'G:/work/web-console' }
const P_DOC = { id: 'p-doc', rootPath: 'G:/work/docs' }
const ALL = [P_API, P_WEB, P_DOC]

// ─────────────────────────────────────────────────────────────
// 一、三级兜底：逐级命中
// ─────────────────────────────────────────────────────────────

test('第一级：成员的主项目命中', () => {
  const d = resolveTurnCwd({
    memberPrimaryProjectId: P_WEB.id,
    workspaceActiveProjectId: P_API.id,
    projects: ALL,
    scratchPath: SCRATCH
  })
  assert.deepEqual(d, { cwd: 'G:/work/web-console', source: 'member-primary' })
})

test('★ 第二级：成员没有主项目 → 空间 active 项目（「最近使用」，仅兜底）', () => {
  const d = resolveTurnCwd({
    memberPrimaryProjectId: null,
    workspaceActiveProjectId: P_API.id,
    projects: ALL,
    scratchPath: SCRATCH
  })
  assert.equal(d.cwd, 'G:/work/api-server')
  assert.equal(d.source, 'workspace-active', 'source 要如实说这是**兜底**命中的，不是主项目')
})

test('★ 第三级：两级都没有 → scratch/（无主项目的角色靠它才发得出轮次）', () => {
  const d = resolveTurnCwd({
    memberPrimaryProjectId: null,
    workspaceActiveProjectId: null,
    projects: ALL,
    scratchPath: SCRATCH
  })
  assert.deepEqual(d, { cwd: SCRATCH, source: 'scratch' })
  assert.equal(resolveTurnCwd({
    memberPrimaryProjectId: null,
    workspaceActiveProjectId: null,
    projects: [],
    scratchPath: SCRATCH
  }).source, 'scratch', '空间里一个项目都没有时同样是第三级')
})

test('主项目那行被删了（id 指向不存在的项目）→ 落到下一级，且 source 如实说没命中', () => {
  // 这里**不许**静默降级：降级会让 agent 在一个空目录里跑，而用户以为它在自己的项目里
  // —— 一个安静的错位置。落回下一级并让 `source` 说话，是唯一的诚实做法。
  const d = resolveTurnCwd({
    memberPrimaryProjectId: 'p-已删除',
    workspaceActiveProjectId: P_API.id,
    projects: ALL,
    scratchPath: SCRATCH
  })
  assert.equal(d.source, 'workspace-active')
})

test('active 项目也被删了 → 第三级', () => {
  const d = resolveTurnCwd({
    memberPrimaryProjectId: 'p-已删除',
    workspaceActiveProjectId: 'p-也删了',
    projects: ALL,
    scratchPath: SCRATCH
  })
  assert.equal(d.source, 'scratch')
})

test('★ 它不碰盘：路径在盘上存不存在，**不影响**解析结果', () => {
  // 「这个 root_path 还在不在」是项目生命周期的事（M4 的删除流程 / 用户在资源管理器里手删）。
  // 真不在了，CLI 会以 ENOENT 起不来，那条失败会如实落进 `turn.error_text` —— 一个说得清的失败。
  // 在这里加一次 existsSync 只会把同一个事实变成两个所有者，而它会随盘上状态变化（TOCTOU）。
  const ghost = { id: 'p-ghost', rootPath: 'Z:/这个盘不存在' }
  const d = resolveTurnCwd({
    memberPrimaryProjectId: ghost.id,
    workspaceActiveProjectId: null,
    projects: [ghost],
    scratchPath: SCRATCH
  })
  assert.deepEqual(d, { cwd: 'Z:/这个盘不存在', source: 'member-primary' })
})

// ─────────────────────────────────────────────────────────────
// 二、`--add-dir`：可见性是**上下文裁剪**，不是安全边界
// ─────────────────────────────────────────────────────────────

test('没有任何 member_project 行（`null`）→ 空间内全部项目可见', () => {
  assert.deepEqual(resolveAddDirs(ALL, null, 'G:/别处'), ['G:/work/api-server', 'G:/work/web-console', 'G:/work/docs'])
})

test('有行 → **只**可见这些（其余一个都不给）', () => {
  assert.deepEqual(resolveAddDirs(ALL, [P_WEB.id], 'G:/别处'), ['G:/work/web-console'])
  assert.deepEqual(resolveAddDirs(ALL, [P_API.id, P_DOC.id], 'G:/别处'), [
    'G:/work/api-server',
    'G:/work/docs'
  ])
})

test('空数组 = 一个都不可见（它与 `null` 是**两件事**，不许合并）', () => {
  // `null` 是"没有配置过 → 全给"，`[]` 是"配置过，谁都不给"。
  // 把后者当成前者，等于给一个刻意收窄过的成员偷偷放开全部项目。
  assert.deepEqual(resolveAddDirs(ALL, [], 'G:/别处'), [])
})

test('cwd 自己不进 `--add-dir`（它已经在里面了）', () => {
  assert.ok(!resolveAddDirs(ALL, null, P_API.rootPath).includes(P_API.rootPath))
  assert.deepEqual(resolveAddDirs(ALL, null, P_API.rootPath), ['G:/work/web-console', 'G:/work/docs'])
})

test('顺序稳定：按传入顺序，不是按 id 或按可见性表的顺序', () => {
  // 参数顺序会影响子进程的命令行长什么样，也就影响 `--help` 输出与日志的对照。
  assert.deepEqual(resolveAddDirs([P_DOC, P_API, P_WEB], null, 'G:/别处'), [
    'G:/work/docs',
    'G:/work/api-server',
    'G:/work/web-console'
  ])
})

test('可见性表里有不存在的 id → 忽略它，不凭空造一个目录出来', () => {
  assert.deepEqual(resolveAddDirs(ALL, [P_WEB.id, 'p-不存在'], 'G:/别处'), ['G:/work/web-console'])
})

test('空间里一个项目都没有 → 空数组，而不是抛', () => {
  assert.deepEqual(resolveAddDirs([], null, 'G:/别处'), [])
})
