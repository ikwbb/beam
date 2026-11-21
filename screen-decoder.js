import './vendor/zxing-reader.js';

const beam = /^B[123]:/;
const settings = {
  formats: ['QRCode'], tryHarder: true, tryRotate: false,
  tryInvert: false, tryDownscale: false, binarizer: 'GlobalHistogram',
};
let ready;
async function getReader() {
  ready ??= (async () => {
    const response = await fetch(new URL('./vendor/zxing-reader.wasm', import.meta.url));
    if (!response.ok) throw Error('The screen QR decoder could not load.');
    ZXingWASM.prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(await response.arrayBuffer()) } });
    return ZXingWASM;
  })();
  return ready;
}

// White QR canvases on Beam's dark board have narrow dark separators. Project
// bright pixels onto each axis to locate cells without running a full-image
// finder-pattern search or assuming a particular grid count or display DPI.
function brightRuns(counts) {
  let max = 0;
  for (const count of counts) max = Math.max(max, count);
  const threshold = Math.max(3, max * .23);
  const runs = [];
  let start = -1;
  for (let i = 0; i <= counts.length; i++) {
    if (counts[i] >= threshold) { if (start < 0) start = i; }
    else if (start >= 0) { if (i - start >= 48) runs.push([start, i]); start = -1; }
  }
  return runs;
}
export function screenGrid({data,width,height}) {
  const xs = new Uint32Array(width), ys = new Uint32Array(height);
  for (let y = 0; y < height; y += 3) {
    const start = y * width * 4;
    for (let x = 0; x < width; x++) if (data[start + x * 4] >= 215) xs[x]++;
  }
  for (let y = 0; y < height; y++) {
    const start = y * width * 4;
    for (let x = 0; x < width; x += 3) if (data[start + x * 4] >= 215) ys[y]++;
  }
  const xRuns = brightRuns(xs), yRuns = brightRuns(ys);
  const count = xRuns.length * yRuns.length;
  if (count < 2 || count > 160) return [];
  const widths = xRuns.map(([a,b]) => b-a), heights = yRuns.map(([a,b]) => b-a);
  const sides = [...widths,...heights].sort((a,b)=>a-b), size = sides[Math.floor(sides.length/2)];
  if (sides.some(n => Math.abs(n-size) > Math.max(4,size*.08))) return [];
  return yRuns.flatMap(([y,y2]) => xRuns.map(([x,x2]) => ({
    x,y,width:x2-x,height:y2-y,
  })));
}
function crop(image, {x,y,width,height}) {
  const data = new Uint8ClampedArray(width*height*4);
  for (let row = 0; row < height; row++) {
    const start = ((y+row)*image.width+x)*4;
    data.set(image.data.subarray(start,start+width*4),row*width*4);
  }
  return {data,width,height};
}
function halfImage({data,width,height}) {
  const w = Math.floor(width/2), h = Math.floor(height/2), out = new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4,at=((2*y+1)*width+2*x+1)*4;
    out[i]=out[i+1]=out[i+2]=data[at];out[i+3]=255;
  }
  return {data:out,width:w,height:h};
}
function doubleImage({data,width,height}) {
  const out = new Uint8ClampedArray(width*height*16);
  for(let y=0;y<height*2;y++)for(let x=0;x<width*2;x++){
    const xx=x>>1,yy=y>>1, at=(yy*width+xx)*4;
    const right=xx+1<width?at+4:at, below=yy+1<height?width*4:0;
    const u=x&1,v=y&1;
    const value=(data[at]+(u?data[right]:data[at])+(v?data[at+below]:data[at])+(v?data[(u?right:at)+below]:data[u?right:at]))/4;
    const i=(y*width*2+x)*4;out[i]=out[i+1]=out[i+2]=value;out[i+3]=255;
  }
  return {data:out,width:width*2,height:height*2};
}
function mapCode({text,position}, x=0,y=0,scale=1) {
  return { text, points: ['topLeft','topRight','bottomRight','bottomLeft'].map(c => ({
    x:position[c].x/scale+x,y:position[c].y/scale+y,
  })) };
}
export async function decodeScreenDetections(image) {
  const reader = await getReader();
  const regions = screenGrid(image), found = [];
  if (regions.length) {
    for (const region of regions) {
      const cell = crop(image,region);
      const pure = {...settings,isPure:true,maxNumberOfSymbols:1};
      let hits = [], scale=1;
      // A large 4K cell still has plenty of module pixels at half size.
      // Retry at native resolution on a miss, keeping dense captures intact.
      if (cell.width>=520 && cell.height>=520) {
        hits = await reader.readBarcodes(halfImage(cell),pure);
        if(hits.length)scale=.5;
      }
      if (!hits.length) hits = await reader.readBarcodes(cell,pure);
      if (!hits.length) hits = await reader.readBarcodes(cell,{...pure,binarizer:'FixedThreshold'});
      if (!hits.length) hits = await reader.readBarcodes(cell,{...settings,maxNumberOfSymbols:1});
      // Some captures land between module pixels. Retry only the failed,
      // small cells at a finer sampling grid; never upscale the whole frame.
      if (!hits.length && cell.width<=280 && cell.height<=280) {
        const doubled = doubleImage(cell);
        scale=2;
        hits = await reader.readBarcodes(doubled,pure);
        if (!hits.length) hits = await reader.readBarcodes(doubled,{...settings,maxNumberOfSymbols:1});
      }
      if (hits.length) found.push(mapCode(hits[0],region.x,region.y,scale));
    }
    if (found.length === regions.length && found.some(code=>beam.test(code.text))) return found;
  }
  // Arbitrary screenshots / clipped grids still have a general QR scan. When
  // many symbols compete in the global search, recover candidates in two
  // overlapping regions, excluding rediscoveries of the same physical code.
  function add(code) {
    const p=code.points[0];
    if (!found.some(old=>old.text===code.text&&Math.hypot(old.points[0].x-p.x,old.points[0].y-p.y)<20)) found.push(code);
  }
  for(const hit of await reader.readBarcodes(image,settings)) add(mapCode(hit));
  if (!regions.length && found.length>=8 && image.width>=800) {
    const width=Math.ceil(image.width*.65);
    for(const x of [0,image.width-width]) {
      for(const hit of await reader.readBarcodes(crop(image,{x,y:0,width,height:image.height}),settings)) add(mapCode(hit,x));
    }
  }
  return found;
}
