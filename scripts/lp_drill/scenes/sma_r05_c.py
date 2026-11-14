"""Region 5 · Daemon life, batch c — the owner's call, the estimate report, the hub watchdog and the outage messages (n503 … n528).

Called from the region scene sma_r05.py (`prove_c(proofs, tmp)`); the receipt of that scene lists these nodes next to the other batches'. The probe sma_r05_c_probe.ts runs the REAL
code of the commit under drill — the owner's digest on a scratch database, the calibration, scripts/hub-watchdog.sh and scripts/lp-owner-push.sh against stand-in curl, systemctl and
sleep — and prints what it returned. Each prove() below compares one value with the result the node's card expects. The same observations are asserted by
tests/sma/four-proofs-r05-c.test.ts. n527 (the outage receipt) is traced by the hub database (lane_pilot_outage), not here.
"""
from __future__ import annotations

import json
import os
import subprocess

from lp_drill.env import ROOT

NODES_C = [f"n{n}" for n in (503, 504, 505, 506, 507, 508, 509, 510, 511, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521, 522, 523, 524, 525, 526, 528)]
PROBE_C = ROOT / "scripts/lp_drill/scenes/sma_r05_c_probe.ts"
FELL = "Хаб BB упал: сервер не отвечает 30 с (timeout, процесс 4242 висит). Поднимаю."
NOT_LIFTED = "Хаб BB не поднялся после 1 попыток. Причина: Job failed. See journalctl Нужен человек: ssh ubuntu@10.8.0.1, journalctl -u bb-server -n 100."


def prove_c(proofs, tmp) -> None:
    """Run the probe and prove batch c's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_C)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_C:
            proofs.prove(node, False, f"the batch c probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def p(node: str, name: str, check, detail) -> None:
        """prove() a node on one section; a missing or throwing section, or a check that cannot read it, is a failed proof with the reason."""
        data = s.get(name)
        if data in (None, {}, []) or (isinstance(data, dict) and "threw" in data):
            proofs.prove(node, False, f"section {name} did not run: {data}")
            return
        try:
            ok = bool(check(data))
        except (KeyError, IndexError, TypeError, AttributeError):
            ok = False
        proofs.prove(node, ok, detail(data))

    # n503 Four reasons to call: the digest names each row with its reason, the costliest first.
    p("n503", "m_sum_kinds", lambda d: d["reasons"] == ["decision", "blocked", "red", "term"] and [x.split("]")[0].split("[")[1] for x in d["lines"]] == ["красное", "стоит", "срок", "решение"], lambda d: f"reasons {d['reasons']}; digest rows {d['lines']}")
    # n504 One message: ten waiting rows are one digest with one header.
    p("n504", "m_sum_digest", lambda d: d["send"] is True and d["keys"] == ["a0", "a1", "a2", "a3", "a4"] and d["header"] == "Lane Pilot: ждут владельца, новых — 5." and len(d["rows"]) == 5, lambda d: f"{d['header']} {len(d['rows'])} rows, keys {d['keys']}")
    # n505 One wait, one message: after the acknowledgement the later ticks say nothing.
    p("n505", "m_sum_raise", lambda d: d["first"]["send"] is True and d["added"] == 1 and d["ticks"] == ["nothing_new"] * 5 and d["again"] == 0, lambda d: f"first {d['first']}; later ticks {d['ticks']}; second ack added {d['again']}")
    # n506 On-disk memory: a row with the time, no repeat before six hours, one repeat at six, never a third.
    p("n506", "m_sum_said", lambda d: len(d["rows"]) == 1 and d["soon"] == "nothing_new" and d["almost"] == "nothing_new" and d["repeat"]["keys"] == ["a#again"] and d["later"] == "nothing_new", lambda d: f"rows {d['rows']}; +1h {d['soon']}; +5h59 {d['almost']}; +6h {d['repeat']['keys']}; +30h {d['later']}")
    # n507 Closed work stays silent.
    p("n507", "m_sum_ghost", lambda d: d["after"] == ["backlog:open"] and d["closed"] is True and d["closedAgain"] is False and [x["by"] for x in d["by"]] == ["janitor:card is done", "janitor:batch cancelled", "screen"], lambda d: f"digest before {d['before']}, after {d['after']}; closed by {[x['by'] for x in d['by']]}")
    # n508 Retry after a failed send: five minutes.
    p("n508", "m_sum_repeat", lambda d: d["failed"]["status"] == 1 and d["at250"] == {"status": 0, "said": "waiting after a failed send (250s < 300s)", "sends": 1} and d["at350"]["sends"] == 2 and d["markerGone"] is True, lambda d: f"failed {d['failed']}; at 250 s {d['at250']}; at 350 s {d['at350']}")
    # n509 Estimate versus fact: per area and overall medians, a model's own history.
    p("n509", "m_sp_report", lambda d: d["overall"]["tasks"] == 5 and d["overall"]["tokensRatio"] == 2 and d["byArea"][0]["minutesRatio"] == 1.5 and d["byArea"][1]["tokensRatio"] is None and d["ofM1"]["overall"]["tasks"] == 2 and d["none"]["overall"] is None, lambda d: f"overall {d['overall']}; line: {d['line']}")
    # n510 Knock every 15 seconds; the database is never opened.
    p("n510", "m_w_knock", lambda d: d["sleeps"] == ["15"] * 4 and d["quick"] == ["7"] * 3 and d["sqliteCalls"] == "" and d["outageEvents"] == 1 and d["downSqlite"] == "", lambda d: f"sleeps {d['sleeps']}, with the setting {d['quick']}; database calls «{d['sqliteCalls']}»/«{d['downSqlite']}»")
    # n511 Door answers: the count resets.
    p("n511", "m_w_up", lambda d: d["cut"] == [] and d["straight"] == ["first_silence", "outage", "message_sent", "lift"], lambda d: f"7 silent + answer + 7 silent: {d['cut']}; 8 silent: {d['straight']}")
    # n512 Same process — false alarm; another one — risen.
    p("n512", "m_w_back", lambda d: d["same"]["tail"][3] == "false_alarm" and d["same"]["falseAlarmSaid"] == 1 and d["other"]["tail"][3] == "risen" and d["other"]["risenSaid"] == 1, lambda d: f"same process {d['same']['tail']}; another {d['other']['tail']}")
    # n513 No record — a stop.
    p("n513", "m_w_stopped", lambda d: d["zero"] == {"outage": False, "lifted": False} and d["empty"] == d["zero"] and d["recorded"] == {"outage": True, "lifted": True}, lambda d: f"MainPID 0 {d['zero']}, empty {d['empty']}, 4242 {d['recorded']}")
    # n514 Still loading — wait.
    p("n514", "m_w_starting", lambda d: d["activating"] == {"outage": False, "lifted": False} and d["reloading"] == d["activating"] and d["active"] == {"outage": True, "lifted": True}, lambda d: f"activating {d['activating']}, reloading {d['reloading']}, active {d['active']}")
    # n515 Suspect: silence in a row.
    p("n515", "m_w_suspect", lambda d: d == {"defaults": "3 8", "sevenTimeouts": False, "eightTimeouts": True, "sevenThenAnswer": False, "eightRefused": True, "threeRefusedAfterAnswer": True, "beforeTheThird": False, "threeRefusedNeverAnswered": False, "fourSetting": False, "fourSettingFifth": True}, lambda d: f"declared at 8 silent {d.get('eightTimeouts')}, at 7 {d.get('sevenTimeouts')}; refused: at 3 after an answer {d.get('threeRefusedAfterAnswer')}, at 2 {d.get('beforeTheThird')}")
    # n516 Outage declared with the fall time of the first silence.
    p("n516", "m_w_declared", lambda d: d["order"] == ["start", "first_silence", "outage", "message_sent"] and d["gapIsThreeKnocks"] is True and d["outage"] == "timeout: no answer for 45s from pid 4242 (active)", lambda d: f"{d['order']}; first silence three knocks (45 s) before the declaration {d['gapIsThreeKnocks']}; «{d['outage']}»")
    # n517 Kill the hung one first.
    p("n517", "m_w_kill", lambda d: d["manager"] == ["--user kill -s SIGKILL bb-server", "--user restart bb-server"] and d["rows"] == ["try 1, killing pid 4242"], lambda d: f"manager commands in order {d['manager']}; record {d['rows']}")
    # n518 The lift is the restart's command.
    p("n518", "m_w_lift", lambda d: d["command"] == "systemctl --user restart bb-server" and d["issued"] == ["--user restart bb-server"], lambda d: f"lift_cmd «{d['command']}»; issued {d['issued']}")
    # n519 The door names the outcome.
    p("n519", "m_w_pending", lambda d: d["answered"] == [["lift", "try 1, killing pid 4242"]] and d["silent"][1] == ["lift_without_outcome", "try 1, waited 30s"], lambda d: f"door answers {d['answered']}; door silent {d['silent']}")
    # n520 Backoff counted from the log: the wait doubles — proved by the parity test (30, 60, 120 s from the log); the scene reads the script's own function.
    seq = subprocess.run(["bash", "-c", f"source <(sed '/^case /,$d' {ROOT / 'scripts/hub-watchdog.sh'}); d=$(mktemp -d); LOG=$d/o.jsonl; "
                          "for n in 1 2 3 4; do backoff_sec | cut -d' ' -f1; printf '{\"at\":%s,\"event\":\"lift\",\"detail\":\"x\"}\\n' $(date +%s) >> $LOG; done; rm -rf $d"], capture_output=True, text=True, cwd=ROOT)
    waits = seq.stdout.split()
    proofs.prove("n520", waits == ["30", "60", "120", "120"], f"waits after 0, 1, 2, 3 lifts on record: {waits}")
    # n521 A repeated lift kills a port holder: default on.
    dflt = subprocess.run(["bash", "-c", f"source <(sed '/^case /,$d' {ROOT / 'scripts/hub-watchdog.sh'}); echo \"$KILL_HOLDER\""], capture_output=True, text=True, cwd=ROOT, env={**{k: v for k, v in os.environ.items() if k != "LP_WATCH_KILL_HOLDER"}, "LP_WATCH_STATE": str(tmp)}).stdout.strip()
    proofs.prove("n521", dflt == "1", f"holder kill default on a repeated lift: {dflt}")
    # n522 Out of tries — to the person.
    p("n522", "m_w_abandoned", lambda d: d["outOfTries"] == ["1 lifts without an answer: Job failed. See journalctl"] and d["said"] == [NOT_LIFTED] and d["longSleeps"] == 1 and d["marker"] is True, lambda d: f"record {d['outOfTries']}; said {d['said']}; 600 s sleeps {d['longSleeps']}")
    # n523 Outage record with times.
    p("n523", "m_out_marker", lambda d: [r[0] for r in d["rows"]] == ["start", "first_silence", "outage", "lift", "lift_without_outcome", "out_of_tries"] and d["gap"] is True and d["ordered"] is True, lambda d: f"record {[r[0] for r in d['rows']]}; first silence two knocks before {d['gap']}; times in order {d['ordered']}")
    # n524 Message «it fell».
    p("n524", "m_out_fall_msg", lambda d: d == [FELL], lambda d: f"said {d}")
    # n525 Second message: lift failed, with the reason, once.
    p("n525", "m_out_lift_failed", lambda d: d["said"] == [NOT_LIFTED] and d["fellSaid"] == 1 and d["events"] == 1, lambda d: f"said {d['said']}")
    # n526 The risen one speaks after the door answers.
    p("n526", "m_out_announce", lambda d: d["risen"] == [FELL, "Хаб BB поднялся: не отвечал около 1 мин."] and d["whileSilent"] == [] and d["healthy"] == [], lambda d: f"after an answer {d['risen'][1:]}; while silent {d['whileSilent']}; healthy door {d['healthy']}")
    # n528 Tell the owner in Telegram: no bot or no pairing — no send, a named reason.
    def notify_ok(d) -> bool:
        base = d["noEnvPath"].rsplit("/no-telegram", 1)[0]
        rows = [(r["case"], r["event"], r["detail"].replace(base, "<dir>"), r["sends"]) for r in d["out"]]
        return rows == [("no file", "message_not_sent", "no tg.env at <dir>/no-telegram", 0), ("no token", "message_not_sent", "TG_TOKEN empty in <dir>/tg.env", 0),
                        ("no chat", "message_not_sent", "TG_CHAT empty in <dir>/tg.env", 0), ("refused", "message_not_sent", "telegram refused (curl 22)", 1), ("sent", "message_sent", "hello", 2)]
    p("n528", "m_out_notify", notify_ok, lambda d: f"{[(r['case'], r['event'], r['sends']) for r in d['out']]}")
