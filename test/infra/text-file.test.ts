/**
 * M7a 验证之一：`src/main/infra/text-file.ts` 的读取语义。
 *
 * 它存在的理由是 §4.5a 规则一：**「读一个文件」这件事只能有一个所有者。**
 * `readHashedFile`（IPC 那条路）与上下文装配都要读文件；两份实现迟早分叉，
 * 而分叉的第一个症状会是「同一个文件在两处得到不同的 hash」—— 不报错，只是错。
 *
 * 这里钉的是四条**只有这个底层能保证**的性质，每一条都有具体的失败形态：
 *
 * 1. **不抛。** 「读不到」是返回值，不是异常。一个抛异常的读文件函数会逼每个调用方
 *    写 `try/catch`，而 `catch {}` 迟早会出现 —— 那正是安静失效的出生地。
 * 2. **hash 按全量算，不按截断后的算。** 它是缓存键 / 变更检测（§4.6 拿 `personaHash`
 *    当缓存键）。按截断算会得到「文件换了、但前 16KB 没变 → hash 不变 → 缓存不失效」，
 *    而那恰好是缓存最需要失效的那一次改动（用户改了文件的后半段）。
 * 3. **按字节截断，不按字符。** 按字符切会切坏多字节字符 —— 在中文项目里这是常态。
 * 4. **`0` 与 `undefined` 是两回事**：`0` 截成空串，`undefined` 不截断。
 *    这两个值一旦被合并，「不限上限」就悄悄变成了「什么都不读」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTextFile, sha256Hex } from '../../src/main/infra/text-file.ts'

/** 一个用完就删的临时目录。测试跑在真盘上 —— 这个模块的**全部职责**就是碰盘，绕不开。 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'code-chat-textfile-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('读到一个普通文件：字节数、返回字节数、未截断、hash 齐全', async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, 'persona.md')
    const text = '你叫 Nyx。\n负责后端。\n'
    await writeFile(p, text, 'utf8')

    const res = await readTextFile(p)
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.text, text, '正文逐字回来，不许 trim')
    assert.equal(res.bytes, Buffer.byteLength(text, 'utf8'), 'bytes 是原始字节数')
    assert.equal(res.returnedBytes, res.bytes, '没截断时两者必须相等')
    assert.equal(res.truncated, false)
    assert.equal(res.hash.length, 64, 'sha256 十六进制是 64 个字符')
  })
})

test('★ 超过上限：按字节截断，但 `bytes` 与 `hash` 仍是**全量**的', async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, 'big.md')
    const head = 'A'.repeat(100)
    const tail = 'B'.repeat(100)
    await writeFile(p, head + tail, 'utf8')

    const cut = await readTextFile(p, 100)
    const whole = await readTextFile(p)
    assert.equal(cut.ok, true)
    assert.equal(whole.ok, true)
    if (!cut.ok || !whole.ok) return

    assert.equal(cut.truncated, true)
    assert.equal(cut.text, head, '截断到上限为止')
    assert.equal(cut.bytes, 200, '★ bytes 说的是「这个文件多大」，不是「给了你多少」')
    assert.equal(cut.returnedBytes, 100)
    // ★ 这一条是判决：截断不许污染身份。改了后半段的文件必须换 hash。
    assert.equal(cut.hash, whole.hash, 'hash 按全量算 —— 与不截断时读到的是同一个值')
  })
})

test('★ 按字节切不按字符切：切在多字节字符中间也不抛（中文项目的常态）', async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, 'cjk.md')
    // 每个汉字 3 字节。上限给 4 ⇒ 落在第 2 个字中间，按字符切是不可能的。
    await writeFile(p, '一二三四', 'utf8')

    const res = await readTextFile(p, 4)
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.truncated, true)
    assert.equal(res.bytes, 12, 'bytes 仍是全量')
    assert.equal(res.text[0], '一', '第一个完整字符必须完好')

    // ★ 切在字符中间时会剩一个**不完整的码元**，解码成一个 U+FFFD。
    // 于是 `returnedBytes` 会**略大于**上限：最坏情况是被截断的 1 个字节
    // 变成 3 个字节的替换字符，即最多超出 2 字节。
    // 这不是 bug，是这个做法的已知代价（文件头写了「可接受」）——
    // 所以这里断言的是**有界**，而不是「不超过上限」（后者是做不到的）。
    assert.ok(
      res.returnedBytes <= 4 + 2,
      `替换字符最多让返回字节数超出 2（实得 ${res.returnedBytes}）`
    )
    assert.ok(res.text.length <= 3, '最多只多出一个替换字符，不许把后面的字也吞进来')
  })
})

test('★ `capBytes` 给 0 是「截成空串」，不给是「不截断」—— 两者不同', async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, 'x.md')
    await writeFile(p, '有内容', 'utf8')

    const zero = await readTextFile(p, 0)
    const none = await readTextFile(p)
    assert.equal(zero.ok, true)
    assert.equal(none.ok, true)
    if (!zero.ok || !none.ok) return

    assert.equal(zero.truncated, true, '0 是上限，而且它被超过了')
    assert.equal(zero.text, '')
    assert.equal(zero.bytes, 9, 'bytes 仍是全量')
    assert.equal(zero.hash, none.hash, '截成空串也不改变身份')

    assert.equal(none.truncated, false)
    assert.equal(none.text, '有内容')
  })
})

test('文件不存在 → `ok:false` + `code`，**不抛**', async () => {
  await withTempDir(async (dir) => {
    const res = await readTextFile(join(dir, 'nope.md'))
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, 'ENOENT')
    assert.ok(res.reason.length > 0, 'reason 是给人看的，必须有话可说')
  })
})

test('★ 目标是目录 → `EISDIR`（用户选错了），**不抛**', async () => {
  await withTempDir(async (dir) => {
    const sub = join(dir, 'a-directory')
    await mkdir(sub)

    const res = await readTextFile(sub)
    assert.equal(res.ok, false)
    if (res.ok) return
    // 这条 code 是 IPC 那条路**唯一**会区别对待的失败：用户多半是选了个目录，
    // 而那句提示（「是一个目录，不是文件」）要能照着做，所以它不能被泛化掉。
    assert.equal(res.code, 'EISDIR')
  })
})

// ─────────────────────────────────────────────────────────────
// M7b：`sha256Hex` —— `@` 去重键的另一半
// ─────────────────────────────────────────────────────────────

test('★ `sha256Hex` 是已知答案，且按 **UTF-8** 算', () => {
  // 为什么值得钉死两个常量：这个值进了 `@` 去重键（§4.5b 第 2 条），
  // 而去重**算不中**的样子是「同一件事被派了两轮」—— 它不报错。
  // 换编码（latin1 / utf16le）在这里是最容易发生的一种改动，而它只对
  // **非 ASCII** 的正文有影响 —— 中文项目里那是绝大多数句子。所以两个向量都要。
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex('改完了'), '5a79554cf3effc494619a7e4c5bb3c4544ae11c8c83357a87759116cb4f4fe92')
})

test('`sha256Hex` 与「先按 UTF-8 编码成字节、再算哈希」逐字节一致', () => {
  // 上一条钉的是「值」，这一条钉的是「它凭什么来」—— 归档里的人重算键时
  // 手里只有字节，所以这两条路必须是同一条。
  const text = '我把 api-server/src/a.ts 的 x 改成了 2。\n'
  assert.equal(sha256Hex(text), createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'))
})
