/** 一次 schema 迁移。`up` 是纯 SQL —— 迁移里不跑 JS 逻辑，避免不可重放的中间态。 */
export interface Migration {
  /** 从 1 开始，严格递增。**已发布的版本号不可复用、不可改写。** */
  version: number
  /** 短名，写进 `schema_migrations.name`，便于人肉排查。 */
  name: string
  /** 纯 SQL。由 runner 包在一个事务里执行。 */
  up: string
}

/** `runMigrations` 的结果，用于日志与测试断言。 */
export interface MigrationResult {
  /** 本次真正执行了的版本号 */
  applied: number[]
  /** 执行前的版本（0 = 全新库） */
  from: number
  /** 执行后的版本 */
  to: number
}
