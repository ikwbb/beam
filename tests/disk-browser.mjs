// Development-only Chromium integration; npm install --no-save playwright.
import { createRequire } from 'node:module';
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=new URL('../',import.meta.url);
const server=http.createServer(async(req,res)=>{
 try{const url=new URL('.'+req.url,root);if(!url.pathname.startsWith(root.pathname))throw Error('outside root');
 const type=req.url.endsWith('.js')||req.url.endsWith('.mjs')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html';
 res.setHeader('Content-Type',type);res.end(await readFile(url));}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.BEAM_CHROME_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
try{
 const page=await browser.newPage();page.on('console',msg=>console.log(msg.text()));
 await page.goto(address+'/index.html');
 // Use the real Chromium filesystem and the real codec worker. The native
 // chooser is bypassed by obtaining a test destination handle from OPFS.
 const result=await page.evaluate(async()=>{
  const {prepareRaptorTransfer,raptorFrame,SOURCE_SYMBOLS}=await import('/raptor-protocol.js');
  const {hashSlices}=await import('/disk-transfer.js');
  const {packet}=await import('/protocol.js');
  const root=await navigator.storage.getDirectory();
  const destination=await root.getFileHandle('test-output',{create:true});
  const worker=new Worker('/codec-worker.js',{type:'module'});
  const calls=new Map();let n=0;worker.onmessage=({data})=>{
   if(data.progress)return;
   const p=calls.get(data.id);calls.delete(data.id);
   if(data.error)p.reject(Error(data.error));else p.resolve(data.result);
  };
  const call=(op,opts={})=>new Promise((resolve,reject)=>{const id=++n;calls.set(id,{resolve,reject});worker.postMessage({id,op,generation:1,...opts});});
  try{
   const size=17*SOURCE_SYMBOLS*384+27,bytes=new Uint8Array(size);
   for(let i=0;i<size;i+=65536)crypto.getRandomValues(bytes.subarray(i,i+65536));
   const file=new File([bytes],'disk-test.bin');
   const t=await prepareRaptorTransfer(file,384);
   if(t.meta.encoding!=='raw')throw Error('Fixture compressed unexpectedly');
   const meta={...t.meta,storage:'disk'};
   const manifest=packet(0,t.id,0,t.count,t.blockSize,new TextEncoder().encode(JSON.stringify(meta)),3);
   const before=(await call('accept',{text:manifest})).status;
   await call('setDestination',{destination});
   // Put one symbol into each object before filling any of them. This exceeds
   // the active decoder cache and covers spilling/restoring partial blocks.
   for(let i=0;i<t.blocks;i++)await call('accept',{text:t.dataFrame(i*SOURCE_SYMBOLS)});
   // Deliver objects backwards. Omit systematic symbols and recover with repair.
   let state;
   for(let b=t.blocks-1;b>=0;b--){
    const k=t.symbols(b);let jobs=[];
    for(let i=1;i<k;i++)if(i%19!==0)jobs.push(call('accept',{text:t.dataFrame(b*SOURCE_SYMBOLS+i)}));
    await Promise.all(jobs);
    for(let i=0;i<Math.floor(k/19)+4;i++){
     const reply=await call('accept',{text:await raptorFrame(t,[3,b,i])});state=reply.status;
    }
   }
   if(!state.complete||state.verified)throw Error('Unexpected receive completion');
   const finish=await call('finish');
   const saved=await destination.getFile();
   let exact=saved.size===size;
   for(let at=0;exact&&at<size;at+=2**20){
    const chunk=new Uint8Array(await saved.slice(at,at+2**20).arrayBuffer());
    exact=chunk.every((value,i)=>value===bytes[at+i]);
   }
   return {before:before.needsDisk&&!before.diskReady,saved:finish.saved,verified:finish.status.verified,exact,clean:!(await Array.fromAsync(root.keys())).some(n=>n.startsWith('beam-transfer-')),hash:await hashSlices(saved)===meta.sha256,size};
  }finally{worker.terminate();await root.removeEntry('test-output');}
 });
 assert.deepEqual({...result,size:undefined},{before:true,saved:true,verified:true,exact:true,clean:true,hash:true,size:undefined});
 console.log('Chromium verified, saved and byte-compared '+result.size+' bytes after out-of-order repair and disk spill.');
 if(process.env.BEAM_SPARSE_FILE){
  await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='sparse-file';document.body.prepend(input);});
  await page.locator('#sparse-file').setInputFiles(process.env.BEAM_SPARSE_FILE);
  const result=await page.evaluate(async()=>{
   const file=document.querySelector('#sparse-file').files[0],{prepareTransfer,framesAt}=await import('/codec-client.js');
   const t=await prepareTransfer(file,1024,'file',(read,total)=>{if(read%(4*2**30)===0||read===total)console.log('Chromium sender hashed '+read+' / '+total+' bytes');});
   const [tail,repair]=await framesAt(t,[[1,t.count-1],[3,t.blocks-1,0]]);
   const {parseRaptorPacket}=await import('/raptor-protocol.js');
   const p=parseRaptorPacket(tail),q=parseRaptorPacket(repair);
   return {size:t.meta.size,sha256:t.meta.sha256,tailBlock:p.block,repairBlock:q.block,tail:Array.from(p.payload.slice(4,21))};
  });
  assert.equal(result.size,24*2**30+17);assert.equal(result.tailBlock,24576);assert.equal(result.repairBlock,24576);
  assert.deepEqual(result.tail,Array.from({length:17},(_,i)=>i+1));
  if(process.env.BEAM_SPARSE_SHA256)assert.equal(result.sha256,process.env.BEAM_SPARSE_SHA256);
  console.log('Chromium 24 GiB sender: '+JSON.stringify(result));
 }
}finally{await browser.close();server.close();}
