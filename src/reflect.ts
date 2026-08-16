/**
 * meow-memory v2 — ReAct 任务结束后的自动反思。
 *
 * 触发：一次任务（单个 turn）内连续 react（工具）step ≥ reflectTurns（默认 7）
 * 后，在该轮结束时触发一次；单次简单工具调用不触发。顶层会话、本 turn 未反思过、
 * 最后工具非 memory_ 系列。
 * 反思消息三块：
 *   1) 记忆清单（fact/lesson 短条目、原话保留、project/topic 规则）；
 *   2) 话题偏离信号（keyword 聚类余弦，只提醒不拍板）；
 *   3) 最相关 topic 当前版本底稿（模型重写前先看它，防无底稿覆盖）。
 */

import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { Doc } from './bm25.js'
import { topicDrift } from './bm25.js'
import { getDb } from './db.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'meow-memory' }

/** 反思消息识别标记（防同 turn 重复反思）。 */
export const REFLECT_MARKER = '[meow-memory-reflect]'

export function scanTurn(events: readonly unknown[]): {
  sawToolCall: boolean
  lastToolName?: string
  sawReflect: boolean
  turnText: string
} {
  let startIdx = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string }
    if (e?.type === 'turn/start') {
      startIdx = i
      break
    }
  }
  let sawToolCall = false
  let lastToolName: string | undefined
  let sawReflect = false
  const texts: string[] = []
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i] as {
      type?: string
      data?: {
        source?: { kind?: string; plugin?: string }
        content?: Array<{ type?: string; text?: string }>
        message?: { content?: Array<{ type?: string; name?: string; text?: string }> }
      }
    }
    if (e?.type === 'user/message') {
      const src = e.data?.source
      if (src?.kind === 'plugin' && src.plugin === 'meow-memory') sawReflect = true
      else {
        for (const b of e.data?.content ?? []) if (b.type === 'text' && b.text) texts.push(b.text)
      }
    } else if (e?.type === 'assistant/message') {
      for (const block of e.data?.message?.content ?? []) {
        if (block.type === 'tool-call') {
          sawToolCall = true
          lastToolName = block.name
        } else if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }
  }
  return { sawToolCall, lastToolName, sawReflect, turnText: texts.join('\n').slice(-2000) }
}

/**
 * 统计当前 turn（最后一个 turn/start 之后）内「连续非 memory_ 工具 step」的最大段长。
 * 每个 tool-call 计 1 step（同一 assistant/message 内的并行调用逐个计数）；
 * memory_ 工具调用中断连续段（已主动记忆，不再反思）。用户拍板：一次任务
 * 连续 react ≥7 个工具 step 才在任务结束时触发反思。
 */
export function consecutiveToolSteps(events: readonly unknown[]): number {
  let startIdx = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as { type?: string }).type === 'turn/start') {
      startIdx = i
      break
    }
  }
  let best = 0
  let cur = 0
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i] as {
      type?: string
      data?: { message?: { content?: Array<{ type?: string; name?: string }> } }
    }
    if (e?.type !== 'assistant/message') continue
    for (const b of e.data?.message?.content ?? []) {
      if (b.type !== 'tool-call' || typeof b.name !== 'string') continue
      if (b.name.startsWith('memory_')) cur = 0
      else {
        cur++
        if (cur > best) best = cur
      }
    }
  }
  return best
}

const BASE_PROMPT = [
  '[记忆反思]',
  '从上次整理记忆到现在，中间这么多轮次里，有值得跨会话记住的新记忆吗？',
  '是否有哪条记忆，你非常确定它的信息已经过时了（比如由用户亲口否定或改变）？你应该更新它。',
  '如果有，按需调用 memory_remember / memory_update；没有则回复"无需记忆"。',
  '',
  '【一】添加记忆条目',
  '如存在以下情况，你可以酌情添加记忆条目：',
  '- 用户的交流/工作/代码偏好（user）；项目特定偏好进 project。',
  '- 设计原则/行为准则（rules）：全局准则不填 project 且 importance≥2（会全量注入首轮）；项目特定准则填 project（随 memory_project 注入）；用户介绍设计思路/框架/决策理由的原话必须保留措辞，进 rules 或 lesson；',
  '- 项目相关的关键信息（project：必须给项目名）。project 子标签（subcategory）：',
  '  overview=项目目标概述 / structure=项目结构 / decisions=技术决策 /',
  '  quotes=用户原话 / ops=部署与数据 / todo=进行中事项（todo 完成时标 stale 视为 done）。',
  '- 用户介绍项目设计思路、框架、决策理由时说的话——必须保留用户原话措辞，不要转述总结（进 project 或 lesson）；',
  '- 重要的事实、结论或决定（fact：一句话直陈，≤60 字）；',
  '- 犯过的错、被用户纠正的地方、多次尝试才成功的经验、踩过的坑（lesson，被纠正的一定要记，保留用户原话和 corrected 标记）；',
  '- 写记忆时，总结完记忆内容后，同时总结这段记忆的关键词（提取 5-10 个内容词，如"记忆插件"；别提取"好的""这个"等虚词），随 memory_remember 的 keywords 参数一起提交。',
  '',
  '【二】总结话题进展',
  '如果你们正在讨论的话题有了新的进展、新的事实、新的发展经过结果，你可以更新话题描述。',
  '话题 topic 规则：',
  '- topic 创建/更新时必须带 project 参数（所属项目名，见会话开头导引中的项目列表）。',
  '- 一条 topic = 一个正在进行或刚结束的讨论线索，可跨会话持续。',
  '- 创建时用 memory_remember 写目标句（goal）与名词性标题（对象+动作，如「femGen 集成」；禁止宽泛名如"dsh 插件"）。',
  '- 归属判断：本 turn 是否让已有 topic 的目标句更接近一步？是 → memory_update 重写该 topic（【起因经过发展结果】≤300 字，旧的没价值信息可丢弃）；否（与目标无因果关联的独立事项）→ 新建 topic。',
  '- 完结：达成目标且连续 ≥2 会话或 ≥7 天无进展 → 标 archived；无结论久无进展 → 标 stale。',
  '',
  '注意：memory_remember / memory_update 调用成功后即完成，不要重复调用。',
  '如果没有值得记住的，直接回复"无需记忆"即可，不要调用任何工具。',
].join('\n')

function formatTopicDraft(t: { title: string | null; goal: string | null; content: string; id: string }): string {
  const parts = [`话题「${t.title ?? '(无标题)'}」当前版本（id=${t.id.slice(0, 8)}）：`]
  if (t.goal) parts.push(`目标：${t.goal}`)
  parts.push(t.content)
  return parts.join('\n')
}

export function buildReflectMessage(workspace: string, turnText: string, dir = '.dsh-meow'): ReturnType<typeof createUserMessage> {
  const db = getDb(workspace, dir)
  const topics = db.list('topic', { status: 'active' })
  const drift = topicDrift(
    turnText,
    topics.map((t) => ({
      id: t.id,
      level: 'topic',
      title: t.title,
      content: t.content,
      keywords: t.keywords,
      importance: t.importance,
      created_at: t.created_at,
    })) as Doc[],
  )

  const blocks: string[] = [REFLECT_MARKER, BASE_PROMPT]
  if (drift.suggestsNew) {
    blocks.push(
      '',
      `[关键词偏离提示] 本 turn 与现有话题「${drift.topTopic?.title ?? '?'}」的相似度仅 ${drift.topScore.toFixed(2)}，` +
        '疑似切换到了新话题/子话题。请用上面的目标句规则判断：仍在推进旧话题目标 → 归旧话题；否则新建 topic。',
    )
  }
  if (drift.topTopic) {
    const t = topics.find((x) => x.id === drift.topTopic!.id)
    if (t) blocks.push('', '【相关话题底稿】（重写前先读它，不要凭记忆覆盖）', formatTopicDraft(t))
  }
  const text = blocks.join('\n')
  return createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE })
}

export { PLUGIN_SOURCE }
