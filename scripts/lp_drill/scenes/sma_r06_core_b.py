"""Region 6 · Chat front, batch core-server-b: the nodes whose code is the thread record in bb-core, read through the `bb` CLI from the sandbox project.

Read-only: `bb thread list --project <sandbox>` and `bb thread log <id> --json` (sma_core_b_hub.py). No message is sent, no thread is created, nothing is
written. n546 (the «changed» frame to a subscribed window: a websocket client), n572 (a /compact turn: a live provider turn), n573 (a message starts a
provider turn: a live provider turn) are not proved here: see NOT_PROVED_CORE_B.
"""
from __future__ import annotations

from lp_drill.prove import Proofs
from lp_drill.scenes.sma_core_b_hub import REQUEST_TYPES, sandbox_threads

NODES_CORE_B = ["n529", "n549"]
NOT_PROVED_CORE_B = {
    "n546": "the frame is pushed to a subscribed websocket client; the CLI and plugin RPC do not subscribe",
    "n572": "a /compact turn is a live provider turn on a thread (the refusals need a busy or non-compacting thread)",
    "n573": "the direct submit is a live provider turn on a thread",
}


def prove_core_b(proofs: Proofs, tmp) -> None:
    threads, why = sandbox_threads()
    # n529 Each turn is appended as one line (core: one stored event per append): the sandbox threads' event logs run in strictly increasing sequence, each event with its type and data.
    logged = [t for t in threads if len(t["events"]) >= 2]
    if logged:
        t = logged[0]
        seqs = [e.get("seq") for e in t["events"]]
        ok = all(isinstance(s, int) for s in seqs) and all(b > a for a, b in zip(seqs, seqs[1:])) and all(e.get("type") and e.get("data") is not None for e in t["events"])
        detail = f"thread {t['id']}: {len(seqs)} events, seq {seqs[0]}..{seqs[-1]}, strictly increasing {ok}"
    else:
        ok, detail = False, f"no sandbox thread with two events to read ({why or 'the logs are empty'})"
    proofs.prove("n529", ok, detail)

    # n549 The turn is stored before the answer: a thread's request event (the text the owner sent) has a lower sequence than its first started turn.
    for t in threads:
        requests = [e for e in t["events"] if e.get("type") in REQUEST_TYPES]
        started = [e for e in t["events"] if e.get("type") == "turn/started"]
        if requests and started:
            first_request, first_started = requests[0], started[0]
            stored = "input" in (first_request.get("data") or {})
            ok = isinstance(first_request.get("seq"), int) and first_request["seq"] < first_started["seq"] and stored
            proofs.prove("n549", ok, f"thread {t['id']}: request seq {first_request.get('seq')} ({first_request.get('type')}) before the turn started at seq {first_started.get('seq')}; input stored {stored}")
            return
    proofs.prove("n549", False, f"no sandbox thread whose first events hold a request and a started turn ({why or 'looked at ' + str(len(threads)) + ' threads'})")
