// Real Chromium module workers + WASM, HTTP and fully embedded file:// page.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(new URL('../',import.meta.url).pathname),types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm'};
const server=http.createServer(async(req,res)=>{try{const p=resolve(root,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));if(!p.startsWith(root+'/'))throw 0;res.setHeader('Content-Type',types[extname(p)]||'application/octet-stream');res.end(await readFile(p));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.BEAM_CHROME_EXECUTABLE||undefined});const errors=[];
try{
 for(const url of [origin,'file://'+root+'/standalone.html']){
  const page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',e=>errors.push(e.message));
  if(url.startsWith('file:'))await page.route('http**/*',route=>route.abort());
  await page.goto(url);await page.locator('#file-input').setInputFiles({name:'smoke.bin',mimeType:'application/octet-stream',buffer:Buffer.from(Array.from({length:20000},(_,i)=>i*37%256))});
  await page.waitForFunction(()=>!document.getElementById('send-start').disabled&&document.getElementById('send-status').textContent==='READY TO SEND');
  await page.locator('#send-start').click();await page.waitForFunction(()=>document.getElementById('send-status').textContent==='SIGNAL LIVE');
  await page.waitForFunction(()=>document.getElementById('send-loop').textContent.includes('FPS'));
  const decoded=await page.evaluate(async()=>{
   // Verify the actual sender's canvas contains B3, using the bundled scanner.
   const canvas=document.getElementById('qr-canvas'),ctx=canvas.getContext('2d');
   if(location.protocol==='file:')return {width:canvas.width,height:canvas.height};
   const {decodeDetections}=await import('./decoder.js');const result=await decodeDetections(ctx.getImageData(0,0,canvas.width,canvas.height));return result.map(r=>r.text);
  });
  if(Array.isArray(decoded))assert.ok(decoded.some(t=>t.startsWith('B3:')),JSON.stringify(decoded));else assert.ok(decoded.width>0);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.getElementById('send-status').textContent==='SIGNAL PAUSED');
  assert.equal(await page.evaluate(()=>!!document.fullscreenElement),false);
  console.log(`PASS sender with actual QR/RaptorQ worker: ${url.startsWith('file:')?'offline standalone':'HTTP app'}`);await page.close();
 }
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  globalThis.__frames=[];
  globalThis.BarcodeDetector=class{static async getSupportedFormats(){return ['qr_code'];}async detect(){return globalThis.__frames.splice(0,24).map(rawValue=>({rawValue,cornerPoints:[{x:10,y:10},{x:110,y:10},{x:110,y:110},{x:10,y:110}]}));}};
  Object.defineProperty(HTMLVideoElement.prototype,'readyState',{get:()=>2});Object.defineProperty(HTMLVideoElement.prototype,'videoWidth',{get:()=>640});Object.defineProperty(HTMLVideoElement.prototype,'videoHeight',{get:()=>480});let clock=0;Object.defineProperty(HTMLVideoElement.prototype,'currentTime',{get:()=>++clock});HTMLVideoElement.prototype.play=async()=>{};
  navigator.mediaDevices.getUserMedia=async()=>document.createElement('canvas').captureStream();
 });
 await page.goto(origin);await page.locator('#receive-tab').click();await page.locator('#camera-start').click();
 const expected=await page.evaluate(async()=>{
  const {prepareRaptorTransfer,raptorSchedule,raptorFrame}=await import('./raptor-protocol.js');
  const bytes=crypto.getRandomValues(new Uint8Array(18000)),t=await prepareRaptorTransfer(new File([bytes],'received.bin'),384);const texts=[];
  // Permanently drop all originals and every fifth repair QR.
  for(let p=1;p<=3;p++){let i=0;for(const item of raptorSchedule(t,p)){const text=await raptorFrame(t,item);if(item[0]===0||++i%5)texts.push(text);}}
  globalThis.__frames=texts;t.dispose();return [...bytes];
 });
 await page.waitForFunction(()=>document.getElementById('camera-status').textContent==='FILE VERIFIED',{},{timeout:20000});
 assert.equal(await page.locator('#percent').textContent(),'100%');
 const actual=await page.evaluate(async()=>[...new Uint8Array(await(await fetch(document.getElementById('download').href)).arrayBuffer())]);assert.deepEqual(actual,expected);
 console.log('PASS receiver with actual RaptorQ worker, repair-only loss, verified download');
 assert.deepEqual(errors,[]);await page.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
