import {createRequire} from 'node:module';import {resolve,sep} from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import http from 'node:http';
// Run against the current checkout or an extracted older build.
const root=process.env.BEAM_BENCH_ROOT ? resolve(process.env.BEAM_BENCH_ROOT) : fileURLToPath(new URL('../',import.meta.url)).replace(/[\\/]$/,''),{chromium}=createRequire(root+'/package.json')('playwright');
const browser=await chromium.launch({executablePath:process.env.BEAM_CHROME_EXECUTABLE,args:['--no-sandbox']});
const server=http.createServer(async(req,res)=>{try{
 const file=req.url.split('?')[0], path=resolve(root,'.'+file);if(!path.startsWith(root+sep))throw Error('outside root');let data=await readFile(path);
 if(file==='/app.js')data=Buffer.concat([data,Buffer.from(`
 globalThis.profile={frames:[],draw:[],gaps:[],reset(){this.frames=[];this.draw=[];this.gaps=[]}};
 const priorRender=renderModules;renderModules=function(...args){const t=performance.now();const r=priorRender(...args);if(running)profile.draw.push(performance.now()-t);return r;};
 window.__profileModules=()=>displayModules;
 window.__profileStatus=()=>({count:activeCodeCount,status:$('send-status').textContent,pass,scheduled:cursor,queue:displayQueue.length,fps:$('send-loop').textContent,workers:typeof encodeWorkers==='undefined'?1:encodeWorkers.length});
 const pTick=tickSend;tickSend=function(now){const prev=displayModules;pTick(now);if(prev!==displayModules&&running)profile.frames.push(now);};
 `)]);
 res.setHeader('Content-Type',file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.setHeader('Cache-Control','no-store');res.end(data);
}catch(e){res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 const page=await browser.newPage({viewport:{width:2592,height:1296}});
 page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
 await page.evaluate(()=>{
  const input=document.querySelector('#file-input');const f=new Uint8Array(8*2**20);
  for(let i=0;i<f.length;i+=65536)crypto.getRandomValues(f.subarray(i,i+65536));
  const dt=new DataTransfer();dt.items.add(new File([f],'bench.bin'));input.files=dt.files;input.dispatchEvent(new Event('change'));
  const speed=document.querySelector('#speed');speed.value='30';speed.dispatchEvent(new Event('input'));
 });
 await page.waitForFunction(()=>document.querySelector('#send-status').textContent.includes('READY'));
 await page.locator('#send-start').click();
 await page.waitForTimeout(2500);
 await page.evaluate(()=>profile.reset());
 await page.waitForTimeout(Number(process.env.BEAM_BENCH_MS||6000));
 const result=await page.evaluate(()=>{
  const t=profile.frames,d=profile.draw.slice().sort((a,b)=>a-b);
  return {...__profileStatus(),fpsMeasured:(1000*(t.length-1)/(t.at(-1)-t[0])).toFixed(2),frames:t.length,drawMedian:d[Math.floor(d.length/2)],drawP95:d[Math.floor(d.length*.95)]};
 });
 assert.equal(result.count,32);
 assert.ok(result.frames>0);
 console.log(JSON.stringify(result));
 if(process.env.BEAM_BENCH_VERIFY==='1'){
  const found=await page.evaluate(async()=>{
   const {decodeDetections}=await import('/decoder.js');
   const canvases=[...document.querySelectorAll('#qr-wrap canvas:not([hidden])')];
   const modules=__profileModules();
   const snapshots=[];
   // Read all 32 before awaiting the decoder so every snapshot is from the
   // same displayed packet batch. Verify the native canvas pixels independently
   // of browser zoom and capture scaling.
   for(const [i,canvas] of canvases.entries()){
    const q=modules[i], size=canvas.width,k=Math.floor(size/(q.size+8)),offset=Math.floor((size-q.size*k)/2);
    const image=canvas.getContext('2d').getImageData(0,0,size,size);
    const pixels=image.data;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
     const row=Math.floor((y-offset)/k),col=Math.floor((x-offset)/k);
     const black=row>=0&&row<q.size&&col>=0&&col<q.size&&q.data[row*q.size+col];
     if(pixels[(y*size+x)*4] !== (black?0:255))throw Error('Rendered QR differs from its integer module raster');
    }
    snapshots.push(image);
   }
   let count=0;
   for(const image of snapshots)if((await decodeDetections(image)).some(code=>/^B3:/.test(code.text)))count++;
   return count;
  });
  assert.equal(found,32);console.log('Pixel-matched sender canvases decoded: '+found+'/32 B3 codes');
 }
}finally{await browser.close();server.close();}
