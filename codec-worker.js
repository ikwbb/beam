import { prepareRaptorTransfer, raptorFrame, CompatibleReceiver } from './raptor-protocol.js';
import { DiskTarget } from './disk-transfer.js';
let transfer=null, transferGeneration=0, receiver=new CompatibleReceiver(), receiverGeneration=0, latestPreparation=0;
function status(r){
 const out={};for(const key of ['meta','key','count','blockSize','version','startedAt','verified','received','collected','receivedBytes','recovered','rejected','duplicates','foreign','complete','needsDisk','diskReady','saveRetry'])out[key]=r[key];
 out.pending=Array(r.pending.length).fill(null);return out;
}
// Serialize asynchronous preparation/verification with subsequent messages.
// This queue also ensures one owner of every WASM handle.
let queue=Promise.resolve();
self.onmessage=({data})=>{
 if(data.op==='prepare'||data.op==='cancelPreparation')latestPreparation=Math.max(latestPreparation,data.generation);
 queue=queue.then(async()=>{
 try{
  let result,transfers=[];
  if(data.op==='prepare'){
   if(data.generation!==latestPreparation)throw Error('File preparation cancelled.');
   transfer?.dispose();transfer=null;
   transfer=await prepareRaptorTransfer(data.file,data.blockSize,data.kind,{progress:(loaded,total)=>{if(data.generation!==latestPreparation)throw Error('File preparation cancelled.');if(loaded===total||loaded%(64*2**20)===0)self.postMessage({id:data.id,progress:[loaded,total]});}});transferGeneration=data.generation;
   result={id:transfer.id,meta:transfer.meta,count:transfer.count,blockSize:transfer.blockSize,manifest:transfer.manifest,blocks:transfer.blocks,sample:await transfer.dataFrame(0)};
  }else if(data.op==='cancelPreparation'){result=true;
  }else if(data.op==='frames'){
   if(!transfer||data.generation!==transferGeneration)throw Error('This prepared transfer was replaced.');
   result=[];for(const item of data.items)result.push(await raptorFrame(transfer,item));
  }else if(data.op==='accept'){
   if(data.generation<receiverGeneration){result={result:'stale',status:null};}
   else{
    if(data.generation>receiverGeneration){await receiver.dispose().catch(()=>{});receiver=new CompatibleReceiver();receiverGeneration=data.generation;}
    result={result:await receiver.receive(data.text),status:status(receiver)};
   }
  }else if(data.op==='setDestination'){
   if(data.generation!==receiverGeneration||!receiver.needsDisk)throw Error('No large transfer is waiting for a destination.');
   if(receiver.saveRetry)receiver.changeDestination(data.destination);
   else if(!receiver.diskReady){const disk=await DiskTarget.open(data.destination);await receiver.setDisk(disk);}
   else throw Error('A destination is already selected.');
   result=status(receiver);
  }else if(data.op==='finish'){
   if(data.generation!==receiverGeneration)throw Error('Transfer was cleared during verification.');
   try{
    const verified=await receiver.finish();
    if(verified===null)result={saved:true,status:status(receiver)};
    else {const bytes=verified.slice();result={buffer:bytes.buffer,status:status(receiver)};transfers=[bytes.buffer];}
   }catch(error){result={finishError:error.message||String(error),status:status(receiver)};}
  }else if(data.op==='reset'){
   if(data.generation>=receiverGeneration){await receiver.dispose().catch(()=>{});receiver=new CompatibleReceiver();receiverGeneration=data.generation;}result=true;
  }else if(data.op==='disposeSender'){
   if(data.generation===transferGeneration){transfer?.dispose();transfer=null;}result=true;
  }else throw Error('Unknown codec operation');
  self.postMessage({id:data.id,result},transfers);
 }catch(error){self.postMessage({id:data.id,error:error.message||String(error)});}
}).catch(error=>self.postMessage({id:data.id,error:error.message||String(error)}));};
