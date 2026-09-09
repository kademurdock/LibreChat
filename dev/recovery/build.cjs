const fs = require('node:fs'), path = require('node:path');
(async () => {
  const { build } = await import('vite');
  const root = path.resolve(__dirname, '../..'), out = path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  const css = fs.readdirSync(path.join(root, 'client/dist/assets')).find(n => /^index\..*\.css$/.test(n));
  fs.copyFileSync(path.join(root, 'client/dist/assets', css), path.join(out, 'app.css'));
  await build({ configFile: false, root, publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
    resolve: { dedupe: ['react', 'react-dom'], alias: [
      { find: /^~\/hooks$/, replacement: path.join(__dirname, 'localize.ts') },
      { find: '~', replacement: path.join(root, 'client/src') },
    ] }, esbuild: { jsx: 'automatic' }, build: { outDir: out, emptyOutDir: false,
      lib: { entry: path.join(__dirname, 'harness.tsx'), formats: ['iife'], name: 'RecoveryPreview', fileName: () => 'app.js' } } });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account recovery development</title><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script src="/app.js"></script></body></html>');
})().catch(e => { console.error(e); process.exitCode = 1; });
