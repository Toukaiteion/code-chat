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
  // ★ 为什么不做成「返回假数据」：`turn:send` 若回一个伪造的 turnId，
  // UI 会照常渲染出一条**永远不会运行的轮次**，用户看到的是「已发送、正在思考」，
  // 而实际上什么都没有发生。一个写明「M5/M6 才有」的报错，比一个安静的谎言好得多。
  //
  // 这些通道的**入站载荷依然过 zod**（registry 的校验在实现检查之前），
  // 所以 UI 连「参数写错了」都能在 M5 之前先发现。
  // ───────────────────────────────────────────────────────────

  // 需要调度器（§4.5：Semaphore + 每 session FIFO 队列 + 持久化排队）。
  r.defer('turn:send', 'M5/M6', '需要 ClaudeAdapter 与调度器；伪造 turnId 会让 UI 渲染一条永不运行的轮次')
  r.defer('turn:interject', 'M9', '插话队列：在当前轮结束后执行')
  r.defer('turn:stopAll', 'M9', '需要先有「停止运行中的轮次」')

  // 事件重放的读取端：表已就位，但帧的来源（event-batcher 的环形缓冲）M6 才有。
  r.defer('stream:resume', 'M6', '需要的帧缓冲由 event-batcher 维护')
}
