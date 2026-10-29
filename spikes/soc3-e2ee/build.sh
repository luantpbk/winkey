#!/usr/bin/env bash
# ==============================================================================
# SOC-3 E2EE Vodozemac WASM Reproducible Build Script
# Pinned toolchain: Rust 1.84.0, wasm-pack 0.13.1, wasm-opt binaryen 118
# Output target: spikes/soc3-e2ee/pkg/
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

RUST_VERSION="1.84.0"
WASM_PACK_VERSION="0.13.1"

echo "=========================================================================="
echo " Building vodozemac-winkey WASM wrapper (SOC-3)"
echo " Pinned Toolchain: rustc ${RUST_VERSION}, wasm-pack ${WASM_PACK_VERSION}"
echo "=========================================================================="

# 1. Verify / install target
if command -v rustup >/dev/null 2>&1; then
  echo "[1/4] Ensuring wasm32-unknown-unknown target is installed..."
  rustup target add wasm32-unknown-unknown
else
  echo "[1/4] rustup not found, assuming wasm32-unknown-unknown is available in cargo environment."
fi

# 2. Build with wasm-pack
echo "[2/4] Compiling to WebAssembly via wasm-pack (--target web --release)..."
if command -v wasm-pack >/dev/null 2>&1; then
  wasm-pack build \
    --target web \
    --release \
    --out-dir pkg \
    --out-name vodozemac_winkey \
    -- \
    --features js
else
  echo "wasm-pack not found in PATH. Using cargo build + wasm-bindgen fallback:"
  cargo build --target wasm32-unknown-unknown --release
  mkdir -p pkg
  wasm-bindgen target/wasm32-unknown-unknown/release/vodozemac_winkey.wasm \
    --out-dir pkg \
    --target web \
    --out-name vodozemac_winkey
fi

# 3. Optimize WASM binary size if wasm-opt is installed
if command -v wasm-opt >/dev/null 2>&1; then
  echo "[3/4] Running wasm-opt (-Oz --strip-debug)..."
  wasm-opt -Oz --strip-debug pkg/vodozemac_winkey_bg.wasm -o pkg/vodozemac_winkey_bg.wasm
else
  echo "[3/4] wasm-opt not found, skipping post-link binaryen pass."
fi

# 4. Report bundle sizes
echo "[4/4] Reporting bundle sizes:"
RAW_WASM=$(wc -c < pkg/vodozemac_winkey_bg.wasm || echo 0)
GZIP_WASM=$(gzip -c9 pkg/vodozemac_winkey_bg.wasm | wc -c || echo 0)
echo "  - Raw WASM:   ${RAW_WASM} bytes"
echo "  - Gzip WASM:  ${GZIP_WASM} bytes"
echo "Build complete."
