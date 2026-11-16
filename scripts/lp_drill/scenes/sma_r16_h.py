"""Region 16 · Slash commands and workflows, batch h — project start, workspaces and the profile (n1349 … n1367, without n1351, n1352, n1362, n1365).

Called from the region scene sma_r16.py (`prove_h(proofs, tmp)`); the receipt of that scene lists these nodes next to the other batches'. The probe sma_r16_h_probe.ts runs the REAL
code of the commit under drill — the real workflow engine on project-start and plan-import with the real lp.* executors against a temp git checkout (agent nodes answer from a table,
no model), the real `bb lane-pilot profile` verb on the plugin, the real worktree removal on a temp repository — with no hub write and nothing outside the machine, and prints what
it returned. Each prove() below compares one value with the result the node's card expects. The same observations are asserted by tests/sma/four-proofs-r16-h.test.ts.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_H = [
    "n1349", "n1350", "n1353", "n1354", "n1355", "n1356", "n1357", "n1358", "n1359", "n1360", "n1361", "n1363", "n1364", "n1366", "n1367",
]
PROBE_H = ROOT / "scripts/lp_drill/scenes/sma_r16_h_probe.ts"
KEYS = ["stack", "test_command", "release", "hosts", "start", "deploy", "logs", "style"]
PIECES = [{"id": "p1", "task": {"owns_paths": ["src/**"]}}]
D3 = "conflicts with locked decision D3"
NOTE = "Open VALUE-MAP.md with these five lines counted from the tree itself, verbatim:"
MAIN_VALUE_MAP = "Value map builder, before asking anything: from README, the passport (project-onboard), the site and the code — who the product is for, the job they hire it for, what they get, how we would know it works. Return the complete raw Markdown of VALUE-MAP.md in document; the code-owned writer persists it to .agents/planning/."


def prove_h(proofs, tmp) -> None:
    """Run the probe and prove batch h's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_H)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_H:
            proofs.prove(node, False, f"the batch h probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # ---- plan-import, workspaces
    d = seen("k_c_import")
    c, k, a, i = d.get("conflicted", {}), d.get("clean", {}), d.get("aborted", {}), d.get("invalid", {})
    proofs.prove("n1349", c.get("path") == "grill resolve pieces check emit" and c.get("asked") == 1 and c.get("out") == {"status": "done", "pieces": PIECES, "conflicts": [D3]} and k.get("skipped") == ["resolve"] and a.get("out", {}).get("status") == "aborted" and a.get("piecesAsked") == 0 and i.get("path") == "grill resolve pieces check invalid" and i.get("out", {}).get("pieces") == [], f"/sma-import: conflict -> owner -> {c.get('out')}; no conflict skips {k.get('skipped')}; abort {a.get('path')}; bad pieces {i.get('path')}")
    d = seen("k_c_ingest")
    proofs.prove("n1350", d.get("grillSaw", {}).get("plan", "").startswith("# ADR-7: orders move to Postgres") and d.get("grillSaw", {}).get("goal") == "move orders to Postgres" and d.get("out", {}).get("conflicts") == ["ADR-7 contradicts the locked decision D3 (the queue is Redis)"] and d.get("out", {}).get("status") == "done", f"an ADR as the plan: the conflict check saw {str(d.get('grillSaw', {}).get('plan', ''))[:40]!r}, conflicts back {d.get('out', {}).get('conflicts')}; no separate ingest graph: {not d.get('hasIngestGraph')}")
    d = seen("k_c_rmws")
    a1, a2 = d.get("after1", {}), d.get("after2", {})
    proofs.prove("n1353", a1 == {"removed": True, "folder": False, "listed": False, "otherKept": True, "branch": "", "parent": True} and a2 == {"removed": True, "folder": False, "listed": False, "branch": "", "parent": False, "main": ["a.txt", "work.txt"]}, f"first copy removed {a1}; last copy removed with its workspace folder {a2}")

    # ---- the start of a project
    d = seen("k_wst_map")
    ask = d.get("askOrder", [])
    proofs.prove("n1354", d.get("order", [])[:3] == ["tree", "probe", "value_map"] and d.get("prompt", "").startswith(MAIN_VALUE_MAP) and d.get("tail") == f"verbatim: sources 3, tests 2, docs 2, planning artifacts 2, commits {d.get('commits')}." and d.get("commits") == 7 and "value_map" in ask and "ask" in ask and ask.index("value_map") < ask.index("ask"), f"value map step given «{d.get('tail')}»; with no profile the owner is asked after it: {ask}")
    d = seen("k_wst_quick")
    r = d.get("resumed", {})
    proofs.prove("n1355", r.get("executed") == ["tree", "probe", "resumed"] and r.get("modelCalls") == 0 and r.get("output", {}).get("next_steps") == ["the project is already started — continue with project-resume"] and d.get("roadmapMissing") == {"costly": ["preview", "research", "requirements", "recap"], "skipped": ["value_map", "write_value_map", "ask", "write_research_stack", "write_research_features", "write_research_architecture", "write_research_pitfalls", "write_requirements"]} and d.get("profileMissing", {}).get("costly") == ["preview", "ask", "research", "requirements"] and d.get("profileMissing", {}).get("skipped") == ["value_map", "write_value_map", "write_research_stack", "write_research_features", "write_research_architecture", "write_research_pitfalls", "write_requirements", "recap", "write_roadmap", "write_project", "add_phases"], f"install with all three resumes {r.get('executed')} with {r.get('modelCalls')} model calls; roadmap missing {d.get('roadmapMissing')}; profile missing {d.get('profileMissing')}")
    d = seen("k_wst_project")
    f, w = d.get("fresh", {}), d.get("withRoadmap", {})
    proofs.prove("n1356", f.get("executed") == ["tree", "probe", "value_map", "write_value_map", "preview", "profile_write", "research", "requirements", "recap", "write_roadmap", "write_project", "add_phases", "done"] and f.get("nextSteps") == ["a", "b", "c"] and "In project_document return the raw Markdown of .agents/planning/PROJECT.md built from VALUE-MAP.md: Vision, Value and Limits" in f.get("prompt", "") and "the roadmap skeleton as raw Markdown in roadmap_draft" in f.get("prompt", "") and w.get("executed") == ["tree", "probe", "resumed"] and w.get("skipped") == [], f"fresh start recap runs and is told to write PROJECT.md and the roadmap skeleton; with a roadmap skipped {w.get('skipped')}")
    d = seen("k_wst_stack")
    proofs.prove("n1357", d.get("previewBeforeWriter") is True and d.get("stored") == {"profile.stack": "typescript, vitest", "profile.test_command": "npm test"} and d.get("refused") == [], f"stack and tests the preview answered are stored as {d.get('stored')}")
    d = seen("k_wst_infra")
    proofs.prove("n1358", d.get("told") == KEYS and d.get("accepted") == KEYS and sorted((d.get("stored") or {}).keys()) == sorted(f"profile.{key}" for key in KEYS) and d.get("refused") == ["flavour"], f"preview told to return {d.get('told')}; writer accepts {d.get('accepted')}; refused {d.get('refused')}")
    d = seen("k_wst_style")
    proofs.prove("n1359", d.get("done", {}).get("set") == ["stack", "test_command", "style"] and "- Style: small functions, no comments\n" in (d.get("projectMd") or "") and d.get("agentsMd") == "# mine\nwritten by a person\n" and d.get("claudeMd") == "@AGENTS.md\n", f"PROJECT.md preferences carry the style; the person's AGENTS.md kept; CLAUDE.md {d.get('claudeMd')!r}")
    d = seen("k_wst_close")
    proofs.prove("n1360", d.get("output") == {"status": "done", "value_map": "for shop owners", "next_steps": ["a", "b", "c"], "refused": []} and d.get("order", [])[-2:] == ["add_phases", "done"] and len(d.get("recapNote", "")) > 100 and d.get("prompt", "").endswith(d.get("recapNote", "?")) and d.get("profileNote", "?") not in d.get("prompt", ""), f"start result {d.get('output')}")
    d = seen("k_v_startmap")
    on = d.get("on", {})
    proofs.prove("n1361", d.get("off") == {"enabled": "off", "sources": 0, "tests": 0, "docs": 0, "planning": 0, "commits": 0, "counts_note": ""} and (on.get("sources"), on.get("tests"), on.get("docs"), on.get("planning")) == (3, 2, 3, 1) and on.get("commits") == d.get("headCommits") == 9 and on.get("counts_note") == f"{NOTE} sources 3, tests 2, docs 3, planning artifacts 1, commits 9.", f"counted from the tree: {on.get('counts_note')}")
    d = seen("k_lib_startmap")
    f = d.get("fresh", {})
    proofs.prove("n1364", "value_map" in f.get("executed", []) and f.get("valueMap") == "for shop owners" and f.get("prompt", "").endswith("verbatim: sources 1, tests 0, docs 1, planning artifacts 1, commits 2.") and "value_map" in d.get("had", {}).get("skipped", []) and d.get("had", {}).get("valueMap") == "" and d.get("valueMapCalls") == 1, f"builder asked once with {str(f.get('prompt', ''))[-60:]!r}; existing map skips it {d.get('had', {}).get('skipped')}")

    # ---- the profile
    d = seen("k_v_profile")
    proofs.prove("n1363", d.get("emptyKeys") == [f"profile.{key}" for key in KEYS] and d.get("read", {}).get("profile.test_command") == "npm test -- --grep=a=b" and d.get("secret") == {"exitCode": 1, "text": "refused release: the value looks like a secret"} and str(d.get("unknown", {}).get("text", "")).startswith("refused flavour: unknown profile key") and d.get("afterRefusals") == {"profile.stack": "typescript", "profile.test_command": "npm test -- --grep=a=b"} and d.get("fromWriter", {}).get("exitCode") == 1 and d.get("afterReset") == {"profile.test_command": "npm test -- --grep=a=b"}, f"profile verb: eight keys read, secret {d.get('secret')}, writer thread {d.get('fromWriter', {}).get('text')}")
    d = seen("k_lib_profile")
    proofs.prove("n1366", d.get("loaded") == {"profile.hosts": "project-host", "profile.style": "terse", "profile.stack": "typescript"} and d.get("viaVerb", {}).get("profile.hosts") == "project-host" and d.get("viaVerb", {}).get("profile.style") == "terse" and [d.get("otherStack"), d.get("otherStyle"), d.get("otherHosts")] == ["php", "terse", "global-host"], f"profile read through the one reader: {d.get('loaded')}; another project sees {d.get('otherStack')}/{d.get('otherHosts')}")
    d = seen("k_lib_profilewriter")
    wr = d.get("written", {})
    proofs.prove("n1367", wr.get("set") == ["stack", "test_command", "deploy"] and wr.get("refused") == ["db_password", "release", "flavour"] and d.get("stored") == {"profile.stack": "typescript", "profile.test_command": "npm test", "profile.deploy": "manual"} and "hunter2" not in f"{d.get('secretsInRows')}{d.get('secretsInFiles')}" and "sk-a" not in f"{d.get('secretsInRows')}{d.get('secretsInFiles')}", f"profile writer set {wr.get('set')}, refused by key {wr.get('refused')}, stored {d.get('stored')}")
