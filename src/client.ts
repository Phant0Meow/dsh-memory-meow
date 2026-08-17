/**
 * meow-memory — 反思轮折叠 UI（client 端）。
 *
 * 目标：记忆反思/dream 轮（prompt 注入 + 后续 think/tool call/汇报）不刷屏——
 * 折叠成一条横条（默认折叠），点击横条向下展开成一个大卡片，对话记录
 * 显示在卡片里面；再点收起。原始消息流里的行始终隐藏。
 *
 * 机制（纯插件，不改 dsh 本体）：
 * - 挂 conversation.composer.dock（InputZone 提供会话快照，随快照重渲染）；
 * - computeFoldGroups 从快照识别 meow-memory 注入的 context 节点及其 turn 范围；
 * - DOM：chat 视图每个节点行有稳定 data-chat-flow-key 锚点，隐藏 + 原位插入
 *   横条锚点（细条 bar + 展开卡片 body）；展开时把原始行 cloneNode 进卡片
 *   （复用原渲染样式，克隆为静态快照，交互不复制）；
 * - MutationObserver 兜底：视图切换（chat↔trajectory）/元素重建后自动重新应用。
 *   防自循环：applyFoldState 只做幂等操作（属性写入/元素存在性），不重建、
 *   不碰卡片内容——卡片内容只在 toggle 时同步填充/清空。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputZone } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AssistantChatData, ChatNode, ToolChatData } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { blocksToText, computeFoldGroups, computeInjectionGroups, foldLabel, toolCallDetail, type FoldGroup, type InjectionGroup } from './client-fold.ts'

/** 折叠行标记（CSS 规则隐藏）。 */
const FOLDED_ATTR = 'data-meow-memory-folded'
const ANCHOR_ATTR = 'data-meow-memory-anchor'
const BODY_ATTR = 'data-meow-memory-body'
const INJ_ANCHOR_ATTR = 'data-meow-injection-anchor'
const INJ_BODY_ATTR = 'data-meow-injection-body'
const INJ_PROMPT_ATTR = 'data-meow-injection-prompt'

const FOLD_CSS = `[${FOLDED_ATTR}="true"] { display: none !important; }
[data-meow-detail-body] {
  display: none;
  margin: 2px 0 8px 22px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary, rgba(190,190,190,.9));
  background: rgba(127,127,127,.06);
  border: 1px solid rgba(127,127,127,.12);
  border-radius: 8px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, 'Courier New', monospace;
}
[data-meow-detail-body="think"] {
  font-family: inherit;
  font-style: italic;
  opacity: .9;
}
[${INJ_BODY_ATTR}] {
  display: none;
  margin: 2px 0 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary, rgba(190,190,190,.9));
  background: rgba(127,127,127,.05);
  border: 1px solid rgba(127,127,127,.12);
  border-radius: 8px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, 'Courier New', monospace;
}
[${INJ_PROMPT_ATTR}] {
  display: flex;
  justify-content: flex-end;
  margin: 2px 0 6px;
}
[${INJ_PROMPT_ATTR}] > div {
  max-width: 82%;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--dsw-alias-bubble-user-bg, rgba(127,127,127,.12));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}`

/** 卡片克隆签名缓存（groupId → 原始行文本签名）：展开时行内容更新/不完整则自愈重克隆。 */
const bodySigs = new Map<string, string>()

/** 原始行当前文本签名（全文：流式补全是尾部追加，截断会漏检）。 */
function sigOf(container: HTMLElement, keys: readonly string[]): string {
  return keys.map((key) => flowRow(container, key)?.textContent ?? '').join('\u0001')
}

/** 匹配某 key 的原始节点行（key 含特殊字符时 CSS.escape）。 */
function flowRow(container: HTMLElement, key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-chat-flow-key="${CSS.escape(key)}"]`)
}

/** 匹配某折叠组的横条锚点。 */
function anchorOf(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[${ANCHOR_ATTR}="${CSS.escape(id)}"]`)
}

/** 构建/更新一个折叠组的锚点（细条 bar + 展开卡片 body）。
 *  幂等：元素只创建一次，文本仅在变化时写入——重建/反复写文本会触发
 *  MutationObserver → 自我循环（横条被反复替换，点击必然丢失）。 */
function ensureAnchor(
  container: HTMLElement,
  group: FoldGroup,
  expanded: boolean,
  onToggle: (id: string) => void,
): void {
  let anchor = anchorOf(container, group.id)
  if (anchor === null) {
    const startRow = flowRow(container, group.id)
    if (startRow === null || startRow.parentElement === null) return
    anchor = document.createElement('div')
    anchor.setAttribute(ANCHOR_ATTR, group.id)
    startRow.parentElement.insertBefore(anchor, startRow)
  }
  let bar = anchor.querySelector<HTMLButtonElement>(':scope > button')
  if (bar === null) {
    bar = document.createElement('button')
    bar.type = 'button'
    bar.style.cssText = [
      'display:block;width:100%;margin:4px 0;padding:5px 12px;',
      'font-size:12px;line-height:1.6;text-align:left;cursor:pointer;',
      'color:var(--dsw-text-secondary, rgba(127,127,127,.9));',
      'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.14);',
      'border-radius:999px;',
    ].join('')
    bar.addEventListener('click', () => onToggle(group.id))
    anchor.appendChild(bar)
  }
  const label = foldLabel(group, expanded)
  if (bar.textContent !== label) bar.textContent = label
  let body = anchor.querySelector<HTMLElement>(`:scope > [${BODY_ATTR}]`)
  if (body === null) {
    body = document.createElement('div')
    body.setAttribute(BODY_ATTR, 'true')
    body.style.display = 'none'
    body.style.cssText = [
      'display:none;',
      'background:rgba(127,127,127,.05);',
      'border:1px solid rgba(127,127,127,.12);',
      'border-radius:12px;',
      'margin:2px 0 6px;',
      'padding:6px 10px;',
      'max-height:70vh;',
      'overflow-y:auto;',
    ].join('')
    anchor.appendChild(body)
  }
}

/**
 * 给克隆的静态行补上折叠块（Think / tool call）的展开能力。
 * 背景：dsh UI 的 DisclosureRow 展开内容（think 全文 / tool 详情）是 React 条件渲染
 * （open && children），折叠时不在 DOM 里——纯 DOM 克隆会永久丢失，且 React 事件
 * 不复制导致"点不开"。这里用快照数据把详情补进克隆 DOM，并用原生 click 切换
 * data-open + 显示/隐藏（幂等：每行只增强一次，fillBody 每次重建克隆）。
 */
function attachDisclosure(rowEl: HTMLElement, label: string, text: string): void {
  const root = rowEl.parentElement
  if (root === null) return
  if (root.querySelector(':scope > [data-meow-detail-body]') !== null) return // 已增强
  const body = document.createElement('div')
  body.setAttribute('data-meow-detail-body', label)
  body.textContent = text
  body.style.display = 'none'
  root.appendChild(body)
  rowEl.addEventListener('click', () => {
    const open = root.getAttribute('data-open') === 'true'
    root.setAttribute('data-open', open ? '' : 'true')
    body.style.display = open ? 'none' : 'block'
  })
}

/** 增强一个克隆行：按快照数据补 Think/tool/context 详情（同类块按 DOM 顺序匹配源顺序）。 */
function enhanceClone(clone: HTMLElement, node: ChatNode | undefined): void {
  if (node === undefined) return
  // 注意：assistant 节点在 ChatNodeDataMap 注册的 kind 是 'assistant-step'（dsh 源码
  // conversation-nodes/assistant.ts），不是 'assistant'——写错则 think 增强永不生效。
  if (node.kind === 'assistant-step') {
    const blocks = (node.data as AssistantChatData).blocks
    const reasoning = blocks.filter((b): b is Extract<typeof b, { kind: 'reasoning' }> => b.kind === 'reasoning')
    const toolCalls = blocks.filter((b): b is Extract<typeof b, { kind: 'tool-call' }> => b.kind === 'tool-call')
    const thinkRows = Array.from(clone.querySelectorAll<HTMLElement>('[data-variant="think"]'))
    thinkRows.forEach((root, i) => {
      const text = reasoning[i]?.text
      const rowEl = root.querySelector<HTMLElement>('[data-disclosure-row]')
      if (text !== undefined && rowEl !== null) attachDisclosure(rowEl, 'think', text)
    })
    const toolRows = Array.from(clone.querySelectorAll<HTMLElement>('[data-disclosure-row]'))
      .filter((el) => el.closest('[data-variant="think"]') === null)
    toolRows.forEach((rowEl, i) => {
      const block = toolCalls[i]
      if (block !== undefined) attachDisclosure(rowEl, 'tool', toolCallDetail(block))
    })
  } else if (node.kind === 'tool-call') {
    const root = (node.data as ToolChatData).root
    const rowEl = clone.querySelector<HTMLElement>('[data-disclosure-row]')
    if (rowEl === null) return
    const name = 'name' in root ? root.name : (root.call?.name ?? root.callId)
    const argsRaw = 'name' in root ? root.argsRaw : (root.call?.argsRaw ?? '')
    const detail = toolCallDetail({ name, argsRaw })
    const resultText = 'content' in root ? blocksToText(root.content) : ''
    attachDisclosure(rowEl, 'tool', resultText.length > 0 ? `${detail}\n\n【结果】\n${resultText}` : detail)
  } else if (node.kind === 'context') {
    // 上下文注入行（反思/dream 指令 prompt）：补完整文本可展开查看。
    const content = (node.data as { content?: readonly { type?: string; text?: string }[] }).content
    const text = blocksToText(content ?? [])
    const rowEl = clone.querySelector<HTMLElement>('[data-disclosure-row]')
    if (rowEl !== null && text.length > 0) attachDisclosure(rowEl, 'context', text)
  }
}

/** 填充/清空一个组的展开卡片（克隆原始行，静态快照；签名记录供自愈比对）。 */
function fillBody(id: string, visible: boolean, keys: readonly string[], session: ConversationSnapshot): void {
  for (const container of Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow]'))) {
    const anchor = anchorOf(container, id)
    if (anchor === null) continue
    const body = anchor.querySelector<HTMLElement>(`:scope > [${BODY_ATTR}]`)
    if (body === null) continue
    body.replaceChildren()
    if (!visible) {
      body.style.display = 'none'
      bodySigs.delete(id)
      return
    }
    body.style.display = 'block'
    for (const key of keys) {
      const row = flowRow(container, key)
      if (row === null) continue
      const clone = row.cloneNode(true) as HTMLElement
      // 克隆去掉折叠标记与流锚点：卡片内展示，且不再被当作原始行匹配。
      clone.removeAttribute(FOLDED_ATTR)
      clone.removeAttribute('data-chat-flow-key')
      clone.removeAttribute('data-chat-anchor-key')
      clone.removeAttribute('data-chat-flow-kind')
      body.appendChild(clone)
      enhanceClone(clone, session.chat.nodes.get(key))
    }
    bodySigs.set(id, sigOf(container, keys))
  }
}

/** 应用一次注入折叠（首轮长期记忆/关键词命中）：原行隐藏，原位插入
 *  「已注入记忆」横条（点开显示注入全文）+ 用户 prompt 气泡。
 *  幂等：只做元素存在性/文本写入；克隆行不重建（内容由快照确定，不变）。 */
function applyInjectionFold(
  groups: readonly InjectionGroup[],
  expanded: ReadonlySet<string>,
  onToggle: (id: string) => void,
): void {
  const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow]'))
  if (containers.length === 0) return
  const liveIds = new Set(groups.map((g) => g.id))
  for (const container of containers) {
    for (const stale of Array.from(container.querySelectorAll<HTMLElement>(`[${INJ_ANCHOR_ATTR}]`))) {
      if (!liveIds.has(stale.getAttribute(INJ_ANCHOR_ATTR) ?? '')) stale.remove()
    }
    for (const group of groups) {
      const startRow = flowRow(container, group.id)
      if (startRow === null || startRow.parentElement === null) continue
      startRow.setAttribute(FOLDED_ATTR, 'true') // 原行隐藏
      let anchor = container.querySelector<HTMLElement>(`[${INJ_ANCHOR_ATTR}="${CSS.escape(group.id)}"]`)
      if (anchor === null) {
        anchor = document.createElement('div')
        anchor.setAttribute(INJ_ANCHOR_ATTR, group.id)
        startRow.parentElement.insertBefore(anchor, startRow)
      }
      let bar = anchor.querySelector<HTMLButtonElement>(':scope > button')
      if (bar === null) {
        bar = document.createElement('button')
        bar.type = 'button'
        // 右对齐 + 与用户气泡同宽（max-width 82%）——横条视觉归属用户消息。
        bar.style.cssText = [
          'display:block;margin:4px 0 4px auto;max-width:82%;padding:5px 12px;',
          'font-size:12px;line-height:1.6;text-align:left;cursor:pointer;',
          'color:var(--dsw-text-secondary, rgba(127,127,127,.9));',
          'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.14);',
          'border-radius:999px;',
        ].join('')
        bar.addEventListener('click', () => onToggle(group.id))
        anchor.appendChild(bar)
      }
      const kindLabel = group.kind === 'first' ? '（长期记忆）' : '（关键词命中）'
      const label = `${expanded.has(group.id) ? '▾' : '▸'} 已注入记忆${kindLabel}`
      if (bar.textContent !== label) bar.textContent = label
      let body = anchor.querySelector<HTMLElement>(`:scope > [${INJ_BODY_ATTR}]`)
      if (body === null) {
        body = document.createElement('div')
        body.setAttribute(INJ_BODY_ATTR, 'true')
        anchor.appendChild(body)
      }
      if (expanded.has(group.id)) {
        if (body.textContent !== group.injectedText) body.textContent = group.injectedText
        body.style.display = 'block'
      } else {
        body.style.display = 'none'
      }
      // 用户 prompt 气泡（纯文本；带附件的消息不折叠——computeInjectionGroups 已过滤）
      let prompt = anchor.querySelector<HTMLElement>(`:scope > [${INJ_PROMPT_ATTR}]`)
      if (prompt === null) {
        prompt = document.createElement('div')
        prompt.setAttribute(INJ_PROMPT_ATTR, 'true')
        const bubble = document.createElement('div')
        prompt.appendChild(bubble)
        anchor.appendChild(prompt)
      }
      const bubble = prompt.firstElementChild as HTMLElement | null
      if (bubble !== null && bubble.textContent !== group.userText) bubble.textContent = group.userText
    }
  }
}

/** 应用一次折叠状态（幂等；对每个 chat 流容器独立处理）。
 *  只做：行隐藏 + 锚点/细条存在性与文本——不重建；展开组的卡片在
 *  原始行内容变化（流式补全/产物到达/视图重建）时按签名自愈重克隆。 */
function applyFoldState(
  groups: readonly FoldGroup[],
  expanded: ReadonlySet<string>,
  onToggle: (id: string) => void,
  session: ConversationSnapshot,
): void {
  const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow]'))
  if (containers.length === 0) return
  const liveIds = new Set(groups.map((group) => group.id))
  for (const container of containers) {
    // 清理已不存在的组的锚点。
    for (const stale of Array.from(container.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}]`))) {
      if (!liveIds.has(stale.getAttribute(ANCHOR_ATTR) ?? '')) stale.remove()
    }
    for (const group of groups) {
      // 原始行始终隐藏（对话记录只在展开卡片里展示）。
      for (const key of group.keys) {
        const row = flowRow(container, key)
        if (row === null) continue
        row.setAttribute(FOLDED_ATTR, 'true')
      }
      ensureAnchor(container, group, expanded.has(group.id), onToggle)
      if (expanded.has(group.id)) {
        // 自愈：克隆快照落后于原始行（点击时行未完整/之后被更新）→ 重克隆收敛。
        const sig = sigOf(container, group.keys)
        if (bodySigs.get(group.id) !== sig) fillBody(group.id, true, group.keys, session)
      } else {
        bodySigs.delete(group.id)
      }
    }
  }
}

/**
 * 隐形 dock 条目：不渲染可见 UI（横条直接进消息流 DOM），只随快照驱动折叠。
 */
export function MemoryFoldDock({ session }: InputZone): null {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [injExpanded, setInjExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => computeFoldGroups(session), [session])
  const injGroups = useMemo(() => computeInjectionGroups(session), [session])
  const toggle = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      const willExpand = !next.has(id)
      if (willExpand) next.add(id)
      else next.delete(id)
      // 同步填充/清空展开卡片（不依赖 effect 时序，也避免 observer 循环）。
      const group = groups.find((candidate) => candidate.id === id)
      fillBody(id, willExpand, group?.keys ?? [], session)
      return next
    })
  }, [groups, session])
  const toggleInj = useCallback((id: string): void => {
    setInjExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 快照/展开态变化 → 重放折叠（行隐藏 + 锚点，不改卡片内容）。
  useLayoutEffect(() => {
    applyFoldState(groups, expanded, toggle, session)
    applyInjectionFold(injGroups, injExpanded, toggleInj)
  }, [groups, expanded, toggle, session, injGroups, injExpanded, toggleInj])

  // 兜底：视图切换/元素重建/流式重渲染导致 DOM 变化时自愈（防抖）。
  const latest = useRef({ groups, expanded, toggle, session, injGroups, injExpanded, toggleInj })
  latest.current = { groups, expanded, toggle, session, injGroups, injExpanded, toggleInj }
  useEffect(() => {
    let timer = 0
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        applyFoldState(latest.current.groups, latest.current.expanded, latest.current.toggle, latest.current.session)
        applyInjectionFold(latest.current.injGroups, latest.current.injExpanded, latest.current.toggleInj)
      }, 80)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  return null
}

/**
 * 浏览器端插件体：注入折叠 CSS（常驻，防多会话/卸载时折叠失效），
 * 并注册 composer.dock 隐形条目驱动折叠。
 * @param ctx - client 根上下文（slots 服务）。
 */
export const inject = ['slots']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  // CSS 常驻全局（不随组件卸载移除：折叠行的隐藏由 data 属性驱动，规则在即生效）。
  const style = document.createElement('style')
  style.dataset.meowMemoryCss = 'true'
  style.textContent = FOLD_CSS
  document.head.appendChild(style)
  const slots = ctx?.slots
  if (slots === undefined || typeof slots.inject !== 'function') {
    console.warn('[meow-memory] slots service unavailable; reflection folding disabled')
    return
  }
  slots.inject('conversation.composer.dock', () => slots.register(
    {
      name: 'conversation.composer.dock',
      id: 'meow-memory',
      order: 90,
    },
    MemoryFoldDock,
  ))
}
