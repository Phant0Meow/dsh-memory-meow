/**
 * meow-memory v2 — 工具面：memory_remember / memory_search / memory_read / memory_update。
 *
 * 写规则（进 description 给模型看）：
 * - fact/lesson 一句话直陈 ≤60 字（短是关键词命中注入的前提）；
 * - 用户介绍项目设计思路/框架/决策理由的原话必须保留措辞，不转述（project/lesson）；
 * - project 必填项目名（femwa / meow-memory / meow-eyes / dsh …）；
 * - topic 必填标题（对象+动作，禁宽泛名）+ 建议目标句。
 */

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { findSimilar, search, tokenize } from './bm25.js'
import { getDb, getDreamWorkspace, type Level, LEVELS, type MemoryPatch, type MemoryRow, type ProjectSubcategory, PROJECT_SUBCATEGORIES } from './db.js'
import { readSeen, markSearched } from './inject.js'

export type { Level }

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

/** 检索范围过滤（用户拍板）：①自己 session 建立的记忆在上下文里，不检索；
 *  ②本 session 已注入/已检索过的（seen）不检索——省 token、扩大检索面。 */
function filterSearchable(
  rows: MemoryRow[],
  opts: { sessionId: string | null; seen: Set<string>; project?: string | null; status?: string | null; days?: number | null },
): MemoryRow[] {
  return rows.filter((r) => {
    if (opts.sessionId && r.source_session === opts.sessionId) return false
    if (opts.seen.has(r.id)) return false
    if (opts.project && r.project !== opts.project) return false
    if (opts.status && opts.status !== 'all' && r.status !== opts.status) return false
    if (opts.days && Date.now() - r.created_at > opts.days * 86_400_000) return false
    return true
  })
}

export function workspaceOf(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return getDreamWorkspace() ?? undefined
}

export function sessionIdOf(exec: ToolRunContext): string | null {
  const header = (exec.agent?.session?.header ?? {}) as { id?: unknown; parentSession?: unknown }
  const id = typeof header.id === 'string' && header.id.length > 0 ? header.id : null
  // 子 agent：source_session 继承母窗口（用户拍板：子 agent 写记忆归属父窗口）
  if (header.parentSession !== undefined) {
    const p = header.parentSession
    if (typeof p === 'string' && p.length > 0) return p
    if (p !== null && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') {
      return (p as { id: string }).id
    }
  }
  return id
}

/** 自动提取关键词：bigram 词频 top N（去重、去纯数字）。 */
export function extractKeywords(content: string, n = 10): string[] {
  const freq = new Map<string, number>()
  for (const t of tokenize(content)) {
    if (/^[0-9]+$/.test(t)) continue
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t)
}

/** bigram Jaccard 相似度（去重用）。 */
export function similarity(a: string, b: string): number {
  const sa = new Set(tokenize(a))
  const sb = new Set(tokenize(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

const DEDUP_THRESHOLD = 0.8

function rememberTool(dir: string): ToolDefinition {
  return {
    name: 'memory_remember',
    description: [
      '把一条值得跨会话记住的信息写入当前工作区的记忆库（SQLite，按 level 分表）。',
      'level 分类：soul=AI 自身（少用）；user=用户基本信息与基础偏好；',
      'project=项目（必填 project 参数，项目名如 femwa/meow-memory/meow-eyes/dsh）；',
      'fact=细碎原子事实（一句话直陈 ≤60 字）；lesson=错误与教训（被纠正的一定记这里）；',
      'topic=话题（必填 title：对象+动作的名词短语，禁宽泛名如"dsh 插件"；建议 goal 目标句）。',
      '铁律：用户介绍项目设计思路/框架/决策理由时，content 必须保留用户原话措辞，不要转述总结。',
      '写入时自动提取关键词；与已有条目高度重复会自动合并（更新而非新增）。',
      '调用成功后工具会返回确认，无需重复调用本工具。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: { type: 'string', description: '要记住的内容；fact/lesson 一句话 ≤60 字；topic ≤300 字；涉及用户原话必须保留措辞。' },
        level: {
          type: 'string',
          enum: [...LEVELS],
          default: 'fact',
          description: '记忆层级，默认 fact。',
        },
        title: { type: 'string', description: '标题（topic 必填；其他可选）。' },
        project: { type: 'string', description: '项目名（level=project 必填；fact/lesson/topic 可选）。' },
        subcategory: { type: 'string', enum: [...PROJECT_SUBCATEGORIES], description: 'project 子类：overview=目标概述/structure=项目结构/decisions=技术决策/quotes=用户原话/ops=部署与数据/todo=进行中。' },
        goal: { type: 'string', description: '话题目标句（level=topic 建议填，如"让 femGen 集成可用"）。' },
        importance: { type: 'integer', minimum: 0, maximum: 3, default: 1, description: '重要性 0-3，3=超级重要。' },
        corrected: { type: 'boolean', default: false, description: '是否为用户纠正的内容（level=lesson 时）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          level: { type: 'string' },
          merged: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const v = value as { level?: unknown; merged?: unknown; id?: unknown }
        return [{
          type: 'text' as const,
          text: `✅ 记忆已写入（${String(v.level ?? 'fact')}${v.merged ? '，已合并到已有条目' : ''}${typeof v.id === 'string' ? `，id=${v.id.slice(0, 8)}` : ''}）。无需重复调用本工具。`,
        }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const parsed = args as { content?: unknown; level?: unknown; title?: unknown; project?: unknown; subcategory?: unknown; goal?: unknown; importance?: unknown; corrected?: unknown }
      const content = typeof parsed.content === 'string' ? parsed.content.trim() : ''
      if (content.length === 0) throw new Error('memory_remember: content 不能为空')
      const level: Level = typeof parsed.level === 'string' && (LEVELS as readonly string[]).includes(parsed.level)
        ? (parsed.level as Level)
        : 'fact'
      const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null
      const project = typeof parsed.project === 'string' && parsed.project.trim() ? parsed.project.trim() : null
      const subcategory =
        level === 'project' && typeof parsed.subcategory === 'string' && (PROJECT_SUBCATEGORIES as readonly string[]).includes(parsed.subcategory)
          ? (parsed.subcategory as ProjectSubcategory)
          : null
      const goal = typeof parsed.goal === 'string' && parsed.goal.trim() ? parsed.goal.trim() : null
      const importance = typeof parsed.importance === 'number' ? Math.max(0, Math.min(3, Math.round(parsed.importance))) : 1
      const corrected = parsed.corrected === true ? 1 : 0
      if (level === 'project' && !project) throw new Error('memory_remember: level=project 时必须提供 project 项目名')
      if (level === 'topic' && !title) throw new Error('memory_remember: level=topic 时必须提供 title 话题标题')

      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_remember: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const source_session = sessionIdOf(exec)

      // 去重：同 level 找相似条目 → 合并更新
      const existing = db.list(level)
      let merged: MemoryRow | undefined
      for (const r of existing) {
        if (similarity(r.content, content) >= DEDUP_THRESHOLD) {
          merged = r
          break
        }
      }
      if (merged) {
        const patch: MemoryPatch = {
          content,
          importance: Math.max(merged.importance, importance),
        }
        if (title) patch.title = title
        if (project && (level === 'project' || level === 'fact' || level === 'lesson' || level === 'topic')) patch.project = project
        if (subcategory && level === 'project') patch.subcategory = subcategory
        if (goal && level === 'topic') patch.goal = goal
        if (level === 'lesson' && corrected) patch.corrected = 1
        db.update(level, merged.id, patch)
        return { ok: true, id: merged.id, level, merged: true }
      }

      const row = db.insert({
        level,
        content,
        title,
        project,
        subcategory,
        goal,
        importance,
        corrected,
        keywords: extractKeywords(content),
        source_session,
      })
      return { ok: true, id: row.id, level, merged: false }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'write' } {
      const parsed = args as { content?: unknown }
      const preview = typeof parsed.content === 'string' ? parsed.content.slice(0, 40) : ''
      return { card: 'generic', title: `memory_remember: ${preview}`, kind: 'write' }
    },
  }
}

function searchTool(dir: string): ToolDefinition {
  return {
    name: 'memory_search',
    description: [
      '在当前工作区记忆库中检索记忆（BM25 × 近期权重）。',
      '范围：只检索其他会话建立的记忆；本会话已经注入过或检索过的条目自动排除（它们已在上下文里可见，不重复占用）。',
      '默认搜索范围=fact+lesson+topic；level 支持逗号多选（如 fact,lesson）；想看项目全景传 level=project。',
      '返回按相关度取 top-k 后按记忆时间戳重排（旧→新，供判断发展过程与新旧冲突）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索关键词/句子。' },
        level: { type: 'string', description: '限定层级，逗号多选：fact/lesson/topic/project/soul/user（默认 fact,lesson,topic）。' },
        project: { type: 'string', description: '按项目名过滤（如 femwa）。' },
        status: { type: 'string', enum: ['active', 'archived', 'stale', 'all'], description: '按状态过滤（默认 active；todo 类的 stale 视为已完成参与）。' },
        days: { type: 'integer', minimum: 1, maximum: 3650, description: '只看最近 N 天创建的条目（按创建时间）。' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: '返回条数上限。' },
        content_max: { type: 'integer', minimum: 0, maximum: 5000, default: 300, description: '每条内容截断长度，0=全文。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['note', 'hits'],
        properties: {
          note: { type: 'string', description: '冲突提示。' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'level'],
              properties: {
                id: { type: 'string', description: '完整记忆 id（可传给 memory_read/memory_update/memory_find_similar）。' },
                level: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string' },
                score: { type: 'number' },
                dream_at: { type: 'number', description: '记忆时间戳（该窗口封存该条记忆的时刻，毫秒）。' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { note?: string; hits?: Array<{ id?: string; level?: string; title?: string; content?: string; score?: number; dream_at?: number | null }> }
        const lines = [String(v.note ?? '')]
        for (const h of v.hits ?? []) {
          const ts = relativeTime(h.dream_at ?? null)
          lines.push(`[${String(h.level ?? '')} ${String(h.id ?? '').slice(0, 12)}] ${String(h.title ?? '')} ${String(h.content ?? '').slice(0, 80)}（记忆时间戳：${ts}）`)
        }
        return lines.map((t) => ({ type: 'text' as const, text: t }))
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const parsed = args as { query?: unknown; level?: unknown; project?: unknown; status?: unknown; days?: unknown; k?: unknown; content_max?: unknown }
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : ''
      if (!query) throw new Error('memory_search: query 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_search: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const sessionId = sessionIdOf(exec)
      const seen = readSeen(workspace, sessionId ?? 'unknown', dir)
      const project = typeof parsed.project === 'string' && parsed.project.trim() ? parsed.project.trim() : null
      const status = typeof parsed.status === 'string' ? parsed.status : null
      const days = typeof parsed.days === 'number' && parsed.days > 0 ? parsed.days : null
      const k = typeof parsed.k === 'number' ? Math.max(1, Math.min(50, Math.round(parsed.k))) : 10
      const contentMax = typeof parsed.content_max === 'number' ? Math.max(0, Math.min(5000, Math.round(parsed.content_max))) : 300

      const levels: Level[] = typeof parsed.level === 'string' && parsed.level.trim()
        ? parsed.level.split(',').map((s) => s.trim()).filter((s): s is Level => (LEVELS as readonly string[]).includes(s))
        : (['fact', 'lesson', 'topic'] as Level[])
      const rows = levels.flatMap((lv) => {
        if (status && status !== 'active' && status !== 'all') return db.list(lv, { status: status as MemoryRow['status'] })
        return db.listSearchable(lv)
      })
      const filtered = filterSearchable(rows, { sessionId, seen, project, status, days })
      const docs = filtered.map((r) => ({
        id: r.id,
        level: r.level,
        title: r.title,
        content: r.content,
        keywords: r.keywords,
        importance: r.importance,
        created_at: r.created_at,
        dream_at: r.dream_at,
      }))
      const hits = search(query, docs, { k })
      for (const h of hits) db.bumpHit(h.level as Level, h.id)
      markSearched(workspace, sessionId ?? 'unknown', hits.map((h) => h.id), dir)
      // 按记忆时间戳（dream_at）重排：旧→新；null 视为最旧（从未封存）。
      const reordered = [...hits].sort((a, b) => (a.dream_at ?? 0) - (b.dream_at ?? 0))
      return {
        note: '如果冲突，以最新的为准。时间戳较旧的条目可作为事情发展过程的参考。',
        hits: reordered.map((h) => ({
          id: h.id,
          level: h.level,
          title: h.title ?? '',
          content: contentMax > 0 ? h.content.slice(0, contentMax) : h.content,
          score: Math.round(h.score * 100) / 100,
          dream_at: h.dream_at ?? 0,
        })),
      }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'read' } {
      const parsed = args as { query?: unknown }
      return { card: 'generic', title: `memory_search: ${String(parsed.query ?? '').slice(0, 40)}`, kind: 'read' }
    },
  }
}

function findSimilarTool(dir: string): ToolDefinition {
  return {
    name: 'memory_find_similar',
    description: [
      '按记忆 id 查找内容相似的条目（bigram 词频向量余弦）——用于查重、找冲突、判断某条记忆是否已有近似记录。',
      '同样只检索其他会话建立的记忆，本会话已见（注入/检索过）的自动排除。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '基准记忆 id（memory_read/search 结果里的完整 id 或前 12 位）。' },
        k: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: '返回条数。' },
        content_max: { type: 'integer', minimum: 0, maximum: 5000, default: 200, description: '每条内容截断长度，0=全文。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hits'],
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'level', 'similarity'],
              properties: {
                id: { type: 'string' },
                level: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string' },
                similarity: { type: 'number', description: '余弦相似度 0-1，越高越接近。' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { hits?: Array<{ id?: string; level?: string; title?: string; content?: string; similarity?: number }> }
        return (v.hits ?? []).map((h) => ({
          type: 'text' as const,
          text: `[${String(h.level ?? '')} ${String(h.id ?? '').slice(0, 12)}] 相似度 ${Number(h.similarity ?? 0).toFixed(3)} ${String(h.title ?? '')} ${String(h.content ?? '').slice(0, 80)}`,
        }))
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const parsed = args as { id?: unknown; k?: unknown; content_max?: unknown }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
      if (!id) throw new Error('memory_find_similar: id 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_find_similar: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const found = db.findById(id)
      if (!found) throw new Error(`memory_find_similar: 未找到记忆 ${id.slice(0, 12)}`)
      const sessionId = sessionIdOf(exec)
      const seen = readSeen(workspace, sessionId ?? 'unknown', dir)
      const k = typeof parsed.k === 'number' ? Math.max(1, Math.min(20, Math.round(parsed.k))) : 5
      const contentMax = typeof parsed.content_max === 'number' ? Math.max(0, Math.min(5000, Math.round(parsed.content_max))) : 200

      const rows = LEVELS.flatMap((lv) => (lv === 'soul' || lv === 'user' ? [] : db.listSearchable(lv)))
      const candidates = rows.filter((r) => r.id !== found.row.id && !seen.has(r.id) && r.source_session !== sessionId)
      const docs = candidates.map((r) => ({
        id: r.id,
        level: r.level,
        title: r.title,
        content: r.content,
        keywords: r.keywords,
        importance: r.importance,
        created_at: r.created_at,
      }))
      const hits = findSimilar(found.row.content, docs, k)
      markSearched(workspace, sessionId ?? 'unknown', hits.map((h) => h.id), dir)
      return {
        hits: hits.map((h) => ({
          id: h.id,
          level: h.level,
          title: h.title ?? '',
          content: contentMax > 0 ? h.content.slice(0, contentMax) : h.content,
          similarity: h.similarity,
        })),
      }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'read' } {
      const parsed = args as { id?: unknown }
      return { card: 'generic', title: `memory_find_similar: ${String(parsed.id ?? '').slice(0, 12)}`, kind: 'read' }
    },
  }
}

function readTool(dir: string): ToolDefinition {
  return {
    name: 'memory_read',
    description: '读取记忆库中某条记忆的完整内容（含 title/keywords/importance/状态等元数据）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '记忆 id（注入块或 memory_search 结果里给出的 id）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found'],
        properties: {
          found: { type: 'boolean' },
          id: { type: 'string' },
          level: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          importance: { type: 'number' },
          status: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          project: { type: 'string' },
          goal: { type: 'string' },
          corrected: { type: 'boolean' },
          created_at: { type: 'number' },
          updated_at: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const v = value as { found?: boolean; level?: unknown; title?: unknown; content?: unknown; status?: unknown; project?: unknown; goal?: unknown }
        if (!v.found) return [{ type: 'text' as const, text: '未找到该记忆。' }]
        const parts = [`[${String(v.level ?? '')}] ${String(v.title ?? '')}（${String(v.status ?? '')}）`]
        if (v.project) parts.push(`项目：${String(v.project)}`)
        if (v.goal) parts.push(`目标：${String(v.goal)}`)
        parts.push(String(v.content ?? ''))
        return [{ type: 'text' as const, text: parts.join('\n') }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const parsed = args as { id?: unknown }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
      if (!id) throw new Error('memory_read: id 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_read: 无法确定工作区（会话无 cwd）')
      const found = getDb(workspace, dir).findById(id)
      if (!found) return { found: false }
      const { row } = found
      return {
        found: true,
        id: row.id,
        level: row.level,
        title: row.title ?? '',
        content: row.content,
        importance: row.importance,
        status: row.status,
        keywords: row.keywords,
        project: row.project ?? '',
        goal: row.goal ?? '',
        corrected: row.corrected === 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'read' } {
      const parsed = args as { id?: unknown }
      return { card: 'generic', title: `memory_read: ${String(parsed.id ?? '').slice(0, 16)}`, kind: 'read' }
    },
  }
}

function updateTool(dir: string): ToolDefinition {
  return {
    name: 'memory_update',
    description: [
      '更新记忆库中某条记忆（内容/标题/重要性/状态/话题目标句等）。',
      'status 取值：active / archived（事项已完成，保留不删除）/ stale（久无进展待复核）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '记忆 id。' },
        content: { type: 'string', description: '新内容（topic 重写时用：起因经过发展结果 ≤300 字）。' },
        title: { type: 'string', description: '新标题。' },
        status: { type: 'string', enum: ['active', 'archived', 'stale'], description: '新状态。' },
        importance: { type: 'integer', minimum: 0, maximum: 3 },
        goal: { type: 'string', description: '新目标句（topic）。' },
        project: { type: 'string', description: '新项目名（project/fact/lesson）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          level: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; level?: unknown; id?: unknown }
        return [{ type: 'text' as const, text: v.ok ? `✅ 已更新（${String(v.level ?? '')} ${String(v.id ?? '').slice(0, 8)}）。` : '更新失败：未找到该记忆。' }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const parsed = args as { id?: unknown; content?: unknown; title?: unknown; status?: unknown; importance?: unknown; goal?: unknown; project?: unknown }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
      if (!id) throw new Error('memory_update: id 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_update: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const found = db.findById(id)
      if (!found) return { ok: false, id, level: '' }
      const patch: MemoryPatch = {}
      if (typeof parsed.content === 'string' && parsed.content.trim()) patch.content = parsed.content.trim()
      if (typeof parsed.title === 'string' && parsed.title.trim()) patch.title = parsed.title.trim()
      if (typeof parsed.status === 'string' && ['active', 'archived', 'stale'].includes(parsed.status)) patch.status = parsed.status as MemoryPatch['status']
      if (typeof parsed.importance === 'number') patch.importance = Math.max(0, Math.min(3, Math.round(parsed.importance)))
      if (typeof parsed.goal === 'string' && parsed.goal.trim() && found.level === 'topic') patch.goal = parsed.goal.trim()
      if (typeof parsed.project === 'string' && parsed.project.trim() && (found.level === 'project' || found.level === 'fact' || found.level === 'lesson')) {
        patch.project = parsed.project.trim()
      }
      const ok = db.update(found.level, found.row.id, patch)
      return { ok, id: found.row.id, level: found.level }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'write' } {
      const parsed = args as { id?: unknown; status?: unknown }
      return { card: 'generic', title: `memory_update: ${String(parsed.id ?? '').slice(0, 8)}${parsed.status ? ` → ${String(parsed.status)}` : ''}`, kind: 'write' }
    },
  }
}

export function registerMemoryTools(register: (t: ToolDefinition) => void, dir = '.dsh-meow'): void {
  register(rememberTool(dir))
  register(searchTool(dir))
  register(findSimilarTool(dir))
  register(readTool(dir))
  register(updateTool(dir))
}
