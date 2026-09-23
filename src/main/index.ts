import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { app, shell, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import type { Store } from './persist/index.ts'
import { openStore } from './persist/index.ts'
import { dbPath } from './infra/paths.ts'
import { createActiveView, createContext } from './ipc/context.ts'
import { createSystemCapabilities } from './ipc/system-capabilities.ts'
import { createElectronTransport } from './ipc/electron-transport.ts'
import { createRegistry, type Registry } from './ipc/registry.ts'
import { registerAll } from './ipc/handlers/index.ts'
import { createChildRegistry } from './process/child-registry.ts'
import { createAdapterRegistry } from './adapters/registry.ts'
import { createRuntime, type Runtime } from './process/runtime.ts'
import type { PushOf } from '../shared/ipc/contract.ts'

/** 启动期需要告诉用户的事，最终都走 `app:notice` 这一条通道。 */
type AppNotice = PushOf<'app:notice'>

/**
 * 后端 = 库 + 运行时 + 注册表 + 传输。**在 `whenReady` 里、建窗口之前**装配好，
 * 这样渲染进程的第一次 `invoke` 一定已经有人接。
 */
interface Backend {
  store: Store
  registry: Registry
  /** 退出时要**先于** `store.close()` 冲空（合批器的定时器 + 脏缓冲）。 */
  runtime: Runtime
}

let backend: Backend | null = null

/**
 * 传输层与库**分开**建：库可能开失败（磁盘满、文件被别的进程锁住、
 * 迁移写错），而那时我们仍然需要一条路把失败告诉渲染层。
 * 把传输建在 try 之外，就是为这个「后端起不来」的路径留的。
 */
const transport = createElectronTransport()

/** 窗口还没 ready 时先攒着。`did-finish-load` 之后一次性推给渲染层。 */
const pendingNotices: AppNotice[] = []

/**
 * 记一条要给用户看的通知。
 *
 * ⚠️ M3 只有**一个**窗口，所以「谁先 load 完谁负责冲掉队列」是安全的。
 * 多窗口时这条不成立（第二个窗口 load 前队列已被第一个冲空），
 * 届时要把队列改成按 `webContents.id` 分桶。
 */
function notify(notice: AppNotice): void {
  pendingNotices.push(notice)
}

function flushNotices(): void {
  if (pendingNotices.length === 0) return
  for (const notice of pendingNotices.splice(0)) {
    if (backend) {
      backend.registry.emit('app:notice', notice)
    } else {
      // ★ 后端起不来时 registry 也不存在，只能**绕过校验**直接发。
      //   这是刻意的例外，且是安全的：载荷由本文件构造，形状即 `AppNoticeSchema`。
      transport.send('app:notice', notice)
    }
  }
}

/**
 * 起后端。**失败不抛** —— 抛出去会让 `whenReady` 的 promise 静默拒绝，
 * 用户看到的是一个白屏窗口，终端里一行有用的信息都没有（M0 踩过同类坑）。
 * 改为：留下可读日志 + 把错误推给渲染层显示。
 */
function startBackend(): void {
  try {
    // `node:sqlite` 不会替我们建父目录。userData 在绝大多数情况下已存在，
    // 但这个 mkdir 的代价是一次 syscall，换掉一整类「首次启动就 SQLITE_CANTOPEN」。
    mkdirSync(dirname(dbPath()), { recursive: true })

    const store = openStore(dbPath())
    const sys = createSystemCapabilities()

    /**
     * ★ 这里有一个**真的环**：registry 的 `HandlerContext` 要拿到 runtime，
     * 而 runtime 的推送（`stream:batch` / `workspace:unread`）要走 registry 的 `emit`。
     *
     * 用 `let registry = null` + 闭包里 `registry?.emit(...)` 把它接起来，而不是
     * 造一个「等一下再注入」的 setter —— 后者会让「谁在什么时候才是活的」变成
     * 一个每个调用点都要小心的隐状态。这里环的**方向**是一眼可见的：
     * runtime 先建、registry 后建，而 runtime 只在**运行时**（轮次真的产出帧时）
     * 才读那个变量，那时它必然已经赋值。
     *
     * 万一真在赋值前就推了一帧，那帧也**不会丢**：合批器的纪律是
     * 「先落库、后推送」，丢的只是一次已经进了 `message_event` 的转发。
     */
    let registry: Registry | null = null

    const children = createChildRegistry()
    const adapters = createAdapterRegistry({ registry: children })
    // ★ 这一个对象交给 runtime（持引用读）**和** ctx（`view:setActive` 写）。
    //   两个都建自己的话，抑制逻辑就会读一个永远不更新的视图。
    const view = createActiveView()

    const runtime = createRuntime({
      store,
      children,
      adapters,
      workspaceRoot: sys.workspacesRoot(),
      view,
      emitBatch: (batch) => registry?.emit('stream:batch', batch),
      emitUnread: (payload) => registry?.emit('workspace:unread', payload),
      emitStatus: (payload) => registry?.emit('stream:status', payload),
      /**
       * ★ M7b 之前 `app:notice` **只有启动期**一个生产者（下面的 `notify`）。
       * 现在运行时的熔断（乒乓 2 跳警告 / 4 跳终止）也要走它 —— 而 §4.5b 要求的
       * 那条「可见警告」正是这条通道。
       *
       * ⚠️ 走 `registry.emit` 而**不是** `notify()`：`notify` 是给「窗口还没加载完」
       * 那段时间用的（它把通知攒进队列等 `did-finish-load`），而轮次结束时窗口早就在了 ——
       * 攒进那个队列的通知**永远不会被冲出去**（`flushNotices` 只跑一次）。
       */
      emitNotice: (notice) => registry?.emit('app:notice', notice),
      now: () => Date.now(),
      newId: () => randomUUID(),
      onWarn: (tag, message, detail) => console.warn(`[runtime:${tag}] ${message}`, detail ?? ''),
      /**
       * ★ M7a 的观测缝：**一轮到底发了什么上下文**。
       *
       * 在这之前那件事是**零观测**的 —— 装配产物只在内存里，`db-*.json` 看不到它，
       * 界面上也没有任何痕迹。走查要对它下断言，而它没有别的落档处。
       *
       * 写的是一行 JSON 到**主进程 stdout**，理由是「这条通道已被证明存在」：
       * M6b 的归档里 `app-A.stdout.log` 就有主进程 `console.log` 的输出。
       * 走查（`scripts/m7a-walkthrough.ts`）读那一行、`rec()` 进 `events.jsonl` ——
       * 于是**报告仍然只读归档**，重放零成本。
       *
       * ★ 传的是 `ContextShape`，**不含任何正文**：够回答「装配对不对」，
       * 不够泄露用户的项目内容（归档是要进版本库的）。
       */
      onContextBuilt: (turnId, shape) => console.log(`[ctx] ${JSON.stringify({ turnId, shape })}`)
    })

    const ctx = createContext({ store, sys, runtime, view })
    registry = createRegistry(transport, ctx)
    registerAll(registry, ctx)
    // ★ `seal()` 会断言每个通道都被明确分类过（handle 或 defer）。
    //   漏掉一条通道是**开发期**错误，必须在启动时炸，而不是等用户点下去才发现。
    registry.seal()

    backend = { store, registry, runtime }
    console.log(`[main] 数据库已就绪：${dbPath()}（schema v${store.schemaVersion}）`)

    /**
     * ★ 启动清扫（§4.4，M6a 提前落地状态层的那一半）。
     *
     * 「不自动恢复」是产品决策，所以这里**只改状态、不重跑**。但改了就必须说 ——
     * 用户上次开着的应用里那几条「排队中 / 运行中」，这一秒变成了「失败」，
     * 不给一句话就是让界面自己编一个解释。两类分开报，因为它们真的是两件事：
     * 一类是跑到一半被掐了，另一类是**从来没发出去过**。
     */
    try {
      const sweep = runtime.startupSweep()
      if (sweep.reapedRunning > 0) {
        notify({
          level: 'warning',
          message: `上次退出时有 ${sweep.reapedRunning} 个轮次正在运行，已标记为失败（不会自动恢复）`,
          detail: { reapedRunning: sweep.reapedRunning }
        })
      }
      if (sweep.reapedQueued > 0) {
        notify({
          level: 'warning',
          message: `有 ${sweep.reapedQueued} 个轮次上次排队后还没开始执行，已标记为失败（不会自动恢复）`,
          detail: { reapedQueued: sweep.reapedQueued }
        })
      }
    } catch (err) {
      // 清扫失败不影响这一次能不能用，但它会让界面上留下几条**永远不会动**的
      // 「排队中」—— 所以必须说出来，而且不能说成「数据库起不来」。
      console.error('[main] 启动清扫失败：', err)
      notify({
        level: 'warning',
        message: `上一次遗留的轮次没能清理干净：${err instanceof Error ? err.message : String(err)}`
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[main] 后端启动失败：', err)
    notify({
      level: 'error',
      message: `无法启动数据库：${message}`,
      detail: { dbPath: dbPath(), schemaVersion: null }
    })
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    // 消除白色启动闪屏（方案 §4.8）
    backgroundColor: '#05060a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // contextIsolation 开、nodeIntegration 关 —— 渲染进程不得触碰 Node
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要 require，故 sandbox 关闭
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // 渲染层订阅 `app:notice` 只可能发生在它自己的脚本跑起来之后，
  // 所以启动期的通知必须等到 `did-finish-load` 才发 —— 早发的会掉在地上。
  mainWindow.webContents.on('did-finish-load', flushNotices)

  if (is.dev) {
    // 渲染进程的 console 默认去 devtools，终端里什么都看不到。
    // 开发期把它转发过来 —— 否则「页面白屏」和「页面正常」在终端里长得一模一样。
    // Electron 44：首参即新式事件对象，level 是字符串（'info'|'warning'|'error'|'debug'），
    // 后面那些位置参数已标记 deprecated，不要用。
    mainWindow.webContents.on('console-message', (details) => {
      const tag = details.level === 'error' || details.level === 'warning' ? 'error' : 'log'
      console[tag](`[renderer:${details.level}] ${details.message}  (${details.sourceId}:${details.lineNumber})`)
    })
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error('[renderer] 进程崩溃:', details.reason, details.exitCode)
    })
    mainWindow.webContents.on('preload-error', (_e, path, err) => {
      console.error('[preload] 出错:', path, err)
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[renderer] 加载失败:', code, desc, url)
    })
  }

  // 外链一律走系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 单实例锁：防止双开导致重复 spawn agent 进程（方案 §4.4）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    // appId 是自动更新的身份标识，日后不可更改（方案 §4.9）
    electronApp.setAppUserModelId('com.codechat.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // 先起后端再开窗口：顺序反过来的话，渲染层的第一条 invoke 会打在空处。
    startBackend()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // 关闭连接放这里而不是 `window-all-closed`：macOS 上关掉所有窗口后进程还活着，
  // 而 WAL 文件要有一次干净的 close 才能被 checkpoint 回主库。
  app.on('will-quit', () => {
    transport.dispose?.()
    // ★ 顺序是硬的：合批器的 `close()` 是**同步冲空**（清定时器 + 把脏缓冲在一个事务里写完），
    //   而它要写的正是这个库。反过来的话，那些帧会在一个已经关掉的连接上写 ——
    //   表现是退出时日志里一串「落库失败」，而用户那最后一句话永远停在半截。
    backend?.runtime.close()
    backend?.store.close()
    backend = null
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
