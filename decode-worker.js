import { decodeDetections } from './decoder.js';
import { decodeScreenDetections } from './screen-decoder.js';
// One captured frame in flight; a screen grid and a camera frame are separate paths.
self.onmessage = async ({ data }) => {
  try {
    const image = { data: new Uint8ClampedArray(data.buffer), width: data.width, height: data.height };
    const start = performance.now();
    let codes, decoder = 'ZBar';
    if (data.source === 'screen') {
      try { codes = await decodeScreenDetections(image); decoder = 'ZXing'; }
      catch { codes = await decodeDetections(image); }
    } else codes = await decodeDetections(image);
    self.postMessage({ codes, texts: codes.map(code => code.text).filter(text => /^B[123]:/.test(text)), width: data.width, height: data.height, generation: data.generation, decoder, decodeMs: performance.now() - start });
  } catch (error) {
    self.postMessage({ texts: [], error: error.message, generation: data.generation });
  }
};
