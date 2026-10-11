import { prepareRaptorTransfer, raptorFrame, CompatibleReceiver } from './raptor-protocol.js';
let transfer=null, transferGeneration=0, receiver=new CompatibleReceiver(), receiverGeneration=0;
function status(r){
 const out={};for(const key of ['meta','key','count','blockSize','version','startedAt','verified','received','collected','receivedBytes','recovered','rejected','duplicates','foreign','complete'])out[key]=r[key];
 out.pending=Array(r.pending.length).fill(null);return out;
}
// Serialize asynchronous preparation/verification with subsequent messages.
// This queue also ensures one owner of every WASM handle.
let queue=Promise.resolve();
self.onmessage=({data})=>{queue=queue.then(async()=>{
 try{
  let result,transfers=[];
  if(data.op==='prepare'){
   transfer?.dispose();transfer=null;
   transfer=await prepareRaptorTransfer(data.file,data.blockSize,data.kind);transferGeneration=data.generation;
   result={id:transfer.id,meta:transfer.meta,count:transfer.count,blockSize:transfer.blockSize,manifest:transfer.manifest,blocks:transfer.blocks,sample:transfer.dataFrame(0)};
  }else if(data.op==='frames'){
   if(!transfer||data.generation!==transferGeneration)throw Error('This prepared transfer was replaced.');
   result=[];for(const item of data.items)result.push(await raptorFrame(transfer,item));
  }else if(data.op==='accept'){
   if(data.generation<receiverGeneration){result={result:'stale',status:null};}
   else{
    if(data.generation>receiverGeneration){receiver.dispose();receiver=new CompatibleReceiver();receiverGeneration=data.generation;}
    result={result:receiver.accept(data.text),status:status(receiver)};
   }
  }else if(data.op==='finish'){
   if(data.generation!==receiverGeneration)throw Error('Transfer was cleared during verification.');
   const bytes=(await receiver.finish()).slice();result={buffer:bytes.buffer,status:status(receiver)};transfers=[bytes.buffer];
  }else if(data.op==='reset'){
   if(data.generation>=receiverGeneration){receiver.dispose();receiver=new CompatibleReceiver();receiverGeneration=data.generation;}result=true;
  }else if(data.op==='disposeSender'){
   if(data.generation===transferGeneration){transfer?.dispose();transfer=null;}result=true;
  }else throw Error('Unknown codec operation');
  self.postMessage({id:data.id,result},transfers);
 }catch(error){self.postMessage({id:data.id,error:error.message||String(error)});}
}).catch(error=>self.postMessage({id:data.id,error:error.message||String(error)}));};
