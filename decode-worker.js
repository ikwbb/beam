import { decodeDetections } from './decoder.js';
// One frame in flight; WASM locates all QR codes in a single pass.
self.onmessage = async ({ data }) => {
  try {
    const codes = await decodeDetections({ data: new Uint8ClampedArray(data.buffer), width: data.width, height: data.height });
    self.postMessage({ codes, texts: codes.map(code => code.text).filter(text => /^B[12]:/.test(text)), width: data.width, height: data.height, generation: data.generation });
  } catch (error) {
    self.postMessage({ texts: [], error: error.message, generation: data.generation });
  }
};
