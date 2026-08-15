/**
 * meow-memory v2 — PROJECT.md → SQLite 一次性迁移。
 *
 * 只在库刚创建（isFresh）且旧文件存在时执行。导入后旧文件改名
 * PROJECT.md.imported 留底（不删——红线：本机文件一律不删除）。
 *
 * 路由规则（用户拍板）：
 *   域路由：fact→fact；mistake→lesson(corrected=1)；preference→user；
 *           user_said→project（原话保留）/lesson（纠正语义）；lesson→lesson；
 *           detail→project（含项目结构）/fact；核心区→soul/user。
 *   项目启发式：femwa/femGen/FemWA→femwa；meow-eyes/猫眼→meow-eyes；
 *           meow-memory→meow-memory；dsh-meow/dsh 本体/3080/3081→dsh；
 *           无法判定→dsh 兜底（dream 复核分拣）。
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Level, MemoryDb } from './db.js'

const CATEGORY_TO_LEVEL: Record<string, { level: Level; corrected?: number }> = {
  fact: { level: 'fact' },
  mistake: { level: 'lesson', corrected: 1 },
  preference: { level: 'user' },
  user_said: { level: 'project' },
  lesson: { level: 'lesson' },
  detail: { level: 'project' },
}

const PROJECT_HINTS: Array<[RegExp, string]> = [
  [/femwa|femgen|fe4m/i, 'femwa'],
  [/meow-eyes|猫眼/i, 'meow-eyes'],
  [/meow-memory|memory-meow/i, 'meow-memory'],
  [/dsh-meow|dsh 本体|3080|3081|known-event|agentPreset|apiproxy/i, 'dsh'],
]

function guessProject(content: string): string {
  for (const [re, name] of PROJECT_HINTS) {
    if (re.test(content)) return name
  }
  return 'dsh'
}

/** detail 含项目结构/接口信息 → project，否则细碎事实 → fact。 */
function routeDetail(content: string): Level {
  return /路径|仓库|端口|目录|结构|junction|文件|package\.json|\.dsh|node_modules|http|127\.0\.0\.1|api|ctx\.|插件|引擎|路由/i.test(
    content,
  )
    ? 'project'
    : 'fact'
}

/** user_said：被纠正语义 → lesson(corrected=1)，否则 project（原话保留）。 */
function routeUserSaid(content: string): { level: Level; corrected?: number } {
  return /纠正|教训|错了|错了|改口|拍板|确认/i.test(content)
    ? { level: 'lesson', corrected: 1 }
    : { level: 'project' }
}

function routeCategory(cat: string, content: string): { level: Level; corrected?: number } {
  switch (cat) {
    case 'detail':
      return { level: routeDetail(content) }
    case 'user_said':
      return routeUserSaid(content)
    default:
      return CATEGORY_TO_LEVEL[cat] ?? { level: 'fact' }
  }
}

/**
 * 解析旧 PROJECT.md：核心区（首个 ## 节之前）+ 各分类节。
 * 返回 { coreLines, entries: [{ category, content }] }。
 */
function parseLegacy(text: string): { core: string[]; entries: Array<{ category: string; content: string }> } {
  const core: string[] = []
  const entries: Array<{ category: string; content: string }> = []
  let current: string | null = null // null = 核心区
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trimEnd()
    const sec = line.match(/^##\s+.+\(([a-z_]+)\)\s*$/)
    if (sec) {
      current = sec[1]
      continue
    }
    if (line.startsWith('- ')) {
      const content = line.slice(2).trim()
      if (!content) continue
      if (current) entries.push({ category: current, content })
      else core.push(content)
      continue
    }
    // 核心区里的非空非标题行（描述性段落）也收进 core
    if (!current) {
      const t = line.trim()
      if (t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('=====')) core.push(t)
    }
  }
  return { core, entries }
}

function splitCoreLine(line: string): Level {
  // 含 AI/模型/我 行为语义 → soul；否则 user（红线/工作方式/环境事实归 user）
  return /ai|模型|我应该|作为|身份|自我|soul/i.test(line) ? 'soul' : 'user'
}

/** 执行迁移。返回导入条数；无需迁移返回 null。 */
export function migrateLegacy(db: MemoryDb, workspace: string, dir = '.dsh-meow'): number | null {
  const projectFile = join(workspace, dir, 'PROJECT.md')
  if (!db.isFresh() || !existsSync(projectFile)) return null

  const text = readFileSync(projectFile, 'utf8')
  const { core, entries } = parseLegacy(text)

  let imported = 0
  const now = Date.now()
  for (const line of core) {
    const level = splitCoreLine(line)
    db.insert({ level, content: line, importance: 3, source_session: 'migration', created_at: now })
    imported++
  }
  for (const { category, content } of entries) {
    const routed = routeCategory(category, content)
    const level = routed.level
    const project =
      level === 'project' || level === 'fact' || level === 'lesson' ? guessProject(content) : null
    db.insert({
      level,
      content,
      importance: 1,
      corrected: routed.corrected ?? 0,
      project,
      source_session: 'migration',
      created_at: now,
    })
    imported++
  }

  // 留底不删
  try {
    renameSync(projectFile, projectFile + '.imported')
  } catch {
    /* 改名失败不阻塞迁移 */
  }
  return imported
}
