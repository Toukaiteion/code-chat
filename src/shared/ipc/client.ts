/**
 * 渲染侧的类型安全门面。
 *
 * preload 只暴露两个**泛型**函数（`invoke` / `on`），因为桥越小越容易审；
 * 类型安全在这一层补回来：每个方法都从 `contract.ts` 推导签名，调用点写起来
 * 就是普通 async 函数，失败时抛 `IpcError`（而不是让调用方层层判 `ok`）。
 *
 * 用法（渲染进程里做一次）：
 * ```ts
 * import { createClient, onPush } from '@shared/ipc/client'
 * export const api = createClient(window.api)
 * const off = onPush(window.api, 'stream:batch', (batch) => …)
 * ```
 */
import type { InvokeChannel, PushChannel } from './channels.ts'
import type { InvokeContract, PushContract } from './contract.ts'
import { unwrap, type IpcResult } from './envelope.ts'

/** preload 挂到 `window.api` 上的原始桥。 */
export interface RawBridge {
  invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>>
  on(channel: string, listener: (payload: unknown) => void): () => void
}

/**
 * 无载荷通道的方法可以**不传参**调用，有载荷的必须传。
 * 靠 `undefined extends Req` 区分，而不是把参数一律标成可选 ——
 * 后者会让 `api.workspace.create()` 这种漏参调用也通过类型检查。
 */
type Args<Req> = undefined extends Req ? [] | [Req] : [Req]

/** `'workspace:list'` → `['workspace', 'list']`。 */
type Split<K extends string> = K extends `${infer D}:${infer V}` ? [D, V] : never

/** 把「域 → 动词」的联合合并成一个嵌套对象：同名域会合并，而不是互相覆盖。 */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I
) => void
  ? I
  : never

/**
 * 由扁平的通道契约推导出的嵌套 API：`api.workspace.list()`。
 * 完全从 `InvokeContract` 推导，所以加了新通道这里自动就有。
 */
export type Api = UnionToIntersection<{
  [K in InvokeChannel]: Split<K> extends [infer D extends string, infer V extends string]
    ? {
        [P in D]: {
          [Q in V]: (...args: Args<InvokeContract[K]['req']>) => Promise<InvokeContract[K]['res']>
        }
      }
    : never
}[InvokeChannel]>

/**
 * 建门面。运行时就是个两级 Proxy：`api.a.b(x)` → `invoke('a:b', x)`。
 *
 * 每层的代理对象**缓存**，所以 `api.workspace === api.workspace` 成立 ——
 * 否则每次属性访问都造一个新对象，放进 React 依赖数组会永远不相等，
 * 引发无限重渲染（这类 bug 极难查）。
 */
export function createClient(bridge: RawBridge): Api {
  const domains = new Map<string, unknown>()

  return new Proxy(Object.create(null) as Api, {
    get(_target, domain: string | symbol) {
      if (typeof domain !== 'string') return undefined
      const cachedDomain = domains.get(domain)
      if (cachedDomain !== undefined) return cachedDomain

      const verbs = new Map<string, unknown>()
      const domainProxy = new Proxy(Object.create(null), {
        get(_t, verb: string | symbol) {
          if (typeof verb !== 'string') return undefined
          const cachedVerb = verbs.get(verb)
          if (cachedVerb !== undefined) return cachedVerb
          const call = (...args: unknown[]): Promise<unknown> =>
            bridge.invoke(`${domain}:${verb}`, args[0]).then(unwrap)
          verbs.set(verb, call)
          return call
        }
      })

      domains.set(domain, domainProxy)
      return domainProxy
    }
  })
}

/**
 * 订阅推送通道。
 *
 * ⚠️ 返回的退订函数**必须**在组件卸载时调用，否则监听器会在 webContents 上堆积 ——
 * 而 `stream:batch` 是 30Hz 的通道，堆积的后果是决定性的卡顿。
 */
export function onPush<K extends PushChannel>(
  bridge: RawBridge,
  channel: K,
  listener: (payload: PushContract[K]) => void
): () => void {
  return bridge.on(channel, listener as (payload: unknown) => void)
}
