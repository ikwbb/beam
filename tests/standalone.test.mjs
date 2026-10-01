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
