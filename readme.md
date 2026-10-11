# Beam

A small, browser-only application that moves files and pasted text from a display to a camera or browser screen capture through animated QR codes. No uploads, accounts, pairing, runtime CDN, or build dependencies.

## Use

1. Open the app on both devices. On the sender, select a document or file (no fixed product size cap), or choose **Paste text** and enter text in any language.
2. On the receiver, choose **Receive a file**, click **Start camera** and point it at the sender, or click **Capture screen** and choose the sender’s tab, window, or entire screen in the browser’s native picker.
3. Start the signal. Keep the whole code in view. Use fullscreen or move closer if necessary.
4. Wait for **File verified**, then press **Save verified file**. For pasted text, you can also read and copy the verified text. Pause the sender manually afterward.

The sender repeats indefinitely. The receiver retains valid blocks across camera pauses and mode changes. A refresh or closed tab loses this in-memory progress. The sender has no feedback channel, so it cannot automatically know when the receiver has finished.

Start with the defaults: Auto layout, high density, 20 fps. Auto fills the available webpage at the selected QR size, with no eighteen-code cap. Every gap between QR canvases is exactly 4 CSS pixels, in both auto and manual layouts. Display sizes adjust in 8px steps instead of snapping to a whole QR-width multiple. Each canvas uses an integer-module backing raster and pixelated display scaling, retaining its four-module quiet zone without redundant slot padding. All canvases have equal square dimensions, even when QR versions differ. Manual counts are **1, 2, 4, 6, 8, 15, or 18**; 2 uses one row, 4/6/8 use two rows, and 15/18 use three rows. Auto and manual layouts with four or more codes hide other page elements and use the webpage without outer padding. The expand button also fills the webpage. No browser fullscreen API is used: press **F11** yourself if desired. Pause/exit, Esc, and **− / +** share a 30px-high notch centred at the bottom edge with zero bottom margin. The notch slides away after 1.5 seconds idle; hovering or tapping the bottom edge reveals it. Hovering the controls or focusing them with the keyboard keeps it open. Esc remains available while the notch is hidden. **− / +** adjusts QR size by 8px per click; **Pause & exit** or **Esc** restores the controls. Resizing, including F11 and browser zoom, preserves the running transfer and updates the count and time estimate. Changing density or editing text prepares a new transfer; clear the old transfer on the receiver first. Changing speed, code count, or pausing preserves the transfer identity.

## Capture preview and QR positions

Both input modes draw numbered green boxes around decoded Beam QR codes and amber boxes around other decoded QR codes. The per-frame counter shows all decoded QR codes and the subset carrying Beam frames. Boxes clear on the next decoded frame; an undecodable QR has no box, so the counter describes successfully decoded codes, not every visible QR-like shape.

Screen capture requests video only. Use desktop Chrome or Edge over HTTPS or localhost; the sharing picker and surface choices belong to the browser. If you select another tab, receiving continues in the background (browser throttling can reduce speed). Stopping sharing, pausing, or switching inputs releases the previous stream and retains received blocks. Camera mode still pauses when its page is hidden. Screen frames retain up to 3840 pixels on their longest side; camera frames retain up to 1920. For very small codes, capture the sender’s tab or window rather than an entire high-resolution desktop.

## File size and transfer time

There is no fixed 10 MiB or 128 MiB file cap. Preparing, hashing, compressing, and verifying files currently uses memory, so actual capacity depends on the browser and device. B3 uses 32-bit source-object addresses and 24-bit RFC6330 symbol IDs. Large-file capability still depends on memory: this release has verified 129 MiB incompressible files under loss, without imposing a new product size limit.

After preparation, the sender shows a minimum estimate for one pass, based on the compressed payload, manifest frames, selected FPS, and code count. This updates when speed or code count changes; it assumes every displayed code is decoded. The receiver shows estimated remaining time using useful collected packed bytes and elapsed time, including pauses. Missed frames and decode speed can make actual transfer longer.

## Run or host

The application lives directly in the repository root. No build or package installation is needed to use the checked-in files.

**Open the HTML directly:** double-click `index.html`; it opens the included `standalone.html`. You can also open or copy `standalone.html` by itself. This version contains the styles, QR encoder, decoder/WASM, and worker code, so it works without a server or an initial online visit. Browser camera support for local files varies; use the localhost option below if your browser restricts it.

**Use Python:** from the directory containing `index.html`, run:

```sh
python -m http.server
```

Open `http://localhost:8000` on that computer. The unmodified Python standard-library server is enough: no special headers, packages, or backend are required. To listen only on that computer, add `--bind 127.0.0.1`.

For GitHub Pages, push these files to `master`, then select **Settings → Pages → Deploy from a branch → master → / (root) → Save**. The root `.nojekyll` file lets GitHub serve the bundled assets directly. All app URLs are relative, so both `https://user.github.io/beam/` and a custom domain work. See [GitHub's publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

For a local desktop, Node 20+ can serve the files:

```sh
npm start
```

Then open `http://localhost:8080` on that computer. For a second device, open its own copy of `standalone.html`, use GitHub Pages/HTTPS, or run a local server on that device. `http://192.168.x.x` does not normally qualify for camera permission. See [MDN's camera security requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security).

Load the app once on each device and wait for **Ready to reopen offline**. Its service worker caches the app and its runtime libraries. The transfer then works without a network connection. Browser cache eviction, private browsing, or service-worker restrictions may prevent later offline reopening. No file contents, camera frames, or captured screen frames are sent over a network.

An app update waits until all Beam tabs at that address close, so a transfer keeps using one release. Reopen after closing those tabs to apply it. Each hosted path has its own cache. When releasing changes to any cached asset, bump the cache version in `sw.js`.

For source changes, regenerate the portable file with `npm run build:standalone` (or `node build-standalone.mjs`). The build uses only Node's standard library and the same source files as the hosted app. Tests check that the committed portable file is current. Keep the bundled dependency licenses and corresponding source files when redistributing the project.

## RaptorQ transfer

Beam 3 sends **B3 / RaptorQ (RFC 6330)** using the mature Rust
[cberner/raptorq 2.0.1](https://github.com/cberner/raptorq) implementation compiled
to locally bundled WASM. The interface, QR renderer, scanner, Base45, CRC-32,
compression and SHA-256 checks remain in place. B1/B2 reception remains supported;
update both devices to send B3. The former XOR sender is retained only as a
benchmark/regression baseline, never used by the application sender.

All original symbols are sent first. Subsequent passes stream fresh repair
symbols across 1024-symbol source blocks (384 KiB, 720 KiB or 1 MiB). Blocks are
independently framed RFC objects, avoiding the 255-source-block restriction on a
single RaptorQ object. Repair streams continue indefinitely; RFC's finite
24-bit ESI space eventually cycles valid repairs. See [packet format](docs/PACKET-V3.md).

A persistent codec Web Worker owns file preparation, compression, RaptorQ
encoding/decoding, decompression and SHA-256 verification. Separate existing
workers handle QR construction and fallback QR scanning. Camera/screen pauses
and adaptive layout changes do not reset codec state. QR preparation and codec
input are bounded; the scanner waits for codec acceptance before reading another
frame rather than growing an unbounded message backlog. Large encoder caches use
a 32 MiB source-data LRU budget; solved decoders release their Rust state.

Useful-symbol progress is an estimate, and caps at **99%** until the whole file
has been decoded, decompressed, size checked and SHA-256 verified. Failed
verification never enables a download or displays 100%. Duplicate packets do
not advance progress. Transfer contents remain in memory until replaced or cleared.

## Validation and performance

Run `npm test` with Node 20+: 85 regression and RaptorQ tests passed in this
release. They cover real bundled WASM loss recovery at 10%, 30%, and 50%,
repair-only late joins, permanently missing originals, partial source blocks,
empty files, corruption and valid-CRC tampering, legacy reception, bounded
encoder caching, progress/verification, worker generations, adaptive layouts,
screen/camera lifecycles, offline hosting and the portable build. Existing QR
image tests include 72 compact QR cells with 4px gaps and returned positions.

Actual headless Chromium tested the hosted sender, the network-blocked
file:// standalone sender, and the receiver with repair-only lossy input,
producing a byte-exact verified download. Camera input in that browser test was
synthetic; physical cameras, capture pickers and real optical throughput were
not measured. The benchmark transmission times divide packets by selected
FPS × QR count and are simulations, not measured device speeds.

Reproduce codec comparisons with `npm run benchmark:codec`, and the 129 MiB
stress test with `npm run test:large`. See [validation report](docs/VALIDATION.md)
for packet counts, CPU measurements, reliability and memory details. The
original and new implementations receive seeded losses and verify every
completed file. The frozen original
baseline is the top-level `legacy-protocol.js`.

The sender has no feedback path. It therefore repairs every object even when
some are already decoded, and a receiver joining after the systematic pass
must collect enough repair symbols. QR rendering/scanning and browser memory
can limit real throughput independently of codec efficiency. SHA-256 checks
integrity against transmitted metadata; it does not authenticate the sender or
encrypt the optical channel.

## Build and source layout

Users can run the included files without installing anything. To rebuild the
portable page after JavaScript/CSS changes, run `npm run build:standalone`.
To rebuild the codec, install Rust and its `wasm32-unknown-unknown` target, then
run `npm run build:codec` and `npm run build:standalone`. The complete pinned
crate source ships under `codec/raptorq/`, and Cargo builds with `--locked
--offline`. See [codec build instructions](codec/README.md).

The UI is in `app.js`; `codec-client.js` mirrors worker state and provides lazy
schedules. `codec-worker.js` owns persistent transfer state, and
`raptor-protocol.js` handles B3 framing and the small Rust ABI.
`protocol.js` contains shared Base45/CRC/file helpers and the compatibility
receiver. `legacy-protocol.js` freezes the original benchmark baseline.
`raptor-wasm.js` embeds the same binary as `vendor/raptorq.wasm`, enabling the
single portable HTML file. QR scanning/rendering stay in the existing
`decode-worker.js` and `encode-worker.js`. `sw.js` atomically caches all runtime
assets for hosted offline use.

Optional real-browser regression testing requires development-only Playwright:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

`BEAM_CHROME_EXECUTABLE` can select an existing Chromium executable. This is
never a runtime dependency of the application.

## Attribution

This implementation uses the uploaded `airgapped-qr-code-transfer-master` project by Mohan Kumar as a reference for the screen-to-camera workflow. The Beam application code is a new implementation. The original project's MIT license is retained in `REFERENCE-LICENSE`.

Bundled dependencies, whose licenses remain alongside their files:

- [node-qrcode 1.4.4](https://github.com/soldair/node-qrcode), MIT, browser build. This pinned release includes the ready-to-use browser bundle.
- [zbar-wasm 0.11.0](https://github.com/undecaf/zbar-wasm), LGPL-2.1, unmodified browser bundle with inline WASM. Its license is included; the library can be replaced independently of Beam.
- [jsQR 1.4.0](https://github.com/cozmo/jsQR), Apache-2.0; retained as the test/benchmark baseline, not loaded by the app.

The app's original code is available under the MIT license in `LICENSE`.

- [raptorq 2.0.1](https://github.com/cberner/raptorq), Apache-2.0; pinned unmodified Rust source and license under `codec/raptorq/`, compiled into local/embedded WASM.
