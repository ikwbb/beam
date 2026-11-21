// Optional: node tests/disk-sender-sparse.mjs <24GiB+17 sparse file> <SHA-256>
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { prepareRaptorTransfer, parseRaptorPacket, raptorFrame } from '../raptor-protocol.js';
const [path,expected]=process.argv.slice(2),file=await open(path,'r');
const size=(await file.stat()).size;
try{
const start=performance.now();
const t=await prepareRaptorTransfer({name:basename(path),size,slice:(start,end)=>({async arrayBuffer(){
 const out=new Uint8Array(end-start);let offset=0;
 while(offset<out.length){const {bytesRead}=await file.read(out,offset,out.length-offset,start+offset);if(!bytesRead)throw Error('Unexpected EOF');offset+=bytesRead;}
 return out.buffer;
}})},1024,'file',{
 progress:(read,total)=>{if(read%(4*2**30)===0||read===total)console.log(`Hashed ${read} / ${total} bytes`);}
});
assert.equal(t.meta.size,24*2**30+17);assert.equal(t.meta.sha256,expected);
for(const frame of [[1,t.count-1],[3,t.blocks-1,0]]){
 const f=parseRaptorPacket(await raptorFrame(t,frame));assert.equal(f.block,24576);
 if(frame[0]===1)assert.deepEqual([...f.payload.slice(4,21)],Array.from({length:17},(_,i)=>i+1));
}
t.dispose();
console.log(`24 GiB sender verified: ${t.meta.sha256}; ${((performance.now()-start)/1000).toFixed(1)}s; RSS ${Math.round(process.memoryUsage().rss/2**20)} MiB`);

}finally{await file.close();}
