const fs=require('node:fs'),path=require('node:path');
const esbuild=require('esbuild');
const root=path.resolve(__dirname,'../..');process.chdir(root);
const out=path.join(__dirname,'out-mounted');fs.mkdirSync(out,{recursive:true});
fs.cpSync('client/public/assets/characters',path.join(out,'assets/characters'),{recursive:true});
fs.copyFileSync('dev/character/character-sample.wav',path.join(out,'sample.wav'));
esbuild.buildSync({entryPoints:[path.join(__dirname,'mounted-harness.tsx')],bundle:true,outfile:path.join(out,'app.js'),alias:{react:path.resolve('node_modules/react'),'react-dom':path.resolve('node_modules/react-dom')},nodePaths:[path.resolve('node_modules')]});
fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Character call development</title><style>
*{box-sizing:border-box}body{font:18px/1.55 system-ui;background:#f7f1ef;color:#332731;padding:24px;margin:0}main{max-width:660px;margin:auto}h1{font-size:1.9rem;line-height:1.2}button,select{font:inherit;min-height:44px;padding:8px 12px;margin:5px;max-width:100%}label{display:block;margin:16px 0}input{width:22px;height:22px}.stage{position:relative;width:min(360px,80vw);aspect-ratio:1;margin:24px auto;border-radius:50%;overflow:hidden;background:#423441}.stage img,.stage canvas{position:absolute;width:100%;height:100%;inset:0;object-fit:cover}.stage [hidden]{display:none}canvas{pointer-events:none}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #ad4185;outline-offset:3px}p{max-width:65ch}@media(prefers-color-scheme:dark){body{background:#201b22;color:#f9edf3}}
</style><div id="root"></div><script src="app.js"></script></html>`);
