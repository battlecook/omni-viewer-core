#!/bin/bash
# Build the WASM audio decode/analysis engine for browser targets.
#
# Unlike the original vscode-omni-viewer build (ENVIRONMENT=node, run in the
# extension host), this build targets web + worker and emits an ES module so
# every platform adapter (chrome extension, obsidian, web, vscode webview)
# can import it via AssetService-resolved URLs.
#
# Requires emsdk (https://github.com/emscripten-core/emsdk). Output artifacts
# are committed under assets/audio-engine/ and copied to dist/assets by the
# package build.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../../assets/audio-engine"
cd "$SCRIPT_DIR"

if [ -f /tmp/emsdk/emsdk_env.sh ]; then
    source /tmp/emsdk/emsdk_env.sh 2>/dev/null
fi

# Pin the toolchain: the committed artifacts under assets/audio-engine/ were
# built with this emsdk release. Refuse to build with anything else so the
# output stays reproducible and THIRD_PARTY_NOTICES.md stays accurate.
EMSDK_VERSION="6.0.3"

if ! command -v emcc >/dev/null 2>&1; then
    echo "emcc not found — install emsdk $EMSDK_VERSION (emsdk install $EMSDK_VERSION && emsdk activate $EMSDK_VERSION)" >&2
    exit 1
fi
ACTUAL_VERSION="$(emcc --version | head -n 1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
if [ "$ACTUAL_VERSION" != "$EMSDK_VERSION" ]; then
    echo "emcc $ACTUAL_VERSION found, but artifacts are pinned to emsdk $EMSDK_VERSION" >&2
    echo "run: emsdk install $EMSDK_VERSION && emsdk activate $EMSDK_VERSION" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
echo "Building WASM audio engine (web,worker / ES6)..."

emcc audio_engine.c \
     lib/kiss_fft.c \
     -O3 \
     -s WASM=1 \
     -s EXPORTED_FUNCTIONS='["_decode_audio","_generate_peaks","_generate_spectrogram","_free_audio","_free_buffer","_malloc","_free","_audio_get_channels","_audio_get_sample_rate","_audio_get_total_frames","_audio_get_total_frames_high"]' \
     -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","HEAPU8","HEAPF32"]' \
     -s ALLOW_MEMORY_GROWTH=1 \
     -s INITIAL_MEMORY=16777216 \
     -s MAXIMUM_MEMORY=2147483648 \
     -s MODULARIZE=1 \
     -s EXPORT_ES6=1 \
     -s EXPORT_NAME="AudioEngineModule" \
     -s ENVIRONMENT='web,worker' \
     -I lib \
     -o "$OUT_DIR/audio_engine.mjs"

echo "Build complete:"
ls -lh "$OUT_DIR/audio_engine.mjs" "$OUT_DIR/audio_engine.wasm"
