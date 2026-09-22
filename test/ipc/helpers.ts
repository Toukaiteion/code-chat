/**
 * `test/ipc/` 共用的测试脚手架。
 *
 * ★ 这里能存在，本身就是「registry 不 import electron」那条纪律的收益：
 * 一份假 transport + 一个内存库，整个 IPC 路径（zod 校验 → 分发 → 信封 →
 * 错误映射）就在裸 Node 下跑完了，不需要起窗口。
 */
import { openStore } from '../../src/main/persist/index.ts'
import type { Store } from '../../src/main/persist/index.ts'
import { createRegistry, type HandlerContext, type Registry } from '../../src/main/ipc/registry.ts'
import { registerAll } from '../../src/main/ipc/handlers/index.ts'
import type { IpcTransport } from '../../src/main/ipc/transport.ts'
import type { IpcResult } from '../../src/shared/ipc/envelope.ts'

export const NOW = 1_700_000_000_000

export interface FakeTransport extends IpcTransport {
  /** 直接调某个通道，绕开 electron —— 返回的永远是信封。 */
  call(channel: string, payload?: unknown): Promise<IpcResult<unknown>>
  /** 记录 `send` 出站的推送，用于验证出站校验。 */
  sent: Array<{ channel: string; payload: unknown }>
  /** 已接在 transport 上的通道数。 */
  size(): number
}

export function fakeTransport(): FakeTransport {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
  const sent: Array<{ channel: string; payload: unknown }> = []

  return {
    sent,
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    send(channel, payload) {
      sent.push({ channel, payload })
    },
    size: () => handlers.size,
    async call(channel, payload) {
      const fn = handlers.get(channel)
      if (!fn) {
        // 真实世界里这里应该是 preload 的白名单拒绝。测试里直接说清是脚手架的问题。
        throw new Error(`测试脚手架错误：通道 ${channel} 没有接在 transport 上`)
      }
      return (await fn(payload)) as IpcResult<unknown>
    }
  }
}

/** `now` / `newId` 都**确定**：断言里因此能写具体值，而不是「非空」。 */
export function testContext(store: Store): HandlerContext {
  let n = 0
  return {
    store,
    now: () => NOW,
    newId: () => `id-${++n}`,
    view: { workspaceId: null, sessionId: null }
  }
}

export interface Harness {
  store: Store
  registry: Registry
  transport: FakeTransport
  ctx: HandlerContext
  call: FakeTransport['call']
}

/** 内存库 + 全量 handler + 假 transport，已经 `seal()` 过。 */
export function harness(): Harness {
  const store = openStore(':memory:')
  const transport = fakeTransport()
  const ctx = testContext(store)
  const registry = createRegistry(transport, ctx)
  registerAll(registry, ctx)
  registry.seal()
  return { store, registry, transport, ctx, call: transport.call }
}

/** 断言信封是失败的，且返回错误对象（收窄类型用）。 */
export function expectFail(result: IpcResult<unknown>): {
  code: string
  message: string
  detail?: unknown
} {
  if (result.ok) throw new Error(`期望失败信封，却拿到了成功：${JSON.stringify(result.data)}`)
  return result.error
}

/** 断言信封是成功的，并返回 data。 */
export function expectOk<T = unknown>(result: IpcResult<unknown>): T {
  if (!result.ok) {
    throw new Error(`期望成功信封，却拿到了 ${result.error.code}：${result.error.message}`)
  }
  return result.data as T
}

/** 建一个最小可用的空间，返回 id。 */
export async function makeWorkspace(h: Harness, name = 'Nova'): Promise<string> {
  const result = await h.call('workspace:create', { name })
  return expectOk<{ id: string }>(result).id
}

/** 建一个角色，返回 id。 */
export async function makeActor(h: Harness, name = 'Atlas'): Promise<string> {
  const result = await h.call('actor:create', {
    name,
    model: 'deepseek-flash',
    personaPath: 'personas/atlas.md',
    personaHash: 'h1'
  })
  return expectOk<{ id: string }>(result).id
}

/** 建一个成员，返回 `{ memberId, sessionId }`。 */
export async function makeMember(
  h: Harness,
  workspaceId: string,
  actorId: string,
  displayName = '架构师'
): Promise<{ memberId: string; sessionId: string }> {
  const result = await h.call('member:create', { workspaceId, actorId, displayName })
  const member = expectOk<{ id: string }>(result)
  const session = await h.call('session:getByMember', { memberId: member.id })
  const sess = expectOk<{ id: string } | null>(session)
  if (!sess) throw new Error('member:create 没有同时建出 session')
  return { memberId: member.id, sessionId: sess.id }
}

/** 建一个项目（直接走 repository，绕开 `addLocal` 的 fs 校验）。 */
export function makeProject(
  store: Store,
  workspaceId: string,
  id: string,
  name: string,
  rootPath: string
): string {
  store.repos.project.create({ id, workspaceId, name, rootPath, origin: 'local', now: NOW })
  return id
}
