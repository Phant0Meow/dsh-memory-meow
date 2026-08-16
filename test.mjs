/**
 * meow-memory v2 测试（无 LLM、无 harness）。
 * 部分 1：模块级（db / migrate / inject / reflect / bm25）。
 * 部分 2：apply 级（mock ctx：工具注册、pre-step 注入、turn-stopping 反思、disabled）。
 * 用法：node test.mjs（先 build）
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  MemoryDb,
  memoryDbPath,
  closeAllDbs,
  migrateLegacy,
  buildInjection,
  buildReflectMessage,
  newId,
  groupWindowMemories,
  buildDreamMessage,
  windowNeedsDream,
  findSimilar,
  markSearched,
  readSeen,
  hourInTimeZone,
} from './lib/index.js'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

// ═══════════════════════ 部分 1：模块级 ═══════════════════════

const ws = mkdtempSync(join(tmpdir(), 'mm-test-'))
const db = new MemoryDb(memoryDbPath(ws))

// db CRUD
const s1 = db.insert({ level: 'soul', content: '我是用户的长期协作伙伴，重事实轻客套。', importance: 3 })
check('soul insert uuid', s1.id.length === 36)
db.insert({ level: 'user', content: '用户偏好中文交流，先备份再改代码。' })
db.insert({ level: 'project', content: 'femGen 集成 dsh 插件的设计定稿', project: 'femwa', title: 'femGen 集成' })
db.insert({ level: 'fact', content: 'Node v22 自带 node:sqlite 可用', project: 'dsh' })
db.insert({ level: 'lesson', content: '每轮注入没意义，模型能看见上下文', corrected: 1 })
db.insert({ level: 'topic', content: '【起因】重构记忆插件【经过】设计讨论【结果】未定', title: 'meow-memory 重构', goal: '让记忆插件 v2 上线' })
check('six levels insert', db.count('soul') === 1 && db.count('user') === 1 && db.count('project') === 1 &&
  db.count('fact') === 1 && db.count('lesson') === 1 && db.count('topic') === 1)
const found = db.findById(s1.id)
check('findById cross-table', found?.level === 'soul' && found.row.content.includes('长期协作'))
check('lesson corrected flag', db.list('lesson')[0].corrected === 1)
check('topic goal stored', db.list('topic')[0].goal === '让记忆插件 v2 上线')
check('project name stored', db.list('project')[0].project === 'femwa')
check('update status', db.update('topic', db.list('topic')[0].id, { status: 'stale' }) &&
  db.list('topic', { status: 'stale' }).length === 1)
check('findById miss', db.findById('nope') === undefined)
const byPrefix = db.findById(s1.id.slice(0, 8))
check('findById prefix match', byPrefix?.level === 'soul' && byPrefix.row.id === s1.id)
const topicId = db.list('topic')[0].id
check('update by prefix', db.update('topic', topicId.slice(0, 8), { status: 'active' }) &&
  db.list('topic', { status: 'active' }).length === 1)

// ── dream v2 数据层：时间前缀 id / 新列 / status 检索语义 / windows ────────
check('newId time-prefixed', /^[0-9a-z]{9}-/.test(newId()) && newId().length === 36)
const early = newId(Date.now() - 1000)
const late = newId(Date.now())
check('newId order = creation order', early < late)
const p1 = db.insert({ level: 'project', content: '项目目标概述', project: 'femwa', subcategory: 'overview' })
check('subcategory stored', db.findById(p1.id)?.row.subcategory === 'overview')
check('dream_at default null', db.findById(p1.id)?.row.dream_at === null)
db.update('project', p1.id, { dream_at: 12345 })
check('dream_at update', db.findById(p1.id)?.row.dream_at === 12345)
const todo = db.insert({ level: 'project', content: '待办事项', project: 'femwa', subcategory: 'todo' })
db.update('project', todo.id, { status: 'stale' })
check('todo stale NOT in active list', db.list('project', { status: 'active' }).some((r) => r.id === todo.id) === false)
check('todo stale IS searchable (done)', db.listSearchable('project').some((r) => r.id === todo.id))
const factStale = db.insert({ level: 'fact', content: '过时事实', project: 'dsh' })
db.update('fact', factStale.id, { status: 'stale' })
check('non-todo stale NOT searchable', db.listSearchable('fact').some((r) => r.id === factStale.id) === false)

// 旧 UUID 升级重排
const wsUp = mkdtempSync(join(tmpdir(), 'mm-up-'))
const dbUp = new MemoryDb(memoryDbPath(wsUp))
const legacyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
dbUp.db.prepare(`INSERT INTO fact (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at, dream_at, project) VALUES (?, NULL, '旧条目', 1, '[]', 'active', NULL, 0, 1000, 1000, NULL, NULL, 'dsh')`).run(legacyId)
dbUp.close()
const dbUp2 = new MemoryDb(memoryDbPath(wsUp)) // 重新打开触发 upgrade
const upgraded = dbUp2.db.prepare('SELECT id, dream_at FROM fact').get()
check('legacy id re-ordered', upgraded.id !== legacyId && /^[0-9a-z]{9}-/.test(upgraded.id))
check('dream_at column added', 'dream_at' in upgraded)
const tcols = dbUp2.db.prepare('PRAGMA table_info(topic)').all().map((c) => c.name)
check('topic.project column added', tcols.includes('project'))
check('topic insert with project', dbUp2.insert({ level: 'topic', content: '话题', title: 't', project: 'femwa' }).project === 'femwa')
dbUp2.close()

// windows 表
const dbW = new MemoryDb(memoryDbPath(ws))
dbW.touchWindow('win-1', ws, 1000)
dbW.touchWindow('win-1', ws, 2000)
check('window touch max time', dbW.getWindow('win-1')?.last_event_time === 2000)
check('window needs dream (no dream yet)', windowNeedsDream({ last_event_time: Date.now(), last_dream_time: null }))
check('window needs dream (new chat after dream)', windowNeedsDream({ last_event_time: Date.now(), last_dream_time: Date.now() - 1000 }))
check('window no dream (dream after chat)', windowNeedsDream({ last_event_time: Date.now(), last_dream_time: Date.now() + 1000 }) === false)
check('window no dream (older than 24h)', windowNeedsDream({ last_event_time: Date.now() - 25 * 3600_000, last_dream_time: null }) === false)

// dream 分组排序
const wsD = mkdtempSync(join(tmpdir(), 'mm-dream-'))
const dbD = new MemoryDb(memoryDbPath(wsD))
const wid = 'win-dream-1'
dbD.insert({ level: 'project', content: '概述', project: 'dsh', subcategory: 'overview', source_session: wid, created_at: 100 })
dbD.insert({ level: 'lesson', content: '坑1', project: 'dsh', source_session: wid, created_at: 300 })
dbD.insert({ level: 'fact', content: '事实1', project: 'dsh', source_session: wid, created_at: 200 })
dbD.insert({ level: 'topic', content: '话题内容', title: '话题X', project: 'dsh', source_session: wid, created_at: 150 })
dbD.insert({ level: 'fact', content: '无项目事实', source_session: wid, created_at: 400 })
dbD.insert({ level: 'project', content: '其他项目条目', project: 'femwa', source_session: wid, created_at: 50 })
dbD.insert({ level: 'soul', content: '不该出现的soul', source_session: wid, created_at: 1 })
const groups = groupWindowMemories(dbD, wid)
check('dream groups: 3 (dsh, femwa, unlabeled)', groups.length === 3, `got ${groups.length}`)
check('dream groups: unlabeled last', groups[2].name === '')
const dshGroup = groups.find((g) => g.name === 'dsh')
check('dream group level order project→topic→fact→lesson', dshGroup !== undefined &&
  dshGroup.rows.map((r) => r.level).join(',') === 'project,topic,fact,lesson')
check('dream group time order within level', dshGroup !== undefined &&
  dshGroup.rows.filter((r) => r.level === 'fact').map((r) => r.content).join(',') === '事实1')
check('soul excluded from dream groups', groups.every((g) => g.rows.every((r) => r.level !== 'soul')))
const dreamMsg = buildDreamMessage(dbD, wid, 5000, groups, 0)
const dtxt = dreamMsg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
check('dream message marker', dtxt.includes('[meow-memory-dream]'))
check('dream message group title', dtxt.includes('项目「dsh」'))
check('dream message T label', dtxt.includes('1970-01-01 00:00'))
check('dream message rules', dtxt.includes('原话') && dtxt.includes('importance') && dtxt.includes('find_similar') && dtxt.includes('本组整理完成'))
dbD.close()

// ── recall 增强：find_similar / seen 排除 ───────────────────────────────────
const wsR = mkdtempSync(join(tmpdir(), 'mm-recall-'))
const dbR = new MemoryDb(memoryDbPath(wsR))
dbR.insert({ level: 'fact', content: '3081 端口是喵版 dsh 的 web 服务', project: 'dsh', source_session: 'win-a' })
dbR.insert({ level: 'fact', content: '3081 端口运行喵版 dsh web 服务', project: 'dsh', source_session: 'win-b' })
dbR.insert({ level: 'fact', content: '今天天气不错适合散步', project: 'dsh', source_session: 'win-c' })
dbR.insert({ level: 'fact', content: '本窗口自己写的事实', project: 'dsh', source_session: 'win-a' })
const sims = findSimilar('3081 端口是喵版 dsh 的 web 服务', [
  { id: 'b', level: 'fact', title: null, content: '3081 端口运行喵版 dsh web 服务', keywords: [], importance: 1, created_at: Date.now() },
  { id: 'c', level: 'fact', title: null, content: '今天天气不错适合散步', keywords: [], importance: 1, created_at: Date.now() },
], 5)
check('findSimilar ranks duplicate higher', sims.length === 1 && sims[0].id === 'b', `got ${JSON.stringify(sims)}`)
check('findSimilar similarity > 0.5 for near-duplicate', sims[0].similarity > 0.5, `got ${sims[0].similarity}`)

// seen 记录：markSearched 后 readSeen 合并 injected+searched
markSearched(wsR, 'win-a', ['seen-id-1'], '.dsh-meow')
const seenSet = readSeen(wsR, 'win-a', '.dsh-meow')
check('readSeen after markSearched', seenSet.has('seen-id-1'))
check('readSeen empty for other session', readSeen(wsR, 'win-b', '.dsh-meow').size === 0)
dbR.close()

// ── dream 时区（用户系统是美区时间，夜间窗口必须按 Asia/Shanghai 算） ───────
const midnightUtc = new Date('2026-08-15T00:00:00.000Z')
check('hourInTimeZone Shanghai at UTC midnight = 8', hourInTimeZone('Asia/Shanghai', midnightUtc) === 8)
check('hourInTimeZone UTC at UTC midnight = 0', hourInTimeZone('UTC', midnightUtc) === 0)

// migrate
const ws2 = mkdtempSync(join(tmpdir(), 'mm-mig-'))
mkdirSync(join(ws2, '.dsh-meow'), { recursive: true })
const legacy = [
  '# PROJECT.md — 项目记忆',
  '',
  '> 说明头',
  '',
  '**用户 GitHub：Phant0Meow，就是 FemWA 作者本人（jovielher@163.com）**',
  '作为长期协作伙伴，我应该重事实轻客套，先计划后动手。',
  '',
  '## 重要事实与决定 (fact)',
  '- 3081 已于 2026-08-14 重启（DSH_HOME=dsh-home）',
  '- 另一个事实',
  '',
  '## 纠错与教训 (mistake)',
  '- 被用户纠正：每轮注入没意义',
  '',
  '## 用户原话 (user_said)',
  '- "用户说：femGen 是可视化生成剧本的，重点是画图→生成剧本"',
  '',
  '## 关键细节 (detail)',
  '- dsh 子 agent API：ctx.subagents.start(spawn)',
  '',
  '## 用户偏好 (preference)',
  '- 改 dsh 原文前先备份',
].join('\n')
writeFileSync(join(ws2, '.dsh-meow', 'PROJECT.md'), legacy, 'utf8')
const db2 = new MemoryDb(memoryDbPath(ws2))
const n = migrateLegacy(db2, ws2)
check('migrate count', n === 8, `got ${n}`)
check('migrate renames file', existsSync(join(ws2, '.dsh-meow', 'PROJECT.md.imported')))
check('migrate original gone', !existsSync(join(ws2, '.dsh-meow', 'PROJECT.md')))
check('core ai line → soul', db2.list('soul').length === 1 && db2.list('soul')[0].content.includes('长期协作伙伴'))
check('core user info → user', db2.list('user').some((u) => u.content.includes('Phant0Meow')))
check('preference → user', db2.list('user').some((u) => u.content.includes('先备份')))
check('mistake → lesson corrected', db2.list('lesson').length === 1 && db2.list('lesson')[0].corrected === 1)
check('user_said → project femwa', db2.list('project').some((p) => p.project === 'femwa' && p.content.includes('femGen')))
check('detail → project dsh', db2.list('project').some((p) => p.project === 'dsh' && p.content.includes('subagents')))
check('plain fact → fact', db2.list('fact').length === 2 && db2.list('fact').some((f) => f.content.includes('3081')))
check('migrate idempotent', migrateLegacy(db2, ws2) === null)

// inject + sessions/ 去重
db2.insert({ level: 'fact', content: '3081 端口是喵版 dsh', project: 'dsh', created_at: Date.now() })
db2.insert({ level: 'soul', content: '我是用户的长期协作伙伴。', created_at: Date.now() })
const inj = buildInjection(db2, ws2, 'test-session-1', '3081 现在什么状态？', { hitTopK: 3 }, '.dsh-meow')
check('injection produced', inj !== null)
if (inj) {
  check('injection blocks', inj.text.includes('【soul 核心】') && inj.text.includes('【user 偏好】') &&
    inj.text.includes('【记忆导引】') && inj.text.includes('【相关记忆】'))
  check('injection guide lists project', inj.text.includes('project:femwa'))
  check('injection hit content', inj.text.includes('3081 端口是喵版 dsh'))
  check('injection format', inj.text.includes('=====记忆结束=====') && inj.text.includes('【本轮用户输入】：'))
  check('sessions file written', readFileSync(join(ws2, '.dsh-meow', 'sessions', 'test-session-1.json'), 'utf8').includes(inj.injectedIds[0]))
}
const inj2 = buildInjection(db2, ws2, 'test-session-1', '3081 又怎么了？', { hitTopK: 3 }, '.dsh-meow')
check('dedup same session', inj2 === null || !inj2.text.includes('3081 端口是喵版 dsh'))
const inj3 = buildInjection(db2, ws2, 'test-session-2', '3081 又怎么了？', { hitTopK: 3 }, '.dsh-meow')
check('new session gets hits', inj3 !== null && inj3.text.includes('3081 端口是喵版 dsh'))

// reflect 消息（独立库：topic 保持 active）
const ws3 = mkdtempSync(join(tmpdir(), 'mm-reflect-'))
const db3 = new MemoryDb(memoryDbPath(ws3))
db3.insert({ level: 'topic', content: '【起因】重构记忆插件【经过】设计讨论【结果】未定', title: 'meow-memory 重构', goal: '让记忆插件 v2 上线' })
const msg = buildReflectMessage(ws3, '我们讨论一下猫眼插件的模型部署', '.dsh-meow')
const txt = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
check('reflect message', txt.includes('[记忆反思]') && txt.includes('目标句') && txt.includes('宽泛名') && txt.includes('subcategory'))
check('reflect draft attached', txt.includes('相关话题底稿') && txt.includes('meow-memory 重构'))

// 空库 → 注入 null
const ws4 = mkdtempSync(join(tmpdir(), 'mm-empty-'))
const db4 = new MemoryDb(memoryDbPath(ws4))
check('no memory → null', buildInjection(db4, ws4, 'x', 'hi') === null)

// ═══════════════════════ 部分 2：apply 级 ═══════════════════════

function makeCtx() {
  const tools = []
  const handlers = {}
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: console.error },
    tools: { register: (t) => tools.push(t) },
    on: (name, fn) => { handlers[name] = fn },
    subagents: { start: () => { throw new Error('subagents not expected in tests') } },
  }
  return { ctx, tools, handlers }
}

const { ctx, tools, handlers } = makeCtx()
await apply(ctx, { enabled: true, projectDir: '.dsh-meow' })
check('six tools registered', tools.length === 6 && ['memory_remember', 'memory_search', 'memory_find_similar', 'memory_read', 'memory_update', 'memory_dream']
  .every((name) => tools.some((t) => t.name === name)), `got ${tools.map((t) => t.name).join(',')}`)

const events = {
  userMsg: (text, source = { kind: 'user' }) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source } }),
  assistantWithTool: (name) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name, arguments: '{}' }] } } }),
  assistantText: (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }),
  turnStart: () => ({ type: 'turn/start', data: {} }),
}

// pre-step 注入
const preStep = handlers['agent/pre-step']
check('pre-step registered', typeof preStep === 'function')
const agentA = { session: { header: { cwd: ws, id: 'apply-session-1' }, events: [] }, steer: () => {} }
const decisionA = await preStep(
  { agent: agentA, messages: [{ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }] }),
)
check('pre-step injects', decisionA.kind === 'enter' && decisionA.messages[0].content[0].type === 'text' &&
  decisionA.messages[0].content[0].text.includes('【soul 核心】'))
check('user text preserved', decisionA.messages[0].content[1].text === '你好')

// 同会话第二次 pre-step（Set 命中）→ 零开销放行，不再注入（回归：防重复注入膨胀上下文）
const decisionA2 = await preStep(
  { agent: agentA, messages: [{ content: [{ type: 'text', text: '第二条消息' }], source: { kind: 'user' } }], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '第二条消息' }], source: { kind: 'user' } }] }),
)
check('no re-injection on second pre-step', decisionA2.messages[0].content.length === 1 &&
  decisionA2.messages[0].content[0].text === '第二条消息')

// 已有历史 → 不注入
const agentB = { session: { header: { cwd: ws, id: 's2' }, events: [events.userMsg('之前')] }, steer: () => {} }
const decisionB = await preStep(
  { agent: agentB, messages: [{ content: [{ type: 'text', text: '再问' }], source: { kind: 'user' } }], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '再问' }], source: { kind: 'user' } }] }),
)
check('no injection with history', decisionB.messages[0].content.length === 1)

// 子代理（有 parentSession）→ 不注入
const agentC = { session: { header: { cwd: ws, id: 's3', parentSession: 'x' }, events: [] }, steer: () => {} }
const decisionC = await preStep(
  { agent: agentC, messages: [{ content: [{ type: 'text', text: '嗨' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '嗨' }], source: { kind: 'user' } }] }),
)
check('no injection for subagent', decisionC.messages[0].content.length === 1)

// turn-stopping 反思（连续工具轮 ≥7 才触发）
const stopping = handlers['agent/turn-stopping']
check('turn-stopping registered', typeof stopping === 'function')

// 构造 7 个连续工具轮
const sevenToolTurns = []
for (let t = 1; t <= 7; t++) {
  sevenToolTurns.push(events.turnStart(), events.userMsg(`干活${t}`), events.assistantWithTool('bash'), events.assistantText(`完成${t}`))
}
const steered = []
const agentD = { session: { header: { cwd: ws, id: 's4' }, events: sevenToolTurns }, steer: (m) => steered.push(m) }
stopping({ agent: agentD, turn: 7, signal: new AbortController().signal })
check('steer after 7 consecutive tool turns', steered.length === 1 && steered[0].content.some((b) => b.type === 'text' && b.text.includes('记忆反思')))

// 单轮工具调用 → 不触发
const steered1 = []
const agentD1 = { session: { header: { cwd: ws, id: 's4b' }, events: [events.turnStart(), events.userMsg('干活'), events.assistantWithTool('bash'), events.assistantText('完成')] }, steer: (m) => steered1.push(m) }
stopping({ agent: agentD1, turn: 1, signal: new AbortController().signal })
check('no steer on single tool turn', steered1.length === 0)

// 6 轮 → 不触发；7 轮含 memory_ 标记 → 重新计数
const sixToolTurns = []
for (let t = 1; t <= 6; t++) {
  sixToolTurns.push(events.turnStart(), events.userMsg(`干活${t}`), events.assistantWithTool('bash'), events.assistantText(`完成${t}`))
}
const steered6 = []
const agentD6 = { session: { header: { cwd: ws, id: 's4c' }, events: sixToolTurns }, steer: (m) => steered6.push(m) }
stopping({ agent: agentD6, turn: 6, signal: new AbortController().signal })
check('no steer on 6 tool turns', steered6.length === 0)

// consecutiveToolTurns 单元测试
const { consecutiveToolTurns } = await import('./lib/index.js')
check('consecutiveToolTurns counts 7', consecutiveToolTurns(sevenToolTurns) === 7)
check('consecutiveToolTurns counts 1', consecutiveToolTurns([events.turnStart(), events.userMsg('x'), events.assistantWithTool('bash')]) === 1)
check('consecutiveToolTurns stops at chat turn', consecutiveToolTurns([
  ...sixToolTurns,
  events.turnStart(), events.userMsg('闲聊'), events.assistantText('嗯'),
  events.turnStart(), events.userMsg('再干'), events.assistantWithTool('bash'),
]) === 1)
check('consecutiveToolTurns resets at memory_ tool', consecutiveToolTurns([
  ...sixToolTurns,
  events.turnStart(), events.userMsg('记住'), events.assistantWithTool('memory_remember'),
  events.turnStart(), events.userMsg('再干'), events.assistantWithTool('bash'),
]) === 1)

const steered2 = []
const agentE = { session: { header: { cwd: ws, id: 's5' }, events: [events.turnStart(), events.userMsg('你好'), events.assistantText('你好呀')] }, steer: (m) => steered2.push(m) }
stopping({ agent: agentE, turn: 1, signal: new AbortController().signal })
check('no steer on chat turn', steered2.length === 0)

const steered3 = []
const agentF = { session: { header: { cwd: ws, id: 's6' }, events: [events.turnStart(), events.userMsg('记住'), events.assistantWithTool('memory_remember')] }, steer: (m) => steered3.push(m) }
stopping({ agent: agentF, turn: 1, signal: new AbortController().signal })
check('no steer after memory_ tool', steered3.length === 0)

// disabled
const { ctx: ctxOff, tools: toolsOff, handlers: handlersOff } = makeCtx()
await apply(ctxOff, { enabled: false })
check('disabled registers nothing', toolsOff.length === 0 && Object.keys(handlersOff).length === 0)

db.close(); db2.close(); db3.close(); db4.close()
dbW.close()
closeAllDbs()
rmSync(ws, { recursive: true, force: true })
rmSync(ws2, { recursive: true, force: true })
rmSync(ws3, { recursive: true, force: true })
rmSync(ws4, { recursive: true, force: true })
rmSync(wsUp, { recursive: true, force: true })
rmSync(wsD, { recursive: true, force: true })
rmSync(wsR, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
