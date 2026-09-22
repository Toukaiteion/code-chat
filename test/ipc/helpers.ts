/**
 * `test/ipc/` 共用的测试脚手架。
 *
 * ★ 这里能存在，本身就是「registry 不 import electron」那条纪律的收益：
 * 一份假 transport + 一个内存库，整个 IPC 路径（zod 校验 → 分发 → 信封 →
 * 错误映射）就在裸 Node 下跑完了，不需要起窗口。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { openStore } from '../../src/main/persist/index.ts'
import type { Store } from '../../src/main/persist/index.ts'
import { locateGit } from '../../src/main/infra/git.ts'
import { createRegistry, type HandlerContext, type Registry } from '../../src/main/ipc/registry.ts'
import { registerAll } from '../../src/main/ipc/handlers/index.ts'
import type { IpcTransport } from '../../src/main/ipc/transport.ts'
import type { IpcResult } from '../../src/shared/ipc/envelope.ts'

export const NOW = 1_700_000_000_000

// ─────────────────────────────────────────────────────────────
// 临时目录
// ─────────────────────────────────────────────────────────────

/**
 * M4 起 handler 真的会写磁盘（建空间、复制、克隆），所以测试需要一个**真的**
 * 临时目录 —— 而且是每个进程自己的一次性目录，不能共用（并行跑测试文件时
 * 共用会让 A 的残留影响 B 的断言）。
 *
 * ★ 同步的 `mkdtempSync`：`harness()` 已经被 80 多个用例同步调用，
 * 为了一个目录把它全改成 `await` 不划算。目录创建本来也不必异步。
 *
 * 进程退出时一并删掉 —— 否则每跑一次测试就在 tmp 里留一堆空间目录。
 * `process.on('exit')` 里只能做同步操作，所以用 `rmSync`。
 */
const tempRoots: string[] = []

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 退出路径上不值得为一个清理失败再抛一次。
    }
  }
})

/** `workspaceRoot` 用的临时根目录。每次调用都是一个**新的**空目录。 */
export function tmpRoot(): string {
  return tempRoot('code-chat-test-')
}

/** 写一个真实文件（人设 / 职责描述用），返回**绝对路径**。 */
export function fixtureFile(name: string, content = `# ${name}\n`): string {
  const path = join(fixtureRoot(), name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

/** 主进程算 hash 用的同一套算法（`file-hash.ts` 也是 sha256 十六进制）。 */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * 写一个人设 / 职责文件，并把它**内容的 sha256** 一并给出来。
 * 用来断言主进程算出来的 hash 确实对得上——比写死一个字符串有说服力。
 */
export function fixtureFileWithHash(
  name: string,
  content = `# ${name}\n`
): { path: string; hash: string } {
  return { path: fixtureFile(name, content), hash: sha256Hex(content) }
}

let fixtureDir: string | null = null
function fixtureRoot(): string {
  fixtureDir ??= tempRoot('code-chat-fixtures-')
  return fixtureDir
}

// ─────────────────────────────────────────────────────────────
// 真 git（用来造一个「本地远端」）
// ─────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

/**
 * 跑 git 时的**干净环境**。
 *
 * ★ 这是本文件里最要紧的一段：不隔离的话，测试结果会随**跑测试的这台机器**漂移 ——
 * 用户自己的 `init.defaultBranch`、`user.name`、`commit.gpgsign`、`core.autocrlf`
 * 都会渗进来。之前有过「本地绿、换台机器红」的教训，宁可在这里多写六行。
 *
 * - `GIT_CONFIG_NOSYSTEM=1` + `GIT_CONFIG_GLOBAL=<空文件>`：系统级与用户级配置全不读；
 * - `-c init.defaultBranch=main`：不依赖机器上配的是 `master` 还是 `main`；
 * - `-c core.autocrlf=false`：断言文件内容时要求**逐字节**一致；
 * - `GIT_AUTHOR_*` / `GIT_COMMITTER_*`：没有身份 git 会拒绝提交。
 */
async function git(args: string[], cwd?: string): Promise<void> {
  const globalConfig = join(fixtureRoot(), 'empty-gitconfig')
  // `flag: 'a'`：不存在就建、存在就什么都不写 —— 只需要一个**空的**文件在那里。
  writeFileSync(globalConfig, '', { flag: 'a' })
  await execFileAsync(
    'git',
    [
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Code Chat Test',
      '-c',
      'user.email=test@example.invalid',
      ...args
    ],
    {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Code Chat Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Code Chat Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid'
      }
    }
  )
}

/**
 * 造一个有两笔提交的本地 git 仓库。
 *
 * ★ 用**本地路径当远端**，所以 clone 的用例**离线可跑** ——
 * 测试不该依赖网络，也不该依赖某个远端仓库一直存在。
 *
 * @returns 仓库目录（可以直接当 `sourcePath` / `remoteUrl` 用）
 */
export async function makeGitRepo(
  dir: string,
  files: Record<string, string> = { 'README.md': '# demo\n' }
): Promise<string> {
  mkdirSync(dir, { recursive: true })
  await git(['init'], dir)

  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  await git(['add', '-A'], dir)
  await git(['commit', '-m', '初始提交'], dir)

  // 第二笔：让历史非平凡，`defaultBranch` 之外的断言（比如「完整克隆拿到了历史」）
  // 才有东西可看。
  writeFileSync(join(dir, 'SECOND.md'), 'second\n', 'utf8')
  await git(['add', '-A'], dir)
  await git(['commit', '-m', '第二笔提交'], dir)

  return dir
}

/** 当前提交数 —— 用来证明「完整克隆」真的拿到了历史，而不只是拿到了工作区。 */
export async function commitCount(repoPath: string): Promise<number> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-list', '--count', 'HEAD'], {
    windowsHide: true
  })
  return Number(stdout.trim())
}

export interface FakeTransport extends IpcTransport {
  /** 直接调某个通道，绕开 electron —— 返回的永远是信封。 */
  call(channel: string, payload?: unknown): Promise<IpcResult<unknown>>
  /** 记录 `send` 出站的推送，用于验证出站校验。 */
  sent: Array<{ channel: string; payload: unknown }>
  /** 已接在 transport 上的通道数。 */
  size(): number
}

export function fakeTransport(): FakeTransport {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
  const sent: Array<{ channel: string; payload: unknown }> = []

  return {
    sent,
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    send(channel, payload) {
      sent.push({ channel, payload })
    },
    size: () => handlers.size,
    async call(channel, payload) {
      const fn = handlers.get(channel)
      if (!fn) {
        // 真实世界里这里应该是 preload 的白名单拒绝。测试里直接说清是脚手架的问题。
        throw new Error(`测试脚手架错误：通道 ${channel} 没有接在 transport 上`)
      }
      return (await fn(payload)) as IpcResult<unknown>
    }
  }
}

export interface HarnessOptions {
  /** `workspaceRoot`。省略就现建一个临时目录。 */
  root?: string
  /** `dialog:pickPath` 的返回值（`null` = 用户取消）。默认 `null`。 */
  pickPath?: string | null
  /**
   * `locateGit()` 的返回值。
   *
   * - 省略 → 用**真的** `locateGit()`（那些要跑真 git 的用例本来就依赖 PATH 上有 git）；
   * - `null` → 明确模拟「本机没装 git」，验那条分支的人话错误。
   */
  gitPath?: string | null
}

/** `now` / `newId` 都**确定**：断言里因此能写具体值，而不是「非空」。 */
export function testContext(store: Store, opts: HarnessOptions = {}): HandlerContext {
  let n = 0
  const root = opts.root ?? tmpRoot()
  return {
    store,
    now: () => NOW,
    newId: () => `id-${++n}`,
    view: { workspaceId: null, sessionId: null },
    /**
     * 宿主能力在测试里是一组**固定实现**：空间根指向临时目录、
     * 对话框返回预设值、git 定位器可控。这就是 `SysCapabilities` 走注入的全部回报
     * —— 建空间与「没装 git」两条分支因此都能自动跑，不用起 Electron、不用点对话框。
     */
    sys: {
      pickPath: async () => opts.pickPath ?? null,
      revealPath: async () => true,
      workspacesRoot: () => root,
      locateGit: async () => (opts.gitPath === undefined ? locateGit() : opts.gitPath)
    }
  }
}

export interface Harness {
  store: Store
  registry: Registry
  transport: FakeTransport
  ctx: HandlerContext
  call: FakeTransport['call']
}

/** 内存库 + 全量 handler + 假 transport，已经 `seal()` 过。 */
export function harness(opts: HarnessOptions = {}): Harness {
  const store = openStore(':memory:')
  const transport = fakeTransport()
  const ctx = testContext(store, opts)
  const registry = createRegistry(transport, ctx)
  registerAll(registry, ctx)
  registry.seal()
  return { store, registry, transport, ctx, call: transport.call }
}

/** 断言信封是失败的，且返回错误对象（收窄类型用）。 */
export function expectFail(result: IpcResult<unknown>): {
  code: string
  message: string
  detail?: unknown
} {
  if (result.ok) throw new Error(`期望失败信封，却拿到了成功：${JSON.stringify(result.data)}`)
  return result.error
}

/** 断言信封是成功的，并返回 data。 */
export function expectOk<T = unknown>(result: IpcResult<unknown>): T {
  if (!result.ok) {
    throw new Error(`期望成功信封，却拿到了 ${result.error.code}：${result.error.message}`)
  }
  return result.data as T
}

/** 建一个最小可用的空间，返回 id。 */
export async function makeWorkspace(h: Harness, name = 'Nova'): Promise<string> {
  const result = await h.call('workspace:create', { name })
  return expectOk<{ id: string }>(result).id
}

/**
 * 建一个角色，返回 id。
 *
 * ★ 人设文件是**真的写到临时目录里的**，因为这个 hash 现在由主进程读文件算
 * （`actor:create` 已经不吃 `personaHash` 了）。要断言 hash，用
 * `fixtureFileWithHash()` 拿到「路径 + 内容 hash」，别写死一个字符串。
 */
export async function makeActor(h: Harness, name = 'Atlas'): Promise<string> {
  const result = await h.call('actor:create', {
    name,
    model: 'deepseek-flash',
    personaPath: fixtureFile(`personas/${name}.md`)
  })
  return expectOk<{ id: string }>(result).id
}

/** 建一个成员，返回 `{ memberId, sessionId }`。 */
export async function makeMember(
  h: Harness,
  workspaceId: string,
  actorId: string,
  displayName = '架构师'
): Promise<{ memberId: string; sessionId: string }> {
  const result = await h.call('member:create', { workspaceId, actorId, displayName })
  const member = expectOk<{ id: string }>(result)
  const session = await h.call('session:getByMember', { memberId: member.id })
  const sess = expectOk<{ id: string } | null>(session)
  if (!sess) throw new Error('member:create 没有同时建出 session')
  return { memberId: member.id, sessionId: sess.id }
}

/** 建一个项目（直接走 repository，绕开 `addLocal` 的 fs 校验）。 */
export function makeProject(
  store: Store,
  workspaceId: string,
  id: string,
  name: string,
  rootPath: string
): string {
  store.repos.project.create({ id, workspaceId, name, rootPath, origin: 'local', now: NOW })
  return id
}
