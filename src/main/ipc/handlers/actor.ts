import type { HandlerContext, Registry } from '../registry.ts'
import { AppError, NotFoundError } from '../errors.ts'
import { readHashedFile } from './file-hash.ts'

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

  /**
   * ★ M4 起 `personaHash` 由**主进程**读文件算出（`readHashedFile`）。
   *
   * M3 的契约要求调用方传这个 hash —— 而调用方是渲染进程，**它没有 fs**，
   * 根本读不到那个文件，只能编一个。现在调用方只给人设文件的路径。
   */
  r.handle('actor:create', async ({ name, model, personaPath, avatar, agentKind, effort }) => {
    // `actor.name` 有 UNIQUE 约束。先查再插只为给一句人话：
    // 直接吃 2067 得到的是「UNIQUE constraint failed: actor.name」。
    const dup = repos.actor.getByName(name)
    if (dup) {
      throw new AppError('E_CONFLICT', `已经有一个叫「${name}」的角色了`, { actorId: dup.id })
    }
    const persona = await readHashedFile('人设文件', personaPath)
    return repos.actor.create({
      id: ctx.newId(),
      name,
      model,
      personaPath: persona.path,
      personaHash: persona.hash,
      avatar,
      agentKind,
      effort,
      now: ctx.now()
    })
  })

  /**
   * 更新「人」的本身属性。**刻意不含** `personaPath` / `personaHash` ——
   * 换人设走 `actor:setPersona`。混在一起会让「只改个模型」的操作顺带把 hash 抹成空。
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
   * 换人设文件（§4.6）。**路径与 hash 必须一起动** —— 内容变了却不更新 hash，
   * 会让「可缓存前缀」的检测失效：缓存键会认为前缀没变，而它变了。
   * `actor-repo.setPersona` 的注释同此。两条都由主进程一次算好，调用方无从搞错。
   */
  r.handle('actor:setPersona', async ({ id, personaPath }) => {
    if (!repos.actor.get(id)) throw new NotFoundError('角色', id)
    const persona = await readHashedFile('人设文件', personaPath)
    const updated = repos.actor.setPersona(id, persona.path, persona.hash, ctx.now())
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
