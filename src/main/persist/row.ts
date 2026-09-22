/**
 * 行 → 实体的显式映射工具。
 *
 * ★ 为什么必须有这一层（M1 实测发现，方案 §2.1）：
 * `node:sqlite` 返回的行是 **null-prototype 对象**，不是普通对象。后果：
 *   - `assert.deepStrictEqual` / 结构化克隆会失败
 *   - `row.hasOwnProperty(...)` 之类会抛 TypeError
 *   - 任何依赖 `Object.prototype` 的下游代码都会炸
 *
 * 所以 repository **必须**把行显式映射成已知形状再往上层传，绝不原样透传。
 * 这里的取值函数同时也是**类型守卫**：列类型不符时立刻抛错，
 * 而不是把 `undefined` 或字符串 `"1"` 悄悄带到 UI 上。
 */

/** 一行原始数据。用宽索引签名，因为列名是动态的。 */
export type Row = Record<string, unknown>

/** 列缺失或类型不符时的错误。带上列名，便于定位是哪个 repository 写歪了。 */
function typeError(column: string, expected: string, got: unknown): TypeError {
  const actual = got === null ? 'null' : typeof got
  return new TypeError(`列 "${column}" 期望 ${expected}，实际得到 ${actual}`)
}

/** NOT NULL TEXT */
export function str(row: Row, column: string): string {
  const v = row[column]
  if (typeof v !== 'string') throw typeError(column, 'string', v)
  return v
}

/** 可空 TEXT */
export function nstr(row: Row, column: string): string | null {
  const v = row[column]
  if (v === null) return null
  if (typeof v !== 'string') throw typeError(column, 'string | null', v)
  return v
}

/**
 * NOT NULL INTEGER。
 * 实测（Node 24.18）`run()` 的 `lastInsertRowid` 是 **number 而非 bigint**，
 * 行里的 INTEGER 也是 number。若某天变成 bigint，这里会立刻暴露。
 */
export function num(row: Row, column: string): number {
  const v = row[column]
  if (typeof v !== 'number') throw typeError(column, 'number', v)
  return v
}

/** 可空 INTEGER / REAL */
export function nnum(row: Row, column: string): number | null {
  const v = row[column]
  if (v === null) return null
  if (typeof v !== 'number') throw typeError(column, 'number | null', v)
  return v
}

/** NOT NULL 布尔（库里存 0/1） */
export function bool(row: Row, column: string): boolean {
  const v = row[column]
  if (v !== 0 && v !== 1) throw typeError(column, '0 | 1', v)
  return v === 1
}

/** 可空布尔（库里存 0/1/NULL） */
export function nbool(row: Row, column: string): boolean | null {
  const v = row[column]
  if (v === null) return null
  if (v !== 0 && v !== 1) throw typeError(column, '0 | 1 | null', v)
  return v === 1
}

/**
 * TEXT 列里存的 JSON。解析失败时抛错并带上列名 ——
 * 一个坏掉的 JSON 列比一个缺失的列更难查，所以要它自己报出身份。
 *
 * ★ 刻意**没有** fallback 参数：这些列都是 `NOT NULL DEFAULT '[]'`，
 *   出现 null 或坏 JSON 说明库被外部改过，此时静默吞掉才是更坏的选择。
 */
export function json<T>(row: Row, column: string): T {
  const v = row[column]
  if (typeof v !== 'string') throw typeError(column, 'string(JSON)', v)
  try {
    return JSON.parse(v) as T
  } catch (err) {
    throw new Error(`列 "${column}" 不是合法 JSON：${(err as Error).message}`)
  }
}

/** 把布尔写成 SQLite 的 0/1。 */
export function bit(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

/** 把可空布尔写成 0/1/null。 */
export function nbit(value: boolean | null): 0 | 1 | null {
  return value === null ? null : value ? 1 : 0
}

/** 把值序列化进 TEXT 列。 */
export function toJson(value: unknown): string {
  return JSON.stringify(value)
}
