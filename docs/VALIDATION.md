# Validation — Beam 3 / RaptorQ

85 automated tests passed, using the actual distributed Rust/WASM binary. They cover 10%, 30%, and 50% independent packet loss, repair-only decoding, permanently missing original symbols, empty files, partial blocks, CRC/SHA corruption, source objects above index 255, legacy B1/B2 reception, worker reset/disposal, progress below 100 until verification, and all existing UI/QR/offline regressions.

Actual Chromium exercised real workers on the hosted app and fully embedded file:// standalone sender, with external networking blocked for the standalone page. The hosted receiver verified a byte-exact download after all originals and every fifth repair packet were omitted. This is synthetic video/detection input, not a physical camera or native screen-picker test.

## Original XOR versus RaptorQ

Both versions send the same incompressible seeded input using 1024-byte symbols. Displayed-packet counts include manifest overhead. Every completed file is byte compared and SHA-256 verified. Loss streams and schedule RNG are reproducible in the included benchmark. The protocol harness jitters manifest gaps randomly at 29–35 symbols; the browser uses an equivalent small periodic jitter table so schedules can be generated lazily. QR workers and worker-message overhead are excluded from the codec timing. One MiB uses 10 trials per codec/loss,8 MiB uses 5, and 129 MiB+17 bytes uses 1. Thus the large-file comparison is a representative run, not a reliability probability estimate.

| File | Loss | XOR packets | RaptorQ packets | Fewer packets | XOR ideal seconds | RaptorQ ideal seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 MiB | 10% | 1,825.1 | 1,180.0 | 35.3% | 5.07 | 3.28 |
| 1 MiB | 30% | 2,572.8 | 1,521.6 | 40.9% | 7.15 | 4.23 |
| 1 MiB | 50% | 3,671.8 | 2,133.7 | 41.9% | 10.20 | 5.93 |
| 8 MiB | 10% | 16,934.4 | 9,747.0 | 42.4% | 47.04 | 27.07 |
| 8 MiB | 30% | 24,225.2 | 12,550.4 | 48.2% | 67.29 | 34.86 |
| 8 MiB | 50% | 33,604.8 | 17,783.0 | 47.1% | 93.35 | 49.40 |
| 129 MiB + 17 B | 10% | 403,342.0 | 161,508.0 | 60.0% | 1120.39 | 448.63 |
| 129 MiB + 17 B | 30% | 423,217.0 | 204,307.0 | 51.7% | 1175.60 | 567.52 |
| 129 MiB + 17 B | 50% | 592,743.0 | 288,859.0 | 51.3% | 1646.51 | 802.39 |

Ideal seconds are packets/(20 fps×18 QR), assuming every display frame appears at the selected pace and loss is exactly the modelled rate. They exclude preparation, scanner latency, physical camera exposure and QR rendering. They are not measured optical completion times.

| File | Loss | XOR codec CPU ms | RaptorQ codec CPU ms | CPU change |
| --- | ---: | ---: | ---: | ---: |
| 1 MiB | 10% | 225.5 | 164.2 | -27.2% |
| 1 MiB | 30% | 256.2 | 160.4 | -37.4% |
| 1 MiB | 50% | 274.7 | 169.2 | -38.4% |
| 8 MiB | 10% | 2,637.7 | 1,201.8 | -54.4% |
| 8 MiB | 30% | 2,240.7 | 1,208.3 | -46.1% |
| 8 MiB | 50% | 2,461.7 | 1,356.2 | -44.9% |
| 129 MiB + 17 B | 10% | 46,242.2 | 50,043.1 | +8.2% |
| 129 MiB + 17 B | 30% | 40,614.0 | 28,069.7 | -30.9% |
| 129 MiB + 17 B | 50% | 45,272.2 | 37,856.0 | -16.4% |

CPU uses Node process.cpuUsage around packet generation, parsing, decoding and verification, excluding file preparation. It includes Base45/CRC and GC, and can exceed elapsed wall time when other runtime threads are active. Encoding/decoding/verification elapsed timings and preparation costs remain separately recorded in the JSON files. Results were collected on this shared host, so small timing differences should not be treated as stable device performance. RaptorQ mathematics is heavier than a 16-symbol XOR operation, but fewer total packets make the full pipeline cheaper in most runs. At 129 MiB/10% loss, measured CPU was higher even though transmission used far fewer packets.

All 96 comparison transfers verified (60 one-MiB,30 eight-MiB,6 large transfers). The separate 129 MiB stress tests also verified at each requested loss rate. This is tested reliability for these finite runs, not a claim of deterministic success with exactly K symbols; RaptorQ may need a few extra symbols.

## Memory and source block choice

The chosen 1024-symbol block size removes the previous 16-symbol loss-recovery bottleneck while keeping each codec object at 384 KiB–1 MiB. Encoding plans are reused by the mature crate. Objects are independent RFC 6330 objects, so their Beam block number can exceed 255. Interleaved 64-symbol repair runs reduce the effect of one unlucky source object on final completion. Without receiver feedback, the sender still repairs objects the receiver has already decoded.

Encoders use a 32 MiB source-data LRU budget; source plus intermediate slabs consume roughly twice that, and decoder state is released on block completion. Before bounding this cache, combined sender/receiver WASM high-water memory reached 405.75 MiB on the large test. The final combined tests reached approximately 201–204.44 MiB. That heap does not shrink, but freed allocations are reused. Actual sender and receiver are normally separate pages/devices.

The 129 MiB stress process RSS peaked at approximately 1.08–1.91 GiB across repeated trials. Those numbers include test input buffers, Blob/File copies, both sides, decoded files and prior retained allocations; they are not per-device browser memory figures. File preparation and complete-file verification still use in-memory buffers. There is no product 128 MiB cap, but sufficiently large files can exhaust browser memory.

## Reproduce

```sh
npm test
npm run build:standalone -- --check
npm run benchmark:codec
BEAM_BENCH_BYTES=8388608 BEAM_BENCH_TRIALS=5 npm run benchmark:codec
BEAM_BENCH_BYTES=135266321 BEAM_BENCH_TRIALS=1 npm run benchmark:codec
npm run test:large
```

Browser smoke testing requires development-only Playwright and Chromium; run npm run test:browser. Codec rebuild instructions are in codec/README.md. All runtime assets and the full pinned crate source are included.

Independent code review found sender memory retained after input invalidation. Generation-aware disposal was added for cleared/replaced files and cancelled preparation results, with a regression test. Review of that fix found no further important issues.

Raw results: benchmark-1MiB.json, benchmark-8MiB.json, benchmark-129MiB.json, large-file-results.json. legacy-protocol.js is the frozen baseline; it is never loaded by the application.
