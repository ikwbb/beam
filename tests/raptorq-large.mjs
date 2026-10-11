// Opt-in: node --expose-gc tests/raptorq-large.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { prepareRaptorTransfer, RaptorReceiver, raptorSchedule, raptorFrame } from '../raptor-protocol.js';
import { codec } from '../raptor-wasm.js';
function rng(seed){return()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/2**32;};}
const size=129*2**20+17,rngData=rng(911),bytes=Uint8Array.from({length:size},()=>rngData()*256);
const file=new File([bytes],'large-129MiB.bin'),results=[];
for(const loss of [.1,.3,.5]){
 global.gc?.();const start=performance.now(),cpu0=process.cpuUsage(),t=await prepareRaptorTransfer(file,1024),r=new RaptorReceiver(),drop=rng(197+loss*1000);
 const prepared=performance.now();let frames=0,passes=0,peakRss=process.memoryUsage().rss;
 for(let pass=0;pass<20&&!r.complete;pass++){
  passes=pass+1;
  for(const item of raptorSchedule(t,pass,rng(981+pass))){
   const text=await raptorFrame(t,item);frames++;if(drop()>=loss)r.accept(text);if(frames%4096===0)peakRss=Math.max(peakRss,process.memoryUsage().rss);if(r.complete)break;
  }
  console.log(`loss=${loss} pass=${pass} received=${r.received}/${t.count} frames=${frames}`);
 }
 assert.ok(r.complete);const recovered=await r.finish();assert.deepEqual(recovered,bytes);
 const cpu=process.cpuUsage(cpu0),end=performance.now();
 results.push({size,loss,verified:true,frames,passes,prepareMs:+(prepared-start).toFixed(1),wallMs:+(end-start).toFixed(1),cpuMs:(cpu.user+cpu.system)/1000,wasmHighWaterMiB:codec().memory.buffer.byteLength/2**20,peakRssMiB:+(peakRss/2**20).toFixed(1)});
 console.log(JSON.stringify(results.at(-1)));t.dispose();r.dispose();
}
await writeFile(new URL('../docs/large-file-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
