# code-chat

多角色 AI 协作编码桌面应用。在一个「空间」里为多个有角色设定的 AI 成员各自绑定
agent / 模型 / 职责文件 / 可见项目，在一条空间级时间线上对话，回答流式呈现。

Electron + React + TypeScript，**零运行时依赖**（所有包都在 `devDependencies`），
权威数据在 `node:sqlite`。

---

## 文档

| 文档 | 是什么 | 什么时候读 |
|---|---|---|
| [`docs/design.md`](docs/design.md) | **权威决策日志**（§编号）。每条设计决策「为什么这样定」，含被否决的方案与代价 | 改设计之前；想知道某条约束的来历 |
| [`docs/architecture.md`](docs/architecture.md) | **实现走读**。逐模块讲「代码现在长什么样、为什么必须那样写」，面向刚接触项目的人 | **第一次读代码，从这里开始** |

两份冲突时以 `design.md` 为准。

---

## 快速开始

```bash
npm install
npm run dev        # 开发（electron-vite dev，热更新）
npm run build      # typecheck(node+web) + electron-vite build
npm test           # 458 个用例，裸 Node，不联网不花钱，约 8.5 秒
npm run typecheck  # 两个 tsconfig 各跑一遍 tsc --noEmit
npm run pack       # 打包（--dir，不生成安装器）
npm run dist       # 出安装包
```

跑真实对话需要本机装了 Claude Code CLI，且**它自己的凭据配置是好的** ——
应用不动 `ANTHROPIC_*` 环境变量，原样继承。找不到 CLI 时会给出「找过哪些地方」的
可照做提示，不会静默失败。

---

## ⚠️ 会花钱的命令

| 命令 | 花费 |
|---|---|
| `npm test` / `npm run typecheck` / `npm run build` | 0 |
| `npm run walk:m6a:dry` / `walk:m6b:dry` | 0（假 CLI） |
| `npm run walk:m6a:replay -- --archive=<dir>` | 0（拿既有归档重判） |
| `npm run walk:m6a` / `walk:m6b` | **真 CLI，两轮** |
| `npm run probe:m5` | **真 CLI，单轮**（`--max-budget-usd 0.50` 硬闸） |

★ **花钱的走查必须先跑 `--dry`。** 这不是客气话：M6a 的头两次 `--dry` 各抓出一个
会让后面所有结论失去意义的缺陷，代价为零。

⚠️ **一个已经记录在案的走火形状**：`walk:m6a:replay` 就是
`walk:m6a` 本身 —— **漏掉 `--archive=<目录>` 时它会照常跑一次真 CLI**。
M6b 把默认反了过来（`walk:m6b:replay` 没有 `--archive` 时**直接报错退出**），
理由是「一个叫 replay 的命令在打错字时花钱，是这把枪自己走火」。
跑之前请把归档目录补全。

走查的原始归档落在 `scripts/evidence/<里程碑>-<时间戳>/` 并**进版本库**
（`design.md` 里那些实测数字的唯一来源）；报告被设计成归档的纯函数，
所以 `replay` 能零成本重判任何一次历史运行。

---

## 目录一瞥

```
src/main/      主进程：infra → persist → adapters → domain → process → ipc
src/preload/   渲染进程唯一的对外窗口（两个泛型函数，白名单从 channels.ts 派生）
src/renderer/  渲染进程：store(entity/ui/live) + hooks + components
src/shared/    三个进程共用：契约（ipc/）+ 纯逻辑（live/）
test/          镜像 src/ 那侧的目录结构
scripts/       探针与真机走查 + scripts/evidence/ 归档
```

三条边界规则、以及「一条消息从点发送到屏幕上的 12 步」，
见 [`docs/architecture.md`](docs/architecture.md) §3 与 §4。

---

## 进度

**M0–M6b 已完成**。当前是**流式对话可用**：能发一轮、看得见 token 流出来、
切走再切回能接上、硬杀重开历史完整、成本常驻显示（标注「估算」）。

**下一个里程碑是 M7**（`context-builder`）：`@` 派发 + 历史上下文数组化 + 压缩。
今天的已知缺口里最要紧的一条是**同一会话的第二轮不记得第一轮** ——
`turn-runner` 只传这一轮的 user 消息，`systemPrompt` 是空串。

完整的「已知不做 / 已知有损」清单见 `docs/architecture.md` §14。

---

## 边界声明（不要读错这些）

- **成员对项目的可见性是上下文裁剪，不是安全机制。** agent 有 shell，
  `--add-dir` 之外的东西它一样读得到。
- **关于硬底 deny 列表，只能说「能静态判定的路径是硬的，动态构造的不是」**
  —— 不能说成「安全」。
- **数据放在 `userData` 是可移植性决定，不是安全决定。**
- **成本那个数是估算，不是账单。** 走第三方端点时 `total_cost_usd` 的数值是错的。
