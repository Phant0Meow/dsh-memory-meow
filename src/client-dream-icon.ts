/**
 * meow-memory — 会话列表 dream 小月牙图标（client 端，用户拍板 2026-08-19）。
 *
 * 目标：左侧会话列表中，dream 整理过记忆且之后无新对话新信息的会话行显示
 * 淡黄色静态小月牙；dream 轮进行中显示白→金呼吸灯月牙（替换 dsh 的运行中
 * 蓝色动画，避免与正常工作混淆）；有新活动则移除。图标放进 dsh 会话行的
 * 状态槽位（16×20 的 slot span）——替换其内容，不新增元素，标题零位移。
 *
 * 数据（事件驱动，无轮询）：
 * - 挂载/EventSource 重连时 GET /meow-memory/dreamed-sessions 全量对账一次
 *   （{ sessionIds: 已整理, dreamingIds: 进行中 }）；
 * - /meow-memory/dream-events 是 SSE 长连接：dream 开始推 state:'dreaming'、
 *   dream 完成推 state:'dreamed'、会话有新活动推 state:'active'（去月亮）。
 *
 * 行定位（零 dsh 改动）：dsh 会话行 DOM 没有 data-id 属性，但 React 18 在每个
 * 渲染元素上挂内部 fiber 引用（__reactFiber$ 前缀属性，DevTools 同款机制，
 * React 18/19 均稳定存在）——行元素 fiber 沿 return 链向上，第一个带字符串 key
 * 的 fiber 就是 SessionNodeItem 的 fiber，其 key = 会话 id（渲染时 key={node.id}）。
 * 找不到 fiber（未来 React 改内部结构）→ 该行跳过，静默降级不报错。
 */

/** 静态淡黄月牙标记（CSS 选择器 + 幂等锚点）。 */
export const DREAM_ICON_ATTR = 'data-meow-dreamed'
/** 呼吸灯月牙标记（dream 进行中）。 */
export const DREAMING_ATTR = 'data-meow-dreaming'

/** 月牙 SVG（Lucide moon 路径，viewBox 24 缩放到 10px——矢量缩放，小尺寸也清晰）。 */
const MOON_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>'

const ICON_CSS = `[${DREAM_ICON_ATTR}],
[${DREAMING_ATTR}] {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  color: #e9c46a; /* 淡黄停驻 */
}
[${DREAM_ICON_ATTR}] { opacity: 0.9; }
[${DREAMING_ATTR}] {
  animation: meow-dream-breathe 2.4s ease-in-out infinite;
}
@keyframes meow-dream-breathe {
  0%, 100% { color: #fff8e6; opacity: 0.55; }
  50% { color: #f2c14e; opacity: 1; }
}
[data-meow-inline-icon] { margin-right: 4px; } /* 无状态槽位的 flat 视图：行首内联 */
`

/** React fiber 内部属性前缀（React 17+ 稳定约定：__reactFiber$ + 随机后缀）。 */
const FIBER_KEY_RE = /^__reactFiber\$/

/**
 * 从会话行 DOM 元素读 session id：找行元素上的 React fiber 引用，
 * 沿 return 链向上最多 8 层，取第一个带非空字符串 key 的 fiber 的 key。
 * @param row - 会话行元素（ui-workspace 的 SessionNodeItem 行）。
 * @returns 会话 id；找不到返回 null。
 */
export function readSessionId(row: HTMLElement): string | null {
  let fiber: unknown = null
  for (const key of Object.keys(row)) {
    if (FIBER_KEY_RE.test(key)) {
      fiber = (row as unknown as Record<string, unknown>)[key]
      break
    }
  }
  let cur = fiber
  for (let depth = 0; depth < 8 && cur !== null && cur !== undefined; depth++) {
    const f = cur as { key?: unknown; return?: unknown }
    if (typeof f.key === 'string' && f.key.length > 0) return f.key
    cur = f.return
  }
  return null
}

/** 会话行最小视图（可测试：真机传 DOM 行，测试传 fake 行）。 */
export interface DreamRowLike {
  querySelector(selector: string): HTMLElement | null
  insertBefore(node: HTMLElement, reference: Node | null): void
  firstChild: Node | null
}

/** 造一个月牙图标元素（状态决定标记属性）。 */
function makeIcon(state: 'dreamed' | 'dreaming'): HTMLElement {
  const icon = document.createElement('span')
  icon.setAttribute(state === 'dreaming' ? DREAMING_ATTR : DREAM_ICON_ATTR, 'true')
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = MOON_SVG
  return icon
}

/** 当前状态对应标记属性；无状态返回 null。 */
function attrForState(state: 'dreamed' | 'dreaming' | undefined): string | null {
  if (state === 'dreaming') return DREAMING_ATTR
  if (state === 'dreamed') return DREAM_ICON_ATTR
  return null
}

/**
 * 重放一轮图标：扫描全部会话行，对照状态表放置/更新/移除小月牙。
 * 幂等：状态一致时不动元素；插入/替换动作触发 MutationObserver → 防抖重扫 → 已一致跳过，
 * 无自循环（client-fold 同款模式）。
 * 位置：优先放进行的状态槽位（`[class$="_slot"]`，16×20 居中，替换槽内内容——
 * 含 dsh 的运行中/完成状态点，用户拍板"dream 图标直接替换它的位置"）；
 * 无槽位（flat 无状态视图）时退化为行首内联（占 14px，可接受）。
 * @param states - 当前状态表：session id → 'dreamed' | 'dreaming'。
 * @param rows - 会话行集合；缺省时按 dsh 会话行选择器查询（CSS Modules 类名
 *   `[hash]_[local]`，后缀匹配 local 名，dsh 升级 hash 变化仍稳定）。
 */
export function applyDreamIcons(states: ReadonlyMap<string, 'dreamed' | 'dreaming'>, rows?: Iterable<DreamRowLike>): void {
  const all = rows ?? document.querySelectorAll<HTMLElement>('div[role="treeitem"][class$="_sessionRow"]')
  for (const row of all) {
    const id = readSessionId(row as HTMLElement)
    const state = id !== null ? states.get(id) : undefined
    const wantAttr = attrForState(state)
    const slot = row.querySelector('[class$="_slot"]')
    if (slot !== null) {
      // 状态槽位：替换槽内内容（含我们的旧图标 / dsh 状态点）。
      const cur = slot.querySelector(`[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}]`)
      const consistent = cur !== null && wantAttr !== null && cur.getAttribute(wantAttr) === 'true'
      if (state !== undefined && !consistent) {
        slot.replaceChildren(makeIcon(state))
      } else if (state === undefined && cur !== null) {
        cur.remove()
      }
    } else if (state !== undefined) {
      // 无状态槽位（flat 无状态视图）：行首内联。
      const cur = row.querySelector(`[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}]`)
      const consistent = cur !== null && cur.getAttribute(wantAttr ?? '') === 'true'
      if (!consistent) {
        cur?.remove()
        const icon = makeIcon(state)
        icon.setAttribute('data-meow-inline-icon', 'true')
        row.insertBefore(icon, row.firstChild)
      }
    } else {
      row.querySelector(`[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}]`)?.remove()
    }
  }
}

/**
 * 启动会话列表 dream 图标管理器：注入常驻 CSS + 全量对账 + SSE 增量 + DOM 兜底重放。
 * @returns 清理函数（插件卸载时调用：断开连接、移除 observer 与已注入图标）。
 */
export function startDreamIconManager(): () => void {
  const states = new Map<string, 'dreamed' | 'dreaming'>()
  let timer = 0

  const replay = (): void => applyDreamIcons(states)

  /** 全量对账（挂载/重连时各一次）：拉 dreamed-sessions 快照并重放。 */
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch('/meow-memory/dreamed-sessions', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json() as { sessionIds?: unknown; dreamingIds?: unknown }
      states.clear()
      if (Array.isArray(data.sessionIds)) {
        for (const id of data.sessionIds) {
          if (typeof id === 'string') states.set(id, 'dreamed')
        }
      }
      if (Array.isArray(data.dreamingIds)) {
        for (const id of data.dreamingIds) {
          if (typeof id === 'string') states.set(id, 'dreaming')
        }
      }
      replay()
    } catch {
      // 路由不可用（webServer 缺失/旧版本）：静默降级，无图标不报错。
    }
  }

  /** SSE 增量订阅：dream 开始/完成/新活动信号。断线后 60s 重连（onopen 时全量对账）。 */
  let eventSource: EventSource | null = null
  let reconnectTimer = 0
  const connect = (): void => {
    eventSource?.close()
    eventSource = new EventSource('/meow-memory/dream-events')
    eventSource.addEventListener('dream', (raw) => {
      try {
        const data = JSON.parse((raw as MessageEvent).data) as { sessionId?: unknown; state?: unknown }
        if (typeof data.sessionId !== 'string') return
        if (data.state === 'dreamed' || data.state === 'dreaming') states.set(data.sessionId, data.state)
        else states.delete(data.sessionId) // 'active'（有新活动）或未知状态：去月亮
        replay()
      } catch {
        // 坏帧忽略
      }
    })
    eventSource.onopen = () => { void refresh() } // 首次连接/每次重连成功：全量对账补漏
    eventSource.onerror = () => {
      eventSource?.close()
      eventSource = null
      window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(connect, 60_000)
    }
  }

  // 样式常驻全局（图标由 data 属性驱动，规则在即生效；与折叠 UI 的 CSS 同策略）。
  const style = document.createElement('style')
  style.dataset.meowDreamIconCss = 'true'
  style.textContent = ICON_CSS
  document.head.appendChild(style)

  // DOM 兜底：React 重渲染/视图切换重建行时防抖重放（含 slot 内容被 React 恢复后的自愈）。
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer)
    timer = window.setTimeout(replay, 120)
  })
  observer.observe(document.body, { childList: true, subtree: true })

  connect()
  void refresh()

  return () => {
    observer.disconnect()
    window.clearTimeout(timer)
    window.clearTimeout(reconnectTimer)
    eventSource?.close()
    eventSource = null
    style.remove()
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}]`))) el.remove()
  }
}
