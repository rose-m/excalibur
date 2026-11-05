// The published Excalidraw entry is browser-oriented. Bundle it separately so
// an isolated worker can install its DOM before importing it (never on the server).
// Adapted from mcp_excalidraw's build-excalidraw-node.mjs; see THIRD_PARTY_NOTICES.md.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { create as readFont } from 'fontkit';
const directory = resolve('dist/headless');
mkdirSync(join(directory, 'fonts'), { recursive: true });
const root = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const families = { Virgil: 'Virgil', Cascadia: 'Cascadia', Liberation: 'Liberation Sans', Excalifont: 'Excalifont', Nunito: 'Nunito', Lilita: 'Lilita One', ComicShanns: 'Comic Shanns', Xiaolai: 'Xiaolai', Assistant: 'Assistant' };
const fonts = [];
for (const [folder, family] of Object.entries(families)) {
  for (const filename of readdirSync(join(root, folder)).filter(f => f.endsWith('.woff2'))) {
    const output = filename;
    cpSync(join(root, folder, filename), join(directory, 'fonts', output));
    // Read coverage from the pinned binaries themselves. This also lets SVG
    // exports include only the CJK subsets needed for the rendered text.
    const font = readFont(readFileSync(join(root, folder, filename)));
    const ranges = [];
    for (const point of [...font.characterSet].sort((a, b) => a - b)) {
      const last = ranges.at(-1);
      if (last && last[1] + 1 === point) last[1] = point;
      else ranges.push([point, point]);
    }
    const unicodeRange = ranges.map(([start, end]) => `U+${start.toString(16)}${start === end ? '' : `-${end.toString(16)}`}`).join(',');
    fonts.push({ family, file: output, unicodeRange, ranges });
  }
}
writeFileSync(join(directory, 'fonts.json'), JSON.stringify(fonts));
cpSync('THIRD_PARTY_NOTICES.md', join(directory, 'THIRD_PARTY_NOTICES.md'));
const sdk = {
  entryPoints: ['scripts/headless-entry.mjs'], outfile: join(directory, 'excalidraw.mjs'),
  bundle: true, minify: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['*.chunk.js'],
  // Use the pinned SDK's native binding/geometry implementation, not a second
  // approximation of routed arrows. Dev entry and internals must share a module.
  alias: { '@excalidraw/excalidraw': resolve('node_modules/@excalidraw/excalidraw/dist/dev/index.js'), '@excalidraw/mermaid-to-excalidraw': resolve('scripts/mermaid-stub.mjs'), mermaid: resolve('scripts/mermaid-stub.mjs') },
  plugins: [{ name: 'native-geometry', setup(build) {
    const dev = realpathSync('node_modules/@excalidraw/excalidraw/dist/dev');
    const chunk = readdirSync(dev).find(file => file.endsWith('.js') && readFileSync(join(dev, file), 'utf8').includes('var updateBoundElements ='));
    if (!chunk) throw new Error('Pinned Excalidraw native geometry module not found; review SDK adapter');
    build.onResolve({ filter: /^excalibur-native-geometry$/ }, () => ({ path: join(dev, chunk) }));
  } }],
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'eof', logLevel: 'warning',
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
};
const worker = {
  entryPoints: ['src/server/render/worker.ts'], outfile: join(directory, 'worker.mjs'),
  bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
};
if (process.argv.includes('--watch')) {
  await Promise.all([sdk, worker].map(async options => { const ctx = await context(options); await ctx.watch(); }));
} else {
  await Promise.all([build(sdk), build(worker)]);
}
