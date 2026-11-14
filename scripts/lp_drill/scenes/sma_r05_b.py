"""Region 5 · Daemon life, batch b — stop and journal, settings, the stop/restart commands, the phase memory, the webhook and the owner's call (n472 … n502).

Called from the region scene sma_r05.py (`prove_b(proofs, tmp)`); the receipt of that scene lists these nodes next to batch a's. The probe sma_r05_b_probe.ts runs the REAL
code of the commit under drill — the schedule abort, the settings store on a scratch database, the door script and hub-watchdog.sh against stand-in tools, the permit sweep,
the phase driver, the webhook with a stand-in fetch, the digest — with no model, no hub write and nothing outside the machine, and prints what it returned. Each prove()
below compares one value with the result the node's card expects. The same observations are asserted by tests/sma/four-proofs-r05-b.test.ts.
n480 (conveyor off from the factory) is not proved: the conveyor starts on (src/rooms/sma-map/gaps.ts); n485 is void.
"""
from __future__ import annotations

import json
import re
import subprocess

from lp_drill.env import ROOT

NODES_B = [
    "n472", "n473", "n474", "n475", "n476", "n477", "n478", "n479", "n481", "n482", "n483", "n484", "n486", "n487", "n488", "n489", "n490", "n491", "n492",
    "n493", "n494", "n495", "n496", "n497", "n498", "n499", "n500", "n501", "n502",
]
PROBE_B = ROOT / "scripts/lp_drill/scenes/sma_r05_b_probe.ts"
UNPROVEN = "door answers, process unproven: port 38886 is held by pid <pid>, outside bb-server (pid 4242); nothing was touched (--force goes on)"
RULES = lambda port: [f"-I INPUT 1 -p tcp --dport {port} -i lo -j ACCEPT", f"-I INPUT 2 -p tcp --dport {port} -i wg0 -j ACCEPT",
                      f"-I INPUT 3 -p tcp --dport {port} -s 172.16.0.0/12 -j ACCEPT", f"-I INPUT 4 -p tcp --dport {port} -j DROP"]


def prove_b(proofs, tmp) -> None:
    """Run the probe and prove batch b's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_B)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_B:
            proofs.prove(node, False, f"the batch b probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str):
        value = s.get(name)
        return {} if not isinstance(value, (dict, list)) or (isinstance(value, dict) and "threw" in value) else value

    def p(node: str, name: str, check, detail) -> None:
        """prove() a node on one section; a missing or throwing section, or a check that cannot read it, is a failed proof with the reason."""
        data = seen(name)
        if not data:
            proofs.prove(node, False, f"section {name} did not run: {s.get(name)}")
            return
        try:
            ok = bool(check(data))
        except (KeyError, IndexError, TypeError, AttributeError):
            ok = False
        proofs.prove(node, ok, detail(data))

    # n472 Stop does not await the pass: the stop frees the slot with the core's reason while the abandoned work finishes by itself.
    p("n472", "m_no_wait_stop", lambda d: d == {"settled": "time limit 60000 ms", "finishedWhenFreed": False, "workResult": "late", "workFinished": True, "alreadyAborted": "stopped by a reload"}, lambda d: f"slot freed with «{d.get('settled')}» before the work ended ({d.get('finishedWhenFreed')}); the work finished later {d.get('workFinished')}")
    # n473 Daemon journal line: one line at warn per event.
    p("n473", "m_dj_journal", lambda d: d["entries"] == ["warn: tick: sweep ran, door: version asked"], lambda d: f"log lines {d.get('entries')}")
    # n474 Unknown code register: counted by text without digits, newest time, most frequent first; known and blank ones left out.
    p("n474", "m_unknown_codes", lambda d: d == [{"reason": "strange fault at slot 12", "count": 2, "lastAt": 300}, {"reason": "odd one", "count": 1, "lastAt": 200}], lambda d: f"register {d}")
    # n475 Permit channel opened: a minute schedule; the ticket goes once to the PM of the run.
    p("n475", "m_action_channel", lambda d: d["registered"] == [{"name": "permit-sweep", "cron": "* * * * *"}] and len(d["first"]) == 1 and d["first"][0].startswith("pm-a: [Lane Pilot permit] The writer of task-a asks permission (delete_for_good): `rm data.csv`.") and d["afterSecondSweep"] == 1, lambda d: f"schedule {d.get('registered')}; sent {d.get('first')}; after a second sweep {d.get('afterSecondSweep')}")
    # n476 Load and validate settings: a bad value and an impossible writer pair are named; a good object is clean.
    p("n476", "m_cfg_load", lambda d: d["clean"] == [] and d["broken"] == ["invalid_choice:run.max_tokens", "incompatible_setting:writer.reasoning_effort"], lambda d: f"clean {d.get('clean')}; broken {d.get('broken')}")
    # n477 Daemon settings file: the settings are rows of the hub database.
    p("n477", "m_cfg_path", lambda d: d["saved"] == {"ok": True, "version": 1} and d["row"] == [{"key": "run.max_tokens", "value": "40", "version": 1}] and d["loaded"] == {"run.max_tokens": 40}, lambda d: f"saved {d.get('saved')}; row {d.get('row')}; read back {d.get('loaded')}")
    # n478 Default pool: every role gets its table default with no setting.
    p("n478", "m_cfg_default", lambda d: d["roles"] == 40 and d["allDefault"] is True and d["analyst"] == "claude-code/claude-opus-5-5/high" and d["pmReader"] == "claude-code/claude-haiku-5-5/low", lambda d: f"{d.get('roles')} roles, all default {d.get('allDefault')}; analyst {d.get('analyst')}, pm-reader {d.get('pmReader')}")
    # n479 Door on this machine only: loopback, WireGuard and docker bridges accepted, everyone else dropped.
    p("n479", "m_cfg_bind", lambda d: d == {"standard": {"exit": 0, "laid": RULES("38886"), "removed": 4}, "other": {"exit": 0, "laid": RULES("4000"), "removed": 4}}, lambda d: f"rules laid for the standard port {d.get('standard', {}).get('laid')}")
    # n481 Paid lane has no money: the unset cap is zero for a paid lane; a subscription lane goes on.
    p("n481", "m_cfg_budget0", lambda d: d["cap"] == 0 and d["paid"].startswith("no money cap is set: openlux is a paid lane and stays closed") and d["subscription"] is None and d["lifted"] == [None, None], lambda d: f"cap {d.get('cap')}; paid lane: «{str(d.get('paid'))[:60]}…»; subscription lane {d.get('subscription')}")
    # n482 Write by named fields: a stale copy is refused with the stored value; the other key is untouched.
    p("n482", "m_cfg_write", lambda d: d["stale"] == {"ok": False, "conflict": True, "version": 2, "value": 55} and d["stored"] == {"run.max_tokens": 55, "run.max_turns": 90}, lambda d: f"stale save {d.get('stale')}; stored {d.get('stored')}")
    # n483 Secrets out as «set»: a name and a kind, never the value.
    p("n483", "m_cfg_secrets_view", lambda d: d["list"] == [{"name": "API_KEY", "kind": "secret"}, {"name": "SITE", "kind": "login"}] and d["leakedInResults"] == [] and d["logLeaked"] is False and d["logLine"] == "deploy failed with *** in the url", lambda d: f"list {d.get('list')}; leaked {d.get('leakedInResults')}; log «{d.get('logLine')}»")
    # n484 Restart-only settings: the ceiling is frozen into the run at its creation.
    p("n484", "m_restart_scoped", lambda d: d == {"first": 5, "second": 100, "old": None, "stored": 100}, lambda d: f"run created before the change keeps {d.get('first')}, the next gets {d.get('second')}, an old policy {d.get('old')}")
    # n486 Turn ceiling: the named default applies without a key; 0/off none; a number as given; junk refused.
    p("n486", "m_cfg_max_turns", lambda d: d["unset"]["ceiling"] == 300 and d["zero"]["ceiling"] is None and d["given"]["ceiling"] == 25 and d["over"]["invalid"] is True and d["policy"] == 300, lambda d: f"unset {d.get('unset')}, 0 {d.get('zero')}, 25 {d.get('given')}, 501 {d.get('over')}")
    # n487 Stop and restart command: the manager's stop and the manager's own restart.
    p("n487", "m_ctl_cmd", lambda d: d["stop"] == {"status": 0, "first": "stopped: bb-server is inactive", "calls": ["--user stop --no-block bb-server"]} and d["restart"]["status"] == 0 and d["restart"]["calls"] == ["--user restart bb-server"], lambda d: f"stop {d.get('stop')}; restart calls {d.get('restart', {}).get('calls')}")
    # n488 Process by record and door: MainPID of the manager and the configured door address, never a program name.
    p("n488", "m_ctl_identify", lambda d: d == {"pid": "4242", "port": "38886", "other": "4555", "noPort": "443", "status": "ok: bb-server active, pid 4242, up <n>s, the door answers"}, lambda d: f"pid {d.get('pid')}, door port {d.get('port')}/{d.get('other')}/{d.get('noPort')}; status «{d.get('status')}»")
    # n489 Knock on the door: the board request names ok, auth, unknown or none.
    p("n489", "m_ctl_probe", lambda d: d == {"ok": "ok", "auth": "auth", "notList": "unknown", "noise": "unknown", "none": "none"}, lambda d: f"board request answers {d}")
    # n490 Not running — calm success: exit 0, one stopped line, no kill, again the same.
    p("n490", "m_ctl_not_running", lambda d: d["first"] == {"status": 0, "line": "stopped: bb-server is inactive"} and d["second"] == d["first"] and d["killed"] is False and d["hardRecorded"] is False, lambda d: f"stop of a stopped service {d.get('first')}, again {d.get('second')}, killed {d.get('killed')}")
    # n491 Door answers, process unproven: a refusal for status, stop and restart; nothing touched; --force goes on.
    p("n491", "m_ctl_unnamed", lambda d: all(d["out"][v] == {"status": 2, "line": UNPROVEN} for v in ("status", "stop", "restart")) and d["touched"] is False and d["holderAlive"] is True and "--force given, going on" in d["forced"] and d["stoppedAfterForce"] is True, lambda d: f"refusals {[(v, d['out'][v]['status']) for v in d['out']]}; nothing touched {not d.get('touched')}; other process alive {d.get('holderAlive')}")
    # n492 Live work holds the stop: the refusal lists the workers; nothing is issued until --force.
    p("n492", "m_ctl_live_work", lambda d: d["refused"] == {"status": 2, "lines": ["refused: live work holds the stop (--force would stop anyway):", "att1 task1 thr1", "att2 task2 -"]} and d["issuedWhileRefused"] == [] and d["forced"] == {"status": 0, "issued": True} and d["recorded"] == ["stop_refused", "stop_forced", "stop_unknown_live_work"], lambda d: f"refused {d.get('refused')}; issued while refused {d.get('issuedWhileRefused')}; forced {d.get('forced')}")
    # n493 Stopped hard: killed after the wait, said so, recorded.
    p("n493", "m_ctl_killed", lambda d: d == {"status": 0, "line": "stopped hard: the process did not leave in 3s and was killed", "calls": ["--user stop --no-block bb-server", "--user kill -s SIGKILL bb-server"], "waited": 3, "recorded": True}, lambda d: f"«{d.get('line')}»; calls {d.get('calls')}; waited {d.get('waited')}s")
    # n494 Restart waits for the door: says how long, or that the door did not answer (exit 1).
    p("n494", "m_ctl_restart", lambda d: d["answered"]["status"] == 0 and re.fullmatch(r"ok: the door answers after \d+s", d["answered"]["last"]) is not None and d["silent"] == {"status": 1, "last": "down: the door did not answer in 30s"}, lambda d: f"door answers: «{d.get('answered', {}).get('last')}»; silent door: {d.get('silent')}")
    # n495 Lift command per platform.
    p("n495", "m_ctl_lift_cmd", lambda d: d == {"mac": "launchctl kickstart -k gui/<uid>/svc", "sudo": "sudo -n systemctl restart bb-server", "user": "systemctl --user restart bb-server"}, lambda d: f"lift commands {d}")
    # n496 Exit codes 0, 1, 2.
    p("n496", "m_ctl_exit", lambda d: d == {"answers": 0, "down": 1, "liveWork": 2, "forcedLiveWork": 0, "foreignDoor": 2, "foreignForced": 0}, lambda d: f"exit codes {d}")
    # n497 Aging said once a day.
    p("n497", "m_aging_mem", lambda d: d == {"fresh": [], "firstDay": ["no movement for 4 day(s) at discussion"], "sameDay": ["no movement for 4 day(s) at discussion"], "nextDay": ["no movement for 4 day(s) at discussion", "no movement for 5 day(s) at discussion"]}, lambda d: f"notes after a day {d.get('firstDay')}, an hour later {d.get('sameDay')}, the next day {d.get('nextDay')}")
    # n498 A standing wave named once.
    p("n498", "m_wave_wait_mem", lambda d: d == {"first": ["wave 1:"], "afterThree": ["wave 1:"], "issued": ["p1"]}, lambda d: f"wave table booked {d.get('first')}, after three passes {d.get('afterThree')}")
    # n499 Task event webhook: one post per state, the answer never read.
    p("n499", "m_report", lambda d: [(x["event"], x["method"], x["url"]) for x in d["posts"]] == [("task.blocked", "POST", "https://hooks.example.test/lp"), ("task.accepted", "POST", "https://hooks.example.test/lp")] and d["answerRead"] is False, lambda d: f"posts {[x['event'] for x in d.get('posts', [])]}; answer read {d.get('answerRead')}")
    # n500 Nine allowed fields.
    p("n500", "m_report_keys", lambda d: d == {"keys": ["event", "projectId", "runId", "taskId", "title", "kind", "state", "attempt", "at"], "titleLength": 200, "leaked": [], "attempt": 1, "kind": "bb"}, lambda d: f"body keys {d.get('keys')}; title clipped to {d.get('titleLength')}; leaked {d.get('leaked')}")
    # n501 No address — silence.
    p("n501", "m_report_off", lambda d: d == {"noAddress": 0, "blank": 0, "http": 0}, lambda d: f"posts with no address {d.get('noAddress')}, blank {d.get('blank')}, http {d.get('http')}")
    # n502 Calling the person in Telegram: the digest follows the live settings at every call.
    p("n502", "m_sum_build", lambda d: d["on"]["send"] is True and d["off"] == {"send": False, "reason": "disabled"} and d["back"]["send"] is True and d["after"] == {"send": False, "reason": "nothing_new"}, lambda d: f"digest on {d.get('on', {}).get('send')}; switched off {d.get('off')}; on again {d.get('back', {}).get('send')}; after it went out {d.get('after')}")
