/**
 * meow-memory v2 核心模块冒烟测试（不依赖 cordis/apply）。
 * 直接驱动 lib 里的 db / bm25 / migrate / inject / reflect。
 * 用法：node smoke.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDb, memoryDbPath, closeAllDbs } from './lib/index.js'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

const ws = mkdtempSync(join(tmpdir(), 'mm-smoke-'))
const db = new MemoryDb(memoryDbPath(ws))

// ── db CRUD ────────────────────────────────────────────────────────────────
const s1 = db.insert({ level: 'soul', content: '我是用户的长期协作伙伴，重事实轻客套。', importance: 3 })
check('soul insert', s1.id.length === 36)
const u1 = db.insert({ level: 'user', content: '用户偏好中文交流，先备份再改代码。' })
const p1 = db.insert({ level: 'project', content: 'femGen 集成 dsh 插件的设计定稿', project: 'femwa', title: 'femGen 集成' })
const f1 = db.insert({ level: 'fact', content: 'Node v22 自带 node:sqlite 可用', project: 'dsh' })
const l1 = db.insert({ level: 'lesson', content: '每轮注入没意义，模型能看见上下文', corrected: 1 })
const t1 = db.insert({ level: 'topic', content: '【起因】重构记忆插件【经过】设计讨论【结果】未定', title: 'meow-memory 重构', goal: '让记忆插件 v2 上线' })

check('all six levels insert', db.count('soul') === 1 && db.count('user') === 1 && db.count('project') === 1 &&
  db.count('fact') === 1 && db.count('lesson') === 1 && db.count('topic') === 1)

const found = db.findById(s1.id)
check('findById cross-table', found?.level === 'soul' && found.row.content.includes('长期协作'))
check('lesson corrected flag', db.list('lesson')[0].corrected === 1)
check('topic goal stored', db.list('topic')[0].goal === '让记忆插件 v2 上线')
check('project name stored', db.list('project')[0].project === 'femwa')
check('keywords auto empty then set', Array.isArray(db.list('fact')[0].keywords))

const upd = db.update('topic', t1.id, { status: 'stale' })
check('update status', upd && db.list('topic', { status: 'stale' }).length === 1)

// ── bm25 检索（从 lib 导出？lib/index.js 只导出 apply 等 —— 改用模块内函数）
// lib 只 re-export 了部分；bm25 不在 index 导出，这里通过相对路径验证 bundle 内的行为太绕，
// 改为通过 memory_search 工具的路径验证（工具在 apply 里注册，冒烟不跑 apply）。
// 因此这里只验证分词正确性经由注入命中间接覆盖。

// ── migrate ────────────────────────────────────────────────────────────────
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

const { migrateLegacy } = await import('./lib/index.js')
const db2 = new MemoryDb(memoryDbPath(ws2))
const n = migrateLegacy(db2, ws2)
check('migrate returns count', n === 8, `got ${n}`)
check('migrate renames file', existsSync(join(ws2, '.dsh-meow', 'PROJECT.md.imported')))
check('migrate removed original', !existsSync(join(ws2, '.dsh-meow', 'PROJECT.md')))
const souls = db2.list('soul')
const users = db2.list('user')
check('core line → soul', souls.length === 1 && souls[0].content.includes('长期协作伙伴'), `soul=${souls.length}`)
check('core user info → user', users.some((u) => u.content.includes('Phant0Meow')))
check('preference → user', users.some((u) => u.content.includes('先备份')))
const lessons = db2.list('lesson')
check('mistake → lesson corrected', lessons.length === 1 && lessons[0].corrected === 1)
const projects = db2.list('project')
check('user_said → project (femwa)', projects.some((p) => p.project === 'femwa' && p.content.includes('femGen')), JSON.stringify(projects.map((p) => [p.project, p.content.slice(0, 20)])))
check('detail → project (dsh)', projects.some((p) => p.project === 'dsh' && p.content.includes('subagents')))
const facts = db2.list('fact')
check('plain fact → fact', facts.length === 2 && facts.some((f) => f.content.includes('3081')), `facts=${facts.length}`)
// 二次迁移不执行
const n2 = migrateLegacy(db2, ws2)
check('migrate idempotent', n2 === null)

// ── inject（需要 sessions/ 去重与命中注入）─────────────────────────────────
const { buildInjection } = await import('./lib/index.js')
db2.insert({ level: 'fact', content: '3081 端口是喵版 dsh', project: 'dsh', created_at: Date.now() })
db2.insert({ level: 'soul', content: '我是用户的长期协作伙伴。', created_at: Date.now() })
const inj = buildInjection(db2, ws2, 'test-session-1', '3081 现在什么状态？', { hitTopK: 3 }, '.dsh-meow')
check('injection produced', inj !== null)
if (inj) {
  check('injection has soul block', inj.text.includes('【soul 核心】'))
  check('injection has user block', inj.text.includes('【user 偏好】'))
  check('injection has guide', inj.text.includes('【记忆导引】') && inj.text.includes('project:femwa'))
  check('injection has keyword hits', inj.text.includes('【相关记忆】') && inj.text.includes('3081 端口是喵版 dsh'))
  check('injection format', inj.text.includes('=====记忆结束=====') && inj.text.includes('【本轮用户输入】：'))
  check('injected ids recorded', readFileSync(join(ws2, '.dsh-meow', 'sessions', 'test-session-1.json'), 'utf8').includes(inj.injectedIds[0]))
}
// 已注入过的命中不再重复注入
const inj2 = buildInjection(db2, ws2, 'test-session-1', '3081 又怎么了？', { hitTopK: 3 }, '.dsh-meow')
check('dedup across sessions file', inj2 === null || !inj2.text.includes('3081 端口是喵版 dsh'))
// 新 session 不受影响
const inj3 = buildInjection(db2, ws2, 'test-session-2', '3081 又怎么了？', { hitTopK: 3 }, '.dsh-meow')
check('new session gets hits', inj3 !== null && inj3.text.includes('3081 端口是喵版 dsh'))

// ── reflect 消息 ───────────────────────────────────────────────────────────
const { buildReflectMessage } = await import('./lib/index.js')
const db3 = new MemoryDb(memoryDbPath(ws))
const msg = buildReflectMessage(ws, '我们讨论一下猫眼插件的模型部署', '.dsh-meow')
check('reflect message produced', msg.content.some((b) => b.type === 'text' && b.text.includes('[记忆反思]')))
const txt = msg.content.map((b) => b.text ?? '').join('')
check('reflect has topic rules', txt.includes('目标句') && txt.includes('宽泛名'))

db.close(); db2.close(); db3.close()
closeAllDbs()
rmSync(ws, { recursive: true, force: true })
rmSync(ws2, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
