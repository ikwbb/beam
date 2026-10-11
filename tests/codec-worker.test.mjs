import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { renderStandalone } from '../build-standalone.mjs';
import { makeSchedule } from '../codec-client.js';
const html=await renderStandalone(),sources=JSON.parse(html.match(/<script id="beam-worker-sources" type="application\/json">([\s\S]*?)<\/script>/)[1]);
function embeddedWorker(){
 let sequence=0;const pending=new Map();const sandbox={console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,DataView,WebAssembly,atob,Blob,File,CompressionStream,DecompressionStream,crypto,fetch(){throw Error('Network forbidden');},postMessage(data){const p=pending.get(data.id);pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);}};
 sandbox.self=sandbox;vm.createContext(sandbox);vm.runInContext(sources.codec,sandbox);
 return async data=>{const id=++sequence;const promise=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));sandbox.onmessage({data:{...data,id}});return promise;};
}
test('actual embedded RaptorQ worker prepares, repairs, receives and verifies with networking forbidden',async()=>{
 const rpc=embeddedWorker(),bytes=crypto.getRandomValues(new Uint8Array(18000));
 const t=await rpc({op:'prepare',generation:1,file:new File([bytes],'worker.bin'),blockSize:384,kind:'file'});
 assert.match(t.manifest,/^B3:/);assert.equal((await rpc({op:'accept',generation:1,text:t.manifest})).result,'manifest');
 let status;
 for(let pass=1;pass<4;pass++){
  const s=makeSchedule(t,pass),items=Array.from({length:s.length},(_,i)=>s.at(i));
  const texts=await rpc({op:'frames',generation:1,items});
  for(const text of texts){status=(await rpc({op:'accept',generation:1,text})).status;if(status.complete)break;}
  if(status.complete)break;
 }
 assert.equal(status.complete,true);assert.equal(status.verified,false);
 const done=await rpc({op:'finish',generation:1});assert.equal(done.status.verified,true);assert.deepEqual(new Uint8Array(done.buffer),bytes);
});
test('worker generations prevent old preparation and old receive replies contaminating a reset',async()=>{
 const rpc=embeddedWorker();const t=await rpc({op:'prepare',generation:1,file:new File(['state'],'state.txt'),blockSize:384,kind:'text'});
 await rpc({op:'accept',generation:1,text:t.manifest});await rpc({op:'reset',generation:2});
 assert.equal((await rpc({op:'accept',generation:1,text:t.sample})).result,'stale');
 await assert.rejects(rpc({op:'finish',generation:1}),/cleared/);
 await rpc({op:'prepare',generation:2,file:new File(['next'],'next.txt'),blockSize:384,kind:'text'});
 await assert.rejects(rpc({op:'frames',generation:1,items:[[0,0]]}),/replaced/);
});
test('lazy scheduler covers all originals once before repairs and uses increasing RFC ESIs',async()=>{
 for(const count of [1,31,32,1024,1025,8193,132096]){
  const t={count,blocks:Math.ceil(count/1024)};
  const s=makeSchedule(t,0),items=Array.from({length:s.length},(_,i)=>s.at(i)).filter(a=>a[0]!==0);
  assert.deepEqual(items.map(a=>a[1]),Array.from({length:count},(_,i)=>i));
  for(const pass of [1,2]){const schedule=makeSchedule(t,pass),repair=Array.from({length:schedule.length},(_,i)=>schedule.at(i)).filter(a=>a[0]!==0);assert.equal(repair.length,count);assert.equal(new Set(repair.map(a=>a.slice(1).join(':'))).size,count);for(const a of repair)assert.ok(a[2]>=(pass-1)*Math.min(1024,count-a[1]*1024));}
 }
});
test('sender disposal releases codec state and an old disposal cannot discard its replacement',async()=>{
 const rpc=embeddedWorker();
 await rpc({op:'prepare',generation:1,file:new File(['old'],'old.txt'),blockSize:384,kind:'text'});
 await rpc({op:'disposeSender',generation:1});await assert.rejects(rpc({op:'frames',generation:1,items:[[0,0]]}),/replaced/);
 const t=await rpc({op:'prepare',generation:2,file:new File(['new'],'new.txt'),blockSize:384,kind:'text'});
 await rpc({op:'disposeSender',generation:1});assert.equal((await rpc({op:'frames',generation:2,items:[[0,0]]}))[0],t.manifest);
});
test('lazy metadata cadence stays visible at every phase of fixed-rate sampling',()=>{
 const t={count:4096,blocks:4},s=makeSchedule(t,0);
 for(const stride of [2,4,5,8])for(let phase=0;phase<stride;phase++){
  let found=false;for(let i=phase;i<Math.min(s.length,512);i+=stride)if(s.at(i)[0]===0){found=true;break;}
  assert.ok(found,`missing manifest: stride ${stride}, phase ${phase}`);
 }
});
