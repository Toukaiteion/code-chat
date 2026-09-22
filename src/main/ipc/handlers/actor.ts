import type { HandlerContext, Registry } from '../registry.ts'
import { AppError, NotFoundError } from '../errors.ts'

/**
 * `Actor` 是**全局的「人」**（§2.4）：跨空间复用，不因空间而复制。
 * 空间间的差异（显示名、职责、可见性）由 `WorkspaceMember` 承载，
 * 所以这里没有任何 `workspaceId` 参数 —— 那是 `member:*` 的事。
 */
export function registerActor(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  r.handle('actor:list', () => repos.actor.list())

  /** 返回 `null` 而不是抛 —— 「查一个不存在的 id」是查询的正常结果，不是异常。 */
  r.handle('actor:get', ({ id }) => repos.actor.get(id))

  r.handle('actor:create', ({ name, model, personaPath, personaHash, avatar, agentKind, effort }) => {
    // `actor.name` 有 UNIQUE 约束。先查再插只为给一句人话：
    // 直接吃 2067 得到的是「UNIQUE constraint failed: actor.name」。
    const dup = repos.actor.getByName(name)
    if (dup) {
      throw new AppError('E_CONFLICT', `已经有一个叫「${name}」的角色了`, { actorId: dup.id })
    }
    return repos.actor.create({
      id: ctx.newId(),
      name,
      model,
      personaPath,
      personaHash,
      avatar,
      agentKind,
      effort,
      now: ctx.now()
    })
  })

  /**
   * 更新「人」的本身属性。**不含** `personaPath` / `personaHash`。
   *
   * 人设文件的重新选择**没有通道**（`actor-repo.setPersona` 已就位，但没有 `actor:setPersona`）——
   * 它涉及读文件、算 hash、以及「改了人设要不要重算缓存前缀」（§4.6），
   * 属于 M4 的界面工作。在那之前，本通道刻意不碰这两列：
   * 混在一起会让「只改个模型」的操作顺带把 hash 抹成空。
   */
  r.handle('actor:update', ({ id, name, model, effort, agentKind, avatar }) => {
    const current = repos.actor.get(id)
    if (!current) throw new NotFoundError('角色', id)

    if (name !== current.name) {
      const dup = repos.actor.getByName(name)
      if (dup) {
        throw new AppError('E_CONFLICT', `已经有一个叫「${name}」的角色了`, { actorId: dup.id })
      }
    }

    const updated = repos.actor.update(id, {
      name,
      model,
      effort,
      agentKind,
      avatar,
      now: ctx.now()
    })
    if (!updated) throw new NotFoundError('角色', id)
    return updated
  })

  /**
   * ⚠️ 级联会带走该 actor 在**所有**空间的成员身份与 session，以及那些 session 的消息与轮次。
   * 这是刻意的（`actor-repo` 的注释同）：`Actor` 是全局对象，
   * 「在某一个空间里退出」应该用 `member:remove`，而不是删掉「人」本身。
   */
  r.handle('actor:remove', ({ id }) => ({ deleted: repos.actor.remove(id) }))
}
