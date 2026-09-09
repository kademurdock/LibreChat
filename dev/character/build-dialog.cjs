const fs = require('node:fs'), path = require('node:path');
(async () => {
  const { build } = await import('vite');
  const root = path.resolve(__dirname, '../..'), out = path.join(__dirname, 'out-dialog');
  const shell = path.join(__dirname, 'dialog-shell.ts');
  process.chdir(root); fs.mkdirSync(out, { recursive: true });
  fs.cpSync('client/public/assets/characters', path.join(out, 'assets/characters'), { recursive: true });
  fs.copyFileSync('dev/character/character-sample.wav', path.join(out, 'sample.wav'));
  const css = fs.readdirSync('client/dist/assets').find(n => /^index\..*\.css$/.test(n));
  if (!css) throw Error('Build the frontend first for the real call styles');
  fs.copyFileSync(path.join('client/dist/assets', css), path.join(out, 'app.css'));
  await build({ configFile: false, root, publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
    resolve: { dedupe: ['react', 'react-dom', 'recoil'], alias: [
      { find: /^~\/hooks$/, replacement: shell }, { find: /^~\/hooks\/Audio$/, replacement: shell },
      { find: /^~\/store$/, replacement: shell }, { find: /^~\/utils$/, replacement: shell },
      { find: '~/components/Chat/Messages/Content/GameTable', replacement: path.join(__dirname, 'dialog-table.tsx') },
      { find: '~', replacement: path.join(root, 'client/src') },
    ] }, esbuild: { jsx: 'automatic' }, build: { outDir: out, emptyOutDir: false,
      lib: { entry: path.join(__dirname, 'dialog-harness.tsx'), formats: ['iife'], name: 'CallDialog', fileName: () => 'app.js' } } });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Call dialog development</title><link rel="stylesheet" href="app.css"><body><div id="root"></div><script src="app.js"></script></body></html>');
})().catch(e => { console.error(e); process.exitCode = 1; });
