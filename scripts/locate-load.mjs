import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const lines = src.split('\n')
console.log('total lines:', lines.length)
lines.forEach((line, i) => {
  if (line.includes('__ModuleLoader__') || line.includes('module.exports')) {
    console.log(`L${i + 1}: ${line.slice(0, 100)}`)
  }
})
// 统计 factory 数量
console.log('factory count:', (src.match(/factory:/g) || []).length)
console.log('load( count:', (src.match(/\.load\(\{/g) || []).length)
