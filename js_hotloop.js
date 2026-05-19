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

const ENOBUFS = 42;
const ENOTSUP = 138;

// Detect API version: 5 params (current) vs 7 params (old)
const oldAPI = (decode_NAL.length === 7);

// The hot decode loop — this is what we want TurboFan to optimize
// Two variants to keep each path clean for TurboFan optimization.
function decodeAllFrames_current(bufPtr, bufEnd, frmPtr, decPtr) {
  let u8 = new Uint8Array(mem.buffer);
  let nalPos = bufPtr + 3 + (u8[bufPtr + 2] === 0 ? 1 : 0);
  let frameCount = 0;

  while (nalPos < bufEnd) {
    const nalEnd = find_start_code(nalPos, bufEnd, 0);
    const ret = decode_NAL(decPtr, nalPos, nalEnd, 0, 0);

    while (get_frame(decPtr, frmPtr, 0) === 0) {
      frameCount++;
    }

    if (ret !== ENOBUFS) nalPos = nalEnd + 3;
    if (ret !== 0 && ret !== ENOBUFS && ret !== ENOTSUP) break;
  }

  flush(decPtr);
  while (get_frame(decPtr, frmPtr, 0) === 0) frameCount++;
  return frameCount;
}

function decodeAllFrames_old(bufPtr, bufEnd, frmPtr, decPtr, nalPtr) {
  const u32 = new Uint32Array(mem.buffer);
  const u8 = new Uint8Array(mem.buffer);
  u32[nalPtr / 4] = bufPtr + 3 + (u8[bufPtr + 2] === 0 ? 1 : 0);
  let frameCount = 0;
  let ret;

  do {
    ret = decode_NAL(decPtr, u32[nalPtr / 4], bufEnd, 0, 0, 0, nalPtr);

    while (get_frame(decPtr, frmPtr, 0) === 0) {
      frameCount++;
    }
  } while (ret === 0 || (ret === ENOBUFS && u32[nalPtr / 4] < bufEnd));

  flush(decPtr);
  while (get_frame(decPtr, frmPtr, 0) === 0) frameCount++;
  return frameCount;
}

// Usage: d8 js_hotloop.js -- <file.264>
const filename = arguments[0];
if (!filename) { print("Usage: d8 js_hotloop.js -- <file.264>"); quit(1); }
print("API: " + (oldAPI ? "old (7 params)" : "current (5 params)"));
const fileBytes = new Uint8Array(readbuffer(filename));
const bufPtr = malloc(fileBytes.length);
new Uint8Array(mem.buffer).set(fileBytes, bufPtr);
const bufEnd = bufPtr + fileBytes.length;
const frmPtr = malloc(64);
const decPtr = alloc(0, 0, 0, 0, 0, 0, 0);
const nalPtr = oldAPI ? malloc(4) : 0;

const decodeAllFrames = oldAPI
  ? (bp, be, fp, dp) => decodeAllFrames_old(bp, be, fp, dp, nalPtr)
  : decodeAllFrames_current;

// Run multiple times to trigger TurboFan optimization
for (let i = 0; i < 3; i++) {
  flush(decPtr);
  const count = decodeAllFrames(bufPtr, bufEnd, frmPtr, decPtr);
  print("pass " + i + ": " + count + " frames");
}

// Cleanup
const ptrPtr = malloc(4);
new Uint32Array(mem.buffer)[ptrPtr >> 2] = decPtr;
edge264_free(ptrPtr);
free(ptrPtr);
if (nalPtr) free(nalPtr);
free(frmPtr);
free(bufPtr);
