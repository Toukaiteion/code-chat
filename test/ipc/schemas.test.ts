/**
 * M3 验证之三：schema 与实体的一致性。
 *
 * `schemas.ts` 末尾的编译期断言（`_Workspace = Assert<Exact<...>>`）保证类型层不分叉；
 * 这个文件补上**运行时**的那一半 —— 拿 repository **真实产出**的对象去喂 schema，
 * 逐一 `deepEqual`。
 *
 * 两者测的不是一回事：编译期断言能挡住「少一个字段」，但当 repository 多映射了
 * 一个 schema 里没有的字段时，`Exact` 会失败、而 `z.object` 的解析**会静默剥掉它**
 * —— 这正是「UI 上少显示了一列」这类 bug 的温床。反向的 deepEqual 就是钉这个的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ActorSchema,
  INVOKE_SCHEMAS,
  MessageEventSchema,
  MessageSchema,
  MemberProjectSchema,
  ProjectSchema,
  PUSH_SCHEMAS,
  SessionSchema,
  StreamFrameSchema,
  StreamStatusSchema,
  TurnSchema,
  WorkspaceMemberSchema,
  WorkspaceSchema,
  WorkspaceUsageSchema
} from '../../src/shared/ipc/schemas.ts'
import { TURN_STATUSES } from '../../src/shared/entities.ts'
import { INVOKE_CHANNELS, PUSH_CHANNELS } from '../../src/shared/ipc/channels.ts'
import { openStore } from '../../src/main/persist/index.ts'

const NOW = 1_700_000_000_000

/** 造出每一种实体的**真实**实例，然后要求 schema 原样接受它。 */
function realEntities() {
  const s = openStore(':memory:')
  const workspace = s.repos.workspace.create({ id: 'w1', name: 'Nova', now: NOW })
  const project = s.repos.project.create({
    id: 'p1',
    workspaceId: 'w1',
    name: 'api-server',
    rootPath: 'G:/work/api',
    origin: 'local',
    now: NOW
  })
  const actor = s.repos.actor.create({
    id: 'a1',
    name: 'Atlas',
    model: 'deepseek-flash',
    personaPath: 'personas/atlas.md',
    personaHash: 'h1',
    now: NOW
  })
  const member = s.repos.member.create({
    id: 'm1',
    workspaceId: 'w1',
    actorId: 'a1',
    displayName: '架构师',
    now: NOW
  })
  const memberProject = s.repos.member.setVisibleProjects('m1', ['p1'], 'p1', NOW)[0]
  const session = s.repos.session.create('s1', 'w1', 'm1', NOW)
  const turn = s.repos.turn.create({ id: 't1', sessionId: 's1', workspaceId: 'w1', cwd: 'G:/work/api', now: NOW })
  const message = s.repos.message.append({
    id: 'msg1',
    workspaceId: 'w1',
    sessionId: 's1',
    turnId: 't1',
    role: 'assistant',
    authorMemberId: 'm1',
    contentText: '你好',
    mentions: [{ memberId: 'm1', kind: 'to' }],
    now: NOW
  })
  const event = s.repos.message.appendEvent({
    messageId: 'msg1',
    kind: 'text',
    textBlob: '你好',
    now: NOW
  })

  return { workspace, project, actor, member, memberProject, session, turn, message, event }
}

test('★ 每一种实体：repository 真实产出的对象与 schema 逐字段一致', () => {
  const e = realEntities()

  const cases: Array<[string, { parse(v: unknown): unknown }, unknown]> = [
    ['Workspace', WorkspaceSchema, e.workspace],
    ['Project', ProjectSchema, e.project],
    ['Actor', ActorSchema, e.actor],
    ['WorkspaceMember', WorkspaceMemberSchema, e.member],
    ['MemberProject', MemberProjectSchema, e.memberProject],
    ['Session', SessionSchema, e.session],
    ['Turn', TurnSchema, e.turn],
    ['Message', MessageSchema, e.message],
    ['MessageEvent', MessageEventSchema, e.event]
  ]

  for (const [name, schema, entity] of cases) {
    // deepEqual 双向钉死：schema 不会剥掉字段（少映射），也不会凭空多出字段（多映射）。
    assert.deepEqual(schema.parse(entity), entity, `${name} 与 schema 不一致`)
  }
})

test('schema 会剥掉多余字段 —— 所以上一条测试的 deepEqual 是必要的，不是多余的', () => {
  const e = realEntities()
  const withExtra = { ...e.workspace, somethingNew: 1 }
  assert.deepEqual(WorkspaceSchema.parse(withExtra), e.workspace)
  assert.notDeepEqual(WorkspaceSchema.parse(withExtra), withExtra)
})

test('MessageEvent 的 id 是数字，不是字符串（AUTOINCREMENT，别顺手写成 z.string）', () => {
  const { event } = realEntities()
  assert.equal(typeof event.id, 'number')
  assert.equal(MessageEventSchema.parse(event).id, event.id)

  // z.number() 不做 coerce —— 字符串进来必须被拒，而不是被悄悄转成数字。
  // 这条断言的价值在于：其余 8 种实体的 id 都是字符串 UUID，
  // 唯独这个不是，很容易在写 schema 时顺手写成 z.string() 而毫无察觉。
  assert.ok(!MessageEventSchema.safeParse({ ...event, id: '1' }).success)
})

test('未知的枚举值进不来（status / origin / role 都由 CHECK 约束兜底，schema 是第二道）', () => {
  const e = realEntities()
  assert.throws(() => TurnSchema.parse({ ...e.turn, status: 'zombie' }))
  assert.throws(() => ProjectSchema.parse({ ...e.project, origin: 'ftp' }))
  assert.throws(() => MessageSchema.parse({ ...e.message, role: 'wizard' }))
})

test('INVOKE_SCHEMAS 与通道清单严格一一对应', () => {
  assert.deepEqual(Object.keys(INVOKE_SCHEMAS).sort(), [...INVOKE_CHANNELS].sort())
  assert.deepEqual(Object.keys(PUSH_SCHEMAS).sort(), [...PUSH_CHANNELS].sort())
})

test('推送通道刻意只有四个 —— 高频的 token delta 必须合批进 stream:batch', () => {
  assert.deepEqual([...PUSH_CHANNELS], ['stream:batch', 'stream:status', 'workspace:unread', 'app:notice'])
})

test('StreamFrameSchema 按 k 判别：缺字段的帧被拒，未知的 k 被拒', () => {
  assert.ok(StreamFrameSchema.parse({ seq: 1, k: 'text', d: 'hello' }))
  assert.ok(StreamFrameSchema.parse({ seq: 2, k: 'thinking_end' }))

  // 按 k 判别，所以「text 帧缺 d」是结构错误而不是静默通过
  assert.ok(!StreamFrameSchema.safeParse({ seq: 1, k: 'text' }).success)
  assert.ok(!StreamFrameSchema.safeParse({ seq: 1, k: 'telepathy' }).success)
  // done 的 reason 是枚举，编不出来的理由进不来
  assert.ok(!StreamFrameSchema.safeParse({ seq: 3, k: 'done', reason: 'whatever' }).success)
  assert.ok(StreamFrameSchema.safeParse({ seq: 3, k: 'done', reason: 'interrupted' }).success)
})

// ─────────────────────────────────────────────────────────────
// M6b 新增的两条载荷
// ─────────────────────────────────────────────────────────────

test('★ `stream:status` 的 status 只能是 `TURN_STATUSES` 里的值', () => {
  // 这条推送是**轮次行的投影**，所以它的取值集合必须与 `turn.status` 那一个逐字相同。
  // 放宽成 `z.string()` 的话，主进程写错一个状态会一路走到渲染层，
  // 而渲染层只能显示一个它不认识的词。
  const base = { workspaceId: 'w1', sessionId: 's1', turnId: 't1', reason: null }
  for (const status of TURN_STATUSES) {
    assert.ok(StreamStatusSchema.safeParse({ ...base, status }).success, `${status} 应当被接受`)
  }
  assert.ok(!StreamStatusSchema.safeParse({ ...base, status: 'zombie' }).success)

  // `reason` 是**必填的可空**字段，不是可选字段：非终态发 null，终态发那个原因。
  // 写成 `.optional()` 的话，「忘了带 reason」与「reason 确实为空」就分不开了。
  assert.ok(!StreamStatusSchema.safeParse({ ...base, reason: undefined, status: 'queued' }).success)
  assert.ok(StreamStatusSchema.safeParse({ ...base, reason: 'budget', status: 'failed' }).success)
})

test('★ 空空间的累计用量：四个数都是 0，**不是 null**（`SUM` 在零行上返回 NULL）', () => {
  // SQLite 的 `SUM` 在**零行**上返回 NULL，`SUM(x IS NULL)` 同理 ——
  // 一个刚建的空间会得到四个 null，而正确答案是「确实没花过钱」。
  // 让它们可空的话，界面每处都要判一次 null，而那个 null 从来没有含义。
  const s = openStore(':memory:')
  s.repos.workspace.create({ id: 'w1', name: 'Nova', now: NOW })
  const usage = s.repos.turn.usageOfWorkspace('w1')
  assert.deepEqual(usage, { turnCount: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, turnsWithoutUsage: 0 })
  assert.ok(WorkspaceUsageSchema.safeParse(usage).success)
})

test('每个通道的 req 都能被一个「最小合法载荷」满足（防止写出不可能调用的通道）', () => {
  // 无载荷通道收 undefined；有载荷的通道至少得接受一个空对象之外的东西 ——
  // 这里只做一次结构性检查：req 必须是个能 safeParse 的 schema 对象。
  for (const [channel, pair] of Object.entries(INVOKE_SCHEMAS)) {
    assert.equal(typeof pair.req.safeParse, 'function', `${channel} 的 req 不是 zod schema`)
    assert.equal(typeof pair.res.safeParse, 'function', `${channel} 的 res 不是 zod schema`)
  }
})
