// edge264 WebGPU demo — vanilla JavaScript, no HTML page
//
// Decodes an H.264 Annex B bitstream via edge264 (compiled to WASM) and
// displays the output using WebGPU.  Works on web browsers and NRDP (with
// browser polyfills).
//
// Query parameters (browser):
//   ?filename=path/to/video.264&frameRate=30
//
// NRDP options:
//   -J filename=path/to/video.264 -J frameRate=30

// ---------------------------------------------------------------------------
// 1. Platform detection & logging
// ---------------------------------------------------------------------------

const isNrdp = typeof nrdp !== "undefined";
const isBrowser = !isNrdp && typeof window !== "undefined";

function NTRACE(...args) {
    if (isNrdp) nrdp.l.trace({ traceArea: "EDGE264_DEMO" }, ...args);
    else console.log("[edge264_demo]", ...args);
}
function NERROR(...args) {
    if (isNrdp) nrdp.l.error({ traceArea: "EDGE264_DEMO" }, ...args);
    else console.error("[edge264_demo]", ...args);
}
function NWARN(...args) {
    if (isNrdp) nrdp.l.warn({ traceArea: "EDGE264_DEMO" }, ...args);
    else console.warn("[edge264_demo]", ...args);
}
function NINFO(...args) {
    if (isNrdp) nrdp.l.info({ traceArea: "EDGE264_DEMO" }, ...args);
    else console.info("[edge264_demo]", ...args);
}

// ---------------------------------------------------------------------------
// 2. WASM loading & memory management
// ---------------------------------------------------------------------------

let malloc, free;
let edge264_find_start_code, edge264_alloc, edge264_flush, edge264_free;
let edge264_decode_NAL, edge264_get_frame, edge264_return_frame;
let memoryManager;

class MemoryManager {
    constructor() {
        this.memory = null;
        this._u8 = null;
        this._u16 = null;
        this._u32 = null;
        this._listeners = [];
    }

    setMemory(wasmMemory) {
        this.memory = wasmMemory;

        // Intercept grow() to refresh views and notify listeners
        if (this.memory && typeof this.memory.grow === "function") {
            const originalGrow = this.memory.grow.bind(this.memory);
            this.memory.grow = (pages) => {
                NINFO("Memory.grow()", pages, "pages");
                const result = originalGrow(pages);
                if (result >= 0) {
                    this._refreshViews();
                    for (const fn of this._listeners) {
                        try { fn(); } catch (e) { NERROR("memory growth listener error:", e); }
                    }
                }
                return result;
            };
        }
        this._refreshViews();
    }

    addGrowthListener(fn) { this._listeners.push(fn); }

    _refreshViews() {
        if (!this.memory) return;
        this._u8 = new Uint8Array(this.memory.buffer);
        this._u16 = new Uint16Array(this.memory.buffer);
        this._u32 = new Uint32Array(this.memory.buffer);
    }

    get u8()  { return this._u8; }
    get u16() { return this._u16; }
    get u32() { return this._u32; }
}

// Load the emscripten-generated edge264.js glue and wait for WASM to be ready.
// The glue defines Module, HEAPU8, HEAPU32, wasmMemory, etc. at the global
// scope.  After WASM instantiation, Module['_edge264_alloc'] etc. become real
// functions (they start as early-access guards that throw).
function loadWasm() {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./edge264.js";
        script.onload = () => {
            const poll = () => {
                // Module['_edge264_alloc'] is initially a throwing stub;
                // once WASM is ready it becomes a real function.
                try {
                    if (typeof Module !== "undefined" &&
                        typeof Module["_edge264_alloc"] === "function") {
                        // Quick sanity — the stub has .isInvalidEarlyAccess,
                        // real wrappers don't.  But the simplest check is to
                        // see if wasmMemory is initialised.
                        if (typeof wasmMemory !== "undefined" && wasmMemory) {
                            resolve();
                            return;
                        }
                    }
                } catch (_) { /* stub may throw — keep polling */ }
                setTimeout(poll, 50);
            };
            poll();
        };
        script.onerror = () => reject(new Error("Failed to load edge264.js"));
        document.head.appendChild(script);
    });
}

// ---------------------------------------------------------------------------
// 3. Video decoder — wraps the edge264 C API
// ---------------------------------------------------------------------------

// Error codes returned by edge264_decode_NAL (WASM/musl errno values)
const ENOBUFS = 42;   // retry same NAL after draining frames
const ENODATA = 116;  // end of stream
const ENOTSUP = 138;  // unsupported NAL type

class VideoDecoder {
    constructor() {
        this.bufferPtr = 0;
        this.bufferLen = 0;
        this.nalPos = 0;       // current WASM pointer into the buffer
        this.bufferEnd = 0;
        this.decPtr = 0;
        this.frmPtr = 0;
        this.pendingFrames = []; // frames extracted but not yet consumed
    }

    init(arrayBuffer) {
        const src = new Uint8Array(arrayBuffer);
        this.bufferLen = src.length;

        // Copy file into WASM memory
        this.bufferPtr = malloc(this.bufferLen);
        memoryManager.u8.set(src, this.bufferPtr);
        this.bufferEnd = this.bufferPtr + this.bufferLen;

        // Skip the initial [0]001 start-code prefix
        this.nalPos = this.bufferPtr + 3 +
            (memoryManager.u8[this.bufferPtr + 2] === 0 ? 1 : 0);

        // Allocate Edge264Frame struct (64 bytes)
        this.frmPtr = malloc(64);

        // Create the decoder (0 threads, no logging, no custom allocator)
        this.decPtr = edge264_alloc(0, 0, 0, 0, 0, 0, 0);
        if (!this.decPtr) throw new Error("edge264_alloc failed");

        NTRACE("Decoder initialised, buffer", this.bufferLen, "bytes");
    }

    // Drain all ready frames from the decoder into pendingFrames.
    _drainFrames() {
        while (edge264_get_frame(this.decPtr, this.frmPtr, 0) === 0) {
            this.pendingFrames.push(this._extractFrame());
        }
    }

    // Return the next decoded frame, or null when the stream loops.
    // Follows the same pattern as edge264_test.c:360-377.
    getNextFrame() {
        // Return a pending frame if we have one
        if (this.pendingFrames.length > 0) {
            return this.pendingFrames.shift();
        }

        // Decode NALs until we get a frame
        while (this.nalPos < this.bufferEnd) {
            // Find the end of the current NAL (= start of next start code)
            const nalEnd = edge264_find_start_code(this.nalPos, this.bufferEnd, 0);

            // Decode one NAL unit
            const ret = edge264_decode_NAL(this.decPtr, this.nalPos, nalEnd, 0, 0);

            // Drain all ready frames
            this._drainFrames();

            // Advance pointer unless decoder asked for retry (ENOBUFS)
            if (ret !== ENOBUFS) {
                this.nalPos = nalEnd + 3;
            }

            // If we got frames, return the first one
            if (this.pendingFrames.length > 0) {
                return this.pendingFrames.shift();
            }

            // Stop on terminal errors (but not ENOBUFS or ENOTSUP)
            if (ret !== 0 && ret !== ENOBUFS && ret !== ENOTSUP) {
                break;
            }
        }

        // End of stream — flush remaining frames
        edge264_flush(this.decPtr);
        this._drainFrames();

        if (this.pendingFrames.length > 0) {
            return this.pendingFrames.shift();
        }

        // Nothing left — loop back to the beginning
        this._resetToStart();
        return null;
    }

    _extractFrame() {
        // Read Edge264Frame struct fields from WASM memory.
        // struct layout (WASM = 32-bit pointers):
        //   offset  0: uint8_t *samples[3]        — Y, Cb, Cr pointers (3×4 bytes)
        //   offset 12: uint8_t *samples_mvc[3]     — MVC (3×4)
        //   offset 24: uint8_t *mb_errors           — 4
        //   offset 28: int8_t bit_depth_Y, bit_depth_C  — 2
        //   offset 30: int16_t width_Y              — 2
        //   offset 32: int16_t width_C              — 2
        //   offset 34: int16_t height_Y             — 2
        //   offset 36: int16_t height_C             — 2
        //   offset 38: int16_t stride_Y             — 2
        //   offset 40: int16_t stride_C             — 2
        //   offset 42: int16_t stride_mb            — 2
        //   offset 44: int32_t FrameId              — 4
        const u32 = memoryManager.u32;
        const u8 = memoryManager.u8;
        const base = this.frmPtr;

        const yPtr = u32[base / 4];
        const cbPtr = u32[base / 4 + 1];
        const crPtr = u32[base / 4 + 2];

        // int16 fields — read via DataView for sign-correct access
        const dv = new DataView(memoryManager.memory.buffer);
        const width_Y  = dv.getInt16(base + 30, true);
        const width_C  = dv.getInt16(base + 32, true);
        const height_Y = dv.getInt16(base + 34, true);
        const height_C = dv.getInt16(base + 36, true);
        const stride_Y = dv.getInt16(base + 38, true);
        const stride_C = dv.getInt16(base + 40, true);

        // Copy plane data — WASM memory views may be invalidated by growth
        // during subsequent decode calls, so we cannot hold subarray references.
        return {
            width_Y, height_Y, width_C, height_C, stride_Y, stride_C,
            yArray:  u8.slice(yPtr,  yPtr  + stride_Y * height_Y),
            cbArray: u8.slice(cbPtr, cbPtr + stride_C * height_C),
            crArray: u8.slice(crPtr, crPtr + stride_C * height_C),
        };
    }

    _resetToStart() {
        NTRACE("Looping stream");
        this.nalPos = this.bufferPtr + 3 +
            (memoryManager.u8[this.bufferPtr + 2] === 0 ? 1 : 0);
        this.pendingFrames = [];
    }

    // Refresh WASM memory views after memory growth.
    updateMemoryViews() {
        // Nothing to do — we always read from memoryManager.u8/u32 which are
        // refreshed by MemoryManager itself.  But nalPos / bufferPtr / frmPtr
        // are WASM-side pointers and remain valid across growth.
    }

    deinit() {
        if (this.decPtr) {
            edge264_flush(this.decPtr);
            // edge264_free takes a pointer-to-pointer
            const ptrPtr = malloc(4);
            memoryManager.u32[ptrPtr >> 2] = this.decPtr;
            edge264_free(ptrPtr);
            free(ptrPtr);
            this.decPtr = 0;
        }
        if (this.frmPtr) { free(this.frmPtr); this.frmPtr = 0; }
        if (this.bufferPtr) { free(this.bufferPtr); this.bufferPtr = 0; }
    }
}

// ---------------------------------------------------------------------------
// 4. WebGPU renderer — YUV 4:2:0 → RGB via a fullscreen-quad shader
// ---------------------------------------------------------------------------

class VideoRenderer {
    constructor() {
        this.gpu = null;
        this.adapter = null;
        this.device = null;
        this.context = null;
        this.canvas = null;
        this.canvasFormat = null;
        this.pipeline = null;
        this.sampler = null;
        this.bindGroupLayout = null;
        this.uniformBuffer = null;
        this.uniformData = new Float32Array(4);
        this.yTexture = null;
        this.cbTexture = null;
        this.crTexture = null;
        this.bindGroup = null;
        this.curW = 0;
        this.curH = 0;
    }

    async init() {
        // --- GPU setup ---
        this.gpu = (typeof nrdp_platform !== "undefined")
            ? nrdp_platform.gpu : navigator.gpu;
        if (!this.gpu) throw new Error("WebGPU not available");

        this.adapter = await this.gpu.requestAdapter();
        if (!this.adapter) throw new Error("No WebGPU adapter");

        this.device = await this.adapter.requestDevice();
        if (!this.device) throw new Error("No WebGPU device");

        this.canvasFormat = this.gpu.getPreferredCanvasFormat();

        // --- Canvas ---
        if (typeof nrdp_platform !== "undefined") {
            this.context = nrdp_platform.canvasContext;
        } else {
            this.canvas = document.createElement("canvas");
            this.canvas.width = 1280;
            this.canvas.height = 720;
            this.canvas.style.display = "block";
            document.body.appendChild(this.canvas);
            this.context = this.canvas.getContext("webgpu");
        }
        if (!this.context) throw new Error("Failed to get WebGPU context");

        this.context.configure({ device: this.device, format: this.canvasFormat });

         // --- Shader ---
        const shaderCode = `
            struct VertexOutput {
                @builtin(position) pos: vec4<f32>,
                @location(0) uv: vec2<f32>,
            }

            struct Uniforms {
                dest_rect: vec4<f32>,
            }

            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            // Vertex positions as 0..1 fractions of the dest_rect.
            const quad = array<vec2<f32>, 6>(
                vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
            );

            // Texture UVs — Y is flipped so that texture row 0 (top of the
            // image) maps to NDC y=+1 (top of screen) on all backends.
            const uvs = array<vec2<f32>, 6>(
                vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
                vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 0.0)
            );

            @vertex
            fn vs(@builtin(vertex_index) i: u32) -> VertexOutput {
                var out: VertexOutput;
                let pos = uniforms.dest_rect.xy + (quad[i] * uniforms.dest_rect.zw);
                out.pos = vec4<f32>(pos, 0.0, 1.0);
                out.uv = uvs[i];
                return out;
            }

            @group(0) @binding(1) var y_tex:  texture_2d<f32>;
            @group(0) @binding(2) var cb_tex: texture_2d<f32>;
            @group(0) @binding(3) var cr_tex: texture_2d<f32>;
            @group(0) @binding(4) var samp:   sampler;

            // BT.709 YUV→RGB (limited range baked in)
            const YUV_TO_RGB = mat3x3<f32>(
                1.0,      1.0,     1.0,
                0.0,     -0.21482, 2.12798,
                1.28033, -0.38059, 0.0
            );

            @fragment
            fn fs(in: VertexOutput) -> @location(0) vec4<f32> {
                let y_raw  = textureSample(y_tex,  samp, in.uv).r;
                let cb_raw = textureSample(cb_tex, samp, in.uv).r;
                let cr_raw = textureSample(cr_tex, samp, in.uv).r;

                let y  = clamp((y_raw  - 16.0/255.0) / (235.0/255.0 - 16.0/255.0), 0.0, 1.0);
                let cb = clamp((cb_raw - 16.0/255.0) / (240.0/255.0 - 16.0/255.0), 0.0, 1.0) - 0.5;
                let cr = clamp((cr_raw - 16.0/255.0) / (240.0/255.0 - 16.0/255.0), 0.0, 1.0) - 0.5;

                let rgb = YUV_TO_RGB * vec3<f32>(y, cb, cr);
                return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
            }
        `;

        const shaderModule = this.device.createShaderModule({ code: shaderCode });

        // --- Uniform buffer ---
        this.uniformBuffer = this.device.createBuffer({
            size: 16,  // 4 floats × 4 bytes (dest_rect)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // Fullscreen quad in NDC
        this.uniformData[0] = -1.0; // x
        this.uniformData[1] = -1.0; // y
        this.uniformData[2] =  2.0; // width
        this.uniformData[3] =  2.0; // height
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
        NTRACE("WebGPU backend:", this.gpu.backend || "n/a");

        // --- Sampler ---
        this.sampler = this.device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
        });

        // --- Bind group layout ---
        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT,
                    sampler: {} },
            ],
        });

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        // --- Render pipeline ---
        this.pipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex:   { module: shaderModule, entryPoint: "vs" },
            fragment: {
                module: shaderModule,
                entryPoint: "fs",
                targets: [{ format: this.canvasFormat }],
            },
            primitive: { topology: "triangle-list" },
        });

        NTRACE("Renderer initialised");
    }

    // Resize the browser canvas to match the video dimensions.
    resizeCanvas(width, height) {
        if (!this.canvas) return;
        if (this.canvas.width === width && this.canvas.height === height) return;
        this.canvas.width = width;
        this.canvas.height = height;
        this.context.configure({ device: this.device, format: this.canvasFormat });
        NTRACE("Canvas resized to", width, "×", height);
    }

    renderFrame(frame) {
        const { width_Y, height_Y, width_C, height_C, stride_Y, stride_C,
                yArray, cbArray, crArray } = frame;

        // Resize canvas to video dimensions (browser only)
        this.resizeCanvas(width_Y, height_Y);

        // Recreate textures if dimensions changed
        if (this.curW !== width_Y || this.curH !== height_Y) {
            if (this.yTexture)  this.yTexture.destroy();
            if (this.cbTexture) this.cbTexture.destroy();
            if (this.crTexture) this.crTexture.destroy();
            this.bindGroup = null;

            const makeTex = (w, h, label) => this.device.createTexture({
                label, size: [w, h, 1], format: "r8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.yTexture  = makeTex(width_Y, height_Y, "Y");
            this.cbTexture = makeTex(width_C, height_C, "Cb");
            this.crTexture = makeTex(width_C, height_C, "Cr");

            this.bindGroup = this.device.createBindGroup({
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffer } },
                    { binding: 1, resource: this.yTexture.createView() },
                    { binding: 2, resource: this.cbTexture.createView() },
                    { binding: 3, resource: this.crTexture.createView() },
                    { binding: 4, resource: this.sampler },
                ],
            });

            this.curW = width_Y;
            this.curH = height_Y;
        }

        // Upload YUV plane data to GPU textures
        this.device.queue.writeTexture(
            { texture: this.yTexture }, yArray,
            { bytesPerRow: stride_Y }, [width_Y, height_Y, 1]);
        this.device.queue.writeTexture(
            { texture: this.cbTexture }, cbArray,
            { bytesPerRow: stride_C }, [width_C, height_C, 1]);
        this.device.queue.writeTexture(
            { texture: this.crTexture }, crArray,
            { bytesPerRow: stride_C }, [width_C, height_C, 1]);

        // Draw
        const encoder = this.device.createCommandEncoder();
        const currentTexture = this.context.getCurrentTexture();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: currentTexture.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.draw(6);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    deinit() {
        if (this.yTexture)  { this.yTexture.destroy();  this.yTexture  = null; }
        if (this.cbTexture) { this.cbTexture.destroy();  this.cbTexture = null; }
        if (this.crTexture) { this.crTexture.destroy();  this.crTexture = null; }
        if (this.uniformBuffer) { this.uniformBuffer.destroy(); this.uniformBuffer = null; }
        this.bindGroup = null;
        this.pipeline = null;
        this.device = null;
    }
}

// ---------------------------------------------------------------------------
// 5. Main / bootstrap
// ---------------------------------------------------------------------------

let polyfillModule = null;

async function main() {
    NTRACE("Starting edge264 demo");

    // --- Parse options ---
    let filename, frameRate;

    if (isNrdp) {
        const opts = nrdp.js_options;
        filename  = opts.filename;
        frameRate = parseInt(opts.frameRate) || 30;
    } else {
        const params = new URLSearchParams(window.location.search);
        filename  = params.get("filename");
        frameRate = parseInt(params.get("frameRate")) || 30;
    }

    if (!filename) {
        NERROR("No filename specified.");
        NERROR("Browser: ?filename=video.264&frameRate=30");
        NERROR("NRDP:    -J filename=video.264 -J frameRate=30");
        return;
    }

    NTRACE("filename:", filename, " frameRate:", frameRate);

    // --- NRDP: load browser polyfills ---
    if (isNrdp && typeof document === "undefined") {
        NTRACE("Loading browser polyfills...");
        polyfillModule = await import(
            "http://localcontrol.netflix.com/js/browser-polyfill/index.js"
        );
        await polyfillModule.browserPolyfillInit(globalThis, { render: false });
        nrdp.gibbon.scene.shouldIdle = false;
        nrdp_platform.setRender((arg) => {
            polyfillModule.browserPolyfillRender(undefined, arg && arg.timestamp);
            return true;
        });
        NTRACE("Browser polyfills loaded");
    }

    // --- Error handling ---
    if (typeof window !== "undefined") {
        window.addEventListener("error", (e) => {
            NERROR("Uncaught error:", e.message || e);
            if (isNrdp) nrdp.exit(1);
        });
        window.addEventListener("unhandledrejection", (e) => {
            NERROR("Unhandled rejection:", e.reason || e);
            if (isNrdp) nrdp.exit(1);
        });
    }

    // --- Fetch the .264 file ---
    NTRACE("Fetching", filename);
    const response = await fetch(filename);
    if (!response.ok) throw new Error("Failed to fetch " + filename + ": " + response.status);
    const fileBuffer = await response.arrayBuffer();
    NTRACE("File loaded,", fileBuffer.byteLength, "bytes");

    // --- Load WASM ---
    NTRACE("Loading WASM module...");
    await loadWasm();

    // Set up memory manager — wasmMemory is a global set by edge264.js
    memoryManager = new MemoryManager();
    memoryManager.setMemory(wasmMemory);

    // Extract API functions from the emscripten Module object
    malloc                  = Module["_malloc"];
    free                    = Module["_free"];
    edge264_find_start_code = Module["_edge264_find_start_code"];
    edge264_alloc           = Module["_edge264_alloc"];
    edge264_flush           = Module["_edge264_flush"];
    edge264_free            = Module["_edge264_free"];
    edge264_decode_NAL      = Module["_edge264_decode_NAL"];
    edge264_get_frame       = Module["_edge264_get_frame"];
    edge264_return_frame    = Module["_edge264_return_frame"];

    NTRACE("WASM ready");

    // --- Initialise decoder ---
    const decoder = new VideoDecoder();
    decoder.init(fileBuffer);
    memoryManager.addGrowthListener(() => decoder.updateMemoryViews());

    // --- Initialise renderer ---
    const renderer = new VideoRenderer();
    await renderer.init();

    // --- Render loop with frame-rate control ---
    const frameInterval = 1000 / frameRate;
    let nextFrameTime = 0;
    let startTime = 0;
    let cachedFrame = null;
    let frameCount = 0;
    let lastFpsTime = 0;

    function renderLoop() {
        if (!startTime) {
            startTime = performance.now();
            lastFpsTime = startTime;
        }
        const now = performance.now() - startTime;

        if (now >= nextFrameTime) {
            nextFrameTime += frameInterval;
            // Prevent spiral-of-death if we fall behind
            if (nextFrameTime < now) nextFrameTime = now + frameInterval;

            const frame = decoder.getNextFrame();
            if (frame) {
                cachedFrame = frame;
            } else {
                // Stream looped — get the first frame of the new loop
                cachedFrame = decoder.getNextFrame();
            }

            frameCount++;

            // FPS logging once per second
            const elapsed = performance.now() - startTime;
            if (elapsed - lastFpsTime >= 1000) {
                NINFO("fps:", frameCount);
                frameCount = 0;
                lastFpsTime = elapsed;
            }
        }

        if (cachedFrame) {
            renderer.renderFrame(cachedFrame);
        }

        requestAnimationFrame(renderLoop);
    }

    requestAnimationFrame(renderLoop);
    NTRACE("Render loop started at", frameRate, "fps");
}

// --- Entry point ---
async function start() {
    if (isBrowser) {
        await main();
    } else if (isNrdp) {
        if (nrdp.thread.config.animation) {
            await main();
        } else {
            NTRACE("Spawning animation thread");
            const thread = nrdp.thread.start({
                url: nrdp.gibbon.location,
                animation: true,
            });
            const listener = (message) => {
                queueMicrotask(() => {
                    if (message?.type === "done" || message?.type === "error") {
                        if (nrdp.thread.config.main) {
                            nrdp.exit(message?.type === "done" ? 0 : 1);
                        } else {
                            thread.removeEventListener("raw-message", listener);
                            thread.stop();
                            nrdp.thread.send(message);
                        }
                    }
                });
            };
            thread.addEventListener("raw-message", listener);

            // Back-key exit handler
            nrdp.gibbon.addEventListener("key", (e) => {
                if (e.data.type === "press" && e.data.uiEvent === "key.back") {
                    nrdp.exit(0);
                }
            });
        }
    }
}

start().catch((e) => {
    NERROR("Fatal:", e);
    if (isNrdp) nrdp.exit(1);
});
