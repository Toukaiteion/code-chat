/**
 * M2 验证之三：repository 行为，重点是 §8 的可见性模型与 §4.2 的
 * 「thinking 结构性不外泄」这条性质。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../../src/main/persist/index.ts'
import type { Store } from '../../src/main/persist/index.ts'

const NOW = 1_700_000_000_000

function seed(s: Store) {
  const workspace = s.repos.workspace.create({ id: 'w1', name: 'Nova', now: NOW })
  const local = s.repos.project.create({
    id: 'p-local',
    workspaceId: workspace.id,
    name: '用户的目录',
    rootPath: 'G:/work/mine',
    origin: 'local',
    now: NOW
  })
  const cloned = s.repos.project.create({
    id: 'p-clone',
    workspaceId: workspace.id,
    name: 'clone 来的',
    rootPath: 'G:/ws/nova/projects/other',
    origin: 'clone',
    remoteUrl: 'https://example.com/other.git',
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
  const session = s.repos.session.create('sess1', workspace.id, member.id, NOW)
  return { workspaceId: workspace.id, local, cloned, actorId: actor.id, memberId: member.id, sessionId: session.id }
}

// ─────────────────────────────────────────────────────────────
// §8.4 可见性模型
// ─────────────────────────────────────────────────────────────

test('可见性默认全开：没有 member_project 行 = 看到空间内全部项目', () => {
  const s = openStore(':memory:')
  const { memberId } = seed(s)

  const v = s.repos.member.visibleProjectIds(memberId)
  assert.equal(v.isRestricted, false, '没有行意味着"未收窄"')
  assert.deepEqual(v.ids, [])
  assert.equal(s.repos.member.primaryProjectId(memberId), null, '没有主项目 → 走二级/三级兜底')
  s.close()
})

test('可见性收窄：有行 = 只看到这些', () => {
  const s = openStore(':memory:')
  const { memberId } = seed(s)

  s.repos.member.setVisibleProjects(memberId, ['p-local'], null, NOW)

  const v = s.repos.member.visibleProjectIds(memberId)
  assert.equal(v.isRestricted, true)
  assert.deepEqual(v.ids, ['p-local'], '被收窄后不应再看到 clone 那个项目')
  s.close()
})

test('主项目必须同时可见 —— 否则 cwd 会指向角色看不到的目录', () => {
  const s = openStore(':memory:')
  const { memberId } = seed(s)

  assert.throws(
    () => s.repos.member.setVisibleProjects(memberId, ['p-local'], 'p-clone', NOW),
    /主项目 p-clone 必须同时在该成员的可见项目集合里/
  )
  // 失败的调用不应留下半截状态
  assert.equal(s.repos.member.visibleProjectIds(memberId).isRestricted, false)
  s.close()
})

test('setVisibleProjects 是整体替换，不是追加', () => {
  const s = openStore(':memory:')
  const { memberId } = seed(s)

  s.repos.member.setVisibleProjects(memberId, ['p-local', 'p-clone'], 'p-clone', NOW)
  assert.deepEqual(s.repos.member.visibleProjectIds(memberId).ids.sort(), ['p-clone', 'p-local'])

  s.repos.member.setVisibleProjects(memberId, ['p-local'], 'p-local', NOW)
  assert.deepEqual(
    s.repos.member.visibleProjectIds(memberId).ids,
    ['p-local'],
    '旧的 p-clone 行必须被清掉'
  )
  assert.equal(s.repos.member.primaryProjectId(memberId), 'p-local')
  s.close()
})

test('撤销收窄会一并清掉主项目（不留"不可见的主项目"）', () => {
  const s = openStore(':memory:')
  const { memberId } = seed(s)

  s.repos.member.setVisibleProjects(memberId, ['p-local'], 'p-local', NOW)
  s.repos.member.clearVisibleProjects(memberId)

  assert.deepEqual(s.repos.member.visibleProjectIds(memberId).ids, [])
  assert.equal(s.repos.member.primaryProjectId(memberId), null)
  assert.equal(s.repos.member.visibleProjectIds(memberId).isRestricted, false)
  s.close()
})

// ─────────────────────────────────────────────────────────────
// §8.2 三种导入方式
// ─────────────────────────────────────────────────────────────

test('三种 origin 都能存取，且 remote_url 只在 clone 型有意义', () => {
  const s = openStore(':memory:')
  const { workspaceId, local, cloned } = seed(s)
  const copied = s.repos.project.create({
    id: 'p-copy',
    workspaceId,
    name: '复制来的',
    rootPath: 'G:/ws/nova/projects/copied',
    origin: 'copy',
    now: NOW
  })

  assert.equal(local.origin, 'local')
  assert.equal(local.remoteUrl, null, '原地引用用户目录没有 remote')
  assert.equal(cloned.origin, 'clone')
  assert.equal(cloned.remoteUrl, 'https://example.com/other.git')
  assert.equal(copied.origin, 'copy')
  assert.equal(s.repos.project.listByWorkspace(workspaceId).length, 3)
  s.close()
})

test('★ 删空间只删登记行：origin=local 的项目目录属于用户，我们绝不碰', () => {
  const s = openStore(':memory:')
  const { workspaceId, local } = seed(s)

  s.repos.workspace.remove(workspaceId)

  assert.equal(s.repos.project.get(local.id), null, 'DB 行被删')
  // 这个断言看起来同义反复，但它锁住的是**语义**：
  // repository 层不做任何文件系统操作，磁盘目录的处置完全由上层决定并需用户确认。
  assert.equal(
    local.origin,
    'local',
    'origin=local 意味着 root_path 是用户的目录，删除流程必须区别对待'
  )
  s.close()
})

test('删除被当作 cwd 兜底的项目时，workspace.active_project_id 自动置空', () => {
  const s = openStore(':memory:')
  const { workspaceId, local } = seed(s)

  s.repos.workspace.setActiveProject(workspaceId, local.id, NOW)
  assert.equal(s.repos.workspace.get(workspaceId)?.activeProjectId, local.id)
  assert.equal(s.repos.project.isReferencedAsActive(local.id), true)

  s.repos.project.remove(local.id)

  assert.equal(
    s.repos.workspace.get(workspaceId)?.activeProjectId,
    null,
    'ON DELETE SET NULL 应该自动清理，不需要应用层手动维护'
  )
  s.close()
})

// ─────────────────────────────────────────────────────────────
// §4.2 thinking 的结构性排除
// ─────────────────────────────────────────────────────────────

test('★ thinking 只落在 message_event；上下文装配读到的 message 里没有推理', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId, memberId } = seed(s)

  const user = s.repos.message.append({
    id: 'msg-user',
    workspaceId,
    role: 'user',
    contentText: '把 auth 重构一下',
    now: NOW
  })
  const reply = s.repos.message.append({
    id: 'msg-atlas',
    workspaceId,
    sessionId,
    role: 'assistant',
    authorMemberId: memberId,
    contentText: '已重构 login.ts',
    mentions: [{ memberId: 'm-nyx', kind: 'to' }],
    now: NOW
  })

  s.repos.message.appendEvent({
    messageId: reply.id,
    kind: 'thinking',
    textBlob: '先看 login.ts 的调用点……',
    now: NOW
  })
  s.repos.message.appendEvent({
    messageId: reply.id,
    kind: 'text',
    textBlob: '已重构 login.ts',
    now: NOW
  })

  // 上下文装配只会用到 listRecent / listAfter / listBySession 这些方法
  const forContext = s.repos.message.listRecent(workspaceId, 50)
  const serialized = JSON.stringify(forContext)

  assert.equal(forContext.length, 2)
  assert.ok(
    !serialized.includes('先看 login.ts 的调用点'),
    '★ 思维链绝不能出现在上下文装配的输入里 —— 这是结构性保证，不是过滤条件'
  )
  assert.ok(serialized.includes('把 auth 重构一下'))

  // 但推理内容**确实被持久化**了，能在 UI 上回放
  const events = s.repos.message.listEvents(reply.id)
  assert.equal(events.length, 2)
  assert.equal(events[0].kind, 'thinking')
  assert.equal(events[0].textBlob, '先看 login.ts 的调用点……')

  // mention 是结构化字段，不是从文本里正则抠出来的
  assert.deepEqual(reply.mentions, [{ memberId: 'm-nyx', kind: 'to' }])
  assert.equal(user.mentions.length, 0)

  assert.equal(
    s.repos.message.countEvents(reply.id),
    2,
    '删掉 message 才能带走事件 —— 它们是历史的一部分，不随上下文裁剪而消失'
  )
  s.close()
})

test('seq 单调分配 + keyset 分页', () => {
  const s = openStore(':memory:')
  const { workspaceId } = seed(s)

  for (let i = 1; i <= 10; i++) {
    s.repos.message.append({
      id: `msg-${i}`,
      workspaceId,
      role: 'user',
      contentText: `第 ${i} 条`,
      now: NOW + i
    })
  }

  const recent = s.repos.message.listRecent(workspaceId, 3)
  assert.deepEqual(
    recent.map((m) => m.seq),
    [8, 9, 10],
    '最近 3 条应按 seq 升序返回（DB 内倒序取，出来翻正）'
  )

  const older = s.repos.message.listBefore(workspaceId, 8, 3)
  assert.deepEqual(older.map((m) => m.seq), [5, 6, 7], 'keyset 分页：无 OFFSET，不重不漏')

  const replay = s.repos.message.listAfter(workspaceId, 9, 100)
  assert.deepEqual(replay.map((m) => m.seq), [10], '切换空间后的重放原语（§4.3）')
  s.close()
})

test('软删除：消息从查询里消失，但行还在（历史可审计）', () => {
  const s = openStore(':memory:')
  const { workspaceId } = seed(s)
  const m = s.repos.message.append({
    id: 'msg-1',
    workspaceId,
    role: 'user',
    contentText: '删掉我',
    now: NOW
  })

  s.repos.message.softDelete(m.id, NOW + 1)

  assert.equal(s.repos.message.listRecent(workspaceId, 10).length, 0)
  const raw = s.db.prepare('SELECT deleted_at FROM message WHERE id = ?').get(m.id) as {
    deleted_at: number
  }
  assert.equal(raw.deleted_at, NOW + 1, '行必须还在，只是被标记')
  s.close()
})

test('压缩只改对话内容，不碰控制状态（§3.3）', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)

  for (let i = 1; i <= 5; i++) {
    s.repos.message.append({
      id: `msg-${i}`,
      workspaceId,
      sessionId,
      role: 'user',
      contentText: `第 ${i} 条`,
      now: NOW + i
    })
  }
  const turn = s.repos.turn.create({
    id: 'turn-1',
    sessionId,
    workspaceId,
    cwd: 'G:/work/mine',
    hopDepth: 2,
    now: NOW
  })

  const compacted = s.repos.message.markCompactedBySession(sessionId, 3, '前三条的摘要')
  s.repos.session.setCompaction(sessionId, 3, '前三条的摘要')

  assert.equal(compacted.length, 3)
  assert.equal(compacted.every((m) => m.injectMode === 'summary'), true)
  assert.equal(compacted.every((m) => m.summaryText === '前三条的摘要'), true)

  const session = s.repos.session.get(sessionId)
  assert.equal(session?.compactedThroughSeq, 3)
  assert.equal(session?.rollingSummary, '前三条的摘要')

  // ★ 跳数计数器活在自己的表里，压缩碰不到它
  assert.equal(s.repos.turn.get(turn.id)?.hopDepth, 2, '压缩不得重置跳数')
  s.close()
})

/** 再起一个成员 + 它的会话（`UNIQUE(workspace_id, member_id)`：一个成员一个会话）。 */
function secondSession(s: Store, workspaceId: string): string {
  const actor = s.repos.actor.create({
    id: 'a2',
    name: 'Nyx',
    model: 'deepseek-flash',
    personaPath: 'personas/nyx.md',
    personaHash: 'h2',
    now: NOW
  })
  const member = s.repos.member.create({
    id: 'm2',
    workspaceId,
    actorId: actor.id,
    displayName: '审查者',
    now: NOW
  })
  return s.repos.session.create('sess2', workspaceId, member.id, NOW).id
}

test('★★ 压缩的标记是**会话粒度**：同空间里别的成员一条都不许动', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)
  const session2 = secondSession(s, workspaceId)

  // 先把本会话的 5 条写完（seq 1..5），再写别人的（seq 6..10）。
  for (let i = 1; i <= 5; i++) {
    s.repos.message.append({
      id: `msg-${i}`,
      workspaceId,
      sessionId,
      role: 'user',
      contentText: `第 ${i} 条`,
      now: NOW + i
    })
  }
  for (let i = 1; i <= 5; i++) {
    s.repos.message.append({
      id: `other-${i}`,
      workspaceId,
      sessionId: session2,
      role: 'user',
      contentText: `别人 ${i}`,
      now: NOW + 10 + i
    })
  }

  const compacted = s.repos.message.markCompactedBySession(sessionId, 3, '前三条的摘要')
  assert.equal(compacted.length, 3)

  // ★★ 这条断言就是这次改名的全部理由。按 workspace 粒度标记会把 `other-*`
  //    一起标成 `summary`，而那些会话的水位线一动没动 —— 后果不是报错，
  //    而是「B 的历史在库里看起来已经被摘要取代了」，哪天有谁按 `inject_mode`
  //    去做判断，B 的历史就静默消失。
  for (let i = 1; i <= 5; i++) {
    assert.equal(
      s.repos.message.get(`other-${i}`)?.injectMode,
      'full',
      `别的会话的消息被压缩标记碰了：other-${i}`
    )
  }
  assert.equal(s.repos.message.get('msg-1')?.injectMode, 'summary')
  s.close()
})

test('压缩不碰已被明确排除的消息，也不碰已软删的', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)

  for (let i = 1; i <= 4; i++) {
    s.repos.message.append({
      id: `msg-${i}`,
      workspaceId,
      sessionId,
      role: 'user',
      contentText: `第 ${i} 条`,
      now: NOW + i
    })
  }
  // 一条被明确排除（`excluded` 是装配层**正在读**的状态，压缩不许把它改写掉），
  // 一条已软删（它已经不注入了，标它只是噪声）。
  s.repos.message.setInjectMode('msg-2', 'excluded', null)
  s.repos.message.softDelete('msg-3', NOW)

  const compacted = s.repos.message.markCompactedBySession(sessionId, 4, '摘要')
  assert.deepEqual(
    compacted.map((m) => m.id),
    ['msg-1', 'msg-4'],
    '只有 `full` 的活行会被标记'
  )
  assert.equal(s.repos.message.get('msg-2')?.injectMode, 'excluded', '「排除」的意图不许被压缩改写')
  s.close()
})

test('lastSeqBefore 是严格的 `<`，且没有活行时给 null 而不是 0', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)
  for (let i = 1; i <= 3; i++) {
    s.repos.message.append({
      id: `msg-${i}`,
      workspaceId,
      sessionId,
      role: 'user',
      contentText: `第 ${i} 条`,
      now: NOW + i
    })
  }

  assert.equal(s.repos.message.lastSeqBefore(sessionId, 3), 2, '严格小于：触发消息自己不算')
  assert.equal(s.repos.message.lastSeqBefore(sessionId, 99), 3)
  // ★ 0 是个合法的 seq 值，用它表示「没有」会让调用方在 `seq <= 0` 上做一个静默的错误判断。
  assert.equal(s.repos.message.lastSeqBefore(sessionId, 1), null)

  // 最大那条被软删之后，右端要退回去 —— 否则水位线会越过一条已经不注入的行。
  s.repos.message.softDelete('msg-3', NOW)
  assert.equal(s.repos.message.lastSeqBefore(sessionId, 99), 2)
  s.close()
})

test('listBySessionBetween 是开区间、升序，且排除被 `excluded` 的消息', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)
  for (let i = 1; i <= 5; i++) {
    s.repos.message.append({
      id: `msg-${i}`,
      workspaceId,
      sessionId,
      role: 'user',
      contentText: `第 ${i} 条`,
      now: NOW + i
    })
  }

  assert.deepEqual(
    s.repos.message.listBySessionBetween(sessionId, 1, 5, 100).map((m) => m.seq),
    [2, 3, 4],
    '两端都是开区间：已在水位线之下的（1）与本轮触发消息（5）都不该进来'
  )

  // ★ 摘要文本**就是**提示词内容 —— 折进去 = 把被排除的正文悄悄送回上下文。
  s.repos.message.setInjectMode('msg-3', 'excluded', null)
  assert.deepEqual(
    s.repos.message.listBySessionBetween(sessionId, 1, 5, 100).map((m) => m.seq),
    [2, 4]
  )
  s.close()
})

test('toolNamesOf 去重、按首次出现排序，且不碰 text_blob', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)
  s.repos.message.append({
    id: 'msg-1',
    workspaceId,
    sessionId,
    role: 'assistant',
    contentText: '干活',
    now: NOW
  })
  const add = (seq: number, toolName: string | null): void => {
    s.repos.message.appendEvent({
      messageId: 'msg-1',
      kind: 'tool_start',
      toolName,
      payloadJson: '{}',
      now: NOW + seq
    })
  }
  add(1, 'Read')
  add(2, 'Grep')
  add(3, 'Read')
  add(4, null) // 没有工具名的事件不算

  assert.deepEqual(s.repos.message.toolNamesOf('msg-1'), ['Read', 'Grep'], '去重且按首次出现的顺序')
  assert.deepEqual(s.repos.message.toolNamesOf('不存在的消息'), [])
  s.close()
})

test('★ 会话历史要**最近** N 条（不是最旧 N 条），且按 seq 升序回来', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)

  // ★ 造第二个会话**必须先造第二个成员** —— `session` 上有
  // `UNIQUE(workspace_id, member_id)`，也就是「一个成员在一个空间里只有一个会话」。
  // 这条约束同时说明了 §3.1 那个粒度错位为什么是真的会出事：
  // 会话是**每成员一条**，而 `message.seq` 是**空间级全序**，
  // 所以 workspace 粒度的压缩一定会碰到别的成员的消息。
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
    displayName: '写手',
    now: NOW
  })
  const other = s.repos.session.create('sess2', workspaceId, member2.id, NOW)

  for (let i = 1; i <= 5; i++) {
    s.repos.message.append({
      id: `recent-${i}`,
      workspaceId,
      sessionId,
      role: 'user',
      contentText: `本会话第 ${i} 条`,
      now: NOW + i
    })
  }
  for (let i = 1; i <= 2; i++) {
    s.repos.message.append({
      id: `other-${i}`,
      workspaceId,
      sessionId: other.id,
      role: 'user',
      contentText: `别的会话第 ${i} 条`,
      now: NOW + 100 + i
    })
  }
  // 空间时间线上的消息（`session_id` 为 NULL，人类用户直接发的那种）也不许混进来。
  s.repos.message.append({
    id: 'space-1',
    workspaceId,
    role: 'user',
    contentText: '空间流里的一条',
    now: NOW + 200
  })

  const got = s.repos.message.listRecentBySession(sessionId, 3)
  assert.deepEqual(
    got.map((m) => m.contentText),
    ['本会话第 3 条', '本会话第 4 条', '本会话第 5 条'],
    '★ 给上下文装配用的窗口必须是**最近**的，否则第二轮就看不到刚说过的第一轮'
  )
  assert.deepEqual(
    got.map((m) => m.seq),
    [...got.map((m) => m.seq)].sort((a, b) => a - b),
    '调用方拿到的永远是「老 → 新」'
  )
  assert.equal(
    got.some((m) => m.id === 'space-1'),
    false,
    '空间流（session_id 为 NULL）是另一条时间线，不许混进会话窗口'
  )

  // ★ 反向对照：`listBySession` 取的是**最旧**的 N 条。两者只差一个 `DESC`，
  // 所以拿错的那个从 M2 起一直没被发现 —— 它不报错，只是把一个长会话的
  // **最近几轮换成了最早几轮**。这一条断言把「两个方法确实不同」钉住。
  assert.deepEqual(
    s.repos.message.listBySession(sessionId, 3).map((m) => m.contentText),
    ['本会话第 1 条', '本会话第 2 条', '本会话第 3 条']
  )

  s.close()
})

// ─────────────────────────────────────────────────────────────
// §4.4 孤儿清扫
// ─────────────────────────────────────────────────────────────

test('★ 孤儿清扫：启动时把遗留的 queued/running 翻成 failed', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)

  const running = s.repos.turn.create({
    id: 'turn-running',
    sessionId,
    workspaceId,
    cwd: 'G:/work/mine',
    now: NOW
  })
  // ★ 状态与 pid 是**两次**写入（见 `markRunning()` 的说明）：派发时还不知道 pid，
  // 它要等 spawn 之后才补。这里把这两步都走一遍，顺带证明中间那段
  // `running` 且 `pid IS NULL` 是合法的。
  s.repos.turn.markRunning(running.id, NOW)
  assert.equal(
    s.repos.turn.get(running.id)?.pid,
    null,
    'markRunning 之后、setPid 之前，pid 就是空的 —— 这是合法状态，不是漏写'
  )
  s.repos.turn.setPid(running.id, 12345)
  // 只为在库里留下一个 queued 轮次（值本身用不到），供后面的孤儿清扫断言
  s.repos.turn.create({
    id: 'turn-queued',
    sessionId,
    workspaceId,
    cwd: 'G:/work/mine',
    now: NOW
  })
  const done = s.repos.turn.create({
    id: 'turn-done',
    sessionId,
    workspaceId,
    cwd: 'G:/work/mine',
    now: NOW
  })
  s.repos.turn.finish(done.id, 'done', { costUsd: 0.01 }, NOW + 5)

  assert.equal(s.repos.turn.listLive().length, 2)

  const reaped = s.repos.turn.reapOrphans(NOW + 100)

  assert.deepEqual(reaped.map((t) => t.id).sort(), ['turn-queued', 'turn-running'])
  assert.equal(reaped.every((t) => t.status === 'failed'), true)
  assert.equal(
    reaped.find((t) => t.id === 'turn-running')?.pid,
    12345,
    'PID 必须还在 —— 调用方要靠它 taskkill 那个可能比父进程活得久的 claude 进程'
  )
  assert.equal(
    s.repos.turn.get(done.id)?.status,
    'done',
    '已终结的轮次不受清扫影响'
  )
  assert.equal(s.repos.turn.listLive().length, 0)
  s.close()
})

test('孤儿清扫可重复调用（第二次没有可清扫的东西）', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)
  const t = s.repos.turn.create({ id: 't1', sessionId, workspaceId, cwd: 'x', now: NOW })

  assert.equal(s.repos.turn.reapOrphans(NOW).length, 1)
  assert.equal(s.repos.turn.reapOrphans(NOW).length, 0)
  assert.equal(s.repos.turn.get(t.id)?.status, 'failed')
  s.close()
})

test('turn 的终态字段完整落库（成本 / token / 终止原因）', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)
  const t = s.repos.turn.create({ id: 't1', sessionId, workspaceId, cwd: 'G:/work/mine', now: NOW })
  s.repos.turn.markRunning(t.id, NOW + 1)

  const finished = s.repos.turn.finish(
    t.id,
    'interrupted',
    { costUsd: 0.0234, tokensIn: 12000, tokensOut: 800, terminalReason: 'user_interrupt' },
    NOW + 5000,
    0,
    null
  )

  assert.equal(finished?.status, 'interrupted')
  assert.equal(finished?.costUsd, 0.0234)
  assert.equal(finished?.tokensIn, 12000)
  assert.equal(finished?.tokensOut, 800)
  assert.equal(finished?.terminalReason, 'user_interrupt')
  assert.equal(finished?.startedAt, NOW + 1)
  assert.equal(finished?.endedAt, NOW + 5000)
  s.close()
})

test('session.advanceSeq 只前进不后退', () => {
  const s = openStore(':memory:')
  const { sessionId } = seed(s)

  s.repos.session.advanceSeq(sessionId, 10)
  assert.equal(s.repos.session.get(sessionId)?.lastSeq, 10)

  s.repos.session.advanceSeq(sessionId, 4)
  assert.equal(s.repos.session.get(sessionId)?.lastSeq, 10, '回退的水位会破坏 stream:resume 的重放原语')
  s.close()
})

// ─────────────────────────────────────────────────────────────
// 事务纪律（这两个用例都是被真实缺陷逼出来的，见下方注释）
// ─────────────────────────────────────────────────────────────

test('★ 事务内的非 SQL 错误必须原样抛上，不能被 ROLLBACK 的报错盖掉', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)

  // 用一条违反 NOT NULL 的事件触发失败。真正要断言的不是它失败，
  // 而是**失败的原因**能传出来。
  //
  // 背景：`appendEvent` 曾经是手写的 `BEGIN` / `COMMIT` / `ROLLBACK`。
  // 一旦 try 里抛的是个普通 JS 错误（当时实际是漏 import 的 `nbool`），
  // catch 里的 `ROLLBACK` 会接着抛 `cannot rollback - no transaction is active`，
  // 于是调用方看到的是这条毫无信息量的报错，真正的病因被永久掩埋。
  assert.throws(
    () => s.repos.message.appendEvent({ messageId: 'does-not-exist', kind: 'thinking', now: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.doesNotMatch(
        err.message,
        /cannot rollback|no transaction is active/,
        '回滚失败绝不能替换掉原始错误'
      )
      assert.match(err.message, /FOREIGN KEY constraint failed/)
      return true
    }
  )
  assert.equal(s.repos.message.countEvents('does-not-exist'), 0)
  assert.ok(s.repos.workspace.get(workspaceId))
  assert.ok(s.repos.session.get(sessionId), '失败的事务不该把连接带坏')
  s.close()
})

test('★ repository 的写方法可以嵌套在外层事务里（SAVEPOINT 分层）', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)

  // 编排层（M6 的 event-batcher）会把「追加消息 + 追加事件 + 推进 seq」
  // 打包进一个 `store.tx()`。所以 repo 方法自己开事务时必须是**可嵌套**的，
  // 不能是裸 BEGIN —— 那会在外层已经有事务时直接抛
  // "cannot start a transaction within a transaction"。
  const msg = s.tx(() => {
    const m = s.repos.message.append({
      id: 'msg-nested',
      workspaceId,
      sessionId,
      role: 'assistant',
      now: NOW
    })
    s.repos.message.appendEvent({ messageId: m.id, kind: 'text', textBlob: 'hi', now: NOW })
    s.repos.message.appendEvent({ messageId: m.id, kind: 'done', now: NOW + 1 })
    s.repos.session.advanceSeq(sessionId, m.seq)
    return m
  })

  assert.equal(s.repos.message.countEvents(msg.id), 2, '内层提交不该被外层吞掉')
  const events = s.repos.message.listEvents(msg.id)
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2],
    '消息内的事件 seq 应当连续单调'
  )
  assert.equal(s.repos.session.get(sessionId)?.lastSeq, msg.seq)
  s.close()
})

test('★ 外层事务回滚时，内层已提交的写操作一并撤销', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)

  assert.throws(() =>
    s.tx(() => {
      const m = s.repos.message.append({
        id: 'msg-doomed',
        workspaceId,
        sessionId,
        role: 'assistant',
        now: NOW
      })
      s.repos.message.appendEvent({ messageId: m.id, kind: 'text', textBlob: 'gone', now: NOW })
      throw new Error('编排层决定放弃这一批')
    })
  )

  assert.equal(s.repos.message.get('msg-doomed'), null, '内层的 COMMIT 必须只是 RELEASE SAVEPOINT')
  assert.equal(s.repos.message.listRecent(workspaceId, 10).length, 0)
  s.close()
})

// ─────────────────────────────────────────────────────────────
// M7b 新增的两个读者：`listByTurn` 与 `listRecentByQueuedAt`
// ─────────────────────────────────────────────────────────────

test('★ `listByTurn` 拿到的是「**这一轮自己的产物**」—— 用户那条触发消息不在里面', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)

  // 顺序就是生产的顺序（`handlers/turn.ts`）：**先**插用户消息（那时轮次还不存在），
  // **再**建轮次并让它回指那条消息。所以 `message.turn_id` 在用户行上是 NULL。
  const user = s.repos.message.append({
    id: 'msg-trigger',
    workspaceId,
    sessionId,
    role: 'user',
    contentText: '请把 a.ts 的 x 改成 2',
    now: NOW
  })
  const turn = s.repos.turn.create({
    id: 'turn-1',
    sessionId,
    workspaceId,
    triggerMessageId: user.id,
    cwd: 'G:/work/mine',
    now: NOW
  })
  const reply = s.repos.message.append({
    id: 'msg-reply',
    workspaceId,
    sessionId,
    turnId: turn.id,
    role: 'assistant',
    contentText: '改好了。\n<mentions>Nyx</mentions>',
    now: NOW + 1
  })

  const produced = s.repos.message.listByTurn(turn.id)
  assert.deepEqual(
    produced.map((m) => m.id),
    [reply.id],
    '★ 这一条正是扇出要读的「这一轮的回复」—— 混进触发消息的话，'
      + '被 @ 的人会看到用户自己写的话被当成模型的回复再转述一遍'
  )
  assert.equal(s.repos.message.get(user.id)?.turnId, null, '用户行的 turn_id 就是 NULL（协议如此，不是缺数据）')
  assert.equal(s.repos.turn.get(turn.id)?.triggerMessageId, user.id, '要拿触发消息就走轮次这一头')

  s.close()
})

test('★ `listRecentByQueuedAt` 按**发起顺序**取，连排队中的一起；`listRecentByWorkspace` 办不到', () => {
  const s = openStore(':memory:')
  const { workspaceId, sessionId } = seed(s)
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
    displayName: '写手',
    now: NOW
  })
  const other = s.repos.session.create('sess2', workspaceId, member2.id, NOW)

  // 第一条：发起得早、也跑得早。
  const early = s.repos.turn.create({
    id: 't-early',
    sessionId,
    workspaceId,
    hopDepth: 0,
    cwd: 'G:/work/mine',
    now: NOW + 1
  })
  s.repos.turn.markRunning(early.id, NOW + 2)
  s.repos.turn.setPid(early.id, 4242)
  s.repos.turn.finish(early.id, 'done', {}, NOW + 3, 0)

  // 第二条：发起得晚，但在队列里**等了一会**才开始（并发槽位被占着 —— 这是常态）。
  const waited = s.repos.turn.create({
    id: 't-waited',
    sessionId: other.id,
    workspaceId,
    hopDepth: 1,
    cwd: 'G:/work/mine',
    now: NOW + 4
  })
  s.repos.turn.markRunning(waited.id, NOW + 20)
  s.repos.turn.setPid(waited.id, 4243)
  s.repos.turn.finish(waited.id, 'done', {}, NOW + 21, 0)

  // 第三条：刚派出去、**还没跑**（`started_at` 为 NULL，状态 `queued`）。
  const fresh = s.repos.turn.create({
    id: 't-fresh',
    sessionId,
    workspaceId,
    hopDepth: 2,
    cwd: 'G:/work/mine',
    now: NOW + 30
  })

  assert.deepEqual(
    s.repos.turn.listRecentByQueuedAt(workspaceId, 10).map((t) => t.id),
    [early.id, waited.id, fresh.id],
    '★ 链的判据要的是「连排队中的一起、按发起顺序」—— 这就是它和 `listRecentByWorkspace` 的分工'
  )

  // ★ 反向对照：`listRecentByWorkspace` 按 `started_at DESC` 排。
  // 两者**真的不同**，而且差在最要紧的那一条上：`listRecentByQueuedAt` 把刚派出去、
  // 还没跑的那一跳放在**尾部**（链判据正是从尾部往前看），而按 `started_at` 排
  // 它会掉到最末 —— 后缀断在它那里，熔断永远数不满。
  const byStarted = s.repos.turn.listRecentByWorkspace(workspaceId, 10)
  assert.deepEqual(
    byStarted.map((t) => t.id),
    [waited.id, early.id, fresh.id],
    '按 started_at 倒序：等得久的那条排第一（发起顺序被丢掉了）'
  )
  assert.notDeepEqual(byStarted.map((t) => t.id), [early.id, waited.id, fresh.id])

  s.close()
})
