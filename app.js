import { prepareTransfer, makeSchedule, frameAt, Receiver } from './protocol.js';

const $ = id => document.getElementById(id);
const show = (id, visible = true) => { $(id).hidden = !visible; };
const write = (id, text) => { const element = $(id); if (element.textContent !== text) element.textContent = text; };
function message(id, text, error = false) { write(id, text); $(id).classList.toggle('error', error); }
function format(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / (bytes < 1048576 ? 1024 : 1048576)).toFixed(1)} ${bytes < 1048576 ? 'KiB' : 'MiB'}`;
}
let mode = 'send';
let inputMode = 'file';
let file = null, transfer = null, running = false, preparing = false, preparation = 0;
let schedule = [], cursor = 0, pass = 0, sendTimer = 0, nextDisplayAt = 0;
let encodeWorker = null, encodeGeneration = 0, encodePending = 0, displayQueue = [], displayedAt = [];
let receiver = new Receiver(), stream = null, scanning = false, cameraPending = 0;
let captureSource = 'camera', screenTimer = 0;
let decodeWorker = null, detector = null, decodeBusy = false, cameraGeneration = 0;
let animation = 0, lastVideoTime = -1, lastScanAt = 0, finishPending = false, downloadUrl = null;
let lastAcceptedAt = 0, wakeLock = null, wakeLockPending = false, displayModules = [];
let activeCodeCount = 1, autoLayout = null, qrTargetSize = 320, referenceModules = 21;
const qrCanvases = Array.from({ length: 18 }, (_, i) => $(i ? `qr-canvas-${i + 1}` : 'qr-canvas'));
const scanCanvas = document.createElement('canvas');
const scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });
// QR frames use the same local receiver for camera and screen capture.

async function syncWakeLock() {
  if (!navigator.wakeLock) return;
  const needed = () => (running || scanning) && document.visibilityState === 'visible';
  if (needed()) {
    if (wakeLock || wakeLockPending) return;
    wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      // The camera or signal may have stopped while permission was pending.
      if (!needed()) { await lock.release(); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch { /* Optional browser capability. */ }
    finally { wakeLockPending = false; }
  } else if (wakeLock) { const lock = wakeLock; wakeLock = null; try { await lock.release(); } catch {} }
}
function selectMode(next) {
  if (!['send', 'receive'].includes(next)) throw new Error('Choose send or receive.');
  if (next === mode) return;
  if (next === 'receive') pauseSend(); else if (scanning || cameraPending) stopCamera();
  mode = next;
  for (const value of ['send', 'receive']) {
    show(value + '-panel', value === mode);
    $(value + '-tab').classList.toggle('active', value === mode);
    $(value + '-tab').setAttribute('aria-pressed', String(value === mode));
  }
}
$('send-tab').onclick = () => selectMode('send');
$('receive-tab').onclick = () => selectMode('receive');

async function chooseFile(chosen, kind = 'file') {
  if (!chosen) return;
  pauseSend();
  resetEncoder();
  const generation = ++preparation;
  transfer = null; file = null; preparing = true;
  $('send-start').disabled = true; $('density').disabled = true;
  $('dropzone').classList.add('busy');
  write('file-label', chosen.name); write('file-detail', format(chosen.size));
  message('send-message', 'Preparing and checking the file…');
  write('send-status', 'PREPARING FILE');
  show('qr-wrap', false); show('empty-code');
  write('send-size', '—'); write('send-blocks', '—'); write('send-rate', '—');
  write('send-eta', 'Choose content to estimate transfer time.');
  try {
    const prepared = await prepareTransfer(chosen, Number($('density').value), kind);
    if (generation !== preparation) return;
    transfer = prepared; file = chosen; pass = 0; cursor = 0;
    schedule = makeSchedule(transfer);
    referenceModules = Math.max(...[transfer.manifest, transfer.dataFrame(0), transfer.parityFrame(0)].map(text => QRCode.create([{ data: text, mode: 'alphanumeric' }], { errorCorrectionLevel: 'M' }).modules.size));
    refreshSendLayout(false);
    drawCode(transfer.manifest);
    fillQueue();
    write('send-size', format(chosen.size)); write('send-blocks', transfer.count.toLocaleString());
    updateCeiling();
    write('send-status', 'READY TO SEND');
    write('send-start', 'Start signal ↗');
    write('send-frame', 'Ready · file information'); write('send-loop', 'AUTO REPEAT');
    const saved = chosen.size ? Math.round((1 - transfer.meta.packedSize / chosen.size) * 100) : 0;
    message('send-message', `${saved > 0 ? `Compressed ${saved}% smaller. ` : ''}Start the receiving camera, then start the signal.`);
    write('send-note', 'The sender repeats until you pause it. Stop after the other device says “File verified”.');
  } catch (error) {
    if (generation !== preparation) return;
    transfer = null; file = null;
    message('send-message', error.message || 'The file could not be prepared.', true);
    write('send-status', 'FILE NOT READY'); write('send-start', 'Choose another file ↗');
    show('qr-wrap', false); show('empty-code');
  } finally {
    if (generation === preparation) {
      preparing = false; $('dropzone').classList.remove('busy');
      $('send-start').disabled = !transfer; $('density').disabled = false;
    }
  }
}
$('file-input').onchange = event => chooseFile(event.target.files[0]);
const dropzone = $('dropzone');
dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('over'); chooseFile(event.dataTransfer.files[0]); });
$('density').onchange = () => { if (file) chooseFile(file, inputMode); };
$('code-count').onchange = () => {
  const resume = running; pauseSend(); resetEncoder(); refreshSendLayout(false);
  if (transfer) {
    try { fillQueue(); updateCeiling(); if (resume) startSend(); }
    catch (error) { resetEncoder(); message('send-message', `Code preparation failed: ${error.message}`, true); }
  }
};
function invalidateInput() {
  pauseSend(); preparation++; resetEncoder(); transfer = null; file = null; preparing = false;
  displayModules = []; show('qr-wrap', false); show('empty-code');
  $('dropzone').classList.remove('busy'); $('density').disabled = false;
  write('send-size', '—'); write('send-blocks', '—'); write('send-rate', '—');
  write('send-eta', 'Choose content to estimate transfer time.');
  write('send-status', 'READY WHEN YOU ARE'); write('send-frame', 'Waiting for content');
  const hasText = inputMode === 'text' && $('text-input').value.length > 0;
  $('send-start').disabled = !hasText; write('send-start', hasText ? 'Start text signal ↗' : 'Choose content to begin ↗');
}
function selectInput(next) {
  if (next === inputMode) return;
  inputMode = next; invalidateInput();
  show('dropzone', next === 'file'); show('text-entry', next === 'text');
  for (const kind of ['file', 'text']) {
    $(kind + '-mode').classList.toggle('active', kind === next);
    $(kind + '-mode').setAttribute('aria-pressed', String(kind === next));
  }
  message('send-message', next === 'text' ? 'Paste text, then start the signal. All languages and line breaks are preserved.' : 'Choose any document or file. Its bytes are transferred unchanged.');
  if (next === 'file' && $('file-input').files[0]) chooseFile($('file-input').files[0]);
}
$('file-mode').onclick = () => selectInput('file');
$('text-mode').onclick = () => selectInput('text');
$('text-input').oninput = () => {
  invalidateInput(); write('text-size', format(new TextEncoder().encode($('text-input').value).length));
  message('send-message', 'Ready to send this text. Start the camera on the receiving device.');
};
$('speed').oninput = () => { write('speed-value', `${$('speed').value} fps`); updateCeiling(); };
function isAutoLayout() { return $('code-count').value === 'auto'; }
function effectiveCodeCount() { return isAutoLayout() ? activeCodeCount : Number($('code-count').value) || 1; }
function stageSpace() {
  const stage = $('send-stage');
  const clean = document.body.classList.contains('signal-only');
  return { width: Math.max(1, stage.clientWidth - (clean ? 0 : 36)), height: Math.max(1, stage.clientHeight - (clean ? 0 : 110)), clean };
}
function refreshSendLayout(requeue = true) {
  const previous = activeCodeCount;
  $('qr-wrap').style.gap = '4px';
  if (isAutoLayout()) {
    const { width, height } = stageSpace();
    // Display size is independent of QR module-count multiples; +/- moves in 8px steps.
    const unit = referenceModules + 8;
    const cell = Math.max(unit, Math.round(Math.min(qrTargetSize, width, height)));
    const columns = Math.max(1, Math.floor((width + 4) / (cell + 4)));
    const rows = Math.max(1, Math.floor((height + 4) / (cell + 4)));
    autoLayout = { columns, rows, cell, count: columns * rows };
    activeCodeCount = autoLayout.count;
  } else { autoLayout = null; activeCodeCount = effectiveCodeCount(); }
  if (previous !== activeCodeCount) {
    resetEncoder();
    if (displayModules.length !== activeCodeCount) { displayModules = []; show('qr-wrap', false); }
    if (requeue && transfer) {
      try { fillQueue(); }
      catch (error) { pauseSend(); message('send-message', `Code preparation failed: ${error.message}`, true); }
    }
  }
  if (transfer) updateCeiling();
  $('qr-size-plus').title = `Larger QR codes · ${activeCodeCount} codes now`;
  $('qr-size-minus').title = `Smaller QR codes · ${activeCodeCount} codes now`;
  renderModules();
}
function adjustQRSize(delta) {
  $('code-count').value = 'auto';
  qrTargetSize = Math.max(referenceModules + 8, (autoLayout?.cell ?? qrTargetSize) + delta);
  refreshSendLayout();
}
$('qr-size-plus').onclick = () => adjustQRSize(8);
$('qr-size-minus').onclick = () => adjustQRSize(-8);
function duration(seconds) {
  if (!Number.isFinite(seconds)) return 'Estimating…';
  const total = Math.max(1, Math.ceil(seconds)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), rest = total % 60;
  return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', rest ? `${rest} s` : ''].filter(Boolean).join(' ');
}
function updateCeiling() {
  if (!transfer) return;
  const useful = transfer.meta.packedSize / schedule.length * Number($('speed').value) * effectiveCodeCount();
  write('send-rate', `${format(Math.round(useful))}/s`);
  write('send-eta', `Estimated minimum: ${duration(schedule.length / (Number($('speed').value) * effectiveCodeCount()))} · actual reception may take longer.`);
  $('send-rate').title = 'Ideal compressed payload per second, after manifest and parity overhead. Actual reception is slower when frames are missed.';
}
function drawCode(text) {
  const qr = QRCode.create([{ data: text, mode: 'alphanumeric' }], { errorCorrectionLevel: 'M' });
  displayModules = [qr.modules]; renderModules();
  show('qr-wrap'); show('empty-code', false);
}
function renderModules() {
  if (!displayModules.length) return;
  const count = displayModules.length, auto = isAutoLayout() && autoLayout?.count === count;
  const columns = auto ? autoLayout.columns : count >= 15 ? count / 3 : count <= 2 ? count : count / 2;
  const rows = auto ? autoLayout.rows : count >= 15 ? 3 : count <= 2 ? 1 : 2;
  const { width, height } = stageSpace(), gap = 4;
  $('qr-wrap').style.gap = `${gap}px`;
  $('qr-wrap').style.gridTemplateColumns = `repeat(${columns}, max-content)`;
  $('qr-wrap').style.gridTemplateRows = `repeat(${rows}, max-content)`;
  while (qrCanvases.length < count) {
    const canvas = document.createElement('canvas'); canvas.id = `qr-canvas-${qrCanvases.length + 1}`;
    canvas.setAttribute('aria-label', `Animated QR code ${qrCanvases.length + 1}`);
    $('qr-wrap').appendChild(canvas); qrCanvases.push(canvas);
  }
  for (const [i, canvas] of qrCanvases.entries()) canvas.hidden = i >= count;
  const available = Math.max(1, Math.min((width - gap * (columns - 1)) / columns, (height - gap * (rows - 1)) / rows));
  const largest = Math.max(...displayModules.map(code => code.size + 8));
  // Keep an integer-module backing raster, then display it at the requested
  // CSS size with pixelated sampling. This avoids both slot padding and size jumps.
  const size = auto ? largest * Math.max(1, Math.ceil(autoLayout.cell / largest)) : largest * Math.max(1, Math.floor(available / largest));
  const displaySize = auto ? autoLayout.cell : size;
  for (const [index, code] of displayModules.entries()) {
    const modules = code.size, scale = Math.max(1, Math.floor(size / (modules + 8)));
    const offset = Math.floor((size - modules * scale) / 2);
    const canvas = qrCanvases[index]; canvas.width = size; canvas.height = size;
    canvas.style.width = `${displaySize}px`; canvas.style.height = `${displaySize}px`;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, size, size); context.fillStyle = '#000';
    for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
      if (code.data[y * modules + x]) context.fillRect(offset + x * scale, offset + y * scale, scale, scale);
    }
  }
}
new ResizeObserver(() => {
  if (mode === 'send') refreshSendLayout();
}).observe($('send-stage'));
function resetEncoder() {
  encodeGeneration++; encodeWorker?.terminate(); encodeWorker = null;
  encodePending = 0; displayQueue = []; displayedAt = [];
}
function fillQueue() {
  if (!transfer) return;
  if (!encodeWorker) {
    const generation = encodeGeneration;
    encodeWorker = new Worker('./encode-worker.js');
    encodeWorker.onmessage = ({ data }) => {
      if (generation !== encodeGeneration || data.generation !== encodeGeneration) return;
      encodePending--;
      if (data.error) { pauseSend(); resetEncoder(); message('send-message', `Code preparation failed: ${data.error}`, true); return; }
      displayQueue.push(data);
    };
    encodeWorker.onerror = () => {
      if (generation !== encodeGeneration) return;
      pauseSend(); resetEncoder(); message('send-message', 'Code preparation could not start. Reload the app and try again.', true);
    };
  }
  // A bounded queue decouples display timing from QR mask search and encoding.
  while (displayQueue.length + encodePending < (isAutoLayout() ? 2 : 6)) {
    const texts = [], labels = [];
    for (let i = 0; i < effectiveCodeCount(); i++) {
      if (cursor >= schedule.length) { pass++; cursor = 0; schedule = makeSchedule(transfer, pass); }
      const item = schedule[cursor++]; texts.push(frameAt(transfer, item));
      labels.push(item[0] === 0 ? 'File info' : item[0] === 1 ? `Block ${item[1] + 1}` : 'Repair');
    }
    encodePending++;
    encodeWorker.postMessage({ generation: encodeGeneration, texts, label: labels.join(' + '), pass: pass + 1 });
  }
}
function tickSend(now) {
  if (!running || !transfer) return;
  sendTimer = requestAnimationFrame(tickSend);
  if (now + 1 < nextDisplayAt) return;
  try {
    if (!displayQueue.length) { fillQueue(); return; }
    const frame = displayQueue.shift(); displayModules = frame.codes; renderModules();
    show('qr-wrap'); show('empty-code', false);
    write('send-frame', frame.label);
    displayedAt.push(now); while (displayedAt.length > 1 && displayedAt[0] < now - 2000) displayedAt.shift();
    const fps = displayedAt.length > 1 ? Math.round(1000 * (displayedAt.length - 1) / (now - displayedAt[0])) : 0;
    write('send-loop', `PASS ${frame.pass}${fps ? ` · ${fps} FPS` : ''}`);
    nextDisplayAt = now + 1000 / Number($('speed').value);
    fillQueue();
  } catch (error) { pauseSend(); message('send-message', `Could not display the code: ${error.message}`, true); }
}
function startSend() {
  if (!transfer || preparing || running || mode !== 'send' || document.hidden) return;
  setSignalOnly(isAutoLayout() || effectiveCodeCount() >= 4);
  refreshSendLayout(false);
  try { fillQueue(); }
  catch (error) {
    setSignalOnly(false);
    resetEncoder(); message('send-message', `Code preparation failed: ${error.message}`, true); return;
  }
  running = true; $('density').disabled = true;
  write('send-start', 'Pause signal Ⅱ'); write('send-status', 'SIGNAL LIVE'); $('send-status').classList.add('live');
  message('send-message', 'Signal repeats automatically. Pause when the receiving device confirms the file is verified.');
  nextDisplayAt = 0; displayedAt = [];
  sendTimer = requestAnimationFrame(tickSend); syncWakeLock();
}
let notchTimer = 0, notchHovered = false, notchFocused = false;
function scheduleNotchHide() {
  clearTimeout(notchTimer); notchTimer = 0;
  if (!document.body.classList.contains('signal-only') || notchHovered || notchFocused) return;
  notchTimer = setTimeout(() => {
    notchTimer = 0;
    if (!notchHovered && !notchFocused) $('signal-notch').classList.add('collapsed');
  }, 1500);
}
function revealNotch() {
  if (!document.body.classList.contains('signal-only')) return;
  $('signal-notch').classList.remove('collapsed');
  scheduleNotchHide();
}
$('signal-notch-zone').onpointerenter = event => {
  if (!document.body.classList.contains('signal-only')) return;
  notchHovered = event.pointerType !== 'touch'; revealNotch();
};
$('signal-notch-zone').onpointerleave = () => { notchHovered = false; scheduleNotchHide(); };
$('signal-notch-zone').onpointerdown = () => revealNotch();
$('signal-notch').onfocusin = () => { notchFocused = true; revealNotch(); };
$('signal-notch').onfocusout = () => { notchFocused = false; scheduleNotchHide(); };
function setSignalOnly(enabled) {
  document.body.classList.toggle('signal-only', enabled);
  show('signal-notch-zone', enabled);
  show('signal-notch', enabled);
  clearTimeout(notchTimer); notchTimer = 0;
  notchHovered = false; notchFocused = false;
  $('signal-notch').classList.remove('collapsed');
  if (enabled) scheduleNotchHide();
  show('exit-signal', enabled);
  show('qr-size-controls', enabled);
  if (displayModules.length) renderModules();
}
$('exit-signal').onclick = () => { pauseSend(); setSignalOnly(false); };
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('signal-only')) { pauseSend(); setSignalOnly(false); }
});
function pauseSend() {
  setSignalOnly(false);
  running = false; cancelAnimationFrame(sendTimer); $('density').disabled = preparing;
  $('send-status').classList.remove('live');
  if (transfer) {
    write('send-start', 'Resume signal ↗'); write('send-status', 'SIGNAL PAUSED');
    message('send-message', 'Paused. Resume to continue the same transfer.');
  }
  syncWakeLock();
}
$('send-start').onclick = async () => {
  if (running) { pauseSend(); return; }
  if (inputMode === 'text' && !transfer) {
    await chooseFile(new File([$('text-input').value], 'message.txt', { type: 'text/plain;charset=utf-8' }), 'text');
    if (inputMode !== 'text' || mode !== 'send') return;
  }
  startSend();
  if (running && window.matchMedia('(max-width: 760px)').matches) $('send-stage').scrollIntoView({ block: 'nearest' });
};
$('fullscreen').onclick = () => {
  if (!transfer) return;
  if (!running) startSend();
  if (running) { setSignalOnly(true); refreshSendLayout(); }
};

async function setupDecoder(generation) {
  let nativeDetector = null;
  if (globalThis.BarcodeDetector) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) nativeDetector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch { /* Use bundled decoder. */ }
  }
  if (generation !== cameraGeneration) return;
  detector = nativeDetector;
  if (!detector) createDecodeWorker(generation);
  write('decoder-label', 'QR');
}
function createDecodeWorker(generation = cameraGeneration) {
  const worker = new Worker('./decode-worker.js', { type: 'module' });
  decodeWorker = worker;
  const isCurrent = () => generation === cameraGeneration && worker === decodeWorker;
  worker.onmessage = ({ data }) => {
    if (!isCurrent() || data.generation !== cameraGeneration) return;
    decodeBusy = false;
    if (data.error) {
      stopCamera(); message('receive-message', 'The QR decoder could not start. Use a current browser with WebAssembly enabled.', true); return;
    }
    if (scanning) {
      updateDetections(data.codes || [], data.width, data.height);
      for (const text of data.texts) acceptFrame(text);
    }
  };
  worker.onerror = () => {
    if (!isCurrent()) return;
    stopCamera(); message('receive-message', 'The camera decoder could not load. Reload Beam while online, then try again.', true);
  };
}
async function startCamera(source = 'camera') {
  if (cameraPending || scanning || receiver.verified || finishPending || mode !== 'receive' || (document.hidden && source === 'camera')) return;
  const screen = source === 'screen', label = screen ? 'screen capture' : 'camera';
  if (!isSecureContext || !navigator.mediaDevices?.[screen ? 'getDisplayMedia' : 'getUserMedia']) {
    message('receive-message', `This browser cannot access ${label} here. Use a supported desktop browser over HTTPS or localhost.`, true); return;
  }
  captureSource = source;
  const generation = ++cameraGeneration;
  cameraPending = generation;
  write(screen ? 'screen-start' : 'camera-start', `Cancel ${label} request`);
  message('receive-message', screen ? 'Choose the sender’s tab, window, or screen in the sharing picker…' : 'Waiting for camera access…');
  let candidate = null;
  try {
    // Invoke directly from the click handler, before awaiting decoder setup.
    const device = $('camera-select').value;
    candidate = screen
      ? await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 60 } } })
      : await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        ...(device ? { deviceId: { exact: device } } : { facingMode: { ideal: 'environment' } }),
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 },
      } });
    if (generation !== cameraGeneration || mode !== 'receive' || (!screen && document.hidden)) { candidate.getTracks().forEach(t => t.stop()); return; }
    stream = candidate;
    const track = stream.getVideoTracks()[0];
    track.onended = () => {
      if (generation === cameraGeneration) { stopCamera(); message('receive-message', `${screen ? 'Screen sharing ended' : 'The camera disconnected'}. Your progress is kept; start the input again to resume.`); }
    };
    $('video').srcObject = stream;
    show('video'); show('qr-overlay'); show('camera-empty', false);
    await $('video').play();
    if (generation !== cameraGeneration) return;
    await setupDecoder(generation);
    if (generation !== cameraGeneration) return;
    if (!screen) {
      const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(d => d.kind === 'videoinput');
      if (generation !== cameraGeneration) return;
      const selectedId = track.getSettings().deviceId;
      $('camera-select').replaceChildren(...devices.map((device, i) => {
        const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `Camera ${i + 1}`;
        option.selected = device.deviceId === selectedId; return option;
      }));
      show('camera-select', devices.length > 1); show('camera-label', devices.length > 1);
    } else { show('camera-select', false); show('camera-label', false); }
    if (track.readyState === 'ended') throw new Error(`${label} ended. Start it again to resume.`);
    scanning = true; decodeBusy = false; lastVideoTime = -1; lastScanAt = 0;
    write(screen ? 'screen-start' : 'camera-start', `Pause ${label} Ⅱ`);
    write('camera-status', 'LOOKING FOR SIGNAL'); $('camera-status').className = 'status-label live';
    message('receive-message', receiver.meta ? `${label} resumed. Previously received blocks are kept.` : screen ? 'Reading QR codes from the shared screen. Keep the sender’s codes visible in the captured surface.' : 'Point the camera at all codes on the sender’s screen.');
    scheduleScan(); syncWakeLock();
  } catch (error) {
    candidate?.getTracks().forEach(t => t.stop());
    if (generation !== cameraGeneration) return;
    stopCamera();
    const descriptions = screen ? {
      NotAllowedError: 'Screen sharing was cancelled or denied. Click Capture screen to choose again.',
      InvalidStateError: 'Click Capture screen while this page is focused to open the sharing picker.',
      NotReadableError: 'The selected screen could not be captured. Choose another window or screen.',
    } : {
      NotAllowedError: 'Camera permission was denied. Allow camera access in your browser settings, then try again.',
      NotFoundError: 'No camera was found. Connect a camera or open Beam on a phone.',
      NotReadableError: 'The camera is busy. Close other apps that use it, then try again.',
      OverconstrainedError: 'That camera is unavailable. Select another camera and try again.',
    };
    message('receive-message', descriptions[error.name] || `Could not start ${label}: ${error.message}`, true);
  } finally {
    if (cameraPending === generation) {
      cameraPending = 0; syncCaptureButtons();
    }
  }
}
function syncCaptureButtons() {
  for (const id of ['camera-start', 'screen-start']) $(id).disabled = receiver.verified || finishPending;
}
function stopCamera() {
  scanning = false; cameraPending = 0; cameraGeneration++; cancelAnimationFrame(animation); clearTimeout(screenTimer); decodeBusy = false;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  decodeWorker?.terminate(); decodeWorker = null; detector = null;
  $('video').srcObject = null; show('video', false); show('qr-overlay', false); show('camera-empty');
  updateDetections([], 1, 1);
  write('camera-start', receiver.meta ? 'Resume camera ↗' : 'Start camera ↗');
  write('screen-start', receiver.meta ? 'Resume screen capture ↗' : 'Capture screen ↗');
  syncCaptureButtons();
  const name = captureSource === 'screen' ? 'SCREEN' : 'CAMERA';
  write('camera-status', receiver.meta ? `${name} PAUSED` : `${name} OFF`); $('camera-status').className = 'status-label';
  write('decoder-label', ''); syncWakeLock();
}
function toggleCapture(source) {
  if (scanning || cameraPending) {
    const same = captureSource === source;
    stopCamera();
    if (same) { message('receive-message', 'Input paused. Your progress is kept.'); return; }
  }
  return startCamera(source);
}
$('camera-start').onclick = () => toggleCapture('camera');
$('screen-start').onclick = () => toggleCapture('screen');
$('camera-select').onchange = async () => { stopCamera(); await startCamera(); };
let latestDetections = [], detectionWidth = 1, detectionHeight = 1;
function updateDetections(codes, width, height) {
  latestDetections = codes; detectionWidth = width || 1; detectionHeight = height || 1;
  drawDetections();
}
function drawDetections() {
  const overlay = $('qr-overlay'), video = $('video');
  const width = video.clientWidth, height = video.clientHeight;
  overlay.width = width; overlay.height = height;
  const context = overlay.getContext('2d'); context.clearRect(0, 0, width, height);
  const scale = Math.min(width / detectionWidth, height / detectionHeight);
  const left = (width - detectionWidth * scale) / 2, top = (height - detectionHeight * scale) / 2;
  let beam = 0;
  for (const [index, code] of latestDetections.entries()) {
    const isBeam = /^B[12]:/.test(code.text); if (isBeam) beam++;
    const points = code.points || [];
    if (!points.length) continue;
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x = left + Math.min(...xs) * scale, y = top + Math.min(...ys) * scale;
    const w = (Math.max(...xs) - Math.min(...xs)) * scale, h = (Math.max(...ys) - Math.min(...ys)) * scale;
    context.strokeStyle = context.fillStyle = isBeam ? '#6fffa2' : '#ffd166';
    context.lineWidth = 3; context.strokeRect(x, y, w, h);
    context.font = 'bold 14px system-ui'; context.fillText(`#${index + 1}`, x + 4, Math.max(16, y - 5));
  }
  write('qr-count-label', `${latestDetections.length} QR · ${beam} Beam`);
}
new ResizeObserver(drawDetections).observe($('video'));
function scheduleScan() {
  // Keep captured windows/tabs readable when selecting the sender hides Beam.
  if (captureSource === 'screen' && document.hidden) screenTimer = setTimeout(() => scan(performance.now()), 50);
  else animation = requestAnimationFrame(scan);
}
function scan(now) {
  if (!scanning) return;
  scheduleScan();
  const video = $('video');
  if (decodeBusy || video.readyState < 2 || video.currentTime === lastVideoTime || now - lastScanAt < 8) return;
  lastVideoTime = video.currentTime; lastScanAt = now;
  if (!video.videoWidth || !video.videoHeight) return;
  decodeBusy = true;
  const generation = cameraGeneration;
  if (detector) {
    // Native detection can read the video directly, avoiding a full canvas copy.
    const nativeDetector = detector;
    Promise.resolve().then(() => {
      if (generation !== cameraGeneration || !scanning) return [];
      return nativeDetector.detect(video);
    }).then(codes => {
      if (generation !== cameraGeneration || !scanning) return;
      updateDetections(codes.map(code => ({ text: code.rawValue, points: code.cornerPoints?.length ? code.cornerPoints : code.boundingBox ? [
        { x: code.boundingBox.x, y: code.boundingBox.y },
        { x: code.boundingBox.x + code.boundingBox.width, y: code.boundingBox.y + code.boundingBox.height },
      ] : [] })), video.videoWidth, video.videoHeight);
      for (const code of codes) acceptFrame(code.rawValue);
    }).catch(() => {
      if (generation !== cameraGeneration) return;
      // Some implementations advertise QR but fail at runtime. Switch to the local worker.
      detector = null;
      try { createDecodeWorker(generation); }
      catch {
        stopCamera(); message('receive-message', 'The QR decoder could not start. Reload Beam and try again.', true);
      }
    }).finally(() => { if (generation === cameraGeneration) decodeBusy = false; });
  } else if (decodeWorker) {
    try {
      // Preserve detail for dense codes, but bound work per camera frame.
      const scale = Math.min(1, (captureSource === 'screen' ? 3840 : 1920) / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
      if (scanCanvas.width !== width || scanCanvas.height !== height) { scanCanvas.width = width; scanCanvas.height = height; }
      scanContext.drawImage(video, 0, 0, width, height);
      const data = scanContext.getImageData(0, 0, width, height);
      decodeWorker.postMessage({ buffer: data.data.buffer, width, height, generation }, [data.data.buffer]);
    } catch {
      stopCamera(); message('receive-message', 'The camera frame could not be read. Resume the camera to try again; your progress is kept.', true);
    }
  } else decodeBusy = false;
}
function acceptFrame(text) {
  if (finishPending || receiver.verified || typeof text !== 'string' || !/^B[12]:/.test(text)) return;
  const before = receiver.collected;
  const result = receiver.accept(text);
  if (result === 'rejected') { write('receive-note', 'A damaged frame was ignored. New repair codes will fill the gap.'); return; }
  if (result === 'foreign') { message('receive-message', 'A different transfer is in view. Resume the original signal or clear this transfer.', true); return; }
  if (result === 'waiting') { updateReceiver(); write('camera-status', 'SIGNAL FOUND'); message('receive-message', 'Signal found. Waiting for file information, which repeats automatically.'); return; }
  if (receiver.collected > before || result === 'accepted' || result === 'manifest' || result === 'complete') {
    lastAcceptedAt = Date.now(); updateReceiver();
    write('camera-status', 'RECEIVING FILE'); write('receive-activity', 'SIGNAL FOUND');
    message('receive-message', 'Keep the code in view. Missing pieces are collected automatically.');
  }
  if (receiver.complete) completeReceive();
}
function updateReceiver() {
  const r = receiver, ratio = r.count ? Math.round(100 * r.collected / r.count) : 0;
  write('receive-title', r.meta?.name || 'Waiting for a file'); write('receive-file', r.meta?.name || 'No signal yet');
  write('percent', `${ratio}%`); $('progress').value = ratio;
  write('received-count', r.count ? `${r.collected.toLocaleString()} / ${r.count.toLocaleString()} pieces` : '0 pieces collected');
  const bytes = r.receivedBytes;
  write('receive-bytes', r.meta ? format(bytes) : '—'); write('recovered', `${r.recovered} blocks`);
  const elapsed = (Date.now() - r.startedAt) / 1000;
  write('receive-rate', r.meta && elapsed > 0 ? `${format(Math.round(bytes / Math.max(1, elapsed)))}/s` : '—');
  const remaining = r.meta ? Math.max(0, r.meta.packedSize - bytes) : 0;
  write('receive-eta', r.verified ? 'Complete' : !r.meta ? 'Waiting for a file.' : r.complete ? 'Verifying file…' : bytes > 0 && elapsed > 0 ? `Estimated remaining: ${duration(remaining * elapsed / bytes)}` : 'Estimating remaining time…');
  $('clear-receive').disabled = !r.meta && r.pending.length === 0;
}
async function completeReceive() {
  finishPending = true; const completed = receiver;
  stopCamera(); $('camera-start').disabled = true;
  write('camera-status', 'VERIFYING FILE'); message('receive-message', 'All blocks received. Checking the complete file…');
  try {
    const bytes = await completed.finish();
    if (receiver !== completed) return;
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    $('download').href = downloadUrl;
    $('download').download = completed.meta.name.replace(/[\\/\u0000-\u001f]/g, '_');
    show('download'); show('verified');
    if (completed.meta.kind === 'text') {
      $('received-text').value = new TextDecoder().decode(bytes);
      show('received-text-wrap'); write('copy-text', 'Copy text');
    }
    write('receive-eta', 'Complete');
    write('camera-status', 'FILE VERIFIED'); $('camera-status').className = 'status-label success';
    $('camera-empty').querySelector('h3').textContent = 'Every piece, in place.';
    $('camera-empty').querySelector('p').textContent = 'Your file passed verification and is ready to save.';
    write('receive-activity', 'COMPLETE'); write('camera-start', 'Transfer complete ✓');
    message('receive-message', 'Your file is ready. You can stop the sender now.');
    write('receive-note', `SHA-256 verified · ${format(completed.meta.size)} · ${completed.recovered} blocks recovered with repair codes`);
    $('receive-note').title = completed.meta.sha256;
  } catch (error) {
    if (receiver !== completed) return;
    message('receive-message', error.message || 'The file did not pass verification. Clear this transfer and try again.', true);
    write('camera-status', 'VERIFICATION FAILED'); write('receive-activity', 'NOT SAVED');
    write('camera-start', 'Clear transfer to retry'); $('camera-start').disabled = true;
    write('receive-note', 'No download was created because the file did not pass verification.');
  } finally { if (receiver === completed) finishPending = false; }
}
function resetReceiver() {
  stopCamera(); receiver = new Receiver(); finishPending = false;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null;
  $('download').removeAttribute('href'); show('download', false); show('verified', false);
  show('received-text-wrap', false); $('received-text').value = '';
  syncCaptureButtons(); write('camera-start', 'Start camera ↗');
  write('camera-status', 'CAMERA OFF'); write('receive-activity', 'READY TO SCAN');
  message('receive-message', 'Ready for a new file. Start the camera when the sender is ready.');
  write('receive-note', 'A download becomes available only after the complete file passes verification.'); $('receive-note').removeAttribute('title');
  $('camera-empty').querySelector('h3').textContent = 'Catch the signal.';
  $('camera-empty').querySelector('p').textContent = 'Start your camera, then aim it at the sender’s screen.';
  updateReceiver();
}
$('clear-receive').onclick = () => {
  if (receiver.collected && !receiver.verified && !confirm('Clear the pieces collected for this file?')) return;
  resetReceiver();
};
$('copy-text').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('received-text').value);
    write('copy-text', 'Copied ✓');
  } catch {
    $('received-text').focus(); $('received-text').select();
    message('receive-message', 'Text selected. Use your device’s Copy command, or save the .txt file.');
  }
};
setInterval(() => {
  if (!scanning || finishPending || !receiver.meta) return;
  updateReceiver();
  if (lastAcceptedAt && Date.now() - lastAcceptedAt > 7000) {
    write('receive-activity', 'WAITING FOR PIECES');
    message('receive-message', 'Progress is kept. Hold steady, move closer, or lower the sender’s speed.');
  }
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (running) { pauseSend(); message('send-message', 'Signal paused because this tab was hidden. Resume when the receiver is ready.'); }
    if ((scanning || cameraPending) && captureSource === 'camera') { stopCamera(); message('receive-message', 'Camera paused while this tab was hidden. Resume to continue.'); }
    else if (scanning) { cancelAnimationFrame(animation); clearTimeout(screenTimer); scheduleScan(); }
  } else {
    if (scanning && captureSource === 'screen') { clearTimeout(screenTimer); cancelAnimationFrame(animation); scheduleScan(); }
    syncWakeLock();
  }
});
window.addEventListener('pagehide', event => {
  if (running) pauseSend();
  if (scanning || cameraPending) stopCamera();
  // A back/forward-cache entry keeps the page and its verified download alive.
  if (!event.persisted && downloadUrl) URL.revokeObjectURL(downloadUrl);
});

// Optional browser agent interface. It exposes state and mode navigation only.
// Choosing files and granting camera access still use normal browser controls.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const tools = [
    { name: 'get_transfer_status', description: 'Read the current mode and transfer progress. Does not return file contents.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute(input) {
      if (!input || Object.keys(input).length) throw new Error('This tool takes no arguments.');
      return { mode, sending: running, scanning, blocksReceived: receiver.received, blocksTotal: receiver.count, verified: receiver.verified };
    } },
    { name: 'select_transfer_mode', description: 'Select send or receive. Switching pauses the current signal or camera and preserves received blocks.', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['send', 'receive'] } }, required: ['mode'], additionalProperties: false }, annotations: { readOnlyHint: false }, execute(input) {
      if (!input || Object.keys(input).some(k => k !== 'mode')) throw new Error('Only mode is accepted.');
      selectMode(input.mode); return { mode };
    } },
  ];
  for (const tool of tools) {
    try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {}
  }
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('./sw.js').then(registration => {
    const updateStatus = () => {
      if (registration.waiting) write('offline-state', 'Update ready · close all Beam tabs and reopen');
      else if (registration.active?.state === 'activated') write('offline-state', 'Ready to reopen offline');
    };
    const watchInstall = () => {
      registration.installing?.addEventListener('statechange', updateStatus);
      updateStatus();
    };
    registration.addEventListener('updatefound', watchInstall);
    watchInstall();
  }).catch(() => { write('offline-state', 'Keep this page open for offline use'); });
}
