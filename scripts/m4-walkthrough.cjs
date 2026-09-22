/**
 * M4 实机走查 —— 用 **DevTools Protocol** 驱动真实窗口里的真实 DOM。
 *
 * 为什么不是「人点一遍然后描述看到什么」：截图和描述都不可复核。这个脚本点的是
 * 真正的按钮、读的是真正的 DOM 文本，所以「界面上显示的是这句话」这件事可以被
 * 逐字复现，而不是靠谁的印象。
 *
 * ⚠️ 它**不**碰用户的真实数据：跑的是另一个实例，`--user-data-dir` 指向沙箱目录，
 *    于是库与 `workspaces/` 根目录都在沙箱里，删空间也删不到真东西。
 *
 * 跑法：
 *   1. 另开一个终端跑 `npm run dev`（提供 5173 上的渲染层）
 *   2. node scripts/m4-walkthrough.cjs
 */
const SAND = 'C:\\Users\\RedMoon\\AppData\\Local\\Temp\\cc-m4'
const SRC = `${SAND}\\src-proj`
const COPY_TARGET = `${SAND}\\copies\\web-copy`
const CLONE_TARGET = `${SAND}\\clones\\git-clone`
const REMOTE = `${SAND}\\prep\\remote.git`
const PERSONA = `${SAND}\\persona.md`
const ROLE = `${SAND}\\roledesc.md`

const CDP = 'http://localhost:9222'

// ── CDP 最小客户端 ────────────────────────────────────────────
let ws
let seq = 0
const waiting = new Map()

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('5173'))
  if (!page) throw new Error('找不到渲染进程页目标；dev server 起来了吗？')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP 连接失败'))
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (msg.error) reject(new Error(`CDP ${msg.error.message}`))
      else resolve(msg.result)
    }
  }
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.exceptionDetails) {
    throw new Error(`页面内异常：${r.exceptionDetails.exception?.description ?? '未知'}`)
  }
  return r.result.value
}

// ── 页面内的小工具（注入一次）────────────────────────────────
const HELPERS = `
window.__acc = {
  norm: (s) => (s || '').replace(/\\s+/g, ' ').trim(),
  text: () => document.body.innerText,
  main: () => document.querySelector('main')?.innerText ?? '',
  buttons() {
    return [...document.querySelectorAll('button')].map((b) => this.norm(b.textContent))
  },
  btn(t) {
    const n = this.norm(t)
    const all = [...document.querySelectorAll('button')]
    return all.find((b) => this.norm(b.textContent) === n)
        || all.find((b) => this.norm(b.textContent).includes(n))
        || null
  },
  /**
   * 只要**完全相等**的按钮。
   *
   * ⚠️ 判断「对话框还开着吗」必须用它：btn() 的 includes 兜底会让
   * 「添加」匹配到侧边栏那个「+ 添加」，于是对话框早关了条件也永远不成立。
   */
  btnExact(t) {
    const n = this.norm(t)
    return [...document.querySelectorAll('button')].find((b) => this.norm(b.textContent) === n) ?? null
  },
  click(t) {
    const b = this.btn(t)
    if (!b) return { ok: false, error: '找不到按钮：' + t, buttons: this.buttons() }
    if (b.disabled) return { ok: false, error: '按钮是禁用的：' + t }
    const label = this.norm(b.textContent)
    b.click()
    return { ok: true, clicked: label }
  },
  /** 等按钮出现且可用了再点。界面是异步的，早一秒点就是「找不到按钮」。 */
  async clickReady(t, ms = 20000) {
    const end = Date.now() + ms
    for (;;) {
      const b = this.btn(t)
      if (b && !b.disabled) {
        const label = this.norm(b.textContent)
        b.click()
        return { ok: true, clicked: label }
      }
      if (Date.now() > end) {
        return { ok: false, error: '等不到可点的按钮：' + t, buttons: this.buttons() }
      }
      await new Promise((r) => setTimeout(r, 120))
    }
  },
  /** 等字段出现再填。 */
  async typeReady(labelText, value, ms = 20000) {
    const end = Date.now() + ms
    for (;;) {
      const r = this.type(labelText, value)
      if (r.ok) return r
      if (Date.now() > end) return r
      await new Promise((res) => setTimeout(res, 120))
    }
  },
  /**
   * 点某个区块里的「+ 添加」。
   *
   * ★ 项目区和成员区的按钮**文本一模一样**，只有所在区块不同 ——
   *   按文本找会点到项目区那个（于是弹出来的是「添加项目」）。所以按区块找。
   */
  async clickAddIn(section, ms = 20000) {
    const end = Date.now() + ms
    for (;;) {
      const b = [...document.querySelectorAll('aside button')].find(
        (x) =>
          this.norm(x.textContent) === '+ 添加' &&
          this.norm(x.parentElement.textContent).includes(section)
      )
      if (b && !b.disabled) {
        b.click()
        return { ok: true, section }
      }
      if (Date.now() > end) {
        return { ok: false, error: '等不到「' + section + '」区块里的「+ 添加」', buttons: this.buttons() }
      }
      await new Promise((r) => setTimeout(r, 120))
    }
  },
  /**
   * 按 aria-label 点按钮（★ 注意：这段在模板字符串里，注释里不能再出现反引号）。
   *
   * 图标按钮（齿轮）没有文本，btn() 按文本找**必然找不到** ——
   * 空间设置那个入口就只有齿轮符号和 aria-label="工作空间设置"。
   */
  async clickAria(label, ms = 20000) {
    const end = Date.now() + ms
    for (;;) {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.getAttribute('aria-label') === label
      )
      if (b && !b.disabled) {
        b.click()
        return { ok: true, aria: label }
      }
      if (Date.now() > end) {
        return { ok: false, error: '等不到 aria-label=' + label + ' 的按钮', buttons: this.buttons() }
      }
      await new Promise((r) => setTimeout(r, 120))
    }
  },
  /** 有没有对话框开着（Dialog 自己渲染的那层遮罩）。
   *  比「找某个按钮」可靠：按钮会因为包含匹配、禁用态、重名而骗人，遮罩只由 Dialog 自己渲染。 */
  overlayOpen() {
    return document.querySelector('div.fixed.inset-0') !== null
  },
  /** 等条件成立。 */
  async until(expr, ms = 20000) {
    const end = Date.now() + ms
    for (;;) {
      // eslint-disable-next-line no-new-func
      if (new Function('return ' + expr)()) return true
      if (Date.now() > end) return false
      await new Promise((r) => setTimeout(r, 120))
    }
  },
  field(labelText, root) {
    const scope = root ? document.querySelector(root) : document
    const n = this.norm(labelText)
    return [...scope.querySelectorAll('label')].find((l) => {
      const own = l.querySelector(':scope > span')
      return own && this.norm(own.textContent).startsWith(n)
    }) ?? null
  },
  type(labelText, value) {
    const f = this.field(labelText)
    if (!f) return { ok: false, error: '找不到字段：' + labelText }
    const el = f.querySelector('input:not([type=checkbox]):not([type=radio]), textarea')
    if (!el) return { ok: false, error: '字段里没有输入框：' + labelText }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, field: labelText, value: el.value }
  },
  /** 勾/取消成员可见性里某个项目的复选框。 */
  checkProject(name, want) {
    const labels = [...document.querySelectorAll('main li label')]
    const el = labels.find((l) => this.norm(l.textContent).includes(name))
    if (!el) return { ok: false, error: '找不到项目复选框：' + name, seen: labels.map((l) => this.norm(l.textContent)) }
    const input = el.querySelector('input[type=checkbox]')
    if (!input) return { ok: false, error: '那不是一个复选框：' + name }
    if (input.checked === want) return { ok: true, already: true, checked: input.checked }
    input.click()
    return { ok: true, checked: input.checked, was: !input.checked }
  },
  /** 给某个项目打「主项目」标记。 */
  setPrimary(name) {
    const lis = [...document.querySelectorAll('main li')]
    const li = lis.find((l) => this.norm(l.textContent).includes(name) && l.querySelector('input[type=radio]'))
    if (!li) return { ok: false, error: '找不到主项目单选：' + name }
    const radio = li.querySelector('input[type=radio]')
    if (radio.disabled) return { ok: false, error: '这个单选框是禁用的（项目没勾选、或没收窄）' }
    if (radio.checked) return { ok: true, already: true }
    radio.click()
    return { ok: true }
  },
  checkBoxByLabel(text, want) {
    const labels = [...document.querySelectorAll('label')]
    const el = labels.find((l) => this.norm(l.textContent).includes(text))
    if (!el) return { ok: false, error: '找不到复选框：' + text, seen: labels.map((l) => this.norm(l.textContent).slice(0, 40)) }
    const input = el.querySelector('input[type=checkbox]')
    if (!input) return { ok: false, error: '不是复选框：' + text }
    if (input.checked === want) return { ok: true, already: true }
    input.click()
    return { ok: true, checked: input.checked }
  },
  selectIn(selectLabel, optionText) {
    const f = this.field(selectLabel)
    if (!f) return { ok: false, error: '找不到下拉：' + selectLabel }
    const sel = f.querySelector('select')
    if (!sel) return { ok: false, error: '字段里没有 select：' + selectLabel }
    const opt = [...sel.options].find((o) => o.textContent.includes(optionText))
    if (!opt) return { ok: false, error: '没有这个选项：' + optionText, options: [...sel.options].map((o) => o.textContent) }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, selected: opt.textContent }
  },
  mouseClick(t) {
    const n = this.norm(t)
    const el = [...document.querySelectorAll('main button, main [role=button]')].find((b) => this.norm(b.textContent).includes(n))
    if (!el) return { ok: false, error: '找不到可点元素：' + t }
    el.click()
    return { ok: true }
  }
};
'ok'
`

// ── 断言与等待 ───────────────────────────────────────────────
let failures = 0

function head(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`)
}

function show(label, value) {
  console.log(`\n▸ ${label}`)
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  console.log(text.split('\n').map((l) => `  ${l}`).join('\n'))
}

function ok(label, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`)
  }
}

async function waitFor(expr, label, timeout = 12000) {
  const started = Date.now()
  for (;;) {
    if (await evaluate(expr)) return true
    if (Date.now() - started > timeout) {
      const seen = await evaluate('window.__acc.text().slice(0, 400)')
      throw new Error(`等不到「${label}」（${timeout}ms）。当前页面文本前 400 字：\n${seen}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

/**
 * 走查默认一路跑到底（含最后删空间）。设 `M4_STOP_AFTER=<步骤号>` 可以在某一步之后停下。
 *
 * ★ 为什么需要这个开关：副本目录在步骤 8 会被删掉，而「复制出来的那份里到底有什么」
 *   （有 `.git` 吗？`node_modules` 跳过了吗？）只有**在删之前**去盘上看才作数。
 *   所以中间态必须是可复现地停下来的，而不是靠谁记得当时看了一眼。
 */
const STOP_AFTER = Number(process.env.M4_STOP_AFTER ?? 0)

function stopIf(step, what) {
  if (STOP_AFTER !== step) return false
  console.log(`\n⏸  M4_STOP_AFTER=${step} —— 停在这里，去盘上核对：${what}`)
  return true
}

async function act(expr, label) {
  const r = await evaluate(expr)
  if (!r || r.ok !== true) {
    throw new Error(`动作失败（${label}）：${JSON.stringify(r)}`)
  }
  return r
}

// ── 走查 ─────────────────────────────────────────────────────
async function main() {
  await connect()
  await evaluate(HELPERS)
  // 页面刚加载完时首帧可能是空的，等 React 挂上 __acc
  await waitFor('typeof window.__acc === "object"', '页面工具注入')

  // ── 步骤 1：首启空态 ──
  head('步骤 1 · 首启空态（沙箱里是一个全新的库）')
  await waitFor('window.__acc.text().includes("还没有工作空间")', '首启空态')
  show('窗口里实际显示的内容', await evaluate('window.__acc.text()'))

  // ── 步骤 2：建空间 Nova ──
  head('步骤 2 · 新建工作空间「Nova」')
  show('点击', await act('window.__acc.clickReady("新建工作空间")', '打开新建对话框'))
  await waitFor('window.__acc.text().includes("显示名")', '新建对话框')
  show('填写显示名', await act('window.__acc.typeReady("显示名", "Nova")', '填名字'))
  show('点击', await act('window.__acc.clickReady("建出来")', '提交'))
  // ★ 等的必须是**外壳**出现，不是「文本里有『空间目录』」—— 首启空态里
  //   也有一句「空间目录建在应用数据目录下…」，用它当条件会立刻通过、
  //   然后在对话框还开着的时候就去点下一步（第一次跑就是这么栽的）。
  await waitFor('document.querySelector("aside") !== null', '侧边栏渲染出来', 30000)
  // 等条件用「提交按钮不在了」，不要用文本里有没有某个词：通知里那句
  // 「改名只会改**显示名**」里也含「显示名」，拿它当条件会永远等不到。
  await waitFor('window.__acc.overlayOpen() === false', '新建对话框关闭', 30000)
  show('建好之后界面上的通知', await evaluate(`
    (() => { const t = window.__acc.text(); const i = t.indexOf('已建工作空间'); return i<0?'(没找到)':t.slice(i, i+160) })()
  `))

  // ── 步骤 3：界面上报出来的真实路径 ──
  head('步骤 3 · 界面报出的空间目录（渲染侧不可能猜到这个路径）')
  const rootPath = await evaluate(`
    (() => {
      const el = [...document.querySelectorAll('main span')]
        .find((s) => /workspaces/i.test(s.textContent) && s.className.includes('select-all'))
      return el ? window.__acc.norm(el.textContent) : '(没找到)'
    })()
  `)
  show('界面上显示的 rootPath', rootPath)
  ok('rootPath 落在沙箱的 userData 下（证明根目录跟着 userData 走）',
     rootPath.toLowerCase().includes('cc-m4\\userdata\\workspaces'.toLowerCase()), rootPath)
  ok('界面同时显示了「项目落点」与「临时目录」',
     (await evaluate('window.__acc.text()')).includes('项目落点') &&
     (await evaluate('window.__acc.text()')).includes('临时目录'))

  // ── 步骤 4：三种方式各加一个项目 ──
  head('步骤 4 · 三种导入方式各加一个项目')

  // ① 原地引用
  await act('window.__acc.clickReady("+ 添加项目")', '打开添加项目')
  // 判断对话框开没开，看它**自己的**提交按钮 —— 不能用页面里有没有「三种方式」：
  // 概览里那句「建空间、三种方式导入项目、配成员与可见性」也含这三个字，
  // 拿它当条件会在对话框还没渲染出来的时候就通过（第一版就是这么错的）。
  await waitFor('window.__acc.overlayOpen() === true', '添加项目对话框')
  show('对话框里列出的三种方式', await evaluate(`
    [...document.querySelectorAll('button')].map(b=>window.__acc.norm(b.textContent)).filter(t=>/原地引用|复制到别处|git clone/.test(t))
  `))
  await act('window.__acc.typeReady("项目名", "ref-local")', '项目名')
  await act('window.__acc.typeReady("目录", ' + JSON.stringify(SRC) + ')', '目录')
  show('原地引用分支显示的代价', await evaluate(`
    (() => { const t = window.__acc.text(); const i = t.indexOf('agent 会直接改'); return i < 0 ? '(没显示)' : window.__acc.norm(t.slice(i, i + 160)) })()
  `))
  show('点击', await act('window.__acc.clickReady("添加")', '提交原地引用'))
  await waitFor('window.__acc.overlayOpen() === false', '对话框关闭', 30000)

  // ② 复制
  await act('window.__acc.clickReady("+ 添加项目")', '打开添加项目')
  await waitFor('window.__acc.overlayOpen() === true', '添加项目对话框')
  await act('window.__acc.clickReady("复制到别处")', '切到复制分支')
  await act('window.__acc.typeReady("项目名", "web-copy")', '项目名')
  await act('window.__acc.typeReady("源目录", ' + JSON.stringify(SRC) + ')', '源目录')
  await new Promise((r) => setTimeout(r, 800)) // 等默认落点自动填上
  show('复制分支显示的跳过清单', await evaluate(`
    (() => { const t = window.__acc.text(); const i = t.indexOf('会跳过这些'); return i < 0 ? '(没显示)' : window.__acc.norm(t.slice(i, i + 200)) })()
  `))
  await act('window.__acc.typeReady("目标目录", ' + JSON.stringify(COPY_TARGET) + ')', '目标目录')
  show('点击', await act('window.__acc.clickReady("添加")', '提交复制'))
  await waitFor('window.__acc.overlayOpen() === false', '对话框关闭', 60000)

  // ③ git clone（远端是一个本地裸仓库，离线可跑）
  await act('window.__acc.clickReady("+ 添加项目")', '打开添加项目')
  await waitFor('window.__acc.overlayOpen() === true', '添加项目对话框')
  await act('window.__acc.clickReady("git clone")', '切到 clone 分支')
  await act('window.__acc.typeReady("项目名", "git-clone")', '项目名')
  await act('window.__acc.typeReady("远端 URL", ' + JSON.stringify(REMOTE) + ')', '远端 URL')
  await act('window.__acc.typeReady("目标目录", ' + JSON.stringify(CLONE_TARGET) + ')', '目标目录')
  show('点击', await act('window.__acc.clickReady("添加")', '提交 clone'))
  await waitFor('window.__acc.overlayOpen() === false', '对话框关闭', 90000)

  // 停在这里的话，`copies/web-copy` 与 `clones/git-clone` 还在盘上（步骤 8 会删掉它们）。
  if (stopIf(4, '复制出来的副本里有 .git 吗、node_modules 跳过了吗；克隆出来的那份对吗')) {
    console.log(`\n${'═'.repeat(72)}\n（按 M4_STOP_AFTER=${STOP_AFTER} 提前停下，未跑删除步骤）\n${'═'.repeat(72)}`)
    return failures
  }

  // ── 步骤 5：侧边栏的三条来源徽标 ──
  head('步骤 5 · 侧边栏项目列表（来源徽标必须各自正确）')
  await waitFor('window.__acc.text().includes("git-clone")', '第三个项目出现')
  const sidebar = await evaluate('document.querySelector("aside").innerText')
  show('侧边栏实际文本', sidebar)
  // 按**行**比对过一次，很脆：徽标跟名字不在同一行（flex 会把它们拆成多行），
  // 而且有「当前」徽标时行数还会变。所以改成按**按钮**取整行文本 —— 项目行本身就是一个
  // <button>，名字、徽标、路径都在里面。
  const rows = await evaluate(`
    [...document.querySelectorAll('aside button')].map((b) => window.__acc.norm(b.textContent))
  `)
  for (const [name, badge] of [
    ['ref-local', '原地引用'],
    ['web-copy', '复制'],
    ['git-clone', '克隆']
  ]) {
    const row = rows.find((r) => r.includes(name)) ?? '(没有这一行)'
    ok(`${name} 的来源徽标是「${badge}」`, row.includes(badge), `那一行的全文是：${row}`)
  }

  // 克隆那一行**必须**有远端与分支：那是我们唯一一次跟 git 说话的结果，落不上库等于白克隆。
  const openProject = (name) =>
    act(
      `(() => { const b = [...document.querySelectorAll('aside button')].find(b=>window.__acc.norm(b.textContent).includes(${JSON.stringify(name)})); if(!b) return {ok:false,error:'找不到项目行'}; b.click(); return {ok:true} })()`,
      '打开 ' + name + ' 详情'
    )
  await openProject('git-clone')
  await waitFor('window.__acc.main().includes("绝对路径")', 'git-clone 详情')
  const cloneDetail = await evaluate(`
    (() => { const t = window.__acc.main(); const i = t.indexOf('绝对路径'); return i < 0 ? '(没找到)' : window.__acc.norm(t.slice(i, i + 300)) })()
  `)
  show('克隆那个项目的详情（路径 / 远端 / 分支）', cloneDetail)
  ok('clone 的 remoteUrl 落进了库', cloneDetail.includes(REMOTE), cloneDetail)
  ok('clone 的 defaultBranch 落进了库（远端就是 main）', cloneDetail.includes('分支 main'), cloneDetail)

  // 复制那一行**不该**有远端：我们没跟任何远端说过话，猜一个是编造。
  await openProject('web-copy')
  await waitFor('window.__acc.main().includes("绝对路径")', 'web-copy 详情')
  const copyDetail = await evaluate(`
    (() => { const t = window.__acc.main(); const i = t.indexOf('绝对路径'); return i < 0 ? '(没找到)' : window.__acc.norm(t.slice(i, i + 300)) })()
  `)
  show('复制那个项目的详情（路径 / 加入时间，没有远端也没有分支）', copyDetail)
  ok('copy 的 remoteUrl / defaultBranch 留空（不编造）', !copyDetail.includes('远端') && !copyDetail.includes('分支'))

  // ── 步骤 6：建角色 + 成员 ──
  head('步骤 6 · 建一个角色（人设 .md），再加进这个空间当成员')
  await act('window.__acc.clickReady("角色库")', '打开角色库')
  await waitFor('window.__acc.overlayOpen() === true', '角色库对话框')
  await act('window.__acc.clickReady("+ 新建角色")', '展开新建表单')
  await waitFor('window.__acc.text().includes("人设文件")', '新建角色表单')
  await act('window.__acc.typeReady("名字", "Atlas")', '名字')
  await act('window.__acc.typeReady("模型", "claude-sonnet-5")', '模型')
  await act('window.__acc.typeReady("人设文件", ' + JSON.stringify(PERSONA) + ')', '人设文件')
  await act('window.__acc.clickReady("创建")', '创建角色')
  await waitFor('window.__acc.text().includes("指纹")', '角色创建完成')
  show('角色卡片上显示的路径与指纹', await evaluate(`
    (() => { const t = window.__acc.text(); const i = t.indexOf('人设 '); return i < 0 ? '(没找到)' : window.__acc.norm(t.slice(i, i + 90)) })()
  `))
  await act('window.__acc.clickReady("关闭")', '关闭角色库')
  await waitFor('window.__acc.overlayOpen() === false', '角色库关闭')

  await act('window.__acc.clickAddIn("成员")', '打开添加成员')
  await waitFor('window.__acc.overlayOpen() === true', '添加成员对话框')
  await act('window.__acc.typeReady("在这个空间里的显示名", "Atlas")', '显示名')
  await act('window.__acc.typeReady("职责文件（可选）", ' + JSON.stringify(ROLE) + ')', '职责文件')
  await act('window.__acc.clickReady("加入")', '加入成员')
  await waitFor('document.querySelector("aside").innerText.includes("Atlas")', '成员出现在侧边栏', 30000)
  await waitFor('window.__acc.overlayOpen() === false', '添加成员对话框关闭')
  show('侧边栏里这条成员行', await evaluate(`
    document.querySelector("aside").innerText.split("\\n").filter(l=>l.includes("Atlas")).join(" | ")
  `))

  // ── 步骤 7：成员详情 + 可见性 ──
  head('步骤 7 · 成员详情：可见性收窄 + 主项目 + 三条文案纪律')
  await act(`(() => { const b = [...document.querySelectorAll('aside button')].find(b=>window.__acc.norm(b.textContent).startsWith('Atlas')); if(!b) return {ok:false,error:'找不到成员行'}; b.click(); return {ok:true} })()`, '选中成员')
  await waitFor('window.__acc.main().includes("可见项目只用于让角色")', '成员详情')

  const policy = await evaluate(`
    (() => {
      const t = window.__acc.main()
      const i = t.indexOf('可见项目只用于让角色')
      return i < 0 ? '(没找到纪律段)' : t.slice(i)
    })()
  `)
  show('印在界面上的说明（逐字）', policy)
  ok('§8.4：写明「不是安全机制」且有 shell', policy.includes('不是') && policy.includes('shell'))
  ok('§8.9-4：只说「能静态判定的路径是硬的，动态构造的不是」',
     policy.includes('能静态判定的路径是硬的，动态构造的不是'))
  ok('§8.9-4：**没有**把它说成「安全」', !/黑名单[^。]*安全/.test(policy))
  ok('§5.6：写明「将在下一轮生效」', policy.includes('将在下一轮生效'))
  ok('§8.4：写明没有只读模式', policy.includes('没有「只读」这种模式'))

  // ⚠️ 不能直接 indexOf('当前：')：上面「职责文件」那段里也有一句
  //    「当前：<路径>（指纹 …）」而它排在前面，于是永远读到的是它。
  //    要从「可见项目」这个标题往后找。
  show('初始可见性状态', await evaluate(`
    (() => {
      const m = window.__acc.main()
      const j = m.indexOf('当前：', m.indexOf('可见项目'))
      return j < 0 ? '(没找到)' : window.__acc.norm(m.slice(j, j + 40))
    })()
  `))
  show('勾上 ref-local', await act('window.__acc.checkProject("ref-local", true)', '勾选'))
  await waitFor('window.__acc.text().includes("只可见 1 个项目")', '收窄生效')
  show('收窄后的状态行', await evaluate(`
    (() => {
      const m = window.__acc.main()
      const j = m.indexOf('当前：', m.indexOf('可见项目'))
      return j < 0 ? '(没找到)' : window.__acc.norm(m.slice(j, j + 40))
    })()
  `))

  show('把最后一个勾取消掉（应当被拒绝）', await act('window.__acc.checkProject("ref-local", false)', '取消勾选'))
  await waitFor('window.__acc.text().includes("不能把勾全部取消")', '拒绝提示')
  show('界面给出的提示（逐字）', await evaluate(`
    (() => { const t = window.__acc.text(); const i = t.indexOf('不能把勾全部取消'); return i<0?'(没找到)':t.slice(i, i+230) })()
  `))

  await act('window.__acc.checkProject("ref-local", true)', '重新勾上')
  await waitFor('window.__acc.text().includes("只可见 1 个项目")', '恢复收窄')
  show('设为主项目', await act('window.__acc.setPrimary("ref-local")', '选主项目'))
  await waitFor('document.querySelector("aside").innerText.includes("主项目 ref-local")', '主项目标记')
  ok('侧边栏的成员行显示了主项目', true)

  // ── 步骤 8：删空间（★ 验收标准的用户可见面）──
  head('步骤 8 · 删掉这个空间（勾选「同时删除副本」）')
  // ★ 这个入口是一个图标按钮（⚙），按文本找必然找不到 —— 它有 aria-label。
  await act('window.__acc.clickAria("工作空间设置")', '打开空间设置')
  await waitFor('window.__acc.overlayOpen() === true', '空间设置对话框')
  const delUI = await evaluate(`
    (() => { const t = window.__acc.text(); const i = t.indexOf('删除这个工作空间'); return i<0?'(没找到)':t.slice(i) })()
  `)
  show('删除区在动手之前摆出来的话（逐字）', delUI)
  ok('列出了原地引用的目录，并写明「一个字节都不会动」',
     delUI.includes('一个字节都不会动') && delUI.includes(SRC))
  ok('写明空间目录本身永远不会被删', delUI.includes('永远不会被删'))

  show('勾选「同时删除副本」', await act('window.__acc.checkBoxByLabel("同时删除这", true)', '勾选删除副本'))
  await act('window.__acc.clickReady("删除这个工作空间…")', '第一次确认')
  await act('window.__acc.clickReady("确认删除，我知道会发生什么")', '第二次确认')
  await waitFor('window.__acc.text().includes("已删除工作空间")', '删除报告', 30000)
  const report = await evaluate(`
    (() => { const t = window.__acc.text(); const i = t.indexOf('已删除工作空间'); return i<0?'(没找到)':t.slice(i, i+320) })()
  `)
  show('删除之后界面如实报回来的内容（逐字）', report)

  head('步骤 9 · 删完之后窗口里的状态')
  await waitFor('window.__acc.text().includes("还没有工作空间")', '回到首启空态')
  show('窗口回到首启空态', '（侧边栏没了，中间是「还没有工作空间」）')
  ok('删完之后回到首启空态 —— 说明 store 里的空间已被清干净', true)

  console.log(`\n${'═'.repeat(72)}`)
  console.log(failures === 0 ? '走查结束：所有断言通过' : `走查结束：有 ${failures} 条断言没通过`)
  console.log('═'.repeat(72))
  return failures
}

main()
  .then((f) => {
    process.exitCode = f === 0 ? 0 : 1
    try { ws.close() } catch {}
  })
  .catch((err) => {
    console.error('\n走查中断：', err.message)
    process.exitCode = 2
    try { ws.close() } catch {}
  })
