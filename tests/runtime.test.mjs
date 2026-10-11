import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '');
const decoderSource = (await readFile(new URL('../decoder.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '').replaceAll('export async function', 'async function');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function cameraStream() {
  const track = { stopped: false, readyState: 'live', stop() { this.stopped = true; this.readyState = 'ended'; }, getSettings: () => ({ deviceId: 'rear' }) };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function harness({ media, display, formats, detect, wakeLock, workerFailure, receiver, confirm = () => true } = {}) {
  const elements = new Map(), workers = [], events = new Map(), frames = new Map(), timers = new Map();
  let frameId = 0, frameTime = 0, canvasReads = 0; const boxes = [];
  const context2d = {
    clearRect() {}, strokeRect(...args) { boxes.push(args); }, fillText() {}, fillRect() {}, drawImage() { canvasReads++; },
    getImageData: () => ({ data: new Uint8ClampedArray(16) }),
  };
  const createElement = () => ({
    hidden: false, disabled: false, value: '', textContent: '', style: {}, className: '',
    clientWidth: 900, clientHeight: 600, files: [], readyState: 2, videoWidth: 2, videoHeight: 2, currentTime: 1,
    classList: { values: new Set(), add(v) { this.values.add(v); }, remove(v) { this.values.delete(v); }, contains(v) { return this.values.has(v); }, toggle(v, on) { if (on ?? !this.values.has(v)) this.values.add(v); else this.values.delete(v); } },
    appendChild(child) { elements.set(child.id, child); }, addEventListener() {}, setAttribute() {}, removeAttribute() {}, replaceChildren() {},
    getContext: () => context2d, play: async () => {}, scrollIntoView() {},
    querySelector: () => createElement(),
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  element('density').value = '720'; element('code-count').value = '1'; element('speed').value = '10';
  const document = {
    body: createElement(), getElementById: element, createElement, hidden: false, visibilityState: 'visible',
    addEventListener(name, callback) { events.set(name, callback); },
  };
  class Worker {
    constructor(url) {
      if (workerFailure?.(url)) throw new Error('Worker unavailable');
      this.url = url; this.messages = []; this.terminated = false; workers.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  class Receiver {
    constructor() { this.meta = null; this.pending = []; this.received = 0; this.count = 0; this.verified = false; }
  }
  const sandbox = {
    document, navigator: { mediaDevices: { getUserMedia: media || (async () => cameraStream()), getDisplayMedia: display, enumerateDevices: async () => [] }, wakeLock },
    window: { addEventListener(name, callback) { events.set(name, callback); }, matchMedia: () => ({ matches: false }) },
    Worker, Receiver: receiver ? class { constructor() { return receiver; } } : Receiver,
    ResizeObserver: class { observe() {} }, isSecureContext: true, confirm,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }, setInterval() {}, setTimeout(callback) { timers.set(++frameId, callback); return frameId; }, clearTimeout(id) { timers.delete(id); }, performance: { now: () => 100 },
    Uint8Array, Uint8ClampedArray, TextEncoder, TextDecoder, URL, Blob, File, console,
    MAX_FILE: Number.MAX_SAFE_INTEGER,
    prepareTransfer: async chosen => ({ manifest: 'B2:INFO', dataFrame: () => 'B2:DATA', parityFrame: () => 'B2:REPAIR', count: 1, meta: { packedSize: chosen.size } }),
    makeSchedule: () => [[0, 0], [1, 0]], frameAt: () => 'B2:DATA',
    QRCode: { create: () => ({ modules: { size: 21, data: new Uint8Array(441) } }) },
  };
  if (formats || detect) sandbox.BarcodeDetector = class {
    static getSupportedFormats() { return formats ? formats() : Promise.resolve(['qr_code']); }
    detect(video) { return detect ? detect(video) : Promise.resolve([]); }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return {
    element, document, workers, events, frames, timers, boxes, evaluate: code => vm.runInContext(code, context),
    canvasReads: () => canvasReads,
    click: id => element(id).onclick(),
    scan() {
      const queue = frames.size ? frames : timers;
      const [id, callback] = queue.entries().next().value;
      queue.delete(id); callback(frameTime += 100);
    },
  };
}

test('a cancelled camera permission request cannot replace a newer camera', async () => {
  const first = deferred(), second = deferred(); let requests = 0;
  const app = harness({ media: () => (++requests === 1 ? first.promise : second.promise) });
  app.click('receive-tab'); app.click('camera-start');
  assert.equal(app.element('camera-start').textContent, 'Cancel camera request');
  assert.equal(app.element('camera-start').disabled, false);
  app.click('camera-start'); app.click('camera-start');
  const stale = cameraStream(), current = cameraStream();
  first.resolve(stale); await flush();
  assert.equal(stale.track.stopped, true);
  // Cancelling again still cancels the second request after the first settles.
  app.click('camera-start');
  assert.equal(app.element('camera-status').textContent, 'CAMERA OFF');
  second.resolve(current); await flush();
  assert.equal(current.track.stopped, true);
  assert.equal(app.workers.length, 0);
});

test('an old decoder setup cannot overwrite or terminate a resumed camera', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const app = harness({ formats: () => (++calls === 1 ? first.promise : second.promise) });
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.click('camera-start'); app.click('camera-start'); await flush();
  second.resolve([]); await flush();
  assert.equal(app.workers.length, 1);
  const worker = app.workers[0];
  first.resolve([]); await flush();
  assert.equal(app.workers.length, 1);
  assert.equal(worker.terminated, false);
  assert.equal(app.element('camera-start').textContent, 'Pause camera Ⅱ');
});

test('late worker errors from a paused session do not stop its replacement', async () => {
  const app = harness();
  app.click('receive-tab'); app.click('camera-start'); await flush();
  const stale = app.workers[0];
  app.click('camera-start'); app.click('camera-start'); await flush();
  stale.onerror();
  assert.equal(app.workers[1].terminated, false);
  assert.equal(app.element('camera-start').textContent, 'Pause camera Ⅱ');
});

test('hiding the page cancels pending camera access without starting a background stream', async () => {
  const request = deferred(), stream = cameraStream();
  const app = harness({ media: () => request.promise });
  app.click('receive-tab'); app.click('camera-start');
  app.document.hidden = true; app.document.visibilityState = 'hidden';
  app.events.get('visibilitychange')();
  request.resolve(stream); await flush();
  assert.equal(stream.track.stopped, true);
  assert.equal(app.workers.length, 0);
  assert.equal(app.element('camera-start').disabled, false);
});

test('wake locks are not leaked when camera access is paused before lock acquisition', async () => {
  const request = deferred(); let requests = 0, releases = 0;
  const app = harness({ wakeLock: { request() { requests++; return request.promise; } } });
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.events.get('visibilitychange')(); app.events.get('visibilitychange')();
  assert.equal(requests, 1);
  app.click('camera-start');
  request.resolve({ release: async () => { releases++; }, addEventListener() {} }); await flush();
  assert.equal(releases, 1);
});

test('native scanning reads video directly and falls back after a runtime failure', async () => {
  let input;
  const app = harness({ detect: video => { input = video; return Promise.reject(new Error('Unsupported source')); } });
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.scan(); await flush();
  assert.equal(input, app.element('video'));
  assert.equal(app.canvasReads(), 0);
  assert.equal(app.workers.length, 1);
  assert.equal(app.element('camera-start').textContent, 'Pause camera Ⅱ');
});

test('native decoder fallback failures leave a usable resume button', async () => {
  const app = harness({ detect: () => Promise.reject(new Error('Unavailable')), workerFailure: () => true });
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.scan(); await flush();
  assert.equal(app.element('camera-status').textContent, 'CAMERA OFF');
  assert.match(app.element('receive-message').textContent, /could not start/);
  assert.equal(app.element('camera-start').disabled, false);
});

test('worker creation failures can be retried without starting a broken signal', async () => {
  let fail = false;
  const app = harness({ workerFailure: () => fail });
  await app.element('file-input').onchange({ target: { files: [new File(['hello'], 'hello.txt')] } });
  assert.equal(app.element('code-count').value, '1');
  fail = true; app.element('code-count').onchange();
  assert.match(app.element('send-message').textContent, /Code preparation failed/);
  await app.click('send-start');
  assert.equal(app.frames.size, 0);
  fail = false; await app.click('send-start');
  assert.equal(app.element('send-status').textContent, 'SIGNAL LIVE');
  assert.equal(app.frames.size, 1);
});

test('pre-manifest pieces can be cleared and fountain equations advance visible progress before decoding bytes', async () => {
  let confirmations = 0;
  const receiver = {
    meta: null, pending: [], received: 0, receivedBytes: 0, collected: 0, count: 0, recovered: 0,
    accept() {
      if (!this.meta) { this.pending.push('B2:piece'); return 'waiting'; }
      this.collected++; return 'accepted';
    },
  };
  const app = harness({ receiver, confirm: () => { confirmations++; return false; } });
  app.element('clear-receive').disabled = true;
  app.click('receive-tab'); app.click('camera-start'); await flush();
  app.scan();
  const worker = app.workers[0], generation = worker.messages[0].generation;
  worker.onmessage({ data: { texts: ['B2:piece'], generation } });
  assert.equal(app.element('clear-receive').disabled, false);
  receiver.meta = { name: 'file.txt' }; receiver.count = 4; receiver.startedAt = Date.now();
  worker.onmessage({ data: { texts: ['B2:repair'], generation } });
  assert.equal(app.element('percent').textContent, '25%');
  assert.equal(app.element('received-count').textContent, '1 / 4 pieces');
  assert.equal(app.element('receive-bytes').textContent, '0 B');
  assert.equal(app.element('camera-status').textContent, 'RECEIVING FILE');
  app.click('clear-receive');
  assert.equal(confirmations, 1);
});

test('the production decoder reuses its configured QR-only scanner and accepts both protocol versions', async () => {
  const configs = [], scanners = [], scanner = { setConfig: (...args) => configs.push(args) };
  let created = 0;
  const context = vm.createContext({
    getDefaultScanner: async () => { created++; return scanner; },
    ZBarSymbolType: { ZBAR_NONE: 0, ZBAR_QRCODE: 64 }, ZBarConfigType: { ZBAR_CFG_ENABLE: 0 },
    scanImageData: async (image, used) => {
      scanners.push(used);
      return ['B1:OLD', 'B2:NEW', 'unrelated QR'].map(text => ({ decode: () => text }));
    },
  });
  vm.runInContext(decoderSource, context);
  assert.deepEqual(Array.from(await context.decodeImage({})), ['B1:OLD', 'B2:NEW']);
  await context.decodeImage({});
  assert.equal(created, 1);
  assert.deepEqual(configs, [[0, 0, 0], [64, 0, 1]]);
  assert.equal(scanners.length, 2);
  assert.ok(scanners.every(used => used === scanner));
});


test('screen capture invokes the picker, survives a hidden receiver tab, and stops cleanly', async () => {
  const stream = cameraStream(); let options;
  const app = harness({ display: async input => { options = input; return stream; } });
  app.click('receive-tab'); app.click('screen-start'); await flush();
  assert.equal(options.audio, false);
  assert.equal(app.element('video').srcObject, stream);
  assert.equal(app.element('screen-start').textContent, 'Pause screen capture Ⅱ');
  app.document.hidden = true; app.document.visibilityState = 'hidden';
  app.events.get('visibilitychange')();
  assert.equal(stream.track.stopped, false);
  app.scan();
  assert.ok(app.workers[0].messages.length);
  stream.track.onended();
  assert.equal(stream.track.stopped, true);
  assert.equal(app.element('video').srcObject, null);
  assert.equal(app.workers[0].terminated, true);
  assert.equal(app.element('screen-start').disabled, false);
});

test('cancelling a picker releases its late screen stream and preserves the replacement camera', async () => {
  const request = deferred();
  const app = harness({ display: () => request.promise });
  app.click('receive-tab'); app.click('screen-start');
  app.click('camera-start'); await flush();
  const current = app.element('video').srcObject, stale = cameraStream();
  request.resolve(stale); await flush();
  assert.equal(stale.track.stopped, true);
  assert.equal(app.element('video').srcObject, current);
  assert.equal(current.track.stopped, false);
});

test('denied and unsupported screen capture leave both input controls usable', async () => {
  for (const display of [undefined, async () => { throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }); }]) {
    const app = harness({ display });
    app.click('receive-tab'); await app.click('screen-start'); await flush();
    assert.equal(app.element('screen-start').disabled, false);
    assert.equal(app.element('camera-start').disabled, false);
    assert.equal(app.element('video').srcObject ?? null, null);
    assert.match(app.element('receive-message').textContent, /screen|Screen/);
  }
});

test('native detection draws letterboxed positions and clears missing codes on the next frame', async () => {
  let codes = [{ rawValue: 'unrelated', boundingBox: { x: 25, y: 10, width: 50, height: 30 } }];
  const app = harness({ detect: async () => codes });
  app.element('video').videoWidth = 200; app.element('video').videoHeight = 100;
  app.click('receive-tab'); app.click('camera-start'); await flush(); app.scan(); await flush();
  assert.deepEqual(app.boxes[0], [112.5, 120, 225, 135]);
  assert.match(app.element('qr-count-label').textContent, /1 QR/);
  codes = []; app.element('video').currentTime++; app.scan(); await flush();
  assert.match(app.element('qr-count-label').textContent, /0 QR/);
});

test('sender queues and renders 1, 2, 4, 6, 8, 15, and 18 distinct code canvases in the requested grid', async () => {
  for (const count of [1, 2, 4, 6, 8, 15, 18]) {
    const app = harness();
    app.element('code-count').value = String(count);
    await app.element('file-input').onchange({ target: { files: [new File(['hello'], 'hello.txt')] } });
    await app.click('send-start');
    const worker = app.workers[0], request = worker.messages[0];
    assert.equal(request.texts.length, count);
    const code = { size: 21, data: new Uint8Array(441) };
    worker.onmessage({ data: { ...request, codes: Array.from({ length: count }, () => code) } });
    app.scan();
    assert.equal(app.element('qr-wrap').style.gridTemplateColumns, `repeat(${count >= 15 ? count / 3 : count > 2 ? count / 2 : count}, max-content)`);
    assert.equal(app.element('qr-wrap').style.gridTemplateRows, `repeat(${count >= 15 ? 3 : count > 2 ? 2 : 1}, max-content)`);
    for (let i = 1; i <= 18; i++) assert.equal(app.element(i === 1 ? 'qr-canvas' : `qr-canvas-${i}`).hidden, i > count);
    assert.equal(app.document.body.classList.contains('signal-only'), count >= 4);
    app.click('exit-signal');
    assert.equal(app.document.body.classList.contains('signal-only'), false);
    assert.equal(app.element('send-status').textContent, 'SIGNAL PAUSED');
  }
});


test('mixed manifest and data QR versions keep equal cell dimensions across frames and resizes', () => {
  const app = harness();
  app.document.body.classList.add('signal-only');
  for (const [width, height] of [[1605, 816], [1690, 816], [1920, 1080], [900, 600]]) {
    app.element('send-stage').clientWidth = width;
    app.element('send-stage').clientHeight = height;
    app.evaluate(`displayModules = Array.from({length: 8}, (_, i) => ({size: i === 5 ? 57 : 105, data: new Uint8Array((i === 5 ? 57 : 105) ** 2)})); renderModules();`);
    const cells = Array.from({length: 8}, (_, i) => app.element(i ? `qr-canvas-${i + 1}` : 'qr-canvas'));
    assert.equal(new Set(cells.map(c => c.width)).size, 1, 'short manifest does not enlarge its cell');
    assert.ok(cells.every(c => c.height === c.width));
    const available = Math.min((width - 12) / 4, (height - 4) / 2);
    const expected = Math.max(113, Math.floor(available / 113) * 113);
    assert.equal(app.element('qr-wrap').style.gap, '4px');
    assert.equal(cells[0].width, expected);
    app.evaluate(`displayModules = Array.from({length: 8}, () => ({size: 105, data: new Uint8Array(105 ** 2)})); renderModules();`);
    assert.equal(cells[0].width, expected, 'cell positions remain stable when the manifest disappears');
  }
});


test('sender shows an estimate that updates with speed and code count', async () => {
  const app = harness();
  await app.element('file-input').onchange({target: {files: [new File(['test'], 'time.txt')]}});
  assert.match(app.element('send-eta').textContent, /1 s/);
  app.evaluate('schedule = Array.from({length: 1000}, () => [1, 0]); updateCeiling();');
  assert.match(app.element('send-eta').textContent, /1 min 40 s/);
  app.element('code-count').value = '2'; app.evaluate('updateCeiling();');
  assert.match(app.element('send-eta').textContent, /50 s/);
  app.element('speed').value = '20'; app.element('speed').oninput();
  assert.match(app.element('send-eta').textContent, /25 s/);
  app.evaluate('invalidateInput();');
  assert.equal(app.element('send-eta').textContent, 'Choose content to estimate transfer time.');
});

test('QR count no longer depends on an expected-code control', () => {
  const app = harness(); app.element('expected-codes').value = '15';
  app.evaluate('updateDetections([{text: "B2:test", points: []}], 100, 100);');
  assert.equal(app.element('qr-count-label').textContent, '1 QR · 1 Beam');
  assert.equal(app.element('expected-codes').onchange, undefined);
});


test('receiver estimates remaining time from actual reconstructed bytes', () => {
  const app = harness();
  app.evaluate(`receiver.meta = {name: 'time.bin', packedSize: 2000}; receiver.count = 2; receiver.collected = 1; receiver.receivedBytes = 1000; receiver.startedAt = Date.now() - 100000; updateReceiver();`);
  assert.match(app.element('receive-eta').textContent, /Estimated remaining: 1 min 4[01] s/);
  app.evaluate(`receiver.receivedBytes = 0; updateReceiver();`);
  assert.equal(app.element('receive-eta').textContent, 'Estimating remaining time…');
  app.evaluate(`receiver.verified = true; updateReceiver();`);
  assert.equal(app.element('receive-eta').textContent, 'Complete');
});


test('auto layout fills any window with the maximum count at the selected compact size', async () => {
  const app = harness(); app.element('code-count').value = 'auto';
  app.element('send-stage').clientWidth = 1920; app.element('send-stage').clientHeight = 1080;
  await app.element('file-input').onchange({target: {files: [new File(['auto'], 'auto.txt')]}});
  await app.click('send-start');
  assert.equal(app.evaluate('activeCodeCount'), 15);
  assert.equal(app.evaluate('autoLayout.columns'), 5); assert.equal(app.evaluate('autoLayout.rows'), 3);
  assert.equal(app.element('qr-wrap').style.gap, '4px');
  const worker = app.workers.at(-1), request = worker.messages[0];
  assert.equal(request.texts.length, 15);
  app.element('send-stage').clientWidth = 3840; app.element('send-stage').clientHeight = 2160;
  app.evaluate('refreshSendLayout();');
  assert.equal(app.evaluate('activeCodeCount'), 66);
  assert.equal(worker.terminated, true);
  const current = app.workers.at(-1), next = current.messages[0];
  assert.equal(next.texts.length, 66);
  const code = {size: 21, data: new Uint8Array(441)};
  current.onmessage({data: {...next, codes: Array.from({length: 66}, () => code)}});
  app.scan();
  assert.equal(app.element('qr-canvas-66').hidden, false);
  assert.equal(app.element('qr-wrap').style.gridTemplateColumns, 'repeat(11, max-content)');
  assert.equal(app.element('qr-wrap').style.gridTemplateRows, 'repeat(6, max-content)');
  assert.equal(app.element('qr-canvas').width, 348);
  assert.equal(app.element('qr-size-controls').hidden, false);
});

test('plus and minus change auto QR size and queued count without resetting the transfer', async () => {
  const app = harness(); app.element('code-count').value = 'auto';
  app.element('send-stage').clientWidth = 1920; app.element('send-stage').clientHeight = 1080;
  await app.element('file-input').onchange({target: {files: [new File(['auto'], 'auto.txt')]}});
  await app.click('send-start');
  const original = app.evaluate('transfer');
  app.click('qr-size-plus'); assert.equal(app.evaluate('qrTargetSize'), 328);
  assert.equal(app.evaluate('autoLayout.cell'), 328);
  app.click('qr-size-minus'); assert.equal(app.evaluate('qrTargetSize'), 320);
  assert.equal(app.evaluate('activeCodeCount'), 15);
  assert.equal(app.evaluate('transfer'), original);
  assert.equal(app.evaluate('running'), true);
});

test('signal uses the webpage without requesting browser fullscreen', async () => {
  const app = harness(); app.element('code-count').value = 'auto';
  let requests = 0;
  app.element('send-stage').requestFullscreen = async () => { requests++; };
  app.document.exitFullscreen = async () => { requests++; };
  await app.element('file-input').onchange({target: {files: [new File(['auto'], 'auto.txt')]}});
  await app.click('send-start');
  await app.click('fullscreen');
  assert.equal(requests, 0);
  assert.equal(app.element('exit-signal').hidden, false);
  assert.equal(app.element('signal-notch').hidden, false);
  assert.equal(app.document.body.classList.contains('signal-only'), true);
  app.element('send-stage').clientWidth = 1600;
  app.evaluate('refreshSendLayout();');
  assert.equal(app.evaluate('running'), true);
  app.click('exit-signal');
  assert.equal(app.element('signal-notch').hidden, true);
  assert.equal(app.evaluate('running'), false);
  assert.equal(app.document.body.classList.contains('signal-only'), false);
});

test('auto canvases stay compact with a four pixel gap across window sizes and densities', () => {
  for (const modules of [89, 105, 125]) for (const width of [900, 1605, 1690, 1920, 2560]) {
    const app = harness(); app.element('code-count').value = 'auto';
    app.element('send-stage').clientWidth = width;
    app.element('send-stage').clientHeight = 1080;
    app.document.body.classList.add('signal-only');
    app.evaluate(`referenceModules = ${modules}; refreshSendLayout(false);
      displayModules = Array.from({length: activeCodeCount}, () => ({size: ${modules}, data: new Uint8Array(${modules * modules})})); renderModules();`);
    const cell = parseInt(app.element('qr-canvas').style.width), unit = modules + 8;
    assert.equal(cell, 320, 'display size does not snap to a whole QR-width multiple');
    assert.equal(app.element('qr-canvas').width % unit, 0, 'backing raster has only its quiet zone');
    assert.equal(app.element('qr-wrap').style.gap, '4px');
    const columns = app.evaluate('autoLayout.columns'), rows = app.evaluate('autoLayout.rows');
    assert.ok(columns * cell + (columns - 1) * 4 <= width);
    assert.ok(rows * cell + (rows - 1) * 4 <= 1080);
    assert.ok((columns + 1) * cell + columns * 4 > width);
  }
});

 test('fine size steps cross module-scale thresholds without sudden code-count jumps', () => {
  const app = harness(); app.element('code-count').value = 'auto';
  app.element('send-stage').clientWidth = 2560; app.element('send-stage').clientHeight = 1440;
  app.document.body.classList.add('signal-only');
  app.evaluate('referenceModules = 125; qrTargetSize = 400; refreshSendLayout(false);');
  assert.equal(app.evaluate('activeCodeCount'), 18);
  app.click('qr-size-minus');
  assert.equal(app.evaluate('autoLayout.cell'), 392);
  assert.equal(app.evaluate('activeCodeCount'), 18);
  app.click('qr-size-plus');
  assert.equal(app.evaluate('autoLayout.cell'), 400);
});

test('notch auto-hides, reveals at the bottom edge, and stays open for hover or focus', () => {
  const app = harness();
  app.evaluate('setSignalOnly(true);');
  const notch = app.element('signal-notch'), zone = app.element('signal-notch-zone');
  const idle = () => { for (const [id, callback] of [...app.timers]) { app.timers.delete(id); callback(); } };
  idle(); assert.equal(notch.classList.contains('collapsed'), true);
  zone.onpointerenter({pointerType: 'mouse'}); idle();
  assert.equal(notch.classList.contains('collapsed'), false);
  zone.onpointerleave(); idle();
  assert.equal(notch.classList.contains('collapsed'), true);
  zone.onpointerdown({pointerType: 'touch'});
  assert.equal(notch.classList.contains('collapsed'), false);
  idle(); assert.equal(notch.classList.contains('collapsed'), true);
  notch.onfocusin(); idle();
  assert.equal(notch.classList.contains('collapsed'), false);
  notch.onfocusout(); idle();
  assert.equal(notch.classList.contains('collapsed'), true);
  app.evaluate('setSignalOnly(false);');
  assert.equal(zone.hidden, true); assert.equal(app.timers.size, 0);
  zone.onpointerenter({pointerType: 'mouse'});
  assert.equal(app.timers.size, 0);
});
