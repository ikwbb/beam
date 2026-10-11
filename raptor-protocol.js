import { preparePayload, packet, unbase45, crc32, hex, BLOCK_SIZES, Receiver, transform, sha256 } from './protocol.js';
import { codec } from './raptor-wasm.js';
export const SOURCE_SYMBOLS = 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_ESI = 0xffffff;
export function progressPercent(r) { return r.verified ? 100 : r.count ? Math.min(99, Math.floor(100 * r.collected / r.count)) : 0; }
function output(w) { return new Uint8Array(w.memory.buffer,w.output_ptr(),w.output_len()).slice(); }
function input(w,bytes,fn) {
 const ptr=w.alloc(bytes.length);
 try {new Uint8Array(w.memory.buffer,ptr,bytes.length).set(bytes);return fn(ptr);} finally {w.dealloc(ptr,bytes.length);}
}
export async function prepareRaptorTransfer(file,blockSize=1024,kind='file') {
 const base=await preparePayload(file,blockSize,kind); const w=codec();
 const meta={...base.meta,codec:'raptorq-rfc6330',sourceSymbols:SOURCE_SYMBOLS};
 const manifest=packet(0,base.id,0,base.count,blockSize,encoder.encode(JSON.stringify(meta)),3);
 const caches=new Map();
 const t={id:base.id,meta,count:base.count,blockSize,manifest,packed:base.packed,blocks:Math.ceil(base.count/SOURCE_SYMBOLS),caches,cacheLimit:Math.max(1,Math.floor(32*2**20/(SOURCE_SYMBOLS*blockSize))),
  blockLength(b){return Math.max(1,Math.min(SOURCE_SYMBOLS*blockSize,this.packed.length-b*SOURCE_SYMBOLS*blockSize));},
  symbols(b){return Math.ceil(this.blockLength(b)/blockSize);},
  dispose(){for(const h of caches.values())w.encoder_free(h);caches.clear();},
  dataFrame(i){return symbolFrame(this,Math.floor(i/SOURCE_SYMBOLS),i%SOURCE_SYMBOLS,this.packed.subarray(i*blockSize,(i+1)*blockSize));},
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
  const start=index*SOURCE_SYMBOLS*t.blockSize;const data=t.packed.subarray(start,start+t.blockLength(index));
  h=input(w,data.length?data:new Uint8Array(1),p=>w.encoder_new(p,t.blockLength(index),t.blockSize));t.caches.set(index,h);
 }
 // RFC6330 has a finite 24-bit ESI space. At exhaustion cycle valid repair
 // symbols; do not overflow or silently emit invalid identifiers.
 const esi=w.encoder_repair(h,offset%(MAX_ESI-t.symbols(index)+1));
 return symbolFrame(t,index,esi,output(w));
}
export class RaptorReceiver {
 constructor(){this.reset();}
 reset(){this.dispose();this.meta=null;this.key=null;this.pending=[];this.count=0;this.blockSize=0;this.version=3;this.startedAt=0;this.verified=false;this.verifying=null;this.received=0;this.collected=0;this.receivedBytes=0;this.recovered=0;this.rejected=0;this.duplicates=0;this.foreign=0;this.states=new Map();this.completed=new Map();this.generation=(this.generation||0)+1;}
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
    if((m.encoding==='raw'&&m.size!==m.packedSize)||(m.encoding==='gzip'&&!m.packedSize)||Math.max(1,Math.ceil(m.packedSize/f.blockSize))!==f.count)throw 0;
   }catch{this.rejected++;return 'rejected';}
   if(this.meta){if(JSON.stringify(m)!==JSON.stringify(this.meta)||this.count!==f.count||this.blockSize!==f.blockSize){this.rejected++;return 'rejected';}this.duplicates++;return 'duplicate';}
   this.meta=m;this.key=f.key;this.count=f.count;this.blockSize=f.blockSize;this.startedAt=Date.now();
   const pending=this.pending;this.pending=[];for(const p of pending)if(p.key===this.key)this.add(p);return 'manifest';
  }
  if(!this.meta){if(!this.pending.some(p=>p.key===f.key&&p.block===f.block&&p.esi===f.esi))this.pending.push(f);if(this.pending.length>128)this.pending.shift();return 'waiting';}
  return this.add(f);
 }
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
  const before=Math.min(k,s.seen.size-1);this.collected+=Math.min(k,s.seen.size)-before;
  const complete=input(w,f.payload.subarray(4),p=>w.decoder_add(s.handle,f.esi,p,this.blockSize));
  if(complete){
   this.completed.set(f.block,output(w).slice(0,len));w.decoder_free(s.handle);this.states.delete(f.block);
   this.received+=k;this.recovered+=k-s.sources;
  }
  // Unique symbols estimate useful work, not proof of rank or completion.
  this.receivedBytes=Math.min(this.meta.packedSize,this.collected*this.blockSize);
  return this.complete?'complete':'accepted';
 }
 async finish(){if(!this.complete)throw Error('File is still incomplete.');if(!this.verifying)this.verifying=this.verify();return this.verifying;}
 async verify(){
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
 dispose(){this.impl?.dispose?.();}
}
for(const key of ['meta','key','pending','count','blockSize','version','startedAt','verified','received','collected','receivedBytes','recovered','rejected','duplicates','foreign','complete'])Object.defineProperty(CompatibleReceiver.prototype,key,{get(){return this.current[key];}});
