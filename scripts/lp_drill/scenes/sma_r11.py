"""Region 11 · The forge: a region scene (docs/sma-evidence.md, «Trace choice»).

The forge keeps its receipts in plugin KV and writes no hub table row, so each node is proved here: the probe (sma_r11_probe.ts) runs the REAL
forge tool of the commit under drill on a scratch database with a fake workspace, a fake host and a stand-in for the writer dispatch, and the
Creator's answer is a fixture draft file (no model, no hub write). The scene compares each node's card with what the code did and prove()s it.
Run: scripts/lp-drill.sh --scenario sma_r11
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n983", "n984", "n985", "n986", "n987", "n988", "n989", "n990", "n991", "n992"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r11_probe.ts"
SKILL_FILE = ".agents/forge/skills/lazy-images/SKILL.md"


def scenario_sma_r11(tmp) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=240)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r11", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n983 The Creator is a task of the ordinary writer pool, born by the PM thread, named for the forge.
    ok = seen["birth"] == "pm" and seen["taskId"] == "forge-skill-lazy-images" and seen["area"] == "forge:lazy-images" and seen["lane"] == "default" and seen["kind"] == "docs"
    proofs.prove("n983", ok, f"dispatched birth={seen['birth']} id={seen['taskId']} area={seen['area']} lane={seen['lane']} kind={seen['kind']}")
    # n984 Three draft kinds; a connection is refused by the tool's schema.
    proofs.prove("n984", seen["kinds"] == ["skill", "role", "workflow"] and seen["connectionAccepted"] is False, f"kinds {seen['kinds']}, connection accepted: {seen['connectionAccepted']}")
    # n985 The brief names the one file and carries the capability ceiling.
    proofs.prove("n985", seen["briefFirst"] == "You are the Creator (forge). Write exactly one role draft, .agents/forge/roles/fixer/fixer.md, and nothing else." and seen["briefCeiling"] == "Never grant: permission bypass, every tool,"[:40] and seen["objectiveIsBrief"] is True, f"first line {seen['briefFirst']!r}; ceiling {seen['briefCeiling']!r}")
    # n986 Exactly one draft: one owned folder, one expected file, the enabled trees off limits, the forge lint as the check.
    ok = seen["ownsPaths"] == [".agents/forge/skills/lazy-images/"] and seen["expectedOutputs"] == [SKILL_FILE] and seen["neverTouch"] == [".claude/", ".lane-pilot/"] \
        and seen["verification"] == [f"bb lane-pilot forge-lint skill lazy-images {SKILL_FILE}"]
    proofs.prove("n986", ok, f"owns {seen['ownsPaths']}, outputs {seen['expectedOutputs']}, check {seen['verification']}")
    # n987 One folder per kind, one per draft; an enabled draft lands in its own tree.
    ok = seen["folders"] == [".agents/forge/skills/thing-one", ".agents/forge/roles/thing-one", ".agents/forge/workflows/thing-one"] \
        and seen["enabledPaths"] == [".claude/skills/thing-one/SKILL.md", ".claude/agents/thing-one.md", ".lane-pilot/workflows/thing-one.json"]
    proofs.prove("n987", ok, f"folders {seen['folders']}")
    # n988 The deterministic lint: clean drafts give no finding, defects are named by code.
    ok = seen["lintGood"] == [0, 0] and seen["lintBad"] == ["name"] and seen["lintShort"] == ["description", "trigger"] and seen["clean"] == 0
    proofs.prove("n988", ok, f"clean drafts {seen['lintGood']} findings, wrong name {seen['lintBad']}, short description {seen['lintShort']}")
    # n989 Forbidden grants: the permission bypass in both spellings and a download piped into a shell fail a named check; a plain tools list passes.
    ok = seen["grants"] == 6 and seen["bypass"] == ["forbidden grant: bypasses the permission prompts"] and seen["bypassMode"] == ["forbidden grant: bypasses the permission prompts"] \
        and seen["pipe"] == ["forbidden grant: pipes a download into a shell"]
    proofs.prove("n989", ok, f"{seen['grants']} grants; flag -> {seen['bypass']}; mode -> {seen['bypassMode']}; pipe -> {seen['pipe']}")
    # n990 A draft that failed the lint cannot be enabled: the refusal names the finding and the host is never called.
    refused = seen["refusedBad"]
    ok = (not refused["ok"]) and refused["code"] == "lint_failed" and "forbidden grant: bypasses the permission prompts" in refused["message"] and seen["badReceipt"]["ok"] is False
    proofs.prove("n990", ok, f"refused with {refused.get('code')}: {refused.get('message', '')[:120]}")
    # n991 The receipt holds the hash of the bytes that were linted.
    good = seen["goodReceipt"]
    proofs.prove("n991", bool(good) and good["ok"] is True and good["shaIsTextHash"] is True and good["path"] == SKILL_FILE, f"receipt {good}")
    # n992 Two steps: confirm before request refused; with owner.words on, the confirm without the owner's «да» refused; with it the file lands in .claude/skills.
    ok = (seen["early"].get("code") == "no_request" and seen["requested"].get("requested") is True and seen["noWord"].get("code") == "owner_word"
          and seen["hostCallsBeforeWord"] == 0 and seen["enabled"].get("enabled") == ".claude/skills/lazy-images/SKILL.md"
          and seen["hostCalls"] == [{"method": "writeForgeEnabled", "paths": [".claude/skills/lazy-images/SKILL.md"]}] and seen["receiptEnabledBy"] == "owner")
    proofs.prove("n992", ok, f"early {seen['early'].get('code')}, no word {seen['noWord'].get('code')}, enabled {seen['enabled']}, host calls {seen['hostCalls']}")
    return proofs.verdict("sma_r11", checked=len(NODES))
