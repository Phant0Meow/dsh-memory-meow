/**
 * Build script: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/index.js — host loader entry (exports["."] / main), loaded by the
 *    dsh Node process.
 *  - lib/client.js — browser bundle in ModuleLoader.load format (the web
 *    shell's client module loader; see @deepseek-ai/dsh-client-modules).
 *
 * Everything is bundled (esbuild) so the plugin is self-contained:
 * @deepseek-ai/* imports are linked in at build time via the node_modules
 * junction mirrors (scripts/link-workspace.ps1); react stays external on the
 * client side (shell singleton, ModuleLoader resolves it).
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');

// The @deepseek-ai/* packages live in the dsh-meow pnpm workspace, not in this
// package's node_modules. `node_modules/@deepseek-ai` holds junction mirrors
// (created by scripts/link-workspace.ps1) so esbuild can resolve both this
// plugin's direct imports and the transitive imports of bundled packages.
const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))];

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
};

const clientOptions = {
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths,
  outfile: 'lib/client.js',
  // react 走 shell 单例（ModuleLoader 的 require 解析到 seed 里的 react），
  // 不能打进 bundle——否则双 React 实例会崩掉 slots 渲染。
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '  id: "meow-memory",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  await (await context(hostOptions)).watch();
  await (await context(clientOptions)).watch();
  console.log('[build] watching src/ for changes...');
} else {
  await Promise.all([build(hostOptions), build(clientOptions)]);
}
