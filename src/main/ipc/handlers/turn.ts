import type { HandlerContext, Registry } from '../registry.ts'
import { AppError, NotFoundError } from '../errors.ts'
import { DEFAULT_MESSAGE_LIMIT } from '../../../shared/ipc/schemas.ts'
import { mentionProblemOf, USER_INITIATED_HOP_DEPTH } from '../../domain/mention-service.ts'

export function registerTurn(r: Registry, ctx: HandlerContext): void {
  const repos = ctx.store.repos

  /**
   * ★ **发一条消息 = 一个事务里的两笔写 + 一次派发。**
   *
   * ```
   * store.tx(() => {                       ← 一个事务
   *   追加用户消息（空间 seq 在这里分配）
   *   插入 queued 轮次（trigger_message_id 指向那条消息）
   * })
   * runtime.dispatch(turn)                 ← 事务**提交之后**才派发
   * ```
   *
   * 三件事都不能省：
   *
   * - **一个事务**：消息与轮次要么都在、要么都不在。分开写的话，中间崩掉会留下
   *   「用户看到了自己发的消息，而它永远不会被回答」—— 一条没有任何解释的死消息。
   * - **返回真实的 turnId**（§4.3b）：回一个伪造的 id，UI 会照常渲染出一条
   *   **永远不会运行的轮次**，用户看到的是「已发送、正在思考」，而实际上什么都没发生。
   * - **提交之后才派发**：调度器会立刻去库里读那一行。事务还没提交就派发，
   *   它会读到「不存在」，而这一轮就再也没人管了。
   *
   * `trigger_message_id` 指向消息、消息的 `turn_id` 留空 —— 这是一个**单向**的环：
   * 消息先插（那时还没有轮次 id），而轮次反过来指向它是原子的，所以不需要回填。
   */
  r.handle('turn:send', ({ workspaceId, memberId, text, mentions }) => {
    const member = repos.member.get(memberId)
    if (!member) throw new NotFoundError('成员', memberId)
    if (member.workspaceId !== workspaceId) {
      throw new AppError('E_INVALID_PAYLOAD', '这个成员不属于该空间', {
        memberId,
        workspaceId,
        actualWorkspaceId: member.workspaceId
      })
    }
    if (!member.enabled) {
      throw new AppError('E_CONFLICT', `成员「${member.displayName}」已停用，发不出去`, { memberId })
    }
    // 会话与成员**同生**（`member:create` 里那个事务），所以这一条查不到就是库不一致。
    const session = repos.session.getByMember(memberId)
    if (!session) throw new NotFoundError('会话', memberId)

    /**
     * ★ **用户 `@` 的校验**（§5.1 的跳 4）：存在 / 属于本空间 / `enabled` / 不是发送者自己。
     *
     * 判据的实现**只有一份**（`mentionProblemOf`，agent 回复那条路也走它），
     * 但**失败语义刻意不同**：这里是 `E_INVALID_PAYLOAD`，整条消息发不出去；
     * 而 agent 回复里 @ 到一个停用的成员只会丢掉那一条 + 记一条 note。
     *
     * 为什么这里必须**硬失败**而不是静默丢掉：用户明确点了那个人，界面上也把
     * 那个 chip 画出来了 —— 悄悄不派，就是「界面上有、实际什么都不会发生」，
     * 正是 §4.3a 拒绝的那类谎。让他当场改，比让他等一个永远不来的回答好。
     */
    const wanted = mentions ?? []
    if (wanted.length > 0) {
      const members = repos.member.listByWorkspace(workspaceId)
      for (const m of wanted) {
        const problem = mentionProblemOf({ memberId: m.memberId, selfMemberId: memberId, members })
        // 「不在本空间」也算不存在 —— 对用户来说两者是同一件事（他点的那个人没了）。
        if (problem) {
          throw new AppError('E_INVALID_PAYLOAD', `@ 的目标无效：${problem.message}`, {
            memberId: m.memberId,
            problem: problem.tag
          })
        }
      }
    }

    const cwd = ctx.runtime.cwdFor(workspaceId, memberId).cwd
    const messageId = ctx.newId()
    const turnId = ctx.newId()
    const now = ctx.now()

    const turn = ctx.store.tx(() => {
      repos.message.append({
        id: messageId,
        workspaceId,
        sessionId: session.id,
        role: 'user',
        authorMemberId: memberId,
        contentText: text,
        mentions: wanted,
        now
      })
      return repos.turn.create({
        id: turnId,
        sessionId: session.id,
        workspaceId,
        triggerMessageId: messageId,
        cwd,
        /**
         * ★ **用户直接发起 = 0**（§3.3），这个 0 不是「默认值」而是一个语义：
         * `hop_depth === 0` 当且仅当这一轮完全由用户发起 ⇒ 它是链的**打断点**
         * （§5.2：用户插一句话就开了一条新链，上一段空转不会被算进这一段）。
         * 而由 `@` 派发出去的那一轮 = 派发方 + 1（`hopDepthOf`，在 `fanout` 里）。
         */
        hopDepth: USER_INITIATED_HOP_DEPTH,
        now
      })
    })

    ctx.runtime.dispatch(turn)
    // ★ 用户消息里 `@` 的那些人：**事务提交之后**才派（扇出会立刻回库里读会话与成员）。
    //   它最终也走 `runtime.dispatch`，不是第二个派发入口。
    if (wanted.length > 0) {
      ctx.runtime.fanoutUserMentions({
        workspaceId,
        authorMemberId: memberId,
        text,
        mentions: wanted
      })
    }
    return { turnId: turn.id }
  })

  /**
   * ⚠️ `listRecentByWorkspace` 按 `started_at DESC` 排序，而**排队中的轮次
   * `started_at` 是 NULL** —— SQLite 的 DESC 把 NULL 排在最后，
   * 所以「刚点了发送、还在排队」的那条会出现在列表**末尾**。
   * 侧边栏要显示排队项时不要用它，用 `turn:listLive`。
   */
  r.handle('turn:list', ({ workspaceId, sessionId, limit }) => {
    if (sessionId != null) {
      // `listBySession` 没有 LIMIT —— 一个会话的轮次数天然有界（按会话切分，
      // 且 `session:remove` 可清空），不值得为它再加一个索引变体。
      return repos.turn.listBySession(sessionId).slice(0, limit ?? DEFAULT_MESSAGE_LIMIT)
    }
    return repos.turn.listRecentByWorkspace(workspaceId, limit ?? DEFAULT_MESSAGE_LIMIT)
  })

  r.handle('turn:get', ({ id }) => repos.turn.get(id))

  /** 全局的排队中 + 运行中，按 `queued_at` 升序（= FIFO 顺序）。 */
  r.handle('turn:listLive', () => repos.turn.listLive())

  /**
   * 停止一轮。
   *
   * ★ 这里是 M3 里**唯一一个「部分实现」的通道**，两半都必须是真话：
   *
   * - `queued` → **真的停掉**（`markCancelled`，M2 已有）。它还没启动，
   *   没有任何进程需要杀，翻一下状态就是完整的操作。
   * - `running` → `E_NOT_IMPLEMENTED`（M9）。**不能假装停掉了**：
   *   杀进程要走 §4.4 的阶梯（SIGINT → 等 → 硬杀），M9 才做。
   *   现在谎报成功，UI 会显示已停止、而那个 claude 进程还在改用户的文件。
   * - 终态 → `E_CONFLICT`。已经是 `done` 的轮次不需要停，
   *   而且 `markCancelled` 是**不带状态守卫的 UPDATE**，
   *   直接调它会把一个已完成的轮次改写成 `cancelled`，抹掉真实结局。
   */
  r.handle('turn:stop', ({ turnId }) => {
    const turn = repos.turn.get(turnId)
    if (!turn) throw new NotFoundError('轮次', turnId)

    if (turn.status === 'queued') {
      const cancelled = repos.turn.markCancelled(turnId, ctx.now())
      if (!cancelled) throw new NotFoundError('轮次', turnId)
      // ★ 库改完了还要告诉调度器一声。**这不是防重复派发的那道锁** ——
      // 调度器每次取队首都会回库里读一次状态，`cancelled` 的行它自己会跳过
      // （`scheduler.ts` 的 `pickNext`）。这一行的作用是让**内存队列与库立刻一致**：
      // 少了它，一个已取消的 id 会一直挂在内部队列里，直到下一次取队首时才被顺手丢掉，
      // 而 `runtime:getState` 的 `dispatchable` 在那之前会多报一个数。
      ctx.runtime.cancelQueued(turnId)

      /**
       * ★ 这是**第四个**终态写入点，而且它是唯一一个在 handler 里的 ——
       * 另外三个都在 `runtime.ts` 装配的那几件东西内部（调度器两处、合批器一处，
       * 外加执行器崩溃那条）。所以这里必须自己发一次：漏掉的后果是那一行
       * 在界面上永远停在「排队中」，而它在库里早就是 `cancelled` 了。
       *
       * 排在 `markCancelled` 与 `cancelQueued` **之后**：前者的返回值已经证明库里
       * 那一行翻了（`!cancelled` 那条已经抛出去了），后者让内存队列与库一致。
       * 发的是这两件事**都成立之后**的事实。
       */
      ctx.runtime.emitStatus({
        workspaceId: cancelled.workspaceId,
        sessionId: cancelled.sessionId,
        turnId: cancelled.id,
        status: 'cancelled',
        /**
         * ⚠️ 这里**就是 `null`**，而且必须是 —— `markCancelled` 那条 UPDATE 只写
         * `status` 与 `ended_at`，**不动 `terminal_reason`**。
         *
         * 顺手填一个 `'user_interrupt'` 看起来更友好，但那是在**编**：库里的
         * `terminal_reason` 仍是 NULL，于是同一件事有了两个来源且互相矛盾
         * （`stream:status` 说 `user_interrupt`、`turn:get` 说 `null`）。
         * 何况「是谁取消的」这个问题，`status === 'cancelled'` 已经答完了。
         */
        reason: cancelled.terminalReason
      })

      return cancelled
    }

    if (turn.status === 'running') {
      throw new AppError(
        'E_NOT_IMPLEMENTED',
        // ⚠️ 这句话在 M5 之后已经不准了：**Windows 上没有 SIGINT/SIGTERM 可用**
        // （libuv 的 `child.kill()` 走 TerminateProcess，直接硬杀直接子进程，
        //  而 `taskkill /T` 靠活着的父子链走路 —— 先杀根会让孙进程永远收不回来）。
        // M5 定的阶梯是「stdin 中断 → 根还活着时 `taskkill /T` → `/T /F`」，
        // 完整理由与实测见 docs/design.md §4.4b。M9 落地时照那一节做，不要照这句话做。
        `通道 turn:stop 对运行中的轮次尚未实现（计划在 M9）：走 docs/design.md §4.4b 的中断阶梯`,
        { turnId, pid: turn.pid, milestone: 'M9' }
      )
    }

    throw new AppError('E_CONFLICT', `该轮次已经结束了（${turn.status}），无需停止`, {
      turnId,
      status: turn.status
    })
  })
}
