// run_decode.js — decode an H.264 file via edge264 WASM and measure performance
//
// Usage: d8 run_decode.js -- <file.264> [passes]
//   passes: number of timed passes (default 3). Pass 0 is always a warmup.

const bytes = readbuffer("edge264.wasm");
const mod = new WebAssembly.Module(bytes);
const instance = new WebAssembly.Instance(mod, {
  env: {
    __assert_fail: () => {},
    emscripten_get_heap_max: () => 2147483648,
    _abort_js: () => {},
    emscripten_resize_heap: () => 0
  },
  wasi_snapshot_preview1: {
    clock_time_get: () => 0,
    fd_close: () => 0,
    fd_write: () => 0,
    fd_seek: () => 0
  }
});

const mem = instance.exports.memory;
const malloc = instance.exports.malloc;
const free = instance.exports.free;
const find_start_code = instance.exports.edge264_find_start_code;
const alloc = instance.exports.edge264_alloc;
const decode_NAL = instance.exports.edge264_decode_NAL;
const get_frame = instance.exports.edge264_get_frame;
const flush = instance.exports.edge264_flush;
const edge264_free = instance.exports.edge264_free;

// Detect API version by checking edge264_decode_NAL parameter count:
//   5 params (current): decode_NAL(dec, buf, end, unref_cb, unref_arg)
//   7 params (old):     decode_NAL(dec, buf, end, non_blocking, unref_cb, unref_arg, next_NAL)
const oldAPI = (decode_NAL.length === 7);

// Parse arguments
const filename = arguments[0];
const numPasses = parseInt(arguments[1]) || 3;
if (!filename) { print("Usage: d8 run_decode.js -- <file.264> [passes]"); quit(1); }
print("API: edge264_decode_NAL has " + decode_NAL.length + " params (" +
      (oldAPI ? "old" : "current") + ")");

// Load file into WASM memory
const fileBytes = new Uint8Array(readbuffer(filename));
const bufPtr = malloc(fileBytes.length);
new Uint8Array(mem.buffer).set(fileBytes, bufPtr);
const bufEnd = bufPtr + fileBytes.length;
const frmPtr = malloc(64);
const decPtr = alloc(0, 0, 0, 0, 0, 0, 0);

const ENOBUFS = 42;
const ENOTSUP = 138;

// Old API (7 params): decode_NAL writes the next NAL pointer to a provided
// address, so we allocate 4 bytes to hold it.
const nalPtr = oldAPI ? malloc(4) : 0;

// Decode one full pass, return frame count
function decodePass() {
  const u8 = new Uint8Array(mem.buffer);
  let nalPos = bufPtr + 3 + (u8[bufPtr + 2] === 0 ? 1 : 0);
  let frameCount = 0;

  if (oldAPI) {
    // Old API: decode_NAL(dec, buf, end, non_blocking, unref_cb, unref_arg, &next_NAL)
    // Pass the entire buffer as end — the decoder finds NAL boundaries internally
    // and writes the next NAL position into nalPtr.  Returns 0 on success or
    // ENOBUFS when next_NAL has passed bufEnd (end-of-stream).
    const u32 = new Uint32Array(mem.buffer);
    u32[nalPtr / 4] = nalPos;
    let ret;

    do {
      ret = decode_NAL(decPtr, u32[nalPtr / 4], bufEnd, 0, 0, 0, nalPtr);

      while (get_frame(decPtr, frmPtr, 0) === 0) {
        frameCount++;
      }
    } while (ret === 0 || (ret === ENOBUFS && u32[nalPtr / 4] < bufEnd));
  } else {
    // Current API: decode_NAL(dec, buf, end, unref_cb, unref_arg)
    // Caller manages NAL boundaries via find_start_code.
    while (nalPos < bufEnd) {
      const nalEnd = find_start_code(nalPos, bufEnd, 0);
      const ret = decode_NAL(decPtr, nalPos, nalEnd, 0, 0);

      while (get_frame(decPtr, frmPtr, 0) === 0) {
        frameCount++;
      }

      if (ret !== ENOBUFS) nalPos = nalEnd + 3;
      if (ret !== 0 && ret !== ENOBUFS && ret !== ENOTSUP) break;
    }
  }

  flush(decPtr);
  while (get_frame(decPtr, frmPtr, 0) === 0) frameCount++;

  return frameCount;
}

// Warmup pass — triggers Liftoff, then TurboFan recompilation in background
print("pass 0 (warmup)...");
const warmupFrames = decodePass();
print("  " + warmupFrames + " frames (Liftoff + TurboFan compilation)");

// Timed passes — TurboFan code is stable
const times = [];
for (let i = 1; i <= numPasses; i++) {
  flush(decPtr);
  const t0 = performance.now();
  const frames = decodePass();
  const elapsed = performance.now() - t0;
  times.push(elapsed);
  const fps = (frames / elapsed * 1000).toFixed(1);
  const msPerFrame = (elapsed / frames).toFixed(2);
  print("pass " + i + ": " + frames + " frames in " +
        elapsed.toFixed(1) + " ms (" + fps + " fps, " + msPerFrame + " ms/frame)");
}

// Summary
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const min = Math.min(...times);
const max = Math.max(...times);
const avgFps = (warmupFrames / avg * 1000).toFixed(1);
const avgMs = (avg / warmupFrames).toFixed(2);
print("\nsummary (" + numPasses + " passes, " + warmupFrames + " frames each):");
print("  avg: " + avg.toFixed(1) + " ms (" + avgFps + " fps, " + avgMs + " ms/frame)");
print("  min: " + min.toFixed(1) + " ms  max: " + max.toFixed(1) + " ms");

// Clean up
const ptrPtr = malloc(4);
new Uint32Array(mem.buffer)[ptrPtr >> 2] = decPtr;
edge264_free(ptrPtr);
free(ptrPtr);
if (nalPtr) free(nalPtr);
free(frmPtr);
free(bufPtr);
