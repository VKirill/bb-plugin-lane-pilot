"""Region 7 · Providers, models, accounts, batch c (n657 .. n672) — proofs of the region scene sma_r07 (docs/sma-evidence.md, «Trace choice»).

Model-free, provider-free, money-free and hub-free. The probe (sma_r07_c_probe.ts, run by tsx) runs the REAL code of the commit under drill on stand-ins — the
design measuring script on a fake page, the writer's launch and brief on a fake plugin host, the Claude launcher script run by sh, the fence, the frame summary,
the writer chain's park on a scratch database, the usage hold, the rate-limit watch on a fake kv, the person's window file in a scratch folder — and prints one JSON
line; this module prove()s each node with the value it observed against the node card's expected result.
n660 (Codex launch arguments) is not here: the sandbox and the approval policy are bb-core's. n599 stays with batch a.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_C = ["n657", "n658", "n659", "n661", "n662", "n663", "n664", "n665", "n666", "n667", "n668", "n669", "n670", "n671", "n672"]
PROBE_C = ROOT / "scripts/lp_drill/scenes/sma_r07_c_probe.ts"


def _iso(hours: int) -> str:
    """The probe's `iso(hours)`: the fixed clock of the probe plus hours, as the ISO string JS prints."""
    from datetime import datetime, timedelta, timezone
    base = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc) + timedelta(hours=hours)
    return base.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def prove_c(proofs: Proofs, tmp) -> None:
    done = subprocess.run(["npx", "tsx", str(PROBE_C)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_C:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def prove(node: str, section: str, check, detail) -> None:
        data = seen.get(section)
        if not isinstance(data, (dict, list)) or (isinstance(data, dict) and "threw" in data):
            proofs.prove(node, False, f"section {section} did not run: {data.get('threw') if isinstance(data, dict) else 'missing'}")
            return
        try:
            ok = bool(check(data))
        except (KeyError, IndexError, TypeError):
            ok = False
        proofs.prove(node, ok, detail(data))

    # n657 Clean design judge input: the page is measured into a fixed list of fields; an author name or a self-score on the page changes nothing.
    prove("n657", "judge", lambda d: d["keys"] == ["h1", "lowContrast", "overflowPx", "smallTargets", "spacingValues", "targets", "textElements", "tinyText", "width"]
          and d["sameForOtherAuthor"] is True and d["seen"]["smallTargets"] == 2 and d["seen"]["overflowPx"] == 110,
          lambda d: f"fields {d['keys']}, the same for another author {d['sameForOtherAuthor']}, small targets {d['seen']['smallTargets']}, overflow {d['seen']['overflowPx']}px")
    # n658 Launch spec assembly: worker, model, effort, tier, the PM it hangs under, the run, task and attempt it belongs to, the brief's header.
    prove("n658", "launchSpec", lambda d: d["launch"] == {"providerId": "codex", "model": "codex-test", "reasoningLevel": "medium", "serviceTier": "default", "projectId": "P", "parentThreadId": "pm-thread"}
          and d["meta"]["role"] == "writer" and d["meta"]["parentPmThreadId"] == "pm-thread" and d["meta"]["lanePilotTaskId"] == "t1" and d["meta"]["attemptId"] == "a1" and d["header"] == "Lane Pilot task t1: Write the bot",
          lambda d: f"launch {d['launch']}, metadata role {d['meta']['role']} parent {d['meta']['parentPmThreadId']} task {d['meta']['lanePilotTaskId']} attempt {d['meta']['attemptId']}, header «{d['header']}»")
    # n659 Claude launch arguments: the writer's launcher denies the helper and writer tools and carries the turn ceiling (7.9 -> 7); a critic only the helper tools and no ceiling; a PM none.
    prove("n659", "launcher", lambda d: d["writerDenied"].startswith("Workflow,ScheduleWakeup,AskUserQuestion,Agent,Bash(git push:*)") and d["writerTurns"] == "7" and d["writerKeepsCallerArgs"] == "hi"
          and d["criticDenied"] == "Workflow,ScheduleWakeup,AskUserQuestion,Agent" and d["criticTurns"] is False and d["pmDenied"] is False,
          lambda d: f"writer denies «{d['writerDenied'][:60]}…» turns {d['writerTurns']}, critic denies «{d['criticDenied']}» ceiling {d['criticTurns']}, PM denies {d['pmDenied']}")
    # n661 One argument per tool: a refusal with a space inside is one element of the argv array and one argument through the launcher's shell line.
    prove("n661", "toolFlags", lambda d: d["argv"] == ["exec", "--disallowedTools", d["entry"], "--json"] and "[a b]" in d["lines"] and any(line.startswith("[Workflow,") and "Bash(git push:*)" in line for line in d["lines"]),
          lambda d: f"argv {d['argv']}, the CLI received {len(d['lines'])} arguments, «a b» whole {'[a b]' in d['lines']}")
    # n662 Foreign text in a fence: one closing tag of the fence's own, every spelling the text brought broken, the source cut to 120.
    prove("n662", "fence", lambda d: d["head"][0] == '<outside_data source="mail from evilname">' and d["closers"] == 1 and d["broken"] == 3 and d["tail"] is True and d["cutSource"] == '<outside_data source="' + "x" * 120 + '">',
          lambda d: f"opening «{d['head'][0]}», closing tags {d['closers']}, broken spellings {d['broken']}, long source cut to {d['cutSource'].count('x')} characters")
    # n663 Task prompt: the contract is in the chat, the instructions, the earlier attempt, the read-first files, the memory and the rules are hidden parts; nothing is invented.
    prove("n663", "brief", lambda d: d["visible"] == [True, True, True, True] and d["memoryInChat"] is False and d["role"] and d["previous"] and d["readFirst"] and d["memory"] and d["rules"] and d["bareHas"] == [],
          lambda d: f"contract lines in the chat {d['visible']}, memory in the chat {d['memoryInChat']}, hidden: attempt {d['previous']}, files {d['readFirst']}, memory {d['memory']}, rules {d['rules']}; a bare task carries {d['bareHas']}")
    # n664 A stream frame in words: the tools the session used with counts, what changed, what failed.
    prove("n664", "frames", lambda d: d == ["Did: shell git status; shell npm test; edit src/a.ts", "Failed: npm test (exit 1)", "Check: npm test", "Files: src/a.ts", "Tools: shell x2, gitnexus/impact x2, edit x1"],
          lambda d: f"digest {d}")
    # n665 Nobody to launch: every member held -> the attempt waits (queued, waiting_writer, wake time); only unsupported providers -> blocked; a free member -> nothing parked.
    prove("n665", "noWorker", lambda d: d["parked"] is True and d["row"] == ["queued", "waiting_writer:" + d["parkedReason"]] and d["wake"] == d["wakeAt"] and d["free"] is False and d["freeLast"] is None
          and d["blocked"] is True and d["blockedRow"] == ["blocked", d["blockedReason"]],
          lambda d: f"all held: attempt {d['row']} wakes at {d['wake']}; free member parks {d['free']}; only unsupported: attempt {d['blockedRow']}")
    # n666 Turns exhausted: five feedback turns by default, one to ten when set, a bad value is the default.
    prove("n666", "turnCap", lambda d: d["default"] == 5 and d["fallbacks"] == [5] * 9 and d["set"] == [1, 3, 7, 7, 10, 10, 10],
          lambda d: f"default {d['default']}, bad values give {sorted(set(d['fallbacks']))}, set values give {d['set']}")
    # n667 Subscription window: open? — open null, exhausted with the worst window's percentage, unknown never a hold.
    prove("n667", "windowState", lambda d: d["open"] is None and d["exhausted"]["percent"] == 97 and d["exhausted"]["window"] == "7d" and d["unknown"] == [None] * 4 and d["oneUnreadable"] is None
          and d["zcodeReason"] == "writer_provider_unavailable:usage_window:zcode/glm-5.3: outside free hours",
          lambda d: f"open {d['open']}, exhausted {d['exhausted']}, unknown measurements {d['unknown']}, one unreadable {d['oneUnreadable']}")
    # n668 Read a rate-limit frame: the frame of a session's stream is recorded per provider; another kind and a repeat write nothing.
    prove("n668", "reading", lambda d: d["stored"]["status"] == "blocked" and d["stored"]["windows"][0]["resetsAtMs"] == d["reset"] and d["keys"] == ["rate-limit-windows:claude-code", "rate-limit-windows:codex"]
          and d["repeat"] == 0 and d["changed"] == 1 and d["board"]["5h"]["utilization"] == 100 and d["board"]["7d"]["utilization"] == 90,
          lambda d: f"stored {d['stored']['status']} {d['stored']['windows'][0]}, records {d['keys']}, repeat writes {d['repeat']}, changed writes {d['changed']}")
    # n669 Window closed until reset: the last reset of the spent windows, a window that reset is not spent, a stored limit event answers for six hours.
    prove("n669", "windowClosed", lambda d: d["lastReset"] == _iso(50) and d["alreadyReset"] is None and d["unknownReset"] is None and d["earliestResource"] == _iso(3)
          and d["eventFiveHours"] == {"percent": 100, "window": "5h", "resetsAt": _iso(40)} and d["eventSevenHours"] is None and d["eventPastReset"] is None,
          lambda d: f"closed until {d['lastReset']}, earliest of two accounts {d['earliestResource']}, event 5 h old {d['eventFiveHours']}, event 7 h old {d['eventSevenHours']}")
    # n670 The person's terminal window: the machine's own file read as percent and reset; no file is nothing.
    prove("n670", "terminal", lambda d: d["none"] == {"hostId": "mini", "at": None, "windows": {}} and d["read"]["at"] == "2026-11-14T11:59:00Z"
          and d["read"]["windows"] == {"five_hour": {"utilization": 41.5, "resetsAt": "2026-11-14T15:00:00Z"}, "seven_day": {"utilization": 12, "resetsAt": None}},
          lambda d: f"no file {d['none']}, file read {d['read']}")
    # n671 Five hours and seven days: the two windows under the board's names, the fullest figure, nothing read is at:null.
    prove("n671", "two", lambda d: d["board"]["windows"] == {"five_hour": {"utilization": 55, "resetsAt": _iso(2)}, "seven_day": {"utilization": 60, "resetsAt": _iso(100)}, "seven_day_opus": {"utilization": 20, "resetsAt": _iso(100)}}
          and d["unread"] == {"at": None, "windows": {}},
          lambda d: f"board {d['board']['windows']}, nothing read {d['unread']}")
    # n672 Open right now: a window at the threshold holds, below it is open, 0 turns the check off, the account's source is asked.
    prove("n672", "windowOpen", lambda d: d["below"] is None and d["atThreshold"]["percent"] == 90 and d["checkOff"] is None and d["lowered"]["percent"] == 50 and d["skip"] == [90, 90, 90, 75, 0, 90, 90]
          and d["spent"]["percent"] == 95 and d["askedSources"] is True and d["off"] is None and d["offCalls"] == [] and d["unspent"] is None,
          lambda d: f"89.9% -> {d['below']}, 90% -> {d['atThreshold']}, check off -> {d['checkOff']}, thresholds {d['skip']}, account source asked {d['askedSources']}, off asks {d['offCalls']}")
