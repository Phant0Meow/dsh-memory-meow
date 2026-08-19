/**
 * meow-memory v2 — 按窗口夜间整理（dream）。
 *
 * 用户拍板（2026-08-15 原始设计 + 2026-08-19 改版）：
 * - 每个 session 窗口由它自己的主 agent 整理：只发本窗口（source_session）建立的
 *   七层记忆（soul/user/project/fact/lesson/topic/rules），对着自己的完整对话上下文整理。
 * - 2026-08-19 改版（用户拍板）：① 不再按 project 逐轮——所有 project 混在同一轮，
 *   用【project：xxx】小标题分段，最后一段【project：无项目 - 全局信息，或缺少项目标签】；
 *   ② 固定两轮：第 1 轮=原子记忆（project/fact/lesson/rules/soul/user，不含 topic），
 *   第 2 轮=topic 记忆，空轮跳过（轮数动态，消息显示"第 N/M 组"）；③ 记忆范围=本窗口
 *   建立的 ∪ 本窗口提取过的（sessions/<id>.json 的 injected+searched）；④ 条目展示
 *   绝对时间戳（最后更新时间）；组内排序 project → level → 创建时间不变。
 * - T = dream 开始前窗口最后一轮正常对话时间（先记死）；收尾时该窗口所有条目
 *   updated_at = T（"记忆时间戳"=最后更新时间），windows 表 last_dream_time = T。
 * - 判定：窗口最后事件时间 > 24h 前 且 > 上次 dream 时间 → 需要 dream。
 * - 串行：同一时刻只有一个进行中的 dream 任务；旧窗口（无 live agent）不碰。
 *
 * 冲突处理：memory_search 返回 top-k 后按 updated_at 重排 + 顶部提示；
 * agent 据"记忆时间戳"判断新旧（工具层乐观锁留待迭代）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, projectList, type Level, type MemoryRow } from './db.js'
import { readSeen } from './inject.js'
import { workspaceOf } from './tools.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'meow-memory' }

/** dream 消息识别标记（turn-stopping 推进判定用）。 */
export const DREAM_MARKER = '[meow-memory-dream]'

/** 会话短 id：剥掉 "session-" 前缀再取前 8 位（日志/落库展示用，可辨识窗口）。 */
export function shortSessionId(sid: string): string {
  return (sid.startsWith('session-') ? sid.slice(8) : sid).slice(0, 8)
}

/** 同步文件日志：进程崩溃也不丢（崩溃点定位用）。 */
function dreamLog(ws: string, dir: string, msg: string): void {
  try {
    appendFileSync(join(ws, dir, 'dream-debug.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不阻塞 */
  }
}

// ── 分组与快照 ──────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<Level, number> = { project: 0, topic: 1, fact: 2, lesson: 3, rules: 4, soul: 5, user: 6 }

export interface DreamGroup {
  name: string // project 名；'' = 无项目标签
  rows: MemoryRow[]
}

/** 一轮 = 一种记忆类型（原子 / topic），内部按 project 小标题分段。 */
export interface DreamRound {
  kind: 'atomic' | 'topic'
  groups: DreamGroup[]
}

/** 绝对时间戳（UTC 分钟级，与封存时间戳一致）。 */
function formatTime(t: number): string {
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ')
}

/** 按 project 分组（组内 project→level→创建时间；"全局"/未标记归无项目段放最后；多值（逗号分隔）归第一个项目段）。 */
function groupByProject(rows: MemoryRow[]): DreamGroup[] {
  const byProject = new Map<string, MemoryRow[]>()
  for (const r of rows) {
    const list = projectList(r.project)
    const key = list.length > 0 ? list[0] : ''
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key)!.push(r)
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => {
      const l = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
      if (l !== 0) return l
      return a.created_at - b.created_at
    })
  }
  return [...byProject.entries()]
    .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
    .map(([name, rows]) => ({ name, rows }))
}

/** dream 记忆范围（用户拍板 2026-08-19）：本窗口建立的 ∪ 本窗口提取过的
 *  （sessions/<id>.json 的 injected+searched，readSeen）。
 *  分两轮：第 1 轮=原子记忆（project/fact/lesson/rules/soul/user，不含 topic）；
 *  第 2 轮=topic 记忆。空轮跳过（轮数动态 1 或 2，消息里显示"第 N/M 组"）。 */
export function collectDreamRounds(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  workspace: string,
  dir = '.dsh-meow',
): DreamRound[] {
  const seen = readSeen(workspace, sessionId, dir)
  const atomic: MemoryRow[] = []
  const topic: MemoryRow[] = []
  for (const level of ['project', 'fact', 'lesson', 'rules', 'soul', 'user'] as const) {
    for (const r of db.list(level)) {
      if (r.source_session === sessionId || seen.has(r.id)) atomic.push(r)
    }
  }
  for (const r of db.list('topic')) {
    if (r.source_session === sessionId || seen.has(r.id)) topic.push(r)
  }
  const rounds: DreamRound[] = []
  if (atomic.length > 0) rounds.push({ kind: 'atomic', groups: groupByProject(atomic) })
  if (topic.length > 0) rounds.push({ kind: 'topic', groups: groupByProject(topic) })
  return rounds
}

function formatRow(r: MemoryRow): string {
  const head = r.content.replace(/\s+/g, ' ').trim()
  const meta = [r.level]
  if (r.level === 'project' && r.subcategory) meta.push(r.subcategory)
  if (r.title) meta.push(`《${r.title}》`)
  if (r.status !== 'active') meta.push(r.status)
  meta.push(`${r.id} ${formatTime(r.updated_at)}`) // 完整 id + 绝对时间戳（最后更新时间）
  // 关键词行：AI 要核查/重写关键词（判断 6），必须先把现有关键词给它看。
  const kw = (r.keywords ?? []).filter((k) => typeof k === 'string' && k.length > 0)
  const kwLine = kw.length > 0 ? kw.join(', ') : '（无）'
  return `- [${meta.join(' ')}] ${head}\n  关键词: ${kwLine}`
}

/** 第 1 轮（原子记忆）指南（用户拍板 2026-08-19 终稿）。 */
const ATOMIC_GUIDE = [
  '这些是你自己建立的记忆条目，以及你更新过的记忆。有没有你认为该整理、更新的？如有，请更新它。',
  '顺便检查历史记录中所有你看到的记忆条目，有没有你认为该更新的，如有，请一并更新。',
  '',
  '## 如何判断该更新——回看之前建立和读到的记忆，你现在觉得：',
  '1. 有没有当时记录错误或片面、过时、信息需要更新、用户改变决定、已有新进展的条目？ → 请及时更新内容，记忆库的信息应该吻合project进展的最新状态。',
  '2. 有没有已完成的 todo 条目？ → 设 status = stale（视为done）；',
  '3. 有没有错误的、过于琐碎、你现在看它根本不重要的条目？ → 设 status=archived；',
  '4. 有没有曾经的bug已被修复，曾经的lesson已不再适用？ → 修改内容，或者设 status=archived；',
  '5. 有没有发现互相矛盾的条目？ → 按你所知道的事实修改。保留最新事实，旧版本设 status=archived；',
  '6. 现在回头去看，那些记忆的 importance 标记是否正确（按记忆系统 importance 准则核查）；',
  '7. 有没有哪条记忆太长，信息太多？→ 拆分成多条，可用update修改，或remember新建新条目。',
  '8. 记忆的关键词是否准确？→ 如果准确就不使用keywords参数，如果你觉得关键词不准，请使用memory_update的keywords参数更新它——当用户prompt命中某条记忆的关键词，它就会被提取。所以你需要反向思考，"你希望在用户prompt提及哪些词的时候，这条记忆被检索到？"以此作为关键词的写入标准。不要用项目名当关键词，用更加针对这条记忆本身的信息作为关键词。优先提取核心实体、语义中心、专有名词。8-13个。',
  '9. project标签是否准确？是否有些信息应该是全局信息但被错误的标记了project？那应该删去project标记。是否有些信息明明属于某个project，却没写project信息？那应该加上。',
  '10. 学而不思则罔，更多抽象泛化：',
  '- 这是总结抽象框架的极好时机，你看看有没有可以总结沉淀的通用规则？可添加新记忆。',
  '- 你现在对某些记忆条目可能有更好更深刻地理解，你可以更新他们。',
  '11. 看一下首轮注入的内容，你现在觉得那些内容都重要吗？有必要每个session首轮注入吗？如果有不重要的，你可以降低他们的importance或者将他们移动到其他level（比如fact）。',
  '首轮只注入：soul（AI 自身）/ user（用户偏好）/ 全局 rules（importance≥2）。想加入首轮：全局规则类 → 移入 rules 且 importance≥2（project 填"全局"）；用户相关 → 移入 user；AI 自身 → 移入 soul。',
  '12. memory_project 展示的是 project 层条目（todo 已完成只列最近 5 条）+ 项目特定 rules；上面的检查同样适用（todo 完成标 stale、过时标 archived、project 标签准确）。',
  '',
  '说明：',
  '对于你认为非常重要的记忆，如果不确定事实到底如何，你可以直接翻项目文件来核实。仅对非常重要的记忆使用。',
  '完成后直接回复"本组整理完成"，不要调用其他工具。',
]

/** 第 2 轮（topic）开头介绍段（在【本组记忆】之前）。 */
const TOPIC_INTRO = [
  'topic是一种特殊的记忆，它追踪一个话题的起因经过发展结果，为AI提供更全局的、事件发展的视野。',
  '一个topic只说一件事的前因后果发展脉络，依然要求信息要聚焦在这一件事上，不可跑题。',
  '如果一个topic的事件链太长、细节太多，你也可以将其拆分成更小的事件。',
  '如果你发现有不同的topic条目在说同一件事，可以将它们合并。',
  '如果你发现有topic记录混乱，比如一件事的前因在topic A，后果在topic B，但topic A和B分别还有其他乱七八糟的信息，你应该综合考虑这些事情发展脉络，将它们整理清楚。用最合理最清楚的方式把这些信息分解成几件事、几条发展脉络，每件事一个topic。',
]

/** 第 2 轮（topic 记忆）更新指导（用户拍板 2026-08-19 终稿）。 */
const TOPIC_GUIDE = [
  '# topic记忆更新指导：',
  '1. 请你根据最新信息判断，这些topic中描述的事情，他们有新的发展、新的重要信息吗？请及时更新。你可以重新起草topic，将该话题的新进展加入，旧信息点如果你认为不再重要，可以删减。',
  '2. 有没有哪些topic说的太庞杂跑题了，如果提了好几件事，你认为应该拆分，你可以把一个大topic拆成几个子topic（新建topic）。',
  '3. 有没有哪几个topic其实在说同一件事，应该合并？请你合并。',
  '4. 有没有哪几个topic信息交叉混乱，你认为应该将它们的信息合并后重新拆分，这样才能更清晰的分割成两件事？请你重写他们。',
  '5. 更新topic时，你依然需要反向思考，"我写这条topic记忆是为了提供哪些信息？别人看到这条topic能看明白这个话题/事件的发展脉络吗？"',
  '6. 写/改topic时，同时总结该topic记忆的关键词（提取 8-13 个内容词供检索；"你希望在用户提及什么关键词时，AI能看到这条记忆"）。',
  '7. 要记录project信息（project名，或全局）、importance。',
  '8. 对于你认为非常重要的topic，如果不确定事实到底如何，你可以直接翻项目文件来核实。仅对非常重要的记忆使用。',
  '9. 完成后直接回复"本组整理完成"，不要调用其他工具。',
]

/** 构造一轮 dream 指令消息（两轮共用头部：封存时间戳 + 时间戳规则）。 */
export function buildDreamMessage(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  T: number,
  rounds: DreamRound[],
  idx: number,
): ReturnType<typeof createUserMessage> {
  const round = rounds[idx]
  const lines: string[] = [
    `${DREAM_MARKER} 记忆整理任务（dream）`,
    '',
    `本窗口记忆封存时间戳：${formatTime(T)}`,
    '如果其他窗口在此时间戳之后有新进展，你是不知道的。所以如果遇到记忆和你所知的上下文冲突，你需要根据时间戳来判断，是那条记忆错了，还是你信息落后了，来考虑要不要修改它。',
    '',
    '时间戳规则：',
    '所有展示给你的时间戳，都是那条记忆的**最后更新**时间戳。',
    '因为你现在看到的是很长时间的完整上下文，所以"几小时前"这种相对时间戳其实一直在变，不值得参考。此时你需要看的是绝对时间戳来判断记忆信息的新旧。',
    '',
    '',
    `第 ${idx + 1}/${rounds.length} 组 - ${round.kind === 'topic' ? 'topic记忆条目' : '原子记忆条目'}`,
    '',
  ]
  if (round.kind === 'topic') lines.push(...TOPIC_INTRO, '')
  lines.push('【本组记忆】：')
  for (const g of round.groups) {
    lines.push('', `【project：${g.name === '' ? '无项目 - 全局信息，或缺少项目标签' : g.name}】`)
    for (const r of g.rows) lines.push(formatRow(r))
  }
  lines.push('', ...(round.kind === 'topic' ? TOPIC_GUIDE : ATOMIC_GUIDE))
  return createUserMessage({ content: [{ type: 'text', text: lines.join('\n') }], source: PLUGIN_SOURCE })
}

// ── dream 任务状态（串行：同一时刻一个） ───────────────────────────────────

/** dream 租约：进行中任务的权威状态（落库，替换旧的模块级 currentDream + dream_pending 布尔）。
 *  owner/progress_at 组合成「租约」——progress_at 超时 = 主人已死，可补收尾；
 *  group_idx / T 落库后，推进/收尾不再依赖任何模块内存，跨实例、热重载、中止都安全。 */
interface DreamLease {
  owner: string
  started_at: number
  progress_at: number
  group_idx: number
  T: number
}

/** 租约超时：心跳按「组」刷新，LEASE 必须 > 单组最长处理时间。 */
const DREAM_LEASE_MS = 30 * 60_000

const liveAgents = new Map<string, unknown>() // sessionId -> 顶层 agent（live 引用）

export function registerLiveAgent(agent: { session?: { header?: { id?: string; parentSession?: unknown } } }): void {
  const id = agent.session?.header?.id
  if (typeof id === 'string' && id.length > 0) liveAgents.set(id, agent)
}

/** 生成本次 dream 的 owner token（pid + 随机后缀，仅诊断用；推进/收尾不校验 owner）。 */
function newDreamOwner(): string {
  return `${process.pid}:${Math.random().toString(36).slice(2, 10)}`
}

/** 扫描判定：窗口需要 dream 吗？ */
export function windowNeedsDream(w: { last_event_time: number; last_dream_time: number | null }, now = Date.now()): boolean {
  if (now - w.last_event_time > 24 * 3600_000) return false // 超过 24h 的旧窗口不碰
  return (w.last_dream_time ?? 0) < w.last_event_time
}

/**
 * 启动一个窗口的 dream（steer 第一组）。agent 必须是该窗口的 live 顶层 agent。
 * 返回 false 表示无法启动（已有任务在跑 / 别处（含其他进程）正在 dream / 无记忆可整理）。
 * 防重复：DB 原子抢占 dream_pending 标记（跨进程/重启一致）——抢占失败即不 start；
 * 抢占成功后即使本进程崩溃/被重载，下个检查周期也会补收尾而不是重复 start。
 */
export function startWindowDream(ctx: Context, agent: { session?: { header?: { id?: string } } }, workspace: string, dir = '.dsh-meow'): boolean {
  const sessionId = agent.session?.header?.id
  if (!sessionId) return false
  const db = getDb(workspace, dir)
  const rounds = collectDreamRounds(db, sessionId, workspace, dir)
  if (rounds.length === 0) {
    // 无本窗口记忆（建立的 ∪ 提取过的都无）：也推进 last_dream_time（= 本窗口无可整理），避免 need=true 恒成立、每轮空扫到 24h
    db.finishDream(sessionId, Date.now())
    dreamLog(workspace, dir, `dream skip-empty sid=${shortSessionId(sessionId)}`)
    return false
  }
  const win = db.getWindow(sessionId)
  // claimDream 的 INSERT OR IGNORE 会给新窗口行造出 last_event_time=0 哨兵，这里兜底 0
  const T = win && win.last_event_time > 0 ? win.last_event_time : Date.now()
  if (!db.claimDream(sessionId, newDreamOwner(), T, DREAM_LEASE_MS)) return false // 别处活跃租约未过期
  const msg = buildDreamMessage(db, sessionId, T, rounds, 0)
  ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
  dreamLog(workspace, dir, `dream start pid=${process.pid} session=${shortSessionId(sessionId)} rounds=${rounds.length} T=${T}`)
  return true
}

/**
 * turn-stopping 推进：本 turn 是 dream 轮 → 下一组或收尾。
 * 状态完全从 DB 租约读：跨实例、热重载残留、中止都不影响推进正确性。
 * 推进按「sessionId + 租约未过期」判定，不校验 owner（owner 只用于抢占判断 + 诊断）。
 */
export function advanceDream(agent: unknown, dir = '.dsh-meow'): void {
  const sessionId = (agent as { session?: { header?: { id?: string } } })?.session?.header?.id
  const ws = (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
  if (typeof sessionId !== 'string' || typeof ws !== 'string' || ws.length === 0) return
  const db = getDb(ws, dir)
  const lease = db.getDreamLease(sessionId)
  if (lease === null) return // 无进行中 dream（已收尾/未开始）：不动

  if (Date.now() - lease.progress_at > DREAM_LEASE_MS) {
    // 租约过期 = 主人已死：补收尾（不再推进），防止窗口永久 need=true 反复 start
    recoverInterruptedDream(db, sessionId, ws, dir)
    dreamLog(ws, dir, `advanceDream expired-recover sid=${shortSessionId(sessionId)}`)
    return
  }

  const rounds = collectDreamRounds(db, sessionId, ws, dir) // 重查：前序轮 archive/merge 已落地
  const nextIdx = lease.group_idx + 1
  if (nextIdx < rounds.length) {
    // CAS 推进：多实例同收 turn-stopping 时只有一个成功，其余跳过
    if (db.advanceDreamLease(sessionId, lease.group_idx, DREAM_LEASE_MS)) {
      const msg = buildDreamMessage(db, sessionId, lease.T, rounds, nextIdx)
      ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
      dreamLog(ws, dir, `dream group ${nextIdx + 1}/${rounds.length} steered`)
    }
    return
  }
  // 最后一轮完成 → 收尾
  finalizeDream(db, sessionId, ws, dir, lease.T, 'done', rounds.length)
}

/** 收尾：封存全部条目（updated_at=T）+ 清租约 + 记 last_dream_time。失败不阻塞（日志兜底）。 */
function finalizeDream(db: ReturnType<typeof getDb>, sessionId: string, workspace: string, dir: string, T: number, reason: 'done' | 'aborted', groupsCount: number): void {
  try {
    const stamped = db.stampDream(sessionId, T)
    db.finishDream(sessionId, Date.now())
    db.logDream(
      `window dream ${reason}: ${shortSessionId(sessionId)} groups=${groupsCount} stamped=${stamped} T=${new Date(T).toISOString()}`,
      { before: undefined, after: undefined },
    )
    dreamLog(workspace, dir, `dream ${reason} session=${shortSessionId(sessionId)} groups=${groupsCount} stamped=${stamped}`)
  } catch (e) {
    dreamLog(workspace, dir, `dream ${reason} finish error: ${String(e)}`)
  }
}

/** dream 轮被用户停止（aborted/interrupted）：立即收尾，不再推进下一组。
 *  与旧 currentDream 不同——这里没有会卡死的内存态，收尾后 DB 租约即清。 */
export function abortDream(agent: unknown, dir = '.dsh-meow'): void {
  const sessionId = (agent as { session?: { header?: { id?: string } } })?.session?.header?.id
  const ws = (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
  if (typeof sessionId !== 'string' || typeof ws !== 'string' || ws.length === 0) return
  const db = getDb(ws, dir)
  const lease = db.getDreamLease(sessionId)
  if (lease === null) return // 没有进行中 dream
  finalizeDream(db, sessionId, ws, dir, lease.T, 'aborted', lease.group_idx + 1)
}

// ── 工具：memory_dream（手动触发本窗口 dream） ─────────────────────────────

export function dreamTool(ctx: Context, dir = '.dsh-meow'): ToolDefinition {
  return {
    name: 'memory_dream',
    description: '立即为本窗口安排一次记忆整理（dream）：把本窗口建立过/提取过的记忆分两轮发给主 agent 整理封存（第 1 轮=原子记忆 project/fact/lesson/rules/soul/user，第 2 轮=topic 记忆）。通常夜间自动运行，此工具用于手动触发。',
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
      if (ok) return { ok, note: '整理指令已发出，逐个项目组处理中。' }
      const sessionId = exec.agent.session?.header?.id
      const lease = typeof sessionId === 'string' ? getDb(workspace, dir).getDreamLease(sessionId) : null
      return {
        ok,
        note: lease !== null
          ? '本窗口已有 dream 任务在进行中（或待补收尾）。'
          : '本窗口没有需要整理的记忆。',
      }
    },
    presentCall(): { card: 'generic'; title: string; kind: 'write' } {
      return { card: 'generic', title: 'memory_dream: 整理本窗口记忆', kind: 'write' }
    },
  }
}

/** 补收尾被打断的 dream（start 过但没 done：进程重启/热重载/跨进程打断）。
 *  视为已完成：封存该窗口条目 + 清 pending + 记 last_dream_time——不再重复 start。
 *  @returns 封存（stamped）的条目数。 */
export function recoverInterruptedDream(db: ReturnType<typeof getDb>, sessionId: string, workspace: string, dir = '.dsh-meow'): number {
  const lease = db.getDreamLease(sessionId)
  const w = db.getWindow(sessionId)
  const T = lease ? lease.T : w && w.last_event_time > 0 ? w.last_event_time : Date.now()
  const stamped = db.stampDream(sessionId, T)
  db.finishDream(sessionId, Date.now())
  db.logDream(
    `window dream recovered (interrupted): ${shortSessionId(sessionId)} stamped=${stamped} T=${new Date(T).toISOString()}`,
    { before: undefined, after: undefined },
  )
  dreamLog(workspace, dir, `dream recovered session=${shortSessionId(sessionId)} stamped=${stamped}`)
  return stamped
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
    const hour = hourInTimeZone(cfg.timeZone)
    if (hour < cfg.windowStart || hour >= cfg.windowEnd) return
    if (Date.now() - lastActivity() < cfg.idleMinutes * 60_000) return
    // 全局检查门（防多实例/多定时器叠加）：60 秒内只有一个实例真正执行检查。
    // 根因：热重载/多 fiber 并存时 dispose 未必清理旧 setInterval → 检查频率
    // 远高于 checkMinutes → 同一窗口被反复 start。用共享库的原子抢占做节流，
    // 与 claimDream（start 幂等）+ recoverInterruptedDream（中断自愈）闭环。
    let gatePassed = false
    for (const [, ws] of windowIndex) {
      if (getDb(ws, dir).claimCheckGate(60_000)) gatePassed = true
      break
    }
    if (!gatePassed) return
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
      const lease = db.getDreamLease(sessionId)
      dreamLog(workspace, dir, `check sid=${shortSessionId(sessionId)} active=${lease !== null} idle=${Math.round((Date.now() - w.last_event_time) / 1000)}s`)
      // 进行中 dream：只在租约过期（主人已死）时补收尾；活跃则跳过（别处正在 dream）
      if (lease !== null) {
        if (Date.now() - lease.progress_at > DREAM_LEASE_MS) {
          recoverInterruptedDream(db, sessionId, workspace, dir)
        }
        continue
      }
      // 窗口级 idle（用户拍板：session 最近 idleMinutes 无动作才 dream）：
      // 用 db 持久化的 last_event_time 判定——不受模块实例/热重载影响
      // （内存全局 lastActivity 只作快速路径，见上方 gate）。
      if (Date.now() - w.last_event_time < cfg.idleMinutes * 60_000) continue
      const agentsSvc = typeof ctx.get === 'function'
        ? (ctx.get('agents') as { get?: (id: unknown) => unknown } | undefined)
        : undefined
      const agent =
        liveAgents.get(sessionId) ??
        (agentsSvc !== undefined && typeof agentsSvc.get === 'function' ? agentsSvc.get(sessionId) : undefined)
      if (!agent) {
        dreamLog(workspace, dir, `check agent-missing sid=${shortSessionId(sessionId)}`)
        continue // 进程内无该窗口 agent（重启后）：跳过
      }
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
