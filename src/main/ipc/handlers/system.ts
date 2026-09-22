import type { HandlerContext, Registry } from '../registry.ts'
import { AppError } from '../errors.ts'

/**
 * 宿主能力通道 —— 原生对话框与文件管理器。
 *
 * 这两个通道**只做转发**：真正的实现挂在 `ctx.sys` 上
 * （生产环境是 `system-capabilities.ts`，测试里是一组固定实现）。
 * 转这一道不是为了薄薄地包一层，而是因为 `registry.ts` 有一条必须守住的不变量
 * ——**它不 import electron**。原生对话框与 `shell` 会打破它，于是它们被关在
 * `system-capabilities.ts` 一个文件里，以注入的方式到这里。
 *
 * ⚠️ **它们不是路径的唯一入口**。UI 里每一个路径输入框都是**可编辑的文本框**，
 * 「选择…」按钮只是便利（§8.2 的「用户有自己的排布习惯」）。
 * 这既照顾了习惯，也让验收不必去点原生对话框 —— 见 `AddProjectDialog`。
 */
export function registerSystem(r: Registry, ctx: HandlerContext): void {
  /**
   * 弹原生选择器。
   *
   * ★ **用户取消返回 `{ path: null }`，不是失败信封。** 取消是用户明确表达的意思，
   * 把它做成 `E_*` 会让调用方写出「捕获异常 = 用户取消」这种代码 ——
   * 于是真实的错误（比如对话框起不来）会被当成取消悄悄吞掉。
   */
  r.handle('dialog:pickPath', async ({ mode, title, defaultPath }) => {
    const path = await ctx.sys.pickPath({ mode, title, defaultPath })
    return { path }
  })

  /**
   * 在系统文件管理器里打开一个目录。打不开返回 `{ opened: false }`，
   * **不抛** —— 「这个目录已经不在磁盘上了」是一种要显示给用户的处境，
   * 不是一次异常。UI 该做的是把路径显示出来让用户自己去看。
   */
  r.handle('shell:revealPath', async ({ path }) => {
    if (path.trim() === '') {
      // schema 已经要求 min(1)，这里只是不让一个纯空白的路径走到 shell 那边去。
      throw new AppError('E_INVALID_PAYLOAD', '路径不能是空白')
    }
    return { opened: await ctx.sys.revealPath(path) }
  })
}
