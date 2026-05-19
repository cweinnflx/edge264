#!/bin/bash
set -e

# Build script for edge264 WebGPU demo
#
# Compiles edge264 to WebAssembly via emscripten, then generates a minimal
# HTML loader so the demo can run in a browser.
#
# Prerequisites:
#   source <path-to-emsdk>/emsdk_env.sh   (puts emcc/emmake on PATH)
#
# WebGPU note:
#   The emdawnwebgpu emscripten port is intentionally NOT used here.
#   emdawnwebgpu provides C-side webgpu.h bindings, but this demo performs all
#   WebGPU work from JavaScript (navigator.gpu / nrdp_platform.gpu), so the
#   port would only add unnecessary binary size.

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Verify emscripten is available
if ! command -v emcc &>/dev/null; then
    echo -e "${RED}Error: emcc not found on PATH.${NC}"
    echo "Please activate emsdk first:"
    echo "  source <path-to-emsdk>/emsdk_env.sh"
    exit 1
fi

echo "Building edge264 WASM library..."
emmake make OS=wasm VARIANTS= BUILDTEST=no CFLAGS="-g" LIBFLAGS="--profiling-funcs"

echo "Generating edge264_demo.html..."
cat > edge264_demo.html << 'EOF'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>edge264 demo</title></head>
<body style="margin:0;background:#000"><script src="edge264_demo.js"></script></body></html>
EOF

echo ""
echo -e "${GREEN}Build complete.${NC}"
echo ""
echo "Files:"
echo "  edge264.js          emscripten glue"
echo "  edge264.wasm        compiled decoder"
echo "  edge264_demo.js     demo application"
echo "  edge264_demo.html   minimal loader"
echo ""
echo "Usage:"
echo "  python3 -m http.server 8080"
echo "  Open: http://localhost:8080/edge264_demo.html?filename=tests/supp-nals.264&frameRate=15"
