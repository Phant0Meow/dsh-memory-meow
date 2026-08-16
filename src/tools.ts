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
import { getDb, getDreamWorkspace, memoryDbPath, relativeTime, type Level, LEVELS, type MemoryPatch, type MemoryRow, type ProjectSubcategory, PROJECT_SUBCATEGORIES } from './db.js'
import { readSeen, markSearched, setCurrentProject } from './inject.js'

export type { Level }

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
      'rules=设计原则/行为准则（必填 importance 区分注入：全局准则（不填 project）importance≥2 会全量注入到首轮；',
      '  项目特定准则填 project 参数，随 memory_project 注入；其余走检索）；',
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
        project: { type: 'string', description: '项目名（level=project 必填；fact/lesson/topic/rules 可选）。' },
        subcategory: { type: 'string', enum: [...PROJECT_SUBCATEGORIES], description: 'project 子类：overview=目标概述/structure=项目结构/decisions=技术决策/quotes=用户原话/ops=部署与数据/todo=进行中。' },
        goal: { type: 'string', description: '话题目标句（level=topic 建议填，如"让 femGen 集成可用"）。' },
        importance: { type: 'integer', minimum: 0, maximum: 3, default: 1, description: '重要性 0-3，3=超级重要。' },
        corrected: { type: 'boolean', default: false, description: '是否为用户纠正的内容（level=lesson 时）。' },
        keywords: { type: 'array', items: { type: 'string' }, description: '手动指定关键词（反思/dream 轮要求提取 5-10 个内容词；不传则自动 bigram 提取）。' },
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
          keywords: { type: 'array', items: { type: 'string' }, description: '实际存储的关键词（自动提取；合并后为最新值）。' },
          project: { type: 'string', description: '实际归属项目（若有）。' },
          title: { type: 'string', description: '实际标题（若有）。' },
        },
      },
      render: (_args, value) => {
        const v = value as { level?: unknown; merged?: unknown; id?: unknown; keywords?: unknown; project?: unknown }
        const kw = Array.isArray(v.keywords) && v.keywords.length > 0 ? `关键词：${v.keywords.join(' / ')}。` : ''
        const proj = typeof v.project === 'string' ? `项目：${v.project}。` : ''
        const head = v.merged ? '✅ 已合并到已有条目' : '✅ 记忆已写入'
        return [{
          type: 'text' as const,
          text: `${head}（${String(v.level ?? 'fact')}${typeof v.id === 'string' ? `，id=${v.id.slice(0, 8)}` : ''}）。${proj}${kw}无需重复调用本工具。`,
        }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const parsed = args as { content?: unknown; level?: unknown; title?: unknown; project?: unknown; subcategory?: unknown; goal?: unknown; importance?: unknown; corrected?: unknown; keywords?: unknown }
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
      // 关键词：显式传入（反思/dream 轮 LLM 提取）优先；否则自动 bigram 提取。
      const keywords = Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter((k) => k.length > 0)
        : extractKeywords(content)
      if (level === 'project' && !project) throw new Error('memory_remember: level=project 时必须提供 project 项目名')
      if (level === 'topic' && !title) throw new Error('memory_remember: level=topic 时必须提供 title 话题标题')

      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_remember: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const source_session = sessionIdOf(exec)
      // 锚定当前 project：带 project 参数的 memory 调用更新会话状态（命中检索用它）。
      if (project) setCurrentProject(workspace, source_session ?? 'unknown', project, dir)

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
        if (project && (level === 'project' || level === 'fact' || level === 'lesson' || level === 'topic' || level === 'rules')) patch.project = project
        if (subcategory && level === 'project') patch.subcategory = subcategory
        if (goal && level === 'topic') patch.goal = goal
        if (level === 'lesson' && corrected) patch.corrected = 1
        if (Array.isArray(parsed.keywords)) patch.keywords = keywords // 显式关键词才覆盖合并目标
        db.update(level, merged.id, patch)
        // 读回合并后的实际存储结果（关键词等），让模型知道最终落库形态。
        const after = db.findById(merged.id)?.row
        return {
          ok: true,
          id: merged.id,
          level,
          merged: true,
          keywords: after?.keywords ?? merged.keywords,
          ...(after?.project ? { project: after.project } : {}),
          ...(after?.title ? { title: after.title } : {}),
        }
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
        keywords,
        source_session,
      })
      return {
        ok: true,
        id: row.id,
        level,
        merged: false,
        keywords: row.keywords,
        ...(row.project ? { project: row.project } : {}),
        ...(row.title ? { title: row.title } : {}),
      }
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
      '默认搜索范围=fact+lesson+topic+rules；level 支持逗号多选（如 fact,lesson）；想看项目全景传 level=project。',
      '返回按相关度取 top-k 后按记忆时间戳重排（旧→新，供判断发展过程与新旧冲突）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索关键词/句子。' },
        level: { type: 'string', description: '限定层级，逗号多选：fact/lesson/topic/rules/project/soul/user（默认 fact,lesson,topic,rules）。' },
        project: { type: 'string', description: '按项目名过滤（见记忆导引中的项目列表）。' },
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
                updated_at: { type: 'number', description: '记忆时间戳（最后更新时间，毫秒）。' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { note?: string; hits?: Array<{ id?: string; level?: string; title?: string; content?: string; score?: number; updated_at?: number | null }> }
        const lines = [String(v.note ?? '')]
        for (const h of v.hits ?? []) {
          const ts = relativeTime(h.updated_at ?? null)
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
      // 锚定当前 project（命中检索限定"全局+当前项目"）。
      if (project) setCurrentProject(workspace, sessionId ?? 'unknown', project, dir)
      const status = typeof parsed.status === 'string' ? parsed.status : null
      const days = typeof parsed.days === 'number' && parsed.days > 0 ? parsed.days : null
      const k = typeof parsed.k === 'number' ? Math.max(1, Math.min(50, Math.round(parsed.k))) : 10
      const contentMax = typeof parsed.content_max === 'number' ? Math.max(0, Math.min(5000, Math.round(parsed.content_max))) : 300

      const levels: Level[] = typeof parsed.level === 'string' && parsed.level.trim()
        ? parsed.level.split(',').map((s) => s.trim()).filter((s): s is Level => (LEVELS as readonly string[]).includes(s))
        : (['fact', 'lesson', 'topic', 'rules'] as Level[])
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
        updated_at: r.updated_at,
      }))
      const hits = search(query, docs, { k })
      for (const h of hits) db.bumpHit(h.level as Level, h.id)
      markSearched(workspace, sessionId ?? 'unknown', hits.map((h) => h.id), dir)
      // 按记忆时间戳（updated_at）重排：旧→新；null 视为最旧（从未封存/更新）。
      const reordered = [...hits].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))
      return {
        note: '如果冲突，以最新的为准。时间戳较旧的条目可作为事情发展过程的参考。如果你确实需要更多细节，可以直接去聊天记录里搜索相关关键词。',
        hits: reordered.map((h) => ({
          id: h.id,
          level: h.level,
          title: h.title ?? '',
          content: contentMax > 0 ? h.content.slice(0, contentMax) : h.content,
          score: Math.round(h.score * 100) / 100,
          updated_at: h.updated_at ?? 0,
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
        updated_at: r.updated_at,
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
        const hint = '如果你确实需要更多细节，可以直接去聊天记录里搜索相关关键词。'
        if (!v.found) return [{ type: 'text' as const, text: `未找到该记忆。${hint}` }]
        const parts = [`[${String(v.level ?? '')}] ${String(v.title ?? '')}（${String(v.status ?? '')}）`]
        if (v.project) parts.push(`项目：${String(v.project)}`)
        if (v.goal) parts.push(`目标：${String(v.goal)}`)
        parts.push(String(v.content ?? ''))
        parts.push(hint)
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
        project: { type: 'string', description: '新项目名（project/fact/lesson/rules）。' },
        keywords: { type: 'array', items: { type: 'string' }, description: '手动指定关键词（默认写入时自动提取；发现不准时主动修正/补充，空数组=清空）。' },
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
      const parsed = args as { id?: unknown; content?: unknown; title?: unknown; status?: unknown; importance?: unknown; goal?: unknown; project?: unknown; keywords?: unknown }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
      if (!id) throw new Error('memory_update: id 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_update: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const sessionId = sessionIdOf(exec)
      const found = db.findById(id)
      if (!found) return { ok: false, id, level: '' }
      const patch: MemoryPatch = {}
      if (typeof parsed.content === 'string' && parsed.content.trim()) patch.content = parsed.content.trim()
      if (typeof parsed.title === 'string' && parsed.title.trim()) patch.title = parsed.title.trim()
      if (typeof parsed.status === 'string' && ['active', 'archived', 'stale'].includes(parsed.status)) patch.status = parsed.status as MemoryPatch['status']
      if (typeof parsed.importance === 'number') patch.importance = Math.max(0, Math.min(3, Math.round(parsed.importance)))
      if (typeof parsed.goal === 'string' && parsed.goal.trim() && found.level === 'topic') patch.goal = parsed.goal.trim()
      if (typeof parsed.project === 'string' && parsed.project.trim() && (found.level === 'project' || found.level === 'fact' || found.level === 'lesson' || found.level === 'rules' || found.level === 'topic')) {
        patch.project = parsed.project.trim()
        // 锚定当前 project（命中检索限定"全局+当前项目"）。
        setCurrentProject(workspace, sessionId ?? 'unknown', patch.project, dir)
      }
      if (Array.isArray(parsed.keywords)) {
        patch.keywords = parsed.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter((k) => k.length > 0)
      }
      // 记忆时间戳 = 最后更新时间：db.update 内部自动刷新 updated_at（任何 update 都刷新）。
      const ok = db.update(found.level, found.row.id, patch)
      return { ok, id: found.row.id, level: found.level }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'write' } {
      const parsed = args as { id?: unknown; status?: unknown }
      return { card: 'generic', title: `memory_update: ${String(parsed.id ?? '').slice(0, 8)}${parsed.status ? ` → ${String(parsed.status)}` : ''}`, kind: 'write' }
    },
  }
}

/** 子标签 → 注入段落标题。 */
const PROJECT_SECTION_TITLES: Record<ProjectSubcategory, string> = {
  overview: '项目概述',
  structure: '项目结构',
  decisions: '技术决策',
  quotes: '用户原话',
  ops: '部署与数据',
  todo: '项目进度',
}

/** 组内排序：记忆时间戳（updated_at）旧→新，相同按创建时间；null 视为最旧。 */
function sortByUpdatedAt(list: MemoryRow[]): MemoryRow[] {
  return [...list].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0) || a.created_at - b.created_at)
}

/**
 * memory_project：取回某项目的完整注入段落（用户拍板规格）。
 * - 非 todo 子标签：active 条目全部；
 * - todo 子标签：active 全部为「To do list：」+ stale（已完成）按 updated_at 取最近 5 条为「已完成：」；
 * - 组内按记忆时间戳旧→新；只拼 content 纯文本，不写复杂格式。
 */
function projectTool(dir: string): ToolDefinition {
  return {
    name: 'memory_project',
    description: [
      '取回某个项目在记忆库中的完整注入段落（纯文本，按子标签分组，未过时条目一口气全给）。',
      '当用户问起某个项目（femwa/meow-memory/meow-eyes/dsh…）的设计历史、技术决策、用户原话、项目进度时调用；',
      '也用于需要项目全景上下文再作答的场合。',
      '规则：组内按记忆时间戳旧→新；todo 子标签输出「已完成：」（最近完成 5 条）+「To do list：」。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['project'],
      properties: {
        project: { type: 'string', description: '项目名（会话开头的记忆导引会列出用户的所有 project，直接选用）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'text'],
        properties: {
          project: { type: 'string' },
          text: { type: 'string', description: '按子标签分组的项目记忆注入段落（纯文本）。' },
        },
      },
      render: (_args, value) => {
        const v = value as { text?: unknown }
        return [{ type: 'text' as const, text: String(v.text ?? '') }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const parsed = args as { project?: unknown }
      const project = typeof parsed.project === 'string' ? parsed.project.trim() : ''
      if (!project) throw new Error('memory_project: project 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_project: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      // 锚定当前 project：用户话题切到某项目时 AI 调 memory_project → 命中检索立即跟进。
      const sessionId = sessionIdOf(exec)
      setCurrentProject(workspace, sessionId ?? 'unknown', project, dir)
      const rows = db.list('project', { project }).filter((r) => r.project === project)
      const active = rows.filter((r) => r.status === 'active')
      // todo 已完成：stale 且 updated_at 非空，按 updated_at 取最近 5 条（展示仍按旧→新）。
      const done = sortByUpdatedAt(
        rows
          .filter((r) => r.subcategory === 'todo' && r.status === 'stale' && r.updated_at !== null)
          .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
          .slice(0, 5),
      )
      const bySub = new Map<ProjectSubcategory, MemoryRow[]>()
      for (const r of active) {
        const sub = r.subcategory ?? 'overview' // 早期无子类条目归概述组
        const list = bySub.get(sub) ?? []
        list.push(r)
        bySub.set(sub, list)
      }
      const sections: string[] = []
      // 项目设计原则（rules，project 特定）：放最前——规则优先于事实。
      const projectRules = sortByUpdatedAt(
        db.list('rules', { project }).filter((r) => r.project === project && r.status === 'active'),
      )
      if (projectRules.length > 0) {
        sections.push(`设计原则\n${projectRules.map((r) => r.content).join('\n')}`)
      }
      for (const sub of PROJECT_SUBCATEGORIES) {
        if (sub === 'todo') {
          const todos = sortByUpdatedAt(bySub.get('todo') ?? [])
          if (todos.length === 0 && done.length === 0) continue
          const lines = [PROJECT_SECTION_TITLES.todo]
          if (done.length > 0) {
            lines.push('已完成：')
            for (const r of done) lines.push(r.content)
          }
          if (todos.length > 0) {
            lines.push('To do list：')
            for (const r of todos) lines.push(r.content)
          }
          sections.push(lines.join('\n'))
        } else {
          const list = sortByUpdatedAt(bySub.get(sub) ?? [])
          if (list.length === 0) continue
          sections.push(`${PROJECT_SECTION_TITLES[sub]}\n${list.map((r) => r.content).join('\n')}`)
        }
      }
      if (sections.length === 0) {
        return { project, text: `【项目：${project}】该项目暂无记忆条目。` }
      }
      const dbPath = memoryDbPath(workspace, dir)
      const text = [
        `【项目：${project}】`,
        '',
        sections.join('\n\n'),
        '',
        '——',
        '说明：此处只提供未过时的信息。',
        `如果你想看已过时的条目（archived/stale），或某条记忆的具体时间戳（记忆时间戳=该窗口 dream 封存时刻）、记忆来源（source_session）、重要性、关键词等元数据，可以直接去搜记忆库 SQLite：${dbPath}`,
        '（库内结构：七层表 soul/user/project/fact/lesson/topic/rules，字段含 id/title/content/importance/keywords/status/corrected/project/subcategory/goal/source_session/created_at/updated_at（记忆时间戳=最后更新时间）/last_accessed_at；另有 dream_log 整理留痕表、windows 窗口时间表；也可按 id 用 memory_read 看单条完整元数据）',
        `如果你想了解未被记录的更多细节，可以直接去搜会话历史目录（dsh 的 session 日志，位置由 DSH_HOME 决定，默认 ~/.dsh/sessions，喵版为 dsh-home/sessions），按会话 id 查原始记录。`,
      ].join('\n')
      return { project, text }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'read' } {
      const parsed = args as { project?: unknown }
      return { card: 'generic', title: `memory_project: ${String(parsed.project ?? '').slice(0, 24)}`, kind: 'read' }
    },
  }
}

export function registerMemoryTools(register: (t: ToolDefinition) => void, dir = '.dsh-meow'): void {
  register(rememberTool(dir))
  register(searchTool(dir))
  register(findSimilarTool(dir))
  register(readTool(dir))
  register(updateTool(dir))
  register(projectTool(dir))
}
