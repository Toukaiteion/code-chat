/**
 * M2 验证之二：schema 的**约束真的生效**。
 *
 * 为什么每一条都要单独验：M1 已经吃过一次亏 —— `PRAGMA foreign_keys = ON`
 * 「被接受」不等于「生效」。约束是**静默**的，失效时不会报错，
 * 只会在很久以后以孤儿数据的形式出现（方案 §2.1）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../../src/main/persist/index.ts'
import { assertDdlEnumsMatch, ddlCheckedValues } from '../../src/main/persist/ddl-enums.ts'
import { openDatabase } from '../../src/main/persist/db.ts'
import type { Store } from '../../src/main/persist/index.ts'

function store(): Store {
  return openStore(':memory:')
}

const NOW = 1_700_000_000_000

/** 建一个最小可用的空间 + 项目 + 角色 + 成员，供约束测试复用。 */
function seed(s: Store): { workspaceId: string; projectId: string; actorId: string; memberId: string } {
  const workspace = s.repos.workspace.create({ id: 'w1', name: 'Nova', now: NOW })
  const project = s.repos.project.create({
    id: 'p1',
    workspaceId: workspace.id,
    name: 'api-server',
    rootPath: 'G:/work/api-server',
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
    workspaceId: workspace.id,
    actorId: actor.id,
    displayName: '架构师',
    now: NOW
  })
  return { workspaceId: workspace.id, projectId: project.id, actorId: actor.id, memberId: member.id }
}

test('外键真的生效：悬空外键必须抛错', () => {
  const s = store()
  assert.throws(
    () =>
      s.repos.project.create({
        id: 'p-bad',
        workspaceId: '不存在的空间',
        name: 'x',
        rootPath: 'G:/x',
        origin: 'local',
        now: NOW
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /FOREIGN KEY constraint failed/)
      return true
    }
  )
  s.close()
})

test('级联删除：删空间带走项目 / 成员 / session / message', () => {
  const s = store()
  const { workspaceId, projectId, memberId, actorId } = seed(s)
  const session = s.repos.session.create('sess1', workspaceId, memberId, NOW)
  s.repos.message.append({
    id: 'msg1',
    workspaceId,
    sessionId: session.id,
    role: 'user',
    contentText: 'hello',
    now: NOW
  })

  assert.equal(s.repos.workspace.remove(workspaceId), true)

  assert.equal(s.repos.project.get(projectId), null, '项目应被级联删除')
  assert.equal(s.repos.member.get(memberId), null, '成员应被级联删除')
  assert.equal(s.repos.session.get(session.id), null, 'session 应被级联删除')
  assert.equal(s.repos.message.get('msg1'), null, '消息应被级联删除')
  // actor 是全局的「人」，**不**随空间消失
  assert.notEqual(s.repos.actor.get(actorId), null, 'actor 是全局实体，不应被空间级联删除')
  s.close()
})

test('偏索引 idx_member_router：每空间至多一个路由角色（§3.2）', () => {
  const s = store()
  const { workspaceId, actorId, memberId } = seed(s)
  const actor2 = s.repos.actor.create({
    id: 'a2',
    name: 'Nyx',
    model: 'deepseek-flash',
    personaPath: 'personas/nyx.md',
    personaHash: 'h2',
    now: NOW
  })
  const member2 = s.repos.member.create({
    id: 'm2',
    workspaceId,
    actorId: actor2.id,
    displayName: '路由',
    now: NOW
  })

  s.repos.member.setRouter(memberId, true, NOW)
  assert.equal(s.repos.member.getRouter(workspaceId)?.id, memberId)

  assert.throws(
    () => s.repos.member.setRouter(member2.id, true, NOW),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /UNIQUE constraint failed/)
      return true
    },
    '第二个路由角色必须被 DB 拒绝，而不是靠应用层代码自觉'
  )
  // 未受影响的第二个成员仍是普通成员
  assert.equal(s.repos.member.get(member2.id)?.isRouter, false)
  // 但另一个空间可以有自己的路由角色
  const w2 = s.repos.workspace.create({ id: 'w2', name: 'Orion', now: NOW })
  const m3 = s.repos.member.create({
    id: 'm3',
    workspaceId: w2.id,
    actorId: actor2.id,
    displayName: '路由2',
    now: NOW
  })
  assert.equal(s.repos.member.setRouter(m3.id, true, NOW)?.isRouter, true)
  assert.equal(actorId.length > 0, true)
  s.close()
})

test('偏索引 idx_member_primary：每成员至多一个主项目（§8.5b）', () => {
  const s = store()
  const { workspaceId, memberId } = seed(s)
  const p2 = s.repos.project.create({
    id: 'p2',
    workspaceId,
    name: 'web-console',
    rootPath: 'G:/work/web-console',
    origin: 'local',
    now: NOW
  })

  s.repos.member.setVisibleProjects(memberId, ['p1', 'p2'], 'p1', NOW)
  assert.equal(s.repos.member.primaryProjectId(memberId), 'p1')

  assert.throws(
    () => s.repos.member.setPrimary(memberId, p2.id, true),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /UNIQUE constraint failed/)
      return true
    },
    '第二个主项目必须被 DB 拒绝'
  )
  s.close()
})

test('UNIQUE(workspace_id, root_path)：同一目录不能被加两次', () => {
  const s = store()
  const { workspaceId } = seed(s)
  assert.throws(
    () =>
      s.repos.project.create({
        id: 'p-dup',
        workspaceId,
        name: '另一个名字，同一个目录',
        rootPath: 'G:/work/api-server',
        origin: 'copy',
        now: NOW
      }),
    /UNIQUE constraint failed/
  )
  s.close()
})

test('project.origin 的三值 CHECK：非法值必须被拒（§8.2）', () => {
  const s = store()
  const { workspaceId } = seed(s)
  assert.throws(
    () =>
      s.repos.project.create({
        id: 'p-bad',
        workspaceId,
        name: 'x',
        rootPath: 'G:/x',
        // 绕过 TS 的类型系统，模拟"上层传了个脏值"
        origin: 'worktree' as never,
        now: NOW
      }),
    /CHECK constraint failed/
  )
  s.close()
})

test('UNIQUE(workspace_id, seq)：空间时间线的 seq 由 DB 强制唯一', () => {
  const s = store()
  const { workspaceId, memberId } = seed(s)
  const session = s.repos.session.create('sess1', workspaceId, memberId, NOW)

  const m1 = s.repos.message.append({
    id: 'msg1',
    workspaceId,
    sessionId: session.id,
    role: 'user',
    contentText: 'a',
    now: NOW
  })
  const m2 = s.repos.message.append({
    id: 'msg2',
    workspaceId,
    sessionId: session.id,
    role: 'assistant',
    contentText: 'b',
    now: NOW
  })
  assert.equal(m1.seq, 1)
  assert.equal(m2.seq, 2)

  // 手工插一个重复 seq —— 模拟写歪的代码
  assert.throws(
    () =>
      s.db
        .prepare(
          `INSERT INTO message (id, workspace_id, role, seq, content_bytes, mentions_json,
             inject_mode, created_at)
           VALUES ('msg-dup', ?, 'user', 2, 0, '[]', 'full', ?)`
        )
        .run(workspaceId, NOW),
    /UNIQUE constraint failed/
  )
  s.close()
})

test('UNIQUE(workspace_id, member_id)：Session 与成员 1:1', () => {
  const s = store()
  const { workspaceId, memberId } = seed(s)
  s.repos.session.create('sess1', workspaceId, memberId, NOW)
  assert.throws(
    () => s.repos.session.create('sess2', workspaceId, memberId, NOW),
    /UNIQUE constraint failed/
  )
  s.close()
})

test('actor.model 是自由文本：第三方端点模型名不该被 CHECK 拦住（§2.4）', () => {
  const s = store()
  const a = s.repos.actor.create({
    id: 'a-x',
    name: '第三方',
    model: 'deepseek-flash[1m]',
    personaPath: 'p.md',
    personaHash: 'h',
    now: NOW
  })
  assert.equal(a.model, 'deepseek-flash[1m]', 'model 必须原样存取，不做枚举归一化')
  s.close()
})

test('message_event 的 kind CHECK 与 ok 可空性', () => {
  const s = store()
  const { workspaceId, memberId } = seed(s)
  const session = s.repos.session.create('sess1', workspaceId, memberId, NOW)
  const msg = s.repos.message.append({
    id: 'msg1',
    workspaceId,
    sessionId: session.id,
    role: 'assistant',
    now: NOW
  })

  const ev = s.repos.message.appendEvent({
    messageId: msg.id,
    kind: 'thinking',
    textBlob: '推理内容',
    now: NOW
  })
  assert.equal(ev.kind, 'thinking')
  assert.equal(ev.seq, 1)
  assert.equal(ev.ok, null, 'thinking 事件没有成功/失败语义')
  assert.equal(ev.truncated, false)
  // bytes 自动按 UTF-8 计算，不是字符数
  assert.equal(ev.bytes, Buffer.byteLength('推理内容', 'utf8'))

  const tool = s.repos.message.appendEvent({
    messageId: msg.id,
    kind: 'tool_result',
    toolUseId: 'tu1',
    toolName: 'Read',
    ok: false,
    now: NOW
  })
  assert.equal(tool.seq, 2, '事件 seq 在消息内单调')
  assert.equal(tool.ok, false)

  assert.throws(
    () =>
      s.db
        .prepare(
          `INSERT INTO message_event (message_id, seq, kind, bytes, truncated, created_at)
           VALUES (?, 99, 'nonsense', 0, 0, ?)`
        )
        .run(msg.id, NOW),
    /CHECK constraint failed/
  )
  s.close()
})

// ─────────────────────────────────────────────────────────────
// ★ 启动断言：TS 枚举 ↔ DDL CHECK（§8.5a 欠的那一条）
// ─────────────────────────────────────────────────────────────

test('★ 真实的 schema 必须让启动断言通过 —— 六对枚举逐条一致', () => {
  // 这是那条断言**唯一**证明自己有意义的形态：拿真正的迁移产物去验。
  // 若某天有人只在 `entities.ts` 里加了一个 kind 而没改迁移，
  // 这个用例会在这里、以及用户的应用启动时，同时炸掉。
  const s = openStore(':memory:')
  assert.doesNotThrow(() => assertDdlEnumsMatch(s.db))
  s.close()
})

test('★ 反向对照：DDL 少一项必须炸 —— 否则这条断言只是装饰', () => {
  // 反向对照是必须的：一条永远不炸的断言，与没有断言在这件事上无法区分。
  const db = openDatabase(':memory:')
  try {
    db.exec(
      `CREATE TABLE message_event (kind TEXT NOT NULL CHECK (kind IN
         ('thinking','text','tool_start','tool_result','file_diff','usage','error')))`
    )
    assert.throws(
      () => assertDdlEnumsMatch(db),
      // 报错必须**点出是谁不一致**，而不是一句「不一致」。少了这一句，
      // 开发者还得自己去两个文件里做集合比较 —— 那正是这个模块要省掉的工作。
      /message_event\.kind.*TS 里有而 DDL 拒收：done/s
    )
  } finally {
    db.close()
  }
})

test('CHECK 整个不见了比写错了更严重 —— 必须也炸', () => {
  const db = openDatabase(':memory:')
  try {
    // 没有任何 CHECK 的 kind 列：约束蒸发是**不可逆**的静默降级。
    db.exec(`CREATE TABLE message_event (kind TEXT NOT NULL)`)
    assert.throws(() => assertDdlEnumsMatch(db), /找不到 CHECK \(kind IN/)
  } finally {
    db.close()
  }
})

test('表根本不存在时也炸（迁移没跑到）', () => {
  const db = openDatabase(':memory:')
  try {
    assert.throws(() => assertDdlEnumsMatch(db), /表 message_event 不存在/)
  } finally {
    db.close()
  }
})

test('DDL 解析：跨行的 CHECK、顺序、以及「没有这一列」', () => {
  // `kind` 那条在真实迁移里是**跨行**写的，所以解析器不能依赖 `.` 不匹配换行。
  const multiline = `CREATE TABLE t (\n  kind TEXT NOT NULL CHECK (kind IN\n    ('a','b')),\n  other TEXT\n)`
  assert.deepEqual(ddlCheckedValues(multiline, 'kind'), ['a', 'b'])
  // 顺序原样保留 —— 顺序也比，见 `assertDdlEnumsMatch` 里那段。
  assert.deepEqual(ddlCheckedValues(multiline, 'kind'), ['a', 'b'])
  // 没有这一列 → null，**不是**空数组：空数组会被读成「这一列一项都不收」。
  assert.equal(ddlCheckedValues(multiline, 'nope'), null)
  // 列名是子串也不能误撞（`id` 不该匹配到 `user_id` 的 CHECK）。
  const decoy = `CREATE TABLE t (a TEXT CHECK (a IN ('x')), other_id TEXT CHECK (other_id IN ('y')))`
  assert.deepEqual(ddlCheckedValues(decoy, 'a'), ['x'])
})
