/**
 * meow-memory — 反思轮折叠：纯计算逻辑（与 DOM 无关，可单测）。
 *
 * 识别：会话快照 chat 节点里 kind='context' 且 source 为
 * { kind: 'plugin', plugin: 'meow-memory' } 的节点 = 反思/dream 轮 prompt
 * （steer 注入的 user/message 事件，非 append 改写，渲染为 context 行）。
 * 范围：该 prompt 所在 turn 内、位于 prompt 之后的全部节点（排除 user/steering，
 * 防止误折叠反思期间用户插入的消息），用快照的 locations.getTurn(turn) 获取。
 * 计数：范围内 kind='tool' 节点中 memory_remember / memory_update 的调用次数。
 * 状态：范围内有 running assistant → 进行中；interrupted → 已中断；否则已完成。
 */

import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AssistantChatData,
  ChatNode,
  ToolChatData,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 反思轮识别标记（与 host 端 reflect.ts / dream.ts 保持一致）。 */
export const REFLECT_MARKER = '[meow-memory-reflect]'
export const DREAM_MARKER = '[meow-memory-dream]'

/** 插件 source 识别（与 host 端 PLUGIN_SOURCE 保持一致）。 */
export const PLUGIN_NAME = 'meow-memory'

export type FoldVariant = 'reflect' | 'dream'

export type FoldStatus = 'running' | 'done' | 'interrupted'

/** 一个可折叠的反思/dream 轮。 */
export interface FoldGroup {
  /** 起点 context 节点的 key（快照 chat 节点 key，全局唯一）。 */
  readonly id: string
  readonly variant: FoldVariant
  /** 折叠的节点 keys（按渲染顺序；不含 user/steering）。 */
  readonly keys: readonly string[]
  /** memory_remember 调用次数（"新增记忆 N 条"）。 */
  readonly rememberCount: number
  /** memory_update 调用次数。 */
  readonly updateCount: number
  readonly status: FoldStatus
}

interface ContextLike {
  readonly source?: unknown
  readonly content?: readonly { type?: string; text?: string }[]
}

/** 从节点 location 提取 turn 号（unresolved/session 定位无法确定时返回 undefined）。 */
function turnOf(node: ChatNode): number | undefined {
  const location = node.location
  if (location.kind === 'turn') return location.turn.turn
  if (location.kind === 'step') return location.turn.turn
  return undefined
}

/** 判定节点是否 meow-memory 注入的反思/dream prompt。 */
function isMemoryPrompt(node: ChatNode): boolean {
  if (node.kind !== 'context') return false
  const source = (node.data as ContextLike).source as { kind?: string; plugin?: string } | undefined
  return source?.kind === 'plugin' && source.plugin === PLUGIN_NAME
}

/** 从 prompt 文本判定轮次类型（reflect / dream）。 */
function variantOf(node: ChatNode): FoldVariant {
  const text = ((node.data as ContextLike).content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
  return text.includes(DREAM_MARKER) ? 'dream' : 'reflect'
}

/** 统计一个工具节点的调用名（memory_remember / memory_update）。
 *  注意：工具节点的渲染 kind 是 'tool-call'（ui-conversation 的 toolDefinition
 *  以 chatNode(context, 'tool-call', ...) 发布），不是 'tool'。 */
function toolNameOf(node: ChatNode): string | undefined {
  if (node.kind !== 'tool-call') return undefined
  const root = (node.data as ToolChatData).root
  if (root === undefined) return undefined
  if ('name' in root) return root.name // RunningToolCall
  return root.call?.name // ToolResultNode（窗口截断时 call 可能为 null）
}

/**
 * 从会话快照计算全部可折叠组。
 * @param snapshot - 会话快照（dock 组件收到的 point-in-time 快照）。
 * @returns 按渲染顺序排列的折叠组。
 */
export function computeFoldGroups(snapshot: ConversationSnapshot): FoldGroup[] {
  const order = snapshot.chat.order
  const nodes = snapshot.chat.nodes
  const groups: FoldGroup[] = []
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || !isMemoryPrompt(node)) continue
    const turn = turnOf(node)
    if (turn === undefined) continue // 定位未解析（历史窗口外）：不折叠，保持可见
    const turnKeys = snapshot.chat.locations.getTurn(turn)
    const startIdx = turnKeys.indexOf(key)
    const keys = turnKeys
      .slice(startIdx === -1 ? 0 : startIdx)
      .filter((k) => {
        const n = nodes.get(k)
        return n !== undefined && n.kind !== 'user' && n.kind !== 'steering'
      })
    let rememberCount = 0
    let updateCount = 0
    let status: FoldStatus = 'done'
    for (const k of keys) {
      const n = nodes.get(k)
      if (n === undefined) continue
      const name = toolNameOf(n)
      if (name === 'memory_remember') rememberCount++
      else if (name === 'memory_update') updateCount++
      if (n.kind === 'assistant') {
        const data = n.data as AssistantChatData
        if (data.status === 'running') status = 'running'
        else if (data.status === 'interrupted' && status !== 'running') status = 'interrupted'
      }
    }
    groups.push({ id: key, variant: variantOf(node), keys, rememberCount, updateCount, status })
  }
  return groups
}

/** 横条文案（产品 copy，中文）。 */
export function foldLabel(group: FoldGroup, expanded: boolean): string {
  const arrow = expanded ? '▾' : '▸'
  const title = group.variant === 'dream' ? '记忆整理' : '记忆反思'
  if (group.status === 'running') return `${arrow} ${title}进行中…`
  if (group.status === 'interrupted') return `${arrow} ${title}已中断`
  if (group.rememberCount > 0) return `${arrow} ${title} · 新增记忆 ${group.rememberCount} 条`
  if (group.updateCount > 0) return `${arrow} ${title} · 已更新 ${group.updateCount} 条`
  return `${arrow} ${title} · 无需记忆`
}
