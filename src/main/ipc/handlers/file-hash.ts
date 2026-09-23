import { readTextFile } from '../../infra/text-file.ts'
import { AppError } from '../errors.ts'

/**
 * 读一个文件并算内容 hash —— 人设文件（`actor.personaHash`）与职责描述文件
 * （`member.roleDescHash`）共用这一条路径。
 *
 * ★ **纪律：凡是主进程能自己算的值，就不要让调用方传。**
 *
 * M3 的契约里 `actor:create` 要求调用方传 `personaHash`、`member:setRoleDesc` 要求传
 * `roleDescHash` —— 而调用方是渲染进程，**它没有 fs，根本读不到文件**，
 * 只能编一个。同一时期 `member:create` 更微妙：它收 `roleDescPath` 却压根不算 hash，
 * 于是库里落成「路径有、hash 为 NULL」，而 §4.6 正是拿这个 hash 做缓存键的。
 * 这类洞不会报错，只会安静地错下去。M4 把它们统一到这一处。
 *
 * 放在 handlers 层而不是 `infra/`：它要抛 `AppError`（好让信封里带上「哪个文件读不了」），
 * 而 `AppError` 属于 ipc 层。`infra/` 保持不认识上层的错误语义。
 *
 * ## ★ M7a：读文件的那一半搬到了 `infra/text-file.ts`
 *
 * 原先本函数自己 `readFile`。M7a 的上下文装配也需要读文件（人设、职责描述），
 * 而它**不能抛** —— 于是「读一个文件」这个动作会变成两个实现、两套失败语义，
 * 正是 §4.5a 规则一禁的形状。现在底层只有 `readTextFile()` 一处，
 * 本函数退化成两个职责：**把 `reason` 映射回 `AppError`**、**只保留 hash**。
 *
 * 错误码与消息**逐字保持不变**（它们已经出现在用户看得见的信封里）。
 */

/**
 * @param what 人话里的主语，用于拼错误消息（如「人设文件」）
 * @returns 绝对路径 + 内容的 sha256（十六进制）
 * @throws AppError 文件不存在 / 不是文件 / 读不了
 */
export async function readHashedFile(
  what: string,
  path: string
): Promise<{ path: string; hash: string }> {
  const res = await readTextFile(path)
  if (!res.ok) {
    // EISDIR 单独说：用户多半是选错了，选了个目录。给一句能被照做的提示。
    if (res.code === 'EISDIR') {
      throw new AppError('E_INVALID_PAYLOAD', `${what}是一个目录，不是文件：${res.path}`, {
        path: res.path
      })
    }
    throw new AppError('E_NOT_FOUND', `${what}读不了（${res.code ?? '未知原因'}）：${res.path}`, {
      path: res.path,
      code: res.code
    })
  }

  return { path: res.path, hash: res.hash }
}
