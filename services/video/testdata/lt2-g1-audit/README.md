# LT2-G1 reproducible evidence (#278)

This corrects the evidence-portability finding in
[Astra's review comment](https://github.com/luantpbk/winkey/issues/278#issuecomment-6059306008).
It publishes sanitized executable probes in the video owner's testdata directory.
No Go product logic, configuration, `loadtest/`, or AG4 branch is modified.

**These probes confirm defects at an old, exact source snapshot. They are not
acceptance tests for the repaired LT2 harness.** AG4 must implement the fixes,
run regressions on its actual final head, and integrate only reviewed/accepted
pieces. This draft evidence PR does not authorize a production run.

## Snapshot and runtimes

- Harness: #263 at `59d81f3c63fd4b81ab9c760b956618f7b4828ccd`.
- `snapshot-sha256.json` checks the four actual source files before execution.
  The probes execute unchanged HLS and shell modules, not copied implementations.
- k6 is exactly the image in that runner:
  `grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603`.
  Actual local version: **v2.3.0, e088784614, Go1.27.1, linux/amd64**.
- The Python fixture image is also pinned:
  `python@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72`.
- Host dependencies: Git, Node >=22, Python >=3.10, Bash, Docker running.
  Windows uses Git Bash; set `PROBE_BASH` to its executable if installed elsewhere.
  Paths are derived from the checkout and disposable directory; no drive-letter
  assumption or previous author's evidence directory is required.

## Run on Linux or Windows

From the repository root, ensure the exact harness commit is available (fetch
`origin agent/ag4/lt2-1000-viewers` if necessary) and pre-pull these two images:

```sh
docker pull grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603
docker pull python@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72
python3 services/video/testdata/lt2-g1-audit/run-audit.py --output-dir /tmp/lt2-g1-results
```

On Windows, use `python` and an output directory such as
`$env:TEMP/lt2-g1-results`. No credentials, account journal, invite code or
production access is needed. The suite validates the snapshot hash, copies it
and the probes into a temporary directory, runs them, and saves all four probe
outputs plus the k6 summaries/logs into the chosen output directory. Missing
dependencies, wrong source hashes and unexpected behavior fail nonzero; probes
are never silently skipped.

The k6 mock container has `--network none`, binds only its loopback address and
publishes **no host ports**. k6 and the trace reader share that namespace. Usage
reporting is disabled. Cleanup removes only randomly named containers created
by this probe; there is no prune or unowned-container operation. The writable
output mount contains only disposable synthetic summaries, not recovery
journals. Fixture byte strings are synthetic; this is not a decoder/HLS-media
conformance test.

The shell probe exports fake-only `docker`, `node`, `curl`, and `sleep` adapters.
It never starts the real generators, collector, preseed or cleanup. Thus it
tests the actual shell's final status handling, **not** collector durability,
account deletion, watchdog correctness or real abort/drain lifecycle. Its
synthetic `QOE_GATE_FILE` is a proposed probe input, not an interface currently
implemented by #263.

## What the output means

| Group | Confirmations | Expected current observation |
| --- | ---: | --- |
| Actual HLS module, controlled k6 imports/clock | 9 | Missing playback invents a URL; PRIVATE is accepted; failed segments still earn watch; Rate rounds incorrectly |
| Independent numerical fixture oracle | 9 | Exact fractions for unequal sessions, < / = / >1%, inclusive seek and zero denominator |
| Actual shell with fake-only CLI adapters | 3 | Either process failure exits1; both process exits0 still exit0 despite a synthetic aggregate FAIL artifact |
| Exact pinned k6 image, isolated HTTP server | 5 | Empty pool/empty master exit0; segment500 exits99 only through HTTP threshold; failed media still earns watch |

Successful reproduction ends with **26/26 observations confirmed**. This means
the known failures were observed, not that #263 is ready. In particular:

- The nine module assertions are **defect-confirmation probes**, not nine
  acceptance tests. The oracle only checks expected arithmetic.
- W=4800ms/S=49ms gives `49/4849 = 1.0105176325%` but the current Rate is0%.
- W=5000ms/S=50ms gives `1/101 = 0.9900990099%` but the current Rate is1.9608%.
- Native unpinned Windows results from the earlier issue report are supplemental;
  the portable suite's container results are from the exact pinned Linux image.
- k6 exported threshold booleans mean **breached** when true. Both human and
  JSON summaries from the current source are retained; there is no repaired
  aggregate-summary hook in this evidence PR.

`results/` contains relevant actual outputs from the portable suite, not invented
example output. Request timing, generated scratch paths and process IDs vary.
The numerical oracle and VM counters are deterministic. Runtime-dependent
timings are asserted only where necessary to establish the defect.

AG4's acceptance tests must instead require PUBLIC READY detail, real contract
URLs/resolution, valid init/first/remaining segments, immediate test-wide invalid
playback failure, no invented watch, exact W/S/K aggregate calculations, null
for undefined ratios with a nonzero gate result, informational session p95,
separate inclusive report, and agreement between both workloads' retained
summaries and the runner's final exit. The full source/contract audit remains in
[#278](https://github.com/luantpbk/winkey/issues/278#issuecomment-6058791963).
