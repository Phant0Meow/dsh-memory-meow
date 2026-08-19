/**
 * meow-memory v2 — SQLite 数据层。
 *
 * 每 level 一表（用户拍板：各层数据结构需求不同）：
 *   soul / user — 无特化列，少而精；
 *   project     — project 名必填（多项目分存）+ subcategory 子类；
 *   fact        — 细碎原子事实，可选 project 归属；
 *   lesson      — corrected 标记 + 可选 project 归属；
 *   topic       — title 必填 + goal 目标句（切换判定参照系）。
 *
 * id = 时间前缀（base36 毫秒 + 随机后缀，36 字符）：id 排序即创建顺序。
 * updated_at = 记忆时间戳（最后更新时间：dream 封存或 memory_update 刷新；对外显示"记忆时间戳"）。
 * 驱动：node:sqlite（Node ≥22.5 内置，宿主 @deepseek-ai/dsh-storage-sqlite 同款）。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Level = 'soul' | 'user' | 'project' | 'fact' | 'lesson' | 'topic' | 'rules'
export type Status = 'active' | 'archived' | 'stale'

export const LEVELS: readonly Level[] = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

/** project 子类（用户拍板）：目标概述/项目结构/技术决策/用户原话/部署与数据/进行中。 */
export const PROJECT_SUBCATEGORIES = ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'] as const
export type ProjectSubcategory = (typeof PROJECT_SUBCATEGORIES)[number]

/** topic 之外的 level 不强制 title；project 需 project 名；lesson 用 corrected。 */
export const LEVEL_LABELS: Record<Level, string> = {
  soul: 'AI 自身',
  user: '用户基本信息与基础偏好',
  project: '项目',
  fact: '原子事实',
  lesson: '错误与教训',
  topic: '话题',
  rules: '设计原则与行为准则',
}

/** 相对时间显示（"记忆时间戳"人性化）。 */
export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return '无时间戳'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ms).toISOString().slice(0, 10)
}

/** project 字段 → 项目名列表（逗号分隔多值，兼容单值；'全局'/空 = 无具体项目）。 */
export function projectList(field: string | null): string[] {
  if (!field || field === '全局') return []
  return field.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** project 字段是否覆盖某项目名（多值包含判断；null/'全局' = 全局适用任何项目）。 */
export function projectCovers(field: string | null, name: string): boolean {
  if (field === null || field === '全局') return true
  return projectList(field).includes(name)
}

/** project 字段的展示标签：'全局'=真全局；null=未标记；多值 join '/'（如 dsh/femwa）。 */
export function projectLabel(field: string | null): string {
  if (field === '全局') return '全局'
  if (field === null) return '未标记'
  return projectList(field).join('/')
}

export interface MemoryRow {
  id: string
  level: Level
  title: string | null
  content: string
  importance: number // 数字即可不设上限（软引导 1-4；高 importance 豁免遗忘权重）
  keywords: string[] // JSON 数组，写入时 bigram 自动提取
  status: Status
  corrected: number // lesson 专用：来自用户纠正
  project: string | null // project 必填；fact/lesson 可选
  subcategory: ProjectSubcategory | null // project 专用
  goal: string | null // topic 专用：目标句
  source_session: string | null
  hit_count: number
  created_at: number
  updated_at: number // 记忆时间戳 = 最后更新时间（dream 封存或 memory_update 刷新）
  last_accessed_at: number | null
}

export interface MemoryPatch {
  content?: string
  title?: string | null
  importance?: number
  keywords?: string[]
  status?: Status
  corrected?: number
  project?: string | null
  subcategory?: ProjectSubcategory | null
  goal?: string | null
}

/** 时间前缀 id：base36(毫秒,9位) + '-' + 26 位随机 = 36 字符，id 排序 ≈ 创建顺序。 */
export function newId(now = Date.now()): string {
  const t = now.toString(36).padStart(9, '0')
  return t + '-' + randomUUID().replace(/-/g, '').slice(0, 26)
}

const COMMON_COLS = `
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER
`

/** level → 建表语句（差异列按层特化）。表名来自 LEVELS 枚举，不拼外部输入。 */
const SCHEMAS: Record<Level, string> = {
  soul: `CREATE TABLE IF NOT EXISTS soul (${COMMON_COLS})`,
  user: `CREATE TABLE IF NOT EXISTS user (${COMMON_COLS})`,
  project: `CREATE TABLE IF NOT EXISTS project (${COMMON_COLS},
    project TEXT NOT NULL,
    subcategory TEXT)`,
  fact: `CREATE TABLE IF NOT EXISTS fact (${COMMON_COLS},
    project TEXT)`,
  lesson: `CREATE TABLE IF NOT EXISTS lesson (${COMMON_COLS},
    corrected INTEGER NOT NULL DEFAULT 0,
    project TEXT)`,
  topic: `CREATE TABLE IF NOT EXISTS topic (${COMMON_COLS},
    goal TEXT,
    project TEXT)`,
  rules: `CREATE TABLE IF NOT EXISTS rules (${COMMON_COLS},
    project TEXT)`, // project 可空：null=全局准则（高 importance 全量注入），非空=项目特定（memory_project 注入）
}

/** 记忆库路径：workspace 是项目根（cwd），目录名单独传（防双拼）。 */
export function memoryDbPath(workspace: string, dir = '.dsh-meow'): string {
  return join(workspace, dir, 'memory.db')
}

export class MemoryDb {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    for (const level of LEVELS) this.db.exec(SCHEMAS[level])
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at INTEGER NOT NULL,
      summary TEXT,
      changes TEXT,
      note TEXT
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS windows (
      session_id TEXT PRIMARY KEY,
      workspace TEXT,
      last_event_time INTEGER,
      last_dream_time INTEGER,
      dream_owner TEXT,
      dream_started_at INTEGER,
      dream_progress_at INTEGER,
      dream_group_idx INTEGER,
      dream_T INTEGER
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_meta (
      key TEXT PRIMARY KEY,
      value INTEGER
    )`)
    this.upgrade()
  }

  /** 幂等升级：缺列补列；旧 UUID id 按 created_at 重排为时间前缀 id；
   *  v0.7.0：dream_at 列并入 updated_at（记忆时间戳=最后更新时间）后删除。 */
  private upgrade(): void {
    for (const level of LEVELS) {
      const cols = new Set(
        (this.db.prepare(`PRAGMA table_info(${level})`).all() as Array<{ name: string }>).map((c) => c.name),
      )
      if (cols.has('dream_at')) {
        // 旧库：记忆时间戳数据合并进 updated_at（取两者较新值），再删 dream_at 列。
        this.db.exec(`UPDATE ${level} SET updated_at = MAX(COALESCE(updated_at, 0), COALESCE(dream_at, 0)) WHERE dream_at IS NOT NULL`)
        this.db.exec(`ALTER TABLE ${level} DROP COLUMN dream_at`)
      }
      if (level === 'project' && !cols.has('subcategory')) {
        this.db.exec('ALTER TABLE project ADD COLUMN subcategory TEXT')
      }
      if (level === 'topic' && !cols.has('project')) {
        this.db.exec('ALTER TABLE topic ADD COLUMN project TEXT')
      }
      // 旧 UUID（不以 9 位时间前缀开头）→ 按 created_at 重写 id
      const legacy = this.db.prepare(`SELECT id FROM ${level}`).all() as Array<{ id: string }>
      for (const { id } of legacy) {
        if (/^[0-9a-z]{9}-/.test(id)) continue
        const created = (this.db.prepare(`SELECT created_at FROM ${level} WHERE id = ?`).get(id) as { created_at: number }).created_at
        this.db.prepare(`UPDATE ${level} SET id = ? WHERE id = ?`).run(newId(created), id)
      }
    }
    // windows 表：v0.10.0 起用租约（dream_owner/progress_at/...）替代 dream_pending 布尔。
    // 老库补列；老「dream_pending=1」迁移为「过期租约」——下个检查周期按租约过期补收尾。
    const wCols = new Set(
      (this.db.prepare('PRAGMA table_info(windows)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    for (const [col, ddl] of [
      ['dream_owner', 'TEXT'],
      ['dream_started_at', 'INTEGER'],
      ['dream_progress_at', 'INTEGER'],
      ['dream_group_idx', 'INTEGER'],
      ['dream_T', 'INTEGER'],
    ] as const) {
      if (!wCols.has(col)) this.db.exec(`ALTER TABLE windows ADD COLUMN ${col} ${ddl}`)
    }
    if (wCols.has('dream_pending')) {
      this.db.exec(`UPDATE windows SET dream_owner = 'legacy-pending', dream_started_at = 0, dream_progress_at = 0, dream_group_idx = 0, dream_T = last_event_time WHERE dream_pending = 1 AND dream_owner IS NULL`)
    }
  }

  /** 新库（memories 全空）判定：迁移只在库刚创建时执行一次。 */
  isFresh(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM soul').get() as { n: number }
    return row.n === 0
  }

  insert(row: { level: Level; content: string } & Partial<MemoryRow>): MemoryRow {
    const now = Date.now()
    const full: MemoryRow = {
      id: row.id ?? newId(now),
      level: row.level,
      title: row.title ?? null,
      content: row.content,
      importance: row.importance ?? 1,
      keywords: row.keywords ?? [],
      status: row.status ?? 'active',
      corrected: row.corrected ?? 0,
      project: row.project ?? null,
      subcategory: row.subcategory ?? null,
      goal: row.goal ?? null,
      source_session: row.source_session ?? null,
      hit_count: row.hit_count ?? 0,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
      last_accessed_at: row.last_accessed_at ?? null,
    }
    this.db
      .prepare(
        `INSERT INTO ${full.level} (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at
          ${full.level === 'project' ? ', project, subcategory' : ''}
          ${full.level === 'fact' || full.level === 'lesson' || full.level === 'rules' ? ', project' : ''}
          ${full.level === 'lesson' ? ', corrected' : ''}
          ${full.level === 'topic' ? ', goal, project' : ''}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          ${full.level === 'project' ? ', ?, ?' : ''}
          ${full.level === 'fact' || full.level === 'lesson' || full.level === 'rules' ? ', ?' : ''}
          ${full.level === 'lesson' ? ', ?' : ''}
          ${full.level === 'topic' ? ', ?, ?' : ''}
        )`,
      )
      .run(
        full.id,
        full.title,
        full.content,
        full.importance,
        JSON.stringify(full.keywords),
        full.status,
        full.source_session,
        full.hit_count,
        full.created_at,
        full.updated_at,
        full.last_accessed_at,
        ...(full.level === 'project' ? [full.project ?? '', full.subcategory] : []),
        ...(full.level === 'fact' || full.level === 'lesson' || full.level === 'rules' ? [full.project] : []),
        ...(full.level === 'lesson' ? [full.corrected] : []),
        ...(full.level === 'topic' ? [full.goal, full.project] : []),
      )
    return full
  }

  /** 跨表定位（UUID 全局唯一，扫描全部表）。id 支持 8 位前缀匹配
   *  （快照/检索结果给的是截断 id；前缀碰撞时取第一个）。 */
  findById(id: string): { row: MemoryRow; level: Level } | undefined {
    const prefix = id.length < 36
    for (const level of LEVELS) {
      const sql = prefix ? `SELECT * FROM ${level} WHERE id LIKE ?` : `SELECT * FROM ${level} WHERE id = ?`
      const r = this.db.prepare(sql).get(prefix ? `${id}%` : id) as Record<string, unknown> | undefined
      if (r) return { row: this.fromRow(level, r), level }
    }
    return undefined
  }

  update(level: Level, id: string, patch: MemoryPatch): boolean {
    const sets: string[] = []
    const args: unknown[] = []
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`)
      args.push(val)
    }
    if (patch.content !== undefined) push('content', patch.content)
    if (patch.title !== undefined) push('title', patch.title)
    if (patch.importance !== undefined) push('importance', patch.importance)
    if (patch.keywords !== undefined) push('keywords', JSON.stringify(patch.keywords))
    if (patch.status !== undefined) push('status', patch.status)
    if (patch.corrected !== undefined && level === 'lesson') push('corrected', patch.corrected)
    if (patch.project !== undefined && (level === 'project' || level === 'fact' || level === 'lesson')) {
      push('project', patch.project)
    }
    if (patch.subcategory !== undefined && level === 'project') push('subcategory', patch.subcategory)
    if (patch.goal !== undefined && level === 'topic') push('goal', patch.goal)
    if (patch.project !== undefined && level === 'topic') push('project', patch.project)
    if (sets.length === 0) return false
    push('updated_at', Date.now()) // 记忆时间戳 = 最后更新时间（任何 update 都刷新）
    const where = id.length < 36 ? 'id LIKE ?' : 'id = ?'
    const res = this.db.prepare(`UPDATE ${level} SET ${sets.join(', ')} WHERE ${where}`).run(...args, id.length < 36 ? `${id}%` : id)
    return res.changes > 0
  }

  list(level: Level, opts: { status?: Status; project?: string } = {}): MemoryRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.status) {
      where.push('status = ?')
      args.push(opts.status)
    }
    if (opts.project !== undefined && (level === 'project' || level === 'fact' || level === 'lesson' || level === 'rules')) {
      where.push('project = ?')
      args.push(opts.project)
    }
    const sql = `SELECT * FROM ${level}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[]
    return rows.map((r) => this.fromRow(level, r))
  }

  /** 全部 active 条目（dream / 注入用），按 level 分组。 */
  allActive(): Record<Level, MemoryRow[]> {
    const out = {} as Record<Level, MemoryRow[]>
    for (const level of LEVELS) out[level] = this.list(level, { status: 'active' })
    return out
  }

  /** 可检索条目：active 全部；project.subcategory='todo' 的 stale 视为 done 参与检索。
   *  （用户拍板：todo 过时=finish 可检索，其他类别过时不检索。） */
  listSearchable(level: Level): MemoryRow[] {
    const active = this.list(level, { status: 'active' })
    if (level !== 'project') return active
    const todoDone = (
      this.db.prepare(`SELECT * FROM project WHERE status = 'stale' AND subcategory = 'todo'`).all() as Record<string, unknown>[]
    ).map((r) => this.fromRow('project', r))
    return [...active, ...todoDone]
  }

  bumpHit(level: Level, id: string): void {
    this.db.prepare(`UPDATE ${level} SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?`).run(
      Date.now(),
      id,
    )
  }

  count(level: Level): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${level}`).get() as { n: number }
    return row.n
  }

  /** 全部出现过（含已过时）的项目名：project/fact/lesson/topic/rules 五表的 project 列并集
   *  （多值逗号分隔展开；"全局"是全局标记不是项目，排除）。供记忆导引列出"用户的所有 project"。 */
  listProjectNames(): string[] {
    const names = new Set<string>()
    for (const level of ['project', 'fact', 'lesson', 'topic', 'rules'] as const) {
      const rows = this.db.prepare(`SELECT project FROM ${level} WHERE project IS NOT NULL AND project != ''`).all() as Array<{ project: string }>
      for (const r of rows) for (const n of projectList(r.project)) names.add(n)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }

  logDream(summary: string, changes: unknown, note = ''): void {
    this.db
      .prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
      .run(Date.now(), summary, JSON.stringify(changes), note)
  }

  recentDream(hours: number): boolean {
    const row = this.db
      .prepare('SELECT run_at FROM dream_log ORDER BY run_at DESC LIMIT 1')
      .get() as { run_at: number } | undefined
    if (!row) return false
    return Date.now() - row.run_at < hours * 3600_000
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  /** 子 agent / dream 用的只读快照：把一组行转成纯数据（无 db 依赖）。 */
  snapshot(level: Level, opts: { status?: Status } = {}): MemoryRow[] {
    return this.list(level, opts)
  }

  // ── windows 窗口表（dream 判定：跨重启持久化） ───────────────────────────

  touchWindow(sessionId: string, workspace: string, eventTime: number): void {
    this.db
      .prepare(`INSERT INTO windows (session_id, workspace, last_event_time, last_dream_time) VALUES (?, ?, ?, NULL)
        ON CONFLICT(session_id) DO UPDATE SET workspace = excluded.workspace, last_event_time = MAX(last_event_time, excluded.last_event_time)`)
      .run(sessionId, workspace, eventTime)
  }

  setWindowDream(sessionId: string, time: number): void {
    this.db.prepare(`UPDATE windows SET last_dream_time = ? WHERE session_id = ?`).run(time, sessionId)
  }

  /** 原子抢占 dream 租约（跨进程/实例防重复 start）：返回 true 表示抢占成功（可 start）。
   *  条件：无租约（owner IS NULL）或租约已过期（progress_at 超 leaseMs）。owner 只用于抢占判断 + 诊断；
   *  推进/收尾按「sessionId + 租约未过期」判定，不校验 owner。 */
  claimDream(sessionId: string, owner: string, T: number, leaseMs: number): boolean {
    this.db
      .prepare(`INSERT OR IGNORE INTO windows (session_id, workspace, last_event_time, last_dream_time) VALUES (?, NULL, 0, NULL)`)
      .run(sessionId)
    const now = Date.now()
    return (
      this.db
        .prepare(
          `UPDATE windows SET dream_owner = ?, dream_started_at = ?, dream_progress_at = ?, dream_group_idx = 0, dream_T = ?
           WHERE session_id = ? AND (dream_owner IS NULL OR dream_progress_at IS NULL OR dream_progress_at <= ?)`,
        )
        .run(owner, now, now, T, sessionId, now - leaseMs).changes === 1
    )
  }

  /** dream 收尾：清租约 + 记 last_dream_time（dream 完成时刻）。 */
  finishDream(sessionId: string, time: number): void {
    this.db
      .prepare(`UPDATE windows SET dream_owner = NULL, dream_started_at = NULL, dream_progress_at = NULL, dream_group_idx = NULL, dream_T = NULL, last_dream_time = ? WHERE session_id = ?`)
      .run(time, sessionId)
  }

  /** 是否有进行中/未收尾的 dream（租约存在，无论是否过期）。 */
  isDreamPending(sessionId: string): boolean {
    const row = this.db.prepare(`SELECT dream_owner FROM windows WHERE session_id = ?`).get(sessionId) as
      | { dream_owner: string | null }
      | undefined
    return row?.dream_owner != null
  }

  /** 读窗口当前 dream 租约；无租约返回 null。 */
  getDreamLease(sessionId: string): { owner: string; started_at: number; progress_at: number; group_idx: number; T: number } | null {
    const row = this.db
      .prepare(`SELECT dream_owner, dream_started_at, dream_progress_at, dream_group_idx, dream_T FROM windows WHERE session_id = ?`)
      .get(sessionId) as
      | { dream_owner: string | null; dream_started_at: number | null; dream_progress_at: number | null; dream_group_idx: number | null; dream_T: number | null }
      | undefined
    if (!row || row.dream_owner == null) return null
    return {
      owner: row.dream_owner,
      started_at: row.dream_started_at ?? 0,
      progress_at: row.dream_progress_at ?? 0,
      group_idx: row.dream_group_idx ?? 0,
      T: row.dream_T ?? 0,
    }
  }

  /** CAS 推进租约：group_idx +1 并刷新心跳。多实例同收 turn-stopping 时只有一个成功。 */
  advanceDreamLease(sessionId: string, fromIdx: number, leaseMs: number): boolean {
    const now = Date.now()
    return (
      this.db
        .prepare(
          `UPDATE windows SET dream_group_idx = dream_group_idx + 1, dream_progress_at = ?
           WHERE session_id = ? AND dream_group_idx = ? AND dream_owner IS NOT NULL AND dream_progress_at > ?`,
        )
        .run(now, sessionId, fromIdx, now - leaseMs).changes === 1
    )
  }

  // ── 全局检查门（dream 定时器防叠加） ─────────────────────────────────────
  // 根因：插件热重载/多实例并存时，dispose 未必清理旧 setInterval → 多个定时器
  // 叠加 → 检查频率远高于 checkMinutes，同一窗口被反复 start。检查动作本身
  // 必须幂等：DB 原子抢占"检查窗口"（minIntervalMs 内只有一个实例通过），
  // 与 startWindowDream 的 claimDream（start 幂等）+ recoverInterruptedDream
  // （中断自愈）组成三层防重复闭环。

  /** 原子抢占一次检查窗口：minIntervalMs 内只有一个调用方返回 true。 */
  claimCheckGate(minIntervalMs: number): boolean {
    this.db.prepare(`INSERT OR IGNORE INTO dream_meta (key, value) VALUES ('last_check', 0)`).run()
    const now = Date.now()
    return (
      this.db
        .prepare(`UPDATE dream_meta SET value = ? WHERE key = 'last_check' AND value <= ?`)
        .run(now, now - minIntervalMs).changes === 1
    )
  }

  getWindow(sessionId: string): { session_id: string; workspace: string; last_event_time: number; last_dream_time: number | null } | undefined {
    return this.db.prepare(`SELECT * FROM windows WHERE session_id = ?`).get(sessionId) as
      | { session_id: string; workspace: string; last_event_time: number; last_dream_time: number | null }
      | undefined
  }

  listWindows(): Array<{ session_id: string; workspace: string; last_event_time: number; last_dream_time: number | null }> {
    return this.db.prepare(`SELECT * FROM windows ORDER BY last_event_time DESC`).all() as Array<{
      session_id: string
      workspace: string
      last_event_time: number
      last_dream_time: number | null
    }>
  }

  /** 本窗口建立的全部条目 id（dream 收尾：updated_at 批量写入用）。 */
  idsBySession(sessionId: string): Array<{ level: Level; id: string }> {
    const out: Array<{ level: Level; id: string }> = []
    for (const level of LEVELS) {
      const rows = this.db.prepare(`SELECT id FROM ${level} WHERE source_session = ?`).all(sessionId) as Array<{ id: string }>
      for (const r of rows) out.push({ level, id: r.id })
    }
    return out
  }

  /** 批量写记忆时间戳（dream 收尾：本窗口条目 updated_at = 窗口最后对话时间 T；
   *   MAX 防止覆盖 T 之后的 memory_update 刷新）。 */
  stampDream(sessionId: string, time: number): number {
    let n = 0
    for (const { level, id } of this.idsBySession(sessionId)) {
      n += this.db.prepare(`UPDATE ${level} SET updated_at = MAX(updated_at, ?) WHERE id = ?`).run(time, id).changes
    }
    return n
  }

  private fromRow(level: Level, r: Record<string, unknown>): MemoryRow {
    let keywords: string[] = []
    try {
      keywords = JSON.parse(String(r.keywords ?? '[]'))
    } catch {
      keywords = []
    }
    return {
      id: String(r.id),
      level,
      title: r.title == null ? null : String(r.title),
      content: String(r.content),
      importance: Number(r.importance ?? 1),
      keywords,
      status: String(r.status) as Status,
      corrected: Number(r.corrected ?? 0),
      project: r.project == null ? null : String(r.project),
      subcategory: r.subcategory == null ? null : (String(r.subcategory) as ProjectSubcategory),
      goal: r.goal == null ? null : String(r.goal),
      source_session: r.source_session == null ? null : String(r.source_session),
      hit_count: Number(r.hit_count ?? 0),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
      last_accessed_at: r.last_accessed_at == null ? null : Number(r.last_accessed_at),
    }
  }
}

// ── 按工作区缓存（插件无全局 cwd；DB 按会话 cwd 懒打开） ─────────────────────

const dbCache = new Map<string, MemoryDb>()

/** 取工作区 DB（缓存复用）。workspace = 项目根（cwd）。 */
export function getDb(workspace: string, dir = '.dsh-meow'): MemoryDb {
  const key = `${workspace}\u0000${dir}`
  let db = dbCache.get(key)
  if (!db) {
    db = new MemoryDb(memoryDbPath(workspace, dir))
    dbCache.set(key, db)
  }
  return db
}

export function closeAllDbs(): void {
  for (const db of dbCache.values()) db.close()
  dbCache.clear()
}

/** dream 子 agent 的 DB 定位通道：子 agent 会话可能无 cwd，dream 运行时临时挂载。 */
let dreamWorkspace: string | null = null
export function setDreamWorkspace(ws: string | null): void {
  dreamWorkspace = ws
}
export function getDreamWorkspace(): string | null {
  return dreamWorkspace
}
