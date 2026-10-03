# Kickoff — ChatGPT · Task #193 (flaky analytics test: "all acknowledged" times out)

ChatGPT joins as **acting owner of the Go API side** (`services/video`, `services/analytics`, `libs/go`) while
Sonnet is paused. This first task is small and fully verifiable on purpose.

````text
# ROLE
You are "ChatGPT", a Go engineer on "Winkey" (repo luantpbk/winkey). While Sonnet is paused you own
services/video, services/analytics and libs/go. Read AGENTS.md first (hard rules: stay in your directories, never
edit contracts/ or db/, never skip/weaken a test, one task per branch/PR, never merge your own PR), then
docs/ARCHITECTURE.md §4 and ADR-008/ADR-010 in docs/DECISIONS.md.

# REPO
Worktree: git worktree add ../winkey-gpt-193 -b agent/gpt/193-analytics-ack-flake origin/main
Before every commit: git branch --show-current must print agent/gpt/193-analytics-ack-flake.

# CONTEXT (issue #193)
Main CI run 36881703822, job "go (services/analytics)", commit 11c8c476 (a deploy-only commit; the next commit
was green):
    --- FAIL: TestClickHouseDownMidRunLosesNothingAndSumsStayExact (41.98s)
        analytics_test.go:428: timed out waiting for: all acknowledged
All 10 000 rows were present (the count wait passed), but NumPending == 0 && NumAckPending == 0 was not reached
within 30 s.
Files: services/analytics/internal/integration/analytics_test.go (the test, waitFor, stack.stopWorker),
services/analytics/internal/worker/{worker.go,jetstream.go} (AckWait = 60 s, MaxAckPending, the InProgress
keep-alive of a batch waiting for the database).

Architect's hypothesis (NOT verified — prove or disprove it):
the test restarts the worker while ClickHouse is down. The stopped worker had already sent InProgress for its
in-flight batch, so those messages stay ack-pending until AckWait (60 s) expires and they are redelivered. The
rows reach 10 000 because the batch is re-inserted (same dedup token), but the acks drain only after up to 60 s,
longer than the test's 30 s window.

# TASK
1. Reproduce: go test ./internal/integration -run TestClickHouseDownMidRun -count=20 (Docker required,
   WINKEY_REQUIRE_DOCKER=1). Record how many runs fail BEFORE any change. If it never fails locally, add
   temporary logging of ConsumerInfo (NumPending, NumAckPending, NumRedelivered) at the timeout to find out
   what is pending, and say what you saw.
2. Root-cause it and fix the PRODUCT if the product is wrong. Example: on shutdown the worker should Nak its
   in-flight, unwritten batch so it is redelivered at once, instead of holding it until AckWait. Only if the
   product is right, change the test, and the new wait must be justified by the worker's own constants (for
   example AckWait + margin) with a comment that says why. Raising a timeout with no explanation is rejected.
3. Do not weaken any assertion: "no loss, no duplicate, exact hourly sums" and "nothing acknowledged during the
   outage" must stay.
4. If the fix is in the worker, add a unit test for it (worker package, no Docker).

# DEFINITION OF DONE
- go vet, golangci-lint (if configured in CI), go test ./... for services/analytics green locally and in CI.
- The PR (Handoff Report, .github/pull_request_template.md) pastes VERBATIM:
  the -count=20 output before the fix (failures, or "0/20 failed" plus the diagnostic you used), and the
  -count=20 output after the fix (must be 20/20 ok).
- The root cause in 3–5 sentences with file:line references.
- Open the PR yourself against main; do not merge it.

# OUT OF SCOPE
Any change outside services/analytics; contract or migration changes (open an issue instead).
````
