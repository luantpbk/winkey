# Antigravity 1 — SOC-3 spike: choose the E2EE library (browser)

Read `AGENTS.md`, then **ADR-049** section 5 "Nhắn tin E2EE (SOC-3)" and the CSP1 addendum (2026-10-29) at the end of `docs/DECISIONS.md`. This is a **time-boxed spike (at most 3 working days)**. Its output is a measured report and a recommendation, not product code.

Work only in a new directory `spikes/soc3-e2ee/`: a standalone package, **not** added to `pnpm-workspace.yaml` and never deployed. Branch `agent/ag1/soc3-e2ee-spike` from `origin/main`. Do not merge your own PR.

## Candidates
1. **vodozemac** (Rust; Olm = Double Ratchet for 1-1, Megolm = sender keys for groups; audited by Least Authority in 2022) compiled to WebAssembly.
   - Write a thin `wasm-bindgen` wrapper with only what we need: `Account` (identity and one-time keys), Olm `Session` (outbound/inbound, encrypt/decrypt), `GroupSession` and `InboundGroupSession` (Megolm), and pickle/unpickle with a 32-byte key.
   - Compare it with the existing `@matrix-org/matrix-sdk-crypto-wasm` (much larger: a whole Matrix crypto state machine). Report both sizes and say why one wins.
2. **libsignal** as the fallback: check whether a supported **browser** build exists. `@signalapp/libsignal-client` is a Node native module. If there is no maintained browser/WASM build, say so with sources (repo, issues, release notes); do not build one.
3. Optional, informational only: OpenMLS (MLS, RFC 9420) compiled to WASM. Report its bundle size, maturity and audit status in one paragraph.

## What to measure and report (numbers, verbatim tool output)
- **Size:** `.wasm` and glue JS, raw / gzip / brotli.
- **Startup:** time to fetch, compile and instantiate on a cold load, on a mid-range Android phone (or Chrome DevTools 4× CPU throttle) and on desktop.
- **Olm 1-1:** create an account with 50 one-time keys; establish a session from a prekey bundle; encrypt and decrypt a 1 KiB message (median and p95 over 1 000 runs).
- **Megolm group of 50:**
  - cost to create the group session;
  - cost to share its key with 50 recipients × 2 devices each (100 Olm encryptions);
  - encrypt and decrypt per message;
  - key rotation after a member leaves.
- **Persistence:** pickle all state with a key derived from a **non-extractable** WebCrypto AES-GCM key kept in IndexedDB.
  - Show that the plaintext pickle never touches `localStorage` or the network.
  - Measure the pickle size per Olm session and per inbound Megolm session.
- **Workers:** run the crypto in a dedicated Web Worker and show the main thread stays free (no long tasks > 50 ms while encrypting 100 messages).
- **Browser support:** Chrome, Firefox and Safari (macOS and iOS 16+), as a matrix of pass/fail with versions. Use BrowserStack or real devices if available; otherwise state what was not tested.
- **CSP:** run the demo page under the CSP1 policy. WebAssembly compilation needs `'wasm-unsafe-eval'` in `script-src`. Confirm it, confirm that no other relaxation is needed (no `'unsafe-eval'`), and check that the worker loads with `worker-src 'self' blob:`.
- **Backup:** encrypt a key-backup blob with a passphrase via **Argon2id** in WASM (memory 64 MiB, 3 iterations, parallelism 1) and AES-256-GCM. Measure the time on a phone and report the library used.

## Deliverables
- `spikes/soc3-e2ee/` containing:
  - the wrapper crate and its build script (pinned toolchain, reproducible `wasm-pack` build);
  - a static demo page that runs every measurement and prints a JSON result;
  - unit tests (Rust and JS) for the round trips: Olm, Megolm, and pickle/unpickle with the right key and failure with a wrong key.
- `docs/spikes/SOC3-e2ee.md`:
  - the numbers above as tables;
  - the browser matrix;
  - the CSP finding;
  - risks (maintenance, audit coverage of the bindings, WASM size budget);
  - a clear **recommendation** with reasons.
- No changes outside `spikes/soc3-e2ee/` and `docs/spikes/`. Do not add dependencies to `apps/web`.

Push, open the PR with the Handoff Report, and report when CI is green. The architect writes the SOC-3 contracts, migration and `chat-svc` design from your report.
