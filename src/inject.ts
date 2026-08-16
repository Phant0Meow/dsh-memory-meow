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
import { search, tokenize } from './bm25.js'
import type { MemoryDb, MemoryRow } from './db.js'

export interface InjectOptions {
  /** 关键词命中条数上限（fact/lesson 短条目）。 */
  hitTopK: number
  /** 导引里 project/topic 标题超长截断长度。 */
  titleMax: number
}

const DEFAULT_OPTS: InjectOptions = { hitTopK: 3, titleMax: 40 }

export function sessionsFile(workspace: string, sessionId: string, dir = '.dsh-meow'): string {
  return join(workspace, dir, 'sessions', `${sessionId}.json`)
}

/** 会话记忆可见集：injected=注入过的，searched=search/find_similar 返回过的。
 *  两者都是"本会话上下文里已经出现过的记忆"，检索时应排除（省 token、扩大检索面）。 */
export interface SessionSeen {
  injected: string[]
  searched: string[]
}

function readSeenFile(workspace: string, sessionId: string, dir: string): SessionSeen {
  try {
    const text = readFileSync(sessionsFile(workspace, sessionId, dir), 'utf8')
    const parsed = JSON.parse(text) as { injected?: unknown; searched?: unknown }
    return {
      injected: Array.isArray(parsed.injected) ? parsed.injected.filter((x): x is string => typeof x === 'string') : [],
      searched: Array.isArray(parsed.searched) ? parsed.searched.filter((x): x is string => typeof x === 'string') : [],
    }
  } catch {
    return { injected: [], searched: [] }
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
  writeFileSync(file, JSON.stringify({ injected: [...set], searched: seen.searched }), 'utf8')
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
  writeFileSync(file, JSON.stringify({ injected: seen.injected, searched: [...set] }), 'utf8')
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
  }))
}

function shortTitle(row: MemoryRow, max: number): string {
  const t = row.title?.trim()
  if (t) return t.length > max ? t.slice(0, max) + '…' : t
  const c = row.content.replace(/\s+/g, ' ').trim()
  return c.length > max ? c.slice(0, max) + '…' : c
}

/**
 * 构造注入块。返回 { text, injectedIds }；无任何可注入内容返回 null。
 * firstUserText 用于关键词命中检索。
 */
export function buildInjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  firstUserText: string,
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  const soul = db.list('soul', { status: 'active' })
  const user = db.list('user', { status: 'active' })
  const projects = db.list('project', { status: 'active' })
  const topics = db.list('topic', { status: 'active' })

  const lines: string[] = []
  const injected: string[] = []

  const pushEntries = (label: string, rows: MemoryRow[]) => {
    if (rows.length === 0) return
    lines.push(`【${label}】`)
    for (const r of rows) lines.push(`- ${r.content}`)
    lines.push('')
  }

  pushEntries('soul 核心', soul)
  pushEntries('user 偏好', user)

  // 记忆导引：project 按项目分组、topic 标题列表。正文不注入，模型自取。
  if (projects.length > 0 || topics.length > 0) {
    lines.push('【记忆导引】需要时用 memory_search 检索、memory_read 读取（只看标题，正文自取）：')
    const byProject = new Map<string, MemoryRow[]>()
    for (const p of projects) {
      const name = p.project ?? '未分类'
      if (!byProject.has(name)) byProject.set(name, [])
      byProject.get(name)!.push(p)
    }
    for (const [name, rows] of byProject) {
      lines.push(`- project:${name} — ${rows.map((r) => shortTitle(r, o.titleMax)).join(' / ')}`)
    }
    for (const t of topics) {
      const mark = t.status === 'stale' ? '（stale）' : ''
      lines.push(`- topic:${shortTitle(t, o.titleMax)}${mark}`)
    }
    lines.push('')
  }

  // 关键词命中：第一条用户消息检索 fact/lesson 短条目，直接注入。
  const hitRows = [...db.list('fact', { status: 'active' }), ...db.list('lesson', { status: 'active' })]
  if (hitRows.length > 0) {
    const query = firstUserText.slice(0, 500)
    const hits = search(query, toDocs(hitRows), { k: o.hitTopK, now: null })
    const fresh = hits.filter((h) => !readInjected(workspace, sessionId, dir).includes(h.id))
    if (fresh.length > 0) {
      lines.push('【相关记忆】与你的消息关键词相关（fact/lesson）：')
      for (const h of fresh) {
        lines.push(`- [${h.level}:${h.id.slice(0, 8)}] ${h.content}`)
        injected.push(h.id)
      }
      lines.push('')
    }
  }

  if (lines.length === 0) return null
  const body = lines.join('\n').trimEnd()
  const text = `\n\n---\n\n[记忆注入 meow-memory — 本会话内快照不变，需要更多用 memory_search]\n\n${body}\n\n=====记忆结束=====\n\n\n【本轮用户输入】：\n\n`
  if (injected.length > 0) markInjected(workspace, sessionId, injected, dir)
  return { text, injectedIds: injected }
}

// 导出 tokenize 供索引/测试复用
export { tokenize }
