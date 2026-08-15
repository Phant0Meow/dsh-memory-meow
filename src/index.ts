/**
 * meow-memory — 喵版跨会话记忆插件（host 端）。
 *
 * 设计要点：
 * 1. 记忆文件：每个工作区一份 `.dsh-meow/PROJECT.md`（纯文本、人可读可编辑）。
 * 2. 注入：新会话的第一条用户消息开头附带完整的 PROJECT.md 快照（不截断；
 *    作为普通对话注入，不动 system prompt，不破坏前缀缓存；会话内快照不变，
 *    之后的记忆更新不影响历史）。
 * 3. 工具：`memory_remember` — 模型可随时主动把值得记住的信息写入 PROJECT.md。
 * 4. 自动反思：turn 结束（模型不再调用工具）时，若本 turn 干过活（调用过工具）、
 *    且最后一个工具不是 memory_ 系列、且本 turn 尚未注入过反思消息，
 *    则通过 `agent.steer()` 注入一条反思引导，让模型判断是否有值得记住的内容。
 *
 * 缓存策略：注入发生在第一条用户消息上（会话级一次性），反思消息是独立的
 * plugin 来源 user 消息——两者的文本变化都不影响 system prompt 前缀。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type MessageSource, type UserMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'meow-memory'

/** tools 是硬依赖（注册 memory_remember）；systemPrompt 刻意不动。 */
export const inject = ['tools']

export const Config = z.object({
  /** 总开关：false 时注入、反思、工具全部停用。 */
  enabled: z.boolean().default(true),
  /** 记忆目录，相对工作区。 */
  projectDir: z.string().default('.dsh-meow'),
  /** 记忆文件名。 */
  projectFile: z.string().default('PROJECT.md'),
  /** 是否在 ReAct 任务结束后自动注入反思。 */
  reflect: z.boolean().default(true),
})

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'meow-memory' }

/** 分类 → 节标题。模型选分类，插件按分类归档。 */
const CATEGORY_LABELS: Record<string, string> = {
  fact: '重要事实与决定',
  mistake: '纠错与教训',
  preference: '用户偏好',
  user_said: '用户原话',
  lesson: '经验与意外',
  detail: '关键细节',
}
const CATEGORIES = Object.keys(CATEGORY_LABELS)

/** 工具名前缀：以此开头的工具调用视为"已完成记忆写入"，不再触发反思。 */
const MEMORY_TOOL_PREFIX = 'memory_'

const FILE_HEADER = [
  '# PROJECT.md — 项目记忆',
  '',
  '> 由 meow-memory 维护（可手工编辑）。每个工作区独立一份；新会话开始时把本文件整体注入第一条用户消息，会话内不再更新。保持精简，只写值得长久记住的内容。',
  '',
].join('\n')

const sectionTitle = (category: string): string => `## ${CATEGORY_LABELS[category]} (${category})`

const REFLECT_PROMPT = [
  '[记忆反思] 刚才的任务告一段落。请花一小段思考回顾一下，判断是否有值得跨会话记住的信息。',
  '',
  '如果有以下任一情况，请调用 memory_remember 工具写入项目记忆（category 选最贴切的一个，content 写一条简洁完整的句子）：',
  '- 重要的事实、结论或决定；',
  '- 犯过的错、被用户纠正的地方（被纠正的一定要记）；',
  '- 用户对项目的概述和描述（尽量用用户原话）；',
  '- 让你意外的地方；',
  '- 多次尝试才成功的经验、踩过的坑；',
  '- 用户表达的偏好（交流风格、工作风格、代码风格、项目相关偏好）；',
  '- 花了好几轮工具调用才找到、以后还会用到的重要细节。',
  '',
  '如果没有值得记住的，直接回复"无需记忆"即可，不要调用任何工具。',
  '注意：memory_remember 调用成功后即完成，不要重复调用。',
].join('\n')

/** 反思消息的识别标记：注入时附带，检查"本 turn 是否已反思"用。 */
const REFLECT_MARKER = '[meow-memory-reflect]'

const REFLECT_MESSAGE_TEXT = `${REFLECT_MARKER}\n${REFLECT_PROMPT}`

// ── 记忆文件读写 ──────────────────────────────────────────────────────────

interface ResolvedConfig {
  enabled: boolean
  projectDir: string
  projectFile: string
  reflect: boolean
}

function resolveConfig(config: unknown): ResolvedConfig {
  const c = (config ?? {}) as Partial<ResolvedConfig>
  return {
    enabled: c.enabled ?? true,
    projectDir: c.projectDir ?? '.dsh-meow',
    projectFile: c.projectFile ?? 'PROJECT.md',
    reflect: c.reflect ?? true,
  }
}

/** 当前会话工作区里的记忆文件绝对路径；会话无 cwd 时返回 undefined。 */
function projectPath(agent: { session: { header?: { cwd?: string } } }): string | undefined {
  const cwd = agent.session.header?.cwd
  if (!cwd) return undefined
  return join(cwd, '.dsh-meow', 'PROJECT.md')
}

function readProject(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    return text.trim().length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/** 追加一条记忆到对应分类节：节存在则插在节标题后（新在前），否则文件末尾新建节。原子写。 */
function appendEntry(path: string, category: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const entry = `- ${content}\n`
  let text: string
  if (!existsSync(path)) {
    const sections = CATEGORIES.map((c) => sectionTitle(c) + (c === category ? `\n${entry}` : ''))
    text = FILE_HEADER + '\n' + sections.join('\n\n')
  } else {
    text = readFileSync(path, 'utf8') ?? ''
    const title = sectionTitle(category)
    const at = text.indexOf(title)
    if (at !== -1) {
      const insertAt = at + title.length
      text = text.slice(0, insertAt) + `\n${entry}` + text.slice(insertAt)
    } else {
      text = text.replace(/\s*$/, '') + '\n\n' + title + `\n${entry}`
    }
  }
  const tmp = path + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** 构造注入文本：分割线 + 快照说明 + 完整内容（不截断）+ 结束标记 + 用户输入分隔。 */
function buildInjection(text: string): string {
  return `\n\n---\n\n[项目记忆 PROJECT.md — 由 meow-memory 注入，本会话内保持此快照不变]\n\n${text}\n\n=====记忆文件结束=====\n\n\n【本轮用户输入】：\n\n`
}

/** 扫描最后一个 turn/start 之后的事件，判断本 turn 的工具调用与反思情况。 */
function scanTurn(events: readonly unknown[]): { sawToolCall: boolean; lastToolName?: string; sawReflect: boolean } {
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
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i] as {
      type?: string
      data?: {
        source?: { kind?: string; plugin?: string }
        message?: { content?: Array<{ type?: string; name?: string }> }
      }
    }
    if (e?.type === 'user/message') {
      const src = e.data?.source
      if (src?.kind === 'plugin' && src.plugin === 'meow-memory') sawReflect = true
    } else if (e?.type === 'assistant/message') {
      for (const block of e.data?.message?.content ?? []) {
        if (block.type === 'tool-call') {
          sawToolCall = true
          lastToolName = block.name
        }
      }
    }
  }
  return { sawToolCall, lastToolName, sawReflect }
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

export async function apply(ctx: Context, config: unknown): Promise<void> {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    ctx.logger.info('meow-memory: disabled by config')
    return
  }

  // 1) memory_remember 工具：模型主动写入项目记忆。
  const rememberTool: ToolDefinition = {
    name: 'memory_remember',
    description: [
      '把一条值得跨会话记住的信息写入当前工作区的 .dsh-meow/PROJECT.md（按分类追加）。',
      '每个工作区独立一份记忆；新会话开始时会整体注入，所以只写值得长久记住的内容。',
      'category 分类：',
      'fact=重要事实与决定；mistake=纠错与教训（被用户纠正过的一定记这里）；',
      'preference=用户偏好（交流/工作/代码风格、项目相关偏好）；user_said=用户对项目的珍贵原话；',
      'lesson=经验与意外（多次尝试才成功的经验、踩过的坑、意外发现）；detail=关键细节（花了很多轮才找到、以后还会用到的重要细节）。',
      'content 写一条简洁完整的句子（建议不超过 200 字），直接陈述事实本身。',
      '调用成功后工具会返回确认，无需重复调用本工具。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: { type: 'string', description: '要记住的内容，一条简洁完整的句子。' },
        category: {
          type: 'string',
          enum: CATEGORIES,
          default: 'fact',
          description: '记忆分类，默认 fact。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          category: { type: 'string' },
          path: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { category?: unknown; path?: unknown }
        return [{
          type: 'text' as const,
          text: `✅ 记忆更新已成功（分类 ${String(v.category ?? 'fact')}，写入 ${String(v.path ?? '')}）。无需重复调用本工具。`,
        }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<{ ok: boolean; category: string; path: string }> {
      const parsed = args as { content?: unknown; category?: unknown }
      const content = typeof parsed.content === 'string' ? parsed.content.trim() : ''
      if (content.length === 0) throw new Error('memory_remember: content 不能为空')
      const category =
        typeof parsed.category === 'string' && CATEGORIES.includes(parsed.category) ? parsed.category : 'fact'
      if (!exec.agent) throw new Error('memory_remember: 无法确定当前会话（agent 缺失）')
      const path = projectPath(exec.agent)
      if (!path) throw new Error('memory_remember: 无法确定工作区（会话无 cwd）')
      appendEntry(path, category, content)
      return { ok: true, category, path }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'write' } {
      const parsed = args as { content?: unknown }
      const preview = typeof parsed.content === 'string' ? parsed.content.slice(0, 40) : ''
      return { card: 'generic', title: `memory_remember: ${preview}`, kind: 'write' }
    },
  }
  ctx.tools.register(rememberTool)
  ctx.logger.info('meow-memory: memory_remember tool registered')

  // 2) 第一条用户消息注入 PROJECT.md 快照。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<unknown> => {
    const decision = await next()
    if (decision === undefined || decision.kind !== 'enter' || signal.aborted) return decision
    if (decision.messages.length === 0) return decision
    // 子代理不注入：它们的 prompt 由父代理提供（如 dsh-femwa 的角色上下文），
    // 注入 PROJECT.md 会污染子任务。
    if (agent.session.header.parentSession !== undefined) return decision
    // 只注入一次：会话历史里已存在任何 user/message 就不再注入。
    if (agent.session.events.some((e) => (e as { type?: string }).type === 'user/message')) return decision
    // 只对真实用户消息注入（source.kind === 'user'）。
    const first = decision.messages[0]
    if (first.source.kind !== 'user') return decision
    const path = projectPath(agent)
    if (!path) return decision
    const text = readProject(path)
    if (!text) return decision
    const injected = buildInjection(text)
    const rewritten: UserMessage[] = [
      // 记忆内容放在用户发言之前：先看到完整记忆，再看到用户本条消息。
      { ...first, content: [{ type: 'text', text: injected }, ...first.content] },
      ...decision.messages.slice(1),
    ]
    ctx.logger.info(`meow-memory: injected PROJECT.md (${text.length} chars) before first user message`)
    return { ...decision, messages: rewritten }
  })

  // 3) ReAct 任务结束后的自动反思。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!resolved.reflect) return
    if (agent.session.header.parentSession !== undefined) return // 子代理不反思
    const { sawToolCall, lastToolName, sawReflect } = scanTurn(agent.session.events)
    if (sawReflect) return // 本 turn 已反思过（含反思轮自身结束）
    if (!sawToolCall) return // 纯聊天轮，不反思
    if (lastToolName !== undefined && lastToolName.startsWith(MEMORY_TOOL_PREFIX)) return // 已主动记忆
    agent.steer(
      createUserMessage({
        content: [{ type: 'text', text: REFLECT_MESSAGE_TEXT }],
        source: PLUGIN_SOURCE,
      }),
    )
    ctx.logger.info(`meow-memory: reflect steered after turn (last tool: ${lastToolName ?? 'none'})`)
  })
}
