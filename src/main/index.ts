import { join } from 'node:path'
import { app, shell, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

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

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
