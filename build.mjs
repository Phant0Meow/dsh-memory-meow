/**
 * Build script: TS source -> deployable host bundle.
 *
 * Everything is bundled into lib/index.js (esbuild, platform=node, ESM) so the
 * plugin is self-contained: @deepseek-ai/schemastery, dsh-tools and dsh-llm
 * are linked in at build time. No node_modules bridges needed at deploy time,
 * and no client half (no browser UI) — this plugin is host-only.
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

if (watch) {
  const ctx = await context(hostOptions);
  await ctx.watch();
  console.log('[build] watching src/ for changes...');
} else {
  await build(hostOptions);
}
