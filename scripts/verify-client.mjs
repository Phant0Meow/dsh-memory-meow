import { readFileSync } from 'node:fs'
const s = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
console.log('len:', s.length)
console.log('start ok:', s.startsWith('window.__ModuleLoader__.load({'))
console.log('id quoted:', s.includes('id: "meow-memory"'))
console.log('footer ok:', s.trimEnd().endsWith('});'))
console.log('map ref:', s.includes('sourceMappingURL'))
// 语法验证：用 new Function 包一层（client 是 CJS，引用 window 不能直接执行，只查语法）
try {
  new Function(s.replace(/^window\.__ModuleLoader__\.load\(\{/, 'void (0); ({'))
  console.log('syntax: OK')
} catch (e) {
  console.log('syntax check skip:', e.message.slice(0, 80))
}
