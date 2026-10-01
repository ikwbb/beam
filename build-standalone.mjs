// Build the portable page from the same sources used by the HTTP app.
// No package installation, bundler, server, or runtime network request is needed.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = new URL('./', import.meta.url);
const normalizeLines = text => text.replace(/\r\n/g, '\n');
const read = async path => normalizeLines(await readFile(new URL(path, root), 'utf8'));
const stripSourceMaps = source => source.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, '').trim();
const escapeHTML = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function replaceOnce(source, pattern, replacement, label) {
  let count = 0;
  const output = source.replace(pattern, (...args) => { count++; return typeof replacement === 'function' ? replacement(...args) : replacement; });
  if (count !== 1) throw new Error(`Expected one ${label}; found ${count}. Update the standalone build for the changed source.`);
  return output;
}

// These small, known modules use named declarations or one named export list.
// Fail on new module syntax instead of silently shipping an incomplete bundle.
function classicModule(source, label) {
  const names = [];
  let code = stripSourceMaps(source).replace(/^export (const|let|class|(?:async )?function) (\w+)/gm, (_, kind, name) => {
    names.push([name, name]); return `${kind} ${name}`;
  });
  code = code.replace(/export\{([^}]+)\};?\s*$/, (_, list) => {
    for (const entry of list.split(',')) {
      const match = entry.trim().match(/^(\w+)(?: as (\w+))?$/);
      if (!match) throw new Error(`Unsupported export in ${label}: ${entry}`);
      names.push([match[2] || match[1], match[1]]);
    }
    return '';
  });
  code = code.replaceAll('import.meta.url', 'self.location.href');
  const wrapped = `(() => {\n${code}\nreturn { ${names.map(([name, local]) => `${name}: ${local}`).join(', ')} };\n})()`;
  new vm.Script(wrapped, { filename: label });
  return wrapped;
}

function removeImport(source, path) {
  const statement = new RegExp(`^import \\{ ([^}]+) \\} from '${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}';\\r?\\n`);
  let names;
  const code = replaceOnce(source, statement, (_, imports) => { names = imports; return ''; }, `import from ${path}`);
  return { code, names };
}

// Keep HTML's raw-text parser from interpreting JS string/comment contents.
export const scriptText = source => source.replace(/<(\/script|script|!--)/gi, '\\x3c$1');

export async function renderStandalone() {
  const paths = ['index.html', 'styles.css', 'app.js', 'protocol.js', 'encode-worker.js', 'decode-worker.js', 'decoder.js', 'vendor/qrcode.js', 'vendor/zbar.mjs', 'LICENSE', 'REFERENCE-LICENSE', 'vendor/QRCODE-LICENSE', 'vendor/ZBAR-LICENSE', 'vendor/THIRD-PARTY-NOTICES.md', 'vendor/source/README.md'];
  const values = await Promise.all(paths.map(read));
  const sources = Object.fromEntries(paths.map((path, i) => [path, values[i]]));
  const qr = stripSourceMaps(sources['vendor/qrcode.js']);
  const encoder = replaceOnce(sources['encode-worker.js'], /^importScripts\('\.\/vendor\/qrcode\.js'\);\r?\n/, `${qr}\n`, 'encoder dependency');
  const decoder = removeImport(sources['decoder.js'], './vendor/zbar.mjs');
  const decodeWorker = removeImport(sources['decode-worker.js'], './decoder.js');
  const decoding = `const { ${decoder.names} } = ${classicModule(sources['vendor/zbar.mjs'], 'vendor/zbar.mjs')};\nconst { ${decodeWorker.names} } = ${classicModule(decoder.code, 'decoder.js')};\n${decodeWorker.code}`;
  const workers = { encode: encoder, decode: decoding };
  for (const [name, code] of Object.entries(workers)) new vm.Script(code, { filename: `${name}-worker.js` });

  const app = removeImport(sources['app.js'], './protocol.js');
  let code = replaceOnce(app.code, /new Worker\('\.\/encode-worker\.js'\)/g, "createEmbeddedWorker('encode')", 'encoder worker');
  code = replaceOnce(code, /new Worker\('\.\/decode-worker\.js', \{ type: 'module' \}\)/g, "createEmbeddedWorker('decode')", 'decoder worker');
  code = replaceOnce(code, /^if \([^\n]*'serviceWorker' in navigator[^\n]*\) \{[\s\S]*\n\}\s*$/gm, '', 'service worker registration');
  const main = `${qr}\n(() => {\nconst { ${app.names} } = ${classicModule(sources['protocol.js'], 'protocol.js')};
const workerSources = JSON.parse(document.getElementById('beam-worker-sources').textContent);
const workerURLs = new Map();
function createEmbeddedWorker(name) {
  if (!workerURLs.has(name)) workerURLs.set(name, URL.createObjectURL(new Blob([workerSources[name]], { type: 'text/javascript' })));
  return new Worker(workerURLs.get(name));
}
window.addEventListener('pagehide', event => {
  if (!event.persisted) for (const url of workerURLs.values()) URL.revokeObjectURL(url);
});
${code}
write('offline-state', 'Ready offline · standalone file');
})();`;
  new vm.Script(main, { filename: 'standalone.js' });

  let html = sources['index.html'].replace(/\s*<!-- standalone:exclude:start -->[\s\S]*?<!-- standalone:exclude:end -->/g, '');
  html = replaceOnce(html, /<link rel="stylesheet" href="\.\/styles\.css">/g, `<style>\n${sources['styles.css'].replace(/<\/style/gi, '<\\/style')}\n</style>`, 'stylesheet');
  html = replaceOnce(html, /\s*<script src="\.\/vendor\/qrcode\.js" defer><\/script>/g, '', 'QR script');
  html = replaceOnce(html, /\s*<script type="module" src="\.\/app\.js"><\/script>/g, '', 'app script');
  html = replaceOnce(html, /<a href="\.\/" class="brand"/g, '<a href="#" class="brand"', 'home link');
  const licenses = ['LICENSE', 'REFERENCE-LICENSE', 'vendor/QRCODE-LICENSE', 'vendor/ZBAR-LICENSE', 'vendor/THIRD-PARTY-NOTICES.md', 'vendor/source/README.md']
    .map(path => `<h3>${path}</h3><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(sources[path])}</pre>`).join('\n');
  const notices = `<details class="help"><summary>Open-source licenses and decoder source</summary><div class="help-content"><p>This portable file is generated with <code>node build-standalone.mjs</code> from Beam's application sources. To modify or replace its LGPL decoder, replace <code>vendor/zbar.mjs</code> and rebuild. Reverse engineering for debugging library modifications is not restricted.</p><p>Corresponding decoder sources and build instructions ship in <code>vendor/source/</code> with the Beam source distribution. They are also available upstream: <a href="https://github.com/undecaf/zbar-wasm/tree/c04ab59682681e27a24b36b36084806437a5d224">zbar-wasm 0.11.0</a> and <a href="https://github.com/mchehab/zbar/tree/0.23.90">ZBar 0.23.90</a>. Keep the source distribution and its license notices together when redistributing Beam.</p>${licenses}</div></details>`;
  html = replaceOnce(html, /<\/main>/g, `${notices}\n</main>`, 'main closing tag');
  // JSON escaping preserves worker bytes exactly and cannot close the data script.
  const workerJSON = JSON.stringify(workers).replaceAll('<', '\\u003c');
  html = replaceOnce(html, /<\/body>/g, `<script id="beam-worker-sources" type="application/json">${workerJSON}</script>\n<script id="beam-standalone">\n${scriptText(main)}\n</script>\n</body>`, 'body closing tag');
  html = html.replace('<!doctype html>', '<!doctype html>\n<!-- Generated by node build-standalone.mjs. Edit the application sources, then rebuild. -->');
  return html;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = await renderStandalone();
  const target = new URL('standalone.html', root);
  if (process.argv.includes('--check')) {
    if (normalizeLines(await readFile(target, 'utf8').catch(() => '')) !== html) throw new Error('standalone.html is stale. Run node build-standalone.mjs.');
    console.log('standalone.html matches the current sources.');
  } else {
    await writeFile(target, html);
    console.log(`Built standalone.html (${Math.round(Buffer.byteLength(html) / 1024)} KiB).`);
  }
}
