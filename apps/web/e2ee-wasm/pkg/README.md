# SOC-3 E2EE Browser Library Spike (`spikes/soc3-e2ee`)

Standalone spike package evaluating WebAssembly end-to-end encryption (E2EE) libraries for Winkey (ADR-049 §5 and `docs/prompts/antigravity-1_SOC3_e2ee-spike.md`).

> [!NOTE]
> This is a time-boxed research spike. It is **not** part of the `pnpm-workspace.yaml` and is never deployed to production.

---

## 1. Structure

```
spikes/soc3-e2ee/
├── Cargo.toml            # Rust crate vodozemac-winkey (opt-level="z", LTO, strip)
├── build.sh              # Pinned toolchain (rustc 1.84.0, wasm-pack 0.13.1)
├── src/
│   ├── lib.rs            # wasm-bindgen exports & panic hook
│   ├── account.rs        # Curve25519/Ed25519 identity & 50 One-Time Keys
│   ├── session.rs        # Olm 1-1 Double Ratchet outbound/inbound sessions
│   ├── group_session.rs  # Megolm outbound sender session
│   ├── inbound_group_session.rs # Megolm inbound group ratchet
│   ├── pickle.rs         # 32-byte pickle key validation & zeroizing buffers
│   └── tests.rs          # Rust roundtrip unit tests
├── pkg/
│   ├── vodozemac_winkey.d.ts # TypeScript definitions
│   └── vodozemac_winkey.js   # ESM/CJS initialization & bindings
├── test/
│   ├── roundtrip.test.mjs    # Olm 1-1, Megolm & pickle wrong-key rejection
│   ├── persistence.test.mjs  # Non-extractable WebCrypto key & zero-leak isolation
│   └── backup.test.mjs       # Argon2id (64 MiB) key derivation & AES-256-GCM
├── index.html            # Browser benchmark UI & CSP1 demonstration
├── worker.js             # Offloaded Web Worker cryptography
├── benchmark.mjs         # Node/CLI benchmark suite runner
└── package.json          # Standalone package definition
```

---

## 2. How to Run

### Run Unit Tests
```bash
npm test
```

### Run Benchmarks
```bash
npm run bench
```

### Run Browser Demo
```bash
npx serve .
# Open http://localhost:3000/index.html
```

---

## 3. Comprehensive Report
The complete evaluation, verbatim tool measurements, browser compatibility matrix, CSP findings, and architectural recommendations are documented in [docs/spikes/SOC3-e2ee.md](../../docs/spikes/SOC3-e2ee.md).
