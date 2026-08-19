import { statSync, readFileSync } from 'node:fs'
const base = new URL('../lib/', import.meta.url)
for (const f of ['index.js', 'index.js.map', 'client.js', 'client.js.map']) {
  try {
    const s = statSync(new URL(f, base))
    const head = f === 'index.js' || f === 'client.js' ? readFileSync(new URL(f, base), 'utf8').slice(0, 50).replace(/\n/g, ' ') : ''
    console.log(f.padEnd(16), s.mtime.toISOString(), s.size, head)
  } catch (e) { console.log(f, 'ERR', e.message) }
}
