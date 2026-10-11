# RaptorQ build

Users need only the distributed HTML/JS/WASM. No Rust, installation or network
access is needed to run Beam.

Developer rebuild (Rust 1.99.0 was used for this release):

```sh
rustup target add wasm32-unknown-unknown
node build-raptorq.mjs
node build-standalone.mjs
npm test
```

The build runs Cargo with `--locked --offline`; its only dependency is the
complete, unmodified Apache-2.0 raptorq 2.0.1 source beside Cargo.toml. Installing
Rust and its WASM standard library is a development-only prerequisite. The
binary is emitted twice: local vendor/raptorq.wasm and embedded base64 in
raptor-wasm.js, enabling the portable file:// page. The equality test ensures
those bytes cannot silently diverge.

The exported ABI allocates byte slices, owns opaque encoder/decoder handles,
and exposes one ephemeral output buffer. JavaScript validates packets before
calling it, copies output before the next operation, frees input slices in
finally blocks, evicts encoders using an LRU budget, and frees solved decoders.
Calls are serialized within a persistent Web Worker. No unsafe shared memory,
SIMD, threads, wasm-bindgen, CDN, or cross-origin isolation is required.

Each Beam source block is a separately framed RFC6330 object with Z=1, N=1,
Al=1. Its standard RFC SBN is zero, its F is the actual block byte length (one
zero byte for an empty file), and its T is the configured symbol size. The
short final source symbol is zero padded for encoding, then removed according
to F/packedSize before SHA-256 verification. Beam's 32-bit block number identifies
which independent object a symbol belongs to; this supports large files without
exceeding the RFC's 255-block limit for a single object.
