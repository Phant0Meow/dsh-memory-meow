/**
 * 诊断：为什么 dream 无法触发？
 * 用运行时同款 lib（lib/index.js）+ 真实库模拟 scheduleDream 判定链路。
 * 只读检查 + 末尾真实调用 startWindowDream（用假 agent，看它返回什么）。
 */
import { getDb, collectDreamRounds, windowNeedsDream, startWindowDream, hourInTimeZone } from '../lib/index.js'

function shortSessionId(sid) {
  return (sid.startsWith('session-') ? sid.slice(8) : sid).slice(0, 8)
}

const WS = 'D:\\myFiles\\dsh'
const DIR = '.dsh-meow'
const now = Date.now()
const db = getDb(WS, DIR)

console.log('now =', new Date(now).toISOString(), 'hour(Asia/Shanghai) =', hourInTimeZone('Asia/Shanghai'))

const rows = db.listWindows().filter((w) => w.workspace === WS)
console.log('\n=== 本工作区窗口（need 判定）===')
for (const w of rows) {
  const need = windowNeedsDream(w, now)
  const idleS = Math.round((now - w.last_event_time) / 1000)
  console.log(
    shortSessionId(w.session_id).padEnd(10),
    'need=', String(need).padEnd(5),
    'idle=', String(idleS).padEnd(7) + 's',
    'last_event=', new Date(w.last_event_time).toISOString(),
    'last_dream=', w.last_dream_time ? new Date(w.last_dream_time).toISOString() : 'null',
    'pending=', db.isDreamPending(w.session_id),
  )
}

const SID = 'session-5294b529-6e26-468a-a2bf-de4be042bf6f'
console.log('\n=== 5294b529 详细 ===')
const w = db.getWindow(SID)
if (w) {
  console.log('windowNeedsDream =', windowNeedsDream(w, now))
  console.log('isDreamPending =', db.isDreamPending(SID))
  console.log('idle >= 30min =', now - w.last_event_time >= 30 * 60_000)
  const rounds = collectDreamRounds(db, SID, WS, DIR)
  console.log('collectDreamRounds rounds =', rounds.length)
  for (const rd of rounds) {
    console.log('   round:', rd.kind, 'groups:', rd.groups.length)
    for (const g of rd.groups) console.log('      group:', JSON.stringify(g.name), 'rows:', g.rows.length)
  }
} else {
  console.log('getWindow 返回 undefined！')
}

// 模拟 agent（与 ctx.agents.get 返回结构类似）
const fakeAgent = {
  session: {
    header: {
      id: SID,
      cwd: WS,
    },
  },
  steer: (msg) => console.log('>>> steer 被调用！(dream 消息已发出)'),
}
console.log('\n=== 调用 startWindowDream（假 agent，会真实 claim + steer）===')
const ok = startWindowDream({}, fakeAgent, WS, DIR)
console.log('startWindowDream 返回 =', ok)
if (!ok) {
  console.log('可能原因排查:')
  console.log('  - currentDream 非空?', false)
  console.log('  - agent.session.header.id =', fakeAgent.session.header.id)
  console.log('  - rounds 数量见上')
  console.log('  - claimDream 失败? 若 rounds>0 且非并发，则 claim 应成功')
}
