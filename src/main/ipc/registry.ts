/**
 * IPC 注册表 —— 校验、分发、信封化。**不 import electron**（见 `transport.ts` 的说明），
 * 所以 `test/ipc/registry.test.ts` 能在裸 Node 下把它整条路径跑完。
 *
 * 三条不变量：
 *
 * 1. **每一个 invoke 通道最终都返回 `IpcResult`**，绝不向边界抛异常。
 *    （handler 内部可以随意 `throw`，见 `errors.ts`。）
 * 2. **每一份入站载荷都过 zod**，无论通道实现没实现 —— 规则统一，没有例外。
 * 3. **每个通道都必须被明确分类**：要么 `handle`，要么 `defer`。
 *    漏掉的会在 `seal()` 时报错，而不是在用户点下去时才发现。
 */
import { INVOKE_CHANNELS, PUSH_CHANNELS } from '../../shared/ipc/channels.ts'
import type { InvokeChannel, PushChannel } from '../../shared/ipc/channels.ts'
import type { PushOf, ReqOf, ResOf } from '../../shared/ipc/contract.ts'
import { fail, ok, type IpcResult } from '../../shared/ipc/envelope.ts'
import { INVOKE_SCHEMAS, PUSH_SCHEMAS } from '../../shared/ipc/schemas.ts'
import type { Store } from '../persist/index.ts'
import { toEnvelope } from './errors.ts'
import type { IpcTransport } from './transport.ts'

/** 渲染层当前可见的空间 / 会话。`view:setActive` 写它，M6 的抑制逻辑读它（§4.3）。 */
export interface ActiveView {
  workspaceId: string | null
  sessionId: string | null
}

/**
 * 宿主能力 —— handler 需要它，但**它只能由主进程提供**。
 *
 * 原生对话框与文件管理器会打破本文件最重要的那条不变量：
 * **registry 不 import electron**。靠它，`test/ipc/` 才能把整条 IPC 路径
 * （校验 → 分发 → 信封）在裸 Node 下跑完，不用起 Electron、不用点对话框。
 *
 * 所以这一袋子跟 `now` / `newId` 走同一套注入手法：生产环境接真实现
 * （`system-capabilities.ts`），测试里接固定实现。
 *
 * 顺带的好处：测试能直接把 `locateGit()` 变成「返回 null」，
 * 于是「本机没装 git」这条分支也能被验到 —— 否则它永远只能靠人肉忘装一次来发现。
 */
export interface SysCapabilities {
  /** 弹原生选择器；用户取消返回 `null`。 */
  pickPath(opts: {
    mode: 'file' | 'directory'
    title?: string
    defaultPath?: string
  }): Promise<string | null>
  /** 在系统文件管理器里定位一个路径。打不开（路径不存在等）返回 `false`。 */
  revealPath(path: string): Promise<boolean>
  /** §8.3 的空间根目录，`userData/workspaces`。 */
  workspacesRoot(): string
  /** 找 `git` 可执行文件；找不到返回 `null`（由 handler 说人话）。 */
  locateGit(): Promise<string | null>
}

/**
 * handler 能拿到的东西。
 *
 * `now` 与 `newId` 走**注入**而不是直接调 `Date.now()` / `randomUUID()`，
 * 是为了让测试完全确定 —— 否则断言里全是「刚生成的那个 id」，
 * 除了「非空」什么都验不了。
 */
export interface HandlerContext {
  store: Store
  now(): number
  newId(): string
  view: ActiveView
  sys: SysCapabilities
}

export type Handler<K extends InvokeChannel> = (
  payload: ReqOf<K>,
  ctx: HandlerContext
) => ResOf<K> | Promise<ResOf<K>>

export interface Registry {
  handle<K extends InvokeChannel>(channel: K, fn: Handler<K>): void
  /**
   * 明确声明「这个通道还没实现，等 MX」。
   * 被 defer 的通道调用时返回 `E_NOT_IMPLEMENTED`，并在 `detail.milestone` 里
   * 带上里程碑号 —— 比 Electron 那句含糊的 `No handler registered` 有用得多。
   */
  defer(channel: InvokeChannel, milestone: string, note?: string): void
  /** 推送给渲染进程。**出站也校验** —— 形状漂移在发送端就暴露，而不是在 UI 上。 */
  emit<K extends PushChannel>(channel: K, payload: PushOf<K>): void
  /** 把全部通道接到 transport 上，并断言没有通道被漏掉分类。 */
  seal(): void
  /** 测试与自检用：当前已注册的通道。 */
  registered(): InvokeChannel[]
}

interface Deferred {
  milestone: string
  note?: string
}

export function createRegistry(transport: IpcTransport, ctx: HandlerContext): Registry {
  const handlers = new Map<InvokeChannel, Handler<InvokeChannel>>()
  const deferred = new Map<InvokeChannel, Deferred>()

  async function dispatch(channel: InvokeChannel, rawPayload: unknown): Promise<IpcResult<unknown>> {
    // ── 1. 校验（永远第一步，且不分通道是否实现 —— 规则统一）──
    const schema = INVOKE_SCHEMAS[channel]
    const parsed = schema.req.safeParse(rawPayload)
    if (!parsed.success) {
      return fail('E_INVALID_PAYLOAD', `通道 ${channel} 的载荷不合法`, {
        // issues 是纯数据，可结构化克隆。只取前几条，避免一条畸形载荷撑爆信封。
        issues: parsed.error.issues.slice(0, 8).map((i) => ({
          path: i.path.map(String),
          code: i.code,
          message: i.message
        }))
      })
    }

    // ── 2. 实现了没有 ──
    const fn = handlers.get(channel)
    if (!fn) {
      const d = deferred.get(channel)
      return fail(
        'E_NOT_IMPLEMENTED',
        d ? `通道 ${channel} 尚未实现（计划在 ${d.milestone}）` : `通道 ${channel} 尚未实现`,
        d ? { milestone: d.milestone, note: d.note } : undefined
      )
    }

    // ── 3. 跑 handler。注意传的是**解析后**的值（可能已被 schema 规范化）──
    try {
      return ok(await fn(parsed.data as never, ctx))
    } catch (err) {
      return toEnvelope(err)
    }
  }

  return {
    handle(channel, fn) {
      handlers.set(channel as InvokeChannel, fn as Handler<InvokeChannel>)
    },

    defer(channel, milestone, note) {
      deferred.set(channel, { milestone, note })
    },

    emit(channel, payload) {
      const parsed = PUSH_SCHEMAS[channel].safeParse(payload)
      if (!parsed.success) {
        // 出站校验失败是**我们自己的** bug，不是渲染层的。大声说出来。
        console.error(
          `[ipc] 推送 ${channel} 的载荷不符合契约，已丢弃：`,
          parsed.error.issues.slice(0, 8)
        )
        return
      }
      transport.send(channel, parsed.data)
    },

    seal() {
      const unclassified = INVOKE_CHANNELS.filter(
        (ch) => !handlers.has(ch) && !deferred.has(ch)
      )
      if (unclassified.length > 0) {
        // 这是**开发期**的完整性检查：每个通道都必须被有意识地分类，
        // 否则会出现「UI 能点、后端没接、报错还没说是谁的错」的灰区。
        throw new Error(
          `以下通道既未实现也未标记为 defer：${unclassified.join(', ')}。` +
            `请在 handlers/index.ts 里显式二选一。`
        )
      }
      for (const channel of INVOKE_CHANNELS) {
        transport.handle(channel, (payload) => dispatch(channel, payload))
      }
      for (const channel of PUSH_CHANNELS) {
        // 推送通道不需要 handler，这里只是让 seal 的覆盖面显式化。
        void channel
      }
    },

    registered() {
      return [...handlers.keys()]
    }
  }
}
