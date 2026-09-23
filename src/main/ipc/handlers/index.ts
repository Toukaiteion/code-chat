/**
 * 全部 handler 的装配点，也是**通道分类的唯一地方**。
 *
 * 规矩：`INVOKE_CHANNELS` 里的每一条，要么在这里（或它调用的 register* 里）
 * 被 `handle`，要么被 `defer` 出一个里程碑号。`seal()` 会在启动时把漏网之鱼
 * 直接抛出来 —— 通道被漏掉这条错误**不可能**溜到用户手上。
 */
import type { HandlerContext, Registry } from '../registry.ts'
import { registerWorkspace } from './workspace.ts'
import { registerProject } from './project.ts'
import { registerActor } from './actor.ts'
import { registerMember } from './member.ts'
import { registerSession } from './session.ts'
import { registerMessage } from './message.ts'
import { registerTurn } from './turn.ts'
import { registerMisc } from './misc.ts'
import { registerSystem } from './system.ts'

export function registerAll(r: Registry, ctx: HandlerContext): void {
  registerWorkspace(r, ctx)
  registerProject(r, ctx)
  registerActor(r, ctx)
  registerMember(r, ctx)
  registerSession(r, ctx)
  registerMessage(r, ctx)
  registerTurn(r, ctx)
  registerMisc(r, ctx)
  registerSystem(r, ctx)

  // ───────────────────────────────────────────────────────────
  // 尚未实现 —— **不填桩，返回 E_NOT_IMPLEMENTED 并带上里程碑号**。
  //
  // ★ 为什么不做成「返回假数据」：`turn:stopAll` 若回一个伪造的「已停止 3 个」，
  // UI 会显示「已全部停止」而那几个 claude 进程还在改用户的文件。
  // 一个写明「M9 才有」的报错，比一个安静的谎言好得多。
  //
  // 这些通道的**入站载荷依然过 zod**（registry 的校验在实现检查之前），
  // 所以 UI 连「参数写错了」都能先发现。
  //
  // ★ M6a 从这里移出了两条：`turn:send`（调度器 + 合批器已就位）与
  //   `stream:resume`（帧缓冲的所有者是 `process/event-batcher.ts`）。
  //   移出时**必须同时**改 `test/ipc/registry.test.ts` 里那张「未实现清单」——
  //   那条用例正是为了让这份名单不会悄悄过时。
  // ───────────────────────────────────────────────────────────

  r.defer('turn:interject', 'M9', '插话队列：在当前轮结束后执行')
  r.defer('turn:stopAll', 'M9', '需要先有「停止运行中的轮次」')
}
