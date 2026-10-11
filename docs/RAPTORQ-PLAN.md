Beam v3 codec migration

Preserve the existing UI, scan and QR workers, Base45/CRC and verified download.
Use pinned Apache-2.0 cberner/raptorq 2.0.1; compile a small handle-based ABI to
WASM and bundle the binary and complete Rust source. No hand-written codec.

Each independently framed source block is one RFC6330 object (Z=N=Al=1), with
1024 source symbols, or a shorter last block. This permits more than 255 blocks
without violating RFC's 8-bit SBN. B3 identifies the object with a 32-bit block
number and its RFC ESI with 24 bits. Symbol sizes remain 384/720/1024 bytes.

Send originals before repairs. Repairs use fresh ESI counters and interleave
blocks in bounded runs. Repeat metadata with jitter. Preserve sender and
receiver state independently of scan/render workers so pause/resume and layout
changes do not reset codec state. Bound encoder cache and release solved decoders.

Introduce one persistent module worker owning preparation, RaptorQ generation,
legacy/RaptorQ acceptance, assembly, decompression and SHA-256. Main thread only
requests bounded QR batches and mirrors receiver status. Keep B1/B2 reception.

Test actual bundled WASM at 0/10/30/50% loss, repair-only recovery, corruption,
late metadata, duplicates, empty/partial blocks, worker reset and verification.
Compare seeded end-to-end frame counts and codec wall/CPU time against retained
v2; distinguish simulated transmission seconds from real camera measurements.
Test >=129 MiB incompressible input, offline/standalone builds, existing runtime
and scanner regression suite. Package code, binary, rebuild instructions and report.
