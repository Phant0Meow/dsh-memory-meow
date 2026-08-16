/**
 * meow-memory v2 — 喵版跨会话记忆插件（host 端）。
 *
 * 设计（2026-08-15 与用户拍板）：
 * - SQLite 结构化存储（node:sqlite，宿主同款），每 level 一表：
 *   soul / user / project / fact / lesson / topic；id=时间前缀（排序=创建顺序）。
 * - 注入：会话开头 soul/user 全量 + 记忆导引（project/topic 标题列表，正文自取）
 *   + 第一条用户消息关键词命中 fact/lesson 短条目；无每轮注入。
 * - 去重：.dsh-meow/sessions/<sessionId>.json 记录本会话注入过的 memory id。
 * - 工具：memory_remember / memory_search / memory_read / memory_update
 *   + memory_dream（手动整理本窗口）。
 * - 反思：干过活的 turn 结束后引导模型记忆；topic 用目标句规则归属，
 *   关键词偏离信号只提醒不拍板，重写附底稿。
 * - dream：按窗口夜间整理——每个窗口由自己的主 agent 整理自己建立的记忆，
 *   按 project 分组逐轮，dream_at 封存（"记忆时间戳"）；串行；旧窗口不碰。
 * - 迁移：首次打开库时把旧 PROJECT.md 导入 SQLite，文件改名 .imported 留底。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { closeAllDbs, getDb } from './db.js'
import {
  advanceDream,
  DREAM_MARKER,
  dreamTool,
  noteActivity,
  registerLiveAgent,
  scheduleDream,
  type DreamConfig,
} from './dream.js'
import { buildInjection, markSearched, readInjected, releaseSeen } from './inject.js'
import { migrateLegacy } from './migrate.js'
import { buildReflectMessage, consecutiveToolSteps, PLUGIN_SOURCE, REFLECT_MARKER, scanTurn } from './reflect.js'
import { registerMemoryTools } from './tools.js'

export const name = 'meow-memory'

/** tools 是硬依赖（注册 memory_*）；systemPrompt 为可选服务（ctx.get 兜底）。 */
export const inject = ['tools']

/**
 * 记忆系统静态手册 —— 挂进 system prompt（order 130 = 工具指南区间末尾，
 * 紧随各 tool:* 说明（100–116）之后，与工具说明列在一起）。
 * 文本恒定、不随会话变化 → 前缀稳定，KV 缓存友好；动态记忆内容（soul/user/
 * 导引/命中）仍走首条消息注入。文案与 tools.ts 的工具 schema 保持一致。
 */
export const MEMORY_GUIDE = `【记忆系统】meow-memory 提供跨会话记忆（SQLite 六层：soul=AI自身 / user=用户偏好 /
project=项目（含子类 overview/structure/decisions/quotes/ops/todo）/ fact=原子事实 /
lesson=教训 / topic=话题）。记忆按"记忆时间戳"排序，冲突以最新为准，旧的可作过程参考。
工具：
- memory_remember —— 写记忆。必填 content；level 选层（默认 fact）；project 记项目名
  （femwa/meow-memory/meow-eyes/dsh…，level=project 必填）；fact/lesson 一句话 ≤60 字；
  topic 需 title（建议配 goal 目标句与 project 项目名）；用户介绍设计思路/框架/决策理由的原话必须保留措辞不转述；
  写前可先 memory_find_similar 查重。
- memory_search —— 检索。只返回其他会话建立的记忆（本会话已注入/已检索的自动排除）；
  默认搜 fact/lesson/topic；支持 level 逗号多选、project/status/days 过滤；k 1-50。
- memory_project —— 当你需要全面了解某个项目的整体概述、设计历史、技术决策、用户原话或进度时使用。
- memory_find_similar —— 按 id 找内容相似条目（查重/找冲突用）。
- memory_read —— 读完整条目（含元数据）。
- memory_update —— 改条目（content/status 含 archived=完结、stale=过时；todo 的 stale=已完成；
  importance/goal/project/subcategory/keywords（手动修正关键词，默认自动提取））。
- memory_dream —— 立即整理本窗口记忆（通常夜间自动）。`

// ── 性能诊断（perf.log，固定位置 ~/.dsh-meow/perf.log；卡死时查数据） ────────
// 模块级计数器：模块只初始化一次；apply 每次执行 +1——若日志里 apply 编号异常
// 跳跃/重复，说明 apply 被多次调用（handler 叠加）。事件计数看事件吞吐。
const PERF_LOG = join(homedir(), '.dsh-meow', 'perf.log')
let applyCount = 0
let evtCount = 0
let perfBoot = Date.now()
let lastPerfLog = Date.now()
function perf(msg: string): void {
  try {
    mkdirSync(dirname(PERF_LOG), { recursive: true })
    appendFileSync(PERF_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不阻塞 */
  }
}
/** 事件吞吐统计：每 5 秒落一条（同步追加，不阻塞）。 */
function perfEvent(): void {
  evtCount++
  const now = Date.now()
  if (now - lastPerfLog >= 5000) {
    const elapsed = (now - perfBoot) / 1000
    perf(`evt total=${evtCount} elapsed=${elapsed.toFixed(1)}s rate=${(evtCount / Math.max(elapsed, 0.001)).toFixed(1)}/s`)
    lastPerfLog = now
  }
}

export const Config = z.object({
  /** 总开关：false 时注入、反思、工具全部停用。 */
  enabled: z.boolean().default(true),
  /** 记忆目录（相对工作区）。 */
  projectDir: z.string().default('.dsh-meow'),
  /** 关键词命中条数上限（fact/lesson 短条目）。 */
  hitTopK: z.number().min(0).max(10).default(3),
  /** 导引标题截断长度。 */
  titleMax: z.number().min(10).max(200).default(40),
  /** 是否在 ReAct 任务结束后自动注入反思。 */
  reflect: z.boolean().default(true),
  /** 单任务内连续工具 step 达到该值才在结束时触发反思（用户拍板：react ≥7 轮）。 */
  reflectTurns: z.number().min(1).max(50).default(7),
  /** 首次打开库时自动迁移旧 PROJECT.md。 */
  autoMigrate: z.boolean().default(true),
  /** 夜间整理。 */
  dream: z
    .object({
      enabled: z.boolean().default(true),
      windowStart: z.number().min(0).max(23).default(0),
      windowEnd: z.number().min(0).max(24).default(7),
      idleMinutes: z.number().min(1).default(30),
      minIntervalHours: z.number().min(1).default(24),
      checkMinutes: z.number().min(1).default(15),
      // 用户系统是美区时间（隐私设置），夜间窗口按中国时区计算
      timeZone: z.string().default('Asia/Shanghai'),
    })
    .default({}),
})

interface ResolvedConfig {
  enabled: boolean
  projectDir: string
  hitTopK: number
  titleMax: number
  reflect: boolean
  reflectTurns: number
  autoMigrate: boolean
  dream: DreamConfig
}

function resolveConfig(config: unknown): ResolvedConfig {
  const c = (config ?? {}) as Partial<ResolvedConfig>
  const d = (c.dream ?? {}) as Partial<DreamConfig>
  return {
    enabled: c.enabled ?? true,
    projectDir: c.projectDir ?? '.dsh-meow',
    hitTopK: c.hitTopK ?? 3,
    titleMax: c.titleMax ?? 40,
    reflect: c.reflect ?? true,
    reflectTurns: c.reflectTurns ?? 7,
    autoMigrate: c.autoMigrate ?? true,
    dream: {
      enabled: d.enabled ?? true,
      windowStart: d.windowStart ?? 0,
      windowEnd: d.windowEnd ?? 7,
      idleMinutes: d.idleMinutes ?? 30,
      minIntervalHours: d.minIntervalHours ?? 24,
      checkMinutes: d.checkMinutes ?? 15,
      timeZone: d.timeZone ?? 'Asia/Shanghai',
    },
  }
}

interface SessionHeaderLike {
  cwd?: string
  id?: string
  parentSession?: unknown
}

/** 工作区 = 会话 cwd（项目根）；目录名 projectDir 单独下传给各模块（防双拼）。 */
function workspaceOfAgent(agent: { session?: { header?: SessionHeaderLike } }): string | null {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

function sessionIdOfAgent(agent: { session?: { header?: SessionHeaderLike } }): string {
  const id = agent?.session?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown'
}

/** 本 turn 是否为 dream 轮（事件流里存在 meow-memory 的 dream 指令消息）。 */
function wasDreamTurn(events: readonly unknown[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: string }> } }
    if (e?.type === 'turn/start') break
    if (e?.type === 'user/message' && e.data?.source?.kind === 'plugin' && e.data.source.plugin === 'meow-memory') {
      if ((e.data.content ?? []).some((b) => b.type === 'text' && b.text?.includes(DREAM_MARKER))) return true
    }
  }
  return false
}

/** 最近一个 turn/end 的 reason.kind（aborted/interrupted 表示用户停止，不反思不推进）。 */
function lastTurnEndReason(events: readonly unknown[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { reason?: { kind?: string } } }
    if (e?.type === 'turn/start') break
    if (e?.type === 'turn/end' && typeof e.data?.reason?.kind === 'string') return e.data.reason.kind
  }
  return null
}

export async function apply(ctx: Context, config: unknown): Promise<void> {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    ctx.logger.info('meow-memory: disabled by config')
    return
  }
  applyCount++
  perf(`apply #${applyCount} pid=${process.pid}`)

  registerMemoryTools((t) => ctx.tools.register(t), resolved.projectDir)
  ctx.tools.register(dreamTool(ctx, resolved.projectDir))
  ctx.logger.info('meow-memory: memory_remember/search/read/update + memory_dream registered')

  // 记忆系统手册挂进 system prompt（静态文本 → KV 缓存友好；order 130 = 工具指南区间末尾，
  // 与各 tool:* 说明（100–116）列在一起，不独占开头）。
  // systemPrompt 是可选服务（别的 profile 可能没加载 dsh-system-prompt），取不到就跳过。
  const sp = (ctx as { get?: (name: string) => unknown }).get?.('systemPrompt') as
    | { section?: (section: { name: string; order: number; text: string }) => unknown }
    | undefined
  sp?.section?.({ name: 'meow-memory:guide', order: 130, text: MEMORY_GUIDE })

  // 窗口表：只处理低频事件类型（流式 assistant/chunk 每块一个事件，绝不逐块写库）。
  // 节流：同一窗口 5 秒内最多落库一次（内存记 lastWrite，事件循环零阻塞）。
  const lastWindowWrite = new Map<string, number>()
  ctx.on('session/event', (session: { id?: string; header?: SessionHeaderLike }, event: { time?: number; type?: string }) => {
    perfEvent()
    noteActivity()
    const t = event?.type
    // 压缩信号：会话历史被压缩（内容已不在上下文）→ 释放本会话已见记录，
    // 允许之前注入/检索过的记忆被再次命中提取。
    if (t === 'compaction/summary' || t === 'compaction/start') {
      const sid = session?.id
      const cwd = session?.header?.cwd
      if (typeof sid === 'string' && typeof cwd === 'string') {
        releaseSeen(cwd, sid, resolved.projectDir)
        ctx.logger.info(`meow-memory: compaction signal, released seen memory for session ${sid.slice(0, 8)}`)
      }
      return
    }
    if (t !== 'user/message' && t !== 'turn/end' && t !== 'assistant/message' && t !== 'tool/result') return
    const sid = session?.id
    const cwd = session?.header?.cwd
    if (typeof sid !== 'string' || typeof cwd !== 'string' || typeof event?.time !== 'number') return
    const now = Date.now()
    const last = lastWindowWrite.get(sid) ?? 0
    if (now - last < 5000) return // 节流：5 秒内同窗口只写一次
    lastWindowWrite.set(sid, now)
    const db = getDb(cwd, resolved.projectDir)
    db.touchWindow(sid, cwd, event.time)
    windowIndex.set(sid, cwd)
  })

  // 1) 第一条用户消息注入记忆块。
  // 只注入一次：内存 Set 命中 → 热路径直接放行（绝不重复注入/检索）；
  // Set miss（进程重启后）→ 反向扫描尾部兜底，历史已有 user/message 视为已注入。
  const injectedSessions = new Set<string>()
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<unknown> => {
    const t0 = Date.now()
    const decision = await next()
    if (decision === undefined || decision.kind !== 'enter' || signal.aborted) return decision
    if (decision.messages.length === 0) return decision
    // 子代理不注入：它们的 prompt 由父代理提供（如 dsh-femwa 的角色上下文）。
    if (agent.session.header.parentSession !== undefined) return decision
    registerLiveAgent(agent)
    const sid = sessionIdOfAgent(agent)
    if (injectedSessions.has(sid)) {
      if (Date.now() - t0 > 10) perf(`pre-step hot ${Date.now() - t0}ms sid=${sid.slice(0, 8)}`) // 热路径超 10ms 有鬼
      return decision // 已注入：零开销放行
    }
    {
      const evs = agent.session.events
      let hasUser = false
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i] as { type?: string }
        if (e?.type === 'user/message') {
          hasUser = true
          break
        }
        if (e?.type === 'turn/start' && evs.length - i > 300) break // 最多回看 300 事件
      }
      if (hasUser) {
        injectedSessions.add(sid)
        return decision
      }
    }
    // 只对真实用户消息注入（source.kind === 'user'）。
    const first = decision.messages[0]
    if (first.source.kind !== 'user') return decision

    const ws = workspaceOfAgent(agent)
    if (!ws) return decision
    const db = getDb(ws, resolved.projectDir)
    if (resolved.autoMigrate && existsSync(join(ws, resolved.projectDir, 'PROJECT.md'))) {
      const n = migrateLegacy(db, ws, resolved.projectDir)
      if (n !== null) ctx.logger.info(`meow-memory: migrated legacy PROJECT.md → SQLite (${n} entries)`)
    }

    const firstText = first.content
      .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string')
      .map((b: { text?: string }) => b.text ?? '')
      .join(' ')

    const injected = buildInjection(db, ws, sid, firstText, {
      hitTopK: resolved.hitTopK,
      titleMax: resolved.titleMax,
    }, resolved.projectDir)
    if (!injected) return decision
    injectedSessions.add(sid)

    const rewritten = [
      { ...first, content: [{ type: 'text', text: injected.text }, ...first.content] },
      ...decision.messages.slice(1),
    ]
    ctx.logger.info(`meow-memory: injected memory block (${injected.text.length} chars) before first user message`)
    return { ...decision, messages: rewritten }
  })

  // 2) turn 结束：dream 轮推进 / 自动反思。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const t0 = Date.now()
    if (agent.session.header.parentSession !== undefined) return // 子代理不参与
    registerLiveAgent(agent)
    // 用户按停止（aborted/interrupted）：不反思、不推进——停止就是要停，别又开新请求
    const endReason = lastTurnEndReason(agent.session.events)
    if (endReason === 'aborted' || endReason === 'interrupted') return
    if (wasDreamTurn(agent.session.events)) {
      advanceDream(agent) // dream 轮：推进下一组或收尾（不反思）
      return
    }
    if (!resolved.reflect) return
    const ws = workspaceOfAgent(agent)
    if (!ws) return
    const { sawToolCall, lastToolName, sawReflect, turnText } = scanTurn(agent.session.events)
    if (sawReflect) return // 本 turn 已反思过（含反思轮自身结束）
    if (!sawToolCall) return // 纯聊天轮，不反思
    if (lastToolName !== undefined && lastToolName.startsWith('memory_')) return // 已主动记忆
    if (consecutiveToolSteps(agent.session.events) < resolved.reflectTurns) return // 单任务内连续工具 step 不足
    const message = buildReflectMessage(ws, turnText, resolved.projectDir)
    agent.steer(message)
    if (Date.now() - t0 > 20) perf(`turn-stopping slow ${Date.now() - t0}ms`)
    ctx.logger.info(`meow-memory: reflect steered after ${resolved.reflectTurns}+ tool turns`)
  })

  // 3) 夜间整理（按窗口；windowIndex 记录 sessionId → workspace）。
  const stopDream = scheduleDream(ctx, resolved.dream, resolved.projectDir, windowIndex)
  ctx.logger.info(
    `meow-memory: dream scheduled (window ${resolved.dream.windowStart}:00-${resolved.dream.windowEnd}:00, idle ${resolved.dream.idleMinutes}m, every ${resolved.dream.checkMinutes}m)`,
  )

  ctx.on('dispose', () => {
    stopDream()
    closeAllDbs()
  })
}

// ── 模块级窗口索引（sessionId → workspace；重启后由 session/event 重建） ────

const windowIndex = new Map<string, string>()

// re-export 供测试/调试/其他插件
export { PLUGIN_SOURCE, REFLECT_MARKER }
export { MemoryDb, memoryDbPath, getDb, closeAllDbs, LEVELS, newId, PROJECT_SUBCATEGORIES } from './db.js'
export { migrateLegacy } from './migrate.js'
export { buildInjection, readSeen, markSearched, readInjected, markInjected, sessionsFile } from './inject.js'
export { buildReflectMessage, consecutiveToolSteps, scanTurn } from './reflect.js'
export { tokenize, search, findSimilar, topicDrift, recencyWeight } from './bm25.js'
export { groupWindowMemories, buildDreamMessage, windowNeedsDream, DREAM_MARKER, isDreaming, noteActivity, hourInTimeZone } from './dream.js'
