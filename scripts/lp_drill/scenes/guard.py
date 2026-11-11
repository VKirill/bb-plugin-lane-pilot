"""The lane-stack guard: hashes on the machines, a mismatch repair, the scenario."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from lp_drill.env import BB, DATE, ROOT
from lp_drill.hub import bb, log, run
from lp_drill.report import verdict

GUARD_FILES = ("guard_shell.py", "lib_payload.py")
GUARD_REPO = ROOT / "lane-stack" / "hooks"
# Lane Pilot's own guard (guard-apply.ts GUARD_RELATIVE_PATH); ~/.agents/hooks was Claude Lane's and is moved aside (2026-10-30).


def guard_machines() -> list[dict]:
    """The machines whose installed guard is compared with the repository's. kind: local (this machine), bb (bb file read/write --host), ssh."""
    raw = os.environ.get("LP_DRILL_GUARD_HOSTS")
    if raw:
        return json.loads(raw)
    return [
        {"name": "mac-mini", "kind": "local", "home": str(Path.home())},
        {"name": "macbook", "kind": "bb", "host": os.environ.get("LP_DRILL_MACBOOK_HOST", "host_p7jhrgsapq"), "home": os.environ.get("LP_DRILL_MACBOOK_HOME", "/Users/vechkasov")},
        {"name": "ovh", "kind": "ssh", "host": os.environ.get("LP_DRILL_OVH_SSH", "ovh-main")},
    ]


def sha256_of(data: bytes) -> str:
    import hashlib
    return hashlib.sha256(data).hexdigest()


GONE = ("enoent", "no such file", "not found", "does not exist")


def guard_read(machine: dict, name: str) -> tuple[bytes | None, str | None]:
    """(content, None) when read, (None, 'missing') when the machine answers that the file is not there, (None, why) when it cannot be asked."""
    kind = machine["kind"]
    if kind == "local":
        try:
            return (Path(machine["home"]) / ".agents/lane-pilot/pm" / name).read_bytes(), None
        except FileNotFoundError:
            return None, "missing"
        except OSError as cause:
            return None, str(cause)
    if kind == "bb":
        rc, out, err = bb("file", "read", "--host", machine["host"], f"{machine['home']}/.agents/lane-pilot/pm/{name}", "--json", timeout=60)
        if rc == 0:
            try:
                return str(json.loads(out)["content"]).encode(), None
            except (ValueError, KeyError, TypeError):
                return None, f"unreadable answer: {out[:120]}"
        text = (err + out).lower()
        return None, "missing" if any(word in text for word in GONE) else (err or out).strip()[:200] or f"exit {rc}"
    rc, out, err = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", machine["host"], f"cat ~/.agents/lane-pilot/pm/{name}"], timeout=60)
    if rc == 0:
        return out.encode(), None
    if rc != 255 and any(word in err.lower() for word in GONE):
        return None, "missing"
    return None, err.strip()[:200] or f"exit {rc}"


def guard_install_command(machine: dict, name: str) -> str:
    src = GUARD_REPO / name
    if machine["kind"] == "local":
        dest = f"{machine['home']}/.agents/lane-pilot/pm/{name}"
        return f"cp -p {dest} {dest}.bak-{DATE}; install -m 755 {src} {dest}"
    if machine["kind"] == "bb":
        return f"bb file write --host {machine['host']} --stdin --create-parents {machine['home']}/.agents/lane-pilot/pm/{name} < {src}"
    return f"scp {src} {machine['host']}:.agents/lane-pilot/pm/{name} && ssh {machine['host']} chmod 755 .agents/lane-pilot/pm/{name}"


def guard_install(machine: dict, name: str) -> str | None:
    """Puts the repository's file on the machine (the old one is kept as .bak-<date>); None when done, the reason when not."""
    data = (GUARD_REPO / name).read_bytes()
    if machine["kind"] == "local":
        dest = Path(machine["home"]) / ".agents/lane-pilot/pm" / name
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                shutil.copy2(dest, dest.with_name(f"{name}.bak-{DATE}"))
            tmp = dest.with_name(f".{name}.{os.getpid()}.tmp")
            tmp.write_bytes(data)
            tmp.chmod(0o755)
            tmp.replace(dest)
        except OSError as cause:
            return str(cause)
        return None
    if machine["kind"] == "bb":
        path = f"{machine['home']}/.agents/lane-pilot/pm/{name}"
        done = subprocess.run([BB, "file", "write", "--host", machine["host"], "--stdin", "--create-parents", path, "--json"], input=data.decode(), capture_output=True, text=True, timeout=90)
        return None if done.returncode == 0 else (done.stderr or done.stdout).strip()[:200]
    host = machine["host"]
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, f"mkdir -p ~/.agents/lane-pilot/pm && cd ~/.agents/lane-pilot/pm && [ ! -e {name} ] || cp -p {name} {name}.bak-{DATE}; cat > .{name}.tmp && chmod 755 .{name}.tmp && mv .{name}.tmp {name}"],
                          input=data.decode(), capture_output=True, text=True, timeout=90)
    return None if done.returncode == 0 else done.stderr.strip()[:200]


def scenario_guard_hash(tmp: Path, repair: bool = False) -> dict:
    """The guard that actually runs is the installed copy on each machine (audit 2026-10-08 round 3, P0-3): it must be the repository's."""
    problems: list[str] = []
    expected = {}
    for name in GUARD_FILES:
        try:
            expected[name] = sha256_of((GUARD_REPO / name).read_bytes())
        except OSError as cause:
            return verdict("guard_hash", [f"the repository has no {GUARD_REPO / name}: {cause}"])
    machines: list[dict] = []
    for machine in guard_machines():
        entry: dict = {"machine": machine["name"], "files": {}}
        machines.append(entry)
        for name in GUARD_FILES:
            data, why = guard_read(machine, name)
            state, installed = "ok", sha256_of(data) if data is not None else None
            if data is None and why != "missing":
                state = "unreachable"
                log(f"guard_hash: {machine['name']}: {name}: {why}")
            elif installed != expected[name]:
                state = "missing" if data is None else "drift"
                if repair:
                    failure = guard_install(machine, name)
                    again, _ = guard_read(machine, name)
                    if failure is None and again is not None and sha256_of(again) == expected[name]:
                        state, installed = "repaired", expected[name]
                    else:
                        state = f"{state}, repair failed: {failure or 'the file read back differs'}"
                if state != "repaired":
                    problems.append(f"{machine['name']}: {name} {'is missing' if state.startswith('missing') else 'differs from the repository'} (installed {str(installed)[:12] if installed else 'none'}, repository {expected[name][:12]}); install: {guard_install_command(machine, name)}")
            entry["files"][name] = {"state": state, "installed": installed, "expected": expected[name]}
        entry["reachable"] = any(f["state"] != "unreachable" for f in entry["files"].values())
    unreachable = [m["machine"] for m in machines if not m["reachable"]]
    return verdict("guard_hash", problems, machines=machines, expected=expected, unreachable=unreachable, repaired=repair)
