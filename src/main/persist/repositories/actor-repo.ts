import type { DatabaseSync } from 'node:sqlite'
import type { Actor, AgentKind, EffortLevel } from '../../../shared/entities.ts'
import { AGENT_KINDS, EFFORT_LEVELS } from '../../../shared/entities.ts'
import { nstr, num, str, type Row } from '../row.ts'

/** 校验一个值在给定白名单里，不在就抛 —— 与 SQL 的 CHECK 约束形成双保险。 */
function oneOf<T extends string>(value: string, allowed: readonly T[], column: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`actor.${column} 出现未知值 ${JSON.stringify(value)}`)
  }
  return value as T
}

function mapActor(row: Row): Actor {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    avatar: nstr(row, 'avatar'),
    agentKind: oneOf(str(row, 'agent_kind'), AGENT_KINDS, 'agent_kind'),
    // 自由文本，**不做白名单校验** —— 用户的 settings.json 会把别名映射到
    // 第三方端点，固定枚举会在换端点时立刻失效（§2.4）。
    model: str(row, 'model'),
    effort: oneOf(str(row, 'effort'), EFFORT_LEVELS, 'effort'),
    personaPath: str(row, 'persona_path'),
    personaHash: str(row, 'persona_hash'),
    skillsJson: str(row, 'skills_json'),
    memoryJson: str(row, 'memory_json'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at')
  }
}

export interface CreateActorInput {
  id: string
  name: string
  avatar?: string | null
  agentKind?: AgentKind
  /** 自由文本，例如 `deepseek-flash` 或 `claude-sonnet-5`（§2.4） */
  model: string
  effort?: EffortLevel
  personaPath: string
  personaHash: string
  now: number
}

export function actorRepo(db: DatabaseSync) {
  const s = {
    list: db.prepare(`SELECT * FROM actor ORDER BY created_at ASC`),
    get: db.prepare(`SELECT * FROM actor WHERE id = ?`),
    getByName: db.prepare(`SELECT * FROM actor WHERE name = ?`),
    insert: db.prepare(
      `INSERT INTO actor
         (id, name, avatar, agent_kind, model, effort, persona_path, persona_hash,
          skills_json, memory_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)
       RETURNING *`
    ),
    update: db.prepare(
      `UPDATE actor SET name = ?, avatar = ?, agent_kind = ?, model = ?, effort = ?,
              updated_at = ?
       WHERE id = ? RETURNING *`
    ),
    /**
     * 只改人设引用，并**由调用方同时给出新 hash**。
     * 人设内容变了却不更新 hash，会让 §4.6 的可缓存前缀检测失效 ——
     * 缓存键会认为前缀没变，实际变了。所以这两个参数必须一起动。
     */
    setPersona: db.prepare(
      `UPDATE actor SET persona_path = ?, persona_hash = ?, updated_at = ? WHERE id = ? RETURNING *`
    ),
    setExtensions: db.prepare(
      `UPDATE actor SET skills_json = ?, memory_json = ?, updated_at = ? WHERE id = ? RETURNING *`
    ),
    remove: db.prepare(`DELETE FROM actor WHERE id = ?`)
  }

  return {
    list(): Actor[] {
      return (s.list.all() as Row[]).map(mapActor)
    },

    get(id: string): Actor | null {
      const row = s.get.get(id) as Row | undefined
      return row ? mapActor(row) : null
    },

    getByName(name: string): Actor | null {
      const row = s.getByName.get(name) as Row | undefined
      return row ? mapActor(row) : null
    },

    create(input: CreateActorInput): Actor {
      const row = s.insert.get(
        input.id,
        input.name,
        input.avatar ?? null,
        input.agentKind ?? 'claude',
        input.model,
        input.effort ?? 'high',
        input.personaPath,
        input.personaHash,
        input.now,
        input.now
      ) as Row
      return mapActor(row)
    },

    update(
      id: string,
      patch: {
        name: string
        avatar?: string | null
        agentKind: AgentKind
        model: string
        effort: EffortLevel
        now: number
      }
    ): Actor | null {
      const row = s.update.get(
        patch.name,
        patch.avatar ?? null,
        patch.agentKind,
        patch.model,
        patch.effort,
        patch.now,
        id
      ) as Row | undefined
      return row ? mapActor(row) : null
    },

    setPersona(id: string, personaPath: string, personaHash: string, now: number): Actor | null {
      const row = s.setPersona.get(personaPath, personaHash, now, id) as Row | undefined
      return row ? mapActor(row) : null
    },

    setExtensions(id: string, skillsJson: string, memoryJson: string, now: number): Actor | null {
      const row = s.setExtensions.get(skillsJson, memoryJson, now, id) as Row | undefined
      return row ? mapActor(row) : null
    },

    /** ⚠️ 级联会带走该 actor 在所有空间的成员身份与 session。 */
    remove(id: string): boolean {
      return s.remove.run(id).changes > 0
    }
  }
}

export type ActorRepo = ReturnType<typeof actorRepo>
