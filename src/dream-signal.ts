/**
 * meow-memory — dream 状态信号（host 端）。
 *
 * 会话列表"已 dream"小月牙图标的数据面（用户拍板 2026-08-19）：
 * - 全量快照：GET /meow-memory/dreamed-sessions → { sessionIds, dreamingIds }
 *   （client 挂载/重连时拉一次）；
 * - 增量信号：/meow-memory/dream-events 是 SSE 长连接，dream 开始推 dreaming、
 *   dream 完成推 dreamed、会话有新活动推 active——事件驱动，无轮询。
 *
 * 判定：
 * - dreaming = windows 表存在活跃租约（dream_progress_at 在 DREAM_LEASE_MS 内）；
 * - dreamed = last_dream_time 非空 且 (last_event_time ?? 0) <= last_dream_time
 *   （dream 轮不刷新 last_event_time，dream 之后无新活动即成立）且无活跃租约。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { getDb, memoryDbPath } from './db.js'
import { DREAM_LEASE_MS } from './dream.js'

/** 会话持久层的最小视图（sessionPersistence.list() 的 SessionHeader 子集）。 */
export interface PersistedSessionMeta {
  id: string
  cwd?: string
}

/** 一个会话的 dream 状态：'dreamed'=整理完成且无新活动；'dreaming'=dream 轮进行中。 */
export type DreamState = 'dreamed' | 'dreaming'

/**
 * 收集全部会话的 dream 状态（全量快照用）。
 * 按 cwd 去重打开记忆库；某工作区没有记忆库（.dsh-meow/memory.db 不存在）直接跳过，
 * 绝不新建空库；单个工作区库损坏只跳过该工作区，不抛。
 * @param sessions - 全部会话（sessionPersistence.list() 结果）。
 * @param dir - 记忆库目录名（默认 .dsh-meow）。
 * @returns { dreamed, dreaming } 两个会话 id 数组（可能包含传入列表之外的 id——
 *   windows 表记录过该工作区所有会话；client 按行实际 id 比对，多余的自动忽略）。
 */
export function collectDreamStates(sessions: ReadonlyArray<PersistedSessionMeta>, dir = '.dsh-meow'): { dreamed: string[]; dreaming: string[] } {
  const dreamed: string[] = []
  const dreaming: string[] = []
  const opened = new Set<string>()
  for (const s of sessions) {
    if (typeof s.cwd !== 'string' || s.cwd.length === 0 || opened.has(s.cwd)) continue
    opened.add(s.cwd)
    if (!existsSync(memoryDbPath(s.cwd, dir))) continue
    try {
      const db = getDb(s.cwd, dir)
      for (const w of db.listWindows()) {
        const lease = db.getDreamLease(w.session_id)
        if (lease !== null && Date.now() - lease.progress_at <= DREAM_LEASE_MS) {
          dreaming.push(w.session_id) // 活跃租约：dream 进行中（优先于 dreamed）
        } else if (w.last_dream_time !== null && (w.last_event_time ?? 0) <= w.last_dream_time) {
          dreamed.push(w.session_id)
        }
      }
    } catch {
      // 单工作区记忆库损坏：跳过该工作区，不炸路由（图标功能静默降级）。
    }
  }
  return { dreamed, dreaming }
}

/**
 * SSE 广播器：持有当前连接集合，向所有连接广播 dream 状态变化。
 * 同一 GUI 的多个标签页/设备各持一条连接，全部收到。
 */
export class DreamStateBroadcast {
  private readonly clients = new Set<ServerResponse>()

  /**
   * SSE 连接入口（路由 handler）：应答 200 text/event-stream 并挂起连接。
   * 连接关闭（客户端断开/服务端 res.end）时自动从集合移除。
   */
  handle(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    const drop = (): void => { this.clients.delete(res) }
    res.on('close', drop)
  }

  /**
   * 广播一个状态变化事件：'dreamed'=整理完成加月亮、'dreaming'=dream 开始呼吸灯、
   * 'active'=有新活动去月亮（client 端幂等忽略无变化）。
   */
  broadcast(sessionId: string, state: 'dreamed' | 'dreaming' | 'active'): void {
    const data = JSON.stringify({ sessionId, state })
    for (const res of this.clients) {
      try {
        res.write(`event: dream\nid: ${Date.now()}\ndata: ${data}\n\n`)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  /** 关闭全部连接（插件卸载时调用）。 */
  dispose(): void {
    for (const res of this.clients) {
      try { res.end() } catch { /* 连接已死 */ }
    }
    this.clients.clear()
  }
}
