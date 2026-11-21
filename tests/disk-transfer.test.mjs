import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareRaptorTransfer, RaptorReceiver, parseRaptorPacket, raptorFrame } from '../raptor-protocol.js';
import { hashSlices, DiskTarget } from '../disk-transfer.js';

test('24 GiB geometry, sender reads bounded slices past the 4 GiB boundary', async () => {
 const size=24*2**30+17, reads=[];
 const file={name:'huge.bin',size,arrayBuffer(){assert.fail('whole-file read');},slice(start,end){
  assert.ok(end-start<=2**20);reads.push(start);return new Blob([new Uint8Array(end-start).fill(Math.floor(start/2**20)%251)]);
 }};
 const t=await prepareRaptorTransfer(file,1024,'file',{hashFile:async f=>{assert.equal(f,file);return 'a'.repeat(64);}});
 assert.equal(t.count,Math.ceil(size/1024));assert.equal(t.meta.storage,'disk');
 const p=parseRaptorPacket(await raptorFrame(t,[1,t.count-1]));assert.ok(p.block>4096);assert.equal(reads.at(-1),24*2**30);
 const repair=parseRaptorPacket(await raptorFrame(t,[3,t.blocks-1,0]));assert.equal(repair.block,p.block);t.dispose();
});
test('incremental SHA-256 matches Node across chunk boundaries',async()=>{
 const bytes=new Uint8Array(2**20+17).fill(231);
 assert.equal(await hashSlices(new Blob([bytes])),createHash('sha256').update(bytes).digest('hex'));
});
import { diskFixture } from './node-disk.mjs';
import { CompatibleReceiver } from '../raptor-protocol.js';
import { packet } from '../protocol.js';

test('disk-backed RaptorQ spills partial objects, recovers out-of-order drops and saves verified bytes',async()=>{
 const fs=await diskFixture(),size=17*1024*384+91,r=new CompatibleReceiver();
 const bytes=Uint8Array.from({length:size},(_,i)=>((i*17)^(i>>>7))&255);
 try{
  // Force disk receive for a small fixture, reusing an ordinary raw coded file.
  const t=await prepareRaptorTransfer(new File([bytes],'fixture'),384);
  t.packed=bytes;t.meta={...t.meta,size,packedSize:size,encoding:'raw',storage:'disk'};t.count=Math.ceil(size/384);t.blocks=Math.ceil(t.count/1024);
  const manifest=packet(0,t.id,0,t.count,384,new TextEncoder().encode(JSON.stringify(t.meta)),3);
  assert.equal(await r.receive(manifest),'manifest');
  assert.equal(await r.receive(t.dataFrame(0)),'disk-required');
  await r.setDisk(await fs.open());
  for(let b=0;b<t.blocks;b++)await r.receive(t.dataFrame(b*1024));
  assert.ok(r.impl.states.size<=16);assert.ok(r.impl.spilled.size>=2);
  for(let b=t.blocks-1;b>=0;b--){
   const k=t.symbols(b);
   for(let i=1;i<k;i++)if(i%19)await r.receive(t.dataFrame(b*1024+i));
   for(let i=0;i<Math.floor((k-1)/19)+5;i++)await r.receive(await raptorFrame(t,[3,b,i]));
   assert.ok(r.impl.states.size<=16);
  }
  assert.ok(r.complete);assert.equal(r.impl.spilled.size,0);assert.ok(r.recovered>0);
  assert.equal(r.verified,false);assert.equal(await r.finish(),null);assert.equal(r.verified,true);
  const saved=await fs.destination.getFile();assert.deepEqual(new Uint8Array(await saved.arrayBuffer()),bytes);
  t.dispose();
 }finally{await r.dispose();await fs.dispose();}
});

test('verified staging survives a failed save; bad SHA never opens the destination',async()=>{
 const fs=await diskFixture();
 try{
  const data=new Uint8Array([1,2,3,4]);
  const meta={size:data.length,sha256:createHash('sha256').update(data).digest('hex')};
  const sink=await DiskTarget.open({async createWritable(){throw Error('destination full');}});
  sink.write(0,data);
  await assert.rejects(sink.finish({...meta,sha256:'0'.repeat(64)}),/SHA-256/);
  assert.equal(sink.hashVerified,undefined);
  await assert.rejects(sink.finish(meta),/destination full/);assert.equal(sink.hashVerified,true);
  sink.destination=fs.destination;await sink.finish(meta);await sink.dispose();
  assert.deepEqual(new Uint8Array(await (await fs.destination.getFile()).arrayBuffer()),data);
 }finally{await fs.dispose();}
});

test('a legacy oversized gzip manifest does not wedge the next transfer',async()=>{
 const r=new CompatibleReceiver(),t=await prepareRaptorTransfer(new File(['plain'],'small'),384);
 const meta={...t.meta,size:24*2**30,encoding:'gzip'};
 const legacy=packet(0,t.id,0,t.count,t.blockSize,new TextEncoder().encode(JSON.stringify(meta)),3);
 await assert.rejects(r.receive(legacy),/without whole-file compression/);
 assert.equal(r.meta,null);assert.equal(await r.receive(t.manifest),'manifest');
 t.dispose();await r.dispose();
});

test('disk target preserves byte offsets above 4 GiB',async()=>{
 const fs=await diskFixture();
 try{
  const sink=await fs.open(),at=4*2**30+19;
  sink.write(at,new Uint8Array([7,8,9]));
  const {open}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const file=await open(join(fs.path,sink.name,'payload'),'r');
  try{
   assert.equal((await file.stat()).size,at+3);
   const data=new Uint8Array(3);assert.equal((await file.read(data,0,3,at)).bytesRead,3);
   assert.deepEqual([...data],[7,8,9]);
  }finally{await file.close();await sink.dispose();}
 }finally{await fs.dispose();}
});
