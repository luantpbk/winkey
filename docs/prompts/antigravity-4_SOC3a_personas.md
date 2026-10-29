# Antigravity 4 — SOC-3a: system tests for E2EE chat

Read the SOC-3 addendum (2026-10-30) at the end of `docs/DECISIONS.md` and `contracts/openapi/chat.v1.yaml`. Work in `systest/` and `loadtest/`. Branch `agent/ag4/soc3a-personas` from `origin/main`. Start when AG3's chat-svc and AG1's web PRs are merged. Do not merge your own PR.

## S13 chat (API, using vodozemac in Node through AG1's wasm package or the spike wrapper)
- **Devices:** register two devices for A and one for B, with real signatures. A tampered signature → `400 INVALID_SIGNATURE`. Reusing an identity key → `409`. An 11th device → `409`.
- **Keys:** 10 parallel claims on a device with 5 keys → 5 distinct one-time keys, then the fallback key.
- **Requests:** A (not followed by B) opens a DIRECT conversation → B is `REQUESTED`. B's `sendMessage` → `403 REQUEST_PENDING`. B accepts and replies. The full encrypt/decrypt round trip works across all three devices.
- **To-device filtering:** C (a stranger) sending to B's device → skipped. A blocks B → `sendMessage` `403 INTERACTION_BLOCKED`, and to-device to B skipped.
- **Groups:**
  - a group of 4: a member removed by an admin can no longer fetch messages after their `left_seq`;
  - a new member cannot fetch messages before their `joined_seq`;
  - the owner leaving hands ownership over;
  - a 51st member → `409`.
- **Realtime:** each of the above produces the expected `chat.hint` on the recipient's WebSocket. A hint never contains ciphertext.
- **Privacy check:** grep chat-svc container logs during the run for any ciphertext or key string → must be absent.

## Persona "chatter" (Playwright, two contexts, desktop and 360 px)
- Request → accept → conversation.
- Safety number dialog matches on both sides.
- A second device for one user joins and sees new messages.
- Delete for everyone.
- Collect `securitypolicyviolation` events during the run and assert there are none.

## Load (`loadtest/`)
200 users, groups of 10–50, 2 messages/s per active group for 10 minutes, measured on the local stack sized like the edge. Targets: p95 `sendMessage` < 120 ms, p95 `listMessages` < 80 ms, error rate < 0.5 %. Report the slowest queries. Production load tests only in the 02:00–03:30 ICT window or with a dated user approval.
