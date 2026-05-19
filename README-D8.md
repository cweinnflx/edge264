# d8 WASM Inspection Tools

Tools for inspecting and benchmarking edge264's WebAssembly decoder using V8's `d8` shell on ARM devices (jamba).

## Files

| File | Description |
|------|-------------|
| `d8/d8_armhf` | d8 binary — ARM32 hard-float |
| `d8/d8_aarch64` | d8 binary — AArch64 |
| `d8/d8_x86_64` | d8 binary — x86-64 Linux |
| `d8/d8_mac` | d8 binary — macOS |
| `run_decode.js` | Decode + benchmark script with warmup and timed passes |
| `js_hotloop.js` | Decode loop for TurboFan JS code inspection |
| `wasm_funcmap.sh` | Map WASM function indices to export names via `wasm-objdump` |
| `d8_guide.html` | Full guide with annotated examples, SIMD mappings, and profiling results |

## Quick Start

Copy the files to the device and run from a single directory containing `d8_armhf`, `edge264.wasm`, `netflixtest.264`, and the `.js` scripts.

### Build WASM with function names

```bash
emmake make OS=wasm VARIANTS= BUILDTEST=no CFLAGS="-g" LIBFLAGS="--profiling-funcs"
```

Both flags are required — `-g` emits names into the object, `--profiling-funcs` preserves the WASM name section in the linked output.

### Benchmark

```bash
./d8_armhf --no-wasm-bounds-checks --no-wasm-stack-checks \
  run_decode.js -- netflixtest.264 5
```

The script auto-detects the API version (5-param current vs 7-param old `edge264_decode_NAL`). Pass 0 is a warmup; subsequent passes are timed.

### Profile

```bash
./d8_armhf --no-wasm-bounds-checks --no-wasm-stack-checks \
  --prof run_decode.js -- netflixtest.264
node --prof-process v8.log
```

### Dump WASM machine code

```bash
./d8_armhf --no-wasm-bounds-checks --no-wasm-stack-checks \
  --print-wasm-code run_decode.js -- netflixtest.264 > wasm_code.txt
grep -A500 'name: decode_inter' wasm_code.txt
```

### Dump TurboFan-optimized JS code

```bash
./d8_armhf --no-wasm-bounds-checks --no-wasm-stack-checks \
  --print-opt-code --print-opt-code-filter="decodeAllFrames" \
  js_hotloop.js -- netflixtest.264
```

## Notes

- The `--no-wasm-bounds-checks --no-wasm-stack-checks` flags reduce ~7.5% overhead on armhf. On aarch64 the overhead is only ~2.7%, so the flags are less important.
- The aarch64 d8 can be used with the same commands (`./d8_aarch64` instead of `./d8_armhf`).
- See `d8_guide.html` for full documentation including SIMD instruction mappings, annotated code, and version comparison results.
