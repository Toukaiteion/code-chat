/**
 * M5 验证之四：活子进程登记处与**进程树**终止。
 *
 * 这一层几乎全部的价值集中在一句话上：**杀根不等于杀树。** CLI 是个会起子进程的工具
 * （Bash、MCP server），所以「孙进程」不是理论情况 —— 而 §4.4 原本写的阶梯
 * （先 `child.kill('SIGTERM')` 再 `taskkill /T`）在 Windows 上恰好**只杀根、放过整棵树**：
 *
 * - `child.kill('SIGTERM')` 在 Windows 上不是信号，libuv 用 `TerminateProcess` **立刻硬杀**；
 * - `taskkill /T` 靠**活着的**父子链走路，根一死它就只会回一句「找不到进程」。
 *
 * 所以这里有一个**反向对照**用例（「按旧阶梯杀 → 孙进程活下来」）：
 * 它验的不是我们的代码，而是**那条被改掉的规则为什么必须改**。没有它，
 * 这个修正看起来就只是另一个实现细节，下一个人很可能又「顺手简化」回去。
 *
 * ## 三条测试纪律（都写在 `child-registry.ts` 的文件头里）
 *
 * - **绝不拿 `process.pid` 驱动阶梯。** `taskkill /T` 会把整棵树带走，包括测试运行器自己；
 *   表现出来是「框架莫名崩了」，而那种失败最难归因。
 * - **SIGTERM 只能断言「结果」，不能断言「信号送达」。** 假 CLI 装了 SIGTERM 处理器，
 *   在 Windows 上也永远收不到（上面那个 `TerminateProcess`）—— 断言「根没了」即可。
 * - **宽限期一律注入缩短**（默认 5s + 3s，一个用例就要真等 8 秒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChildRegistry, createCancelTable, DEFAULT_TIMINGS } from '../../src/main/process/child-registry.ts'
import type { KillTimings } from '../../src/main/process/child-registry.ts'
import { interruptLine, writeLine } from '../../src/main/adapters/claude/control-protocol.ts'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.cjs', import.meta.url))

/** 缩短的阶梯宽限期 —— 默认值是给生产用的，测试里真等会拖垮整个套件。 */
const FAST: KillTimings = { interruptGraceMs: 400, gracefulGraceMs: 400 }

const IS_WINDOWS = process.platform === 'win32'

/** 起一个假 CLI（直接 spawn，不经过适配器 —— 这里测的是登记处本身）。 */
function spawnFake(flags: string[]): ChildProcess {
  return spawn(process.execPath, [FAKE, ...flags], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

/** 中断载荷的形状只有 `control-protocol` 知道，登记处只负责把它递过去。 */
const sendInterrupt = (c: ChildProcess): boolean => writeLine(c.stdin, interruptLine('req-1'))

function waitExit(child: ChildProcess, ms = 4000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    child.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

/** 进程还活着吗。`kill(pid, 0)` 是「只探活不发信号」。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等到进程真的没了，或者到点放弃。Windows 上 `taskkill` 之后 pid 会短暂地仍可探测。 */
async function waitGone(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

/** 兜底清理：测试中途失败时也不许漏下进程。 */
function forceKillTree(pid: number): void {
  try {
    if (IS_WINDOWS) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch {
    /* 已经没了 */
  }
}

// ─────────────────────────────────────────────────────────────
// 登记与取消表
// ─────────────────────────────────────────────────────────────

test('登记 / 查询 / 枚举 / 释放', async () => {
  const reg = createChildRegistry()
  const child = spawnFake(['--fake-scenario=empty'])
  try {
    reg.register('t1', child)
    assert.equal(reg.handleOf('t1')?.turnId, 't1')
    assert.equal(reg.handleOf('t1')?.pid, child.pid)
    assert.deepEqual(
      reg.listLive().map((e) => e.turnId),
      ['t1']
    )
    reg.release('t1')
    assert.equal(reg.handleOf('t1'), null)
    assert.deepEqual(reg.listLive(), [])
  } finally {
    if (child.pid) forceKillTree(child.pid)
    await waitExit(child)
  }
})

test('子进程自己退出时会**自动**撤销登记（否则登记表随运行时间慢慢变脏）', async () => {
  const reg = createChildRegistry()
  const child = spawnFake(['--fake-scenario=empty'])
  reg.register('t1', child)
  try {
    assert.equal(reg.listLive().length, 1)
    await waitExit(child)
    assert.notEqual(child.exitCode, null, '假 CLI 必须真的自己退出了（它不放开 stdin 就会挂住）')
    // 等一下让 exit 监听器跑完（它是微任务，但这里跨了进程事件）。
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(reg.listLive(), [], '不该留着一条已经死掉的记录')
  } finally {
    if (child.pid) forceKillTree(child.pid)
  }
})

test('取消表：登记 / 取信号 / 中断 / 忘掉，且**中断两次只有第一次算数**', () => {
  const cancel = createCancelTable()
  const c = new AbortController()
  cancel.registerCancel('t1', c)

  assert.equal(cancel.signalOf('t1'), c.signal)
  assert.deepEqual(cancel.liveTurnIds(), ['t1'])
  assert.equal(cancel.abort('t1'), true, '第一次是真中断')
  assert.equal(c.signal.aborted, true)
  // 第二次返回 false —— 这正是 §4.5a 规则 4 要的幂等语义：
  // 「请求了中断」与「本来就结束了」是两件事，调用方要能区分。
  assert.equal(cancel.abort('t1'), false, '已经中断过了，不许再报一次成功')
  assert.equal(cancel.abort('never-existed'), false)

  cancel.forgetCancel('t1')
  assert.equal(cancel.signalOf('t1'), null)
})

// ─────────────────────────────────────────────────────────────
// 阶梯
// ─────────────────────────────────────────────────────────────

test('找不到这个轮次 → null（没在跑，不是错误）', async () => {
  const reg = createChildRegistry()
  assert.equal(await reg.killTree('nope'), null)
})

test('已经退出、且已从登记表摘掉 → null（「没在跑」而不是「杀过了」）', async () => {
  // `register` 挂了 `once('exit')` 自动撤销登记，所以正常退出之后登记表里已经没有它了。
  // 返回 `null` 是对的：调用方要区分的是「它还在不在跑」，而答案是不在。
  const reg = createChildRegistry()
  const child = spawnFake(['--fake-scenario=empty'])
  reg.register('t1', child)
  await waitExit(child)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(await reg.killTree('t1', { timings: FAST, sendInterrupt }), null)
})

test('已经退出、但**还在**登记表里 → already-exited（那条守卫是活的，不是死代码）', async () => {
  // 这条路径真实存在：`exitCode` 在进程退出的那一刻就置位了，而 `exit` **事件**
  // 要到下一个 tick 才派发 —— 中间那个窗口里，登记表里还留着一条已经死掉的记录。
  // 启动清扫（M10）也会走到同一个形状：登记一个已经死掉的东西。
  // 这里用「先等它退出、再登记」把这个状态确定性地造出来。
  const reg = createChildRegistry()
  const child = spawnFake(['--fake-scenario=empty'])
  await waitExit(child)
  assert.notEqual(child.exitCode, null)
  reg.register('t1', child)
  const outcome = await reg.killTree('t1', { timings: FAST, sendInterrupt })
  assert.equal(outcome?.stage, 'already-exited')
  assert.equal(outcome?.exited, true, '已经死了就是死了，别谎报说没杀掉')
})

test('★ 第 1 级：CLI 收到中断后**自己**体面收尾 → 这一级就结束，不需要动刀', async () => {
  const reg = createChildRegistry()
  // `graceful`：先回 ACK，隔一会儿才吐终态并退出 —— 阶梯第 1 级成功的形态。
  const child = spawnFake(['--fake-scenario=empty', '--fake-hang', '--fake-on-interrupt=graceful'])
  reg.register('t1', child)
  try {
    const outcome = await reg.killTree('t1', { timings: FAST, sendInterrupt })
    assert.equal(outcome?.stage, 'interrupt', '优雅收尾成功时不该走到 taskkill')
    assert.equal(outcome?.exited, true)
  } finally {
    if (child.pid) forceKillTree(child.pid)
  }
})

test('ACK 与终态是两件事：CLI 先回 ACK，工作并没有因此结束', async () => {
  const reg = createChildRegistry()
  const child = spawnFake(['--fake-scenario=empty', '--fake-hang', '--fake-on-interrupt=graceful'])
  reg.register('t1', child)

  const lines: string[] = []
  child.stdout?.on('data', (b: Buffer) => lines.push(...b.toString('utf8').split('\n').filter(Boolean)))

  try {
    await reg.killTree('t1', { timings: FAST, sendInterrupt })
    await new Promise((r) => setTimeout(r, 50))

    const ackIdx = lines.findIndex((l) => l.includes('control_response'))
    const resultIdx = lines.findIndex((l) => l.includes('"type":"result"'))
    assert.ok(ackIdx >= 0, '要收到 ACK')
    assert.ok(resultIdx >= 0, '要收到终态')
    assert.ok(ackIdx < resultIdx, 'ACK 必须在终态**之前** —— 这正是「ACK ≠ 完成」的可执行版本')
  } finally {
    if (child.pid) forceKillTree(child.pid)
  }
})

test('★ 第 1 级不奏效（CLI 只回 ACK 不干活）→ 升到硬杀，且**结果确实死了**', async () => {
  const reg = createChildRegistry()
  // `ack-only`：回了 ACK，然后永远不吐终态。阶梯第 1 级必然超时。
  const child = spawnFake(['--fake-scenario=empty', '--fake-hang', '--fake-on-interrupt=ack-only'])
  reg.register('t1', child)
  try {
    const outcome = await reg.killTree('t1', { timings: FAST, sendInterrupt })
    assert.ok(outcome, '要给出结局')
    assert.equal(outcome.exited, true, '走了硬杀这一级就必须真的死掉')
    assert.ok(
      ['taskkill-graceful', 'taskkill-force', 'sigterm', 'sigkill'].includes(outcome.stage),
      `不该停在第 1 级，实际 ${outcome.stage}`
    )
  } finally {
    if (child.pid) forceKillTree(child.pid)
  }
})

test('连 ACK 都不回（卡死在工具里）→ 照样被杀干净', async () => {
  const reg = createChildRegistry()
  const child = spawnFake(['--fake-scenario=empty', '--fake-hang', '--fake-on-interrupt=silent'])
  reg.register('t1', child)
  try {
    const outcome = await reg.killTree('t1', { timings: FAST, sendInterrupt })
    assert.equal(outcome?.exited, true)
  } finally {
    if (child.pid) forceKillTree(child.pid)
  }
})

// ─────────────────────────────────────────────────────────────
// ★ 进程树 —— 本文件存在的理由
// ─────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'code-chat-tree-'))
const pidFile = (name: string): string => join(tmp, `${name}.pid`)

/** 起一个带孙进程的假 CLI，返回根进程与孙进程 pid。 */
async function spawnWithGrandchild(
  name: string,
  extra: string[] = []
): Promise<{ root: ChildProcess; grandchildPid: number }> {
  const file = pidFile(name)
  const root = spawnFake(['--fake-scenario=empty', '--fake-hang', '--fake-grandchild=' + file, ...extra])
  // 等假 CLI 把孙进程的 pid 写出来。
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(file, 'utf8'))
      if (pid > 0) return { root, grandchildPid: pid }
    } catch {
      /* 还没写出来 */
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('假 CLI 没能在 5 秒内写出孙进程 pid')
}

test('先确认孙进程真的活着 —— 否则下面那两条对照什么也证明不了', async () => {
  const { root, grandchildPid } = await spawnWithGrandchild('sanity')
  try {
    assert.ok(alive(grandchildPid), '前提：孙进程确实在跑')
    assert.ok(root.pid && alive(root.pid), '前提：根也在跑')
  } finally {
    if (root.pid) forceKillTree(root.pid)
    forceKillTree(grandchildPid)
    await waitExit(root)
  }
})

test('★★ 我们的阶梯：根与孙都必须消失 —— 而且是那个**会逃出 job** 的 detached 孙', async () => {
  const reg = createChildRegistry()
  // `ack-only`：让第 1 级必然超时，逼阶梯走到 `taskkill /T` —— 那才是这一条要验的东西。
  const { root, grandchildPid } = await spawnWithGrandchild('ladder', ['--fake-on-interrupt=ack-only'])
  reg.register('t1', root)
  try {
    const outcome = await reg.killTree('t1', { timings: FAST, sendInterrupt })
    assert.equal(outcome?.exited, true, '根要死')
    assert.ok(
      await waitGone(grandchildPid),
      `detached 的孙进程 ${grandchildPid} 也必须被回收 —— 这正是「第 2 级必须在根还活着时发」的理由`
    )
  } finally {
    if (root.pid) forceKillTree(root.pid)
    forceKillTree(grandchildPid)
  }
})

test('⚠️ 已知缺口：CLI **自己体面退出**时，detached 的后代会被留下（记给 M10，不是本文件能修的）', async () => {
  // 这是上一条的反面，而它**不是**实现疏漏，是结构性的：
  // 第 1 级成功意味着根**已经没了**，而 `taskkill /T` 靠父进程链走路 ——
  // 根一没，那条链就断了，我们手里再没有任何手段能找到那些后代。
  //
  // 为什么还是写出来：M10 的验收标准是「重启后任务管理器无残留 claude.exe」。
  // 这条用例把「优雅路径不收树」这个事实摆在明面上，免得有人以为树**总是**干净的。
  // M10 的启动清扫（按 `turn.pid` 找上一条命留下的孤儿）正是为这一类情形准备的。
  const reg = createChildRegistry()
  const { root, grandchildPid } = await spawnWithGrandchild('graceful-leak', ['--fake-on-interrupt=graceful'])
  reg.register('t1', root)
  try {
    const outcome = await reg.killTree('t1', { timings: FAST, sendInterrupt })
    assert.equal(outcome?.stage, 'interrupt', '第 1 级成功，根自己退了')
    assert.equal(outcome?.exited, true)
    // 趁根刚走，那个 detached 的孙还在 —— 这就是留下的一笔账。
    assert.ok(alive(grandchildPid), 'detached 的后代在优雅路径上确实会被留下')
  } finally {
    if (root.pid) forceKillTree(root.pid)
    forceKillTree(grandchildPid)
    await waitGone(grandchildPid)
  }
})

test('★★ 反向对照：**先杀根**，那个 detached 孙就活下来了 —— 旧阶梯错在哪的证据', async () => {
  // 这条测验的不是我们的代码，而是那条**被改掉的规则**。
  // §4.4 原本是「② child.kill('SIGTERM') ③ taskkill /T /F」。第 ② 级在 Windows 上是
  // TerminateProcess（立刻硬杀根），于是第 ③ 级拿着一个死 PID 发 `/T`，
  // 再也找不到父进程链可走。没有这条对照，那个顺序修正看起来只是个实现细节，
  // 早晚被人「顺手简化」回去。
  //
  // ⚠️ 这里**必须**用 detached 的孙。用普通孙进程会**假绿**：
  // 非 detached 的后代会因为继承的 Job Object 随根一起死，
  // 于是「杀根」看起来把树收干净了 —— 而那不是 Windows 的普遍性质。
  const { root, grandchildPid } = await spawnWithGrandchild('negative')
  try {
    assert.ok(root.pid)
    // 模拟旧阶梯的第 ② 级：直接对根发 SIGTERM。
    root.kill('SIGTERM')
    await waitExit(root)
    assert.ok(!alive(root.pid!), '根已经没了 —— 这一步在两种写法下都成立')

    // 关键断言：那个孙进程**还活着**。所以「先杀根」一旦执行，
    // 任何以 `/T` 为基础的补救都已经来不及了。
    assert.ok(
      alive(grandchildPid),
      'detached 的孙活了下来 —— 因为根已经不在，`/T` 再也走不到它'
    )
  } finally {
    if (root.pid) forceKillTree(root.pid)
    forceKillTree(grandchildPid)
    await waitGone(grandchildPid)
  }
})

// ─────────────────────────────────────────────────────────────
// 默认值
// ─────────────────────────────────────────────────────────────

test('默认宽限期是给生产用的，测试一律注入更短的值', () => {
  assert.ok(DEFAULT_TIMINGS.interruptGraceMs >= 1000, '第 1 级要留够 CLI 收尾在途工具的时间')
  assert.ok(DEFAULT_TIMINGS.gracefulGraceMs >= 1000)
  assert.ok(FAST.interruptGraceMs < DEFAULT_TIMINGS.interruptGraceMs)
})

test.after(() => {
  rmSync(tmp, { recursive: true, force: true })
})
