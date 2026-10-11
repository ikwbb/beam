import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRaptorTransfer, RaptorReceiver, raptorSchedule, raptorFrame, progressPercent } from '../raptor-protocol.js';
function rng(seed=17) { return () => { seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5; return (seed>>>0)/2**32; }; }
const random=rng();
const bytes=Uint8Array.from({length:1300*384-19},()=>random()*256);
for (const loss of [0,.1,.3,.5]) test(`RaptorQ verified recovery at ${loss*100}% loss`,async()=>{
 const t=await prepareRaptorTransfer(new File([bytes],'test.bin'),384); const r=new RaptorReceiver(); const random=rng(37);
 let sent=0;
 for(let pass=0;pass<15&&!r.complete;pass++) for(const item of raptorSchedule(t,pass)) {
  const text=await raptorFrame(t,item);sent++; if(random()>=loss) r.accept(text); if(r.complete)break;
 }
 assert.ok(r.complete,`incomplete after ${sent}`); assert.equal(progressPercent(r),99);
 assert.deepEqual(await r.finish(),bytes); assert.equal(progressPercent(r),100); t.dispose();r.dispose();
});
test('repair-only late join and permanently missing originals',async()=>{
 const t=await prepareRaptorTransfer(new File([bytes],'late.bin'),384); const r=new RaptorReceiver();
 for(let pass=1;pass<5&&!r.complete;pass++)for(const item of raptorSchedule(t,pass)){r.accept(await raptorFrame(t,item));if(r.complete)break;}
 assert.ok(r.complete);assert.deepEqual(await r.finish(),bytes);t.dispose();r.dispose();
});
import { packet, unbase45, base45, crc32, prepareTransfer as legacyPrepare, makeSchedule as legacySchedule, frameAt as legacyFrame } from '../protocol.js';
import { CompatibleReceiver, parseRaptorPacket } from '../raptor-protocol.js';
import { readFile } from 'node:fs/promises';
import { codec } from '../raptor-wasm.js';
test('empty, one-symbol and partial-final-block transfers in repair-only mode',async()=>{
 for(const n of [0,1,383,384,385,1024*384+1]){
  const data=Uint8Array.from({length:n},()=>random()*256),t=await prepareRaptorTransfer(new File([data],'edge.bin'),384),r=new RaptorReceiver();
  for(let pass=1;pass<4&&!r.complete;pass++)for(const item of raptorSchedule(t,pass)){r.accept(await raptorFrame(t,item));if(r.complete)break;}
  assert.ok(r.complete,`${n} bytes`);assert.deepEqual(await r.finish(),data);t.dispose();r.dispose();
 }
});
test('late manifest buffering, duplicates, invalid ESI and corrupted CRC',async()=>{
 const t=await prepareRaptorTransfer(new File([bytes],'frame.bin'),384),r=new RaptorReceiver();
 const text=t.dataFrame(0);assert.equal(r.accept(text),'waiting');assert.equal(r.accept(text),'waiting');assert.equal(r.pending.length,1);
 assert.equal(r.accept(t.manifest),'manifest');assert.equal(r.accept(text),'duplicate');
 assert.equal(r.accept(text.slice(0,-1)+'!'),'rejected');
 const a=unbase45(text.slice(3)),v=new DataView(a.buffer);v.setUint32(20,0x1000000);v.setUint32(a.length-4,crc32(a.subarray(0,-4)));
 assert.equal(r.accept('B3:'+base45(a)),'rejected');assert.equal(r.collected,1);
 const other=await prepareRaptorTransfer(new File(['other'],'other.txt'),384);assert.equal(r.accept(other.manifest),'foreign');
 t.dispose();other.dispose();r.dispose();
});
test('SHA-256 rejects a tampered symbol with a valid recomputed CRC and stays below 100%',async()=>{
 const t=await prepareRaptorTransfer(new File([bytes.subarray(0,900)],'corrupt.bin'),384),r=new RaptorReceiver();r.accept(t.manifest);
 for(let i=0;i<t.count;i++){
  let text=t.dataFrame(i);
  if(!i){const a=unbase45(text.slice(3));a[24]^=1;new DataView(a.buffer).setUint32(a.length-4,crc32(a.subarray(0,-4)));text='B3:'+base45(a);}
  r.accept(text);
 }
 assert.ok(r.complete);assert.equal(progressPercent(r),99);await assert.rejects(r.finish(),/verification failed/);assert.equal(progressPercent(r),99);t.dispose();r.dispose();
});
test('compatibility receiver reads legacy B1 and B2, and does not mix protocol versions',async()=>{
 const t=await legacyPrepare(new File([bytes.subarray(0,4000)],'legacy.bin'),384);
 for(const version of [1,2]){
  const r=new CompatibleReceiver();
  for(const item of legacySchedule(t)){
   let text=legacyFrame(t,item);
   if(version===1){const a=unbase45(text.slice(3));a[0]=1;new DataView(a.buffer).setUint32(a.length-4,crc32(a.subarray(0,-4)));text='B1:'+base45(a);}
   r.accept(text);
  }
  assert.deepEqual(await r.finish(),bytes.subarray(0,4000));r.dispose();
 }
});
test('distributed local wasm exactly matches embedded binary',async()=>{
 const source=await readFile(new URL('../raptor-wasm.js',import.meta.url),'utf8');const embedded=Buffer.from(source.match(/atob\("([^"]+)"\)/)[1],'base64');
 assert.deepEqual(embedded,await readFile(new URL('../vendor/raptorq.wasm',import.meta.url)));assert.ok(codec().memory.buffer.byteLength>0);
});
test('large sender repair cache stays within its configured block budget',async()=>{
 const t=await prepareRaptorTransfer(new File([bytes],'cache.bin'),384);t.cacheLimit=1;
 await raptorFrame(t,[3,0,0]);await raptorFrame(t,[3,1,0]);assert.equal(t.caches.size,1);
 const r=new RaptorReceiver();r.accept(t.manifest);
 for(let pass=1;pass<4&&!r.complete;pass++)for(const item of raptorSchedule(t,pass)){r.accept(await raptorFrame(t,item));if(r.complete)break;}
 assert.deepEqual(await r.finish(),bytes);t.dispose();r.dispose();
});
test('B3 supports source objects beyond RFC single-object 8-bit SBN range',()=>{
 const size=384,count=257*1024,id=new Uint8Array(8).fill(7),r=new RaptorReceiver();
 const meta={name:'many-objects.bin',size:count*size,packedSize:count*size,encoding:'raw',sha256:'0'.repeat(64),kind:'file',codec:'raptorq-rfc6330',sourceSymbols:1024};
 assert.equal(r.accept(packet(0,id,0,count,size,new TextEncoder().encode(JSON.stringify(meta)),3)),'manifest');
 for(let esi=0;esi<1024;esi++){const payload=new Uint8Array(size+4);new DataView(payload.buffer).setUint32(0,esi);r.accept(packet(1,id,256,count,size,payload,3));}
 assert.equal(r.received,1024);assert.ok(r.completed.has(256));assert.equal(r.complete,false);r.dispose();
});
