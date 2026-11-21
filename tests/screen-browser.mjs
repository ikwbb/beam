// Real Chromium capture pipeline using a deterministic canvas stream in place
// of the OS sharing picker. The input uses the same QR size and packing as Beam.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = new URL('../', import.meta.url);
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL('.'+req.url,root);
    if (!url.pathname.startsWith(root.pathname)) throw Error('outside root');
    const type = /\.m?js$/.test(url.pathname) ? 'text/javascript' : url.pathname.endsWith('.wasm') ? 'application/wasm' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html';
    res.setHeader('Content-Type',type);res.end(await readFile(url));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.BEAM_CHROME_EXECUTABLE||undefined,args:['--no-sandbox']});
  const page=await browser.newPage();
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  for (const [columns,width] of [[6,3840],[7,3840],[6,1280],[7,1280]]) {
    console.log('Testing '+columns+' × 3 at '+width+' px');
    const baseline=await page.evaluate(async ({columns,width})=>{
      const {packet}=await import('/protocol.js');
      const {decodeDetections}=await import('/decoder.js');
      let seed=931;
      const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed&255;};
      const id=Uint8Array.of(1,2,3,4,5,6,7,8),count=columns*3;
      const texts=Array.from({length:count},(_,i)=>{
        const p=Uint8Array.from({length:1028},random);
        new DataView(p.buffer).setUint32(0,i);
        return packet(1,id,0,count,1024,p,3);
      });
      const qr=texts.map(data=>QRCode.create([{data,mode:'alphanumeric'}],{errorCorrectionLevel:'M'}).modules);
      const source=new OffscreenCanvas(3840,2160),ctx=source.getContext('2d');
      ctx.fillStyle='#111923';ctx.fillRect(0,0,3840,2160);
      const cell=(qr[0].size+8)*4,gap=8;
      const left=(3840-columns*(cell+gap)+gap)/2,top=(2160-3*(cell+gap)+gap)/2;
      for(const [i,q] of qr.entries()){
        const x0=left+(i%columns)*(cell+gap),y0=top+Math.floor(i/columns)*(cell+gap);
        ctx.fillStyle='#fff';ctx.fillRect(x0,y0,cell,cell);
        ctx.fillStyle='#000';for(let y=0;y<q.size;y++)for(let x=0;x<q.size;x++)if(q.data[y*q.size+x])ctx.fillRect(x0+16+x*4,y0+16+y*4,4,4);
      }
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=width*9/16;
      const out=canvas.getContext('2d',{willReadFrequently:true});out.drawImage(source,0,0,canvas.width,canvas.height);
      navigator.mediaDevices.getDisplayMedia=async()=>{
        const stream=canvas.captureStream(0),track=stream.getVideoTracks()[0];
        for(const delay of [20,60,140])setTimeout(()=>{if(track.readyState==='live'){track.requestFrame();out.drawImage(source,0,0,canvas.width,canvas.height);}},delay);
        return stream;
      };
      const image=out.getImageData(0,0,canvas.width,canvas.height),start=performance.now();
      const old=await decodeDetections(image);
      return {count:old.length,ms:Math.round(performance.now()-start)};
    },{columns,width});
    await page.locator('#receive-tab').click();
    await page.locator('#screen-start').click();
    await page.waitForFunction(()=>document.querySelector('#decoder-label').textContent.includes('ZXing'),null,{timeout:10000}).catch(async error=>{
      console.error(await page.locator('#receive-message').textContent(),await page.locator('#decoder-label').textContent());throw error;
    });
    const label=await page.locator('#decoder-label').textContent();
    const text=await page.locator('#qr-count-label').textContent();
    const count=Number(text.match(/(\d+) Beam/)[1]);
    console.log(JSON.stringify({width,displayed:columns*3,baseline,received:count,label}));
    assert.equal(count,columns*3);
    assert.match(label,new RegExp('^'+width+'×'));
    await page.locator('#screen-start').click();
  }
} finally {await browser?.close();server.close();}
