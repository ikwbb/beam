import './vendor/sha256.umd.js';

export const MEMORY_LIMIT = 128 * 2**20;
const CHUNK = 2**20;
const STAGE_PREFIX = 'beam-transfer-';

async function clearAbandoned(root, locks) {
 if(!locks)return;
 for await(const name of root.keys()){
  if(!/^beam-transfer-[0-9a-f-]{36}$/.test(name))continue;
  await locks.request(name,{ifAvailable:true},async lock=>{
   if(lock)await root.removeEntry(name,{recursive:true}).catch(()=>{});
  });
 }
}

async function holdStageLock(locks,name){
 if(!locks)return null;
 return new Promise((ready,reject)=>{
  locks.request(name,()=>new Promise(release=>ready(release))).catch(reject);
 });
}

export async function hashSlices(file, progress) {
 const hash = await globalThis.hashwasm.createSHA256();
 for(let at=0;at<file.size;at+=CHUNK){
  const end=Math.min(file.size,at+CHUNK);
  const bytes=new Uint8Array(await file.slice(at,end).arrayBuffer());
  if(bytes.length!==end-at)throw Error('The file changed or could not be read. Select it again.');
  hash.update(bytes);progress?.(end,file.size);
 }
 return hash.digest();
}

// This directory is private to this receive session, including its partial-block
// spill files. The destination remains untouched until the staged data verifies.
export class DiskTarget {
 static async open(destination){
  const root=await globalThis.navigator?.storage?.getDirectory?.();
  if(!root)throw Error('Browser disk staging is unavailable. Open Beam in desktop Chrome or Edge on localhost or HTTPS.');
  const locks=globalThis.navigator.locks;
  await clearAbandoned(root,locks);
  const name=STAGE_PREFIX+crypto.randomUUID();
  const release=await holdStageLock(locks,name);
  try{
   const dir=await root.getDirectoryHandle(name,{create:true});
   const file=await dir.getFileHandle('payload',{create:true});
   return new DiskTarget(root,name,dir,file,await file.createSyncAccessHandle(),destination,release);
  }catch(e){await root.removeEntry(name,{recursive:true}).catch(()=>{});release?.();throw e;}
 }
 constructor(root,name,dir,file,access,destination,release){Object.assign(this,{root,name,dir,file,access,destination,release});}
 write(at,bytes){
  if(this.access.write(bytes,{at})!==bytes.length)throw Error('Could not write the complete block. Check available disk space.');
 }
 async spill(block,packets){
  const file=await this.dir.getFileHandle('partial-'+block,{create:true});
  const h=await file.createSyncAccessHandle();
  try{
   const data=new Uint8Array(packets.length*packets[0].length);
   for(let i=0;i<packets.length;i++)data.set(packets[i],i*packets[0].length);
   if(h.write(data,{at:0})!==data.length)throw Error('Could not stage the incomplete block. Check available disk space.');
   h.truncate(data.length);
  }finally{h.close();}
 }
 async load(block){
  return new Uint8Array(await (await (await this.dir.getFileHandle('partial-'+block)).getFile()).arrayBuffer());
 }
 async remove(block){await this.dir.removeEntry('partial-'+block);}
 async finish(meta){
  if(this.access){this.access.flush();this.access.close();this.access=null;}
  const file=await this.file.getFile();
  if(!this.hashVerified){
   if(file.size!==meta.size||await hashSlices(file)!==meta.sha256)throw Error('SHA-256 verification failed. The destination was not written.');
   this.hashVerified=true;
  }
  const out=await this.destination.createWritable();
  try{
   // pipeTo can feed browser-dependent chunk sizes; explicit slices guarantee a
   // bounded buffer and await backpressure before reading the next one.
   for(let at=0;at<file.size;at+=CHUNK)await out.write(await file.slice(at,Math.min(file.size,at+CHUNK)).arrayBuffer());
   await out.close();
  }catch(e){await out.abort().catch(()=>{});throw e;}
 }
 async dispose(){
  try{this.access?.close();}finally{this.access=null;try{await this.root.removeEntry(this.name,{recursive:true});}finally{this.release?.();this.release=null;}}
 }
}
