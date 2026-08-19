/**
 * meow-memory v2 — ReAct 任务结束后的自动反思。
 *
 * 触发：一次任务（单个 turn）内连续 react（工具）step ≥ reflectTurns（默认 7）
 * 后，在该轮结束时触发一次；单次简单工具调用不触发。顶层会话、本 turn 未反思过、
 * 最后工具非 memory_ 系列。
 * 反思消息（用户拍板 2026-08-19 终稿）：【一】新记忆（project 列表/纠正/偏好等）、
 * 【二】更新判断（过时/错误/完成/关键词不准反推）、【三】通用要求（subcategory/
 * 关键词 8-13/importance/收尾）。topic 归 dream 轮处理，反思不再涉及。
 */

import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
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

function buildBasePrompt(projectNames: string[]): string {
  const projectList = projectNames.length > 0 ? projectNames.join(' / ') : '（暂无）'
  return [
    '记忆反思任务',
    '请回顾你的聊天历史。',
    '',
    '【一】从上次【记忆反思任务】，到现在，中间这么多轮次里，有值得跨会话记住的新记忆吗？使用memory_remember添加新记忆条目。',
    `1. 当前记忆库中已有的 project：${projectList}。你认为是否有新的 project 需要添加？ → 请添加新 project 的记忆。`,
    '2. 你是否记错、说错、想错了什么、是否被用户纠正过？',
    '- 被用户纠正的一定要记，加入你认为合适的记忆层级（如project，rule，fact等）。',
    '- 如果是写入 lesson层级，需保留 corrected 标记；',
    '3. 如存在以下情况，你可以酌情添加记忆条目：',
    '- 用户是否提出了交流/工作/代码偏好 → 全局偏好记录进user；项目特定偏好进 project。',
    '- 用户是否提出了某些设计原则/行为准则？ → 记录进rules。',
    '- 有没有用户介绍项目设计思路、框架、决策理由时说的话？ → 保留用户原话，记录进正确的层级。',
    '- 有没有重要的事实、结论或决定？',
    '- 你是否在完成任务的过程中踩过坑，有没有多次尝试才成功的时候？如果你认为值得记录，可作为lesson记录。',
    '',
    '【二】回看上下文中注入的所有记忆，结合你的最新进展，请你判断，是否有需要更新的记忆？',
    '1. 是否有哪条记忆，你现在非常确定它的信息已经过时了（比如由用户亲口否定或改变主意）？ → 你应该及时更新它的内容，不要放着不管。',
    '2. 你是否发现有哪条记忆信息是错的，甚至误导了你？ → 更新为正确信息，或者标 archived（视为 delete）；',
    '3. 是否有哪些todo或topic已被完成？ → 标 stale（视为 done）；',
    '4. 你是否发现有那条记忆注入时机非常不合理，和当前任务一点关系也没有？→ 这是因为关键词不准，更新它的关键词；',
    '',
    '【三】写记忆时的通用要求',
    '1. 写记忆的规则见系统提示词。你应该把记忆归类在正确的level和标签之下。',
    '2. 强调一下关键词拟定标准:',
    '- 提取 8-13 个关键词供检索',
    '- 反向思考："在用户prompt提及哪些词的时候，你希望这条记忆能被检索到？"',
    '- 非项目名，针对记忆本身的细节。',
    '- 优先提取核心实体、语义中心、专有名词。',
    '3. 如果你认为没有什么重要信息，不需要添加和更新记忆，直接回复"无需记忆"即可，不要调用任何工具。',
  ].join('\n')
}

export function buildReflectMessage(workspace: string, turnText: string, dir = '.dsh-meow'): ReturnType<typeof createUserMessage> {
  const db = getDb(workspace, dir)
  const text = `${REFLECT_MARKER} ${buildBasePrompt(db.listProjectNames())}`
  return createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE })
}

export { PLUGIN_SOURCE }
