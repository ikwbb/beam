# Dense 4K screen capture in Beam

On the sender, choose a file and select the 18-code grid (6 columns × 3 rows) for a repeatable check. On the receiver, use **Capture screen** in Chrome and select the sender's browser tab. Start around 8–10 fps, watch the number of Beam codes recognized in each frame, and raise the speed after the count is stable. Keep the sender viewport large. Compare tab and display capture if the readout shows a lower resolution than you expected. Capture dimensions are the browser's reported video dimensions, not the monitor's advertised panel resolution.

The receiver shows **capture resolution · decoder · decode time · scans/s**. The actual scans/s value is based on completed scan callbacks, and can be lower than the sender's setting or the refresh rate. If a held frame reads nearly every QR code but the received rate is slow, changing FPS is the first thing to try. If the held frame itself misses QR codes, start with Balanced density or enlarge the tiles. Screen pixels that are already too blurred or undersampled cannot always be recovered by a scanner.

The former screen path used the browser's native barcode API if available, and fell back to ZBar only on an exception. Detecting a partial set is not an exception. Its full-frame ZBar decoder needed much more time on 4K synthetic frames than 1080p. At lower capture resolutions the dense codes approach one pixel per module, and the much smaller file-information QR can remain readable even when the data QRs do not. This explains a plausible failure mode without implying the Mac's actual capture feed was measured. The practical comparison is the capture readout and scan count on the Mac itself.

The new screen-only path uses local ZXing-C++ WASM in the existing worker. It locates the dark separators between Beam's white cells and decodes each cell with its known upright orientation, keeping the source resolution for small cells. It retries misses and can scan arbitrary screenshots if a regular grid is not found. The camera path, QR wire format, and large-file disk path are unchanged. The standalone build embeds the decoder binary and licenses; hosted Beam includes the same offline-cached assets.

Run `npm test` for a dense downscaled regression and `npm run test:screen-browser` for the Chromium canvas-capture test. The latter uses actual video frames, browser workers and the same QR raster geometry as Beam, but not the operating system picker. Set `BEAM_CHROME_EXECUTABLE` if using an existing Chromium executable.

A deterministic High-density B3 run on headless Chromium produced these counts on this test machine:

| Captured video | Grid | Previous bundled full-frame scan | New screen scan |
| --- | ---: | ---: | ---: |
| 3840 × 2160 | 18 | 18 | 18 |
| 3840 × 2160 | 21 | 21 | 21 |
| 1280 × 720 | 18 | 5 | 18 |
| 1280 × 720 | 21 | 0 | 21 |

In these single-frame 4K runs the former ZBar scan took 688–694 ms and the new worker reported 93–125 ms, including its first-frame initialization. These figures compare the bundled scan paths on this machine only and do not benchmark the Mac's native barcode API or predict real transfer throughput. The automated suite and bundled portable-worker regressions cover disk-backed file transfer and camera paths as well.
