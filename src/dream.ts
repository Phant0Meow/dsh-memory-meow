/**
 * meow-memory v2 — 按窗口夜间整理（dream）。
 *
 * 用户拍板（2026-08-15）：
 * - 每个 session 窗口由它自己的主 agent 整理：只发本窗口（source_session）建立的
 *   project/topic/fact/lesson 记忆（不含 soul/user），对着自己的完整对话上下文整理。
 * - 按 project 分组逐轮处理（每轮一个项目域，注意力友好）；无 project 标签的最后统一一轮。
 * - 组内排序：project → level（project→topic→fact→lesson）→ 创建时间。
 * - T = dream 开始前窗口最后一轮正常对话时间（先记死）；收尾时该窗口所有条目
 *   dream_at = T（"记忆时间戳"），windows 表 last_dream_time = T。
 * - 判定：窗口最后事件时间 > 24h 前 且 > 上次 dream 时间 → 需要 dream。
 * - 串行：同一时刻只有一个进行中的 dream 任务；旧窗口（无 live agent）不碰。
 *
 * 冲突处理：memory_search 返回 top-k 后按 dream_at 重排 + 顶部提示；
 * agent 据"记忆时间戳"判断新旧（工具层乐观锁留待迭代）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, type Level, type MemoryRow } from './db.js'
import { workspaceOf } from './tools.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'meow-memory' }

/** dream 消息识别标记（turn-stopping 推进判定用）。 */
export const DREAM_MARKER = '[meow-memory-dream]'

/** 同步文件日志：进程崩溃也不丢（崩溃点定位用）。 */
function dreamLog(ws: string, dir: string, msg: string): void {
  try {
    appendFileSync(join(ws, dir, 'dream-debug.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不阻塞 */
  }
}

// ── 分组与快照 ──────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<Level, number> = { project: 0, topic: 1, fact: 2, lesson: 3, soul: 4, user: 5 }

export interface DreamGroup {
  name: string // 项目名；'' = 无项目标签
  rows: MemoryRow[]
}

/** 取窗口自己的记忆并按 project 分组（组内 project→topic→fact→lesson→时间）。 */
export function groupWindowMemories(db: ReturnType<typeof getDb>, sessionId: string): DreamGroup[] {
  const rows: MemoryRow[] = []
  for (const level of ['project', 'topic', 'fact', 'lesson'] as Level[]) {
    rows.push(...db.list(level).filter((r) => r.source_session === sessionId))
  }
  rows.sort((a, b) => {
    const p = (a.project ?? '').localeCompare(b.project ?? '')
    if (p !== 0) return p
    const l = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
    if (l !== 0) return l
    return a.created_at - b.created_at
  })
  const groups = new Map<string, DreamGroup>()
  for (const r of rows) {
    const key = r.project ?? ''
    if (!groups.has(key)) groups.set(key, { name: key, rows: [] })
    groups.get(key)!.rows.push(r)
  }
  // 无项目组放最后
  return [...groups.entries()]
    .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : 0))
    .map(([, g]) => g)
}

function formatRow(r: MemoryRow): string {
  const head = r.content.replace(/\s+/g, ' ').trim()
  const meta = [r.level]
  if (r.level === 'project' && r.subcategory) meta.push(r.subcategory)
  if (r.title) meta.push(`《${r.title}》`)
  if (r.status !== 'active') meta.push(r.status)
  return `- [${meta.join(' ')} ${r.id.slice(0, 8)}] ${head}`
}

const DREAM_RULES = [
  '规则：',
  '1. 可新增（memory_remember）、修改（memory_update）、归档（memory_update 设 status=archived 表示完结/过时）；',
  '2. 用户提供的信息尽量保留用户原话——原话里包含用户的潜在逻辑，很珍贵；',
  '3. 过时、重复、不再重要的条目 → 设 status=archived；',
  '4. 互相矛盾的条目 → 按事实修改（保留最新事实，旧版本标 archived）；',
  '5. 核查 importance：重要决策/红线/教训 → 2 或 3；琐碎 → 1；',
  '6. 更新事件最新进展与 todo：topic 重写【经过/结果】段；project 的 todo 子类完成 → 标 stale（视为 done）；',
  '7. 改动前若怀疑重复，先 memory_find_similar 查重；',
  '8. 完成后直接回复"本组整理完成"，不要调用其他工具。',
].join('\n')

/** 构造一组 dream 指令消息。 */
export function buildDreamMessage(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  T: number,
  groups: DreamGroup[],
  idx: number,
): ReturnType<typeof createUserMessage> {
  const group = groups[idx]
  const tLabel = new Date(T).toISOString().slice(0, 16).replace('T', ' ')
  const title = group.name === '' ? '（无项目标签的记忆）' : `项目「${group.name}」`
  const lines = [
    `${DREAM_MARKER} 记忆整理任务（dream）第 ${idx + 1}/${groups.length} 组：${title}`,
    `本窗口记忆封存到：${tLabel}（之后其他窗口的进展本窗口不知道，冲突以记忆时间戳最新为准）。`,
    '',
    `【本组记忆】（${group.rows.length} 条，按 project→level→时间排序）：`,
    ...group.rows.map(formatRow),
    '',
    DREAM_RULES,
  ]
  return createUserMessage({ content: [{ type: 'text', text: lines.join('\n') }], source: PLUGIN_SOURCE })
}

// ── dream 任务状态（串行：同一时刻一个） ───────────────────────────────────

interface DreamTask {
  sessionId: string
  workspace: string
  dir: string
  T: number
  groups: DreamGroup[]
  idx: number
}

let currentDream: DreamTask | null = null
const liveAgents = new Map<string, unknown>() // sessionId -> 顶层 agent（live 引用）

export function registerLiveAgent(agent: { session?: { header?: { id?: string; parentSession?: unknown } } }): void {
  const id = agent.session?.header?.id
  if (typeof id === 'string' && id.length > 0) liveAgents.set(id, agent)
}

export function isDreaming(): boolean {
  return currentDream !== null
}

/** 扫描判定：窗口需要 dream 吗？ */
export function windowNeedsDream(w: { last_event_time: number; last_dream_time: number | null }, now = Date.now()): boolean {
  if (now - w.last_event_time > 24 * 3600_000) return false // 超过 24h 的旧窗口不碰
  return (w.last_dream_time ?? 0) < w.last_event_time
}

/**
 * 启动一个窗口的 dream（steer 第一组）。agent 必须是该窗口的 live 顶层 agent。
 * 返回 false 表示无法启动（已有任务在跑 / 无记忆可整理）。
 */
export function startWindowDream(ctx: Context, agent: { session?: { header?: { id?: string } } }, workspace: string, dir = '.dsh-meow'): boolean {
  if (currentDream !== null) return false
  const sessionId = agent.session?.header?.id
  if (!sessionId) return false
  const db = getDb(workspace, dir)
  const groups = groupWindowMemories(db, sessionId)
  if (groups.length === 0) return false
  const win = db.getWindow(sessionId)
  const T = win?.last_event_time ?? Date.now()
  currentDream = { sessionId, workspace, dir, T, groups, idx: 0 }
  const msg = buildDreamMessage(db, sessionId, T, groups, 0)
  ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
  dreamLog(workspace, dir, `dream start session=${sessionId.slice(0, 8)} groups=${groups.length} T=${T}`)
  return true
}

/** turn-stopping 推进：本 turn 是 dream 轮 → 下一组或收尾。 */
export function advanceDream(agent: unknown): void {
  const task = currentDream
  if (!task) return
  const sessionId = (agent as { session?: { header?: { id?: string } } })?.session?.header?.id
  if (!sessionId || sessionId !== task.sessionId) return
  const db = getDb(task.workspace, task.dir)

  task.idx += 1
  if (task.idx < task.groups.length) {
    const msg = buildDreamMessage(db, task.sessionId, task.T, task.groups, task.idx)
    ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
    dreamLog(task.workspace, task.dir, `dream group ${task.idx + 1}/${task.groups.length} steered`)
    return
  }

  // 收尾：全部条目 dream_at = T（封存语义不变）；窗口 last_dream_time = dream 完成时刻
  // （不是 T！dream 轮本身会产生会话事件推后 last_event_time，若记 T 则
  // last_dream_time < last_event_time 永远成立 → 窗口永远"需要 dream" 无限重复）。
  const stamped = db.stampDream(task.sessionId, task.T)
  db.setWindowDream(task.sessionId, Date.now())
  db.logDream(
    `window dream done: ${task.sessionId.slice(0, 8)} groups=${task.groups.length} stamped=${stamped} T=${new Date(task.T).toISOString()}`,
    { before: undefined, after: undefined },
  )
  dreamLog(task.workspace, task.dir, `dream done session=${task.sessionId.slice(0, 8)} groups=${task.groups.length} stamped=${stamped}`)
  currentDream = null
}

// ── 工具：memory_dream（手动触发本窗口 dream） ─────────────────────────────

export function dreamTool(ctx: Context, dir = '.dsh-meow'): ToolDefinition {
  return {
    name: 'memory_dream',
    description: '立即为本窗口安排一次记忆整理（dream）：把本窗口建立的记忆按项目分组逐轮发给主 agent 整理封存。通常夜间自动运行，此工具用于手动触发。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; note?: unknown }
        return [{ type: 'text' as const, text: v.ok ? `🧠 dream 已安排。${String(v.note ?? '')}` : `dream 未启动：${String(v.note ?? '')}` }]
      },
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_dream: 无法确定工作区（会话无 cwd）')
      if (!exec.agent) throw new Error('memory_dream: 无法确定当前 agent')
      const ok = startWindowDream(ctx, exec.agent, workspace, dir)
      return { ok, note: ok ? '整理指令已发出，逐个项目组处理中。' : currentDream !== null ? '已有 dream 任务在进行中。' : '本窗口没有需要整理的记忆。' }
    },
    presentCall(): { card: 'generic'; title: string; kind: 'write' } {
      return { card: 'generic', title: 'memory_dream: 整理本窗口记忆', kind: 'write' }
    },
  }
}

// ── 定时器 ──────────────────────────────────────────────────────────────────

export interface DreamConfig {
  enabled: boolean
  windowStart: number // 目标时区小时
  windowEnd: number
  idleMinutes: number
  minIntervalHours: number
  checkMinutes: number
  /** 夜间窗口按此时区计算（默认 Asia/Shanghai——用户系统是美区时间，系统时区会算错）。 */
  timeZone: string
}

/** 取指定时区的当前小时（Intl 支持；无效时区回退系统时区）。 */
export function hourInTimeZone(timeZone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).formatToParts(date)
    const h = parts.find((p) => p.type === 'hour')?.value
    if (h !== undefined) return parseInt(h, 10) % 24
  } catch {
    /* 无效时区 */
  }
  return date.getHours()
}

/** 后台定时检查（全局 setInterval + dispose 清理；cordis 无内置定时器）。
 *  判定纯时间化（用户拍板）：窗口最后发言在 24h 内 且 最后动作不是 dream
 *  （last_dream_time < last_event_time）；不依赖 live agent 存在性。
 *  已归档的会话（workspaceRegistry.archivedSessionIds）视为不存在，不 dream（用户拍板）。
 *  执行时尝试取 agent（liveAgents 或 ctx.agents.get），进程重启后取不到 → 跳过（旧窗口精神）。 */
export function scheduleDream(ctx: Context, cfg: DreamConfig, dir = '.dsh-meow', windowIndex: Map<string, string>): () => void {
  const timer = setInterval(() => {
    if (!cfg.enabled) return
    if (currentDream !== null) return // 串行
    const hour = hourInTimeZone(cfg.timeZone)
    if (hour < cfg.windowStart || hour >= cfg.windowEnd) return
    if (Date.now() - lastActivity() < cfg.idleMinutes * 60_000) return
    // 已归档会话集合（registry 全局归档；服务不可用时跳过检查）
    const archived = new Set<string>()
    try {
      const reg = (ctx as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as
        | { archivedSessionIds?: readonly string[] }
        | undefined
      for (const id of reg?.archivedSessionIds ?? []) archived.add(id)
    } catch {
      /* workspaceRegistry 不可用：不做归档过滤 */
    }
    for (const [sessionId, workspace] of windowIndex) {
      if (archived.has(sessionId)) continue // 已归档 = 当不存在
      const db = getDb(workspace, dir)
      const w = db.getWindow(sessionId)
      if (!w || !windowNeedsDream(w)) continue
      const agent =
        liveAgents.get(sessionId) ??
        (typeof ctx.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined)
      if (!agent) continue // 进程内无该窗口 agent（重启后）：跳过
      const started = startWindowDream(ctx, agent as never, workspace, dir)
      if (started) return // 一轮一个窗口
    }
  }, cfg.checkMinutes * 60_000)
  return () => clearInterval(timer)
}

/** 会话活跃度跟踪（模块级，单进程足够）。 */
let lastActivityAt = Date.now()
export function noteActivity(): void {
  lastActivityAt = Date.now()
}
export function lastActivity(): number {
  return lastActivityAt
}
