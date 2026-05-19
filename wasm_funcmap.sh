#!/bin/bash
# wasm_funcmap.sh — Map WASM function indices to export names
#
# Usage: ./wasm_funcmap.sh <file.wasm>
#
# Requires wasm-objdump from WABT (brew install wabt)

set -e

if [ $# -lt 1 ]; then
    echo "Usage: $0 <file.wasm>" >&2
    exit 1
fi

WASM="$1"

if [ ! -f "$WASM" ]; then
    echo "Error: $WASM not found" >&2
    exit 1
fi

if ! command -v wasm-objdump &>/dev/null; then
    echo "Error: wasm-objdump not found. Install WABT:" >&2
    echo "  brew install wabt" >&2
    exit 1
fi

# Extract the export section only — lines like:
#   - func[44] <edge264_find_start_code> -> "edge264_find_start_code"
wasm-objdump -x "$WASM" 2>/dev/null | \
    grep -E 'func\[.*\].*->' | \
    sed -E 's/.*func\[([0-9]+)\].*<([^>]+)>.*/func[\1]\t\2/' | \
    sort -t'[' -k2 -n
