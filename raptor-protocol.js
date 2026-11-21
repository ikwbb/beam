import { preparePayload, packet, unbase45, crc32, hex, BLOCK_SIZES, Receiver, parsePacket, transform, sha256 } from './protocol.js';
import { codec } from './raptor-wasm.js';
import { MEMORY_LIMIT, hashSlices } from './disk-transfer.js';
export const SOURCE_SYMBOLS = 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_ESI = 0xffffff;
export function progressPercent(r) { return r.verified ? 100 : r.count ? Math.min(99, Math.floor(100 * r.collected / r.count)) : 0; }
function output(w) { return new Uint8Array(w.memory.buffer,w.output_ptr(),w.output_len()).slice(); }
function input(w,bytes,fn) {
 const ptr=w.alloc(bytes.length);
 try {new Uint8Array(w.memory.buffer,ptr,bytes.length).set(bytes);return fn(ptr);} finally {w.dealloc(ptr,bytes.length);}
}
export async function prepareRaptorTransfer(file,blockSize=1024,kind='file', { hashFile=hashSlices, progress }={}) {
 const disk=file.size>MEMORY_LIMIT;
 if(disk&&kind==='text')throw Error('Save the text as a file and select it from the file tab.');
 if(disk&&(!Number.isSafeInteger(file.size)||!BLOCK_SIZES.includes(blockSize)||Math.ceil(file.size/blockSize)>0xffffffff))throw Error('This file exceeds Beam’s packet address range.');
 const base=disk?{id:crypto.getRandomValues(new Uint8Array(8)),count:Math.ceil(file.size/blockSize),meta:{name:[...file.name].slice(0,160).join('')||'received-file',size:file.size,packedSize:file.size,encoding:'raw',sha256:await hashFile(file,progress),kind:'file',storage:'disk'}}:await preparePayload(file,blockSize,kind);
 const w=codec();
 const meta={...base.meta,codec:'raptorq-rfc6330',sourceSymbols:SOURCE_SYMBOLS};
 const manifest=packet(0,base.id,0,base.count,blockSize,encoder.encode(JSON.stringify(meta)),3);
 const caches=new Map();
 const t={id:base.id,meta,count:base.count,blockSize,manifest,packed:base.packed,blocks:Math.ceil(base.count/SOURCE_SYMBOLS),caches,cacheLimit:Math.max(1,Math.floor(32*2**20/(SOURCE_SYMBOLS*blockSize))),
  blockLength(b){return Math.max(1,Math.min(SOURCE_SYMBOLS*blockSize,this.meta.packedSize-b*SOURCE_SYMBOLS*blockSize));},
  async readBlock(b){
   const start=b*SOURCE_SYMBOLS*blockSize,end=Math.min(this.meta.packedSize,start+this.blockLength(b));
   if(!disk)return this.packed.subarray(start,end);
   if(this.cachedBlock?.b!==b){const data=new Uint8Array(await file.slice(start,end).arrayBuffer());if(data.length!==end-start)throw Error('The source file changed or could not be read. Select it again.');this.cachedBlock={b,data};}
   return this.cachedBlock.data;
  },
  symbols(b){return Math.ceil(this.blockLength(b)/blockSize);},
  dispose(){for(const h of caches.values())w.encoder_free(h);caches.clear();},
  dataFrame(i){if(disk)return this.readBlock(Math.floor(i/SOURCE_SYMBOLS)).then(data=>symbolFrame(this,Math.floor(i/SOURCE_SYMBOLS),i%SOURCE_SYMBOLS,data.subarray(i%SOURCE_SYMBOLS*blockSize,(i%SOURCE_SYMBOLS+1)*blockSize)));return symbolFrame(this,Math.floor(i/SOURCE_SYMBOLS),i%SOURCE_SYMBOLS,this.packed.subarray(i*blockSize,(i+1)*blockSize));},
  parityFrame(){return this.dataFrame(0);}
 };
 return t;
}
function symbolFrame(t,b,esi,data) {
 const payload=new Uint8Array(t.blockSize+4);new DataView(payload.buffer).setUint32(0,esi);payload.set(data,4);
 return packet(1,t.id,b,t.count,t.blockSize,payload,3);
}
export function parseRaptorPacket(text) {
 if(typeof text!=='string'||!text.startsWith('B3:')||text.length>3200)throw Error('Not a B3 packet');
 const a=unbase45(text.slice(3));if(a.length<24)throw Error('Truncated packet');const v=new DataView(a.buffer);
 if(v.getUint32(a.length-4)!==crc32(a.subarray(0,-4)))throw Error('CRC mismatch');
 const type=a[1],count=v.getUint32(14),size=v.getUint16(18),block=v.getUint32(10);
 if(a[0]!==3||type>1||!count||!BLOCK_SIZES.includes(size)||block>=Math.ceil(count/SOURCE_SYMBOLS)||(type===0&&block!==0))throw Error('Invalid B3 header');
 const payload=a.slice(20,-4);
 if(type===1&&(payload.length!==size+4||new DataView(payload.buffer).getUint32(0)>MAX_ESI))throw Error('Invalid RaptorQ symbol');
 return {type,count,blockSize:size,block,payload,key:hex(a.subarray(2,10)),version:3,esi:type?new DataView(payload.buffer).getUint32(0):0};
}
// Each repair pass sends ~K symbols per object, in 64-symbol runs. The order
// rotates between passes; fresh ESI prevents replaying the same equations.
export function raptorSchedule(t,pass=0,random=Math.random) {
 const frames=[];
 if(!pass)for(let i=0;i<t.count;i++)frames.push([1,i]);
 else for(let start=0;start<SOURCE_SYMBOLS;start+=64)for(let j=0;j<t.blocks;j++) {
  const b=(j+pass-1)%t.blocks,k=t.symbols(b);
  for(let offset=start;offset<Math.min(start+64,k);offset++)frames.push([3,b,(pass-1)*k+offset]);
 }
 const out=[[0,0]];let gap=29+Math.floor(random()*7);
 for(const f of frames){out.push(f);if(--gap===0){out.push([0,0]);gap=29+Math.floor(random()*7);}}
 return out;
}
export async function raptorFrame(t,[type,index,offset]) {
 if(type===0)return t.manifest;if(type===1)return t.dataFrame(index);
 const w=codec();let h=t.caches.get(index);
 if(h){t.caches.delete(index);t.caches.set(index,h);}
 if(!h){
  while(t.caches.size>=t.cacheLimit){const oldest=t.caches.keys().next().value;w.encoder_free(t.caches.get(oldest));t.caches.delete(oldest);}
  const data=await t.readBlock(index);
  h=input(w,data.length?data:new Uint8Array(1),p=>w.encoder_new(p,t.blockLength(index),t.blockSize));t.caches.set(index,h);
 }
 // RFC6330 has a finite 24-bit ESI space. At exhaustion cycle valid repair
 // symbols; do not overflow or silently emit invalid identifiers.
 const esi=w.encoder_repair(h,offset%(MAX_ESI-t.symbols(index)+1));
 return symbolFrame(t,index,esi,output(w));
}
export class RaptorReceiver {
 constructor(){this.reset();}
 reset(){this.dispose();this.meta=null;this.key=null;this.pending=[];this.spilled=new Map();this.count=0;this.blockSize=0;this.version=3;this.startedAt=0;this.verified=false;this.verifying=null;this.received=0;this.collected=0;this.receivedBytes=0;this.recovered=0;this.rejected=0;this.duplicates=0;this.foreign=0;this.states=new Map();this.completed=new Map();this.generation=(this.generation||0)+1;}
 dispose(){if(this.states)for(const s of this.states.values())if(s.handle)codec().decoder_free(s.handle);this.states?.clear();}
 get complete(){return !!this.meta&&this.completed.size===Math.ceil(this.count/SOURCE_SYMBOLS);}
 blockLength(b){return Math.max(1,Math.min(SOURCE_SYMBOLS*this.blockSize,this.meta.packedSize-b*SOURCE_SYMBOLS*this.blockSize));}
 accept(text){
  let f;try{f=parseRaptorPacket(text);}catch{this.rejected++;return 'rejected';}
  if(this.key&&f.key!==this.key){this.foreign++;return 'foreign';}
  if(f.type===0){
   let m;try{
    m=JSON.parse(decoder.decode(f.payload));
    if(!m||typeof m.name!=='string'||!m.name.length||m.name.length>320||!['raw','gzip'].includes(m.encoding)||!/^[0-9a-f]{64}$/.test(m.sha256)||m.codec!=='raptorq-rfc6330'||m.sourceSymbols!==SOURCE_SYMBOLS||!['file','text'].includes(m.kind))throw 0;
    for(const n of [m.size,m.packedSize])if(!Number.isSafeInteger(n)||n<0)throw 0;
    if((m.storage!==undefined&&(m.storage!=='disk'||m.encoding!=='raw'||m.kind!=='file'))||(m.encoding==='raw'&&m.size!==m.packedSize)||(m.encoding==='gzip'&&!m.packedSize)||Math.max(1,Math.ceil(m.packedSize/f.blockSize))!==f.count)throw 0;
   }catch{this.rejected++;return 'rejected';}
   if(this.meta){if(JSON.stringify(m)!==JSON.stringify(this.meta)||this.count!==f.count||this.blockSize!==f.blockSize){this.rejected++;return 'rejected';}this.duplicates++;return 'duplicate';}
   this.meta=m;this.key=f.key;this.count=f.count;this.blockSize=f.blockSize;this.startedAt=Date.now();
   const pending=this.pending;this.pending=[];for(const p of pending)if(p.key===this.key&&!this.needsDisk)this.add(p);return 'manifest';
  }
  if(!this.meta){if(!this.pending.some(p=>p.key===f.key&&p.block===f.block&&p.esi===f.esi))this.pending.push(f);if(this.pending.length>128)this.pending.shift();return 'waiting';}
  if(this.needsDisk)return 'disk-required';
  return this.add(f);
 }
 get needsDisk(){return !!this.meta&&(this.meta.storage==='disk'||Math.max(this.meta.size,this.meta.packedSize)>MEMORY_LIMIT);}
 add(f){
  if(f.count!==this.count||f.blockSize!==this.blockSize){this.rejected++;return 'rejected';}
  if(this.completed.has(f.block)){this.duplicates++;return 'duplicate';}
  const w=codec(),len=this.blockLength(f.block),k=Math.ceil(len/this.blockSize);
  let s=this.states.get(f.block);
  if(!s){s={handle:w.decoder_new(len,this.blockSize),seen:new Set(),sources:0};this.states.set(f.block,s);}
  if(s.seen.has(f.esi)){this.duplicates++;return 'duplicate';}
  // Keep failed objects bounded even if a malicious stream sends endless ESIs.
  if(s.seen.size>=k+64){
   w.decoder_free(s.handle);this.collected-=k;
   s={handle:w.decoder_new(len,this.blockSize),seen:new Set(),sources:0};this.states.set(f.block,s);
  }
  s.seen.add(f.esi);if(f.esi<k)s.sources++;
  if(this.disk){(s.packets??=[]).push(f.payload);}
  const before=Math.min(k,s.seen.size-1);this.collected+=Math.min(k,s.seen.size)-before;
  const complete=input(w,f.payload.subarray(4),p=>w.decoder_add(s.handle,f.esi,p,this.blockSize));
  if(complete){
   const bytes=output(w).subarray(0,len);
   if(this.disk)this.disk.write(f.block*SOURCE_SYMBOLS*this.blockSize,bytes);
   this.completed.set(f.block,this.disk?true:bytes);w.decoder_free(s.handle);this.states.delete(f.block);
   this.received+=k;this.recovered+=k-s.sources;
  }
  // Unique symbols estimate useful work, not proof of rank or completion.
  this.receivedBytes=Math.min(this.meta.packedSize,this.collected*this.blockSize);
  return this.complete?'complete':'accepted';
 }
 async acceptDisk(f){
  if(f.key!==this.key){this.foreign++;return 'foreign';}
  if(f.count!==this.count||f.blockSize!==this.blockSize){this.rejected++;return 'rejected';}
  if(this.completed.has(f.block)){this.duplicates++;return 'duplicate';}
  if(!this.states.has(f.block)){
   if(this.states.size>=16){
    const [block,state]=this.states.entries().next().value;
    await this.disk.spill(block,state.packets);
    (this.spilled??=new Map()).set(block,Math.min(this.symbolsIn(block),state.seen.size));
    codec().decoder_free(state.handle);this.states.delete(block);
   }
   if(this.spilled?.has(f.block)){
    const bytes=await this.disk.load(f.block),stride=this.blockSize+4;
    if(bytes.length%stride)throw Error('A staged block is damaged. Clear and retry.');
    this.collected-=this.spilled.get(f.block);
    for(let at=0;at<bytes.length;at+=stride){
     const payload=bytes.slice(at,at+stride);
     this.add({...f,payload,esi:new DataView(payload.buffer).getUint32(0)});
    }
    await this.disk.remove(f.block);this.spilled.delete(f.block);
   }
  }
  const result=this.add(f);
  const state=this.states.get(f.block);
  if(state){this.states.delete(f.block);this.states.set(f.block,state);}
  return result;
 }
 symbolsIn(block){return Math.ceil(this.blockLength(block)/this.blockSize);}
 async finish(){if(!this.complete)throw Error('File is still incomplete.');if(!this.verifying)this.verifying=this.verify();return this.verifying;}
 async verify(){
  if(this.disk){await this.disk.finish(this.meta);this.verified=true;await this.disk.dispose().catch(()=>{});this.disk=null;return null;}
  if(this.needsDisk)throw Error('Choose a disk destination to receive this file.');
  const generation=this.generation,packed=new Uint8Array(this.meta.packedSize);
  for(const [b,data]of this.completed)packed.set(data.subarray(0,Math.max(0,this.meta.packedSize-b*SOURCE_SYMBOLS*this.blockSize)),b*SOURCE_SYMBOLS*this.blockSize);
  const bytes=this.meta.encoding==='gzip'?await transform(packed,new DecompressionStream('gzip'),this.meta.size):packed;
  if(bytes.length!==this.meta.size||await sha256(bytes)!==this.meta.sha256)throw Error('File verification failed. Clear this transfer and scan again.');
  if(generation!==this.generation)throw Error('Transfer was cleared during verification.');this.verified=true;return bytes;
 }
}
export class CompatibleReceiver {
 constructor(){this.impl=null;this.empty=new Receiver();}
 get current(){return this.impl||this.empty;}
 accept(text){
  if(!this.impl){if(!/^B[123]:/.test(text))return 'rejected';const candidate=text.startsWith('B3:')?new RaptorReceiver():new Receiver();const result=candidate.accept(text);if(result!=='rejected')this.impl=candidate;return result;}
  if((text.startsWith('B3:'))!==(this.impl instanceof RaptorReceiver))return 'foreign';return this.impl.accept(text);
 }
 finish(){return this.current.finish();}
 async dispose(){const disk=this.impl?.disk;this.impl?.dispose?.();await disk?.dispose();}
 get needsDisk(){return this.impl?.needsDisk===true;}
 get diskReady(){return !!this.impl?.disk;}
 get saveRetry(){return !!this.impl?.disk?.hashVerified&&!this.verified;}
 changeDestination(destination){if(!this.saveRetry)throw Error('No verified file is waiting to be saved.');this.impl.disk.destination=destination;this.impl.verifying=null;}
 async setDisk(disk){if(!this.needsDisk||this.diskReady)throw Error('No large transfer is waiting for a destination.');this.impl.disk=disk;}
 async receive(text){
  if(this.diskFailure)throw Error(this.diskFailure);
  if(this.needsDisk&&this.diskReady&&text.startsWith('B3:')){
   let f;try{f=parseRaptorPacket(text);}catch{this.impl.rejected++;return 'rejected';}
   if(f.type===1){
    try{return await this.impl.acceptDisk(f);}
    catch(error){this.diskFailure=`Disk staging stopped: ${error.message}. Check disk space, then clear this transfer and retry.`;throw Error(this.diskFailure);}
   }
  }
  if(!this.current.meta){
   let frame, meta;
   try{
    frame=text.startsWith('B3:')?parseRaptorPacket(text):parsePacket(text);
    if(frame.type===0)meta=JSON.parse(decoder.decode(frame.payload));
   }catch{}
   if(meta&&Math.max(meta.size,meta.packedSize)>MEMORY_LIMIT&&(frame.version!==3||meta.encoding!=='raw'))
    throw Error('Use this version of Beam on the sender to transfer large files without whole-file compression.');
  }
  return this.accept(text);
 }
}
for(const key of ['meta','key','pending','count','blockSize','version','startedAt','verified','received','collected','receivedBytes','recovered','rejected','duplicates','foreign','complete'])Object.defineProperty(CompatibleReceiver.prototype,key,{get(){return this.current[key];}});
