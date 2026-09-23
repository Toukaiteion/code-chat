/**
 * 把 M6b 走查里 `HELPERS` 那段**页面侧 JS** 抠出来做一次语法检查。
 *
 * ## 为什么需要这个脚本（而不是「小心一点」）
 *
 * `tsc` **不检查模板字符串里面的内容**，而 `HELPERS` 里装的是要注入渲染进程的
 * 一大段 JS。于是那里面的语法错**没有任何静态检查能拦住它**，
 * 而它的报错方式极其误导：页面侧注释里**一个裸反引号**就会提前把模板截断，
 * 于是整个文件从那里往下错位，`tsc` 报的是 `TS1005` / `TS1443`，
 * 行号指在**几百行之外**一个看起来完全正常的地方。
 *
 * M6b 这一轮被它咬了**两次**（第二次是刚写完一条关于它的注释）。
 * 所以它不是「一次性的自查」，它是这个形状的模板字符串的**必要配套**：
 * 碰过 `HELPERS` 就跑一次，代价是几十毫秒，而它拦住的是「真机上炸 —— 那已经花过钱了」。
 *
 *     npm run check:helpers
 *
 * ## 两处刻意的做法
 *
 * 1. **抠区间的两头都是硬判据，且拿不到就报错退出** —— 悄悄抠错一段然后说「语法 OK」
 *    比不检查更坏（它会让人以为检查过了）。
 * 2. **多验一个标记（`window.__m6b`）**：区间取错时（比如把整份脚本都抠进来）
 *    语法多半也是对的，那条标记是「我抠到的确实是那段页面侧 JS」的证据。
 */
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, 'm6b-walkthrough.ts')
const TICK = String.fromCharCode(96) // 反引号：本文档里不许出现裸的它（同一条纪律）
const OPEN = 'const HELPERS = ' + TICK
const CLOSE = '\n' + TICK + '\n' // 模板的收尾反引号独占一行

const src = fs.readFileSync(SRC, 'utf8')
const start = src.indexOf(OPEN)
if (start < 0) {
  console.log('拿不到 HELPERS 的开头（' + OPEN + '）')
  process.exit(1)
}
const end = src.indexOf(CLOSE, start)
if (end < 0) {
  console.log('拿不到 HELPERS 的收尾反引号 —— 它要么被截断了，要么格式变了')
  process.exit(1)
}

const body = src.slice(start + OPEN.length, end)
const lineOf = (i) => src.slice(0, i).split('\n').length

if (!body.includes('window.__m6b')) {
  console.log(`抠到的区间（第 ${lineOf(start)}–${lineOf(end)} 行）里没有 window.__m6b —— 抠错了`)
  process.exit(1)
}

let ok = true
try {
  new Function(body)
} catch (e) {
  ok = false
  console.log('❌ 页面侧 JS 语法错：' + e.message)
}

console.log(
  (ok ? '✅ ' : '') +
    `页面侧 JS 语法 ${ok ? 'OK' : '不通过'} —— 第 ${lineOf(start) + 1}–${lineOf(end)} 行，` +
    `${body.length} 字，含 \${ 插值? ${body.includes('$' + '{')}`
)
if (!ok || body.includes('$' + '{')) {
  console.log('   ⚠️ 真机跑之前先修掉 —— 那一段只在渲染进程里炸，而那时钱已经花了。')
  process.exit(1)
}
