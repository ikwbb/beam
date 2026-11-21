// File-system adapter for exercising the production DiskTarget on Node.
import { openAsBlob, closeSync, openSync, writeSync, fsyncSync, ftruncateSync } from 'node:fs';
import { mkdtemp, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiskTarget } from '../disk-transfer.js';
function fileAt(path){
 return {
  getFile:()=>openAsBlob(path),
  async createWritable(){
   const h=await open(path,'w');
   return {async write(data){await h.writeFile(new Uint8Array(data));},close:()=>h.close(),abort:()=>h.close()};
  },
  async createSyncAccessHandle(){
   const fd=openSync(path,'r+');
   return {write:(bytes,{at})=>writeSync(fd,bytes,0,bytes.length,at),truncate:size=>ftruncateSync(fd,size),flush:()=>fsyncSync(fd),close:()=>closeSync(fd)};
  }
 };
}
function directory(path){
 return {
  async *keys(){yield* await readdir(path);},
  async getDirectoryHandle(name,{create}={}){const p=join(path,name);if(create)await mkdir(p,{recursive:true});return directory(p);},
  async getFileHandle(name,{create}={}){const p=join(path,name);if(create)await (await open(p,'a')).close();return fileAt(p);},
  removeEntry:(name,opts)=>rm(join(path,name),opts)
 };
}
export async function diskFixture(){
 const path=await mkdtemp(join(tmpdir(),'beam-disk-test-'));
 const root=directory(path),descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{getDirectory:async()=>root}}});
 const destination=fileAt(join(path,'output.bin'));
 return {path,destination,open:()=>DiskTarget.open(destination),async dispose(){
  if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;
  await rm(path,{recursive:true,force:true});
 }};
}
