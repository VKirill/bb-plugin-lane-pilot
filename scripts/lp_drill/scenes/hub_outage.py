"""The hub outage probe: a stand-in door and bot, the live watchdog pass."""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.hub import log, run
from lp_drill.report import verdict

STAND_DOOR = """import http.server, sqlite3, sys, threading, time
port, db = int(sys.argv[1]), sys.argv[2]
if db != "-":
    con = sqlite3.connect(db)
    con.execute("pragma journal_mode=WAL"); con.execute("create table if not exists beats(n integer)")
    def beat():
        while True:
            con.execute("insert into beats values (1)"); con.commit(); time.sleep(0.05)
    threading.Thread(target=beat, daemon=True).start()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"v")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
"""

STAND_BOT = """import http.server, sys
log = open(sys.argv[2], "ab")
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = self.rfile.read(n)
        log.write(b"%s %s\\n" % (self.path.encode(), body)); log.flush()
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
"""


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _stand_up(state: Path, port: int, db: Path | None) -> list[str]:
    """A throwaway user service lp-drill-door serving /install/version (and, with db, committing a row a second into a WAL SQLite)."""
    (state / "stand_door.py").write_text(STAND_DOOR)
    unit = Path.home() / ".config/systemd/user/lp-drill-door.service"
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text(f"[Service]\nExecStart={sys.executable} {state / 'stand_door.py'} {port} {db or '-'}\nRestart=no\n")
    run(["systemctl", "--user", "daemon-reload"], timeout=30)
    rc, _, err = run(["systemctl", "--user", "restart", "lp-drill-door"], timeout=30)
    return [] if rc == 0 else [f"could not start the stand-in service: {err.strip()[:200]}"]


def _stand_down() -> None:
    run(["systemctl", "--user", "stop", "lp-drill-door"], timeout=30)
    (Path.home() / ".config/systemd/user/lp-drill-door.service").unlink(missing_ok=True)
    run(["systemctl", "--user", "daemon-reload"], timeout=30)


def _db_census(script: str, env: dict, db: Path) -> dict:
    """Rows committed in the stand-in database and what db-ready says of it."""
    rc, out, _ = run(["sqlite3", "-readonly", str(db), "select count(*) from beats;"], timeout=15)
    rows = int(out.strip()) if rc == 0 and out.strip().isdigit() else -1
    rc2, ready, _ = run(["bash", script, "db-ready"], env={**env, "LP_WATCH_DBS": str(db)}, timeout=30)
    return {"rows": rows, "ready": rc2 == 0 and "ready:" in ready}


def _watchdog_live(tmp: Path, with_bot: bool, census: bool) -> tuple[list[str], dict]:
    """The real (non-dry) watchdog against the stand-in service lp-drill-door: hang it with SIGSTOP so the process lives but the door is
    silent, let the watchdog declare, lift and see it rise; then read the record and the stand-in bot's posts. Never the real hub."""
    problems: list[str] = []
    state = tmp / "watchdog-live"
    state.mkdir(exist_ok=True)
    port, bot_port = free_port(), free_port()
    db = state / "stand.db" if census else None
    problems += _stand_up(state, port, db)
    if problems:
        _stand_down()
        return problems, {}
    bot = None
    tg_log = state / "tg-posts.log"
    tg_env = state / "tg.env"
    tg_env.write_text("TG_TOKEN=drill\nTG_CHAT=1\n")
    env = {**os.environ,
           "LP_WATCH_USER": "1", "LP_WATCH_SERVICE": "lp-drill-door",
           "LP_WATCH_DOOR": f"http://127.0.0.1:{port}/install/version",
           "LP_WATCH_STATE": str(state), "LP_WATCH_TG_ENV": str(tg_env),
           "LP_WATCH_TG_API": f"http://127.0.0.1:{bot_port}",
           "LP_WATCH_KNOCK_SEC": "1", "LP_WATCH_SUSPECT_AFTER": "2", "LP_WATCH_REFUSED_AFTER": "2",
           "LP_WATCH_FIRST_SEC": "0", "LP_WATCH_BB": "/nonexistent"}
    script = str(ROOT / "scripts" / "hub-watchdog.sh")
    proc = None
    try:
        if with_bot:
            (state / "stand_bot.py").write_text(STAND_BOT)
            bot = subprocess.Popen([sys.executable, str(state / "stand_bot.py"), str(bot_port), str(tg_log)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 30
        while time.time() < deadline:
            _, code, _ = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "2", f"http://127.0.0.1:{port}/install/version"], timeout=10)
            if code.strip() == "200":
                break
            time.sleep(0.5)
        else:
            _stand_down()
            return ["the stand-in door never answered"], {}
        _, pid, _ = run(["systemctl", "--user", "show", "-p", "MainPID", "--value", "lp-drill-door"], timeout=15)
        pid = pid.strip()
        census_before = _db_census(script, env, db) if db else None
        if not pid.isdigit() or int(pid) <= 1:  # 0 would signal the drill's own process group, 1 is init
            _stand_down()
            return [f"the stand-in service has no usable main pid (read {pid!r}); nothing was signalled"], {}
        os.kill(int(pid), signal.SIGSTOP)  # hung: the process lives, the door is silent
        proc = subprocess.Popen(["bash", script, "run"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log_path = state / "outages.jsonl"
        deadline = time.time() + 120
        events: list[str] = []
        while time.time() < deadline:
            if log_path.exists():
                events = [json.loads(line).get("event") for line in log_path.read_text().splitlines() if line.strip()]
                if "risen" in events or "out_of_tries" in events:
                    break
            time.sleep(2)
        details = {"events": events, "pid": pid}
        rows = [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()] if log_path.exists() else []
        if "outage" not in events:
            problems.append(f"no outage recorded for the hung stand-in: {events}")
        if not any(pid in (row.get("detail") or "") for row in rows if row.get("event") == "lift"):
            problems.append(f"no lift line names the killed pid {pid}")
        if "risen" not in events and "lift_without_outcome" not in events:
            problems.append("the lift's own lines are missing after the kill")
        if db is not None:
            census_after = _db_census(script, env, db)
            details["census"] = {"before": census_before, "after": census_after}
            if census_before and census_after["rows"] < census_before["rows"]:
                problems.append(f"the census shrank over the kill: {census_before} -> {census_after}")
            if not census_after["ready"]:
                problems.append("db-ready does not call the stand-in database ready after the kill")
        if with_bot:
            posts = tg_log.read_text().splitlines() if tg_log.exists() else []
            details["posts"] = posts
            if len(posts) != 2:
                problems.append(f"the stand-in bot got {len(posts)} posts, expected 2 (the fall and the return)")
        return problems, details
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if bot:
            bot.terminate()
        _stand_down()


def scenario_outage_live(tmp: Path) -> dict:
    """Outage drill, live (SMA: Outage drill): a real stand-in daemon is killed (hung, then SIGKILLed by the lift) and the fall, the lift,
    the return and both messages land — the messages on a stand-in bot (LP_WATCH_TG_API), never on telegram.org. The scenario refuses to
    drive any service but its own stand-in unit."""
    named = os.environ.get("LP_WATCH_SERVICE", "lp-drill-door")
    if named != "lp-drill-door":
        return {"name": "outage_live", "result": "skipped", "problems": [],
                "note": f"refuses to run a non-dry watchdog against {named}: only its own stand-in unit lp-drill-door may be killed"}
    if os.environ.get("LP_DRILL_WATCHDOG_LIVE") != "1":
        return {"name": "outage_live", "result": "skipped", "problems": [], "note": "the live pass writes a user unit and hangs a stand-in process: it runs only with LP_DRILL_WATCHDOG_LIVE=1"}
    problems, details = _watchdog_live(tmp, with_bot=True, census=False)
    return verdict("outage_live", problems, **details)
