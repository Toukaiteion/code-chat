/**
 * 把所有走查脚本里 `HELPERS` 那段**页面侧 JS** 抠出来做一次语法检查。
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
 * ## 五处刻意的做法
 *
 * 1. **抠区间的两头都是硬判据，且拿不到就报错退出** —— 悄悄抠错一段然后说「语法 OK」
 *    比不检查更坏（它会让人以为检查过了）。
 * 2. **多验一个标记（`window.__`）**：区间取错时（比如把整份脚本都抠进来）
 *    语法多半也是对的，那条标记是「我抠到的确实是那段页面侧 JS」的证据。
 *    用通配的 `window.__` 而不是写死 `window.__m6b` —— 每个走查的命名空间后缀不同
 *    （`__m6a` / `__m6b` / `__m7a`…），而「它往页面里挂东西」这件事是共同的。
 * 3. ★ **默认检查全部，而不是只检查写死的那一个。** 这条是 M7a 补的：
 *    原先它硬编码 `m6b-walkthrough.ts`，于是 `m6a-pipeline-walkthrough.ts:326`
 *    也有一份 `HELPERS`，却**没有任何检查覆盖它** ——
 *    一份零覆盖的代码与一份被检查过的代码长得一模一样。
 * 4. **「一个都没找到」也算失败，不是「干净通过」**：发现逻辑若哪天失效
 *    （文件改名、模板改成不带字面量的形状），它会退化成
 *    「每次都打印 ✅ 却什么都没查」—— 而那正是本脚本存在的理由。
 * 5. ★ **收尾反引号的判据与行尾无关**（`^[ \t]*` + 反引号 + `[ \t]*$`）。这条是 M7b
 *    收尾时补的，起因是一个**假 ❌**：本仓库 `core.autocrlf=true`，所以工作区里
 *    每个文本文件的行尾取决于「谁最后写了它」——`m7b-walkthrough.ts` 是 CRLF，
 *    而它三个同类都是 LF。原先写死的 `\n` + 反引号 + `\n` 在 CRLF 下**永远匹配不上**，
 *    于是四个脚本里只有它报「拿不到收尾反引号」，而它的页面侧 JS 一个字节都没错
 *    （真机走查全绿过）。⇒ **假 ❌ 与假 ✅ 一样坏**：它教人忽略这个工具的报错。
 *    而这不只是一次偶发：`autocrlf=true` 意味着**新签出**的工作区全是 CRLF，
 *    那时旧写法会对**全部**走查脚本报假 ❌。
 *
 * 用法：
 *
 *     node scripts/check-page-helpers.cjs                            # 检查全部（默认）
 *     node scripts/check-page-helpers.cjs --file=m7a-walkthrough.ts  # 只查一个（可重复）
 */
const fs = require('node:fs')
const path = require('node:path')

const SCRIPTS = __dirname
const TICK = String.fromCharCode(96) // 反引号：用字面量拼它，免得本文档自己被它截断
const OPEN = 'const HELPERS = ' + TICK
// 模板的收尾反引号独占一行（允许行首缩进与行尾空白）；`^` 在多行模式下落在 `\n`
// 之后，所以 LF / CRLF 两种行尾都匹配得到 —— 见文档第 5 条。
const CLOSE = new RegExp('^[ \\t]*' + TICK + '[ \\t]*$', 'm')
const MARKER = 'window.__'

const only = process.argv
  .slice(2)
  .filter((a) => a.startsWith('--file='))
  .map((a) => a.slice('--file='.length))

/** 扫 scripts/ 下所有含 HELPERS 的 .ts —— 自维护，新走查不用回来登记。 */
function discover() {
  return fs
    .readdirSync(SCRIPTS)
    .filter((n) => n.endsWith('.ts'))
    .filter((n) => fs.readFileSync(path.join(SCRIPTS, n), 'utf8').includes(OPEN))
    .sort()
}

function check(name) {
  const file = path.join(SCRIPTS, name)
  if (!fs.existsSync(file)) return { name, ok: false, why: '文件不存在：' + file }

  const src = fs.readFileSync(file, 'utf8')
  const lineOf = (i) => src.slice(0, i).split('\n').length

  const start = src.indexOf(OPEN)
  if (start < 0) {
    return { name, ok: false, why: '拿不到 HELPERS 的开头（' + OPEN + '）' }
  }
  const rest = src.slice(start + OPEN.length)
  const close = CLOSE.exec(rest)
  if (close === null) {
    return { name, ok: false, why: '拿不到 HELPERS 的收尾反引号 —— 它要么被截断了，要么格式变了' }
  }
  // close.index 落在反引号那一行的行首（前一个 `\n` 之后），所以正文要削掉那一个换行，
  // 这样同一份 HELPERS 在 LF 与 CRLF 两个工作区里报出来的字数一样。
  const end = start + OPEN.length + close.index
  const body = src.slice(start + OPEN.length, end).replace(/\r?\n$/, '')
  const where = `第 ${lineOf(start) + 1}–${lineOf(end)} 行，${body.length} 字`

  if (!body.includes(MARKER)) {
    return {
      name,
      ok: false,
      why: `抠到的区间（${where}）里没有 ${MARKER} —— 抠错了`,
    }
  }

  try {
    new Function(body)
  } catch (e) {
    return { name, ok: false, why: '页面侧 JS 语法错：' + e.message, where }
  }

  if (body.includes('$' + '{')) {
    return { name, ok: false, why: '页面侧 JS 里有插值 —— 它会被外层模板先求值', where }
  }

  return { name, ok: true, where }
}

const targets = only.length > 0 ? only : discover()

if (targets.length === 0) {
  console.log('❌ 一个含 HELPERS 的 .ts 都没找到 —— 这不对：')
  console.log('   m6a-pipeline-walkthrough.ts 与 m6b-walkthrough.ts 都有一份。')
  console.log('   要么是文件改名了，要么是这段检查的定位逻辑失效了。')
  console.log('   ⚠️ 这里报错而不是打印 ✅ —— 检查器自己失效时静默通过，是它最坏的失效方式。')
  process.exit(1)
}

const failed = []
for (const name of targets) {
  const r = check(name)
  if (r.ok) {
    console.log(`✅ ${name}  页面侧 JS 语法 OK —— ${r.where}`)
  } else {
    console.log(`❌ ${name}  ${r.why}`)
    failed.push(name)
  }
}

if (failed.length > 0) {
  console.log('')
  console.log(`   ${failed.length} / ${targets.length} 个不通过。`)
  console.log('   ⚠️ 真机跑之前先修掉 —— 那一段只在渲染进程里炸，而那时钱已经花了。')
  process.exit(1)
}
