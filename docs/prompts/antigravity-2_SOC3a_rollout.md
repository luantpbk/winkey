# Antigravity 2 — SOC-3a: chat-svc deployment, grants, NATS, gateway

Read the SOC-3 addendum (2026-10-30) at the end of `docs/DECISIONS.md`, `contracts/openapi/chat.v1.yaml` (`info`), and the `chat.hint` rows of `contracts/realtime/README.md`. Work in `deploy/`, workflows, and root tooling. Apply to production only after the PRs are merged, and only while chat is limited to the closed beta.

1. **Database role** `chat_svc` (grants script, compose/systest equivalents, guarded for objects that exist only after migration 000033):
   - owner-like CRUD on `chat.*`, with default privileges for future tables;
   - `USAGE` on `auth` and `social`, plus `SELECT` on `auth.public_profiles`, `social.blocks`, `social.subscriptions` only;
   - `verify.sh` negative checks: `chat_svc` cannot read `auth.users` or `social.posts`; `social_svc` cannot read `chat.messages`.
2. **NATS user `chat`:** publish only `rt.chat.user.*` and `_INBOX.>`; subscribe `_INBOX.>`. User `realtime`: add subscribe `rt.chat.user.*`. In `verify.sh`, `chat` cannot publish `video.ready` or `social.>`, and `video` cannot publish `rt.chat.user.x`.
3. **Valkey:** chat-svc uses its own key prefix (`chat:`) for rate limits and the purge lock.
4. **Gateway:** `PathPrefix(/v1/chat)` → chat-svc (forwardAuth like other `/v1/*`). Body limit 1 MiB on `/v1/chat/to-device`, 128 KiB on the other chat routes.
5. **Images / CI:** add `chat` to the image matrix (multi-arch). Agree with AG1 on the vodozemac wasm build: either the web image build runs `wasm-pack` with a pinned toolchain, or a CI job checks that the committed `pkg/` matches a fresh build. Document the choice.
6. **Rollout order:** migration 000033 → grants + `verify.sh` → NATS permissions (reload with SIGHUP) → chat-svc → realtime-gw (with `rt.chat.user.*`) → web (AG1). Report on #47: digests from the CI logs, `readyz`, and `verify.sh` output (no secrets).
