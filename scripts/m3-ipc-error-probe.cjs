/**
 * M3 待验假设之一 —— **`ipcMain.handle` 跨边界时到底保留了什么**。
 *
 * 为什么要实测：`shared/ipc/envelope.ts` 让每个 handler 都返回信封而**不抛异常**，
 * 理由是「抛出去的自定义字段会丢」。这是本仓库里唯一一条「文档没写、也没实测」的前提，
 * 而整个信封设计的必要性都押在它上面。所以必须亲自量一次。
 *
 * 跑法（Git Bash）：
 *   ./node_modules/electron/dist/electron.exe scripts/m3-ipc-error-probe.cjs
 * 期望输出最后一行：M3 PROBE DONE（并把结论打印在中间）
 */
const { app, BrowserWindow, ipcMain } = require('electron')

// 一个带自定义字段的错误 —— 完全模仿 `AppError` 的形状。
class ProbeError extends Error {
  constructor() {
    super('这个目录已经加过了')
    this.name = 'AppError'
    this.code = 'E_CONFLICT'
    this.detail = { projectId: 'p1', errcode: 2067 }
  }
}

ipcMain.handle('probe:appError', () => {
  throw new ProbeError()
})

// 同一个错误，但被包成**信封**返回（也就是我们真正采用的做法）。
ipcMain.handle('probe:envelope', () => ({
  ok: false,
  error: { code: 'E_CONFLICT', message: '这个目录已经加过了', detail: { projectId: 'p1', errcode: 2067 } }
}))

// detail 不可结构化克隆时会怎样 —— 信封路线也必须扛得住。
ipcMain.handle('probe:unclonable', () => {
  const circular = {}
  circular.self = circular
  const err = new Error('带循环引用')
  err.detail = circular
  throw err
})

const PROBE = `
(async () => {
  const out = {}

  // 1. 抛一个带自定义字段的 Error
  try {
    await window.probe.invoke('probe:appError')
    out.appError = 'NO THROW?!'
  } catch (err) {
    out.appError = {
      constructor: err.constructor.name,
      ownKeys: Object.keys(err),
      code: err.code === undefined ? '(丢失)' : err.code,
      detail: err.detail === undefined ? '(丢失)' : err.detail,
      name: err.name,
      message: err.message,
      hasStack: typeof err.stack === 'string'
    }
  }

  // 2. 返回信封
  out.envelope = await window.probe.invoke('probe:envelope')

  // 3. 不可克隆的 detail
  try {
    await window.probe.invoke('probe:unclonable')
    out.unclonable = 'NO THROW?!'
  } catch (err) {
    out.unclonable = { message: err.message, hasDetail: err.detail !== undefined }
  }

  return out
})()
`

function makeWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: require('node:path').join(__dirname, 'm3-ipc-error-probe-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  return win
}

app.whenReady().then(async () => {
  const win = makeWindow()
  await win.loadURL('data:text/html,<html><body>probe</body></html>')

  const result = await win.webContents.executeJavaScript(PROBE)

  console.log('\n══════════ M3 待验假设：ipcMain.handle 丢不丢自定义错误字段 ══════════')
  console.log('\n① handler 抛出一个带 code / detail 的 Error，渲染侧收到：')
  console.dir(result.appError, { depth: null })

  console.log('\n② handler 返回信封（我们采用的做法），渲染侧收到：')
  console.dir(result.envelope, { depth: null })

  console.log('\n③ Error 上挂一个不可结构化克隆的 detail：')
  console.dir(result.unclonable, { depth: null })

  const lost = result.appError.code === '(丢失)' || result.appError.detail === '(丢失)'
  console.log('\n────────── 结论 ──────────')
  console.log(
    lost
      ? '★ 自定义字段**确实会丢** → 「handler 必须返回信封」是有实证依据的，不是迷信。'
      : '★ 自定义字段**没有丢** → 信封的理由要重新审视（见 docs/design.md §4.3）。'
  )
  console.log('M3 PROBE DONE')

  win.destroy()
  app.quit()
})
