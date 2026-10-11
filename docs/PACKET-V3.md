# Beam B3 / RaptorQ packets

QR alphanumeric payload: `B3:` followed by the existing Base45 representation.
The existing CRC-32 protects all header/payload bytes. All integers are big-endian.

| Byte offset | Length | Meaning |
| --- | --- | --- |
| 0 | 1 | Version = 3 |
| 1 | 1 | Type 0 manifest; type 1 RFC6330 encoding symbol |
| 2 | 8 | Random transfer ID |
| 10 | 4 | Source object/block number; manifest = 0 |
| 14 | 4 | Total source symbol count across the file |
| 18 | 2 | Symbol size T: 384, 720 or 1024 bytes |
| 20 | variable | Manifest UTF-8 JSON, or 4-byte ESI followed by T symbol bytes |
| last 4 | 4 | Existing CRC-32 |

A symbol ESI must be in [0, 0xffffff]. ESIs below the object's K are systematic
source symbols. Subsequent ESIs are repair symbols, with the mature crate
handling RFC's K' padding internally. The high byte of the 4-byte ESI is zero.
Every object uses standard RFC parameters Z=N=Al=1, SBN=0, F=actual block size
(maximum 1024*T); derive the last F from packedSize, using F=1 for empty files.
Manifest keeps all B2 metadata and adds codec=`raptorq-rfc6330` and
sourceSymbols=1024. These parameters are version-pinned and validated.

Transmit all originals first. Repair passes interleave 64-symbol runs across
objects, rotate the starting object, and never repeat an ESI until RFC's finite
24-bit space is exhausted. At exhaustion the stream cycles valid repairs,
rather than emitting invalid identifiers. Manifest repeats approximately every
29–35 QR packets; this overhead is included in the time estimate and benchmarks.

B1/B2 receive support is retained. New senders use B3, so old receivers require
this update. Source block framing is Beam-specific; arbitrary RaptorQ file
protocols are not wire-compatible with Beam, although the encoding symbols
within each object follow RFC6330.

CRC-damaged packets, invalid ESI/length/metadata and mixed sessions are refused.
Up to 128 unique packets can wait for a manifest. Duplicates do not add progress.
Each decoder tracks at most K+64 unique symbols; an exceptionally unsuccessful
object is restarted with fresh input at that bound, avoiding unbounded repair
storage. Solved objects immediately release their Rust decoder state. Encoders
have an LRU source-data budget of 32 MiB (roughly twice that for source plus
intermediate symbol slabs), and are reconstructed deterministically if evicted.

Useful-symbol progress is an estimate of work, not rank. It caps at 99% even
when all source objects have decoded. Only successful whole-file assembly,
bounded decompression, size validation and SHA-256 verification permit 100%
and a download. Verification failure remains below 100% and exposes no file.
