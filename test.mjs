/**
 * Logic-level test for meow-memory (no LLM, no harness).
 * Drives the plugin's apply() with a mock ctx and asserts:
 *  1. memory_remember tool registered with the right shape;
 *  2. first user message gets PROJECT.md injected (and only once);
 *  3. turn-stopping steers a reflect message only when the turn did tool work
 *     and did not already reflect / did not end on a memory_ tool.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './lib/index.js'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

function makeCtx() {
  const tools = []
  const handlers = {}
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: console.error },
    tools: { register: (t) => tools.push(t) },
    on: (name, fn) => { handlers[name] = fn },
  }
  return { ctx, tools, handlers }
}

function makeAgent(cwd, events = []) {
  const steered = []
  return {
    session: { header: { cwd }, events },
    steer: (msg) => steered.push(msg),
    _steered: steered,
  }
}

const events = {
  turnStart: (turn) => ({ type: 'turn/start', data: { turn } }),
  turnEnd: (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }),
  userMsg: (text, source = { kind: 'user' }) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source } }),
  assistantWithTool: (name) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name, arguments: '{}' }] } } }),
  assistantText: (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }),
}

const ws = mkdtempSync(join(tmpdir(), 'mm-test-'))
const projectFile = join(ws, '.dsh-meow', 'PROJECT.md')

const { ctx, tools, handlers } = makeCtx()
await apply(ctx, { enabled: true })

// ── 1. tool registration ────────────────────────────────────────────────────
check('memory_remember registered', tools.length === 1 && tools[0].name === 'memory_remember',
  `got ${tools.map(t => t.name).join(',')}`)
const tool = tools[0]
check('tool has content param required', tool.parameters?.required?.includes('content') === true)
check('tool has category enum', Array.isArray(tool.parameters?.properties?.category?.enum) &&
  tool.parameters.properties.category.enum.length >= 5)
check('tool renders success hint', typeof tool.output?.render === 'function')

// ── 2. memory_remember execute writes PROJECT.md ────────────────────────────
const exec = { agent: makeAgent(ws) }
const res = await tool.execute({ content: '用户偏好中文交流', category: 'preference' }, exec)
check('execute returns ok', res.ok === true)
check('PROJECT.md created', existsSync(projectFile))
let text = readFileSync(projectFile, 'utf8')
check('entry under preference section', text.includes('## 用户偏好 (preference)') && text.includes('- 用户偏好中文交流'))
await tool.execute({ content: '这是一个重要决定', category: 'fact' }, exec)
text = readFileSync(projectFile, 'utf8')
check('second category section added', text.includes('## 重要事实与决定 (fact)') && text.includes('- 这是一个重要决定'))
await tool.execute({ content: '又一个偏好' }, exec)
text = readFileSync(projectFile, 'utf8')
check('same category appends', (text.match(/- 又一个偏好/g) || []).length === 1)
check('file still parses as utf8 without corruption', !text.includes('\uFFFD'))

// ── 3. pre-step injection ───────────────────────────────────────────────────
const preStep = handlers['agent/pre-step']
check('pre-step handler registered', typeof preStep === 'function')

// first user message → injected
const agentA = makeAgent(ws)
const decisionA = await preStep(
  { agent: agentA, messages: [{ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }] }),
)
check('injects into first user message', decisionA.kind === 'enter' && decisionA.messages.length === 1 &&
  decisionA.messages[0].content.some(b => b.type === 'text' && b.text.includes('[项目记忆 PROJECT.md')))

// second time (session now has user/message history) → no injection
const agentB = makeAgent(ws, [events.userMsg('之前有一条')])
const decisionB = await preStep(
  { agent: agentB, messages: [{ content: [{ type: 'text', text: '再问' }], source: { kind: 'user' } }], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '再问' }], source: { kind: 'user' } }] }),
)
check('no injection on later turns', decisionB.messages[0].content.length === 1)

// no PROJECT.md → no injection
const wsEmpty = mkdtempSync(join(tmpdir(), 'mm-empty-'))
const agentC = makeAgent(wsEmpty)
const decisionC = await preStep(
  { agent: agentC, messages: [{ content: [{ type: 'text', text: '嗨' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '嗨' }], source: { kind: 'user' } }] }),
)
check('no injection without PROJECT.md', decisionC.messages[0].content.length === 1)

// ── 4. turn-stopping reflect ────────────────────────────────────────────────
const stopping = handlers['agent/turn-stopping']
check('turn-stopping handler registered', typeof stopping === 'function')

// tool work done, last tool not memory → steer
const agentD = makeAgent(ws, [events.turnStart(1), events.userMsg('列文件'), events.assistantWithTool('bash'), events.assistantText('完成')])
stopping({ agent: agentD, turn: 1, signal: new AbortController().signal })
check('steers reflect after tool turn', agentD._steered.length === 1 &&
  agentD._steered[0].content.some(b => b.type === 'text' && b.text.includes('记忆反思')))

// chat-only turn → no steer
const agentE = makeAgent(ws, [events.turnStart(1), events.userMsg('你好'), events.assistantText('你好呀')])
stopping({ agent: agentE, turn: 1, signal: new AbortController().signal })
check('no steer on chat turn', agentE._steered.length === 0)

// already reflected this turn (plugin message present) → no steer
const agentF = makeAgent(ws, [
  events.turnStart(1), events.userMsg('列文件'), events.assistantWithTool('bash'), events.assistantText('完成'),
  events.userMsg('', { kind: 'plugin', plugin: 'meow-memory' }),
])
stopping({ agent: agentF, turn: 1, signal: new AbortController().signal })
check('no double reflect', agentF._steered.length === 0)

// last tool is memory_remember → no steer (already self-recorded)
const agentG = makeAgent(ws, [events.turnStart(1), events.userMsg('记住这个'), events.assistantWithTool('memory_remember'), events.assistantText('已记住')])
stopping({ agent: agentG, turn: 1, signal: new AbortController().signal })
check('no steer after memory_ tool', agentG._steered.length === 0)

// reflect message steers then reflect round ends → no recursion
const agentH = makeAgent(ws, [
  events.turnStart(1), events.userMsg('干活'), events.assistantWithTool('bash'), events.assistantText('干完了'),
  events.userMsg('', { kind: 'plugin', plugin: 'meow-memory' }),
  events.assistantText('无需记忆'),
])
stopping({ agent: agentH, turn: 1, signal: new AbortController().signal })
check('no recursion after reflect round', agentH._steered.length === 0)

// ── 5. disabled config ──────────────────────────────────────────────────────
const { ctx: ctxOff, tools: toolsOff, handlers: handlersOff } = makeCtx()
await apply(ctxOff, { enabled: false })
check('disabled registers nothing', toolsOff.length === 0)
check('disabled registers no handlers', Object.keys(handlersOff).length === 0)

rmSync(ws, { recursive: true, force: true })
rmSync(wsEmpty, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
