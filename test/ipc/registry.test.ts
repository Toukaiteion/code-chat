/**
 * M3 验证之一：registry 的**分发纪律**。
 *
 * 三条不变量各有一组用例（见 `registry.ts` 顶部）：
 * 1. 每个 invoke 都返回信封，绝不向边界抛
 * 2. 每份入站载荷都过 zod —— 无论通道实现没实现
 * 3. 每个通道都被明确分类（handle 或 defer），漏掉的在 `seal()` 就炸
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { INVOKE_CHANNELS } from '../../src/shared/ipc/channels.ts'
import { createRegistry } from '../../src/main/ipc/registry.ts'
import { registerAll } from '../../src/main/ipc/handlers/index.ts'
import { DEFAULT_CONCURRENCY } from '../../src/main/ipc/handlers/misc.ts'
import { expectFail, expectOk, fakeTransport, harness, makeActor, makeMember, makeProject, makeWorkspace, testContext } from './helpers.ts'
import { openStore } from '../../src/main/persist/index.ts'
import type { Workspace } from '../../src/shared/entities.ts'

// ─────────────────────────────────────────────────────────────
// 不变量 3：每个通道都被明确分类
// ─────────────────────────────────────────────────────────────

test('seal() 把全部 invoke 通道接到了 transport 上', () => {
  const h = harness()
  assert.equal(
    h.transport.size(),
    INVOKE_CHANNELS.length,
    'seal() 之后 transport 上的通道数应等于通道清单长度'
  )
})

test('漏掉分类的通道会让 seal() 抛错，而不是等用户点下去才发现', () => {
  const store = openStore(':memory:')
  const ctx = testContext(store)
  const transport = fakeTransport()
  const r = createRegistry(transport, ctx)
  registerAll(r, ctx)

  // 模拟「以后加了一个通道，但忘了在 handlers/index.ts 里分类」。
  // 直接改清单是不行的（它是 shared 的单一事实源），所以换个等价的做法：
  // 用一个只注册了部分通道的 registry —— `workspace:list` 不注册。
  const partial = createRegistry(fakeTransport(), testContext(store))
  partial.handle('workspace:list', () => [])
  assert.throws(() => partial.seal(), /既未实现也未标记为 defer/, '缺分类必须抛错')

  // 反证：同一个清单，分类齐了就不抛。
  assert.doesNotThrow(() => r.seal())
})

test('每个通道调用后都有明确归属：成功、E_INVALID_PAYLOAD、或 E_NOT_IMPLEMENTED', async () => {
  const h = harness()

  for (const channel of INVOKE_CHANNELS) {
    // 全部传 undefined：无载荷通道正常通过校验；有载荷通道会得到 E_INVALID_PAYLOAD。
    // 这里只断言「有归属、且不越界抛异常」，具体行为各有用例覆盖。
    const result = await h.call(channel, undefined)
    if (result.ok) continue
    assert.ok(
      result.error.code === 'E_INVALID_PAYLOAD' || result.error.code === 'E_NOT_IMPLEMENTED',
      `${channel} 返回了意外的错误码 ${result.error.code}`
    )
  }
})

test('★ 未实现的通道在合法载荷下返回 E_NOT_IMPLEMENTED，并带上里程碑号', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const { memberId, sessionId } = await makeMember(h, w, await makeActor(h))

  // 这些载荷**全都能过 zod**（否则测的就不是「未实现」而是「校验」了）。
  const valid: Record<string, unknown> = {
    'turn:send': { workspaceId: w, memberId, text: '你好' },
    'turn:interject': { turnId: 't1', text: '插一句' },
    'turn:stopAll': { workspaceId: w },
    'stream:resume': { sessionId, fromSeq: 0 }
  }

  const reported: Record<string, string> = {}
  for (const [channel, payload] of Object.entries(valid)) {
    const error = expectFail(await h.call(channel, payload))
    assert.equal(error.code, 'E_NOT_IMPLEMENTED', `${channel} 应当明确报告未实现`)
    reported[channel] = (error.detail as { milestone: string }).milestone
  }

  /**
   * ★ 「不填桩」那个决定的清单化表达：这些通道永远不返回伪造的成功数据。
   *
   * M4 把 `project:copy` / `project:clone` 从这个清单里**移走了** —— 它们真的实现了，
   * 不再是 defer。真正实现的那两条由 `test/ipc/import.test.ts` 覆盖（真文件系统、
   * 真 git），不在这里用「未实现」的方式验。
   */
  assert.deepEqual(reported, {
    'turn:send': 'M5/M6',
    'turn:interject': 'M9',
    'turn:stopAll': 'M9',
    'stream:resume': 'M6'
  })
})

// ─────────────────────────────────────────────────────────────
// 不变量 2：入站一律过 zod，且校验在实现检查**之前**
// ─────────────────────────────────────────────────────────────

test('畸形载荷被 zod 拒绝，且 handler 一次都没被调用', async () => {
  const h = harness()
  let calls = 0
  h.registry.handle('workspace:list', () => {
    calls++
    return h.store.repos.workspace.list()
  })

  // workspace:list 的 req 是 NoPayload，给个字符串必然拒绝。
  const error = expectFail(await h.call('workspace:list', 'not-a-payload'))
  assert.equal(error.code, 'E_INVALID_PAYLOAD')

  const details = error.detail as { issues: Array<{ path: string[]; code: string }> }
  assert.ok(Array.isArray(details.issues) && details.issues.length > 0, 'detail 里应有 zod issues')
  assert.equal(calls, 0, '校验失败时 handler 不该被调用')
})

test('未实现的通道也照样校验载荷 —— 规则统一，没有例外', async () => {
  const h = harness()

  // 空载荷 → 先撞校验
  assert.equal(expectFail(await h.call('turn:send', undefined)).code, 'E_INVALID_PAYLOAD')

  // 合法载荷 → 才轮到「没实现」
  const error = expectFail(
    await h.call('turn:send', { workspaceId: 'w', memberId: 'm', text: 'hi' })
  )
  assert.equal(error.code, 'E_NOT_IMPLEMENTED')
  assert.equal((error.detail as { milestone: string }).milestone, 'M5/M6', '必须带上里程碑号')
})

test('limit 超过上限被拒 —— 渲染层一次要不走一百万行', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  assert.equal(
    expectFail(await h.call('message:list', { workspaceId: w, limit: 1_000_000 })).code,
    'E_INVALID_PAYLOAD'
  )
  assert.ok(expectOk(await h.call('message:list', { workspaceId: w, limit: 500 })))
})

// ─────────────────────────────────────────────────────────────
// 不变量 1 + M3 的验收标准
// ─────────────────────────────────────────────────────────────

test('★ 验收标准：空库上 workspace:list 返回 []', async () => {
  const h = harness()
  assert.deepEqual(expectOk(await h.call('workspace:list')), [])
})

test('workspace:list 在没传载荷时也能调（Electron 给 undefined 或 null 都行）', async () => {
  const h = harness()
  assert.deepEqual(expectOk(await h.call('workspace:list', undefined)), [])
  assert.deepEqual(expectOk(await h.call('workspace:list', null)), [])
})

test('handler 抛出的异常被转成信封，绝不跨边界抛出去', async () => {
  const h = harness()
  h.registry.handle('workspace:list', () => {
    throw new Error('boom')
  })
  const error = expectFail(await h.call('workspace:list', undefined))
  assert.equal(error.code, 'E_INTERNAL')
  assert.equal(error.message, 'boom')
})

test('非 Error 的抛出物也能变成信封（detail 不可克隆时不能反过来炸掉信封）', async () => {
  const h = harness()
  h.registry.handle('workspace:list', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    throw circular
  })
  const error = expectFail(await h.call('workspace:list', undefined))
  assert.equal(error.code, 'E_INTERNAL')
})

// ─────────────────────────────────────────────────────────────
// 出站也校验
// ─────────────────────────────────────────────────────────────

test('emit 出站校验：形状不对的推送被丢弃，不发给渲染层', () => {
  const h = harness()
  const originalError = console.error
  const logged: unknown[] = []
  console.error = (...args: unknown[]) => logged.push(args)

  try {
    // @ts-expect-error 故意传错形状：缺 sessionId / turnId
    h.registry.emit('stream:status', { workspaceId: 'w', status: 'running' })
  } finally {
    console.error = originalError
  }

  assert.equal(h.transport.sent.length, 0, '形状不对的推送不能出站')
  assert.equal(logged.length, 1, '静默丢弃是不行的 —— 必须留下日志')
})

test('emit 形状正确时真的发出去，并带上通道名', () => {
  const h = harness()
  h.registry.emit('app:notice', { level: 'info', message: 'hi' })
  assert.deepEqual(h.transport.sent, [{ channel: 'app:notice', payload: { level: 'info', message: 'hi' } }])
})

// ─────────────────────────────────────────────────────────────
// workspace / project / member 的真操作
// ─────────────────────────────────────────────────────────────

test('workspace 的建改删走的是真数据', async () => {
  const h = harness()
  const id = await makeWorkspace(h, 'Nova')

  assert.equal(expectOk<Workspace[]>(await h.call('workspace:list')).length, 1)
  assert.equal(expectOk<Workspace>(await h.call('workspace:update', { id, name: 'Orion' })).name, 'Orion')

  // 没有项目 → 没有副本可谈；但**空间目录本身照常报告**（永不删除，只说它在哪）。
  const report = expectOk<{
    deleted: boolean
    copies: unknown[]
    workspaceDir: string
    workspaceDirExists: boolean
  }>(await h.call('workspace:delete', { id }))
  assert.equal(report.deleted, true)
  assert.deepEqual(report.copies, [])
  assert.equal(report.workspaceDirExists, true, '空间目录不随记录一起删')
  assert.match(report.workspaceDir, /Nova$/)

  assert.deepEqual(expectOk(await h.call('workspace:list')), [])
})

test('改一个不存在的空间 → E_NOT_FOUND，而不是静默的空操作', async () => {
  const h = harness()
  assert.equal(
    expectFail(await h.call('workspace:update', { id: 'nope', name: 'x' })).code,
    'E_NOT_FOUND'
  )
})

test('setActive 拒绝把别的空间的项目设为本空间的活跃项目', async () => {
  const h = harness()
  const a = await makeWorkspace(h, 'A')
  const b = await makeWorkspace(h, 'B')
  const p = makeProject(h.store, b, 'p-b', 'B 的项目', 'G:/b')

  const error = expectFail(await h.call('workspace:setActive', { id: a, projectId: p }))
  assert.equal(error.code, 'E_CONFLICT')
  assert.ok(expectOk<Workspace>(await h.call('workspace:setActive', { id: a, projectId: null })))
})

test('project:addLocal 是真操作：校验目录存在，且把路径归一成绝对路径', async () => {
  const h = harness()
  const w = await makeWorkspace(h)

  const dir = await mkdtemp(join(tmpdir(), 'code-chat-test-'))
  try {
    const project = expectOk<{ rootPath: string; origin: string }>(
      await h.call('project:addLocal', { workspaceId: w, name: '我的目录', rootPath: dir })
    )
    assert.equal(project.origin, 'local', 'addLocal 注册的必须是 local 型')
    assert.equal(project.rootPath, resolve(dir), 'root_path 必须是归一化后的绝对路径')

    // 同一个目录再来一次 → 人话版的 E_CONFLICT（而不是 2067 的原始报错）
    const dup = expectFail(await h.call('project:addLocal', { workspaceId: w, name: '重复', rootPath: dir }))
    assert.equal(dup.code, 'E_CONFLICT')
    assert.match(dup.message, /已经加过了/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('project:addLocal 拒绝不存在的目录，也拒绝指向文件的路径', async () => {
  const h = harness()
  const w = await makeWorkspace(h)

  assert.equal(
    expectFail(await h.call('project:addLocal', { workspaceId: w, name: 'x', rootPath: 'G:/definitely/not/here/xyz' })).code,
    'E_NOT_FOUND'
  )

  const dir = await mkdtemp(join(tmpdir(), 'code-chat-test-'))
  try {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hi')
    assert.equal(
      expectFail(await h.call('project:addLocal', { workspaceId: w, name: 'x', rootPath: file })).code,
      'E_INVALID_PAYLOAD'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('project:remove 只删数据库行 —— 磁盘目录一个字节都不动', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const dir = await mkdtemp(join(tmpdir(), 'code-chat-test-'))

  try {
    const project = expectOk<{ id: string }>(
      await h.call('project:addLocal', { workspaceId: w, name: '我的', rootPath: dir })
    )
    // ★ 即使明确要求删副本也必须拒绝 —— `local` 型不归我们管。
    //   报告里 `state: 'kept'` 是**要说给用户听**的：勾了却没发生，必须有个交代。
    const report = expectOk<{ deleted: boolean; copy: { state: string; path: string } }>(
      await h.call('project:remove', { id: project.id, deleteCopy: true })
    )
    assert.equal(report.deleted, true)
    assert.equal(report.copy.state, 'kept', 'local 型永远不删磁盘')
    assert.equal(report.copy.path, resolve(dir))

    // 目录仍在 —— 这是 §8.2 的硬要求，不是副作用。
    const { stat } = await import('node:fs/promises')
    assert.ok((await stat(dir)).isDirectory(), 'local 型项目删记录后目录必须还在')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('member:create 在同一个事务里把 session 建出来（1:1 不变量的落点）', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const a = await makeActor(h)

  const { memberId, sessionId } = await makeMember(h, w, a)
  assert.ok(memberId && sessionId)

  // 同一个 actor 再来一次 → 关系表中止
  assert.equal(
    expectFail(await h.call('member:create', { workspaceId: w, actorId: a, displayName: '重复' })).code,
    'E_CONFLICT'
  )
})

test('每个空间至多一个路由角色：第二个被拒绝，且指出是谁占着', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const m1 = await makeMember(h, w, await makeActor(h, 'Atlas'))
  const m2 = await makeMember(h, w, await makeActor(h, 'Nyx'), '评审')

  assert.ok(expectOk(await h.call('member:setRouter', { id: m1.memberId, isRouter: true })))

  const error = expectFail(await h.call('member:setRouter', { id: m2.memberId, isRouter: true }))
  assert.equal(error.code, 'E_CONFLICT')
  assert.match(error.message, /路由角色已经是/)
})

test('可见性：无行 = 全部可见，且这些边界都被拦下', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const other = await makeWorkspace(h, '别的空间')
  const { memberId } = await makeMember(h, w, await makeActor(h))

  const p1 = makeProject(h.store, w, 'p1', 'A', 'G:/a')
  const p2 = makeProject(h.store, w, 'p2', 'B', 'G:/b')
  const foreign = makeProject(h.store, other, 'p3', 'C', 'G:/c')

  // 默认全可见：ids 为空但 isRestricted=false ——「空」不等于「看不见」
  assert.deepEqual(expectOk(await h.call('member:visibility', { memberId })), {
    ids: [],
    isRestricted: false,
    primaryProjectId: null
  })

  // 跨空间的项目不能配进来（外键只保证项目存在，领域规则在这一层）
  assert.equal(
    expectFail(await h.call('member:setVisibility', { memberId, projectIds: [foreign], primaryProjectId: null })).code,
    'E_CONFLICT'
  )

  // 主项目必须在可见集合里
  assert.equal(
    expectFail(await h.call('member:setVisibility', { memberId, projectIds: [p1], primaryProjectId: p2 })).code,
    'E_INVALID_PAYLOAD'
  )

  const rows = expectOk<unknown[]>(
    await h.call('member:setVisibility', { memberId, projectIds: [p1, p2], primaryProjectId: p1 })
  )
  assert.equal(rows.length, 2)
  assert.deepEqual(expectOk(await h.call('member:visibility', { memberId })), {
    ids: [p1, p2],
    isRestricted: true,
    primaryProjectId: p1
  })

  // 撤销收窄 → 回到全可见，且主项目标记一并清掉
  assert.equal(expectOk(await h.call('member:clearVisibility', { memberId })), null)
  assert.deepEqual(expectOk(await h.call('member:visibility', { memberId })), {
    ids: [],
    isRestricted: false,
    primaryProjectId: null
  })
})

test('setPrimary 拒绝「悄悄地把他收窄成一个项目」', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const { memberId } = await makeMember(h, w, await makeActor(h))
  const p1 = makeProject(h.store, w, 'p1', 'A', 'G:/a')

  // 未收窄的成员没有可挂主项目的位置 —— 顺手插一行等于偷改语义
  const error = expectFail(await h.call('member:setPrimary', { memberId, projectId: p1, isPrimary: true }))
  assert.equal(error.code, 'E_CONFLICT')
  assert.match(error.message, /可见全部项目/)
})

// ─────────────────────────────────────────────────────────────
// turn：M3 里唯一「部分实现」的通道，两半都必须是真话
// ─────────────────────────────────────────────────────────────

test('turn:stop 对排队中的轮次是真的停掉了', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const { sessionId } = await makeMember(h, w, await makeActor(h))

  const turn = h.store.repos.turn.create({
    id: 't1',
    sessionId,
    workspaceId: w,
    cwd: 'G:/a',
    now: 1
  })
  assert.equal(turn.status, 'queued')

  const stopped = expectOk<{ status: string; endedAt: number }>(await h.call('turn:stop', { turnId: 't1' }))
  assert.equal(stopped.status, 'cancelled')
  assert.ok(stopped.endedAt, '取消也要写 ended_at —— 否则「运行时长」算不出来')
})

test('turn:stop 对运行中的轮次诚实地说「还没实现」，而不是谎报成功', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const { sessionId } = await makeMember(h, w, await makeActor(h))
  h.store.repos.turn.create({ id: 't1', sessionId, workspaceId: w, cwd: 'G:/a', now: 1 })
  h.store.repos.turn.markRunning('t1', 4242, 2)

  const error = expectFail(await h.call('turn:stop', { turnId: 't1' }))
  assert.equal(error.code, 'E_NOT_IMPLEMENTED')
  assert.equal((error.detail as { milestone: string }).milestone, 'M9')

  // 关键：状态**没有**被改动。谎报成功会让 UI 显示已停止，而进程还在跑。
  assert.equal(h.store.repos.turn.get('t1')?.status, 'running')
})

test('turn:stop 对已结束的轮次返回 E_CONFLICT（不能把 done 改写成 cancelled）', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const { sessionId } = await makeMember(h, w, await makeActor(h))
  h.store.repos.turn.create({ id: 't1', sessionId, workspaceId: w, cwd: 'G:/a', now: 1 })
  h.store.repos.turn.markRunning('t1', 1, 2)
  h.store.repos.turn.finish('t1', 'done', {}, 3)

  assert.equal(expectFail(await h.call('turn:stop', { turnId: 't1' })).code, 'E_CONFLICT')
  assert.equal(h.store.repos.turn.get('t1')?.status, 'done', '真实结局不能被抹掉')
})

// ─────────────────────────────────────────────────────────────
// message / view / runtime
// ─────────────────────────────────────────────────────────────

test('message:list 的三种取法按优先级生效，且一律升序返回', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const { memberId, sessionId } = await makeMember(h, w, await makeActor(h))

  const append = (id: string, text: string, mine: boolean): void => {
    h.store.repos.message.append({
      id,
      workspaceId: w,
      sessionId: mine ? sessionId : null,
      role: mine ? 'assistant' : 'user',
      authorMemberId: mine ? memberId : null,
      contentText: text,
      now: 1
    })
  }
  append('m1', '第一', false)
  append('m2', '第二', true)
  append('m3', '第三', true)

  // 都不给 → 空间时间线最近 N 条
  const recent = expectOk<Array<{ id: string }>>(await h.call('message:list', { workspaceId: w, limit: 2 }))
  assert.deepEqual(recent.map((m) => m.id), ['m2', 'm3'], '取最近 N 条并升序')

  // beforeSeq → keyset 分页
  const before = expectOk<Array<{ id: string }>>(
    await h.call('message:list', { workspaceId: w, beforeSeq: 3, limit: 10 })
  )
  assert.deepEqual(before.map((m) => m.id), ['m1', 'm2'])

  // sessionId 优先于 beforeSeq
  const bySession = expectOk<Array<{ id: string }>>(
    await h.call('message:list', { workspaceId: w, sessionId, beforeSeq: 3, limit: 10 })
  )
  assert.deepEqual(bySession.map((m) => m.id), ['m2', 'm3'])
})

test('message:getEvents 区分「消息不存在」和「这条消息没有事件」', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const { sessionId } = await makeMember(h, w, await makeActor(h))
  h.store.repos.message.append({ id: 'm1', workspaceId: w, sessionId, role: 'assistant', contentText: 'x', now: 1 })

  assert.deepEqual(expectOk(await h.call('message:getEvents', { messageId: 'm1' })), [])
  assert.equal(expectFail(await h.call('message:getEvents', { messageId: 'nope' })).code, 'E_NOT_FOUND')
})

test('view:setActive 写的是内存里的视图状态，不落库', async () => {
  const h = harness()
  const w = await makeWorkspace(h)
  const { sessionId } = await makeMember(h, w, await makeActor(h))

  assert.equal(expectOk(await h.call('view:setActive', { workspaceId: w, sessionId })), null)
  assert.deepEqual(h.ctx.view, { workspaceId: w, sessionId })
})

test('runtime:getState 的三个字段是诚实的 0，不是桩数据', async () => {
  const h = harness()
  const state = expectOk<{
    liveTurns: unknown[]
    queueDepth: number
    slots: { used: number; total: number }
  }>(await h.call('runtime:getState'))

  assert.deepEqual(state.liveTurns, [])
  assert.equal(state.queueDepth, 0)
  assert.deepEqual(state.slots, { used: 0, total: DEFAULT_CONCURRENCY })
})

test('seal() 之后可以重复调用（幂等），不会重复接线', () => {
  const h = harness()
  h.registry.seal()
  assert.equal(h.transport.size(), INVOKE_CHANNELS.length)
})
