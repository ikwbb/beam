// Actual bundled WASM, seeded iid packet loss. No QR/camera timing claims.
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import * as old from '../legacy-protocol.js';
import * as rq from '../raptor-protocol.js';
import { codec } from '../raptor-wasm.js';
function rng(seed){return()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/2**32;};}
const size=Number(process.env.BEAM_BENCH_BYTES||1048576),trials=Number(process.env.BEAM_BENCH_TRIALS||10),random=rng(918);
const bytes=Uint8Array.from({length:size},()=>random()*256),file=new File([bytes],'benchmark.bin');
const summary=[];
for(const loss of [.1,.3,.5])for(const name of ['XOR-v2','RaptorQ-v3']){
 const rows=[];
 for(let trial=0;trial<trials;trial++){
  const api=name==='XOR-v2'?old:rq,prepare=name==='XOR-v2'?old.prepareTransfer:rq.prepareRaptorTransfer;
  const p0=performance.now(),t=await prepare(file,1024),prepareMs=performance.now()-p0;
  const r=name==='XOR-v2'?new old.Receiver():new rq.RaptorReceiver(),drop=rng(19+trial*4973),scheduleRandom=rng(991+trial*349);
  let frames=0,encodeMs=0,decodeMs=0;
  const cpu0=process.cpuUsage(),start=performance.now();
  for(let pass=0;pass<30&&!r.complete;pass++)for(const item of (name==='XOR-v2'?old.makeSchedule(t,pass,scheduleRandom):rq.raptorSchedule(t,pass,scheduleRandom))){
   const a=performance.now(),text=name==='XOR-v2'?old.frameAt(t,item):await rq.raptorFrame(t,item);encodeMs+=performance.now()-a;frames++;
   if(drop()>=loss){const b=performance.now();r.accept(text);decodeMs+=performance.now()-b;}if(r.complete)break;
  }
  const v0=performance.now();const decoded=await r.finish(),verifyMs=performance.now()-v0;
  if(decoded.length!==bytes.length||decoded.some((v,i)=>v!==bytes[i]))throw Error('Byte mismatch');
  const cpu=process.cpuUsage(cpu0);
  rows.push({frames,prepareMs,encodeMs,decodeMs,verifyMs,wallMs:performance.now()-start,cpuMs:(cpu.user+cpu.system)/1000,wasmMiB:codec().memory.buffer.byteLength/2**20});
  t.dispose?.();r.dispose?.();
 }
 const mean=k=>+(rows.reduce((a,r)=>a+r[k],0)/rows.length).toFixed(2);
 summary.push({codec:name,loss:loss*100,trials,bytes:size,successes:rows.length,frames:mean('frames'),simulatedSecondsAt20fps18QR:+(mean('frames')/360).toFixed(2),prepareMs:mean('prepareMs'),encodeMs:mean('encodeMs'),decodeMs:mean('decodeMs'),verifyMs:mean('verifyMs'),cpuMs:mean('cpuMs'),wallMs:mean('wallMs'),wasmHighWaterMiB:name==='RaptorQ-v3'?mean('wasmMiB'):null});
 console.log(JSON.stringify(summary.at(-1)));
}
await writeFile(new URL('../docs/benchmark-results.json',import.meta.url),JSON.stringify(summary,null,2)+'\n');
