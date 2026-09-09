const {rollup}=require('rollup');
const terser=require('@rollup/plugin-terser');
const fs=require('node:fs');const path=require('node:path');
(async()=>{
 const assets=path.resolve(__dirname,'../../client/public/assets/reverie');
 const bundle=await rollup({input:path.join(assets,'stage.mjs'),plugins:[terser()]});
 const {output}=await bundle.generate({format:'iife',name:'ReverieBundled'});
 const script=output[0].code.replace(/<\/script/gi,'<\\/script');
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' file: data:; connect-src 'none'"><style>html,body,#stage{margin:0;width:100%;height:100%;overflow:hidden;background:#c7d9ca}#stage{position:relative}canvas{display:block;position:absolute;width:100%;height:100%;inset:0}</style></head><body><div id="stage" aria-hidden="true"></div><script>window.ReverieAssetBase='./';${script}\nlet stage=null,failed=false;window.reverieNativeUpdate=(s,m)=>{if(failed)return 'The room picture is unavailable. All world controls and sound remain available.';try{if(!stage)stage=new window.ReverieStage.Stage(document.getElementById('stage'),()=>{failed=true;stage?.dispose();stage=null;});stage.update(s.room,s.hud||{});stage.setMotion(m);return window.ReverieStage.describePicture(stage.model);}catch(e){failed=true;stage?.dispose();stage=null;return 'The room picture is unavailable. All world controls and sound remain available.';}};window.reverieNativeDispose=()=>{stage?.dispose();stage=null;};</script></body></html>`;
 const dest=path.join(path.resolve(process.argv[2] || '../kade-ai-native'),'Sources/Reverie');fs.mkdirSync(dest,{recursive:true});
 fs.writeFileSync(path.join(dest,'ReverieStage.html'),html);
 fs.copyFileSync(path.join(assets,'mural.webp'),path.join(dest,'mural.webp'));
 fs.copyFileSync(path.join(assets,'vendor/LICENSE.three'),path.join(dest,'LICENSE.three.txt'));
 console.log('Offline iPhone scene bundle:',Buffer.byteLength(html),'bytes');
 await bundle.close();
})();
