import { statSync } from 'node:fs'
console.log('now        :', new Date().toISOString())
for (const f of ['lib/client.js', 'lib/client.js.map', 'lib/index.js']) {
  const s = statSync(new URL('../' + f, import.meta.url))
  console.log(f.padEnd(20), s.mtime.toISOString(), s.size)
}
