/**
 * 通道清单 —— **全应用唯一的通道名事实源**。
 *
 * 主进程的 registry、preload 的白名单、渲染侧的 client 全部从这里派生，
 * 所以三者不可能分叉。（preload 会把 INVOKE_CHANNELS / PUSH_CHANNELS
 * 冻结成 Set 做白名单，未知通道在 preload 就被挡掉，不触达 ipcRenderer。）
 *
 * 命名规则（方案 §4.3）：`domain:verb` 用于 invoke；`stream:*` / `app:*` 用于推送。
 *
 * ⚠️ 不用 TS `enum` —— 裸 Node 的类型剥离不支持它，`npm test` 会直接炸。
 *    `as const` 数组 + 派生联合类型是本仓库的既定手法（见 `entities.ts`）。
 */

/** 渲染 → 主，一问一答（`ipcRenderer.invoke`）。 */
export const INVOKE_CHANNELS = [
  // ── workspace ──────────────────────────────────────────────
  'workspace:list',
  'workspace:create',
  /** 改名。§4.3 里叫 `update`；它当前只承载 rename 一件事。 */
  'workspace:update',
  /** 硬删除。级联带走成员/项目/session/message —— 但 `origin='local'` 的目录**一个字节都不动**（§8.2）。 */
  'workspace:delete',
  /** 设置 cwd 的二级兜底（§8.5b）。传 null 清空。 */
  'workspace:setActive',

  // ── project ────────────────────────────────────────────────
  'project:list',
  /** 三种导入方式之一：原地引用。**只登记，不复制**（§8.2）。 */
  'project:addLocal',
  /** 三种导入方式之二：复制到指定位置。M4。 */
  'project:copy',
  /** 三种导入方式之三：git clone 到指定目录。M4。 */
  'project:clone',
  'project:rename',
  'project:remove',

  // ── actor（全局的「人」）─────────────────────────────────────
  'actor:list',
  'actor:get',
  'actor:create',
  'actor:update',
  'actor:remove',

  // ── member（actor × workspace）──────────────────────────────
  'member:list',
  'member:create',
  'member:remove',
  'member:setEnabled',
  'member:setRoleDesc',
  /** 每空间至多一个路由角色，由偏索引 `idx_member_router` 兜底（§3.2）。 */
  'member:setRouter',
  'member:setPermissions',
  /** 读可见性：`{ ids, isRestricted, primaryProjectId }`。**无行 = 全可见**（§8.4）。 */
  'member:visibility',
  /** 写可见性：整体替换 + 主项目。主项目必须在可见集里。 */
  'member:setVisibility',
  'member:setPrimary',
  'member:clearVisibility',

  // ── session ────────────────────────────────────────────────
  'session:list',
  /** 与成员 1:1，所以按成员查比按 id 查更常用。 */
  'session:getByMember',
  'session:remove',

  // ── message ────────────────────────────────────────────────
  /** keyset 分页历史，**无 OFFSET**。 */
  'message:list',
  /** 单条消息的完整未截断事件（含 thinking）。展开大输出时按需拉。 */
  'message:getEvents',

  // ── turn ───────────────────────────────────────────────────
  /** 发起一轮对话。**需要调度器（M5/M6）**。 */
  'turn:send',
  'turn:stop',
  'turn:stopAll',
  /** 中途插话，排队到当前轮结束后执行。M9。 */
  'turn:interject',
  'turn:list',
  'turn:get',
  'turn:listLive',

  // ── view / stream / runtime ────────────────────────────────
  /** 告诉主进程当前可见的空间/会话 —— 驱动跨空间**抑制**（§4.3）。 */
  'view:setActive',
  /** 切换空间后的重放原语。M6。 */
  'stream:resume',
  /** 运行中的轮、队列深度、并发槽位。 */
  'runtime:getState'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

/**
 * 主 → 渲染，推送。**刻意只有四个**（方案 §4.3）——
 * 高频的 token delta 全部合批进 `stream:batch`，其余三个都是低频的。
 */
export const PUSH_CHANNELS = [
  /** 高频那个，已在主进程侧合批到 ~30Hz（§4.3 合批规则）。 */
  'stream:batch',
  /** 低频：排队 / 开始 / 结束 / 失败。 */
  'stream:status',
  /** 未读点，合批到 ≤1Hz。 */
  'workspace:unread',
  /** 错误、崩溃、迁移提示。 */
  'app:notice'
] as const

export type PushChannel = (typeof PUSH_CHANNELS)[number]

export const ALL_CHANNELS: readonly (InvokeChannel | PushChannel)[] = [
  ...INVOKE_CHANNELS,
  ...PUSH_CHANNELS
]

const INVOKE_SET: ReadonlySet<string> = new Set<string>(INVOKE_CHANNELS)
const PUSH_SET: ReadonlySet<string> = new Set<string>(PUSH_CHANNELS)

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && INVOKE_SET.has(value)
}

export function isPushChannel(value: unknown): value is PushChannel {
  return typeof value === 'string' && PUSH_SET.has(value)
}
