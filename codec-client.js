// UI facade: the persistent codec worker survives camera/render worker restarts.
let worker=null,nextId=0,sendGeneration=0,receiveGeneration=0;
const pending=new Map();
function request(data){
 if(!worker){
  worker=new Worker('./codec-worker.js',{type:'module'});
  worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);};
  worker.onerror=()=>{for(const p of pending.values())p.reject(Error('The offline codec worker could not run. Reload Beam and try again.'));pending.clear();worker?.terminate();worker=null;};
 }
 return new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});try{worker.postMessage({...data,id});}catch(e){pending.delete(id);reject(e);}});
}
export async function prepareTransfer(file,blockSize,kind){
 const generation=++sendGeneration;
 const t=await request({op:'prepare',file,blockSize,kind,generation});
 return {...t,generation,dataFrame:()=>t.sample,parityFrame:()=>t.sample,dispose:()=>request({op:'disposeSender',generation})};
}
// A lazy schedule avoids O(file size) allocations and rebuilding a giant array
// on every repair pass. Packet generation happens only for queued QR batches.
export function makeSchedule(t,pass=0){
 const symbols=b=>Math.max(1,Math.min(1024,t.count-b*1024));
 const dataLength=t.count;
 // A fixed period aliases cameras sampling every 2nd/4th frame. Jitter
 // metadata gaps with a small periodic table while keeping lazy O(1) lookup.
 const baseGaps=[29,31,35,30,33,32,34],gaps=baseGaps.map((_,i)=>baseGaps[(i+pass)%baseGaps.length]);
 const cumulative=[];let sum=0;for(const gap of gaps){sum+=gap;cumulative.push(sum);}
 const starts=[0];let cursor=0;for(let i=0;i<gaps.length-1;i++){cursor+=gaps[i]+1;starts.push(cursor);}
 const periodData=sum,periodFrames=sum+gaps.length;
 const manifests=Math.floor(dataLength/periodData)*gaps.length+cumulative.filter(n=>n<=dataLength%periodData).length;
 const length=1+dataLength+manifests;
 // Prefix table for 64-symbol repair runs; one entry per run, not per symbol.
 const runs=[];
 if(pass)for(let start=0;start<1024;start+=64)for(let j=0;j<t.blocks;j++){
  const b=(j+pass-1)%t.blocks,n=Math.max(0,Math.min(64,symbols(b)-start));
  if(n)runs.push({b,start,n,end:n+(runs.at(-1)?.end||0)});
 }
 return {length,at(i){
  const cycle=Math.floor(i/periodFrames),position=i%periodFrames;
  if(starts.includes(position))return [0,0];
  const index=cycle*periodData+position-starts.filter(n=>n<=position).length;
  if(!pass)return [1,index];
  let lo=0,hi=runs.length-1;while(lo<hi){const mid=(lo+hi)>>>1;if(index<runs[mid].end)hi=mid;else lo=mid+1;}
  const r=runs[lo],offset=index-(lo?runs[lo-1].end:0)+r.start;
  return [3,r.b,(pass-1)*symbols(r.b)+offset];
 }};
}
export function frameAt(t,item){return request({op:'frames',generation:t.generation,items:[item]}).then(a=>a[0]);}
export function framesAt(t,items){return request({op:'frames',generation:t.generation,items});}
export class Receiver {
 constructor(){this.generation=++receiveGeneration;this.meta=null;this.pending=[];this.count=0;this.blockSize=0;this.startedAt=0;this.verified=false;this.received=0;this.collected=0;this.receivedBytes=0;this.recovered=0;this.rejected=0;this.duplicates=0;this.foreign=0;this.complete=false;}
 async accept(text){const a=await request({op:'accept',text,generation:this.generation});if(a.status)Object.assign(this,a.status);return a.result;}
 async finish(){const a=await request({op:'finish',generation:this.generation});Object.assign(this,a.status);return new Uint8Array(a.buffer);}
 dispose(){return request({op:'reset',generation:this.generation+1});}
}
