# code-chat 架构与实现走读

> **这份文档是什么。** 权威的设计文档是 `docs/design.md`（一份 §编号的决策日志，
> 记的是「为什么这样定」）。本文是**代码现在长什么样**的地图：每个模块做什么、
> 关键不变量是什么、为什么必须那样写。目标读者是**刚接触这个项目的人**。
>
> **两者的关系**：`design.md` 是法律条文，本文是导览手册。两者冲突时以 `design.md` 为准
> —— 但也请相信本文，因为本文里每一句声称的事实都能在代码里找到，且本文会**明确标出**
> 代码与文档不一致的地方（那些都是有意记录在案的偏离，不是笔误）。
>
> **代码规模**（实测，2026-09-24）：`src/` 103 个文件 / 17196 行；`test/` 27 个文件 /
> 9293 行 / **458 个用例全部通过**（`npm test`，约 8.5 秒）。
>
> **项目状态**：M0–M6b 完成并已入库。下一个里程碑是 M7（`context-builder`：`@` 派发 +
> 历史上下文装配）。里程碑地图见 §12。

---

## 目录

1. [它是什么](#1-它是什么)
2. [五分钟跑起来](#2-五分钟跑起来)
3. [目录结构：三个进程 + 一个共享层](#3-目录结构三个进程--一个共享层)
4. [一条消息的一生（端到端）](#4-一条消息的一生端到端)
5. [数据：SQLite、三条 seq 轴、两条正文轴](#5-数据sqlite三条-seq-轴两条正文轴)
6. [主进程逐模块](#6-主进程逐模块)
7. [共享层 `src/shared/`](#7-共享层-srcshared)
8. [渲染进程](#8-渲染进程)
9. [IPC 契约与三道护栏](#9-ipc-契约与三道护栏)
10. [渲染层的七条规则与「抑制」机制](#10-渲染层的七条规则与抑制机制)
11. [测试与走查](#11-测试与走查)
12. [里程碑地图](#12-里程碑地图)
13. [常见改动怎么做](#13-常见改动怎么做)
14. [已知不做 / 已知有损（诚实清单）](#14-已知不做--已知有损诚实清单)

---

## 1. 它是什么

一个 Electron 桌面应用：**在一个「空间」（workspace）里，让多个有角色设定的 AI（成员）
协作改代码**。每个成员绑定一个 agent（目前只有 Claude Code CLI）、一个模型、
一个职责说明文件、一组可见项目；你在一条**空间级的时间线**上对某个成员说话，
它的回答会**流式**地出现在同一条线里。

几个决定了全部架构形状的前提：

| 前提 | 后果 |
|---|---|
| 界面、注释、commit 全部中文 | 读代码时不要预期英文标识符之外的英文 |
| **零运行时依赖** —— `package.json` 里 `dependencies` 都没有，所有包都在 `devDependencies` | 打包后进 `node_modules` 的东西只有我们自己写的代码；`node:sqlite` 用 Node 内置而不是 `better-sqlite3` |
| `npm test` 跑在**裸 Node 的原生类型剥离**上（`node --test "test/**/*.test.ts"`），没有 vitest / jsdom | `src/shared/**`、`src/main/**`、`test/**`、`scripts/**` 里的相对 import **必须写 `.ts` 扩展名**；**禁止 TS `enum`，禁止构造函数参数属性**（两者都要求生成代码，原生剥离会拒） |
| 权威数据在 SQLite，磁盘上的 `workspace.json` 只是「铭牌」 | 不要试图从文件系统反推状态 |
| 被测的必须是**纯逻辑** | 所有「错了不会报错、只会让界面悄悄不对」的判断都被搬到 `src/shared/live/` 里，用裸 Node 测 |

**今天它不做什么**（完整清单见 §14）：不解析 Markdown、不做语法高亮、不能停止一个
正在跑的轮次、不能 `@` 别的成员、第二轮不记得第一轮。这些都在后面的里程碑里。

---

## 2. 五分钟跑起来

```bash
npm install          # 装 devDependencies（含 electron 本体）
npm run dev          # electron-vite dev，热更新
npm run build        # typecheck(node+web) + electron-vite build
npm test             # 458 个用例，裸 Node，不碰网络不花钱
npm run typecheck    # 两个 tsconfig 各跑一遍 tsc --noEmit
```

跑真实对话需要本机装了 Claude Code CLI，并且**它自己的凭据配置是好的** ——
应用**不动** `ANTHROPIC_*` 环境变量，原样继承（`claude-adapter.ts` 的 spawn 选项里
`env: { ...process.env }`，注释：「复用用户自己的登录态与端点配置」）。
找不到 CLI 时不会静默失败：会有一句能照着修的人话，连同「找过哪些地方」一起给出来
（`cli-locator.ts` 的 `claudeSearchHint()`）。

**会花钱的命令有两个，都带硬闸和零成本替身**：

| 命令 | 干什么 | 花费 |
|---|---|---|
| `npm run probe:m5` | 单轮真 CLI 探针（`--max-budget-usd 0.50`） | **会花钱** |
| `npm run walk:m6a:dry` / `walk:m6b:dry` | 走查的**零成本**版本（假 CLI） | 0 |
| `npm run walk:m6a` / `walk:m6b` | 真机走查，两轮真 CLI | **会花钱** |
| `npm run walk:m6a:replay -- --archive=<dir>` | 拿既有归档**零成本重判** | 0 ⚠️ 漏掉 `--archive` 会花钱，见 §11.2 |

> ★ **纪律：花钱的走查必须先跑 `--dry`。** 这不是客气话 —— M6a 的头两次 `--dry`
> 各抓出一个会让后面所有结论失去意义的缺陷，代价为零。见 `design.md` §8.8e 规则一。

---

## 3. 目录结构：三个进程 + 一个共享层

```
code-chat/
├─ docs/
│  ├─ design.md            ★ 权威决策日志（§编号）
│  └─ architecture.md      本文
├─ src/
│  ├─ main/                ★ 主进程（Node 环境，能碰 electron / node:sqlite / spawn）
│  │  ├─ index.ts          启动顺序的唯一编排者
│  │  ├─ infra/            磁盘、git、空间目录 —— 最底层，不认识业务
│  │  ├─ persist/          SQLite：DDL、迁移、七个 repository
│  │  ├─ adapters/         agent 适配层：spawn CLI、解析 NDJSON、杀进程树
│  │  ├─ domain/           业务规则：调度、执行器、cwd 兜底、diff 合成
│  │  ├─ process/          运行时管道：子进程登记、合批器、装配点
│  │  └─ ipc/              契约的**服务端**：注册表、护栏、47 个 handler
│  ├─ preload/index.ts     渲染进程唯一的对外窗口（两个泛型函数）
│  ├─ renderer/            ★ 渲染进程（浏览器环境，没有 node）
│  │  ├─ index.html        CSP 在这里
│  │  └─ src/
│  │     ├─ main.tsx       React 挂载点
│  │     ├─ App.tsx        三栏外壳 + 三个只读 effect
│  │     ├─ ipc.ts         ★ 全仓唯一的 `window.api` 消费点
│  │     ├─ store/         zustand：entity / ui / live 三个 slice
│  │     ├─ hooks/         usePushNotices.ts（四条推送的唯一订阅处）
│  │     ├─ components/    界面（conversation/ 是对话那一屏）
│  │     └─ styles.css     Tailwind v4 的 `@theme` token + 四个自定义类
│  └─ shared/              ★ 三个进程都 import 的东西
│     ├─ entities.ts       领域枚举与取值（跨进程的**词汇表**）
│     ├─ copy-policy.ts    纯函数
│     ├─ ipc/              契约：通道清单、zod schema、信封、渲染侧门面
│     └─ live/             ★ 渲染层的纯逻辑（帧归约、水位线、时间线排法、diff 分类）
├─ test/                   镜像 src/ 那侧的目录结构（adapter/ domain/ ipc/ persist/ process/ shared/）
└─ scripts/                探针与走查（m5-probe / m6a-walkthrough / m6b-walkthrough / m4 …）
   └─ evidence/            ★ 走查的原始归档，**进版本库**
```

### 3.1 三条边界规则（记住这三条，读代码就不会迷路）

**规则一（唯一一条不可破的架构约束）**：**`src/main/domain/` 不得 import `electron`
或 `node:sqlite`。**（`design.md` §4.1）

这条约束是全项目唯一一条「破了就重构」的规则，它换来的是：`domain/` 里每一行
（调度器、执行器、cwd 兜底、diff 合成）都能在裸 Node 里直接测，不需要起 Electron、
不需要临时数据库。`test/domain/` 里那 1000 多行用例全靠它。

同样的理由解释了 `src/shared/live/` 为什么存在：那些是**渲染层的判断**，
搬到纯逻辑目录里才测得到（渲染层没有测试运行器）。

**规则二：依赖只能向下。**

```
renderer ──→ shared/ipc/contract ←── preload
   │                 ↑
   └──→ shared/live ─┘        （纯逻辑，零 runtime import）
                    main/ipc → main/process → main/domain → main/persist → main/infra → *
```

反例都在代码里被点名过：`src/main/ipc/` 里**只有两个文件** import electron
（`electron-transport.ts` 和 `system-capabilities.ts`），其余全部与 Electron 无关，
所以能测。`handlers/*.ts` 一个 electron 都不碰。

**规则三：越是「错了不报错」的判断，越要往纯逻辑层搬。**

这个项目里最贵的 bug 不是崩溃，是**界面安静地少显示一块**。所以：

- 帧归约、水位线状态机、时间线排法、diff 行分类 → `src/shared/live/`（纯函数，有单测）
- 超长行切分、`thinkingTokens` 取哪个数、`ok` 缺失时算不算成功 → 抽成函数，写清理由

`design.md` §4.6a 是这条纪律的正式表述：**「计算了但没渲染 = 缺陷」**，
反过来同样成立 —— 一个要么会算错、要么会显示假的数字的判断，必须有一个能测的落点。

---

## 4. 一条消息的一生（端到端）

这一节是全文档最该先读的。下面这条链**每一步都在一个具体文件里**，
跟着走一遍，其余模块就都有位置了。

```
① 用户点发送
   Composer.tsx ──api.turn.send({workspaceId, memberId, sessionId, content})──┐
                                                                             │
② 桥                                                                          │
   preload/index.ts 查 INVOKE_CHANNELS 白名单 → ipcRenderer.invoke            │
                                                                             │
③ 服务端入口                                                                  │
   ipc/registry.ts  dispatch(): zod 校验 → 查实现表 → try handler → toEnvelope│
                                                                             │
④ 落库（一个事务两笔写）                                                       │
   ipc/handlers/turn.ts:                                                     │
     message.append(用户消息)  +  turn.create(status='queued', hopDepth=0)     │
   ── 提交之后 ──→ runtime.dispatch(turn) → emit stream:status('queued')      │
                                                                             │
⑤ 排队                                                                        │
   process/runtime.ts dispatch() → 入 Set 队列 → scheduler.enqueue()          │
   domain/scheduler.ts  pump() 同步跑：有槽位就 pickNext()                    │
                                                                             │
⑥ 起跑                                                                        │
   markRunning(turn.id) 返回了行 → emit stream:status('running')              │
   → void run(turn).catch(onRunCrashed).finally(pump)   ← 刻意不 await        │
                                                                             │
⑦ 装配 TurnContext                                                            │
   domain/turn-runner.ts: 读 actor/member/session → resolveTurnCwd（三级兜底）│
   → resolveAddDirs（可见项目） → 组装 messages/model/effort/permissionMode   │
   → batcher.beginTurn() → adapters.get(agentKind).run(ctx, signal)          │
                                                                             │
⑧ spawn CLI                                                                   │
   adapters/claude/claude-adapter.ts:                                        │
     resolveLaunch() → 写 system prompt 临时文件 → buildClaudeArgs()          │
     → spawn(claude.exe, args, {cwd, stdio:['pipe','pipe','pipe']})          │
     → 写首条 user 消息进 stdin → 逐块喂解析器                                 │
   adapters/claude/stream-json-parser.ts: NDJSON 行 → AgentEvent             │
                                                                             │
⑨ 合批                                                                        │
   process/event-batcher.ts:                                                 │
     mergeable 事件（text/thinking delta）累积 + markDirty() 起 33ms 定时器   │
     tool_start / tool_result / usage / done 是**屏障**：立即 flush 一次      │
   ── 到点 ──→ 分配帧 seq → commit()（一个事务：ensureMessage + 写事件行      │
              + setStreamedText + advanceSeq + turn.finish）                 │
   ── 提交之后 ──→ emitFrames() → transport.send('stream:batch', batch)      │
                                                                             │
⑩ 推送（不过桥的默认路径都行，只走白名单四条）                                 │
   ipc/electron-transport.ts: 广播给所有未 destroy 的窗口                     │
                                                                             │
⑪ 渲染层收                                                                     │
   hooks/usePushNotices.ts（★ 全应用唯一订阅处）→ store/live.ts applyBatch    │
   → shared/live/watermark.ts planBatch（三个判断的合流）                     │
   → shared/live/frame-buffer.ts applyFrames（唯一写入口）                    │
   → zustand 通知订阅者 → StreamingText.tsx 重渲染**那一个 `<p>`**            │
                                                                             │
⑫ 终态                                                                        │
   event-batcher.endTurn(): pushDoneRow → commit → 清重状态 → emitFrames(done)│
     → drain 未读 → **最后** emitStatus(终态)                                 │
   渲染层收 stream:status 终态 → ① 先把历史读回来 ② 再丢缓冲 ③ 记 recentlyFinished
```

**这条链上有四个「顺序是硬的」的地方**，每一处错了都不会报错、只会让界面不对：

1. **`enqueue()` 先 emit `queued` 再 `pump()`。** 反过来的话，一个瞬间就起跑的轮次
   会先收到 `running` 再收到 `queued`，而渲染层按状态覆盖 —— 界面显示「排队中」。
2. **`commit()` 一定在 `emitFrames()` 之前。** 先落库后推送：崩溃时丢的是「已推送但没落库」
   的那一点增量（≤33ms），而不是「落库了但没推」这种会永久缺口的形态。
3. **`endTurn` 里 `emitStatus` 排在最后。** 状态是「`turn` 行现在是什么」的宣告，
   它必须在所有与之相关的批次推出去之后才发。
4. **渲染层收到终态时「先把历史读回来，再丢缓冲」。** 见 §10 的折叠一节。

---

## 5. 数据：SQLite、三条 seq、两条正文轴

### 5.1 库

- 位置：`app.getPath('userData')/code-chat.db`（`infra/paths.ts`，**唯一**的磁盘位置事实源）。
  ★ 全部走绝对路径，**绝不用相对路径或 `__dirname`** —— 开发时它们指向仓库，
  打包后指向 `app.asar` 内部（只读、随版本被替换）。
- 驱动：`node:sqlite`（Node 内置，Electron 44 带的 Node 24 里有）。
- 迁移：`persist/migrations/`，目前两个（`0001-init`、`0002-workspace-dir-name`）。
  版本记在库里，`runMigrations` 按序补齐。
- **枚举一致性断言**：`persist/ddl-enums.ts` 在迁移跑完之后、repository 装配之前，
  读 `sqlite_master` 里的真实 DDL，断言它里面的 `CHECK (...)` 取值与 TS 侧的
  闭合联合**逐字一致**。放在 `openStore()` 里而不是 `main/index.ts` 里，
  理由是**测试用的也是这个入口** —— 于是这条断言在每次 `npm test` 里都跑。
  （它读的是「这次真的要用的那份 DDL」，包括用户从旧版本升上来的库。）
- 事务：`store.tx(fn)`，基于 SAVEPOINT，**嵌套安全**。
- 七个 repository：workspace / project / actor / member / session / turn / message。
  上层（domain、ipc handlers）**只**从这里拿数据，不直接碰 `node:sqlite`。

### 5.2 ★ 三条 seq 轴（这张表解释了本项目一半的复杂度）

| 轴 | 作用域 | 落库？ | 谁能当水位线 |
|---|---|---|---|
| **帧 seq**（`StreamFrame.seq`、`Batch.fromSeq/toSeq`） | **每 session**，跨轮次单调 | **不落库** | ✅ **只有它** |
| `message_event.seq` | 每消息，从 1 重来 | 是 | ❌ |
| `message.seq` | **每 workspace** | 是（`UNIQUE (workspace_id, seq)`） | ❌ |

**三条直接后果，每一条都决定了代码的形状：**

1. **帧水位线无法从历史行推导出来。** `message:list` 只带后两条轴。
   所以渲染层必须**自己记**「我收到过什么」（`watermark.ts`），而这份记忆是**每进程**的
   —— 重启就没了。
2. **合并会跳号。** 合批器把相邻的 text delta 合成一帧，**保留首个 seq**，
   于是 `toSeq` 是**计数器高水位**，不等于 `frames[last].seq`。
   渲染层必须容许批内跳号，不能拿 `frames[last].seq` 当水位线。
3. **不许跨轴比较。** 时间线排「失败轮次」格子时，**不能**拿 `message.seq` 与
   `turn.queued_at` 比大小 —— 那是两个不同的轴。做法是把它挂在**触发它的那条消息**后面，
   这样不需要比较任何两个轴（`shared/live/timeline.ts`）。

### 5.3 两条正文轴：`content_text` 与帧

同一轮回答的正文有两个去向：

- **`message.content_text`** —— 每次 flush（~33ms）把「所有 `seq ≤ s.seq` 的帧」折进去的结果，
  落在库里；
- **实时帧** —— 渲染层手上一批批收到的 delta。

`design.md` §2.3 明写要**同源**，它们确实是同一份字节的两个去向。但**渲染层绝不能
「先用历史播种、再追加帧」** —— 因为两者描述的是**不同时刻的同一个流**，
只在刷新边界上相等。混用会安静地重复或缺口，且不报错。

这直接推出 `frame-buffer.ts` 那条贯穿全文件的不变式：

> ★ **缓冲的正文只来自帧，从不来自历史。**
> 所以：**一个轮次要由帧渲染，就必须从它的第一帧开始由帧渲染。**

做不到的时候（新进程打开一个已经在跑的轮次）就**不建缓冲**，让历史行自己显示。
这个选择在 `live` slice 里落成一句话：**有缓冲才抑制历史行**（见 §10）。

---

## 6. 主进程逐模块

### 6.1 `infra/` —— 最底层，不认识业务

| 文件 | 行数 | 干什么 |
|---|---|---|
| `paths.ts` | 51 | 磁盘位置的唯一事实源。`dbPath()`、`workspacesRoot()` |
| `space-dir.ts` | 180 | 空间目录：名字净化、目录结构、`workspace.json` 铭牌 |
| `fs-ops.ts` | 276 | 文件操作（copy / clone / hash / 删除副本并如实报告） |
| `git.ts` | 212 | 定位 git、`gitSearchHint()` |

**`paths.ts`**：`userData/workspaces/` 是空间根。为什么不放 `Documents`？
注释里写了权衡：`<空间>/projects/` 里装的是**真实的代码**，而 `Documents` 下多一棵树
会混进用户自己的文档管理（同步盘、备份工具、搜索索引）。代价也写清了：
这个位置在资源管理器里默认不可见，**所以 UI 必须显示真实路径并提供「打开」**。
⚠️ 这一条是**可移植性决定，不是安全决定** —— agent 有 shell，能读到 userData，
我们不假装能解决它。

`paths.ts` 还记了一处**删除**：M6a 删掉了 `blobsRoot()`，因为 §8.9-9 收口成
`<空间>/blobs/` 之后正确答案是 `spacePaths(...).blobs`。「两个都留着必然会有人用错
那个零调用方的，而用错的表现是『文件写在 A、清理扫的是 B』—— 一个只会让磁盘慢慢变脏
的沉默错误。」

**`space-dir.ts`**：`SPACE_SUBDIRS = ['memory','index','blobs','logs','scratch','projects']`，
**顺序即创建顺序**。`scratch/` 是无主项目的角色的默认 cwd（三级兜底的第三级），
`projects/` 是 clone/copy 的默认落点。
`buildManifest()` **只写铭牌**，铭牌里逐字写着：

> 权威数据在 SQLite (userData/code-chat.db)，本文件只是给人看的铭牌，不含项目列表与
> 成员可见性（那些会变，镜像在这里迟早过期）。删掉本文件不影响使用。

`sanitizeDirName` / `pickDirName` 是纯函数（不 import electron），所以测得到 ——
目录名净化那段尤其需要。

### 6.2 `persist/` —— SQLite 的一切

```
db.ts (119)          openDatabase / withTransaction / isSqliteError / SQLITE_CONSTRAINT_*
ddl-enums.ts (129)   断言 DDL 的 CHECK 取值与 TS 闭合联合逐字一致
row.ts (103)         行 → 对象的取列助手（json()、str()、num()…）
index.ts (83)        openStore()：迁移 → 断言 → 装配 repository
migrations/0001-init.ts (210)、0002-workspace-dir-name.ts (39)
repositories/workspace-repo.ts (124) project-repo.ts (139) actor-repo.ts (148)
             member-repo.ts (252) session-repo.ts (106) turn-repo.ts (269)
             message-repo.ts (346)
```

**`turn-repo.ts` 里两个值得单独讲的点：**

**① `markRunning(id, now)` 刻意不收 pid。** M2 的版本收 pid，而那是**不可能满足**的：
pid 只在 spawn 之后才存在，而 `markRunning` 是「开始跑」那一刻的状态切换。
所以 pid 走另一个方法 `setPid()`，中间那个 `status='running' AND pid IS NULL` 的状态
**是合法的**。

**② `reapOrphans` 与 `workspace:usage` 的聚合。** 启动清扫把孤儿行翻成失败，
文案是逐行区分的：

```sql
CASE status WHEN 'running' THEN '应用上次退出时该轮次仍在运行，没有自动恢复'
            ELSE '应用上次退出时该轮次还没排上队执行，没有自动恢复' END
```

用量聚合（成本常驻显示的**唯一**数据源）：

```sql
SELECT COUNT(*)              AS turn_count,
       SUM(cost_usd)         AS cost_usd,
       SUM(tokens_in)        AS tokens_in,
       SUM(tokens_out)       AS tokens_out,
       SUM(cost_usd IS NULL) AS turns_without_usage
  FROM turn WHERE workspace_id = ?
```

★ 三个 `?? 0` 是**刻意的**：空空间时 `SUM` over 零行返回 `NULL` 而不是 0。
★ 第五个字段 `turnsWithoutUsage` 是这条查询存在的**理由的一半**：
`SUM` 会安静地跳过 `NULL` 的行（失败 / 被中断 / 进程被杀的那些），
于是成本与 token 两个数都**偏低**而用户无从知道。按 §4.6a 规则二
（「上报 0 不许覆盖实测量」的反面：**空缺不许冒充成 0**），界面必须在它非零时
如实附一句「另有 N 轮无用量数据」。**不留这个字段，这个数字就是在说谎。**

### 6.3 `adapters/` —— agent 适配层

这一层的定位：**「把一件事交给一个 agent 去做，会发生什么」**，
而且答案必须对不同种类的 agent 都成立。

```
agent-adapter.ts (219)           ★ 锁定的接口（§8.5c），谁都不许随便改
registry.ts (87)                 AgentKind → 适配器实例的穷尽映射
claude/claude-adapter.ts (465)   spawn 那 237MB 的 claude.exe，翻译事件，杀干净进程树
claude/cli-locator.ts (230)      找到真正的 claude.exe（只查文件，不执行）
claude/control-protocol.ts (118) 往 CLI 的 stdin 说话的那一小套协议
claude/project-context.ts (136)  收集项目记忆（CLAUDE.md 等）
claude/stream-json-parser.ts (616) NDJSON → AgentEvent（**有状态**，不是纯函数）
```

#### 6.3.1 `agent-adapter.ts`：三条所有权裁定

文件头定了三件事，每一件都是「两个地方都能做，必须选一个」：

1. **`AgentEvent` 与线上帧 `StreamFrame` 是「超集 + 映射」，不是同一个东西。**
   帧是**派生层**：它带 `seq`（由合批器分配），适配层**不许**有 `seq`
   —— 否则就有两个地方在分配同一个序号。
   （差集：`status_changed` 帧上没有对应物；`text_delta` 多带 `block`；`tool_result` 多带 `structured`。）
2. **`TurnContext` 的所有者是本文件**，不是 `domain/context-builder.ts`，
   且**必须带结构化的 `messages[]`，绝不能是一个预先序列化好的 NDJSON blob**
   —— §4.6：历史必须逐条传递，因为 prefix 缓存以消息为界。
3. **取消意图只能有一个所有者：`signal`。** `interrupt(handle)` 只是它的命令式外壳
   （查表拿到同一个 `AbortSignal` 再 abort）。中断阶梯因此**只有一份实现**，
   在 `child-registry.ts` 里。

两条实现纪律写在文件头，且**每一轮都有人踩**：

- **禁止 TS `enum`，也禁止构造函数参数属性。** `test/**` 与 `src/main/**` 由裸 Node 的
  原生类型剥离直接跑，两者都要求生成代码。TypeScript 会把它们报成编译错误。
- `noUnusedLocals` / `noUnusedParameters` 都是 `true`。实现里的下划线形参（`_signal`）
  **是刻意的**，不是笔误。

`AgentEvent` 有 **10 个变体**：`session_started` / `status_changed` / `thinking_delta` /
`thinking_end` / `text_delta` / `tool_start` / `tool_result` / `usage` / `error` / `done`。
「一个轮次是一串 `AgentEvent`，且**恰好以一次 `done` 收尾**。」

★ **「恰好一次 `done`」是适配器的义务，不是解析器的。** 中断阶梯的第 2/3 级是硬杀，
杀完**没有任何 `result` 行**，也就没有 `done` 可解析。于是「用户点了停止」这条
最常见的非正常结束路径上，轮次会永远等不到终态，并发槽位永远不释放。
所以 `claude-adapter` 必须在 `close` / `error` / `exit` 上**自己合成**那个 `done`。

`AgentDiagnostic`（`level` / `tag` / `message` / `sample?`）**刻意不是 `AgentEvent`，
更不是 `error` 事件**：

> **诊断与错误是两回事：错误说「这轮没成」，诊断说「我看到了一点不对劲」。**
> 如果非 JSON 行走 `error`，UI 就会为一行 `[claude-code:unrecognized_model] {…}`
> 弹一个「出错了」。

#### 6.3.2 `registry.ts`：`codex` 为什么在表里是 `null`

```ts
const table: Record<AgentKind, AgentAdapter | null> = {
  claude,
  // codex 在 AGENT_KINDS 与 DDL 的 CHECK 里都存在，但**没有任何实现**。
  // 写在这里而不是删掉，正是为了让上面那句「穷尽」成立。
  codex: null
}
```

两点刻意的设计：

1. **没有实现的 kind 返回 `null`，不抛。** 这不是异常，是阶段性的已知缺口，
   调用方拿 `null` 去组织人话（「codex 还没接，现在只有 claude」）。
   照 `locateGit()` / `resolveClaude()` 的形状：**预期中的处境用返回值表达，不用异常**。
2. **`Record<AgentKind, …>` 是穷尽的，这是本文件最值钱的一行类型。**
   往 `AGENT_KINDS` 里加第三个 kind 时，这张表会**编译不过**
   —— 于是「新加了 kind 但忘了适配器」不可能变成一个运行时才发现的 `null`。

#### 6.3.3 `claude-adapter.ts`：`run()` 的控制流

最容易读错的是「它其实是个异步生成器 + 一个队列 + 一个唤醒泵」。
子进程推事件与生成器 yield 两者节奏完全不同，所以中间隔了一个队列。

关键步骤：

1. **`resolveLaunch()`**：优先 `opts.resolve` → `opts.launch` → `resolveClaude()`。
2. **找不到 CLI** → yield 一条 `error`（`code: 'cli_not_found'`）+ `done reason='crashed'`。
   理由：「本机没装 CLI」是可预期的处境，不是异常 —— 所以是一句**能照着修的人话**，
   而「找过哪里」必须一起给。
3. **写 system prompt 到临时文件**（`mkdtemp` + `system-prompt.md`），
   `finally` 里删掉。★ 这个文件的生命周期**归本函数所有** —— 不认领就会在 `%TEMP%` 里堆积。
4. **spawn 选项**：`cwd: ctx.cwd`、`windowsHide: true`（否则闪一个黑框）、
   `stdio: ['pipe','pipe','pipe']`、`env: { ...process.env }`。
   ★ **绝不 `shell: true`**：提示词会暴露给 shell 注入，且 `.cmd` 垫片会抛 `EINVAL`。
5. **登记 + 挂 abort**，并补一次 `if (signal.aborted) requestKill()`
   —— 竞态：监听器挂上之前就已经 abort 了，漏掉它这一轮就永远不会走阶梯。
6. **泵循环里 await 阶梯**（不是 fire-and-forget）：这样 `run()` **不可能在杀树还没落定
   的时候就返回**，也就不需要在 `finally` 里追一个悬着的 Promise
   （那种写法有个更隐蔽的坏处：杀树的失败会变成 unhandled rejection，而它恰恰最需要被看见）。
7. **终态兜底**：`if (!sawDone)` → ENOENT 时 `invalidateClaudeCache()`（CLI 会自更新，
   路径可能刚换过）；非零退出码时把 stderr 最后 4 条非空行拼进 `nonzero_exit` 的 message；
   最后 `yield { k: 'done', reason: synthesizedReason(exitCode, aborted) }`。

`synthesizedReason` 里那句注释值得逐字引：

> 进程自己退出且退出码为 0，但一行 `result` 都没吐 —— 只能如实说「它正常地结束了，
> 但我们没读到结局」。这比编一个 subtype 诚实。

**★ `closeStdinOnResult`（默认 `true`）是被实测逼出来的。** 记录在案的事实：
`--input-format stream-json` 让 stdin 成为一条**持续**的输入通道，于是 `-p` 那一轮
做完之后进程**不会退出** —— 它还在等下一条 user 消息。M5 探针归档里，
模型只干了 8.5 秒（终态行自报 `duration_ms: 8525`），而进程**活到了 187 秒**
才被中断阶梯收走，中间 171 秒什么也没做。
为什么不在写完提示词时就关？因为中断阶梯的第 1 级正是往 stdin 写
`control_request/interrupt` —— 提示词一写完就关，等于把唯一的优雅中断通道焊死。
**在终态到达时关**才两边都对。

**`buildClaudeArgs()` 是契约，不是实现细节** —— 测试直接比对这份数组：

```
-p
--input-format stream-json          # 中断能力的必要条件：只有开着它 stdin 才可插话
--output-format stream-json
--verbose
--include-partial-messages          # 增量事件（但它会带来双份投递，见解析器）
--append-system-prompt-file <file>  # 用 file 版绕开 Windows 命令行长度限制
--exclude-dynamic-system-prompt-sections  # 保住前缀稳定 —— 缓存命中率靠它
--model <ctx.model>
--effort <ctx.effort>
--permission-mode <ctx.permissionMode>
--no-session-persistence            # 应用是唯一事实源：不许 CLI 自己留会话文件
--max-budget-usd <ctx.maxBudgetUsd> # 单轮成本硬闸
--add-dir <每个可见项目>
```

**可测性：`CliLaunch` 注入。** 构造参数收一个 `{ exe, preambleArgs }`，测试于是可以传
`{ exe: process.execPath, preambleArgs: [假 CLI 脚本] }` —— **真 spawn、真 stdio、
真解析、真中断阶梯**，只把那个 237MB 的二进制换成一个一百多行的 Node 脚本。
否则这一层几乎没法测：真 CLI 要花钱、要联网、还没法假装「不回 ACK」或「忽略 SIGTERM」
这种专门要测的坏行为。

还有一个 `resolve?: () => Promise<CliLaunch | null>` 注入点，理由写在注释里：

> 只给一个 `launch?: CliLaunch` 的话，「没有 launch」就等于「去问本机」——
> 而一台**真的装了** CLI 的机器上，那条用例会**真的 spawn 一个真的 claude.exe**：
> 真凭据、真端点、真花钱，而且表现成「一个跑了三分钟的测试」。
> 这不是假想的风险，我自己写的第一个版本就踩了。

#### 6.3.4 `cli-locator.ts`：为什么不能照 §4.4 字面实现

`design.md` §4.4 写的解析顺序是「用户设置覆盖 → `npm prefix -g` 下的
`…/bin/claude.exe` → `where claude`」。**顺序保留，机制必须换掉** —— 本机实测：

```
where claude  →  D:\nodejs\node_global\claude        ← 无扩展名的 bash 垫片
                 D:\nodejs\node_global\claude.cmd    ← .cmd 垫片
where npm     →  D:\nodejs\npm  /  D:\nodejs\npm.cmd  ← 压根没有 npm.exe
```

**`claude.exe` 根本不在 PATH 上。** 真身在
`D:\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
（237,100,192 字节），同目录还躺着一个自更新残留 `claude.exe.old.<时间戳>`。

于是：不能 spawn `npm`（`npm.exe` 不存在 → ENOENT；`npm.cmd` 无 shell spawn → EINVAL）；
`where claude` 的两条结果恰好都是必须拒绝的垫片。

**实际机制：拿垫片的位置去反推真身。** npm 全局包的 Windows 布局是固定的：
`<prefix>/claude.cmd` 是垫片，真身在 `<prefix>/node_modules/<包名>/bin/claude.exe`。
而 `where claude` 给的 `.cmd` **就在那个 prefix 里** —— 所以它的目录名就是我们要的 prefix，
**不需要问 npm、不需要 spawn 任何东西**。本机的 prefix 是 `node_global`（不在 node 目录下），
猜是猜不出来的。

三条自律：**只查文件不执行**（存在性与大小足够）、**只认文件名精确等于 `claude.exe`**
（`.old.<ts>` 残留必须排除，否则自更新之后可能一直启动旧版本且毫无征兆）、
**找不到返回 `null`**（由调用方给出人话）。

缓存：模块级 `cached` + `cachedOnce`。与 `locateGit()` **刻意不同** —— git 那边不缓存
（一次 `--version` 只要几十毫秒，换「刚装完 git 却要重启应用」不划算）；
CLI 这边必须缓存，它是 237MB 的原生二进制，而每轮都要 spawn 一次，
每次解析都要走一遍 `where.exe`。代价是路径会在 CLI 自更新后变旧，
所以配 `invalidateClaudeCache()`，在 spawn 报 ENOENT 时调用。
★ 它**缓存的是 `null` 也可以** —— 「找不到」也是要缓存的结果。

#### 6.3.5 `stream-json-parser.ts`：NDJSON → AgentEvent

**它是有状态的，不是纯函数**（要跨行记住内容块类型、是否见过增量、是否已收终态）。

CLI 行类型 → 事件：

| CLI 行 | 我们发什么 |
|---|---|
| `system:init` | `session_started` |
| `system:status` | `status_changed`（帧上没有对应物，合批器丢弃） |
| `system:thinking_tokens` | **不发事件、也不报警**，只累加估算 |
| `system:permission_denied` | 一条 `warn` 诊断（**不是错误**：这一轮照样完成了） |
| `system:compact_boundary` | 只 `observations.sawCompactBoundary = true` + 诊断 |
| `stream_event:content_block_delta` | `text_delta` / `thinking_delta` |
| `stream_event:content_block_stop` | 仅当块类型是 `thinking` → `thinking_end` |
| `assistant` 里的 `tool_use` | `tool_start`（按 id 去重） |
| `user` 里的 `tool_result` | `tool_result` |
| `result`（终态行） | `usage` + 可能的 `error` + **`done`** |
| `control_response` | **不发、不报**（ACK ≠ 完成） |
| 不认识的类型 | `warn` 诊断 `unknown-line-type` |

**★ `--include-partial-messages` 的「谁说了算」裁定**（文件头有完整论证）：
§2.3-2 当年把去重判给了**渲染层** —— 那句话写在适配层存在之前。现在解析器就站在
渲染层前面，两边都做 = 双重抑制，都不做 = 文字重复。**裁定给解析器**（离源头最近）：

- **文本 / 思考：增量说了算。** 完整 `assistant` 块里的 `text`/`thinking` **不重复发**。
- **`tool_start`：完整块说了算。** 因为 `input_json_delta` 给的是**半截 JSON**，
  逐片拼起来再解析等于自己写一个流式 JSON 解析器 —— 不做。
- **兜底**：万一没开那个旗标（没有任何 `content_block_delta`），增量就没内容可发，
  于是**整轮静默**。所以记一个 `sawAnyDelta`，完整块到达时若从未见过增量，
  才由完整块补发一次。

**★ `synthetic-assistant`：一个实测到的、会污染归因的形态。**

```json
{"type":"assistant","message":{"model":"<synthetic>", …,
  "content":[{"type":"text","text":"Prompt is too long"}]},
 "error":"invalid_request","is_api_error_message":true}
```

`model` 是字面量 `"<synthetic>"` —— 没有哪个真模型叫这个名字。**这不是模型说的话，
是 CLI 把它自己的报错包装成了一条 assistant 消息。** 解析器的兜底分支（整轮没见过增量时
由完整块补发文本）会把它发成一条 `text_delta` —— 今天它只活在内存里所以无害；
**M6a 一落库，它就会变成一条 `text` 事件：用户看到的是模型「开口」说了句 CLI 的报错。**

两个判据都认（`model === '<synthetic>'` 是身份，`is_api_error_message === true` 是自述），
任一成立就不当模型的话。命中时不发任何事件，只记一条 `warn` 诊断。
**正文不丢弃** —— 它交回给失败路径（终态行的 `result` 里通常是同一句话），
由 `onResult` 落成 `error` 事件。

**★ `thinkingTokens` 的取法也是实测逼出来的。** 这个端点上
`output_tokens_details.thinking_tokens` 报的是 **0**，而那一轮明明有 374 段思考，
真正的数字只在 `system:thinking_tokens` 里。规则是
「上报值 > 0 才用它，否则用流里的累计估算」：

> 拿 0 覆盖掉一个实测量，正是 §4.6「计算了但没渲染 = 缺陷」的镜像：
> **这里是「渲染了一个假的 0」。** 两个都是估算，但 0 的含义是「没上报」，不是「没思考」。

**超长行**：`MAX_LINE_CHARS = 8MB`（「一个没有上限的行缓冲 = 一个可以吃光内存的入口」）。
超限时记一条 `line-too-long` 诊断并丢弃到下一个换行。
`flush()` 处理「最后一行没有换行符」—— 不 flush 就会丢掉终态 `result`，那是最要紧的一行。

**`reasonFromResult` 是全文件唯一一处「猜」**，而且是刻意的：
CLI 到底用哪些 subtype 报「超预算」和「被中断」，**尚无实测**。
★ **subtype 认不出来时落 `complete` 而不是 `crashed`**：
`is_error` 是 CLI **自己**对成败的明确表态，比我们对 subtype 名字的熟悉程度可靠得多。
一刀切成 `crashed` 的代价是：CLI 下一个版本新增任何一个成功的 subtype，
所有正常轮次都会被报成崩溃。**「我不认识这个词」不等于「它失败了」。**

#### 6.3.6 `control-protocol.ts`：stdin 上说什么

三种写入：user 消息行、中断请求行、`writeLine()`。
**一个必须记住的协议事实：ACK ≠ 完成。** `control_response` 只表示 CLI **收到了**
中断请求，不表示工作已经结束 —— 它可能正停在一个跑了一半的 `Edit` 上。
要等的是**终态 `result` 事件**。所以 `control_response` 只做一件事：
让「CLI 至少听见了」这件事可被观测。中断阶梯的推进完全靠 `child-registry` 的等待与超时。

`writeLine` **写失败一律吞掉**：stdin 会在进程退出时先一步关闭（EPIPE），
而那恰好是中断路径上的常态 —— 一个已经死掉的 CLI 收不到我们的中断请求，
这不需要报警。

**一处明知故犯，留档在此**：`TurnContext.messages` 是**真正的消息数组**，
但当前往 stdin 只写**一条** user 消息，由 `renderTurnInput()` 把数组拍平成文本
（多轮时按角色加标记，否则模型分不清哪句是它自己说的）——
因为「CLI 的 stream-json 输入是否接受多条消息（含 assistant 角色的历史）」**尚未实测**，
而真正的历史装配是 M7 的活。注释里逐字写着：

> 也就是说：**这一处是暂时违反 §4.6 的，不是满足它。** 记进待办，
> 别让它安静地变成 M7 的既成事实。

`readControlResponse()` **在仓库里没有任何调用者**（只有定义与解析器里的忽略分支）。
它借一处易错点留了个教训：**`request_id` 在 `response` 里面，不在顶层。**
「我第一版读的是顶层，于是永远拿到空串 —— 一个『看起来在工作、其实永远读不到东西』的
解析函数。靠探针归档里那一行原文才发现。」

#### 6.3.7 `project-context.ts`：⚠️ **没有任何生产代码调用它**

这是本文档必须点明的一处：`collectProjectContext` / `projectContextSources`
在**生产装配路径上零调用**，只有测试与文档在用它。

唯一明确表态的地方是 `domain/turn-runner.ts` 的注释：

> 另外本函数**不调 `collectProjectContext`**（§8.5c 把它放在首条 user 消息里，
> 属于上下文装配 = M7）—— 但 agent 并非全盲：**cwd 里的 `CLAUDE.md` 由 CLI 自己
> 自动注入**（M5 实测），而 `--add-dir` 目录里的那份不会。M6a 只如实记录这条不对称，
> 去重规则是 M7 的。

它自己的四条纪律值得先记下来（M7 会用）：

- **`~/.claude/CLAUDE.md` 不扫。** 那是用户**全局**的记忆，不属于任何项目；
  把它当项目上下文注入，等于每个项目都悄悄带上用户的私人配置。
- **顺序是确定的**（排序 + 固定扫描表顺序）。这不是审美：注入内容会影响提示词前缀，
  而前缀一变，**缓存就整段失配**。同一棵树两次扫描必须给出同一个顺序。
- **单文件失败一律跳过并记档，不抛。** `.claude/rules/*.md` 完全可能匹配到一个
  名字里带 `.md` 的**目录**，那是 `EISDIR`；而「项目记忆没被读到」是一个**可见**的状态，
  静默跳过就把它变回安静的失效。
- **不写任何「去重」逻辑。** `--add-dir` 带进的 CLAUDE.md 与我们显式注入的是不是重复，
  要用两个可区分的标记字符串**实测一次**才能判定，**结论出来前不许写去重**。

每个文件截断上限 16KB，**按字节切、不按字符切**（否则多字节字符会被切一半）。

### 6.4 `domain/` —— 业务规则（不认识 electron / sqlite）

```
scheduler.ts (309)    队列、并发槽位、启动清扫
turn-runner.ts (377)  跑一轮：装配上下文 → 驱动适配器 → 喂合批器 → 收尾
turn-cwd.ts (104)     cwd 三级兜底（纯函数）
tool-diff.ts (164)    file_diff 的合成器（format 的所有者）
```

#### 6.4.1 `scheduler.ts`

`DEFAULT_CONCURRENCY = 3`。三件结构上的事：

**① 队列在内存里，`queued` 状态在库里 —— 这个分裂是刻意的。**

队列是一个 `Set<string>`（插入顺序 = FIFO），而 `turn.status='queued'` 是持久化的。
两者不同步的部分就是「应用重启后没有自动恢复」这条行为的**结构性保证**：
重启后库里有一堆 `queued` 行，而内存队列是空的。`sweepStartup()` 会把它们翻成失败，
文案见 §6.2。

**② `pump()` 是同步的**（没有 `setTimeout` 轮询）。

**③ `dispatch()` 先 `markRunning`，只有它返回了行才 emit `stream:status running`。**
并且 `run()` 的 Promise **刻意不 await**：

```ts
void run(turn).catch(onRunCrashed).finally(() => pump())
```

不 await 才可能并发跑三个；`.finally(pump)` 保证槽位一释放就补下一个。

**`enqueue()` 先 emit `queued` 再 `pump()`** —— 顺序是硬的（见 §4）。

**`sweepStartup()` 先数后清**，`{ reapedRunning, reapedQueued }` 分开报。
★ 这里有一处与计划**有意不同**并记录在案的：`queued` 与 `running` **都**翻成
`failed`，而不是只处理 `running`。

#### 6.4.2 `turn-runner.ts`：表驱动的一处

文件头有一张 `TurnContext` 填充表，说明每个字段从哪来：

| 字段 | 来源 |
|---|---|
| `cwd` | 三级兜底（`turn-cwd.ts`） |
| `addDirs` | `member_project` 的可见性 → `resolveAddDirs` |
| `messages` | ★ **只有这一轮的 user 消息**（没有历史装配 —— 那是 M7 的 `context-builder`） |
| `systemPrompt` | ★ **空字符串** |
| `model` / `effort` | `actor` |
| `permissionMode` | `member.permissionJson.mode ?? 'bypassPermissions'` |
| `maxBudgetUsd` | 常量 `DEFAULT_MAX_BUDGET_USD = 0.5` |

★ **明写的代价：M6a 里同一会话的第二轮「不记得」第一轮。** 这是当前最重要的
功能缺口，M7 补。

三条实现细节：

- **`fail(code, message)` = 一条 `error` 事件 + 一次终态写。** 只有这一个出口。
- **`beginTurn` 必须先于任何 `push`。**
- **pid 是懒写的**：第一个事件到来时通过 `opts.pidOf(turn.id)` 拿到再落库
  （与 `markRunning` 不收 pid 呼应）。

唯一一处终态映射表（`terminalOf`）：

| `TerminalReason` | `status` |
|---|---|
| `complete` | `done` |
| `interrupted` | `interrupted` |
| `budget` | **`failed`** |
| `crashed` / `null` | `failed` |

注意 `TerminalReason` **刻意只有四个值**：`failed` 不在这里 ——
失败是通过「先发一个 `error` 事件、再发 `done`」表达的。

#### 6.4.3 `turn-cwd.ts`：三级兜底

```
member 在该空间的 is_primary 项目  →  该项目的 root_path
  ↓ 无
workspace.active_project_id        →  该项目的 root_path   ← 空间「最近使用」，仅作兜底
  ↓ 无
<space>/scratch/                   →  无主项目的角色（总览 / 客服）的落点
```

`CwdDecision.source`（`'member-primary' | 'workspace-active' | 'scratch'`）
「**要记进诊断与日志** —— 用户问『它到底在哪个目录里跑的』时，这是答案。」

三条论证：

- **粒度必须是成员而不是空间。** 用户故事 1（前后端各配一个专注角色）与故事 2
  （总览角色）**同时成立**时，任何空间级的单一 cwd 都必然错一半。
- **它不碰盘，这是刻意的。** 「这个 `root_path` 在盘上还在不在」不是 cwd 解析能回答的
  问题：那是项目生命周期的事。真不在了，CLI 会以 ENOENT 起不来，而那条失败会如实
  落进 `turn.error_text` 与一条 `error` 事件 —— 一个**说得清**的失败。
  在这里加一次 `existsSync` 只会把同一个事实变成两个所有者，
  而它会随盘上状态在两次调用之间变化（TOCTOU）。
- **第三级为什么必须有。** 总览 / 客服这类角色**没有主项目**，而 `turn.cwd` 是
  `NOT NULL` 的。少这一级，它们连一轮都发不出去。

一处不静默降级：主项目指向的项目行找不到（被删了）时**不静默降级到 scratch**，
而是落回下一级 —— 「降级会让 agent 在一个空目录里跑，而用户以为它在自己的项目里。
一个安静的错位置。」

`resolveAddDirs(projects, visibleProjectIds, cwd)`：§8.4 的**可见性**落到 `--add-dir` 上，
**所有可见项目**一律挂入。语义：没有任何 `member_project` 行 → 可见**全部**；
有行 → **只**可见这些。返回顺序稳定，且**排除 cwd 自己**。

> ⚠️ 它是**上下文裁剪，不是安全边界**（§8.4）。UI 上不得宣传为权限控制
> —— agent 有 shell，`--add-dir` 之外的东西它一样读得到。

#### 6.4.4 `tool-diff.ts`：`file_diff` 的生产者（格式的所有者）

**为什么必须存在**：CLI 输出行的映射表里**没有任何一行产出 `file_diff`**。
适配层拿到的只有 `Edit` / `Write` 的 `tool_use.input` 里那两个字符串。
不写这段合成，`file_diff` 就会一直是「契约里有、永远收不到」的那个状态 ——
**而那种缺失不会报错，只会让界面安静地少一块。**

**它刻意不读文件**（最诱人的做法是拿到 `file_path` 就去盘上读原文，算准确行号）：

1. 我们拿到的时刻是 `tool_use`，而**工具真的执行发生在之后** ——
   读到的文件是「改动前」还是「改动后」取决于时序，我们无从知道。
   编出来的行号会把「我猜的位置」伪装成「它的位置」。
2. Agent 在跑，它自己也在改这些文件。任何一次读都是 TOCTOU。
3. `Edit` 的输入里**已经有**原文与新文，读文件不会多出任何信息，
   只会多出一份可能与输入不一致的第二事实源。

**patch 格式**（这就是 `file_diff.patch` 的全部语法）：

```
-原文的一行
+新文的一行
# 以 # 开头的是我们自己的注释
```

- 内容行首字符永远是 `-` 或 `+`，所以 `#` 注释行不可能与内容混淆
  （哪怕原文本身有一行是 `# 注释`，它也会长成 `-# 注释`）。
- **没有 `@@`、没有行号、没有上下文行。** 「位置是未知的」这件事被如实表达，
  而不是被一个数字盖住。
- **它不是合法的 unified diff，也不假装是。**

三种注释行的存在理由：

- `Write` 的首行 `# 整文件写入：覆盖前的原文未知（未读取文件）`
  —— 编一整份「删除」出来的话，界面会显示一个我们从未见过的原文。
- `Edit` 且 `replace_all: true` 时 `# replace_all：该替换在文件里出现多次，每一处都已被替换`
  —— 它改变**语义**却不改变**行**，不写这行用户会以为只改了一处。

`looksLikeEditor(toolName)`：`EDIT_TOOLS`（Edit/Write/MultiEdit/NotebookEdit）里
但没进 `MAPPED_TOOLS`（只有实测见过的 Edit/Write）的工具。

> ★ 这个函数存在的**唯一**理由，是让那种缺失**再也无法安静地复发**：
> `file_diff` 当年的问题不是「算错了」，而是「没有任何东西会产生它，
> 也没有任何东西会抱怨」。

所以调用方（`event-batcher`）遇到这类工具时会记一条 `warn` 诊断。

`displayPath(filePath, cwd)`：在 cwd 之下就相对化，否则原样返回绝对路径；
`cwd` 为空、或相对路径要往上爬（`..`）时**一律保留绝对路径**
—— 一个以 `../../..` 开头的「相对路径」比绝对路径更难读，而且它其实是在说
「这个文件不在你这个项目的目录里」，那正是该被看见的信息。Windows 上用正斜杠展示。

### 6.5 `process/` —— 运行时管道

```
child-registry.ts (300)  活子进程登记处 + 中断阶梯（唯一实现）
event-batcher.ts (1123)  ★ 最大也最核心：帧的分配、合批、落库、推送、重放、抑制
runtime.ts (268)         ★ 唯一的装配点（也是唯一的管道入口）
```

#### 6.5.1 `runtime.ts`：为什么是三个具体回调而不是一个泛化的 Registry

`runtime` 是**唯一的装配点**，也是**进入管道的唯一入口**（`runtime.dispatch`）。
它被注入了三个 emit 回调：

```ts
emitBatch   // → transport.send('stream:batch', batch)
emitUnread  // → transport.send('workspace:unread', …)
emitStatus  // → transport.send('stream:status', …)
```

文件头解释了为什么不用一个泛化的 `Registry`：为了让**注册表 ↔ 运行时**这个循环
在类型上可见。（合批器需要回调，而回调需要合批器的 store ——
用三个具体回调比用一个对象更容易看清这个环。）

`batcherStoreOf(store)` 是**导出**的，好让测试共用**同一个生产用窄口**，
而不是各写一份。

两条容易忽略的：

- **`onRunCrashed` 直接写终态行（不过合批器）** —— 一轮没有任何事件的轮次
  不该留下一条 assistant 消息。**它必须** emit `stream:status failed/crashed`，
  否则界面会一直以为它在跑。
- **`startupSweep` 刻意不 emit status** —— 那时窗口还没加载完，推了也没人收。
- `close()` → `batcher.close()`。

#### 6.5.2 `event-batcher.ts`：整条链上最核心的一个文件

它是「适配层事件」到「线上帧」的翻译器，同时负责落库、推送、重放、抑制。
1123 行，是仓库里最大的文件。

**★ 时序与阈值**：

```ts
DEFAULT_BATCH_TIMINGS = {
  flushMs: 33,           // 一帧 ≈ 30Hz
  maxFramesPerFlush: 64,
  maxBufferBytes: 32 * 1024,
  unreadMs: 1000,        // 未读节流
  ringFrames: 4096       // 回放环容量
}
FRAME_PAYLOAD_LIMIT = 256 * 1024   // 单帧载荷上限
```

★ `FRAME_PAYLOAD_LIMIT` 在 `message-repo.ts` 里**另有一份**，是**刻意**不共用的
（两个不同的所有者，理由与 `entities.ts` 里「这不是 `IPC_ERROR_CODES` 的第二份」同形）。

**★ 先落库后推送。** 崩溃窗口：硬杀时最多丢 33ms 的增量。工具事件是**屏障**，
它们立即 flush —— 于是「工具调用」这种带因果关系的点不会悬在半空。

**★ epoch**：每进程铸造一次（`randomUUID()`）。它的所有者是合批器，
渲染层只负责持有与回传。为什么不能用「自己造一个」代替：
那唯一后果是 `stream:resume` 一律返回 `matched: false` + 空帧 ——
**而那个结果看起来和一个正常的空回复一模一样**，所以这个错误会活得很久。

**关键函数**（只列最难懂的几个）：

| 函数 | 语义 |
|---|---|
| `armFlush` / `clearFlush` | 进程级**一个**定时器（不是每轮一个） |
| `markDirty` | 「起定时器」这件事的唯一入口。M6a 的 bug 是 `text_delta` 从不调它 → 纯文本轮次永不 flush |
| `pushMergeable` | 合并**保留首个 seq**（这直接造成「批内跳号」，见 §5.2） |
| `pushAtomic` | 工具/用量/终态等不可合并的事件 |
| `usageFrame` | 规则：上报值 > 0 才用它，否则用流内估算 |
| `diffBuffers` | 合成 diff —— **只在 `ok === true` 时**；`looksLikeEditor` 时记 `file-diff-unmapped-tool` 警告 |
| `ensureMessage` | 懒建 message 行（一轮可能一个字都没产出） |
| `commit(turnId, terminal)` | **一个事务**：ensureMessage → 写事件行 → `setStreamedText` → `advanceSeq` → 记数 + `turn.finish`。失败时清缓冲 + `t.message = null` + 走 `bestEffortTerminal` |
| `retain` | 回放环（`ringFrames`），`retainedFrom = max(retainedFrom, 最高被淘汰帧的 seq)` |
| `emitFrames` | ★ `toSeq` 取**计数器高水位** `s.seq`，**不是** `frames[last].seq` |
| `barrier` | 两次 commit、一次 emit |
| `resume` | 重放协议的实现（三道判断，见下） |
| `markUnread` / `drainUnread` | 节流 ≠ 丢弃（末尾还有一个 trailing 定时器） |
| `sliceUtf8` | 按 UTF-8 切到字符边界（第一版是错的：实测 `'汉'.repeat(262144).subarray(0,262144)` 切出 262146 字节 + 一个 U+FFFD） |

**★ `endTurn` 的顺序是硬的**：

```
pushDoneRow → commit(turnId, terminal) → 清重状态 → emitFrames
  → drain 未读 → 最后 emitStatus
```

**★ `resume()` 的三道判断**（重放协议，`design.md` §4.3）：

```
epochIn !== epoch           → matched: false + 空帧
fromSeq  >  s.seq           → matched: false + 空帧
fromSeq  <  s.retainedFrom  → matched: false + 空帧
```

三种成因**在契约上就塌成同一个响应**，因为渲染层的动作三者完全一样：
丢弃水位线 → 用响应里的 epoch 覆盖本地 → 重跑 `message:list` → **不重试**。

**★ `beginTurn` 在两件事上同时生效**：把上一轮的在途帧丢掉
（`retainedFrom = max(retainedFrom, s.seq)`），并清空回放环。
于是环里**只有「当前这一轮」的帧**。

**★ 抑制**：`emitFrames` 按 `workspaceId` 抑制（不在当前视图里的空间不推帧），
而 `retain(s, frames)` 跑在 `commit()` **里、`emitFrames` 之前** ——
所以「被抑制」不等于「被丢弃」，切回来还能重放。
`stream:status` **从不抑制**（侧边栏要跨空间显示谁在跑）。
`workspace:unread` 节流到 1Hz，计数单位是**轮次**。

**★ 终态与 `done` 帧相差 249–377ms**（M6a 实测）。`done` 帧由合批器刷新推出，
终态行由 `turn-runner` 写，**不是同一个事务**。所以：

> 渲染层不许在收到 `done` 的同一刻断言「库里已经是终态」——
> 此刻 `turn:get` 可能还回 `running`。

#### 6.5.3 `child-registry.ts`：中断阶梯的唯一实现

登记 `turnId → ChildProcess`，提供 `killTree(turnId, { timings, sendInterrupt })`。
`sendInterrupt` 是**载荷形状的注入点** —— 「`control_request` 长什么样只有适配器知道」。

Windows 上的杀树与信号语义与 POSIX 不同，文件头有完整记录。
阶梯分三级（优雅 `control_request/interrupt` → 硬杀），宽限期由 `KillTimings` 注入
（测试注入缩短，否则每个用例真等 8 秒以上）。

### 6.6 `ipc/` —— 契约的服务端

```
registry.ts (194)          ★ 三道护栏都在这里（见 §9）
errors.ts (89)             AppError / NotFoundError → toEnvelope（把 SqliteError 的 errcode 映射成业务码）
context.ts (50)            HandlerContext = { store, now(), newId(), view, sys, runtime }
transport.ts (28)          传输接口
electron-transport.ts (38) ★ ipc/ 里**唯一** import electron 的传输实现（+ system-capabilities.ts）
system-capabilities.ts (51) dialog:pickPath / shell:revealPath
handlers/index.ts (48)     注册顺序 + 两个 defer
handlers/workspace.ts (273) project.ts (393) actor.ts (91) member.ts (223)
         session.ts (24) message.ts (39) turn.ts (176) misc.ts (70) system.ts (42)
         file-hash.ts (49)
```

**`handlers/index.ts` 里两个 `defer`** —— 「没有实现」的通道被**显式**标出来，
**不写桩**：

```
turn:interject → M9「插话队列：在当前轮结束后执行」
turn:stopAll   → M9「需要先有『停止运行中的轮次』」
```

理由：**假数据会是一句谎。** 返回一个编的 `{queued: 0}` 比返回 `E_NOT_IMPLEMENTED`
坏得多 —— 前者会让调用方以为功能已经有了。

**`handlers/turn.ts`：`turn:send` 的全部动作**

1. 四项前置检查：成员存在 / 成员属于本空间 / 成员是启用的 / 会话存在。
2. `ctx.runtime.cwdFor(workspaceId, memberId).cwd`。
3. **一个事务两笔写**：`message.append`（用户消息）+ `turn.create`
   （`status='queued'`、`triggerMessageId`、`hopDepth: 0`）。
4. **提交之后**才 `ctx.runtime.dispatch(turn)`。
5. 返回 `{ turnId }`。

`turn:stop` 的三个分支：`queued` → `markCancelled` + `runtime.cancelQueued` +
`runtime.emitStatus({status:'cancelled', reason: null})`；`running` → `E_NOT_IMPLEMENTED`
带 `{turnId, pid, milestone:'M9'}`（附一条注释说明旧的 SIGINT 措辞已过期）；终态 → `E_CONFLICT`。

**`handlers/message.ts`**：优先级链 `sessionId != null` → `listBySession`；
否则 `beforeSeq != null` → `listBefore`；否则 `listRecent(workspaceId)`。
三条都是**升序**。`message:getEvents` 在消息不存在时**抛 `NotFoundError`** ——
返回空 `[]` 会把两种不同的 UI 状态混成一个。

**`handlers/turn.ts` 的一条警告**：`turn:list` 的 `listRecentByWorkspace` 按
`started_at DESC` 排序，而 NULL 排最后 —— 所以 `queued` 的轮次会出现在**末尾**。
要拿在途轮次请用 `turn:listLive`。

### 6.7 `main/index.ts`：启动顺序

275 行，是启动次序的唯一编排者。几个刻意的选择：

- **`transport` 建在 `try` 外面** —— 数据库起不来时也要有一条路径把这件事报出去。
- **`startBackend()` 的顺序**：mkdir userData → openStore → sys → children/adapters
  → view → runtime → ctx → registry → registerAll → **seal()** → backend 赋值
  → **startupSweep**（reapedRunning / reapedQueued 分开 warn，且它自己的失败
  会被单独报告，不会被说成「数据库起不来」）。
- **`whenReady` 先 `startBackend()` 再 `createWindow()`。**
- **`will-quit` 的顺序**：`transport.dispose?.()` → `runtime.close()` → `store.close()`
  → `backend = null`。★ `batcher.close()` 会**同步** flush 掉脏缓冲，
  所以它必须跑在 `store.close()` 之前。
- **单实例锁**。
- **`app:notice` 在窗口还没加载完时进 `pendingNotices`**，`did-finish-load` 时
  `flushNotices()`；后端从没起来过时退化成裸 `transport.send`。

---

## 7. 共享层 `src/shared/`

### 7.1 `entities.ts` / `copy-policy.ts`

`entities.ts`（308 行）是**跨进程的词汇表**：`AGENT_KINDS`、`TURN_STATUSES`、
`TERMINAL_REASONS`、`AGENT_ERROR_CODES`、`TABLES` …

★ `AGENT_ERROR_CODES` **不是 `IPC_ERROR_CODES` 的第二份**，两者是不同的所有者，
**绝不要合并**。命名刻意**不带 `E_` 前缀**，就是为了让人一眼看出不是一套。

8 个码里，**只有 4 个目前有生产者**（`cli_not_found` / `spawn_failed` / `nonzero_exit` /
`cli_reported`）。另外 4 个（`protocol` / `parse` / `budget_exceeded` / `aborted`）
**至今零生产点**：前两个是「整轮没有 `system:init`」「终态行解析不出来」这类
理论上会发生的情形；后两个的位置被 `done reason='budget'` / `'interrupted'` 占着。

`copy-policy.ts`（34 行）是个小纯函数模块，它的**先例意义**大于功能意义：
「纯逻辑放 `shared/`、用裸 Node 测」这条做法是从它开始的。

### 7.2 `ipc/` —— 契约

```
channels.ts (162)   ★ 通道清单：47 条 invoke + 4 条 push
schemas.ts (703)    ★ 每个通道的 zod schema（+ 推送载荷的 schema）
contract.ts (43)    从上面两张表推导出类型（`InvokeContract` / `PushContract`）
envelope.ts (78)    IpcResult / IpcError / unwrap
client.ts (103)     渲染侧门面：两级 Proxy → `api.workspace.list()`
```

**47 条 invoke 通道，分九组**：workspace 7、project 7、actor 6、member 11、
session 3、message 2、turn 7、宿主能力 2（`dialog:pickPath` / `shell:revealPath`）、
view/stream/runtime 3。

**推送通道刻意只有四条**：

```
stream:batch       帧批次（30Hz）
stream:status      轮次状态切换（低频）
workspace:unread   未读数（节流 1Hz）
app:notice         通知
```

★ **没有 `runtime:changed` 这种东西** —— 侧边栏的「运行中 0/3 · 队列 0」靠
`stream:status` 刷新。这让那条通道除了「显示轮次状态」之外有了第二个用途，
而且两个用途**恰好同步**：轮次状态变了，正是队列深度与槽位占用会变的时刻。
**不需要新通道。**

**`schemas.ts` 里几个值得记的形状**：

- `StreamFrameSchema` 是按 `k` 判别的 9 元联合：`text` / `thinking` / `thinking_end` /
  `tool_start` / `tool_result` / `file_diff` / `usage` / `error` / `done`。
  ★ `usage` 的三个字段（`cacheRead` / `cacheCreation` / `thinkingTokens`）
  **是必填不是可选** —— 合批器必须在发出去之前就把 §4.6a 那条规则走完。
- `StreamBatchSchema = { v:1, t, workspaceId, sessionId, turnId, actorId, epoch,
  fromSeq, toSeq, frames }`。
- `WorkspaceUnreadSchema.count` 是 `int ≥ 0`，单位是**轮次**。
- `WorkspaceUsageSchema` 四个数字**都不可空**（`?? 0` 的落点）。
- `DeleteReport` 里 `CopyRemoval` 有四个状态 `removed | absent | kept | failed`
  ——「几个副本删掉了、哪些没删掉」必须逐条如实。
- `workspace:paths` 有一个显式的 `ensure` 标志（默认 `false`）——
  **一个叫 `paths` 的通道不该写盘**。

**`client.ts` 的一个细节**：两级 Proxy 的每一层**缓存**代理对象，
所以 `api.workspace === api.workspace` 成立 ——
否则每次属性访问都造一个新对象，放进 React 依赖数组会永远不相等，引发无限重渲染。

### 7.3 `live/` —— 渲染层的纯逻辑（★ 本项目测试密度最高的一块）

```
frame-buffer.ts (258)  帧 → 在途轮次的缓冲（唯一归约器）
watermark.ts (308)     水位线 + 纪元 + 「这一轮我够不够格自己渲染」的状态机
history.ts (180)       message_event 行 → 帧 → 缓冲
timeline.ts (109)      空间时间线的排法
patch-lines.ts (70)    file_diff.patch 的行分类
```

**零 DOM、零 electron、零运行时 import**（`import type` 是真的类型导入，
编译出来没有任何 require，裸 Node 直接跑得动）。

#### 7.3.1 `frame-buffer.ts`

```ts
interface TurnBuffer {
  readonly turnId: string; readonly sessionId: string
  readonly workspaceId: string; readonly actorId: string
  text: string            // 只被 <StreamingText> 订阅
  thinking: string        // 只被 <ThinkingPanel> 订阅
  thinkingOpen: boolean
  items: TimelineItem[]   // tool_start/tool_result/file_diff/error，按到达序
  usage: Usage | null
  done: DoneReason | null
}
```

★ **`text` 与 `thinking` 必须是两个字段，不能合成一个字符串列表** ——
§4.7 规则 4 要求思考 delta **不触发正文节点重渲染**，这是前提。
`applyFrame` **只重建被改动的那一个**。

行为细节（每条都对应一个「不这么写就会安静出错」的坑）：

| 帧 | 处理 |
|---|---|
| `text` | 空 delta **不动引用**（否则白白让订阅 `text` 的组件重渲染一次） |
| `thinking` | ★ **重新展开** `thinkingOpen`：`thinking_end` 之后可能还有第二段思考（工具调用之间会发生），塞进一个收起的面板里 = 用户看不见它，而它明明来了 |
| `thinking_end` | 只在 `thinkingOpen` 为真时改引用 |
| `tool_start` | 少见但要定义：先见 result、后见 start（重放从中间接上）→ **补全那一条，而不是再压一条** |
| `tool_result` | 没见过这次调用时**名字留空**，让界面说「未见到调用」—— 拿 id 去猜一个工具名是最容易犯的错，**猜出来的名字会被当成事实读** |
| `file_diff` | `patch` **原样透传**，一个字符都不动 |
| `usage` | ★ **覆盖，不是累加** |
| `error` / `done` | — |
| `default` | ★ **这个分支必须有**，尽管 TS 认为已穷尽。理由是推送路径**不做校验**（`client.ts` 的 `onPush` 把载荷原样交给监听器，没有 zod），所以一个我们不认识的帧（主进程版本更新）会真的走到这里。**静默忽略是对的：一个看不懂的帧不该让整个轮次的渲染崩掉。** |

`emptyBuffer()` 的 `thinkingOpen` 初值是 **`true`**：第一段思考 delta 到达时应当能看见它。
没有思考的那一轮 `thinking` 恒为空，面板根本不会渲染，所以这个初值不会泄漏成一个空面板。

`applyFrames(buf, ids, frames)`：`buf` 为 `null` 且 `frames` 非空 → 新建缓冲；
`buf` 为 `null` 且 `frames` 为空 → **返回 `null`**，不建空缓冲。
★ 这一条很重要：**空缓冲会让历史行被抑制**，于是一个什么都没有的轮次会把已有的历史行
**藏起来**。

#### 7.3.2 `watermark.ts`：本项目最容易「静默出错」的地方

> 因为它是整个 M6b 里唯一一处**错了不会报错、只会让界面永远不动或悄悄重复**的地方。
> 记错的表现是：数字偏小 → 每批帧都被判成旧的、界面静默冻住；
> 数字偏大 → 一段内容永远收不到。

三条 `seq` 轴里帧 `seq` 是唯一能当水位线的，而它**不落库** ——
所以它推不出来，只能由「我收到过什么」记下来。

**★ `epoch` 只能学到，不能自己造。** 它的所有者是合批器（每进程铸造一次），
这里只负责持有与回传。

**★ 重放能拿到多少：只有当你从这一轮的第一帧要起。** `beginTurn` 在新一轮第一帧到来时
丢掉上一轮的在途帧并清空回放环，而 `resume()` 有三道判断（见 §6.5.2）。三条推论：

1. **环里只有「当前这一轮」的帧。**
2. **`fromSeq: 0` 只有在本会话于本进程里的第一轮才拿得到整轮。**
3. **用「我自己的水位线」去问，拿到的永远是尾巴。**

**推论 3 是第一版协议踩过的坑。** `watermarks[sessionId]` 是**跨轮次**的（只增不减），
所以「我有一条水位线」**不等于**「我看着这一轮从头开始」。按推论 3 去问，
切回来时拿到的是**半截**正文，而 `frame-buffer` 那条不变式会让这半截缓冲**盖住**
已经完整的历史行 —— 用户看到的是「回答只有最后一段」。

于是这里记两样**按轮次**的东西（`TurnWatch`）：

- `startSeq`：**这一轮的第一帧之前的那个水位线**。拿它去问就能要到**整轮**。
- `fromStart`：我们**有没有见到这一轮的第一帧**。为假时**不许建缓冲**。
  ⚠️ 这个判断只在**第一次见到这一轮**时做一次，之后一直沿用 ——
  「每次拿 `fromSeq` 现算」看着更简单，其实是错的：`fromSeq` 每批都往后走，
  第二批就会被判成「没见到开头」。

**★ 三个字段 `resetBuffers` / `useFrames` / `createBuffer` 必须分开说**
—— 这是 M6b 真机走查**用一次真实损失**换来的：

> 第一版把它们揉成了一句「纪元变了 → 清空缓冲，这一批也丢掉」，其中 `resetBuffers`
> 针对的是**旧**缓冲（按上一套编号拼的），而 `useFrames` 说的是**这一批** ——
> 它带的就是新纪元（`batch.epoch` 正是刚被学到的那个），凭什么丢。
>
> 揉在一起的后果是：**进程启动后的第一批帧永远被吃掉**，于是每次开应用，
> 那一轮回答的**开头**都缺一段。走查量到的形状是「DOM 45 字 / 帧 66 字」，
> 缺的正是模型说的第一句 —— 而界面显示的是一个**完整的、只是更短的**回答，
> 所以它不像出错，只是内容悄悄少了一截。

`planBatch` 的实现就是这一条的固化：`useFrames` **恒为真**，
想让「纪元变了」顺带把帧也丢掉，得先把这个字段改成假 —— 而测试会当场拦下。

`applyResume` 有一处不对称，注释特意点明：**它推的是帧的 seq，而实时路径推的是
`toSeq`。两者不是同一个算法，也不需要是** —— 帧 seq 是单调分配后可能被合并跳过的，
所以随便取哪个都只能是个下界，而水位线的语义本来就是「我已经有了到这儿为止的内容」。

`matched: false` 时**删掉**该 session 的两份记忆（不是「设成某个数」）——
我们确实不知道任何正确的值，设一个就会在下一轮 `resumePlan` 里伪装成
「有一条可用水位线」。

#### 7.3.3 `history.ts`

> **历史回放与实时流走的是同一个归约器。**

很自然的分叉写法是给历史**再写一套**渲染。那样一来，同一轮对话在「刚跑完」与
「重启后重看」时会长得不一样 —— 而且**只在某些字段上不一样**。这种错没有任何测试能
自动发现。所以这里只做一件事：**把行翻译成帧**，然后交给 `frame-buffer` 那个唯一的归约器。

**一条有损之处，必须写明**：`EVENT_KINDS` 里**没有 `thinking_end`** —— 它不落库
（只是一条帧）。所以从历史拼出来的缓冲**没有「思考结束」这个事实**，
统一按 `thinkingOpen: false` 给（回顾旧消息时推理面板默认收起是我们要的样子）。
代价是历史里看不出「这段思考之后模型还说了话、之后又想了第二段」的边界。
**那是 M7 或更后面的里程碑要做的事，M6b 不做，只把它记在这里。**

其他细节：

- 帧 `seq` 借自 `message_event.seq` 只是**填一个必填字段**，
  「它绝不会被喂进水位线状态机」。
- **坏 JSON 一律抛**：那些列都是我们自己用 `JSON.stringify` 写进去的，
  读回来解析不了意味着**库被外部改过**，此时静默吞掉会让界面少显示一块而无从解释。
- `ok` 可空，但一条没有 `ok` 的结果行是坏数据 → **按失败读**
  （把未知当成成功会让界面给一次可能没成的调用打勾）。
- 行里存的 `truncated` 与帧上的 `truncated` **不是同一件事**：
  行回答「到底输出了什么」，帧回答「这一次推送发了多少」。历史上看到的是全量，所以恒为 `false`。
- `file_diff` 缺 `path` → **抛**，不编一个。
- `error.code` **不校验**是否在 `AGENT_ERROR_CODES` 里：真出现别的值说明版本分叉了，
  如实显示出来比吞掉更容易发现。

#### 7.3.4 `timeline.ts` —— 「哪些格子、按什么顺序」

```ts
type TimelineEntry =
  | { kind: 'message';   id: string }
  | { kind: 'streaming'; turnId: string }
  | { kind: 'failed';    triggerMessageId: string }
```

> ★ 一条不变式：**有缓冲才抑制历史行。**

这是 `frame-buffer` 那条「缓冲的正文只来自帧，从不来自历史」在界面上的形态，
也是「重放回来的帧」与「历史行」永远不会同时出现的**全部**机制 ——
**不需要任何去重逻辑**。

三种格子的排法：

1. **历史消息**：`order[workspaceId]` 的顺序（`message.seq` 升序）。
   用户消息与各成员的回复交错在同一条线里。
2. **失败轮次**：紧跟在**触发它的那条消息**后面。
   ★ **不用时间戳把它插进序列里** —— 那要比较 `message.seq` 与 `turn.queued_at`
   两个不同的轴（§4.7 明令禁止）。挂在触发消息后面不需要比较任何两个轴。
3. **在途轮次**：一律排在**最后**。这是一个**已知的粗略**：多个成员同时跑时，
   它们之间的先后是按「谁先被建起缓冲」定的。等它们落定，交换会按 `message.seq` 归位。

`shouldReadEvents()` 回答**三件「不读」**的事，每一条的后果都不是「少一点东西」
而是**看到假的东西**：

| 情形 | 读了会怎样 |
|---|---|
| **用户消息**（`turnId === null`） | 没有事件行，读了只会折出一个空缓冲，**而空缓冲会把 `content_text` 盖掉** —— 用户那句话在界面上变成一片空白 |
| **在途轮次** | 事件行每 33ms 就多几行，此刻折出的是一份**冻结的残缺快照**，随后会盖住**随流增长**的 `content_text`：字幕卡在半句话上，底下模型还在说 |
| **`runtime` 没读回来** | 无法断定有没有在跑的轮次 → 按「等会儿再来」处理：多等一个 IPC 往返，换掉一整个卡住的正文 |

⚠️ 后两条是「**等会儿**再来」而不是「这辈子别再来」—— 调用方据此**不置位**
`eventsAttempted`（那个置位是永久性的）。

★ 顺带一条容易读错的：**`runtime === null` 不是「零个在跑」**，
而是「还不知道」。UI 上显示「运行状态读取中…」，不是「0/3」。

#### 7.3.5 `patch-lines.ts`

格式的所有者是 `domain/tool-diff.ts`，这里是它的**读者**。
它**只做一件事**：按首字符分类。它不解析、不编号、不补上下文。

四类：`add`（text 不含 `+`）、`del`（不含 `-`）、`note`（text **含** `#`）、
`raw`（既不是 `+`/`-` 也不是 `#`）。

★ `raw` **不许丢掉**：它意味着生产方给出了语法之外的东西（版本不一致、格式被改）。
静默吞掉的话界面上少一行而没人知道；原样显示至少让用户看见「这里有个怪东西」。
（空行也会落到这里 —— 那是合法的。）

两个易错点写在注释里：`'a\nb\n'.split('\n')` 得到 `['a','b','']`，
而那个 `''` **不是一行空行**，是分隔符的残留；`countChanges` **只数 `add`/`del`**
—— 把注释算成改动行，用户看到的数字会比实际改动大，而他会拿这个数字去判断改动有多大。

---

## 8. 渲染进程

### 8.1 全景

```
main.tsx            <StrictMode> 挂载
App.tsx             三栏外壳 + 三个只读 effect + NoticeBar
ipc.ts              ★ 全仓唯一的 window.api 消费点
store/
  index.ts          三个 slice 合成一个 store
  entity.ts (683)   实体缓存（会被写回 DB 的东西）
  ui.ts    (182)    这屏的状态（在看谁、在看哪一屏、通知、pending）
  live.ts  (562)    ★ 对话的实时态（缓冲、历史、运行时概要、用量）
hooks/usePushNotices.ts  ★ 四条推送的全应用唯一订阅处
components/
  conversation/     对话那一屏（10 个文件）
  ui/               基础件（Badge/Button/Dialog/Empty/Field/Text）
  其余              外壳与实体管理（Sidebar/TopBar/MemberList/ProjectList/…）
```

**三份 store 的分工判据**（`store/index.ts` 与各文件头）：

- `entity`：**刷新一次重来会让用户看到不同数据的**放这里（空间、项目、成员、会话）。
- `ui`：**刷新一次重来也无所谓的**放这里（在看谁、在看哪一屏、通知、pending）。
- `live`：**由推送驱动的、过期即无意义的**（帧缓冲、水位线、运行时概要）。

★ 里程碑上的一段历史值得记：**M4 只落了 `entity` + `ui`，`live` 故意不建**，
当时在 `ui.ts` 里留了话「M6 的调度器与 `stream:batch` 落地时会把它搬过去」。
M6b 兑现了：`runtime` 与 `loadRuntime` 从 `ui` 搬到了 `live`，
理由写在那里 —— 「运行概要的变更信号是 `stream:status`，而那条推送属于 `live`。
留在这里的话，`ui` 会因为一条与它无关的推送而重渲染。」

### 8.2 `store/live.ts`（562 行）

文件头有一张「**四份状态，四个所有者**」的表，和一句加粗的：

> ★ **没有 `turnStatus`。**

也就是说，渲染层**不维护**「这个轮次现在是 running 还是 done」这份状态。
为什么不维护、以及那它靠什么渲染，是这一节的核心。

字段：

```ts
messages            Record<messageId, Message>     // 历史消息（DB 的投影）
order               Record<workspaceId, string[]>  // message.seq 升序的 id
loadedWorkspaces    Set<workspaceId>
failuresByTrigger   Record<triggerMessageId, …>    // 「跑了但一个字都没产出」的轮次
historyBuffers      Record<messageId, TurnBuffer>  // 由 message_event 折出来的（只读展示）
eventsAttempted     Record<messageId, true>        // 永久置位：不再重试
buffers             Record<turnId, TurnBuffer>     // ★ 在途轮次的实时缓冲
streamingTurnIds    string[]                       // 有缓冲的轮次（= 抑制历史行的判据）
recentlyFinished    Set<turnId>                    // 上限 64
cursor              StreamCursor                   // watermark.ts 的状态机
runtime             RuntimeState | null            // 来源是 stream:status
usage               WorkspaceUsage | null
```

**全文件贯穿一条不变式**：

> ★ **有缓冲才抑制历史行。**

**`planBatch` 是三个判断的唯一合流处**（`watermark` 的纪元 + 缓冲存在性 +
`fromStart`），**`applyBatch` 是热路径**（同步、没有 await）。

**`applyStatus` 的终态分支的顺序是硬的**：

```
① 先把历史读回来（message:list）
② 再丢缓冲
③ 最后把 turnId 记进 recentlyFinished
```

原因见 §10 的折叠一节。

**`openConversation` 的顺序也是硬的**：`runtime:getState` 必须在 `stream:resume` 之前
（否则不知道有没有在跑的轮次，而 `shouldReadEvents` 依赖这个判断）。

**`resumeWorkspace` 要哪一头取决于手里有没有缓冲**：没有 → 要**整轮**；
有 → 只管要**尾巴**。（见 §7.3.2 的推论 3。）

**usage 帧是覆盖不是累加**（与 `frame-buffer` 一致）。

### 8.3 `hooks/usePushNotices.ts`（50 行）

四条推送在这里**一次挂完**。文件头逐字：

> ★ 整个应用**只挂这一处**。任何组件自己再订阅一次 `stream:batch` 都会
> 把「折两遍」的问题重新引进来，而且只在开发模式下才看得见。

（`<StrictMode>` 会让 effect 跑两遍，所以退订函数的返回值是**必须**的 ——
不还的话同一批帧会被折两遍，界面上的正文**逐字重复**一遍。）

这段注释还留了一处「寄放的兑现」：文件头原本写着「M4 只订阅了其中两条
（`app:notice` / `workspace:unread`），另外两条留给 M6」—— M6b 让那句话成真。

### 8.4 `components/conversation/` 逐组件

这一屏的设计目标是**§4.7 的七条渲染规则**（见 §10）。核心手法是
**每个组件只订阅一个原子选择器**，于是「哪些东西会重渲染」是可以通过读代码确定的。

| 组件 | 订阅什么 | 关键点 |
|---|---|---|
| `ConversationPane` (77) | 5 个原子订阅 + 两个**只读** effect | 贴底跟随刻意做得**粗**（30Hz 精确跟随是下一个里程碑的事） |
| `MessageList` (58) | 4 样东西，**从不订阅 `buffers`** | 把整张列表挡在 30Hz 之外 |
| `MessageRow` (120) | `messages[id]` + `historyBuffers[id]` | 局部 `thinkingOpen` 默认 `false`；`FailedTurnRow` 按**触发消息 id** 索引 |
| `StreamingRow` (73) | 只订阅 `actorId` / `workspaceId` / `usage` / `done` | ★ **本身也不随 delta 重渲染** |
| `StreamingText` (40) | `s.buffers[turnId]?.text ?? ''` | 一次 delta 只重渲染**那一个 `<p>`**；光标挂在 `done === null` 上 |
| `ThinkingPanel` / `LiveThinking` | 两个**分开的**原子订阅 | 用户的 `override` 在 `thinkingOpen` 回到真时被清掉 |
| `ToolTimeline` / `LiveToolTimeline` (115) | 只订阅 `items` 数组 | 未见到调用时显示「未知调用」而不是猜一个名字 |
| `DiffBlock` (63) | — | 调 `classifyPatch` / `countChanges`，渲染 patch，**不算行号** |
| `Composer` (115) | — | 成员是**选**的，不从文本里解析 `@`（那是 M7）；**停止按钮刻意不存在**（M9） |
| `ActorChip` (63) | — | 认不出时显示「未知成员」，不猜 |

### 8.5 外壳里的几条容易忽略的规则

- **`App.tsx` 的空态也必须渲染 `NoticeBar`。** 删掉最后一个空间时界面会立刻落到空态，
  而「副本删了几个、哪些没删掉、空间目录还留在哪」那条报告正是这一刻推出来的
  —— 少渲染它，就等于把整个里程碑最要紧的那句交代吞掉。
  （这是**实机走查发现的**：空间删掉了、页面回到了空态，而删除报告一个字都没露过面。）
- **对话视图自带滚动，且不套外面那层滚动容器** —— 套进去会出现两条滚动条，
  其中一条永远滚不动。提示条放在滚动区**外面**（滚上去就看不见了）。
- **`App.tsx` 的三个 effect 全部只读、幂等。** StrictMode 会把它们各跑两遍，
  重复读一次没有副作用 —— 而「写入」一次都不许出现在 effect 里
  （M3 被自动建空间的写操作咬过一次）。
- **`key` 是必须的**：不换 key 的话，从一个成员切到另一个时内部的 `useState`
  （职责文件草稿、二次确认）会留在原地，「确认移除」的勾会跟着跑到下一个人身上。
- **`ui.select()` 会顺手切回 `overview`。** 「在看某一屏」与「在看某个对象」互斥；
  不对称就会有一个**静默的空点**：在对话视图里点侧栏的成员，`selection` 确实变了，
  而 `App` 按 `view` 渲染 → 那一屏还是对话 → 点击看起来什么都没做。
  ⚠️ 这一条是**读代码时发现的，不是走查抓到的**，所以它**不在任何一次归档运行的覆盖里**。
- **成本那个数必须标「估算」（§2.4-2）。** 走第三方端点时 `result.total_cost_usd`
  的数值是错的 —— 一个看起来像账单的数字会被当成账单用。
  ★ `turnsWithoutUsage` 非零时**必须**露出来。
- **「当前项目」切换器接的是 `workspace:setActive`，不是 `project:setActive`**
  —— 通道清单里没有后者。「当前项目」不是项目自己的属性，而是**空间**的属性
  （`workspace.active_project_id`），它是 cwd 的二级兜底。
- **`MemberDetail` 有三条常驻说明**：可见项目**只是上下文裁剪**、不是安全机制；
  改可见性**将在下一轮生效**；`isRestricted === false` 时空数组的意思是
  「**可见全部**」而不是「什么都看不见」。

### 8.6 `styles.css`

Tailwind v4 的 CSS-first 配置。`@theme` 里 **14 个颜色 + 1 个字体**：

```
深空底色  --color-void #05060a  --color-abyss #0a0c14  --color-panel #0e111b
          --color-panel-2 #131725  --color-edge #1b2030  --color-edge-bright #2a3350
霓虹四色  --color-neon-cyan #22d3ee  --color-neon-violet #a855f7
          --color-neon-pink #f472b6  --color-neon-lime #a3e635
文字三级  --color-ink #e6edf7  --color-ink-dim #8b97ad  --color-ink-faint #5a6478
字体      --font-mono 'JetBrains Mono', 'Cascadia Code', 'Consolas', ui-monospace, monospace
```

块头注释：「全部走 CSS 变量，将来加浅色主题只是换一组变量。」

四个自定义类，每一个都带一条**性能理由**：

- `.typing-cursor` —— 纯 CSS 动画，「**绝不进 React state**」（用 React 布尔量跟踪
  光标可见性 = 每次闪烁多一次重渲染）
- `.neon-frame` —— 辉光烘焙进静态伪元素，**只 animate opacity**（直接 animate
  `box-shadow` / `text-shadow` 会在流式期间每帧全量重绘）
- `.neon-halo` —— 静态径向渐变，**不旋转**（见 §14）
- `.grid-bg` —— 32px 网格底纹

另有 `:root { color-scheme: dark; }` 与 `@media (prefers-reduced-motion: reduce)`
降级（`animation: none` + 光环 `opacity: 0.3`）。

`index.html` 的 CSP（逐字）：

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
           img-src 'self' data:; font-src 'self' data:;
           connect-src 'self' ws: http://localhost:*" />
```

---

## 9. IPC 契约与三道护栏

`src/shared/ipc/channels.ts` 是**唯一**的通道清单，它同时是四样东西的事实源：
主进程的注册表、preload 的白名单、渲染侧的类型、zod 校验表。

**为什么这很重要**：`preload/index.ts` 的白名单是**从 `channels.ts` 派生**的，
不是手写的一份副本 —— 所以 preload 与主进程的通道清单**不可能**分叉。
而 preload **绝不暴露裸 `ipcRenderer`**：一旦暴露，渲染层（以及任何注入到页面里的
第三方脚本）就能对任意通道发任意载荷，那份契约就成了一张废纸。

**三道护栏**（`ipc/registry.ts`）：

1. **每个通道都必须返回 `IpcResult` 信封。** 连「这条通道没实现」也走信封
   （preload 遇到未知通道时回一个 `E_INVALID_PAYLOAD` 信封而**不是抛异常**
   —— 破了这条会让渲染层的 `unwrap` 拿到一个裸 rejection，处理方式与其它通道全不一样）。
2. **每个载荷都要过 zod，未实现的通道也要过。**
3. **每条通道必须被显式分类成 handle 或 defer，否则 `seal()` 抛。**
   漏分类是**启动即炸**，不是「用户点下去才发现」。`seal()` 还会把那个未分类的错误
   通过 `startBackend` 的 catch 变成一条 `app:notice`。

`dispatch()` 是三段：**zod → 有没有实现 → try 跑 handler → toEnvelope**。

**出站也要校验**：`emit()` 拿 `PUSH_SCHEMAS` 校验推送载荷，不匹配时
**`console.error` 而不是抛** —— 一条坏推送不该让主进程崩掉，但必须留下痕迹。

**错误映射**（`errors.ts`）：`AppError` / `NotFoundError`；`toEnvelope` 把 SqliteError 的
errcode **2067 / 1555 / 787** 映射成 `E_CONFLICT` / `E_CONFLICT` / `E_FK_MISSING`，
其余 `E_INTERNAL`。`safeDetail` 对 detail 做一次 JSON 往返。

**⚠️ 一处如实记录的边界**：`system-capabilities.ts`（`shell:revealPath`）
的文件头明写：这个通道让渲染进程可以要求主进程打开**任意路径** ——
「免得日后有人以为这是一道被守住的闸门」。

---

## 10. 渲染层的七条规则与「抑制」机制

`design.md` §4.7 定了七条渲染规则。它们的共同目标只有一句：
**30Hz 的流式更新不许把整张消息列表拖下水。**

| # | 规则 | 落地形态 |
|---|---|---|
| 1 | `<MessageList>` 不随 delta 重渲染 | 只订阅 `order[workspaceId]` |
| 2 | `<MessageRow>` 只订阅自己那条消息 | `messages[id]` + `historyBuffers[id]` |
| 3 | **只有一个**组件以 30Hz 重渲染 | `<StreamingRow>`，且 M6b **收得更紧**：它自己也不随 delta 重渲染，只有 `<StreamingText>` 里的那一个 `<p>` 会 |
| 4 | 思考 delta 不触发正文节点重渲染 | `text` / `thinking` 是两个字段、两个组件、两个原子订阅 |
| 5 | 不在每次 delta 重解析 Markdown | ⚠️ **尚未实现** —— M6b 连解析都不做，渲染原始文本 |
| 6 | 语法高亮只在 `done` 时跑 | ⚠️ **尚未实现** —— 不装 Shiki（见 §14） |
| 7 | `done` 时把缓冲折叠成一条历史行 | 见下 |

规则 3 的收紧记在 §4.7 上；实测数字（M6b 走查）：

| 场景 | 结果 |
|---|---|
| 流式期间 `<MessageList>` 重渲染 | **0** 次 |
| 30Hz 隔离 | 17 次重写 vs 已落定的卡片 **0** 次 |
| 一批 12 个批次，DOM 32 字 / 帧 32 字 | 一致 |
| 场景 3：界面 173 字 vs 收到 9 字 | **164 字只可能来自 `stream:resume`** |
| 成本 | `$0.0000 → $0.3279` |
| 聚合 | `{turnCount:2, costUsd:0.327943, tokensIn:38914, tokensOut:1477, turnsWithoutUsage:0}` |
| 终态行落库 | 比 `done` 帧晚 **252 ms** |

### 10.1 ★ 折叠那一节：为什么不能收到 `done` 就折叠

`done` 帧说的是「这一轮的正文结束了」；`stream:status` 的终态说的是
「`turn` 行现在是终态」。**它们相差 249–377ms，正好是两个不同的事实，不是重复。**

而库里那一行是**后**落定的那一个 —— 在 `done` 时就折叠，会让界面先闪回一条
**还没有正文的历史行**。所以规则 7 的落地形态是：

> **折叠发生在 `stream:status` 的终态推送那一支，而不在 `done` 帧。**

执行顺序是**硬的**：

```
① 先把历史读回来（message:list）   ← 此刻 content_text 才是完整的
② 再丢缓冲
③ 最后记 recentlyFinished
```

### 10.2 ★ 抑制：为什么「重放」与「历史」永远不会同时出现

三条机制叠起来，就得到了「不需要任何去重逻辑」这个结果：

1. **只有一个归约器。** 实时帧与历史行都折进 `frame-buffer` 的同一个 `applyFrames`
   —— 于是同一个轮次在两种路径下长得**完全一样**，没有「某些字段只在一条路径上不同」
   这种自动测试抓不到的错。
2. **有缓冲才抑制历史行。** 一个轮次只要有缓冲，它的历史消息就**不进** `<MessageList>`，
   那个轮次由 `<StreamingRow>` 单独呈现。反向也成立：没有缓冲就照常显示历史行 ——
   **那是正确的降级**（`content_text` 就是这一轮到目前为止的正文）。
3. **缓冲的正文只来自帧。** 所以「先用历史播种、再追加帧」这种会安静地重复或缺口
   的写法被结构性地排除了。

**抑制发生在推送层，不发生在渲染层**：`emitFrames` 按 `workspaceId` 抑制
（不在当前视图里的空间不推帧），而 `retain()` 跑在 `commit()` **里、`emitFrames` 之前**
—— 于是「被抑制」不等于「被丢弃」，切回来还能重放。`stream:status` **从不抑制**。

---

## 11. 测试与走查

### 11.1 `npm test` —— 458 个用例，8.5 秒，零成本

```
test/adapter/   claude-adapter(344) cli-locator(160) project-context(241) stream-json-parser(757)
test/domain/    scheduler(473) tool-diff(188) turn-cwd(145)
test/ipc/       delete(344) errors(188) import(449) registry(538) schemas(192)
                space-dir(157) turn(462) workspace-dir(194) helpers(475)
test/persist/   migrations(181) repositories(535) schema(382) turn-usage(204)
test/process/   child-registry(375) event-batcher(1033)
test/shared/    frame-buffer(338) history(286) patch-lines(79) timeline(174) watermark(399)
```

**这套测试靠三件事才跑得起来**（新写测试时会用到）：

1. **裸 Node 的原生类型剥离** —— 不转换、不打包。代价是相对 import 要写 `.ts`，
   且不能用 `enum` 与构造函数参数属性。
2. **真 spawn，假 CLI。** `CliLaunch` 注入点让适配层测的是真的 stdio、真的解析、
   真的中断阶梯，只有那个 237MB 的二进制是假的。
3. **纯逻辑外置。** `src/shared/live/` 与 `src/main/domain/` 里的东西不需要 DOM、
   不需要数据库、不需要 Electron。

**测试的写法有一条纪律**：用例名写「**为什么**这条重要」，而不是「测了什么函数」。
例如 `★★ 同一轮的后续批次不许把 fromStart 翻掉（这条错了界面会静默停更）`。
带 `★` 的是「错了不会报错」的那类。

### 11.2 走查（真机验收）

实机验收手法（M3 起沿用）：用 `--remote-debugging-port` + `--user-data-dir=<沙箱>`
起一个**独立实例**，用 DevTools Protocol 驱动真实窗口，脚本留在 `scripts/` 里当证据。

| 脚本 | 行数 | 做什么 |
|---|---|---|
| `scripts/m4-walkthrough.cjs` | 582 | 空间/项目/成员管理的端到端 |
| `scripts/m5-probe.ts` | 1096 | **真 CLI 探针**（会花钱，`--max-budget-usd 0.50` 硬闸） |
| `scripts/m6a-pipeline-walkthrough.ts` | 1579 | 主进程管道（零界面） |
| `scripts/m6b-walkthrough.ts` | 2774 | 流式对话界面（五个场景，两轮真 CLI） |
| `scripts/check-page-helpers.cjs` | 69 | 见下 |

**★ `check:helpers` 为什么必须存在**：这看起来像个边角料，其实是个真陷阱 ——
**`tsc` 不会检查模板字符串里面的东西**。走查脚本里有一大段**在页面里执行**的 JS
（写成模板字符串），它绕过整个类型系统。所以那段代码由
`scripts/check-page-helpers.cjs` 单独静态检查一遍。

**归档与重判**：走查的原始输出（`events.jsonl` / `batches.jsonl` / `db-*.json` /
原始 NDJSON / app 日志）落在 `scripts/evidence/<里程碑>-<时间戳>/`，
**自 M5 起进版本库**（`.gitattributes` 里 `-text` 保持逐字节原样）。
理由：它是 `design.md` 里那些实测数字的唯一来源。

**断言只写在 `report()` 里，而 `report()` 只读归档** —— 于是
`npm run walk:m6b:replay -- --archive=<dir>` 能**零成本重判**任何一次历史运行。

⚠️ **两个里程碑在这里刻意不同，而差别会走火**：

- `walk:m6a:replay` **就是** `walk:m6a` 本身 —— 漏掉 `--archive=<目录>` 时
  它会照常跑一次真 CLI（**花钱**）。
- `walk:m6b:replay` 没有 `--archive` 时**直接报错退出**，不采集。

M6b 把默认反过来不是洁癖，理由逐字记在脚本里：「一个叫 replay 的命令在打错字时花钱，
是这把枪自己走火。」

⚠️ 一条坑：根 `.gitignore` 有全局 `*.log`，所以归档里的 app 日志/console.log
**被静默挡在版本库外**（报告不读它们，故结论不受影响）——
日后有结论要靠 app 日志时，必须先补 `.gitignore` 的否定规则。

### 11.3 ⚠️ 一条诚信纪律：缺证据不许打勾

走查报告里**不允许**「没采集到 → 打 ✅」这种形态。缺证据就是缺证据，
报告必须说清是**哪一项**没采到，而不是让整份报告看起来通过。
同理，**采集失败要报告「采集本身在哪一步失败的」**，而不是笼统地报一句失败。

---

## 12. 里程碑地图

| 里程碑 | 内容 | commit |
|---|---|---|
| M0–M2 | 外壳 + 视觉验证、SQLite 落地、DDL | `2e61f7e` |
| M3 | 空间与项目的 IPC 全链路 | `9e857c6` / `f3f2a72` |
| M4 | 成员、会话、空间目录、删除流程 | `72e35ab` / `baa2a35` |
| M5 | **适配层**：spawn CLI、解析、中断阶梯、探针实测 | `40f3c86` |
| M6a | **主进程管道**：调度器 + 执行器 + 合批器 + 落库 + `turn:send`/`stream:resume` + `file_diff`，**零新界面** | `5f1c6c8` |
| M6b | **流式对话界面**：`live` slice + 流式渲染 + 历史重放 + 成本常驻 + `stream:status` 的生产者 | `ea3d546` |
| **M7**（下一个） | `context-builder`：`@` 派发 + 历史上下文数组化 + 压缩 | — |
| M8–M11 | 见 `design.md` §六 | — |

**M7 的三件已知债，来源都在代码注释里**：

1. **多轮历史**：`turn-runner` 只传这一轮的 user 消息，`systemPrompt` 是空串
   → 同一会话的第二轮不记得第一轮。
2. **`@` 派发**：`Composer` 的成员是**选**的，不从文本解析。
3. **`renderTurnInput` 的临时实现**：往 stdin 只写一条 user 消息。
   注释逐字：「**M5 这一处是暂时违反 §4.6 的，不是满足它。** 记进待办，
   别让它安静地变成 M7 的既成事实。」

---

## 13. 常见改动怎么做

**加一个 IPC 通道**（护栏会替你把该改的地方找出来）：

1. `src/shared/ipc/channels.ts` 加进 `INVOKE_CHANNELS`；
2. `src/shared/ipc/schemas.ts` 加 schema；
3. `src/main/ipc/handlers/<域>.ts` 写 handler；
4. `src/main/ipc/handlers/index.ts` 分类成 handle 或 defer；
5. **preload 不用改**（它从 `channels.ts` 派生白名单）。

三处护栏会自动检查：`test/ipc/schemas.test.ts`（schema 的键必须与通道清单**逐字一致**）、
`test/ipc/registry.test.ts`（每个通道必须被显式分类，`seal()` 时数量要对得上）。
**漏了第 4 步是启动即炸**，不是「用户点下去才发现」。

**加一条推送**：`PUSH_CHANNELS` 是**刻意很短**的清单（现在四条）。
加之前先问「现有的四条里有没有一条的信号恰好同步」——
`stream:status` 兼作运行时概要的变更信号就是这么来的。加了之后记得
`usePushNotices.ts` 是唯一订阅点。

**加一种帧（`StreamFrame` 的新变体）**：

1. `schemas.ts` 的判别联合加一格；
2. `frame-buffer.ts` 的 `applyFrame` 加 `case` —— ★ **`default` 分支不许删**；
3. `history.ts` 的 `eventToFrame` 加映射（如果它要落库）；
4. 如果要落库：`message_event` 的 `kind` 枚举（DDL + `EVENT_KINDS`）+ 一条迁移。

**改渲染层的某个判断**：先问「这个判断错了会不会报错」。
不会报错就把它搬到 `src/shared/live/` 写成纯函数并加用例 ——
`timeline.ts` / `patch-lines.ts` / `watermark.ts` 都是这么从组件里搬出来的。

**调时序参数**：`DEFAULT_BATCH_TIMINGS`（`event-batcher.ts`）一处集中。
⚠️ 改 `flushMs` 之前先读 §5.2 那三条 `seq` 的推论。

**改 DDL**：写一条新迁移（不许改既有的 `0001-init.ts`）。
改完跑 `npm test` —— `assertDdlEnumsMatch` 会检查 DDL 的 `CHECK` 与 TS 枚举是否逐字一致。

---

## 14. 已知不做 / 已知有损（诚实清单）

这一节是本文档最重要的一节。上面每一处「我们知道它不完整」都汇总到这里，
**不是遗漏，是有记录的选择**。

### 14.1 装了对吧，但没用

- **`@tanstack/react-virtual`（3.14）与 `motion`（13.4）装在 `devDependencies` 里，
  但 `src/` 里零使用实例。** 全仓 grep 确认。

### 14.2 对 `design.md` 的**偏离**（文档说要有、实现里没有）

照 M6a 记偏差的先例，都逐字记在 §4.8 与 §六里：

- **不装 Shiki。** §4.8 原文写着「**语法高亮用 Shiki 且只在 `done` 时跑**」——
  **没有落地**。代码块走等宽。理由：M6b 的验收是「看得见流式输出」，不是「高亮好看」；
  不装 Shiki 就零新依赖。
  ⚠️ 这是**偏离文档**，不是文档没写 —— 不记下来的话，下一个读 §4.8 的人会以为高亮已经有了。
- **光环不旋转。** §4.8 技巧 3 的后半（`conic-gradient` + `transform: rotate()`）**不做**：
  活跃角色的光环**存在**（复用既有的静态 `.neon-halo`），只是不动。
  这一节真正关心的是「animate 渐变会让元素每帧重绘」，而我们干脆不动画它
  —— 是更省的那一边。
- **不做 Markdown 渲染。** §4.7 规则 5 只要求「不在每次 delta 重解析」，
  M6b 连解析都不做（流式期间渲染原始文本）。
- **§4.7 规则 5 与规则 6 至今未实现**（同上，见 §10 的表）。

### 14.3 功能缺口（属于后面的里程碑）

- **不能停止一个正在跑的轮次**：`turn:stop` 的 `running` 分支返回 `E_NOT_IMPLEMENTED`
  带 `milestone:'M9'`。`turn:interject` 与 `turn:stopAll` 是显式 `defer`。
- **不能 `@` 派发**：`Composer` 用成员选择器。`@` 派发是 M7。
- **第二轮不记得第一轮**：`turn-runner` 只传这一轮的 user 消息，`systemPrompt` 是空串。
- **不做历史上下文拼接**：M7 的 `context-builder`。
- **`collectProjectContext` / `projectContextSources` 零生产调用**（见 §6.3.7）。
- **`codex` 没有适配器**：`registry.ts` 的表里是 `null`，调用方会得到一句人话。
- **`AGENT_ERROR_CODES` 里 4 个码零生产点**（`protocol` / `parse` / `budget_exceeded` /
  `aborted`，见 §7.1）。
- **`readControlResponse()` 零调用者**（见 §6.3.6）。

### 14.4 有损 / 降级（做了，但会丢东西，且都记着）

- **`thinking_end` 不落库**，所以从历史拼出来的缓冲没有「思考分段」这个事实。
  代价：历史里看不出「这段思考之后模型还说了话、之后又想了第二段」的边界。
  这是**已知的有损**。
- **`blob_path` 恒为 `NULL`**（M6a 偏差一的延续）。超 256KB 的工具输出在帧上是
  **截断过的**，展开也只能拿到截断版。
- **新进程打开一个已经在跑的轮次** → 不建缓冲、退化成历史行，
  而历史行**在轮次结束前不再增长**。这是已知的、正确的降级（代价记在文档里）。
- **在途轮次的排序是一个已知的粗略**：多个成员同时跑时，先后按「谁先被建起缓冲」定，
  不是任何数据库里的序号。落定后按 `message.seq` 归位。
- **贴底跟随刻意做得粗**：30Hz 精确跟随是后面里程碑的事。

### 14.5 边界声明（⚠️ 措辞纪律）

这几条**必须在 UI 与文档里说准**，说错一个字就是在误导用户：

- **可见项目是上下文裁剪，不是安全机制。** §8.4：agent 有 shell，
  `--add-dir` 之外的东西它一样读得到。UI 上不得宣传为权限控制。
- **关于硬底 deny 列表，只能说「能静态判定的路径是硬的，动态构造的不是」**
  —— **绝不能**把它说成「安全」。这是一条被两处常驻 UI 说明固定在界面上的措辞
  （`MemberDetail.tsx`）。
- **数据位置（`userData`）是**可移植性**决定，不是安全决定。**
  agent 能读到它；我们不假装能解决它。
- **成本是「估算」不是账单**（§2.4-2）。走第三方端点时 `total_cost_usd` 的数值是错的。
- **`shell:revealPath` 让渲染进程可以要求主进程打开任意路径** ——
  「免得日后有人以为这是一道被守住的闸门」。

### 14.6 一条关于「走查覆盖」的诚实

`docs/design.md` §六上记着一句：**M6b 走查之后、进库之前还改了一处
（`ui.select()` 顺手切回 `overview`），而它不在上面任何一次运行的覆盖里**。
> **这一条是读代码时发现的，不是走查抓到的。**

也就是说：这份文档里所有的实测数字都来自归档，而**代码库此刻的状态比那些归档新一点**。

---

## 附：给新人的三条读码建议

1. **从 §4 那条链开始，只读那 12 个文件**（`Composer` → `handlers/turn` →
   `scheduler` → `turn-runner` → `claude-adapter` → `stream-json-parser` →
   `event-batcher` → `electron-transport` → `usePushNotices` → `store/live` →
   `frame-buffer` → `StreamingText`）。这一遍读完，剩下的都是枝叶。
2. **看到 `★` 就停下来读那一段注释。** 这个项目的注释密度是刻意的：
   带 `★` 的地方都是「曾经错过一次，或者错了不会报错」的地方。
   `★★` 的那几条更是用真实的损失换来的。
3. **遇到「这里为什么不直接 X」时，答案通常在同一个文件的文件头里。**
   这个项目有一个稳定的习惯：每个 `★` 决策都在被它约束的那个文件的头部
   记着完整论证，包括**被否决的那个方案**和**否决它的具体代价**。
