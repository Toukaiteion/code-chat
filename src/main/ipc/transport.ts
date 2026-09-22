/**
 * IPC 传输抽象。
 *
 * ★ 为什么要有这一层（方案 §4.1 的纪律延申）：
 * `registry.ts` **不得 import electron**，否则它的全部逻辑就只能靠起一个真窗口来测。
 * 把「怎么收发」抽成这个接口后，registry / 错误映射 / zod 校验 / 未实现通道的处理
 * **全部能在裸 Node 下单测**（见 `test/ipc/`），与 `domain/` 不得 import electron 同源。
 *
 * 真正碰 electron 的只有 `electron-transport.ts` 一个文件。
 */
export interface IpcTransport {
  /**
   * 注册一个 invoke 处理器。`listener` 拿到**未经校验**的载荷 ——
   * 校验是 registry 的职责，不是 transport 的。
   */
  handle(channel: string, listener: (payload: unknown) => Promise<unknown>): void

  /**
   * 向渲染进程推送。
   *
   * M3 是广播到所有窗口；跨空间**抑制**（§4.3：非活跃空间的批次直接丢弃）
   * 在 M6 随 event-batcher 一起实现，届时收窄到具体 webContents。
   */
  send(channel: string, payload: unknown): void

  /** 关闭所有窗口或应用退出时释放。测试用的假 transport 可以是空实现。 */
  dispose?(): void
}
