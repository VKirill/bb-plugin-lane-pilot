"""Region 14 · Memory, batches a and b (n1048 .. n1107): the nodes whose effect is not a hub row of their own.

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
         "n1074", "n1075", "n1076",
         # batch b
         "n1078", "n1080", "n1081", "n1082", "n1083", "n1084", "n1085", "n1086", "n1087", "n1088", "n1090", "n1092", "n1093", "n1094", "n1095", "n1097", "n1098",
         "n1099", "n1100", "n1101", "n1102", "n1103", "n1104", "n1105"]
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

    # ---- batch b (n1078 .. n1105): the terminal verbs and the retrieval layers, on the hub path of memory (rows of lane_pilot_memory and its indexes).
    b = seen["b"]
    # n1078 Gold set: a reminded miss is a gold case tied to its note; an empty miss is not one.
    g = b["gold"]
    proofs.prove("n1078", g["listed"] == ["when does the refund queue drain?|true"] and g["gold"] == ["miss-1|when does the refund queue drain?|true"],
                 f"reminded misses {g['listed']}, gold questions of the corpus plan {g['gold']}")
    # n1080 sma memory miss: the verb refuses an unknown note, stores a reminded miss for a known one.
    proofs.prove("n1080", g["refusedExit"] == 1 and g["missExit"] == 0 and len(g["listed"]) == 1, f"unknown note exit {g['refusedExit']}, known note exit {g['missExit']}, reminded rows {len(g['listed'])}")
    # n1081 / n1104 Why a note is in the pack or not.
    e = b["explain"]
    proofs.prove("n1081", e["keep"] == "deliver keep — matched the query" and "context budget" in e["cut"] and "no token overlap" in e["away"], f"explain: {e['keep']} | {e['cut']} | {e['away']}")
    proofs.prove("n1104", e["cut"].startswith("reject long") and "cut by the context budget" in e["cut"] and e["away"].endswith("no token overlap"), f"reasons: {e['cut']} | {e['away']}")
    # n1082 / n1088 Index status and rebuild: a lost entry is reported by the status, the rebuild puts it back and says how many.
    ix = b["index"]
    proofs.prove("n1082", ix["missing"] == [ix["a"]], f"index status lists the lost entry {ix['missing']}")
    proofs.prove("n1088", ix["rebuilt"] == "rebuilt memory indexes: 2 active, 1 added, 0 stale" and ix["after"] == [], f"rebuild said «{ix['rebuilt']}», drift after {ix['after']}")
    # n1083 sma memory forget: archive and revoke leave their reasons, erase needs --yes and then nothing remains.
    fg = b["forget"]
    proofs.prove("n1083", fg["archive"] == {"status": "expired", "reason": "archived"} and fg["revoke"] == {"status": "expired", "reason": "revoked"} and fg["noYesExit"] == 1 and fg["erasedExit"] == 0 and fg["gone"] and fg["leftovers"] == [],
                 f"archive {fg['archive']}, revoke {fg['revoke']}, erase without --yes exit {fg['noYesExit']}, with --yes exit {fg['erasedExit']}, leftovers {fg['leftovers']}")
    # n1084 sma memory migrate: a dry run previews per line and the corpus is unchanged.
    mg = b["migrate"]
    proofs.prove("n1084", mg["outcomes"] == ["added", "dropped"] and mg["unchanged"], f"dry run outcomes {mg['outcomes']}, corpus unchanged {mg['unchanged']}")
    # n1085 sma memory compress: the list changes no row; apply replaces exactly the named note.
    cp = b["compress"]
    proofs.prove("n1085", cp["listedBoth"] and cp["afterList"] == 0 and cp["appliedExit"] == 0 and cp["first"] == "superseded" and cp["second"] == "active",
                 f"listed both {cp['listedBoth']}, superseded after the list {cp['afterList']}, apply exit {cp['appliedExit']}, named note {cp['first']}, other {cp['second']}")
    # n1086 sma memory stats: tokens of the core and of the notes.
    proofs.prove("n1086", b["stats"] == {"core": 100, "notes": 400}, f"core {b['stats']['core']} tokens, notes {b['stats']['notes']} tokens")
    # n1087 sma load --tags: the core, then the notes carrying the tag, never another note.
    ld_ = b["load"]
    proofs.prove("n1087", ld_["core"] and ld_["tagged"] and not ld_["other"], f"core listed {ld_['core']}, tagged note listed {ld_['tagged']}, other note listed {ld_['other']}")
    # n1090 sma lint: one checker names the planted credential as an error and exits 1.
    li = b["lint"]
    proofs.prove("n1090", li["exit"] == 1 and li["secret"] == ["error:leak9"], f"lint exit {li['exit']}, secret findings {li['secret']}")
    # n1092 sma trim: an overfull core moves down (the last core entry becomes a note), nothing is deleted.
    tr = b["trim"]
    proofs.prove("n1092", tr["demoted"] == 1 and tr["kinds"] == ["core", "note"] and tr["rows"] == 2, f"demoted {tr['demoted']}, kinds {tr['kinds']}, rows kept {tr['rows']}")
    # n1093 sma history search: a lesson of the project is found, a planted token is masked, an unknown word finds nothing.
    hs = b["history"]
    proofs.prove("n1093", hs["lessons"] and hs["masked"] and hs["none"] == "nothing found", f"lesson found {hs['lessons']}, token masked {hs['masked']}, unknown word: «{hs['none']}»")
    # n1094 sma context: the pack holds what fits the budget, a head line for what does not, nothing unrelated.
    cx = b["context"]
    proofs.prove("n1094", cx["kept"] == ["keep"] and cx["heads"] == ["long"] and not cx["borscht"] and cx["fits"], f"kept {cx['kept']}, head lines {cx['heads']}, unrelated note in the pack {cx['borscht']}, within budget {cx['fits']}")
    # n1095 sma catalog: one card line per git-tracked file, none for an untracked one.
    ct = b["catalog"]
    proofs.prove("n1095", ct["exit"] == 0 and ct["lines"] == 3 and ct["first"] == "a.ts" and not ct["untracked"], f"catalog lines {ct['lines']}, first {ct['first']}, untracked listed {ct['untracked']}")
    # n1097 One note header parser: the claim and areas are read, a missing status is active, a file without a header is nothing.
    fm = b["frontmatter"]
    proofs.prove("n1097", fm["id"] == "worktree-routing" and fm["status"] == "active" and fm["areas"] == ["procedures", "lanes"] and fm["none"] is None, f"parsed id {fm['id']}, status {fm['status']}, areas {fm['areas']}, no header {fm['none']}")
    # n1098 Memory record schema: kinds core/note, an end date, lower-cased tags; any other kind is refused with the check's words.
    sc = b["schema"]
    proofs.prove("n1098", sc["until"] and sc["concepts"] == ["queue"] and sc["kindRefusal"] == "memory kind must be core or note", f"valid_until parsed {sc['until']}, tags {sc['concepts']}, refusal «{sc['kindRefusal']}»")
    # n1099 The core of a session: active core records of the project only.
    proofs.prove("n1099", b["core"] == ["Always write terse commit messages."], f"session core {b['core']}")
    # n1100 Word index first, trigram word forms after: whole-word hits lead, a word form is reached only by the trigram layer.
    se = b["search"]
    proofs.prove("n1100", se["whole"] == ["The invoice", "Nightly arc"] and se["forms"] == ["Nightly arc", "The invoice"] and se["none"] == 0, f"«invoice» {se['whole']}, «invoices» {se['forms']}, unrelated {se['none']}")
    # n1101 Word forms: one form finds the others.
    wf = b["forms"]
    proofs.prove("n1101", wf["stems"] == ["ошиб", "ошиб", "ошиб"] and wf["long"] == "calculati" and wf["short"] == "cat", f"stems {wf['stems']}, long {wf['long']}, short {wf['short']}")
    # n1102 Memory by the words in view: the matching note, and «nothing relevant» for an unrelated question.
    rc = b["recall"]
    proofs.prove("n1102", rc["found"] == ["The nightly export"] and rc["none"] == 0 and rc["nothingRelevant"], f"found {rc['found']}, unrelated question: {rc['none']} notes, nothing relevant {rc['nothingRelevant']}")
    # n1103 Fusion: the note both layers find leads, the one only the word-form layer finds follows.
    proofs.prove("n1103", b["fusion"] == ["invoice", "A", "invoices"], f"fused order {b['fusion']}")
    # n1105 Claude Code's own notes: read through the shared door, a credential line is dropped with reason secret.
    am = b["automem"]
    proofs.prove("n1105", am["outcomes"] == {"proj/fact": "added:", "sec": "dropped:secret"} and am["rows"] == 1, f"outcomes {am['outcomes']}, rows stored {am['rows']}")
    return proofs.verdict("sma_r14", checked=len(NODES))
