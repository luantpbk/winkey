# Antigravity 1 — AV1-tel: report the playing codec in playback samples (ADR-048 addendum)

**Wait for the go-ahead:** do not merge until the architect confirms that the new analytics-worker runs on gpu-01
(the old worker terminates samples with unknown fields). You can open the PR right away.

## Contract (already merged, `contracts/openapi/video.v1.yaml` → `PlaybackSample`)

Two optional fields, regenerated in `@winkey/api-client`:

- `codec`: `'h264' | 'av1'`. The codec of the master the player **actually loaded**, not the one it wanted:
  - `av1` only when the source URL is `hls_av1_url`;
  - `h264` when it is `hls_url`, including the fallback when `activeCodec === 'av1'` but the video has no
    `hls_av1_url` (see `video-player.tsx` around lines 170–175 and 485–495).
  - If the player switches master mid-playback (refresh of signed URLs, error fallback), later samples carry the new
    value.
- `av1_capable`: `boolean`, the result of `isAv1Supported()` for this device, whatever the video offers. Same value on
  every sample of one playback.
  - Omit it while the check has not resolved yet; never send `null` (the contract rejects `null` for both fields).

## Work (`apps/web` only)

1. `apps/web/src/lib/video/playback-tracker.ts`:
   - add `codec` and `av1Capable` next to `surface`;
   - add a setter (e.g. `setCodec(codec)` / `setAv1Capable(v)`) the player calls when it loads a source or the
     capability check resolves;
   - include them in every sample, omitting a field while it is unknown.
2. `apps/web/src/components/video/video-player.tsx` (and the embed page if it builds its own tracker): feed the tracker
   from the URL actually passed to hls.js / the `<video>` element.
3. Tests (Vitest):
   - samples carry `codec: 'av1'` only when the loaded URL is the AV1 master;
   - the fallback to `hls_url` reports `h264`;
   - `av1_capable` is omitted before the check resolves, then present on every later sample;
   - the batch still validates against the generated `PlaybackHeartbeatBatch` type.

## Done

Lint, typecheck and tests green. Handoff report as the PR description. No change outside `apps/web`.
