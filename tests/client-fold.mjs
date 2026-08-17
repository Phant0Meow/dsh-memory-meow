/**
 * client-fold 纯逻辑测试：computeFoldGroups / foldLabel。
 * 运行：node tests/client-fold.mjs（构建后；内部 esbuild 打包源码保证与 src 同步）。
 */
import { build } from 'esbuild'

// 现场 bundle src/client-fold.ts（纯函数模块，无 DOM/react 依赖）→ 内存加载。
const { outputFiles } = await build({
  entryPoints: ['src/client-fold.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const code = new TextDecoder().decode(outputFiles[0].contents)
const modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const { computeFoldGroups, foldLabel, toolCallDetail, blocksToText, computeInjectionGroups } = await import(modUrl)

// ---- mock 快照 ----
function turnLoc(turn) {
  return { kind: 'turn', turn: { turn } }
}
function stepLoc(turn, step) {
  return { kind: 'step', turn: { turn }, step: { step } }
}
function contextNode(key, text, loc) {
  return {
    key, kind: 'context', location: loc,
    data: { source: { kind: 'plugin', plugin: 'meow-memory' }, content: [{ type: 'text', text }] },
  }
}
function userNode(key, loc, content) {
  return { key, kind: 'user', location: loc, data: { source: { kind: 'user' }, ...(content ? { content } : {}) } }
}
function steeringNode(key, loc) {
  return { key, kind: 'steering', location: loc, data: {} }
}
function assistantNode(key, loc, status) {
  return { key, kind: 'assistant', location: loc, data: { status } }
}
function toolNode(key, loc, name) {
  const root = name === null
    ? { kind: 'tool-result', callId: 'c', call: null, content: [] }
    : { callId: 'c', name, argsRaw: '{}', turn: 1, step: 1, time: 0, subCalls: [] }
  return { key, kind: 'tool-call', location: loc, data: { root } }
}
function snapshot(order, nodes, getTurn) {
  return {
    chat: {
      order,
      nodes: { get: (k) => nodes.get(k) },
      locations: { getTurn: (t) => getTurn(t) ?? [] },
    },
  }
}

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  if (!cond) failures++
}

const REFLECT = '[meow-memory-reflect]\n反思 prompt...'
const DREAM = '[meow-memory-dream]\n整理指令...'

// ---- 1. 识别 + 范围 + 计数（RunningToolCall 形态） ----
console.log('=== 1. 反思轮识别/范围/计数 ===')
{
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['asst-1', assistantNode('asst-1', turnLoc(5), 'settled')],
    ['tool-1', toolNode('tool-1', turnLoc(5), 'memory_remember')],
    ['tool-2', toolNode('tool-2', turnLoc(5), 'memory_remember')],
    ['tool-3', toolNode('tool-3', turnLoc(5), 'memory_update')],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(5), data: { turn: 5 } }],
  ])
  const s = snapshot(
    ['ctx-1', 'asst-1', 'tool-1', 'tool-2', 'tool-3', 'tail-1'],
    nodes,
    (t) => t === 5 ? ['ctx-1', 'asst-1', 'tool-1', 'tool-2', 'tool-3', 'tail-1'] : [],
  )
  const groups = computeFoldGroups(s)
  check('识别出一个组', groups.length === 1)
  const g = groups[0]
  check('组 id = 起点 key', g.id === 'ctx-1')
  check('变体 = reflect', g.variant === 'reflect')
  check('范围含全部 turn 节点', g.keys.length === 6)
  check('remember 计数 = 2', g.rememberCount === 2)
  check('update 计数 = 1', g.updateCount === 1)
  check('status = done', g.status === 'done')
}

// ---- 2. 排除 user/steering + 起点之后切片 ----
console.log('=== 2. 排除 user/steering、只取起点之后 ===')
{
  const nodes = new Map([
    ['user-0', userNode('user-0', turnLoc(4))],
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['asst-1', assistantNode('asst-1', turnLoc(5), 'settled')],
    ['steer-1', steeringNode('steer-1', turnLoc(5))],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(5), data: { turn: 5 } }],
  ])
  // getTurn(5) 把 user-0 也算进去（异常数据），应被"起点之后"切片排除
  const s = snapshot(
    ['user-0', 'ctx-1', 'asst-1', 'steer-1', 'tail-1'],
    nodes,
    (t) => t === 5 ? ['user-0', 'ctx-1', 'asst-1', 'steer-1', 'tail-1'] : [],
  )
  const [g] = computeFoldGroups(s)
  check('范围排除起点之前的 user-0', !g.keys.includes('user-0'))
  check('范围排除 steering', !g.keys.includes('steer-1'))
  check('范围含 asst/tail', g.keys.includes('asst-1') && g.keys.includes('tail-1'))
  check('group 起点 ctx-1 在内', g.keys.includes('ctx-1'))
}

// ---- 3. 状态：running / interrupted ----
console.log('=== 3. 状态判定 ===')
{
  const mk = (status) => {
    const nodes = new Map([
      ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
      ['asst-1', assistantNode('asst-1', turnLoc(5), status)],
    ])
    return computeFoldGroups(snapshot(['ctx-1', 'asst-1'], nodes, () => ['ctx-1', 'asst-1']))[0]
  }
  check('running', mk('running').status === 'running')
  check('interrupted', mk('interrupted').status === 'interrupted')
  check('settled → done', mk('settled').status === 'done')
}

// ---- 4. dream 变体 + unresolved 跳过 + 非 meow-memory 不管 ----
console.log('=== 4. dream / unresolved / 外来 context ===')
{
  const nodes = new Map([
    ['ctx-d', contextNode('ctx-d', DREAM, turnLoc(6))],
    ['ctx-x', { key: 'ctx-x', kind: 'context', location: turnLoc(7), data: { source: { kind: 'plugin', plugin: 'compact' }, content: [] } }],
    ['ctx-u', contextNode('ctx-u', REFLECT, { kind: 'unresolved' })],
  ])
  const s = snapshot(['ctx-d', 'ctx-x', 'ctx-u'], nodes, (t) => t === 6 ? ['ctx-d'] : [])
  const groups = computeFoldGroups(s)
  check('只有 dream 组', groups.length === 1 && groups[0].variant === 'dream')
}

// ---- 5. ToolResultNode 形态计数（窗口截断） ----
console.log('=== 5. tool-result 形态计数 ===')
{
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['tool-1', toolNode('tool-1', turnLoc(5), null)], // call 为 null（窗口截断）
    ['tool-2', { key: 'tool-2', kind: 'tool-call', location: turnLoc(5), data: { root: { kind: 'tool-result', callId: 'c', call: { name: 'memory_remember', argsRaw: '{}' }, content: [] } } }],
  ])
  const s = snapshot(['ctx-1', 'tool-1', 'tool-2'], nodes, () => ['ctx-1', 'tool-1', 'tool-2'])
  const [g] = computeFoldGroups(s)
  check('截断 call=null 不计，窗口内 call 正常计', g.rememberCount === 1 && g.updateCount === 0)
}

// ---- 6. 文案 ----
console.log('=== 6. foldLabel 文案 ===')
{
  const base = { id: 'x', variant: 'reflect', keys: [], rememberCount: 0, updateCount: 0, status: 'done' }
  check('新增记忆 3 条', foldLabel({ ...base, rememberCount: 3 }, false) === '▸ 记忆反思 · 新增记忆 3 条')
  check('无需记忆', foldLabel(base, false) === '▸ 记忆反思 · 无需记忆')
  check('running', foldLabel({ ...base, status: 'running' }, false) === '▸ 记忆反思进行中…')
  check('已更新 2 条', foldLabel({ ...base, updateCount: 2 }, false) === '▸ 记忆反思 · 已更新 2 条')
  check('dream 新增', foldLabel({ ...base, variant: 'dream', rememberCount: 1 }, true) === '▾ 记忆梦境任务 · 新增记忆 1 条')
  check('中断', foldLabel({ ...base, status: 'interrupted' }, false) === '▸ 记忆反思已中断')
}

// ---- 7. 并行 tool-call 各自成节点（反思轮真实形态） ----
console.log('=== 7. 并行 memory_remember 计数 ===')
{
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['asst-1', assistantNode('asst-1', turnLoc(5), 'settled')],
    ['tool-a', toolNode('tool-a', turnLoc(5), 'memory_remember')],
    ['tool-b', toolNode('tool-b', turnLoc(5), 'memory_remember')],
    ['tool-c', toolNode('tool-c', turnLoc(5), 'memory_remember')],
    ['tool-d', toolNode('tool-d', turnLoc(5), 'memory_search')],
    ['asst-2', assistantNode('asst-2', turnLoc(5), 'settled')],
  ])
  const s = snapshot(
    ['ctx-1', 'asst-1', 'tool-a', 'tool-b', 'tool-c', 'tool-d', 'asst-2'],
    nodes,
    () => ['ctx-1', 'asst-1', 'tool-a', 'tool-b', 'tool-c', 'tool-d', 'asst-2'],
  )
  const [g] = computeFoldGroups(s)
  check('并行 3 次 remember 全数到', g.rememberCount === 3)
  check('memory_search 不计', g.updateCount === 0)
  check('文案显示新增 3 条', foldLabel(g, false).includes('新增记忆 3 条'))
}

// ---- 9. 注入折叠：首轮长期记忆 / 关键词命中识别与解析 ----
console.log('=== 9. computeInjectionGroups ===')
{
  const FIRST = '===== 长期记忆 =====\n【关于你】x\n===== 长期记忆结束 =====\n\n本轮用户prompt：\n\n你好'
  const HIT = '可能相关的记忆，仅供参考：\n- [fact:abc] 内容\n------\n本轮用户prompt：\n\n再问一句'
  const PLAIN = '普通消息没有注入'
  const nodes = new Map([
    ['u-first', userNode('u-first', turnLoc(1), [{ type: 'text', text: FIRST }])],
    ['u-hit', userNode('u-hit', turnLoc(2), [{ type: 'text', text: HIT }])],
    ['u-plain', userNode('u-plain', turnLoc(3), [{ type: 'text', text: PLAIN }])],
    ['u-img', userNode('u-img', turnLoc(4), [{ type: 'text', text: HIT }, { type: 'image', attachment: {} }])],
  ])
  const s = snapshot(['u-first', 'u-hit', 'u-plain', 'u-img'], nodes, () => [])
  const injs = computeInjectionGroups(s)
  check('识别 2 个注入组（带图不折叠）', injs.length === 2)
  const first = injs.find((g) => g.id === 'u-first')
  check('首轮注入 kind=first', first?.kind === 'first')
  check('首轮 userText 解析', first?.userText === '你好')
  check('首轮 injectedText 含完整注入', first?.injectedText.includes('===== 长期记忆 =====') && first?.injectedText.includes('本轮用户prompt：'))
  const hit = injs.find((g) => g.id === 'u-hit')
  check('命中注入 kind=hit', hit?.kind === 'hit')
  check('命中 userText 解析', hit?.userText === '再问一句')
  check('命中 injectedText 含标记', hit?.injectedText.includes('可能相关的记忆，仅供参考：'))
}

console.log(failures === 0 ? '\nALL CLIENT-FOLD TESTS PASSED ✅' : `\n${failures} FAILURES ❌`)
process.exit(failures === 0 ? 0 : 1)
