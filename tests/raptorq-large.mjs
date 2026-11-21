// Opt-in: node --expose-gc tests/raptorq-large.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { prepareRaptorTransfer, CompatibleReceiver, raptorFrame } from '../raptor-protocol.js';
import { diskFixture } from './node-disk.mjs';
import { makeSchedule } from '../codec-client.js';
import { codec } from '../raptor-wasm.js';
function rng(seed){return()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/2**32;};}
const size=129*2**20+17,rngData=rng(911),bytes=Uint8Array.from({length:size},()=>rngData()*256);
const file=new File([bytes],'large-129MiB.bin'),results=[];
for(const loss of (process.env.BEAM_LOSS?.split(',').map(Number)||[.1,.3,.5])){
 const disk=await diskFixture();const r=new CompatibleReceiver();
 try{
 global.gc?.();const start=performance.now(),cpu0=process.cpuUsage(),t=await prepareRaptorTransfer(file,1024),drop=rng(197+loss*1000);
 await r.receive(t.manifest);await r.setDisk(await disk.open());
 const prepared=performance.now();let frames=0,passes=0,peakRss=process.memoryUsage().rss;
 for(let pass=0;pass<20&&!r.complete;pass++){
  passes=pass+1;
  const schedule=makeSchedule(t,pass);
  for(let i=0;i<schedule.length;i++){
   const text=await raptorFrame(t,schedule.at(i));frames++;if(drop()>=loss)await r.receive(text);if(frames%4096===0)peakRss=Math.max(peakRss,process.memoryUsage().rss);if(r.complete)break;
  }
  console.log(`loss=${loss} pass=${pass} received=${r.received}/${t.count} frames=${frames}`);
 }
 assert.ok(r.complete);assert.equal(await r.finish(),null);const recovered=await disk.destination.getFile();
 for(let at=0;at<size;at+=2**20)assert.deepEqual(new Uint8Array(await recovered.slice(at,at+2**20).arrayBuffer()),bytes.subarray(at,at+2**20));
 const cpu=process.cpuUsage(cpu0),end=performance.now();
 results.push({size,loss,verified:true,frames,passes,prepareMs:+(prepared-start).toFixed(1),wallMs:+(end-start).toFixed(1),cpuMs:(cpu.user+cpu.system)/1000,wasmHighWaterMiB:codec().memory.buffer.byteLength/2**20,peakRssMiB:+(peakRss/2**20).toFixed(1)});
 console.log(JSON.stringify(results.at(-1)));t.dispose();
 }finally{await r.dispose();await disk.dispose();}
}
await writeFile(new URL('../docs/disk-stress-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
