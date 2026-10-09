"""Run the unchanged harness with exactly its pinned k6 image, offline."""
import json
import os
import subprocess
import time
import uuid
from pathlib import Path

p = Path(__file__).parent
K6 = "grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"
PYTHON = "python@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72"


def docker(*args, timeout=30):
    return subprocess.run(["docker", *args], capture_output=True, timeout=timeout)


version = docker("run", "--rm", "--network", "none", K6, "version")
assert version.returncode == 0, version.stderr.decode()
assert "k6 v2.3.0 (commit/e088784614" in version.stdout.decode(), version.stdout.decode()
print(version.stdout.decode().strip())
outputs = p / "k6-outputs"
outputs.mkdir(exist_ok=True)
# Only sanitized disposable summaries are stored here; allow the image's uid12345.
outputs.chmod(0o777)
for mode in ["empty", "invalid-master", "first-500", "remaining-500", "valid"]:
    name = "lt2-g1-mock-" + uuid.uuid4().hex[:12]
    k6_name = name + "-k6"
    try:
        start = docker("run", "-d", "--name", name, "--network", "none",
                       "--mount", f"type=bind,source={p},target=/audit,readonly",
                       "-e", f"PROBE_MODE={mode}", PYTHON, "python", "/audit/docker-mock.py")
        assert start.returncode == 0, start.stderr.decode()
        deadline = time.monotonic() + 10
        while "PROBE_READY" not in docker("logs", name).stdout.decode():
            if time.monotonic() >= deadline:
                raise RuntimeError("offline mock server did not start")
            time.sleep(0.1)
        cmd = ["run", "--rm", "--name", k6_name, "--network", "container:" + name,
               "--mount", f"type=bind,source={p},target=/audit,readonly",
               "--mount", f"type=bind,source={outputs},target=/outputs",
               K6, "run", "--no-usage-report", "--no-color", "--vus", "1", "--iterations", "1",
               "--duration", "5s", "--summary-export", f"/outputs/{mode}-summary.json",
               "-e", "TARGET_URL=http://127.0.0.1:17878", "-e", "EXECUTOR=constant-vus",
               "-e", "VUS=1", "/audit/hls-viewers.js"]
        run = docker(*cmd, timeout=20)
        (outputs / (mode + "-k6.log")).write_bytes(run.stdout + run.stderr)
        data = json.loads((outputs / (mode + "-summary.json")).read_text())
        metrics = data["metrics"]
        # Read back ONLY synthetic fixture counters/paths, inside the same isolated namespace.
        probe = docker("run", "--rm", "--network", "container:" + name, PYTHON, "python", "-c",
                       "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:17878/_probe').read().decode())")
        assert probe.returncode == 0, probe.stderr.decode()
        trace = json.loads(probe.stdout)
        assert run.returncode == (99 if mode in ["first-500", "remaining-500"] else 0), (mode, run.returncode)
        if mode in ["empty", "invalid-master"]:
            assert trace["segment_requests"] == 0
        if mode in ["first-500", "remaining-500"]:
            assert metrics["total_watch_time_ms"]["count"] > 0 and trace["segment_requests"] > 1
        selected = {k: v for k, v in metrics.items() if k in ["aggregate_rebuffer_ratio", "rebuffer_ratio",
                    "rebuffer_ratio_incl_seek", "total_watch_time_ms", "total_stall_time_ms", "http_req_failed", "iterations"]}
        print(json.dumps({"mode": mode, "exit": run.returncode, "metrics": selected, **trace}))
    finally:
        # Only names created by this probe; never prune or stop any other container.
        docker("rm", "-f", k6_name, name)
print("Pinned-image actual-source observations: 5/5 confirmed; these are defect confirmations, NOT harness acceptance.")
