# Kickoff — Antigravity 1 · Task N2-web (react to realtime notification hints)

Starts after N1-web (#132, merged). Design: ADR-023 addendum "N2". Contract on main: `notification.hint` in
contracts/realtime/server.schema.json ($defs.notificationHint) and the README rows. The realtime-gw side (Antigravity
3, N2) is in progress — build against the existing realtime test harness / a fake socket; the contract is final.

````text
# ROLE
You are the frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag1-n2web -b agent/ag1/n2-web-notification-hints origin/main
READ FIRST: docs/DECISIONS.md ADR-023 addendum N2, contracts/realtime/README.md (`notification.hint` note),
apps/web/src/lib/realtime/* (client, types, schema validator), components/notifications/notification-bell.tsx.
You own: apps/web, e2e/, packages/api-client.

# TASK N2-web — build
1. Realtime types: add `notification.hint` ({kind: VIDEO_COMMENT | COMMENT_REPLY | NEW_SUBSCRIBER}) to the typed
   event union (the validator already reads the contract file, so it accepts the frame).
2. On a `notification.hint` for the signed-in user (room `user:{me}`): invalidate
   `['notifications','unread-count']`; if the dropdown or the /notifications page is open, also invalidate its list
   query. Coalesce bursts: at most one refetch per 2 s (trailing). Never render anything from the hint itself.
3. Polling: while the realtime socket is connected and authenticated, the unread-count `refetchInterval` becomes
   5 min; while disconnected (or anonymous socket), 60 s as today. Still visible-tab only. On reconnect, refetch once
   (the existing "notify REST refetch after reconnect" hook).
4. No change to the bell UI.

# DEFINITION OF DONE
- Vitest (fake timers + the existing fake realtime client): a hint invalidates the count once; 5 hints within 2 s →
  1 refetch; interval is 5 min when connected and 60 s after a disconnect; reconnect → one refetch; a hint while the
  dropdown is open also refetches the list; hints are ignored when signed out.
- Playwright (MSW + fake socket if the harness supports it; otherwise Vitest only, say so): badge updates after a
  pushed hint without waiting for the poll.
- `pnpm --filter @winkey/web run lint && typecheck && test && build`, root `pnpm run lint && pnpm run
  format:check`, CI green; new test files 10× in a row. Open the PR yourself; description = Handoff Report.

# OUT OF SCOPE
realtime-gw (Antigravity 3), contracts, any server change.
````
