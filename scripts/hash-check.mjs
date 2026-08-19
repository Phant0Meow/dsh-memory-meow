import { readFileSync, createHash } from 'node:fs'
import { createHash as ch } from 'node:crypto'
const cli = readFileSync(new URL('../lib/client.js', import.meta.url))
console.log('client.js bytes:', cli.length)
console.log('sha1      :', ch('sha1').update(cli).digest('hex'))
console.log('sha1(12)  :', ch('sha1').update(cli).digest('hex').slice(0, 12))
console.log('md5       :', ch('md5').update(cli).digest('hex'))
console.log('md5(12)   :', ch('md5').update(cli).digest('hex').slice(0, 12))
console.log('用户报错 rev: 026351ed9296')
// 也看 index.js 是否被 21:37 构建（含修复）
const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
console.log('index.js has agentsSvc:', idx.includes('agentsSvc'))
