import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 读一个文本文件，**有字节上限、不抛、顺带算 hash**。
 *
 * ## 为什么它必须不抛
 *
 * 它服务的是**上下文装配**（`domain/context-builder.ts`）：人设、职责描述、项目记忆
 * 全都是「我们希望读到」而不是「读不到就没法跑」的东西（人设文件是唯一的例外，
 * 而那个判决在编排层，不在这里 —— 见下面「失败语义」）。
 *
 * 一个抛异常的读文件函数会把「这个文件不在」变成一次中断，而调用方为了不中断
 * 就得写 `try/catch` —— 于是 `catch {}` 里迟早会出现一个空块，
 * 而那正是一个**安静的失效**的出生地。这里把「读不到」做成**返回值**，
 * 调用方就**必须**写一句「读不到时怎么办」，而不是可以写一个空的 catch 蒙过去。
 *
 * ## 与 `readHashedFile` 的关系（谁是谁的所有者）
 *
 * `ipc/handlers/file-hash.ts` 的 `readHashedFile()` 做的是**同一件事的一半**：
 * 它也读文件、也算 sha256，但它**抛 `AppError`**（因为它的调用方是 IPC 处理器，
 * 那个错误的去处是信封里的错误码），而且它**不返回正文**。
 *
 * 于是「读一个文件」这个动作有了两个实现 —— 正是 §4.5a 规则一禁的形状
 * （同一个决定有两个所有者，而它们的失败语义迟早会分叉）。
 * ⇒ M7a 把 `readHashedFile()` 改成**调本文件**，自己只负责把 `reason` 映射回错误码。
 * 底层读法、上限语义、hash 算法因此只有一处。
 *
 * ## 失败语义：`reason` 是给人看的，`code` 是给机器看的
 *
 * `ENOENT`（这个项目没有这个文件）与 `EACCES`（有但读不了）在**展示层**是两回事，
 * 所以两者都原样带上，由调用方决定要不要记档。`project-context.ts` 已经定了这条口径：
 * `ENOENT` 不记档（大部分项目本来就没有那些文件），其余记档。
 */

/** 读失败的原因。`code` 是 `ENOENT` / `EISDIR` / `EACCES`… 原样带上，不翻译成语义。 */
export interface TextReadFailure {
  ok: false
  /** 绝对路径（已经 `resolve` 过）。 */
  path: string
  /** Node 的 `err.code`；拿不到时为 `null`（而不是编一个字符串）。 */
  code: string | null
  /** 给人看的一句话。 */
  reason: string
}

export interface TextReadSuccess {
  ok: true
  path: string
  /** 实际读到的文本，**可能已被截断**（截断时 `truncated` 为 true）。 */
  text: string
  /** 截断**前**的原始字节数 —— UI 说「被截掉了多少」靠它。 */
  bytes: number
  /** 实际返回的文本的字节数（未截断时与 `bytes` 相等）。 */
  returnedBytes: number
  truncated: boolean
  /** `bytes` 那一段原始字节的 sha256（十六进制）。**截断也按全量算** —— 见下。 */
  hash: string
}

export type TextReadResult = TextReadSuccess | TextReadFailure

/**
 * `hash` 为什么按**全量**算而不是按截断后的文本算：
 *
 * 它的用途是当缓存键 / 变更检测（§4.6 拿 `personaHash` 做缓存键）。
 * 按截断后的算，会出现「文件换了但前 16KB 没变 → hash 不变 → 缓存不失效」——
 * 而那恰好是缓存最需要失效的那种情况（用户改了文件的后半段）。
 * 截断只是**注入**的上限，不该污染**身份**。
 */
export async function readTextFile(path: string, capBytes?: number): Promise<TextReadResult> {
  const abs = resolve(path)

  let buf: Buffer
  try {
    buf = await readFile(abs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? null
    return { ok: false, path: abs, code, reason: code ? `读取失败（${code}）` : '读取失败（未知原因）' }
  }

  const bytes = buf.byteLength
  // ★ `capBytes` 给 `undefined` 时**不截断**；给 `0` 时截成空串 —— 两者不同，别合并。
  const cap = capBytes
  const truncated = cap !== undefined && bytes > cap
  // 按**字节**切，不按字符切 —— 否则一个多字节字符会被切一半。
  // 边界上可能留一个 U+FFFD 替换字符，可接受（总比丢一段好）。
  const text = truncated ? buf.subarray(0, cap).toString('utf8') : buf.toString('utf8')

  return {
    ok: true,
    path: abs,
    text,
    bytes,
    returnedBytes: Buffer.byteLength(text, 'utf8'),
    truncated,
    hash: createHash('sha256').update(buf).digest('hex')
  }
}

/**
 * 一段**文本**的 sha256（十六进制）。
 *
 * M7b 的 `@` 去重要用它（§4.5b 第 2 条：去重基准是「尚未执行的尾部」，
 * 键 = `(目标成员, 内容哈希)`）。放在这里而不是 `domain/`：`domain/` 不许 import
 * `node:crypto`，而「哈希怎么算」这件事**已经在本文件里有一个所有者**了
 * （上面那个 `readTextFile`）—— 再写一份 `createHash` 就是同一个决定两个所有者（§4.5a 规则一）。
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
