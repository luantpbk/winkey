"""Materialize hash-checked actual source in a disposable directory and run probes."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parents[3]
parser = argparse.ArgumentParser()
parser.add_argument("--output-dir", required=True, type=Path)
args = parser.parse_args()
out = args.output_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
lock = json.loads((here / "snapshot-sha256.json").read_text())
with tempfile.TemporaryDirectory(prefix="winkey-lt2-g1-") as directory:
    work = Path(directory)
    work.chmod(0o755)
    for name, expected in lock["sha256"].items():
        source = subprocess.check_output(["git", "-C", str(root), "show", lock["head"] + ":loadtest/" + name])
        assert hashlib.sha256(source).hexdigest() == expected, name
        (work / name).write_bytes(source)
        (work / name).chmod(0o644)
    for file in here.iterdir():
        if file.suffix in [".py", ".mjs", ".json"]:
            shutil.copyfile(file, work / file.name)
            (work / file.name).chmod(0o644)
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    commands = [
        ["node", "--experimental-vm-modules", "audit-source.mjs"],
        [sys.executable, "check-qoe-fixtures.py"],
        [sys.executable, "check-runner.py"],
        [sys.executable, "check-pinned-k6.py"],
    ]
    for command in commands:
        print("RUN", " ".join(command), flush=True)
        run = subprocess.run(command, cwd=work, env=env, capture_output=True, timeout=180)
        raw = run.stdout + run.stderr
        (out / (Path(command[-1]).stem + ".txt")).write_bytes(raw)
        print(raw.decode("utf-8"), end="", flush=True)
        assert run.returncode == 0, command
    shutil.copytree(work / "k6-outputs", out / "k6-outputs", dirs_exist_ok=True)
print("26/26 observations confirmed: 9 actual-module + 9 numeric oracle + 3 runner + 5 pinned k6.")
print("These assertions confirm current defects; final AG4 acceptance tests must expect corrected behavior.")
