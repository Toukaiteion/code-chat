/**
 * 0001 —— 阶段一的完整 schema（方案 §4.2）。
 *
 * 修订记录：
 * - 2026-09-23 依据 §8 定稿：新增 `member_project`（§8.4），删除
 *   `workspace_member.working_paths_json`，`project.origin` 扩为三值（§8.2）。
 */
import type { Migration } from './types.ts'

const up = /* sql */ `
-- 注：schema_migrations **不在这里**创建。它是迁移器自己的基础设施，
-- 由 runMigrations 通过 LEDGER_DDL 负责 —— 否则「如何记录第 0 号迁移已应用」
-- 会变成鸡生蛋问题，且每个新迁移都不得不重复这段 DDL。
-- （也不要在这个模板串里写反引号 —— 它会终止模板。踩过一次。）

-- ─────────────────────────────────────────────────────────────
-- 工作空间 / 项目
-- ─────────────────────────────────────────────────────────────
CREATE TABLE workspace (
  id                TEXT PRIMARY KEY,
  name              TEXT    NOT NULL,
  -- cwd 的二级兜底（§8.5b），**非权威**。成员没设主项目时才轮到它。
  active_project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER
);

CREATE TABLE project (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT    NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  -- ★ 三种导入方式（§8.2）。local = 原地引用用户目录，删空间时**绝不动它**。
  root_path      TEXT    NOT NULL,
  origin         TEXT    NOT NULL CHECK (origin IN ('clone','local','copy')),
  remote_url     TEXT,
  default_branch TEXT,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER,
  -- 防止同一目录被加两次
  UNIQUE (workspace_id, root_path)
);
CREATE INDEX idx_project_workspace ON project(workspace_id);

-- ─────────────────────────────────────────────────────────────
-- 角色（全局的「人」，不属于任何空间）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE actor (
  id           TEXT PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  avatar       TEXT,
  agent_kind   TEXT    NOT NULL DEFAULT 'claude' CHECK (agent_kind IN ('claude','codex')),
  -- ★ 自由文本，**不是枚举**。用户的 settings.json 会把别名映射到第三方端点（§2.4）。
  model        TEXT    NOT NULL,
  effort       TEXT    NOT NULL DEFAULT 'high'
                       CHECK (effort IN ('low','medium','high','xhigh','max')),
  persona_path TEXT    NOT NULL,
  -- hash 用于缓存键 + 「可缓存前缀是否合法变更」的检测（§4.6）
  persona_hash TEXT    NOT NULL,
  skills_json  TEXT    NOT NULL DEFAULT '[]',
  memory_json  TEXT    NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- 成员（角色 × 空间）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE workspace_member (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT    NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  actor_id        TEXT    NOT NULL REFERENCES actor(id)     ON DELETE CASCADE,
  display_name    TEXT    NOT NULL,
  role_desc_path  TEXT,
  role_desc_hash  TEXT,
  permission_json TEXT    NOT NULL DEFAULT '{}',
  is_router       INTEGER NOT NULL DEFAULT 0 CHECK (is_router IN (0,1)),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (workspace_id, actor_id)
);
CREATE INDEX idx_member_workspace ON workspace_member(workspace_id, enabled);
-- 偏索引把「每空间至多一个路由角色」交给 DB 保证，而非应用层代码（§3.2）
CREATE UNIQUE INDEX idx_member_router ON workspace_member(workspace_id) WHERE is_router = 1;

-- ★ 成员可见项目 + 主项目（§8.4）。
-- 语义：**没有行的成员 = 可见空间内全部项目**（默认）。有行 = 只看到这些。
-- 这是**上下文裁剪，不是安全边界** —— 见 §8.4 的边界声明。
-- 刻意**没有** access / read_only 列：用户明确不要只读（§8.1），
-- 加一个无法执行的列比不加更糟 —— 它会变成一句兑现不了的承诺。
CREATE TABLE member_project (
  member_id  TEXT    NOT NULL REFERENCES workspace_member(id) ON DELETE CASCADE,
  project_id TEXT    NOT NULL REFERENCES project(id)          ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, project_id)
);
-- 每成员至多一个主项目 → 决定 cwd（§8.5b）
CREATE UNIQUE INDEX idx_member_primary ON member_project(member_id) WHERE is_primary = 1;

-- ─────────────────────────────────────────────────────────────
-- 会话
-- ─────────────────────────────────────────────────────────────
CREATE TABLE session (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT    NOT NULL REFERENCES workspace(id)          ON DELETE CASCADE,
  member_id             TEXT    NOT NULL REFERENCES workspace_member(id)   ON DELETE CASCADE,
  turn_count            INTEGER NOT NULL DEFAULT 0,
  last_seq              INTEGER NOT NULL DEFAULT 0,
  compacted_through_seq INTEGER NOT NULL DEFAULT 0,
  rolling_summary       TEXT,
  created_at            INTEGER NOT NULL,
  last_active_at        INTEGER,
  -- 与 WorkspaceMember 1:1
  UNIQUE (workspace_id, member_id)
);
CREATE INDEX idx_session_workspace ON session(workspace_id);

-- ─────────────────────────────────────────────────────────────
-- 轮次
-- ─────────────────────────────────────────────────────────────
-- 为什么 turn 是必需的：PID、排队位置、退出码、成本、跳数都需要地方挂。
-- 「停止单个运行中的角色」与崩溃后孤儿清理**没有东西可以 key on**。
CREATE TABLE turn (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT    NOT NULL REFERENCES session(id)   ON DELETE CASCADE,
  workspace_id       TEXT    NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  trigger_message_id TEXT REFERENCES message(id) ON DELETE SET NULL,
  status             TEXT    NOT NULL
                             CHECK (status IN ('queued','running','done','interrupted','failed','cancelled')),
  -- ★ 跳数计数器（§3.3）。**绝不进入提示词上下文** ——
  -- 压缩只压对话内容，不压控制状态。
  hop_depth          INTEGER NOT NULL DEFAULT 0,
  -- 本轮解析出的工作目录（§8.5b 三级兜底的产物）
  cwd                TEXT    NOT NULL,
  pid                INTEGER,
  exit_code          INTEGER,
  error_text         TEXT,
  cost_usd           REAL,
  tokens_in          INTEGER,
  tokens_out         INTEGER,
  terminal_reason    TEXT,
  queued_at          INTEGER NOT NULL,
  started_at         INTEGER,
  ended_at           INTEGER
);
CREATE INDEX idx_turn_session_status ON turn(session_id, status);
-- ★ 启动时孤儿清扫用的索引：任何仍处于 queued/running 的轮次都是上次硬杀留下的
CREATE INDEX idx_turn_running ON turn(status) WHERE status IN ('queued','running');
CREATE INDEX idx_turn_workspace_started ON turn(workspace_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 消息 / 消息事件
-- ─────────────────────────────────────────────────────────────
CREATE TABLE message (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT    NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- NULL = 空间流里的用户消息（不属于任何角色的 session）
  session_id       TEXT REFERENCES session(id) ON DELETE CASCADE,
  turn_id          TEXT REFERENCES turn(id)    ON DELETE SET NULL,
  role             TEXT    NOT NULL CHECK (role IN ('user','assistant','system')),
  author_member_id TEXT REFERENCES workspace_member(id) ON DELETE SET NULL,
  -- 空间时间线内的单调序号：全序、keyset 分页、廉价 <recent> 窗口（§4.2）
  seq              INTEGER NOT NULL,
  content_text     TEXT,
  content_path     TEXT,
  content_bytes    INTEGER NOT NULL DEFAULT 0,
  -- ★ 结构化 mention（§3.1）。运行时**永不**从文本解析。
  mentions_json    TEXT    NOT NULL DEFAULT '[]',
  inject_mode      TEXT    NOT NULL DEFAULT 'full'
                           CHECK (inject_mode IN ('full','summary','excluded')),
  summary_text     TEXT,
  created_at       INTEGER NOT NULL,
  edited_at        INTEGER,
  deleted_at       INTEGER
);
CREATE UNIQUE INDEX idx_message_ws_seq ON message(workspace_id, seq);
CREATE INDEX idx_message_session_created ON message(session_id, created_at);
CREATE INDEX idx_message_retention ON message(created_at) WHERE deleted_at IS NULL;

-- ★ 关键性质（§4.2）：thinking 块**只存在于这张表**。
-- 上下文装配只读 message，**从不读 message_event**，
-- 所以推理内容是**结构性排除**的 —— 没有可以忘写的谓词，
-- 也没有任何未来的查询能把思维链泄漏进另一个角色的提示词。
CREATE TABLE message_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   TEXT    NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN
                 ('thinking','text','tool_start','tool_result','file_diff','usage','error','done')),
  tool_use_id  TEXT,
  tool_name    TEXT,
  payload_json TEXT,
  text_blob    TEXT,
  blob_path    TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  ok           INTEGER,
  truncated    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_event_message_seq ON message_event(message_id, seq);
CREATE INDEX idx_event_retention ON message_event(kind, created_at);
`

export const migration0001: Migration = {
  version: 1,
  name: 'init',
  up
}
