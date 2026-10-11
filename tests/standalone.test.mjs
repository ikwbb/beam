import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { renderStandalone, scriptText } from '../build-standalone.mjs';
import { prepareTransfer, makeSchedule, frameAt, Receiver } from '../protocol.js';

const saved = (await readFile(new URL('../standalone.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const workers = JSON.parse(saved.match(/<script id="beam-worker-sources" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const appSource = saved.match(/<script id="beam-standalone">([\s\S]*?)<\/script>/)[1];

test('standalone is reproducible and current, with no external runtime assets or module scripts', async () => {
  assert.equal(saved, await renderStandalone(), 'Run node build-standalone.mjs after changing application sources.');
  assert.doesNotMatch(saved, /<script[^>]+(?:src=|type="module")/);
  assert.doesNotMatch(saved, /<link[^>]+rel="stylesheet"/);
  assert.doesNotMatch(saved, /standalone:exclude|location\.replace/);
  assert.doesNotMatch(appSource, /serviceWorker\.register/);
  assert.doesNotMatch(appSource, /new Worker\('\./);
  assert.match(saved, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(saved, /Copyright \(c\) 2026 Beam contributors/);
  assert.match(saved, /c04ab59682681e27a24b36b36084806437a5d224/);
  new vm.Script(appSource, { filename: 'standalone.html' });
  for (const source of Object.values(workers)) new vm.Script(source);
});

test('embedded scripts cannot terminate their HTML element through strings, templates, or comments', () => {
  const values = ['</script>', '<script>', '<!--', '</SCRIPT><script>alert(1)</script>'];
  const code = `// <!-- <script>\n globalThis.result = ${JSON.stringify(values)};`;
  const escaped = scriptText(code);
  assert.doesNotMatch(escaped, /<(?:\/?script|!--)/i);
  const context = vm.createContext({});
  vm.runInContext(escaped, context);
  assert.deepEqual(Array.from(context.result), values);
});

function workerContext(source) {
  let reply;
  const noNetwork = () => { throw new Error('An embedded worker attempted a network request.'); };
  const sandbox = {
    console, TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, ArrayBuffer,
    Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
    atob, btoa, location: { href: 'blob:null/standalone-worker' },
    fetch: noNetwork, importScripts: noNetwork, XMLHttpRequest: noNetwork,
    postMessage: data => { reply = data; },
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return async data => {
    reply = undefined;
    await context.onmessage({ data });
    assert.ok(reply, 'worker answered the frame');
    assert.equal(reply.error, undefined);
    return reply;
  };
}

function raster(code) {
  const scale = 3, width = (code.size + 8) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) {
    if (!code.data[y * code.size + x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const index = (((y + 4) * scale + dy) * width + (x + 4) * scale + dx) * 4;
      data[index] = data[index + 1] = data[index + 2] = 0;
    }
  }
  return { buffer: data.buffer, width, height: width };
}

test('embedded classic workers encode and WASM-decode a verified transfer without fetching any dependency', async () => {
  const encode = workerContext(workers.encode), decode = workerContext(workers.decode);
  const bytes = new TextEncoder().encode('Portable Beam\n廣東話 👋\n' + '0123456789'.repeat(150));
  const transfer = await prepareTransfer(new File([bytes], 'portable.txt'), 720, 'text');
  const receiver = new Receiver();
  for (const item of makeSchedule(transfer)) {
    const text = frameAt(transfer, item);
    const encoded = await encode({ texts: [text], generation: 9, label: 'Test', pass: 1 });
    assert.equal(encoded.generation, 9);
    const decoded = await decode({ ...raster(encoded.codes[0]), generation: 9 });
    assert.equal(decoded.generation, 9);
    assert.ok(decoded.texts.includes(text));
    for (const value of decoded.texts) receiver.accept(value);
  }
  assert.deepEqual(await receiver.finish(), bytes);
  assert.equal(receiver.verified, true);
  assert.equal(receiver.meta.kind, 'text');
});


function gridRaster(codes, columns) {
  const images = codes.map(raster), gap = 20;
  const cell = Math.max(...images.map(img => img.width));
  const rows = Math.ceil(codes.length / columns);
  const width = columns * (cell + gap) + gap, height = rows * (cell + gap) + gap;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [index, img] of images.entries()) {
    const source = new Uint8ClampedArray(img.buffer);
    const left = gap + (index % columns) * (cell + gap), top = gap + Math.floor(index / columns) * (cell + gap);
    for (let y = 0; y < img.height; y++) data.set(source.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((top + y) * width + left) * 4);
  }
  return { buffer: data.buffer, width, height };
}

test('portable WASM locates and decodes every code in 4, 6, 8, 15, and 18 code grids at each density', async () => {
  const encode = workerContext(workers.encode), decode = workerContext(workers.decode);
  for (const density of [384, 720, 1024]) {
    const bytes = new Uint8Array(density * 24); crypto.getRandomValues(bytes);
    const transfer = await prepareTransfer(new File([bytes], 'grid.bin'), density);
    const frames = makeSchedule(transfer).map(item => frameAt(transfer, item));
    for (const count of [4, 6, 8, 15, 18]) {
      const texts = [...new Set(frames)].slice(0, count);
      assert.equal(new Set(texts).size, count);
      const encoded = await encode({ texts, generation: 17 });
      const decoded = await decode({ ...gridRaster(encoded.codes, count >= 15 ? count / 3 : count / 2), generation: 17 });
      assert.equal(decoded.codes.length, count, `${count} detections at density ${density}`);
      for (const text of texts) {
        const code = decoded.codes.find(code => code.text === text);
        assert.ok(code, `QR decoded at density ${density}`);
        assert.ok(code.points.length >= 4, 'positions are returned by the actual WASM decoder');
        assert.ok(code.points.every(p => p.x >= 0 && p.x <= decoded.width && p.y >= 0 && p.y <= decoded.height));
      }
    }
  }
});


function autoRaster(codes, columns, cell) {
  const rows = Math.ceil(codes.length / columns), width = columns * cell + (columns - 1) * 4, height = rows * cell + (rows - 1) * 4;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [index, code] of codes.entries()) {
    const scale = Math.max(1, Math.floor(cell / (code.size + 8))), offset = Math.floor((cell - code.size * scale) / 2);
    const left = index % columns * (cell + 4), top = Math.floor(index / columns) * (cell + 4);
    for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) {
      if (!code.data[y * code.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const at = ((top + offset + y * scale + dy) * width + left + offset + x * scale + dx) * 4;
        data[at] = data[at + 1] = data[at + 2] = 0;
      }
    }
  }
  return {buffer: data.buffer, width, height};
}

test('compact automatic layout decodes 72 QR cells with four pixel gaps', async () => {
  const encode = workerContext(workers.encode), decode = workerContext(workers.decode);
  const bytes = new Uint8Array(720 * 96);
  for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  const transfer = await prepareTransfer(new File([bytes], 'auto-4k.bin'), 720);
  const texts = [...new Set(makeSchedule(transfer).map(item => frameAt(transfer, item)))].slice(0, 72);
  assert.equal(texts.length, 72);
  const encoded = await encode({texts, generation: 21});
  const decoded = await decode({...autoRaster(encoded.codes, 12, Math.max(...encoded.codes.map(code => code.size + 8)) * 2), generation: 21});
  assert.equal(decoded.codes.length, 72);
  for (const text of texts) assert.ok(decoded.texts.includes(text));
});

function scaledAutoRaster(codes, columns, displayCell) {
  const largest = Math.max(...codes.map(code => code.size + 8));
  const backing = largest * Math.ceil(displayCell / largest);
  const rows = Math.ceil(codes.length / columns);
  const width = columns * displayCell + (columns - 1) * 4;
  const height = rows * displayCell + (rows - 1) * 4;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  codes.forEach((code, index) => {
    const source = autoRaster([code], 1, backing);
    const pixels = new Uint8ClampedArray(source.buffer);
    const left = index % columns * (displayCell + 4), top = Math.floor(index / columns) * (displayCell + 4);
    for (let y = 0; y < displayCell; y++) for (let x = 0; x < displayCell; x++) {
      const sx = Math.floor((x + 0.5) * backing / displayCell), sy = Math.floor((y + 0.5) * backing / displayCell);
      const value = pixels[(sy * backing + sx) * 4];
      const at = ((top + y) * width + left + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = value;
    }
  });
  return {buffer: data.buffer, width, height};
}

test('fine display sizes decode at every density with pixelated scaling and 4px gaps', async () => {
  const encode = workerContext(workers.encode), decode = workerContext(workers.decode);
  for (const density of [384, 720, 1024]) {
    const bytes = crypto.getRandomValues(new Uint8Array(density * 8));
    const transfer = await prepareTransfer(new File([bytes], 'fine-step.bin'), density);
    const texts = [...new Set(makeSchedule(transfer).map(item => frameAt(transfer, item)))].slice(0, 4);
    const encoded = await encode({texts, generation: 31});
    for (const size of [312, 320, 328]) {
      const decoded = await decode({...scaledAutoRaster(encoded.codes, 2, size), generation: 31});
      assert.equal(decoded.codes.length, texts.length, `${density} bytes at ${size}px`);
      for (const text of texts) assert.ok(decoded.texts.includes(text));
    }
  }
});
