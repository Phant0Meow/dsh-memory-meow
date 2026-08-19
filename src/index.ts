/**
 * meow-memory v2 — 喵版跨会话记忆插件（host 端）。
 *
 * 设计（2026-08-15 与用户拍板）：
 * - SQLite 结构化存储（node:sqlite，宿主同款），每 level 一表：
 *   soul / user / project / fact / lesson / topic / rules；id=时间前缀（排序=创建顺序）。
 * - 注入：会话开头 soul/user 全量 + 记忆导引（project/topic 标题列表，正文自取）
 *   + 第一条用户消息关键词命中 fact/lesson 短条目；无每轮注入。
 * - 去重：.dsh-meow/sessions/<sessionId>.json 记录本会话注入过的 memory id。
 * - 工具：memory_remember / memory_search / memory_read / memory_update
 *   + memory_dream（手动整理本窗口）。
 * - 反思：干过活的 turn 结束后引导模型记忆——【一】新记忆（project 列表/纠正/偏好）、
 *   【二】更新判断（含关键词不准反推）、【三】通用要求（subcategory/关键词 8-13/importance）；
 *   topic 归 dream 轮处理（用户拍板 2026-08-19）。
 * - dream：按窗口夜间整理——每个窗口由自己的主 agent 整理自己建立/提取过的记忆，
 *   分两轮（原子记忆 project/fact/lesson → topic 记忆），project 小标题分段；
 *   updated_at 封存（"记忆时间戳"=最后更新时间）；串行；旧窗口不碰。
 * - 迁移：首次打开库时把旧 PROJECT.md 导入 SQLite，文件改名 .imported 留底。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { closeAllDbs, getDb } from './db.js'
import {
  abortDream,
  advanceDream,
  DREAM_MARKER,
  dreamTool,
  noteActivity,
  registerLiveAgent,
  scheduleDream,
  shortSessionId,
  type DreamConfig,
} from './dream.js'
import { buildHitInjection, buildInjection, markSearched, readInjected, releaseSeen } from './inject.js'
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
export const MEMORY_GUIDE = `【记忆系统】meow-memory 提供跨会话记忆

一、记忆数据总览
1. 记忆level分类：
- soul = 关于 AI 自身；
- user = 用户基本信息、基础偏好、重要的设备网络环境、关于用户本人的重要的事；每session注入，所以不要太冗杂，只记最重要的。
- rules = 设计原则/行为准则。全局准则 project 填"全局"，项目特定准则填 project 参数；
- fact = 细碎的小事实（一句话直陈 ≤60 字）；
- lesson = 错误与教训，踩过的坑，你从实践中学到的经验；
- topic = 话题，描述一件事的前因后果、发展脉络，为AI提供更全局的、事件发展的视野。在事情有发展变化时可更新。
- project = 项目，project记忆含子类：
  overview：项目的目的、总览、元信息、概括信息、基础介绍存入这里。
  structure：项目架构相关的信息存入这里。
  decisions：重要的设计决策存入这里。
  quotes：你认为重要的用户原话存入这里。
  ops：部署与数据相关的信息存入这里（端口/路径/启动方式/数据库位置/运维操作）。
  todo：你和用户的to do list，你认为即将要做的任务，记入这里。

2. 记忆结构与要求：
- 记忆都是分条目存入数据库，每条记忆不可过长（topic记忆除外）。
- 每条记忆应聚焦于一件事或一个事实。如果事实繁多，应分为多条记忆。
- 每条记忆必须要有关键词。
- topic记忆是特殊的一类，可以稍长，但也是聚焦于一件事，不可以很多事件混在一起。
- 发现某条记忆涉及信息太多，应主动将其拆分。
- 记忆库中的记忆应时刻保持最新状态，如果事实状态、项目状态已更新，应及时更新记忆内容，或者修改记忆状态。

3. 记忆注入说明
- 你会时常收到相关记忆的自动注入（首轮长期记忆 + 每消息关键词命中），无需操作；
- 注入的记忆仅供参考：
   它可能与当前任务相关，也可能无关——若发现注入与当前话题无关，通常是该记忆关键词不准，可更新它。
   它可能准确，也可能过时或错漏——若发现记忆内容有错漏、与事实不符、或已过时，请务必及时更新。
- 记忆按"最后更新时间戳"排序，冲突以最新为准，旧的可作过程参考。


二、你能用的记忆工具：

【写记忆】

1. 添加新记忆：memory_remember
- 必填参数：content（内容）/ project/ keywords（8-13 个检索关键词）/ importance（重要性评估）。
- 与已有条目高度重复应该用update合并，更新而非新增。
- 已有条目信息太多需要拆解，可以用memory_remember新增条目。

2. 更新已有记忆条目：memory_update
- 必须有记忆 id 来准确指向某条记忆。
- 如果你觉得 keywords/content/project/importance/status 信息不对，可用对应参数更新它。
- 一次 update 可使用多个参数修改多项。
- 参数按需，如果你不想改某一项，就不带那个参数。

【查记忆】

3. 查看项目全景：memory_project
- 提供关于项目的全局信息，可帮助你快速了解该项目。
- 包含设计历史、技术决策、用户原话、项目进度等。

4. 检索记忆：memory_search
- query 必填：传关键词/句子（如 "记忆插件 部署"），不要空查。
- 返回检索元数据视图，不含原文；你可以根据关键词判断那条记忆是否与你需要的信息有关。需要某条记忆的全文用 memory_read。
- 只检索其他会话建立的记忆；本会话已注入/已检索过的自动排除。
- 默认搜 fact/lesson/topic/rules；
- 支持选择性搜索某个 level/project/status（可多选，逗号分割）。
- 支持按时间检索，如 days: 30 = 只搜最近 30 天创建的。
- 默认top k = 10，但可选择 k = 1-50。

5. 读取单条记忆：memory_read
- 按记忆 id 读完整内容（含 keywords/importance/状态等元数据）。

6. 查重/找冲突：memory_find_similar
- 按记忆 id 找内容相似条目。

7. 可搜索源文件
- 记忆数据存为 SQLite（路径具体见 memory_project 返回末尾说明）；memory_search 不好用时也可直接检索数据库。
- 记忆库里找不到时可直接搜聊天记录原文。
  聊天记录原文：$DSH_HOME/sessions/<工作区>/<会话id>/session.jsonl.zstd——Zstandard 压缩的 JSONL；
  用 Node ≥22.13 的 node:zlib 一行解压搜索：
  node -e "console.log(require('node:zlib').zstdDecompressSync(require('fs').readFileSync(process.argv[1])).toString())" <文件>
- 尤其是，当用户问及细节信息，记忆搜不到，就参考用户描述和记忆里搜到的相关线索，直接去搜聊天记录原文。

【整理记忆】

8. 整理本窗口记忆：memory_dream
- 一般夜间自动触发，也可以手动调用。


三、记忆写作准则（新建和更新记忆时都必须遵守）：
1. content 准则
- 不要太长，如果过长就分为多条记录。
- 信息密度要大，不要啰嗦。
- 如果用户提供了项目描述，应尽量保留用户原话——原话里包含用户的潜在逻辑，很珍贵。
- 时刻保持最新，如发现错误或过时，应立即修改内容或归档。不可以允许错误或过时的记忆内容保持 active 状态。

2. keywords 准则
- 你要明白，关键词是供记忆系统检索用的，当用户 prompt 命中某条记忆的关键词，它就会被提取。
- 所以你需要反向思考，"你希望在用户 prompt 提及哪些词的时候，这条记忆被检索到？"以此作为关键词的写入标准。
- 每个记忆条目，提取 8-13 个关键词供检索。
- 不要用项目名当关键词，用更加针对这条记忆本身的信息作为关键词。
- 优先提取核心实体、语义中心、专有名词。
- 如果某条记忆被注入的时机不合理，和你们聊的事完全无关，那应该是关键词总结的不好。你可以更新它。

3. importance 准则
- 非常重要、致命、犯错会很糟糕的决策/红线/教训，和健康、安全相关的准则 → 4；
- 用户强调的，用户认为重要的，全局适用的准则，全局适用的通用信息 → 3；
- 用户决策，跨越多个文件不好核实的抽象总结 → 2；
- 琐碎的原子信息，适用性不广的信息，一些小信息想随手记一笔 → 1。

4. status 准则
- 新建记忆默认 active 状态。memory_update 可修改 status。
- stale=完结（todo 完成 → stale 视为 done）；
- archived=删除（过时信息、作废、重复、被替代的旧版本）；
- 其他情况保持 active 不改标。

5. project 准则
- 如果用户在和你说一个全新的项目，你要建立新 project。
- 如果是适用于某一个具体的项目的信息，你要在 remember 时写入该 project 名。
- 如果是全局适用的信息，不局限于任何一个项目，project 填"全局"。
- 如果并非适用于全局，但有多个项目都适用这一条信息，project 用英文逗号分隔多个项目名（如 "dsh, femwa"）。
- 如果你认为某条记忆的 project 信息写错了，或者写的不全，应该及时更新它。`

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
  /** 关键词命中条数上限（fact/lesson/rules/topic 短条目，每条用户消息命中注入）。 */
  hitTopK: z.number().min(0).max(10).default(2),
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
    hitTopK: c.hitTopK ?? 2,
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
  /** 子代理权威标记（dsh：origin === 'subagent'）；GUI fork 的会话只有 parentSession 无 origin。 */
  origin?: unknown
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
  loadWindowIndex(resolved.projectDir) // 恢复窗口索引（热重载/重启后旧窗口不失联）
  perf(`window-index restored ${windowIndex.size} windows`)

  // 工具注册 + disposer 收集：热重载/重启时旧 fiber 的工具必须注销，
  // 否则新 apply 重复注册同名工具会抛异常 → apply 中断 → 工具/手册/pre-step 全失效
  // （真机踩坑 2026-08-17：04:35 配置变更触发的 reload 后首轮注入消失）。
  const toolDisposers: Array<() => void> = []
  registerMemoryTools((t) => {
    const dispose = ctx.tools.register(t)
    if (typeof dispose === 'function') toolDisposers.push(dispose)
  }, resolved.projectDir)
  const disposeDreamTool = ctx.tools.register(dreamTool(ctx, resolved.projectDir))
  if (typeof disposeDreamTool === 'function') toolDisposers.push(disposeDreamTool)
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
  // 插件注入轮（反思/dream 的 steer 消息轮）内的事件不刷新 last_event_time：
  // dream 轮自身事件会推后窗口活跃度 → 收尾后 last_dream_time < last_event_time
  // → 窗口永远"需要 dream"，配合中断/多进程场景造成反复 dream。
  const lastWindowWrite = new Map<string, number>()
  const isPluginTurn = new Map<string, boolean>() // sid -> 本 turn 是否为 meow-memory 插件轮
  ctx.on('session/event', (session: { id?: string; header?: SessionHeaderLike }, event: { time?: number; type?: string; data?: unknown }) => {
    perfEvent()
    noteActivity()
    const t = event?.type
    const sid = session?.id
    const cwd = session?.header?.cwd
    // 压缩信号：会话历史被压缩（内容已不在上下文）→ 释放本会话已见记录，
    // 允许之前注入/检索过的记忆被再次命中提取。
    if (t === 'compaction/summary' || t === 'compaction/start') {
      if (typeof sid === 'string' && typeof cwd === 'string') {
        releaseSeen(cwd, sid, resolved.projectDir)
        ctx.logger.info(`meow-memory: compaction signal, released seen memory for session ${shortSessionId(sid)}`)
      }
      return
    }
    if (typeof sid === 'string') {
      if (t === 'turn/start') {
        isPluginTurn.set(sid, false) // 新轮重置
        return
      }
      if (t === 'user/message') {
        const src = (event.data as { source?: { kind?: string; plugin?: string } } | undefined)?.source
        if (src?.kind === 'plugin' && src.plugin === 'meow-memory') {
          isPluginTurn.set(sid, true) // 反思/dream 指令轮
          return // 指令消息本身也不刷新活跃度
        }
      }
      if (isPluginTurn.get(sid)) return // 插件轮内：不 touchWindow
    }
    if (t !== 'user/message' && t !== 'turn/end' && t !== 'assistant/message' && t !== 'tool/result') return
    if (typeof sid !== 'string' || typeof cwd !== 'string' || typeof event?.time !== 'number') return
    const now = Date.now()
    const last = lastWindowWrite.get(sid) ?? 0
    if (now - last < 5000) return // 节流：5 秒内同窗口只写一次
    lastWindowWrite.set(sid, now)
    const db = getDb(cwd, resolved.projectDir)
    db.touchWindow(sid, cwd, event.time)
    windowIndex.set(sid, cwd)
    persistWindowIndex() // 窗口索引落盘（热重载/重启后恢复）
  })

  // 1) 注入：首轮快照（soul/user/设计原则/导引，仅一次）+ 命中链路（第二条起每条真实用户消息都跑）。
  // 首轮判定（真机踩坑 2026-08-16）：不能看 decision.messages[0]——首条用户消息可能与
  // 插件通知消息同批到达（如 user-approval 的 policy 变更通知，source.kind='plugin'），
  // messages[0] 未必是用户消息。正确判定 = 本会话日志里还没有任何 user/message
  // （harness 在 pre-step 之后才 append 当前消息，首条消息时日志必为空）+ 消息列表里
  // 存在真实用户消息（source.kind === 'user'）。
  // 首条消息：只注入长期记忆快照，绝不跑命中链路（用户拍板：命中从第二轮起）。
  // 进程重启后恢复的会话：日志已有 user/message → 视为首轮已注入，只走命中链路。
  const firstUserHandled = new Set<string>()
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<unknown> => {
    const t0 = Date.now()
    const decision = await next()
    if (decision === undefined || decision.kind !== 'enter' || signal.aborted) return decision
    if (decision.messages.length === 0) return decision
    // 子代理不注入（origin === 'subagent'，dsh 权威标记）：它们的 prompt 由父代理提供
    // （如 dsh-femwa 的角色上下文）。注意不能只看 parentSession——GUI fork/续写的
    // 主会话也有 parentSession（真机踩坑 2026-08-17：fca10feb 被误判为子代理导致注入全失效）。
    if (agent.session.header.origin === 'subagent') return decision
    registerLiveAgent(agent)
    const sid = sessionIdOfAgent(agent)
    const ws = workspaceOfAgent(agent)

    // 真实用户消息（跳过插件通知等，source.kind='plugin' 的进不来）。
    const userMsgs = decision.messages.filter((m) => m.source?.kind === 'user')
    if (userMsgs.length === 0) return decision // 工具轮/纯插件消息：不注入

    // 首条用户消息（本进程内每个会话只判定一次）。
    if (!firstUserHandled.has(sid)) {
      firstUserHandled.add(sid)
      let priorUser = 0
      for (const e of agent.session.events) {
        if ((e as { type?: string })?.type === 'user/message') priorUser++
      }
      if (ws) {
        try {
          appendFileSync(join(ws, resolved.projectDir, 'dream-debug.log'), `[${new Date().toISOString()}] pre-step first pid=${process.pid} sid=${shortSessionId(sid)} priorUser=${priorUser} userMsgs=${userMsgs.length}\n`)
        } catch { /* 日志失败不阻塞 */ }
      }
      if (priorUser === 0) {
        // 会话首条消息：只注入长期记忆快照，不跑命中链路。
        if (ws) {
          const firstUser = userMsgs[0]
          const db = getDb(ws, resolved.projectDir)
          if (resolved.autoMigrate && existsSync(join(ws, resolved.projectDir, 'PROJECT.md'))) {
            const n = migrateLegacy(db, ws, resolved.projectDir)
            if (n !== null) ctx.logger.info(`meow-memory: migrated legacy PROJECT.md → SQLite (${n} entries)`)
          }
          const firstText = firstUser.content
            .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string')
            .map((b: { text?: string }) => b.text ?? '')
            .join(' ')
          const injected = buildInjection(db, ws, sid, firstText, {
            hitTopK: resolved.hitTopK,
            titleMax: resolved.titleMax,
          }, resolved.projectDir)
          if (injected) {
            const rewritten = decision.messages.map((m) => m === firstUser
              ? { ...m, content: [{ type: 'text', text: injected.text }, ...m.content] }
              : m)
            ctx.logger.info(`meow-memory: injected memory block (${injected.text.length} chars) before first user message`)
            return { ...decision, messages: rewritten }
          }
        }
        return decision // 首条消息：不跑命中链路（首轮只注入长期记忆）
      }
      // 恢复的会话（日志已有历史消息）：首轮快照由上个进程注入过，只走命中链路。
    }

    // 命中链路（从第二条用户消息起）：每条含真实用户消息的请求都跑关键词检索命中
    // （top-K）。工具轮/子步骤的请求消息不含真实用户消息 → 不触发；
    // 命中 id 记入已见，不再重复。
    if (ws) {
      const lastUser = [...decision.messages].reverse().find((m) => m.source?.kind === 'user')
      if (lastUser !== undefined) {
        const text = lastUser.content
          .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string')
          .map((b: { text?: string }) => b.text ?? '')
          .join(' ')
        const db = getDb(ws, resolved.projectDir)
        const hit = buildHitInjection(db, ws, sid, text, {
          hitTopK: resolved.hitTopK,
          titleMax: resolved.titleMax,
        }, resolved.projectDir)
        try {
          appendFileSync(join(ws, resolved.projectDir, 'dream-debug.log'), `[${new Date().toISOString()}] hit-chain pid=${process.pid} sid=${shortSessionId(sid)} text=${text.slice(0, 40).replace(/\n/g, ' ')} hit=${hit === null ? 'null' : 'yes'}\n`)
        } catch { /* 日志失败不阻塞 */ }
        if (hit !== null) {
          const rewritten = decision.messages.map((m) => m === lastUser
            ? { ...m, content: [{ type: 'text', text: hit.text }, ...m.content] }
            : m)
          return { ...decision, messages: rewritten }
        }
      }
      if (Date.now() - t0 > 10) perf(`pre-step hit ${Date.now() - t0}ms sid=${shortSessionId(sid)}`) // 热路径超 10ms 有鬼
    }
    return decision
  })

  // 2) turn 结束：dream 轮推进 / 自动反思。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const t0 = Date.now()
    if (agent.session.header.origin === 'subagent') return // 子代理不参与（origin 权威判定）
    registerLiveAgent(agent)
    const endReason = lastTurnEndReason(agent.session.events)
    const dreamTurn = wasDreamTurn(agent.session.events)
    const wsTs = workspaceOfAgent(agent)
    const sidTs = sessionIdOfAgent(agent)
    if (wsTs) {
      try {
        appendFileSync(join(wsTs, resolved.projectDir, 'dream-debug.log'), `[${new Date().toISOString()}] turn-stopping pid=${process.pid} sid=${shortSessionId(sidTs)} reason=${endReason ?? 'none'} wasDream=${dreamTurn}\n`)
      } catch { /* 日志失败不阻塞 */ }
    }
    // 用户按停止（aborted/interrupted）：不反思、不推进下一组；但 dream 轮必须立即收尾，
    // 否则 DB 租约残留，窗口要等租约过期（30min）才能再 dream。
    if (endReason === 'aborted' || endReason === 'interrupted') {
      if (dreamTurn) abortDream(agent, resolved.projectDir)
      return
    }
    if (dreamTurn) {
      advanceDream(agent, resolved.projectDir) // dream 轮：推进下一组或收尾（含孤儿收尾）
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
    for (const dispose of toolDisposers) {
      try {
        dispose()
      } catch {
        /* 注销失败不阻塞 */
      }
    }
    stopDream()
    closeAllDbs()
  })
}

// ── 模块级窗口索引（sessionId → workspace） ────────────────────────────────
// 持久化到 homedir/.dsh-meow/window-index.json：热重载/重启会重置模块级 Map，
// 若不恢复则旧窗口（reload 后无新事件）从 dream 检查中失联——有记忆也不 dream。
// 恢复后 agent 经 ctx.agents（AgentRegistry，harness 进程级）获取，不受插件 reload 影响。

const windowIndex = new Map<string, string>()
const WINDOW_INDEX_FILE = join(homedir(), '.dsh-meow', 'window-index.json')

/** apply 时恢复窗口索引：①文件（上次落盘）→ workspace 集合；②每个已知 workspace
 *  的 windows 表（DB 持久化，含 reload 前全部窗口）补全——旧窗口（reload 后无新
 *  事件、文件里没有）也能恢复，不会从 dream 检查中失联。 */
function loadWindowIndex(dir = '.dsh-meow'): void {
  const workspaces = new Set<string>()
  try {
    const merged = JSON.parse(readFileSync(WINDOW_INDEX_FILE, 'utf8')) as Record<string, unknown>
    for (const [sid, ws] of Object.entries(merged)) {
      if (typeof ws === 'string' && ws.length > 0) {
        windowIndex.set(sid, ws)
        workspaces.add(ws)
      }
    }
  } catch {
    /* 无文件/损坏 */
  }
  for (const ws of workspaces) {
    try {
      for (const w of getDb(ws, dir).listWindows()) {
        if (typeof w.workspace === 'string' && w.workspace.length > 0) windowIndex.set(w.session_id, w.workspace)
      }
    } catch {
      /* 该 workspace 库不可用：跳过 */
    }
  }
}

/** 窗口索引落盘（读-合并-写，低频事件驱动；失败不阻塞）。 */
function persistWindowIndex(): void {
  try {
    mkdirSync(dirname(WINDOW_INDEX_FILE), { recursive: true })
    let merged: Record<string, string> = {}
    try {
      merged = JSON.parse(readFileSync(WINDOW_INDEX_FILE, 'utf8')) as Record<string, string>
    } catch {
      /* 首次写入 */
    }
    for (const [sid, ws] of windowIndex) merged[sid] = ws
    writeFileSync(WINDOW_INDEX_FILE, JSON.stringify(merged), 'utf8')
  } catch {
    /* 持久化失败不阻塞 */
  }
}

// re-export 供测试/调试/其他插件
export { PLUGIN_SOURCE, REFLECT_MARKER }
export { MemoryDb, memoryDbPath, getDb, closeAllDbs, LEVELS, newId, PROJECT_SUBCATEGORIES, projectList, projectCovers, projectLabel } from './db.js'
export { migrateLegacy } from './migrate.js'
export { buildHitInjection, buildInjection, readSeen, markSearched, readInjected, markInjected, sessionsFile, getCurrentProject, setCurrentProject } from './inject.js'
export { buildReflectMessage, consecutiveToolSteps, scanTurn } from './reflect.js'
export { tokenize, search, findSimilar, topicDrift, recencyWeight } from './bm25.js'
export { collectDreamRounds, buildDreamMessage, windowNeedsDream, DREAM_MARKER, noteActivity, hourInTimeZone, startWindowDream, advanceDream, abortDream, recoverInterruptedDream } from './dream.js'
