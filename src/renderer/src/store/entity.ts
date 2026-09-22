/**
 * `entity` slice —— **规范化之后的领域实体**，以及改变它们的全部动作。
 *
 * 三条纪律：
 *
 * 1. **规范化**：`workspaces` 是 `Record<id, Workspace>` + 一份顺序数组。
 *    同一个空间在界面上出现三次（切换器、顶栏、详情），三份拷贝迟早会互相矛盾。
 * 2. **动作写在 slice 里**，组件只调动作、不直接 `api.*`。于是「改完之后怎么刷新」
 *    只有一处实现，组件里不会散落十几个 `await` + `setState` 的小剧本。
 * 3. **失败不抛**：动作返回 `null` / `false`，错误经 `toNotice` 进 `ui.notices`。
 *    调用点因此只需要判「成了没成」，不需要写 try/catch。
 *
 * 键的命名跟通道对齐（`'workspace:create'`），这样日志里一眼能对上是哪一步挂了。
 */
import { api } from '../ipc'
import type { Actor, Project, Workspace, WorkspaceMember } from '@shared/entities'
import type { ResOf } from '@shared/ipc/contract'
import type { Notice, Slice } from './index'
import { toNotice } from './ui'

/** 从契约推导，**不手抄** —— schema 改了这里跟着改。 */
export type DeleteReport = ResOf<'workspace:delete'>
export type CopyRemoval = DeleteReport['copies'][number]
export type Visibility = ResOf<'member:visibility'>
export type SpacePathsView = ResOf<'workspace:paths'>

export interface EntitySlice {
  // ── 规范化实体 ──
  workspaces: Record<string, Workspace>
  workspaceOrder: string[]
  /** 空间 id → 它的项目列表（含顺序）。 */
  projectsByWorkspace: Record<string, Project[]>
  /** 空间 id → 它的磁盘目录信息（`workspace:paths`）。**默认不查** —— 只在要看时才查。 */
  pathsByWorkspace: Record<string, SpacePathsView>
  /** 角色是**全局**的，不属于任何空间（§2.4）。 */
  actors: Actor[]
  membersByWorkspace: Record<string, WorkspaceMember[]>
  /** 成员 id → 可见性。**按需加载**：只有打开详情面板时才拉。 */
  visibilityByMember: Record<string, Visibility>

  // ── 动作：工作空间 ──
  loadWorkspaces(): Promise<void>
  createWorkspace(name: string): Promise<Workspace | null>
  renameWorkspace(id: string, name: string): Promise<boolean>
  deleteWorkspace(id: string, deleteCopies: boolean): Promise<DeleteReport | null>
  setActiveProject(workspaceId: string, projectId: string | null): Promise<boolean>
  loadWorkspacePaths(id: string, ensure?: boolean): Promise<void>

  // ── 动作：项目（三种导入方式）──
  loadProjects(workspaceId: string): Promise<void>
  addLocalProject(input: {
    workspaceId: string
    name: string
    rootPath: string
  }): Promise<Project | null>
  copyProject(input: {
    workspaceId: string
    name: string
    sourcePath: string
    targetPath: string
  }): Promise<Project | null>
  cloneProject(input: {
    workspaceId: string
    name: string
    remoteUrl: string
    targetPath: string
    defaultBranch?: string | null
  }): Promise<Project | null>
  renameProject(id: string, name: string): Promise<boolean>
  removeProject(id: string, deleteCopy: boolean): Promise<boolean>
  /**
   * 默认落点 `＜空间目录＞/projects/＜项目名＞`（§8.3）。
   * **只算路径，不建目录**（主进程那边也是纯计算）—— 用户还能改，建了就是白建。
   * 返回 `null` 表示没算出来（错误已进通知）。
   */
  defaultTarget(workspaceId: string, name: string): Promise<string | null>

  // ── 动作：角色（全局）──
  loadActors(): Promise<void>
  createActor(input: {
    name: string
    model: string
    personaPath: string
    agentKind?: Actor['agentKind']
    effort?: Actor['effort']
    avatar?: string | null
  }): Promise<Actor | null>
  updateActor(input: {
    id: string
    name: string
    model: string
    effort: Actor['effort']
    agentKind: Actor['agentKind']
    avatar?: string | null
  }): Promise<boolean>
  setActorPersona(id: string, personaPath: string): Promise<boolean>
  removeActor(id: string): Promise<boolean>

  // ── 动作：成员（actor × 空间）──
  loadMembers(workspaceId: string): Promise<void>
  createMember(input: {
    workspaceId: string
    actorId: string
    displayName: string
    roleDescPath?: string | null
  }): Promise<WorkspaceMember | null>
  removeMember(id: string): Promise<boolean>
  setMemberEnabled(id: string, enabled: boolean): Promise<boolean>
  setMemberRouter(id: string, isRouter: boolean): Promise<boolean>
  setMemberRoleDesc(id: string, roleDescPath: string | null): Promise<boolean>

  // ── 动作：可见性（§8.4）──
  loadVisibility(memberId: string): Promise<void>
  setVisibility(
    memberId: string,
    projectIds: string[],
    primaryProjectId: string | null
  ): Promise<boolean>
  clearVisibility(memberId: string): Promise<boolean>

  // ── 动作：宿主能力 ──
  revealPath(path: string): Promise<boolean>
}

// ─────────────────────────────────────────────────────────────
// 报告 → 人话
// ─────────────────────────────────────────────────────────────

/**
 * 一个副本目录的处置结果 → 一句中文。
 *
 * ★ 四种状态**分开说**，因为它们是四件不同的事：「我们删掉了」「本来就不在」
 * 「按你的意思没删」「想删没删掉」。压成「成功/失败」两个词，用户就分不清
 * 「我没勾」和「删失败了」—— 而这里动的是他真实的目录。
 */
export function describeCopy(c: CopyRemoval): string {
  switch (c.state) {
    case 'removed':
      return '副本目录已删除'
    case 'absent':
      return '副本目录本来就不在磁盘上'
    case 'kept':
      return `保留了副本目录${c.reason ? `（${c.reason}）` : ''}`
    case 'failed':
      return `副本目录没删掉：${c.reason ?? '未知原因'}`
  }
}

/**
 * 删空间的结果 → 一条通知。
 *
 * `detail` 是多行文本（`NoticeBar` 用 `whitespace-pre-line` 渲染）——
 * 里面必须出现**空间目录留在哪**：用户把工作空间根目录选在了 `userData`，
 * 那是个资源管理器里看不见的地方，「东西还在，在这里」是我们欠他的交代。
 */
export function summarizeDeleteReport(name: string, report: DeleteReport): Omit<Notice, 'id' | 'at'> {
  const count = (state: CopyRemoval['state']): number =>
    report.copies.filter((c) => c.state === state).length
  const failed = report.copies.filter((c) => c.state === 'failed')

  const lines = [
    `项目副本：已删除 ${count('removed')} · 保留 ${count('kept')} · 本来就不在 ${count('absent')} · 删除失败 ${count('failed')}`,
    report.workspaceDir
      ? `空间目录${report.workspaceDirExists ? '仍在磁盘上' : '已经不在磁盘上'}：${report.workspaceDir}`
      : '没有找到这个空间的目录记录'
  ]
  // 失败的逐条列出来（最多三条）——「有 1 个副本没删掉」而不给路径等于没说。
  for (const c of failed.slice(0, 3)) lines.push(`· 未删掉 ${c.path} —— ${c.reason ?? '未知原因'}`)
  if (failed.length > 3) lines.push(`· 还有 ${failed.length - 3} 个没删掉，详见日志`)

  return {
    level: failed.length > 0 ? 'warning' : 'info',
    message: `已删除工作空间「${name}」`,
    detail: lines.join('\n')
  }
}

// ─────────────────────────────────────────────────────────────
// 不可变小工具（模块级，避免每次 set 都重建）
// ─────────────────────────────────────────────────────────────

function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  const base = list ?? []
  const i = base.findIndex((x) => x.id === item.id)
  if (i === -1) return [...base, item]
  const next = base.slice()
  next[i] = item
  return next
}

function without<T extends { id: string }>(list: T[] | undefined, id: string): T[] {
  return (list ?? []).filter((x) => x.id !== id)
}

export const createEntitySlice: Slice<EntitySlice> = (set, get) => {
  /**
   * 动作外壳：**一处**管进行中标记、**一处**把异常翻译成通知。
   *
   * 每个动作手写一遍 `try/catch/finally` 是这类代码退化成噪音的头号原因，
   * 而且十个人会写出十种「出错时到底怎么办」。这里只有一种。
   */
  async function attempt<T>(
    key: string,
    what: string,
    fn: () => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    set((s) => ({ pending: { ...s.pending, [key]: true } }))
    try {
      return { ok: true, value: await fn() }
    } catch (err) {
      get().pushNotice(toNotice(err, what))
      return { ok: false }
    } finally {
      set((s) => ({ pending: { ...s.pending, [key]: false } }))
    }
  }

  /** 把一条实体写进规范化表。 */
  function putWorkspace(ws: Workspace): void {
    set((s) => ({
      workspaces: { ...s.workspaces, [ws.id]: ws },
      workspaceOrder: s.workspaceOrder.includes(ws.id)
        ? s.workspaceOrder
        : [...s.workspaceOrder, ws.id]
    }))
  }

  function findProjectWorkspace(projectId: string): string | null {
    for (const [workspaceId, list] of Object.entries(get().projectsByWorkspace)) {
      if (list.some((p) => p.id === projectId)) return workspaceId
    }
    return null
  }

  return {
    workspaces: {},
    workspaceOrder: [],
    projectsByWorkspace: {},
    pathsByWorkspace: {},
    actors: [],
    membersByWorkspace: {},
    visibilityByMember: {},

    // ── 工作空间 ──────────────────────────────────────────────

    async loadWorkspaces() {
      const r = await attempt('workspace:list', '读取工作空间列表', () => api.workspace.list())
      if (!r.ok) return
      const workspaces: Record<string, Workspace> = {}
      for (const ws of r.value) workspaces[ws.id] = ws
      // 顺序也以 DB 为准（列表按 created_at 排），别让本地插入顺序漂移。
      set({ workspaces, workspaceOrder: r.value.map((w) => w.id) })
    },

    async createWorkspace(name) {
      const r = await attempt('workspace:create', '新建工作空间', () =>
        api.workspace.create({ name })
      )
      if (!r.ok) return null
      const ws = r.value
      putWorkspace(ws)
      get().setActiveWorkspace(ws.id)

      // 建完立刻取一次真实路径。用户把根目录选在了 `userData` 里（资源管理器看不见），
      // 所以「它到底建在哪」是我们要主动说的第一句话，而不是等他去翻。
      const paths = await attempt('workspace:paths', '读取空间目录', () =>
        api.workspace.paths({ id: ws.id })
      )
      get().pushNotice({
        level: 'info',
        message: `已建工作空间「${ws.name}」`,
        detail: paths.ok
          ? `空间目录：${paths.value.rootPath}\n（改名只会改显示名，不会移动这个目录）`
          : `目录名：${ws.dirName}`
      })
      return ws
    },

    async renameWorkspace(id, name) {
      const r = await attempt('workspace:update', '改名', () => api.workspace.update({ id, name }))
      if (!r.ok) return false
      putWorkspace(r.value)
      // ★ 必须说清目录没跟着动 —— 否则用户改完名去资源管理器里找新目录，找不到。
      get().pushNotice({
        level: 'info',
        message: `已改名为「${r.value.name}」`,
        detail: `磁盘目录仍是「${r.value.dirName}」—— 改名不会移动空间目录`
      })
      return true
    },

    async deleteWorkspace(id, deleteCopies) {
      const name = get().workspaces[id]?.name ?? id
      const r = await attempt('workspace:delete', '删除工作空间', () =>
        api.workspace.delete({ id, deleteCopies })
      )
      if (!r.ok) return null

      set((s) => {
        const workspaces = { ...s.workspaces }
        delete workspaces[id]
        const projectsByWorkspace = { ...s.projectsByWorkspace }
        delete projectsByWorkspace[id]
        const membersByWorkspace = { ...s.membersByWorkspace }
        delete membersByWorkspace[id]
        const pathsByWorkspace = { ...s.pathsByWorkspace }
        delete pathsByWorkspace[id]
        return {
          workspaces,
          projectsByWorkspace,
          membersByWorkspace,
          pathsByWorkspace,
          workspaceOrder: s.workspaceOrder.filter((x) => x !== id)
        }
      })

      // 删的是当前空间 → 退回「没选」。App 的 effect 会自动落到剩下的第一个。
      if (get().activeWorkspaceId === id) get().setActiveWorkspace(null)
      get().pushNotice(summarizeDeleteReport(name, r.value))
      return r.value
    },

    async setActiveProject(workspaceId, projectId) {
      const r = await attempt('workspace:setActive', '切换当前项目', () =>
        api.workspace.setActive({ id: workspaceId, projectId })
      )
      if (!r.ok) return false
      putWorkspace(r.value)
      return true
    },

    async loadWorkspacePaths(id, ensure) {
      const r = await attempt('workspace:paths', '读取空间目录', () =>
        // `ensure` 会**真的建目录**（老空间在磁盘上没有目录）。默认不建。
        ensure ? api.workspace.paths({ id, ensure: true }) : api.workspace.paths({ id })
      )
      if (!r.ok) return
      set((s) => ({ pathsByWorkspace: { ...s.pathsByWorkspace, [id]: r.value } }))
    },

    // ── 项目 ──────────────────────────────────────────────────

    async loadProjects(workspaceId) {
      const r = await attempt('project:list', '读取项目列表', () =>
        api.project.list({ workspaceId })
      )
      if (!r.ok) return
      set((s) => ({ projectsByWorkspace: { ...s.projectsByWorkspace, [workspaceId]: r.value } }))
    },

    async addLocalProject(input) {
      const r = await attempt('project:addLocal', '添加项目', () => api.project.addLocal(input))
      if (!r.ok) return null
      set((s) => ({
        projectsByWorkspace: {
          ...s.projectsByWorkspace,
          [input.workspaceId]: upsert(s.projectsByWorkspace[input.workspaceId], r.value)
        }
      }))
      get().pushNotice({
        level: 'info',
        message: `已原地引用「${r.value.name}」`,
        detail: `${r.value.rootPath}\n这个目录属于你：删空间、删项目都不会动它一个字节。`
      })
      return r.value
    },

    async copyProject(input) {
      const r = await attempt('project:copy', '复制项目', () => api.project.copy(input))
      if (!r.ok) return null
      set((s) => ({
        projectsByWorkspace: {
          ...s.projectsByWorkspace,
          [input.workspaceId]: upsert(s.projectsByWorkspace[input.workspaceId], r.value)
        }
      }))
      get().pushNotice({
        level: 'info',
        message: `已复制出「${r.value.name}」`,
        detail: `副本位置：${r.value.rootPath}`
      })
      return r.value
    },

    async cloneProject(input) {
      const r = await attempt('project:clone', '克隆项目', () => api.project.clone(input))
      if (!r.ok) return null
      set((s) => ({
        projectsByWorkspace: {
          ...s.projectsByWorkspace,
          [input.workspaceId]: upsert(s.projectsByWorkspace[input.workspaceId], r.value)
        }
      }))
      get().pushNotice({
        level: 'info',
        message: `已克隆「${r.value.name}」`,
        detail: [
          `位置：${r.value.rootPath}`,
          r.value.defaultBranch ? `当前分支：${r.value.defaultBranch}` : '（没能读出分支名）'
        ].join('\n')
      })
      return r.value
    },

    async renameProject(id, name) {
      const r = await attempt('project:rename', '重命名项目', () =>
        api.project.rename({ id, name })
      )
      if (!r.ok) return false
      set((s) => ({
        projectsByWorkspace: {
          ...s.projectsByWorkspace,
          [r.value.workspaceId]: upsert(s.projectsByWorkspace[r.value.workspaceId], r.value)
        }
      }))
      return true
    },

    async removeProject(id, deleteCopy) {
      const workspaceId = findProjectWorkspace(id)
      const name = (workspaceId ? get().projectsByWorkspace[workspaceId] : undefined)?.find(
        (p) => p.id === id
      )?.name
      const r = await attempt('project:remove', '移除项目', () =>
        api.project.remove({ id, deleteCopy })
      )
      if (!r.ok) return false
      if (workspaceId) {
        set((s) => ({
          projectsByWorkspace: {
            ...s.projectsByWorkspace,
            [workspaceId]: without(s.projectsByWorkspace[workspaceId], id)
          }
        }))
        // 移除的项目可能正是「当前项目」（空间的一级 cwd 兜底）。让主进程那边也清掉。
        if (get().workspaces[workspaceId]?.activeProjectId === id) {
          await get().setActiveProject(workspaceId, null)
        }
      }
      get().pushNotice({
        level: 'info',
        message: `已移除项目「${name ?? id}」`,
        // 副本的处置**如实回报**（四种状态，见 describeCopy）。
        detail: r.value.copy ? describeCopy(r.value.copy) : '数据库里本来就没有这个项目'
      })
      return true
    },

    async defaultTarget(workspaceId, name) {
      const r = await attempt('project:defaultTarget', '计算默认落点', () =>
        api.project.defaultTarget({ workspaceId, name })
      )
      return r.ok ? r.value.path : null
    },

    // ── 角色（全局）────────────────────────────────────────────

    async loadActors() {
      const r = await attempt('actor:list', '读取角色列表', () => api.actor.list())
      if (!r.ok) return
      set({ actors: r.value })
    },

    async createActor(input) {
      const r = await attempt('actor:create', '新建角色', () => api.actor.create(input))
      if (!r.ok) return null
      set((s) => ({ actors: [...s.actors, r.value] }))
      // 人设文件的 hash 是主进程算的（渲染侧没有 fs）—— 顺手把 hash 的头几位说出来，
      // 让「人设变了 = 缓存前缀变了」（§4.6）这件事在界面上有迹可循。
      get().pushNotice({
        level: 'info',
        message: `已建角色「${r.value.name}」`,
        detail: `人设：${r.value.personaPath}\n内容指纹：${r.value.personaHash.slice(0, 12)}…`
      })
      return r.value
    },

    async updateActor(input) {
      const r = await attempt('actor:update', '保存角色', () => api.actor.update(input))
      if (!r.ok) return false
      set((s) => ({ actors: upsert(s.actors, r.value) }))
      return true
    },

    async setActorPersona(id, personaPath) {
      const r = await attempt('actor:setPersona', '更换人设文件', () =>
        api.actor.setPersona({ id, personaPath })
      )
      if (!r.ok) return false
      set((s) => ({ actors: upsert(s.actors, r.value) }))
      get().pushNotice({
        level: 'info',
        message: `「${r.value.name}」的人设已更新`,
        detail: `新内容指纹：${r.value.personaHash.slice(0, 12)}…\n（人设一变，可缓存前缀就失效了 —— 下一轮会重新建立缓存）`
      })
      return true
    },

    async removeActor(id) {
      const name = get().actors.find((a) => a.id === id)?.name ?? id
      const r = await attempt('actor:remove', '删除角色', () => api.actor.remove({ id }))
      if (!r.ok) return false
      set((s) => {
        const membersByWorkspace: Record<string, WorkspaceMember[]> = {}
        for (const [wsId, list] of Object.entries(s.membersByWorkspace)) {
          membersByWorkspace[wsId] = list.filter((m) => m.actorId !== id)
        }
        return { actors: s.actors.filter((a) => a.id !== id), membersByWorkspace }
      })
      // ★ 级联是**跨空间**的（§2.4）：删「人」会带走他在每个空间里的身份。
      //   不说清楚的话，用户会以为只是从一个空间里移除了他。
      get().pushNotice({
        level: 'warning',
        message: `已删除角色「${name}」`,
        detail:
          '这是全局的「人」：他在所有工作空间里的成员身份、以及那些成员的会话与消息，' +
          '都被一并删除了。只想让他在某个空间里退出的话，应该用成员列表里的「移除」。'
      })
      return true
    },

    // ── 成员 ──────────────────────────────────────────────────

    async loadMembers(workspaceId) {
      const r = await attempt('member:list', '读取成员列表', () =>
        api.member.list({ workspaceId })
      )
      if (!r.ok) return
      set((s) => ({ membersByWorkspace: { ...s.membersByWorkspace, [workspaceId]: r.value } }))
      // 顺手把每个成员的可见性也拉一遍。成员数是个位数，一次一条查询；
      // 而列表上的「主项目」标记要用它 —— M4 没有「列出全部主项目」的通道，
      // 也**不该**为此加一条通道（那是个纯展示用的聚合）。
      for (const m of r.value) void get().loadVisibility(m.id)
    },

    async createMember(input) {
      const r = await attempt('member:create', '添加成员', () =>
        api.member.create({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          displayName: input.displayName,
          roleDescPath: input.roleDescPath ?? null
        })
      )
      if (!r.ok) return null
      set((s) => ({
        membersByWorkspace: {
          ...s.membersByWorkspace,
          [input.workspaceId]: upsert(s.membersByWorkspace[input.workspaceId], r.value)
        }
      }))
      return r.value
    },

    async removeMember(id) {
      const r = await attempt('member:remove', '移除成员', () => api.member.remove({ id }))
      if (!r.ok) return false
      set((s) => {
        const membersByWorkspace: Record<string, WorkspaceMember[]> = {}
        for (const [wsId, list] of Object.entries(s.membersByWorkspace)) {
          membersByWorkspace[wsId] = without(list, id)
        }
        const visibilityByMember = { ...s.visibilityByMember }
        delete visibilityByMember[id]
        return { membersByWorkspace, visibilityByMember }
      })
      if (get().selection?.id === id) get().select(null)
      return true
    },

    async setMemberEnabled(id, enabled) {
      const r = await attempt('member:setEnabled', '切换启用状态', () =>
        api.member.setEnabled({ id, enabled })
      )
      if (!r.ok) return false
      set((s) => ({ membersByWorkspace: replaceMember(s.membersByWorkspace, r.value) }))
      return true
    },

    async setMemberRouter(id, isRouter) {
      const r = await attempt('member:setRouter', '设置路由角色', () =>
        api.member.setRouter({ id, isRouter })
      )
      if (!r.ok) return false
      // 至多一个路由角色，是主进程的偏索引兜底的；本地要把**其他**成员的标记清掉，
      // 否则界面上会同时出现两个「路由」徽标，直到下一次整体刷新。
      set((s) => {
        const list = s.membersByWorkspace[r.value.workspaceId] ?? []
        const next = list.map((m) =>
          m.id === r.value.id ? r.value : isRouter && m.isRouter ? { ...m, isRouter: false } : m
        )
        return { membersByWorkspace: { ...s.membersByWorkspace, [r.value.workspaceId]: next } }
      })
      return true
    },

    async setMemberRoleDesc(id, roleDescPath) {
      const r = await attempt('member:setRoleDesc', '设置职责文件', () =>
        api.member.setRoleDesc({ id, roleDescPath })
      )
      if (!r.ok) return false
      set((s) => ({ membersByWorkspace: replaceMember(s.membersByWorkspace, r.value) }))
      return true
    },

    // ── 可见性（§8.4）──────────────────────────────────────────

    async loadVisibility(memberId) {
      const r = await attempt('member:visibility', '读取可见性', () =>
        api.member.visibility({ memberId })
      )
      if (!r.ok) return
      set((s) => ({ visibilityByMember: { ...s.visibilityByMember, [memberId]: r.value } }))
    },

    async setVisibility(memberId, projectIds, primaryProjectId) {
      const r = await attempt('member:setVisibility', '保存可见性', () =>
        api.member.setVisibility({ memberId, projectIds, primaryProjectId })
      )
      if (!r.ok) return false
      // 直接由返回值推出新的可见性视图，省一次往返：`setVisibleProjects` 是**整体替换**，
      // 所以返回的行就是全部的行，没有残留。
      set((s) => ({
        visibilityByMember: {
          ...s.visibilityByMember,
          [memberId]: {
            ids: r.value.map((row) => row.projectId),
            isRestricted: r.value.length > 0,
            primaryProjectId: r.value.find((row) => row.isPrimary)?.projectId ?? null
          }
        }
      }))
      // ★ 这里**刻意不推通知**：可见性是「点一下就立刻落库」的开关，
      //   每次都弹一条只会变成噪音。而「改动将在下一轮生效」这条（§5.6）
      //   是**常驻说明**，应该印在可见性面板上，而不是一闪而过的提示。
      return true
    },

    async clearVisibility(memberId) {
      const r = await attempt('member:clearVisibility', '恢复默认可见性', () =>
        api.member.clearVisibility({ memberId })
      )
      if (!r.ok) return false
      // 回到「全部可见」：一行 `member_project` 都没有，`ids` 因此是**空数组**。
      // 空不等于「什么都看不见」，见 MemberDetail 里的说明。
      set((s) => ({
        visibilityByMember: {
          ...s.visibilityByMember,
          [memberId]: { ids: [], isRestricted: false, primaryProjectId: null }
        }
      }))
      return true
    },

    // ── 宿主能力 ──────────────────────────────────────────────

    async revealPath(path) {
      const r = await attempt('shell:revealPath', '打开目录', () => api.shell.revealPath({ path }))
      if (!r.ok) return false
      if (!r.value.opened) {
        get().pushNotice({
          level: 'warning',
          message: `打不开这个路径：${path}`,
          detail: '多半是它已经不在磁盘上了。'
        })
      }
      return r.value.opened
    }
  }
}

/** 用返回的那一行替换掉列表里对应的成员 —— 找不到就原样返回（列表可能还没加载）。 */
function replaceMember(
  membersByWorkspace: Record<string, WorkspaceMember[]>,
  member: WorkspaceMember
): Record<string, WorkspaceMember[]> {
  const list = membersByWorkspace[member.workspaceId]
  if (!list) return membersByWorkspace
  return {
    ...membersByWorkspace,
    [member.workspaceId]: list.map((m) => (m.id === member.id ? member : m))
  }
}
