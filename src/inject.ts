/**
 * meow-memory v2 — 会话开头注入。
 *
 * 结构（用户拍板）：soul/user 全量 + 记忆导引（project/topic 标题列表，
 * 正文模型自取）+ 第一条用户消息关键词命中 fact/lesson 短条目自动注入。
 * 无每轮注入——模型自己用 memory_search 深挖。
 *
 * 去重：.dsh-meow/sessions/<sessionId>.json 记录本会话注入过的 memory id，
 * 已注入不重复。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Doc } from './bm25.js'
import { keywordHitScore, search, tokenize } from './bm25.js'
import { relativeTime, type MemoryDb, type MemoryRow } from './db.js'

export interface InjectOptions {
  /** 关键词命中条数上限（fact/lesson 短条目）。 */
  hitTopK: number
  /** 导引里 project/topic 标题超长截断长度。 */
  titleMax: number
}

const DEFAULT_OPTS: InjectOptions = { hitTopK: 2, titleMax: 40 }

export function sessionsFile(workspace: string, sessionId: string, dir = '.dsh-meow'): string {
  return join(workspace, dir, 'sessions', `${sessionId}.json`)
}

/** 会话记忆可见集：injected=注入过的，searched=search/find_similar 返回过的。
 *  两者都是"本会话上下文里已经出现过的记忆"，检索时应排除（省 token、扩大检索面）。 */
export interface SessionSeen {
  injected: string[]
  searched: string[]
  /** 当前 project 锚定（最近一次带 project 参数的 memory 工具调用）：命中检索限定"全局+当前项目"。 */
  currentProject: string | null
}

function readSeenFile(workspace: string, sessionId: string, dir: string): SessionSeen {
  try {
    const text = readFileSync(sessionsFile(workspace, sessionId, dir), 'utf8')
    const parsed = JSON.parse(text) as { injected?: unknown; searched?: unknown; currentProject?: unknown }
    return {
      injected: Array.isArray(parsed.injected) ? parsed.injected.filter((x): x is string => typeof x === 'string') : [],
      searched: Array.isArray(parsed.searched) ? parsed.searched.filter((x): x is string => typeof x === 'string') : [],
      currentProject: typeof parsed.currentProject === 'string' && parsed.currentProject.length > 0 ? parsed.currentProject : null,
    }
  } catch {
    return { injected: [], searched: [], currentProject: null }
  }
}

/** 读本会话已注入 id 列表（文件不存在返回空数组）。 */
export function readInjected(workspace: string, sessionId: string, dir = '.dsh-meow'): string[] {
  return readSeenFile(workspace, sessionId, dir).injected
}

/** 追加写入已注入 id。 */
export function markInjected(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const file = sessionsFile(workspace, sessionId, dir)
  mkdirSync(dirname(file), { recursive: true })
  const seen = readSeenFile(workspace, sessionId, dir)
  const set = new Set(seen.injected)
  for (const id of ids) set.add(id)
  writeFileSync(file, JSON.stringify({ injected: [...set], searched: seen.searched, currentProject: seen.currentProject }), 'utf8')
}

/** 本会话全部"已见" id（注入 + 检索），检索排除用。 */
export function readSeen(workspace: string, sessionId: string, dir = '.dsh-meow'): Set<string> {
  const s = readSeenFile(workspace, sessionId, dir)
  return new Set([...s.injected, ...s.searched])
}

/** 追加已检索返回的 id（memory_search / memory_find_similar 命中后调用）。 */
export function markSearched(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const file = sessionsFile(workspace, sessionId, dir)
  mkdirSync(dirname(file), { recursive: true })
  const seen = readSeenFile(workspace, sessionId, dir)
  const set = new Set(seen.searched)
  for (const id of ids) set.add(id)
  writeFileSync(file, JSON.stringify({ injected: seen.injected, searched: [...set], currentProject: seen.currentProject }), 'utf8')
}

/** 释放本会话已见记录（收到会话压缩信号后调用）：清空 injected/searched，
 *  允许之前注入/检索过的记忆被再次命中提取——压缩后它们的内容已不在上下文里。
 *  当前 project 锚定保留（与可见性无关）。 */
export function releaseSeen(workspace: string, sessionId: string, dir = '.dsh-meow'): void {
  const file = sessionsFile(workspace, sessionId, dir)
  mkdirSync(dirname(file), { recursive: true })
  const seen = readSeenFile(workspace, sessionId, dir)
  writeFileSync(file, JSON.stringify({ injected: [], searched: [], currentProject: seen.currentProject }), 'utf8')
}

/** 读当前 project 锚定（最近一次带 project 参数的 memory 工具调用）；未锚定返回 null。 */
export function getCurrentProject(workspace: string, sessionId: string, dir = '.dsh-meow'): string | null {
  return readSeenFile(workspace, sessionId, dir).currentProject
}

/** 锚定当前 project：memory 工具调用带 project 参数时更新会话状态（命中检索用它，免扫历史）。 */
export function setCurrentProject(workspace: string, sessionId: string, project: string, dir = '.dsh-meow'): void {
  const file = sessionsFile(workspace, sessionId, dir)
  mkdirSync(dirname(file), { recursive: true })
  const seen = readSeenFile(workspace, sessionId, dir)
  writeFileSync(file, JSON.stringify({ injected: seen.injected, searched: seen.searched, currentProject: project }), 'utf8')
}

function toDocs(rows: MemoryRow[]): Doc[] {
  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    title: r.title,
    content: r.content,
    keywords: r.keywords,
    importance: r.importance,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))
}

function shortTitle(row: MemoryRow, max: number): string {
  const t = row.title?.trim()
  if (t) return t.length > max ? t.slice(0, max) + '…' : t
  const c = row.content.replace(/\s+/g, ' ').trim()
  return c.length > max ? c.slice(0, max) + '…' : c
}
/* v8 ignore next -- 保留工具函数（历史/调试用），当前导引不再截断标题 */
void shortTitle

/**
 * 构造首轮长期记忆注入块（用户拍板格式）：
 *   顶格「===== 长期记忆 =====」→ 【关于你】(soul) / 【关于user】/ 【设计原则】/ 【记忆导引】(两行)
 *   →「===== 长期记忆结束 =====」+「本轮用户prompt：」。
 * 首轮只注入长期记忆，不做关键词命中（命中链路从第二轮起，见 buildHitInjection）；
 * 正文注入的 id 记入已见（命中链路不再重复注入它们）。
 * @returns { text, injectedIds }；无任何可注入内容返回 null。
 */
export function buildInjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  _firstUserText: string,
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  const soul = db.list('soul', { status: 'active' })
  const user = db.list('user', { status: 'active' })

  const lines: string[] = ['===== 长期记忆 =====', '']
  const injected: string[] = []

  const pushEntries = (label: string, rows: MemoryRow[]) => {
    if (rows.length === 0) return
    lines.push(`【${label}】`)
    for (const r of rows) {
      lines.push(`- ${r.content}`)
      injected.push(r.id) // 正文已注入 → 记入已见（命中链路不再重复注入）
    }
    lines.push('')
  }

  pushEntries('关于你', soul)
  pushEntries('关于user', user)

  // 设计原则（rules）：只注入「全局（project 为空）且 importance≥2」的——少而精的命令式准则。
  const globalRules = db.list('rules', { status: 'active' }).filter((r) => r.project === null && r.importance >= 2)
  pushEntries('设计原则', globalRules)

  // 记忆导引：说明 + 项目列表（正文/标题一律自取，不列）。
  const projectNames = db.listProjectNames()
  if (projectNames.length > 0) {
    lines.push('【记忆导引】')
    lines.push('需要时用 memory_search 检索（必须传 query 检索词，不能空查）、memory_read 读取。')
    lines.push('当有项目相关任务时，应先用 memory_project 查项目全景，这样可以对项目有整体理解。')
    lines.push(`用户的所有 project：${projectNames.join(' / ')}`)
    lines.push('')
  }

  if (lines.length <= 2) return null // 只有标题头，无任何内容
  const body = lines.join('\n').trimEnd()
  const text = `${body}\n\n===== 长期记忆结束 =====\n\n本轮用户prompt：\n\n`
  if (injected.length > 0) markInjected(workspace, sessionId, injected, dir)
  return { text, injectedIds: injected }
}

/** 关键词命中查询（首轮与每条消息链路共用）：active 的 fact/lesson/rules/topic，
 *  范围=全局 或 当前 project 锚定；排除本会话已见（injected+searched）；
 *  不检索本 session 建立的记忆（它们就在上下文里，AI 最清楚，无需命中）。
 *  命中打分基于条目关键词（keywords，+title）而非全文——全文匹配噪音大
 *  （常见 bigram 如"的时"每条消息都有，长条目一碰词就整条注入）。 */
function hitQuery(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  userText: string,
  o: InjectOptions,
  dir: string,
): Array<{ id: string; level: string; content: string; updated_at: number | null }> {
  const currentProject = readSeenFile(workspace, sessionId, dir).currentProject
  const hitRows = [
    ...db.list('fact', { status: 'active' }),
    ...db.list('lesson', { status: 'active' }),
    ...db.list('rules', { status: 'active' }),
    ...db.list('topic', { status: 'active' }),
  ].filter((r) =>
    (r.project === null || (currentProject !== null && r.project === currentProject))
    && r.source_session !== sessionId, // 本 session 建立的记忆在上下文里，不命中
  )
  if (hitRows.length === 0) return []
  const query = userText.slice(0, 500)
  const docs = toDocs(hitRows).map((d) => ({
    ...d,
    // 匹配面 = 条目关键词（LLM 提取或自动 bigram；无关键词的旧条目回退内容前 100 字）。
    content: d.keywords.length > 0 ? d.keywords.join(' ') : d.content.slice(0, 100),
  }))
  // 命中专用打分：交集×覆盖率×艾宾浩斯(updated_at)×importance×title 加成（艾宾浩斯开着）。
  const hits = keywordHitScore(query, docs, { k: o.hitTopK })
  const byId = new Map(hitRows.map((r) => [r.id, r]))
  // 展示/注入用原文 content（docs 的 content 只是 keywords 匹配面，不能当正文）。
  return hits
    .filter((h) => !readInjected(workspace, sessionId, dir).includes(h.id))
    .map((h) => {
      const row = byId.get(h.id)
      return { id: h.id, level: h.level, content: row?.content ?? h.content, updated_at: row?.updated_at ?? null }
    })
}

/**
 * 每条用户消息的关键词命中注入（独立于首轮注入的链路）：
 * 检索 active 的 fact/lesson/rules/topic（全局+当前锚定项目），top-K 命中注入，
 * 命中 id 记入本会话已见（之后不再命中；压缩释放 seen 后恢复）。
 * 格式（用户拍板）：顶格「可能相关的记忆，仅供参考：」→ 条目（- [id] 换行接内容、
 * 条目间空行）→ 分割线 + 「本轮用户prompt：」；前面都是注入，后面是用户消息。
 * @returns 命中注入块；无命中返回 null。
 */
export function buildHitInjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  userText: string,
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  const fresh = hitQuery(db, workspace, sessionId, userText, o, dir)
  if (fresh.length === 0) return null
  const lines = ['可能相关的记忆，仅供参考：']
  for (const h of fresh) {
    // 时间信息：记忆时间戳（updated_at=最后更新时间）的相对时间；从未更新（null）不显示。
    const time = h.updated_at !== null ? ` ${relativeTime(h.updated_at)}` : ''
    lines.push(`- [${h.level}:${h.id.slice(0, 8)}]${time}`)
    lines.push(h.content)
    lines.push('')
  }
  const text = `${lines.join('\n')}------\n本轮用户prompt：\n\n`
  const ids = fresh.map((h) => h.id)
  markInjected(workspace, sessionId, ids, dir)
  return { text, injectedIds: ids }
}

// 导出 tokenize 供索引/测试复用
export { tokenize }
