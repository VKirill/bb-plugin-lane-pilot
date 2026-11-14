"""Region 14 · Memory, batch a (n1048 .. n1077): the nodes whose effect is not a hub row of their own.

Memory lives only on the hub (rows of lane_pilot_memory and its indexes; no memory file in a project): the probe writes into a scratch database with the
REAL memory door, lint, tiers and learning sweep of the commit under drill (no model, no hub write) and reads the rows back. Per node, proofs.prove(node, ok,
detail) with the observed value. Run: scripts/lp-drill.sh --scenario sma_r14.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1050", "n1052", "n1053", "n1054", "n1057", "n1058", "n1062", "n1063", "n1065", "n1066", "n1068", "n1069", "n1070", "n1071", "n1072", "n1073",
         "n1074", "n1075", "n1076"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r14_probe.ts"


def scenario_sma_r14(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=300)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r14", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n1050 A draft is moved, never over an existing one: the next free name each time.
    proofs.prove("n1050", seen["imports"]["drafts"] == ["a.md", "a-2.md", "a-3.md"], f"draft names {seen['imports']['drafts']}")
    # n1052 Secret redaction: a credential and an instruction override refuse the bytes; prose naming a variable stores; nothing reaches the corpus.
    red = seen["redact"]
    proofs.prove("n1052", "credential" in red["issue"] and red["secret"] and red["override"] and red["prose"] and red["rowsAfterRefusal"] == 0,
                 f"issue «{red['issue']}», secret refused {red['secret']}, override refused {red['override']}, prose stored {red['prose']}, rows after refusal {red['rowsAfterRefusal']}")
    # n1053 One claim: three list lines are refused, two are not.
    claim = seen["claim"]
    proofs.prove("n1053", bool(claim["three"]) and claim["two"] is None, f"three list lines: {claim['three']!r}; two: {claim['two']!r}")
    # n1054 Compare with the corpus: the twin replaces the older note, a different fact with the same tags stays.
    cmp_ = seen["compare"]
    proofs.prove("n1054", cmp_["olderStatus"] == "superseded" and cmp_["supersededBy"] and cmp_["otherStatus"] == "active", f"older {cmp_['olderStatus']} (by the twin {cmp_['supersededBy']}), other {cmp_['otherStatus']}")
    # n1057 Draft awaits a person: with the owner's word required the waiting item is untouched and the other project's is settled.
    lrn = seen["learning"]
    proofs.prove("n1057", lrn["accepted"] == ["free"] and lrn["heldState"] == "pending_owner", f"accepted {lrn['accepted']}, the held item is {lrn['heldState']}")
    # n1058 Refused by the pipeline: the refusal carries the check's own words.
    proofs.prove("n1058", "credential" in seen["rejected"]["parsedRefusal"], f"refusal «{seen['rejected']['parsedRefusal']}»")
    # n1062 Index rebuilt: one write gave both indexes a row per active note.
    idx = seen["indexLifecycle"]
    proofs.prove("n1062", idx["fts"] == idx["active"] == 2 and idx["trgm"] == 2, f"active {idx['active']}, word index {idx['fts']}, trigram index {idx['trgm']}")
    # n1063 Record lifecycle: an owner tombstone is not revived by a restatement, an idle one comes back.
    proofs.prove("n1063", idx["ownerTombstone"] == {"status": "expired", "reason": "owner"} and idx["restatedOwner"] == 0 and idx["restatedIdle"] == 1,
                 f"owner tombstone {idx['ownerTombstone']}, restated owner {idx['restatedOwner']}, restated idle {idx['restatedIdle']}")
    # n1065 Corpus lint: a record without a pipeline trace is a warning, once each.
    lint = seen["lint"]
    proofs.prove("n1065", lint["noTrace"] == ["dated:warn", "leak:warn"], f"no_trace findings {lint['noTrace']}")
    # n1066 Load by tags: the core always, notes by tags, never another audience.
    ld = seen["loader"]
    proofs.prove("n1066", ld["core"] == ["Always write terse commit messages."] and len(ld["tags"]) == 2, f"core {ld['core']}, tagged notes {len(ld['tags'])}")
    # n1068 Similar works from books: at most five accepted past tasks, never a blocked one.
    t = seen["tiers"]
    proofs.prove("n1068", t["episodes"] == 5 and not t["blockedAmongThem"], f"{t['episodes']} accepted similar tasks, blocked among them {t['blockedAmongThem']}")
    # n1069 Memory layer linter: errors before warnings before info, the same report twice.
    proofs.prove("n1069", lint["sortedByTier"] and lint["stable"] and lint["tiers"] == ["error", "warn", "info"], f"tiers {lint['tiers']}, sorted {lint['sortedByTier']}, stable {lint['stable']}")
    # n1070 Corpus review: proposals only, nothing written.
    proofs.prove("n1070", lint["proposals"] == [{"action": "supersede", "id": "aaa", "by": "bbb", "reason": "same subject"}] and lint["untouched"], f"proposals {lint['proposals']}, corpus untouched {lint['untouched']}")
    # n1071 Demotion instead of forgetting: the idle note is kept in the cold tier and found there.
    proofs.prove("n1071", t["stored"] == {"status": "expired", "reason": "idle"} and t["coldMatch"] == ["Greeting cards"] and t["none"] == 0, f"stored {t['stored']}, cold match {t['coldMatch']}, unrelated query {t['none']}")
    # n1072 Note text compression: a heavy note gets a shorter text; a core record never.
    er = seen["erase"]
    proofs.prove("n1072", er["shorterIsShorter"] and er["coreNeverShortened"], f"shorter {er['shorterIsShorter']}, core untouched {er['coreNeverShortened']}")
    # n1073 Memory economy meters: the budgets in tokens with their defaults.
    b = er["budgets"]
    proofs.prove("n1073", (b["coreBudget"], b["noteBudget"], b["indexBudget"], b["contextBudget"]) == (3072, 24000, 65536, 2500), f"budgets {b['coreBudget']}/{b['noteBudget']}/{b['indexBudget']}/{b['contextBudget']}")
    # n1074 The one destructive effect: after the erase no table still holds the id.
    proofs.prove("n1074", er["leftoversBefore"] == 4 and er["leftoversAfter"] == 0, f"tables holding the id: {er['leftoversBefore']} before, {er['leftoversAfter']} after")
    # n1075 This-machine-only store: a note for the owner is read by the owner view only, never by a writer or an export.
    proofs.prove("n1075", ld["exportView"] == 0 and ld["ownerView"] == ["An owner-only remark about billing."], f"export view {ld['exportView']}, owner view {ld['ownerView']}")
    # n1076 v1 to v2, preview only: a dry-run reports per line and writes nothing.
    im = seen["imports"]
    proofs.prove("n1076", im["dryRun"] and im["outcomes"] == ["added", "dropped"] and im["rowsWritten"] == 0, f"dry run outcomes {im['outcomes']}, rows written {im['rowsWritten']}")
    return proofs.verdict("sma_r14", checked=len(NODES))
