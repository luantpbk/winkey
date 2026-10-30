# Winkey E2EE WebAssembly Crate (`vodozemac-winkey`)

Thin `wasm-bindgen` wrapper around [Matrix.org's vodozemac](https://gitlab.matrix.org/matrix-org/vodozemac) (0.11.1) for Winkey SOC-3a End-to-End Encrypted Messaging (ADR-049 §5).

## Pinned Toolchain

To ensure deterministic, byte-for-byte reproducible builds in local development and CI:
- **Rust Toolchain**: `1.99.1` (pinned in `rust-toolchain.toml`)
- **Target**: `wasm32-unknown-unknown`
- **wasm-pack**: `0.15.0` (`https://github.com/wasm-bindgen/wasm-pack/releases/tag/v0.15.0`)

## How to Build

From within `apps/web/e2ee-wasm`:
```bash
wasm-pack build --target web --release
```

Output files:
- Generated wrapper and typings in `pkg/`
- Static WASM binary mirrored to `apps/web/public/wasm/vodozemac_winkey_bg.wasm`

## CI Verification

The `.github/workflows/ci.yml` workflow (`verify-wasm` job) compiles this crate on every PR touching `apps/web/e2ee-wasm/**` or `apps/web/public/wasm/**` and validates byte-for-byte parity against committed artifacts.
