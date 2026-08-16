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
  MEMORY_GUIDE,
  MemoryDb,
  memoryDbPath,
  closeAllDbs,
  migrateLegacy,
  buildInjection,
  buildHitInjection,
  buildReflectMessage,
  newId,
  groupWindowMemories,
  buildDreamMessage,
  windowNeedsDream,
  findSimilar,
  markSearched,
  readSeen,
  getCurrentProject,
  setCurrentProject,
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
  db.count('fact') === 1 && db.count('lesson') === 1 && db.count('topic') === 1 && db.count('rules') === 0)
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
check('updated_at default now', db.findById(p1.id)?.row.updated_at !== null)
const beforeUp = db.findById(p1.id)?.row.updated_at ?? 0
db.update('project', p1.id, { importance: 2 })
check('update refreshes updated_at', (db.findById(p1.id)?.row.updated_at ?? 0) >= beforeUp)
const todo = db.insert({ level: 'project', content: '待办事项', project: 'femwa', subcategory: 'todo' })
db.update('project', todo.id, { status: 'stale' })
check('todo stale NOT in active list', db.list('project', { status: 'active' }).some((r) => r.id === todo.id) === false)
check('todo stale IS searchable (done)', db.listSearchable('project').some((r) => r.id === todo.id))
const factStale = db.insert({ level: 'fact', content: '过时事实', project: 'dsh' })
db.update('fact', factStale.id, { status: 'stale' })
check('non-todo stale NOT searchable', db.listSearchable('fact').some((r) => r.id === factStale.id) === false)

// 旧 UUID 升级重排 + dream_at 列迁移（并入 updated_at 后删除）
const wsUp = mkdtempSync(join(tmpdir(), 'mm-up-'))
const dbUp = new MemoryDb(memoryDbPath(wsUp))
const legacyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
dbUp.db.exec('ALTER TABLE fact ADD COLUMN dream_at INTEGER')
dbUp.db.prepare(`INSERT INTO fact (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at, dream_at, project) VALUES (?, NULL, '旧条目', 1, '[]', 'active', NULL, 0, 1000, 1000, NULL, 5000, 'dsh')`).run(legacyId)
dbUp.close()
const dbUp2 = new MemoryDb(memoryDbPath(wsUp)) // 重新打开触发 upgrade
const upgraded = dbUp2.db.prepare('SELECT id, updated_at FROM fact').get()
check('legacy id re-ordered', upgraded.id !== legacyId && /^[0-9a-z]{9}-/.test(upgraded.id))
check('dream_at merged into updated_at', upgraded.updated_at === 5000)
const dreamCols = dbUp2.db.prepare('PRAGMA table_info(fact)').all().map((c) => c.name)
check('dream_at column dropped', !dreamCols.includes('dream_at'))
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
check('dream rules require project param', dtxt.includes('project 参数'))
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

// inject + sessions/ 去重（命中检索按新语义：未锚定只搜全局；这里先锚定 dsh 模拟干活中的会话）
setCurrentProject(ws2, 'test-session-1', 'dsh', '.dsh-meow')
db2.insert({ level: 'fact', content: '3081 端口是喵版 dsh', project: 'dsh', created_at: Date.now() })
db2.insert({ level: 'soul', content: '我是用户的长期协作伙伴。', created_at: Date.now() })
// listProjectNames：四表 project 列并集（只挂 fact 的项目名也出现）
db2.insert({ level: 'fact', content: '猫眼视觉服务', project: 'meow-eyes', created_at: Date.now() })
check('project names union includes fact-only project', db2.listProjectNames().includes('meow-eyes'))
check('project names sorted', JSON.stringify(db2.listProjectNames()) === JSON.stringify(['dsh', 'femwa', 'meow-eyes']))
// 导引 topic 带 project 归属
db2.insert({ level: 'topic', content: '【起因】x【经过】y【结果】z', title: '记忆插件重构', project: 'meow-memory', created_at: Date.now() })
const inj = buildInjection(db2, ws2, 'test-session-1', '3081 现在什么状态？', { hitTopK: 3 }, '.dsh-meow')
check('injection produced', inj !== null)
if (inj) {
  check('injection blocks', inj.text.includes('===== 长期记忆 =====') && inj.text.includes('【关于user】') &&
    inj.text.includes('【记忆导引】'))
  check('injection first line flush-left', inj.text.startsWith('===== 长期记忆 ====='))
  check('injection guide three lines', inj.text.includes('需要时用 memory_search 检索、memory_read 读取。') &&
    inj.text.includes('当有项目相关任务时，应先用 memory_project 查项目全景，这样可以对项目有整体理解。') &&
    inj.text.includes('用户的所有 project：'))
  check('injection no topic/project title list', !inj.text.includes('- topic:') && !inj.text.includes('- project:'))
  check('injection format', inj.text.includes('===== 长期记忆结束 =====') && inj.text.includes('本轮用户prompt：'))
  check('injection tool name fixed', !inj.text.includes('memory_recall') && inj.text.includes('memory_search'))
  check('sessions file written', readFileSync(join(ws2, '.dsh-meow', 'sessions', 'test-session-1.json'), 'utf8').includes(inj.injectedIds[0]))
}
const inj2 = buildInjection(db2, ws2, 'test-session-1', '3081 又怎么了？', { hitTopK: 3 }, '.dsh-meow')
check('dedup same session', inj2 === null || !inj2.text.includes('3081 端口是喵版 dsh'))
// 首轮不命中（只注入长期记忆）；命中链路从第二轮起（buildHitInjection）
setCurrentProject(ws2, 'test-session-2', 'dsh', '.dsh-meow')
const inj3 = buildHitInjection(db2, ws2, 'test-session-2', '3081 又怎么了？', { hitTopK: 3 }, '.dsh-meow')
check('new session gets hits', inj3 !== null && inj3.text.includes('3081 端口是喵版 dsh'))
// reflect 消息（独立库：topic 保持 active）
const ws3 = mkdtempSync(join(tmpdir(), 'mm-reflect-'))
const db3 = new MemoryDb(memoryDbPath(ws3))
db3.insert({ level: 'topic', content: '【起因】重构记忆插件【经过】设计讨论【结果】未定', title: 'meow-memory 重构', goal: '让记忆插件 v2 上线' })
const msg = buildReflectMessage(ws3, '我们讨论一下猫眼插件的模型部署', '.dsh-meow')
const txt = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
check('reflect message', txt.includes('[记忆反思]') && txt.includes('目标句') && txt.includes('宽泛名') && txt.includes('subcategory'))
check('reflect checks outdated memories', txt.includes('信息已经过时') && txt.includes('你应该更新它'))
check('reflect requires project param', txt.includes('project 参数') && txt.includes('项目列表'))
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
check('seven tools registered', tools.length === 7 && ['memory_remember', 'memory_search', 'memory_find_similar', 'memory_read', 'memory_update', 'memory_dream', 'memory_project']
  .every((name) => tools.some((t) => t.name === name)), `got ${tools.map((t) => t.name).join(',')}`)

// 返回结果引导语：search 的 note 与 read 的渲染文本都提示可去聊天记录搜更多细节
const searchTool = tools.find((t) => t.name === 'memory_search')
const execCtx = { agent: { session: { header: { cwd: ws, id: 't-search' } } } }
const searchResult = await searchTool.execute({ query: '随便' }, execCtx)
check('search note hints chat log', searchResult.note.includes('如果你确实需要更多细节，可以直接去聊天记录里搜索相关关键词'))
const readTool = tools.find((t) => t.name === 'memory_read')
const readNotFound = readTool.output.render({}, { found: false })
check('read not-found hints chat log', readNotFound[0].text.includes('聊天记录里搜索相关关键词'))
const readFound = readTool.output.render({}, { found: true, level: 'fact', title: 't', content: 'c', status: 'active' })
check('read found hints chat log', readFound[0].text.includes('聊天记录里搜索相关关键词'))

// memory_update 支持 keywords 手动修正（AI 主动提取/纠偏）
const updateTool = tools.find((t) => t.name === 'memory_update')
const updCtx = { agent: { session: { header: { cwd: ws, id: 't-upd' } } } }
const kwId = db.insert({ level: 'fact', content: '测试关键词修正', project: 'dsh' }).id
const upRes = await updateTool.execute({ id: kwId.slice(0, 8), keywords: ['关键词甲', '关键词乙'] }, updCtx)
check('update keywords ok', upRes.ok === true)
const kwRow = db.findById(kwId)
check('update keywords applied', JSON.stringify(kwRow.row.keywords) === JSON.stringify(['关键词甲', '关键词乙']))
const upEmpty = await updateTool.execute({ id: kwId.slice(0, 8), keywords: [] }, updCtx)
check('update keywords clear', upEmpty.ok === true && JSON.stringify(db.findById(kwId).row.keywords) === '[]')
// memory_update 刷新记忆时间戳（updated_at = 最后更新时间）
const beforeTs = db.findById(kwId).row.updated_at
await new Promise((r) => setTimeout(r, 5))
const upTs = await updateTool.execute({ id: kwId.slice(0, 8), content: '测试关键词修正（时间戳刷新）' }, updCtx)
const afterTs = db.findById(kwId).row.updated_at
check('update refreshes memory timestamp', upTs.ok === true && afterTs !== null && (beforeTs === null || afterTs > beforeTs) && afterTs > Date.now() - 60_000)

// memory_remember 读回确认：返回实际存储结果（关键词/项目归属），模型知道干了什么
const rememberTool = tools.find((t) => t.name === 'memory_remember')
const remRes = await rememberTool.execute({ content: '读回确认测试关键词', level: 'fact', project: 'dsh' }, updCtx)
check('remember returns keywords', Array.isArray(remRes.keywords) && remRes.keywords.length > 0, JSON.stringify(remRes))
check('remember returns project', remRes.project === 'dsh')
check('remember render shows result', rememberTool.output.render({}, remRes)[0].text.includes('关键词：'))

// 压缩信号释放 seen：compaction 事件 → sessions 文件清空 → 记忆可再次命中
const wsSeen = mkdtempSync(join(tmpdir(), 'mm-seen-'))
const dbSeen = new MemoryDb(memoryDbPath(wsSeen))
dbSeen.insert({ level: 'fact', content: '压缩后应能重新命中的记忆', project: 'dsh', source_session: 'win-other' })
markSearched(wsSeen, 's-comp', ['fake-id-1'], '.dsh-meow')
check('seen marked before compaction', readSeen(wsSeen, 's-comp', '.dsh-meow').size === 1)
await handlers['session/event']({ id: 's-comp', header: { cwd: wsSeen } }, { type: 'compaction/summary', time: Date.now() })
check('seen released after compaction', readSeen(wsSeen, 's-comp', '.dsh-meow').size === 0)
const searchCtx2 = { agent: { session: { header: { cwd: wsSeen, id: 's-comp' } } } }
const reHit = await searchTool.execute({ query: '重新命中', project: 'dsh' }, searchCtx2)
check('search re-hits after compaction', reHit.hits.some((h) => h.content.includes('压缩后应能重新命中')))
dbSeen.close()

// memory_project：项目完整注入段落（用户拍板规格：全量/分组/排序/已完成 5 条）
const projectTool = tools.find((t) => t.name === 'memory_project')
const projCtx = { agent: { session: { header: { cwd: ws, id: 't-proj' } } } }
const t0 = Date.now()
db.insert({ level: 'project', content: 'overview 旧条目', project: 'femwa', subcategory: 'overview', updated_at: t0 })
db.insert({ level: 'project', content: 'overview 新条目', project: 'femwa', subcategory: 'overview', updated_at: t0 + 1000 })
db.insert({ level: 'project', content: '决策条目', project: 'femwa', subcategory: 'decisions' })
db.insert({ level: 'project', content: 'todo 进行中 A', project: 'femwa', subcategory: 'todo' })
db.insert({ level: 'project', content: 'todo 进行中 B', project: 'femwa', subcategory: 'todo' })
db.insert({ level: 'project', content: 'todo 无时间戳已完成', project: 'femwa', subcategory: 'todo', status: 'stale' })
for (let i = 1; i <= 7; i++) {
  db.insert({ level: 'project', content: `已完成事项 ${i}`, project: 'femwa', subcategory: 'todo', status: 'stale', updated_at: t0 + i * 1000 })
}
db.insert({ level: 'project', content: '已归档条目', project: 'femwa', subcategory: 'overview', status: 'archived' })
const pj = await projectTool.execute({ project: 'femwa' }, projCtx)
check('project 段落含项目名', pj.text.startsWith('【项目：femwa】'))
check('project 分组标题齐全', pj.text.includes('项目概述') && pj.text.includes('技术决策') && pj.text.includes('项目进度'))
check('project overview 旧→新排序', pj.text.indexOf('overview 旧条目') < pj.text.indexOf('overview 新条目'))
check('project archived 排除', !pj.text.includes('已归档条目'))
check('todo 已完成只取 updated_at 最近 5 条', pj.text.includes('已完成事项 3') && !pj.text.includes('已完成事项 1') && !pj.text.includes('已完成事项 2'))
check('todo 已完成按旧→新展示', pj.text.indexOf('已完成事项 3') < pj.text.indexOf('已完成事项 7'))
check('todo 无时间戳已完成排除', !pj.text.includes('无时间戳已完成'))
check('todo To do list 全量', pj.text.includes('todo 进行中 A') && pj.text.includes('todo 进行中 B'))
check('todo 已完成在 To do 之前', pj.text.indexOf('已完成：') < pj.text.indexOf('To do list：'))
const pjEmpty = await projectTool.execute({ project: 'nope' }, projCtx)
check('project 空项目提示', pjEmpty.text.includes('暂无记忆条目'))

// rules 层：全局高 importance 注入首轮、其余检索/项目段落
db.insert({ level: 'rules', content: '全局铁律：绝不删除文件只标 archived', project: null, importance: 2 })
db.insert({ level: 'rules', content: '全局琐碎规则走检索', project: null, importance: 1 })
db.insert({ level: 'rules', content: '项目特定规则不全局注入', project: 'femwa', importance: 2 })
db2.insert({ level: 'rules', content: '规则注入测试专用', project: null, importance: 2, created_at: Date.now() })
db2.insert({ level: 'topic', content: '【起因】规则注入测试话题【经过】x【结果】y', title: '规则注入测试话题', project: 'meow-memory', created_at: Date.now() })
const injR = buildInjection(db2, ws2, 'test-session-3', '规则注入测试', { hitTopK: 3 }, '.dsh-meow')
check('rules global high-importance injected', injR !== null && injR.text.includes('【设计原则】') && injR.text.includes('规则注入测试专用'))
check('rules low-importance not injected', injR !== null && !injR.text.includes('全局琐碎规则走检索'))
check('rules project-specific not injected globally', injR !== null && !injR.text.includes('项目特定规则不全局注入'))
// 命中链路（第二轮起）覆盖 rules/topic：低 importance rules 等关键词命中
setCurrentProject(ws2, 's-hit', 'meow-memory', '.dsh-meow')
const hitR = buildHitInjection(db2, ws2, 's-hit', '规则注入测试', { hitTopK: 3 }, '.dsh-meow')
check('keyword hit covers rules', hitR !== null && hitR.text.includes('规则注入测试专用'))
check('keyword hit covers topic', hitR !== null && hitR.text.includes('规则注入测试话题'))

// 当前 project 锚定：工具调用带 project → 状态更新；命中检索限定"全局+当前项目"
const anchorCtx = { agent: { session: { header: { cwd: ws2, id: 's-anchor' } } } }
check('no anchor before tools', getCurrentProject(ws2, 's-anchor', '.dsh-meow') === null)
const remAnc = await rememberTool.execute({ content: '锚定测试记忆', level: 'fact', project: 'femwa' }, anchorCtx)
check('remember anchors project', remAnc.ok === true && getCurrentProject(ws2, 's-anchor', '.dsh-meow') === 'femwa')
await searchTool.execute({ query: '锚定', project: 'meow-memory' }, anchorCtx)
check('search re-anchors project', getCurrentProject(ws2, 's-anchor', '.dsh-meow') === 'meow-memory')
await projectTool.execute({ project: 'dsh' }, anchorCtx)
check('memory_project anchors project', getCurrentProject(ws2, 's-anchor', '.dsh-meow') === 'dsh')
// 锚定后命中：全局 + 当前项目；未锚定只全局（命中链路）
await projectTool.execute({ project: 'femwa' }, anchorCtx)
db2.insert({ level: 'fact', content: 'femwa 专有命中词', project: 'femwa', created_at: Date.now() })
const hitAnc = buildHitInjection(db2, ws2, 's-anchor', 'femwa 专有命中词', { hitTopK: 3 }, '.dsh-meow')
check('anchored hit includes current project', hitAnc !== null && hitAnc.text.includes('femwa 专有命中词'))
const hitNoAnc = buildHitInjection(db2, ws2, 's-no-anchor', 'femwa 专有命中词', { hitTopK: 3 }, '.dsh-meow')
check('unanchored hit excludes project-only', hitNoAnc === null || !hitNoAnc.text.includes('femwa 专有命中词'))

// 命中基于 keywords 而非全文：content 含词但 keywords 不含 → 不命中（防噪音）
const noiseId = db2.insert({ level: 'fact', content: '这段话的全文里出现了测试两个字但关键词是别的', project: null }).id
db2.update('fact', noiseId, { keywords: ['别的', '无关'] })
const hitNoise = buildHitInjection(db2, ws2, 's-noise', '测试', { hitTopK: 3 }, '.dsh-meow')
check('hit uses keywords not full text', hitNoise === null || !hitNoise.text.includes('这段话的全文里出现了测试两个字'))
const hitKw = buildHitInjection(db2, ws2, 's-kw', '别的无关', { hitTopK: 3 }, '.dsh-meow')
check('hit matches keywords', hitKw !== null && hitKw.text.includes('这段话的全文里出现了测试两个字'))
// 命中打分：LLM 关键词（多字词 bigram 化）可命中；虚词不产生命中
db2.insert({ level: 'fact', content: 'LLM 关键词测试条目', project: null, keywords: ['记忆插件', '命中链路', '打分函数'] })
const hitLlm = buildHitInjection(db2, ws2, 's-llm', '记忆插件命中', { hitTopK: 3 }, '.dsh-meow')
check('hit matches llm keywords', hitLlm !== null && hitLlm.text.includes('LLM 关键词测试条目'))
const hitVoid = buildHitInjection(db2, ws2, 's-void', '好的谢谢', { hitTopK: 3 }, '.dsh-meow')
check('void words produce no hit', hitVoid === null || !hitVoid.text.includes('LLM 关键词测试条目'))
// importance 权重：3 星优先于 1 星（同关键词）
const impLow = db2.insert({ level: 'fact', content: '低重要度条目', project: null, importance: 1, keywords: ['权重对比'] }).id
const impHigh = db2.insert({ level: 'fact', content: '高重要度条目', project: null, importance: 3, keywords: ['权重对比'] }).id
const hitImp = buildHitInjection(db2, ws2, 's-imp', '权重对比', { hitTopK: 3 }, '.dsh-meow')
check('importance boosts score', hitImp !== null && hitImp.text.indexOf('高重要度条目') < hitImp.text.indexOf('低重要度条目'))
db2.update('fact', impLow, { status: 'archived' })
db2.update('fact', impHigh, { status: 'archived' })
// 覆盖率：多关键词条目靠单词碰瓷分低（被少关键词条目压过）
db2.insert({ level: 'fact', content: '单词聚焦条目', project: null, keywords: ['唯一词'] })
const hitCover = buildHitInjection(db2, ws2, 's-cover', '唯一词', { hitTopK: 3 }, '.dsh-meow')
check('coverage favors focused entry', hitCover !== null && hitCover.text.includes('单词聚焦条目') && !hitCover.text.includes('LLM 关键词测试条目'))
// 不检索本 session 建立的记忆（它们在上下文里，无需命中）
const selfId = db2.insert({ level: 'fact', content: '本窗口刚写的独有命中词', project: null, source_session: 's-self' }).id
const hitSelf = buildHitInjection(db2, ws2, 's-self', '独有命中词', { hitTopK: 3 }, '.dsh-meow')
check('hit excludes own-session memory', hitSelf === null || !hitSelf.text.includes('本窗口刚写的独有命中词'))
db2.update('fact', selfId, { status: 'archived' })
// 命中条目带记忆时间戳（updated_at 相对时间）
const datedId = db2.insert({ level: 'fact', content: '带时间戳的命中条目', project: null, updated_at: Date.now() - 2 * 86_400_000 }).id
const hitDated = buildHitInjection(db2, ws2, 's-dated', '时间戳命中', { hitTopK: 3 }, '.dsh-meow')
check('hit shows memory timestamp', hitDated !== null && hitDated.text.includes('2 天前'))
db2.update('fact', datedId, { status: 'archived' })
const searchRules = await searchTool.execute({ query: '全局铁律' }, projCtx)
check('search default scope includes rules', searchRules.hits.some((h) => h.content.includes('全局铁律')))
db.insert({ level: 'rules', content: 'femwa 设计铁律：语法错误必须报错', project: 'femwa', importance: 2 })
const pjRules = await projectTool.execute({ project: 'femwa' }, projCtx)
check('project rules injected in paragraph', pjRules.text.includes('设计原则') && pjRules.text.includes('语法错误必须报错'))

// system prompt 手册：宿主有 systemPrompt 服务 → 注册 order 130 的静态 section；无 → 静默跳过
const guideCtx = makeCtx()
const sections = []
guideCtx.ctx.get = (name) => (name === 'systemPrompt' ? { section: (s) => sections.push(s) } : undefined)
await apply(guideCtx.ctx, { enabled: true, projectDir: '.dsh-meow' })
check('guide section registered', sections.length === 1 && sections[0].name === 'meow-memory:guide' &&
  sections[0].order === 130 && sections[0].text === MEMORY_GUIDE, `got ${JSON.stringify(sections)}`)
check('guide covers all seven tools', ['memory_remember', 'memory_search', 'memory_find_similar', 'memory_read', 'memory_update', 'memory_dream', 'memory_project']
  .every((n) => MEMORY_GUIDE.includes(n)))
check('guide has no {{variable}} refs', !MEMORY_GUIDE.includes('{{'))

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
  decisionA.messages[0].content[0].text.includes('===== 长期记忆 ====='))
check('user text preserved', decisionA.messages[0].content[1].text === '你好')

// 回归（真机 2026-08-16）：首条用户消息与插件通知同批到达（messages[0].source.kind='plugin'，
// 如 user-approval 的 policy 变更通知）→ 快照必须仍注入到真实用户消息上，且命中链路不得在首轮触发。
const notifAgent = { session: { header: { cwd: ws, id: 'apply-session-notif' }, events: [] }, steer: () => {} }
const notifMsg = { content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never" (changed by the user).' }], source: { kind: 'plugin', plugin: 'user-approval' } }
const notifUserMsg = { content: [{ type: 'text', text: '首条带通知的消息' }], source: { kind: 'user' } }
const decisionNotif = await preStep(
  { agent: notifAgent, messages: [notifMsg, notifUserMsg], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [notifMsg, notifUserMsg] }),
)
check('snapshot injects into first user message despite leading plugin notice',
  decisionNotif.kind === 'enter' &&
  decisionNotif.messages[0].content.length === 1 && // 通知消息原样保留
  decisionNotif.messages[1].content[0].type === 'text' &&
  decisionNotif.messages[1].content[0].text.includes('===== 长期记忆 =====') &&
  decisionNotif.messages[1].content[0].text.includes('本轮用户prompt：') &&
  !decisionNotif.messages[1].content[0].text.includes('可能相关的记忆，仅供参考：'))

// 恢复会话（进程重启后，日志已有历史用户消息）：快照不重复注入，命中链路照跑（第 N 条消息）
const resumeAgent = { session: { header: { cwd: ws, id: 'apply-session-resume' }, events: [events.userMsg('之前')] }, steer: () => {} }
setCurrentProject(ws, 'apply-session-resume', 'dsh', '.dsh-meow')
const resumeMsg = { content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }
const decisionResume = await preStep(
  { agent: resumeAgent, messages: [resumeMsg], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [resumeMsg] }),
)
check('resumed session skips snapshot, hit chain runs', decisionResume.messages[0].content.length === 2 &&
  decisionResume.messages[0].content[0].text.includes('可能相关的记忆，仅供参考：') &&
  !decisionResume.messages[0].content[0].text.includes('===== 长期记忆 ====='))

// 同会话第二次 pre-step（Set 命中）→ 零开销放行，不再注入（回归：防重复注入膨胀上下文）
const decisionA2 = await preStep(
  { agent: agentA, messages: [{ content: [{ type: 'text', text: '第二条消息' }], source: { kind: 'user' } }], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '第二条消息' }], source: { kind: 'user' } }] }),
)
check('no re-injection on second pre-step', decisionA2.messages[0].content.length === 1 &&
  decisionA2.messages[0].content[0].text === '第二条消息')

// 命中链路（独立于首轮注入）：每条用户消息都检索命中（top-K），seen 去重
setCurrentProject(ws, 'apply-session-1', 'dsh', '.dsh-meow')
const agentA3 = { session: { header: { cwd: ws, id: 'apply-session-1' }, events: [] }, steer: () => {} }
const decisionA3 = await preStep(
  { agent: agentA3, messages: [{ content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }], turn: 3, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }] }),
)
check('per-message hit injects', decisionA3.messages[0].content.length === 2 &&
  decisionA3.messages[0].content[0].text.includes('可能相关的记忆，仅供参考：') &&
  decisionA3.messages[0].content[0].text.includes('本轮用户prompt：') &&
  decisionA3.messages[0].content[0].text.includes('测试关键词修正'))
const decisionA4 = await preStep(
  { agent: agentA3, messages: [{ content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }], turn: 4, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }] }),
)
check('seen dedup on repeated message', decisionA4.messages[0].content.length === 1)
// 工具轮（无用户消息）不触发命中
const decisionA5 = await preStep(
  { agent: agentA3, messages: [{ content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }], source: { kind: 'assistant' } }], turn: 4, step: 2, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }], source: { kind: 'assistant' } }] }),
)
check('tool step skips hit chain', decisionA5.messages.length === 1 && decisionA5.messages[0].content.length === 1)

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

// turn-stopping 反思（单任务内连续工具 step ≥7 才触发——用户拍板语义）
const stopping = handlers['agent/turn-stopping']
check('turn-stopping registered', typeof stopping === 'function')

// 单 turn 内 7 个连续工具 step → 触发
const sevenSteps = [events.turnStart(), events.userMsg('干活'), ...Array.from({ length: 7 }, () => events.assistantWithTool('bash'))]
const steered = []
const agentD = { session: { header: { cwd: ws, id: 's4' }, events: sevenSteps }, steer: (m) => steered.push(m) }
stopping({ agent: agentD, turn: 1, signal: new AbortController().signal })
check('steer after 7 consecutive tool steps', steered.length === 1 && steered[0].content.some((b) => b.type === 'text' && b.text.includes('记忆反思')))

// 单步工具调用 → 不触发
const steered1 = []
const agentD1 = { session: { header: { cwd: ws, id: 's4b' }, events: [events.turnStart(), events.userMsg('干活'), events.assistantWithTool('bash'), events.assistantText('完成')] }, steer: (m) => steered1.push(m) }
stopping({ agent: agentD1, turn: 1, signal: new AbortController().signal })
check('no steer on single tool step', steered1.length === 0)

// 6 步 → 不触发
const sixSteps = [events.turnStart(), events.userMsg('干活'), ...Array.from({ length: 6 }, () => events.assistantWithTool('bash'))]
const steered6 = []
const agentD6 = { session: { header: { cwd: ws, id: 's4c' }, events: sixSteps }, steer: (m) => steered6.push(m) }
stopping({ agent: agentD6, turn: 1, signal: new AbortController().signal })
check('no steer on 6 tool steps', steered6.length === 0)

// 跨 turn 不算：前面 turn 的工具不累计进当前 turn
const acrossTurns = [events.turnStart(), events.userMsg('干活1'), events.assistantWithTool('bash'), events.turnStart(), events.userMsg('干活2'), events.assistantWithTool('bash')]
check('consecutiveToolSteps only current turn', (await import('./lib/index.js')).consecutiveToolSteps(acrossTurns) === 1)

// consecutiveToolSteps 单元测试
const { consecutiveToolSteps } = await import('./lib/index.js')
check('consecutiveToolSteps counts 7', consecutiveToolSteps(sevenSteps) === 7)
check('consecutiveToolSteps counts 1', consecutiveToolSteps([events.turnStart(), events.userMsg('x'), events.assistantWithTool('bash')]) === 1)
check('consecutiveToolSteps chat turn = 0', consecutiveToolSteps([events.turnStart(), events.userMsg('闲聊'), events.assistantText('嗯')]) === 0)
check('consecutiveToolSteps resets at memory_ tool', consecutiveToolSteps([
  events.turnStart(), events.userMsg('干活'),
  events.assistantWithTool('bash'), events.assistantWithTool('bash'),
  events.assistantWithTool('memory_remember'),
  events.assistantWithTool('bash'), events.assistantWithTool('bash'),
]) === 2)
check('consecutiveToolSteps counts parallel calls', consecutiveToolSteps([
  events.turnStart(), events.userMsg('干活'),
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'p1', name: 'bash', arguments: '{}' }, { type: 'tool-call', id: 'p2', name: 'grep', arguments: '{}' }] } } },
]) === 2)

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
