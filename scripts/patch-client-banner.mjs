/**
 * 临时修复：给 lib/client.js 拼接 __ModuleLoader__.load 包装（banner/footer）。
 * 背景：PowerShell 直接传 --banner 参数会吃掉双引号（id: meow-memory 丢引号），
 * 导致 client-modules 加载时报 "loaded without registering meow-memory"。
 * 这里用 Node 文件拼接（无 shell 转义），与 build.mjs 的 banner/footer 完全一致。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const outfile = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const raw = readFileSync(outfile, 'utf8')

const banner = [
  'window.__ModuleLoader__.load({',
  '  id: "meow-memory",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '',
].join('\n')

const footer = [
  '',
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')

writeFileSync(outfile, banner + raw + footer, 'utf8')
console.log('patched client.js:', raw.length, '->', banner.length + raw.length + footer.length, 'chars')
