import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const lines = src.split('\n')
console.log('total lines:', lines.length, 'bytes:', src.length)
console.log('--- 所有 load/factory/module.exports 行 ---')
lines.forEach((line, i) => {
  if (line.includes('__ModuleLoader__') || line.includes('factory') || line.includes('module.exports') || line.includes('return module.exports')) {
    console.log(`L${i + 1}: ${line.slice(0, 90)}`)
  }
})
console.log('--- 前 12 行 ---')
console.log(lines.slice(0, 12).join('\n'))
console.log('--- 末 8 行 ---')
console.log(lines.slice(-8).join('\n'))
