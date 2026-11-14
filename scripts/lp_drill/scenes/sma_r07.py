"""Region 7 · Providers, models, accounts: the region scene of the SMA-parity proof (docs/sma-evidence.md, «Trace choice»).

Model-free, provider-free, money-free and hub-free. The probe (sma_r07_probe.ts, run by tsx) runs the REAL code of the commit under drill on stand-ins: a fake
plugin host, a scratch HOME and database, a fake host call, the launcher's own Python over a scratch layer file, the guard's permit gate over a scratch folder.
No thread is spawned on a provider, nothing is paid. It prints one JSON line; this scene prove()s each node with the value it observed against the node card's
expected result. Two nodes (n605, n625) need a replaced module (the `sudo test -r` of the worker probe, a stub core for the writer start): their own test of
the contract index is re-run on this commit by vitest and the scene reads its result.

Batch b (n626 .. n656) is proved by re-running the contract tests of its cards (BATCH_B below). To add a node of this region (later batches): append its id to NODES, add a section to the probe (independent: its own host, folder and database), read it in
scenario_sma_r07 with proofs.prove(node, ok, detail) and put `trace: drill("sma_r07")` on its line of evidence/r07.ts. Nodes proved by a hub row (n601, n607,
n609: the capability table) are not here. Core-resident nodes (n596, n597, n598, n612, n615, n616) are not here either: their code is bb-core's.
Run: scripts/lp-drill.sh --scenario sma_r07   (add --dry-run to list the nodes).
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n599", "n600", "n602", "n603", "n604", "n605", "n606", "n608", "n610", "n611", "n613", "n614", "n617", "n618", "n619", "n620", "n621", "n622",
         "n623", "n624", "n625",
         # batch b: n626 .. n656 (n628 is void); each is proved by the contract tests of its card re-run on this commit (see BATCH_B)
         "n626", "n627", "n629", "n630", "n631", "n632", "n633", "n634", "n635", "n636", "n637", "n638", "n639", "n640", "n641", "n642", "n643", "n644",
         "n645", "n646", "n647", "n648", "n649", "n650", "n651", "n652", "n653", "n654", "n655", "n656"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r07_probe.ts"

# Batch b: node -> (the card's smaId, what the re-run tests must have shown). The tests are the contract index's: the new ones of
# tests/sma/four-proofs-r07-b.test.ts and the older tagged ones in the parity files; one vitest run reads them all.
BATCH_B = {
    "n626": ("m_md_forbidden", "the launch argv with an installer, an apply, a setup or a permission-bypass flag is refused before the launch"),
    "n627": ("m_md_role", "a named role loads its profile, an unlisted role starts as a specialist of the owner"),
    "n629": ("m_md_day_owner", "the provider the owner used in the last ten minutes is held with the minutes and the machine named"),
    "n630": ("m_md_busy", "the chain passes by the busy provider and the next member takes the task"),
    "n631": ("m_md_window_wait", "with every member held the task waits for the earliest and is not failed"),
    "n632": ("m_md_agent_model", "a member with its window almost spent is passed by and the next model of the chain takes the task"),
    "n633": ("m_mo_rule", "the paid channel only with every window closed and the cap set and not exceeded"),
    "n634": ("m_mo_bind", "the chain asks the hub's money for the cap, the book and the accounts"),
    "n635": ("m_mo_cap_read", "the stop and the screen read the cap from the one global row"),
    "n636": ("m_mo_cap_fn", "the cap setting becomes a number in one place, no conversion"),
    "n637": ("m_mo_set", "the cap dialog writes only money.monthly_cap_usd, hub-wide, as typed"),
    "n638": ("m_mo_stop", "a paid lane stops at exactly the cap or when the task's estimate would cross it"),
    "n639": ("m_mo_unset", "with no cap set the paid channel is closed by name"),
    "n640": ("m_mo_fallback", "a paid member over the cap is held until next month, a subscription lane is not"),
    "n641": ("m_mo_task_ceiling", "the task's estimate holds a paid lane only when a cap is set and would be crossed"),
    "n642": ("m_mo_usage", "a subscription turn books a row and is priced at zero, never counted as free money"),
    "n643": ("m_mo_month", "the month to date counts this month at the lane's price"),
    "n644": ("m_mo_accounts", "the stop and the screen quote the same book per account"),
    "n645": ("m_mo_estimate", "a silent paid attempt is estimated and marked as such"),
    "n646": ("m_mo_series", "the spend series is the last 14 days by day and account"),
    "n647": ("m_pr_create", "the sweep probes each provider in use on the sandbox with its own model"),
    "n648": ("m_pr_required", "an unproven adapter is observed, a red receipt holds"),
    "n649": ("m_pr_version", "the adapter version is the plugin's, a new version voids the receipt"),
    "n650": ("m_pr_doc_cells", "a provider is documentary-proved only with all four cells supported"),
    "n651": ("m_pr_doc_drill", "the documentary cells are proved by the session's trace, not the model's word"),
    "n652": ("m_pr_claude_pause", "stop, confirmed exit and resume by the same thread id"),
    "n653": ("m_pr_codex_pause", "the same stop-confirm-resume proof is the Codex pause drill"),
    "n654": ("m_pr_codex_probe", "the probe writes only its own .lp-probe-* files in the workspace"),
    "n655": ("m_pr_codex_progress", "a Codex thread's commands and tool calls become the progress lines"),
    "n656": ("m_pr_design_eval", "two versions of a page are judged by the rubric, the cleaner one wins"),
}
BATCH_B_FILES = ["tests/sma/four-proofs-r07-b.test.ts", "tests/sma/parity-d8-providers-money-1.test.ts", "tests/sma/parity-d8-providers-money-2.test.ts",
                 "tests/sma/parity-c1-have.test.ts", "tests/sma/parity-i3-drill-watch.test.ts", "tests/sma/parity-h4-window.test.ts"]


def _section(seen: dict, name: str) -> dict:
    """One probe section; an errored or missing one is returned as {} so every node that reads it fails with the reason in its detail."""
    value = seen.get(name)
    return value if isinstance(value, dict) and "error" not in value else {}


def _why(seen: dict, name: str) -> str:
    value = seen.get(name)
    return f"section {name} did not run: {value.get('error') if isinstance(value, dict) else 'missing'}"


def _vitest(tmp: Path, file: str, pattern: str) -> tuple[int, int]:
    """Re-run the tests of the contract index whose title holds `pattern` on this commit: (passed, failed)."""
    report = tmp / f"vitest-{abs(hash(pattern))}.json"
    subprocess.run(["npx", "vitest", "run", file, "-t", pattern, "--reporter=json", f"--outputFile={report}", "--maxWorkers=2"], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        data = json.loads(report.read_text())
    except (OSError, ValueError):
        return 0, 1
    return int(data.get("numPassedTests", 0)), int(data.get("numFailedTests", 0))


def _contract_results(tmp: Path) -> dict[str, tuple[int, int]]:
    """Re-run the batch-b contract tests on this commit with one vitest call: smaId -> (passed, failed) over the tests whose title carries [sma:<id>]."""
    report = tmp / "vitest-batch-b.json"
    subprocess.run(["npx", "vitest", "run", *BATCH_B_FILES, "-t", "sma:m_(md|mo|pr)_", "--reporter=json", f"--outputFile={report}", "--maxWorkers=2"],
                   cwd=ROOT, capture_output=True, text=True, timeout=1200)
    try:
        data = json.loads(report.read_text())
    except (OSError, ValueError):
        return {}
    seen: dict[str, tuple[int, int]] = {}
    for suite in data.get("testResults", []):
        for test in suite.get("assertionResults", []):
            for sma in re.findall(r"\[sma:([a-z0-9_]+)\]", test.get("fullName", "")):
                passed, failed = seen.get(sma, (0, 0))
                seen[sma] = (passed + (test.get("status") == "passed"), failed + (test.get("status") == "failed"))
    return seen


def scenario_sma_r07(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r07", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    def prove(node: str, section: str, check, detail) -> None:
        data = _section(seen, section)
        if not data:
            proofs.prove(node, False, _why(seen, section))
            return
        try:
            ok = bool(check(data))
        except (KeyError, IndexError, TypeError):
            ok = False
        proofs.prove(node, ok, detail(data))

    # n599 Fresh codex home per task: after the janitor pass only the quiet final task of the strict project lost its home (task and attempt keys); a task of a project
    # without worker.strict_user and a task that ended ten hours ago kept theirs; the owner's login the homes linked is still there.
    prove("n599", "codexHome", lambda d: d["removals"] == ["A-done", "T-done"] and d["left"] == ["T-fresh", "T-plain"] and d["ownerLogin"] is True,
          lambda d: f"homes removed through the host call {d['removals']}, homes left {d['left']}, owner's login kept {d['ownerLogin']}")
    # n600 Seed the codex home: config and login laid on the first call, nothing on the second; goals and web search turned off for the writer profile, no AGENTS.md.
    prove("n600", "seed", lambda d: d["seeded"] == ["config.toml", "auth.json"] and d["again"] == [] and d["goalsOff"] and d["webOff"] and not d["agentsMd"] and d["authLinked"],
          lambda d: f"seeded {d['seeded']}, again {d['again']}, goals off {d['goalsOff']}, web search off {d['webOff']}, AGENTS.md {d['agentsMd']}, login linked {d['authLinked']}")
    # n602 Readiness of the whole pool: two workers enabled, the one with an open breaker named with its reason.
    prove("n602", "pool", lambda d: d["enabled"] == 2 and [row["key"] for row in d["blocked"]] == ["codex/gpt-6-luna"] and d["blocked"][0]["reason"].startswith("writer_provider_unavailable:breaker_open:") and d["blocked"][0]["projectIds"] == ["proj"],
          lambda d: f"enabled {d['enabled']}, blocked {d['blocked']}")
    # n603 No access, named: the only member of the chain is held, the attempt waits with the cause in its reason, not silence.
    prove("n603", "hold", lambda d: d["parked"] == "waiting_writer:writer_provider_unavailable:breaker_open:codex/gpt-6-luna: 3 provider failures" and d["free"] is None and d["none"] is None,
          lambda d: f"parked reason «{d['parked']}», free member {d['free']}, an unheld member holds {d['none']}")
    # n617 Vendor cannot be started: each cause has its own named reason and its board line in words.
    prove("n617", "hold", lambda d: d["unsupported"] == "writer_provider_unavailable:core_unsupported:devin" and "не поддерживается этим ядром" in d["unsupportedText"] and d["off"] == "writer_provider_unavailable:writer_off:codex/gpt-6-luna"
          and "выключен владельцем" in d["offText"] and d["openText"].startswith("Ждёт писателя: провайдер Codex временно недоступен"),
          lambda d: f"core cannot run it «{d['unsupported']}» / «{d['unsupportedText']}»; switched off «{d['off']}»; breaker «{d['openText']}»")
    # n604 Strict worker list: worker.strict_user on sends the check as worker.user (lp-worker by default), unset sends no user.
    prove("n604", "strict", lambda d: d["named"] == ["ci-bot"] and d["defaulted"] == ["lp-worker"] and d["off"] == [None],
          lambda d: f"strict on with worker.user ci-bot -> asUser {d['named']}, strict on -> {d['defaulted']}, unset -> {d['off']}")
    # n606 Checks as the worker: sudo -n -u keeping only the named variables; the credential stores (.ssh, .aws, .gnupg, gh, .netrc) are the masked ones.
    prove("n606", "worker", lambda d: d["launch"]["args"][:4] == ["-n", "-u", "lp-worker", "--preserve-env=PATH,TOKEN"] and d["masked"]["dirs"] == [".aws", ".config/gh", ".gnupg", ".ssh"] and d["masked"]["files"] == [".netrc"],
          lambda d: f"launch {d['launch']['program']} {' '.join(d['launch']['args'][:4])}, masked {d['masked']}")
    # n608 Worker hands in own copy: the worker gets inherited rights on the run folder and the owner keeps his on what the worker makes.
    prove("n608", "worker", lambda d: d["darwin"] == ["-a user:lp-worker", "+a user:lp-worker", "+a user:owner"] and "u:owner:rwX,d:u:owner:rwX" in d["linux"],
          lambda d: f"macOS grants {d['darwin']}, Linux acl {d['linux']}")
    # n610 Windows job object: the group of a timed-out check is dead, the background process of a normal finish is left.
    prove("n610", "job", lambda d: d["timeoutCode"] == "ETIMEDOUT" and d["timedOutAlive"] is False and d["normalStatus"] == 0 and d["normalAlive"] is True,
          lambda d: f"timeout {d['timeoutCode']}, group alive after it {d['timedOutAlive']}; normal finish status {d['normalStatus']}, background alive {d['normalAlive']}")
    # n611 Claude lane: the claude family, subscription windows published, hook settings read; Codex publishes no windows.
    prove("n611", "lanes", lambda d: d["claude"]["family"] == "claude" and d["claude"]["windows"] is True and d["claude"]["hooks"] is True and d["claude"]["codexWindows"] is None,
          lambda d: f"claude-code {d['claude']}")
    # n613 Paid API channel: the token-paid lanes are told from the subscription ones.
    prove("n613", "lanes", lambda d: d["paid"] == ["openlux", "anthropic", "openai", "api", "api-acme"] and d["subscription"] == ["claude-code", "codex", "opencode2"],
          lambda d: f"paid {d['paid']}, subscription {d['subscription']}")
    # n614 Default vendor per lane: authors on Claude, judges and paperwork on GPT, reviews on the Gemini through 9router.
    prove("n614", "lanes", lambda d: d["routing"] == {"planner": "claude-code/claude-opus-5-5/high", "auditor": "codex/gpt-6.1-sol/high", "docs": "codex/gpt-6-luna/high", "codeCritic": "opencode2/router9/ag/gemini-3.8-flash-high/medium", "pmReader": "claude-code/claude-haiku-5-5/low"},
          lambda d: f"routing {d['routing']}")
    # n624 Expected model and effort: every role of the table names an offered model and a known effort.
    prove("n624", "lanes", lambda d: d["table"]["roles"] > 30 and d["table"]["unknownModel"] == [] and d["table"]["unknownEffort"] == [],
          lambda d: f"{d['table']['roles']} roles, without an offered model {d['table']['unknownModel']}, without a known effort {d['table']['unknownEffort']}")
    # n618 Default critic is another vendor: a Claude critic of a Claude writer moves to Codex, a GPT writer leaves it.
    prove("n618", "critic", lambda d: d["claudeWriter"] == {"pair": {"providerId": "codex", "model": "gpt-6.1-sol"}, "changed": True} and d["gptWriter"]["changed"] is False,
          lambda d: f"claude writer: {d['claudeWriter']}; gpt writer: {d['gptWriter']}")
    # n619 Merge of worker settings: core flags first, the guard after, the person's deny list mirrored, allow and defaultMode left out.
    prove("n619", "merge", lambda d: d["commands"][0] == "core" and d["commands"][-1] == "guard" and d["deny"] == ["Bash(rm -rf /)"] and d["allow"] is None and d["plugins"] == {"x@x": False},
          lambda d: f"hooks {d['commands']}, deny {d['deny']}, allow {d['allow']}")
    # n623 Unreadable hooks removed: the hook whose program file is missing is gone and the stderr names its place and the reason; the present one stays.
    prove("n623", "merge", lambda d: "python3 /definitely/missing/hook.py" not in d["commands"] and any(c.endswith("present.py") for c in d["commands"]) and "hook 2 of group 1 on event PreToolUse dropped" in d["stderr"] and "/definitely/missing/hook.py does not exist" in d["stderr"],
          lambda d: f"hooks {d['commands']}, said «{d['stderr'][:140]}»")
    # n620 Keys never mirrored: a secret and a login reach a check; an ssh or ftp record never does.
    prove("n620", "keys", lambda d: d["secret"] == {"STRIPE": "tok"} and set(d["login"]) == {"SHOP_USERNAME", "SHOP_PASSWORD", "SHOP_URL"} and d["ssh"] is None and d["ftp"] is None,
          lambda d: f"secret {d['secret']}, login variables {sorted(d['login'])}, ssh {d['ssh']}, ftp {d['ftp']}")
    # n621 Danger gate hook: the first call files a ticket, the granted call goes through once, the same call afterwards files a ticket again.
    prove("n621", "permit", lambda d: d["first"] is True and d["second"] is None and d["third"] is True,
          lambda d: f"first call ticketed {d['first']}, call after the grant {d['second']}, the same call again ticketed {d['third']}")
    # n622 Capsule hook before compaction: the last five asks cut to 300 characters, 30 files, 30 claims, the trigger.
    prove("n622", "capsule", lambda d: d["asks"] == 5 and d["firstAsk"] == "ask-3" and d["askLength"] == 300 and d["files"] == 30 and d["claims"] == 30 and d["trigger"] == "precompact",
          lambda d: f"asks {d['asks']} from {d['firstAsk']} of {d['askLength']} characters, files {d['files']}, claims {d['claims']}, trigger {d['trigger']}")
    # n605 Reachability probe command: the worker probe names a readable credential path as exposed (the contract index's tests, re-run on this commit).
    passed, failed = _vitest(tmp, "tests/sma/parity-d10-rest-2.test.ts", "m_ac_identity_probe")
    proofs.prove("n605", passed >= 2 and failed == 0, f"tests of m_ac_identity_probe re-run: {passed} passed, {failed} failed")
    # n625 Launch profile parity: the swapped provider is refused with refuse (default), warned with warn; an alias or clamped effort is only a warning.
    passed, failed = _vitest(tmp, "tests/sma/parity-d8-providers-money-2.test.ts", "m_md_parity")
    proofs.prove("n625", passed >= 4 and failed == 0, f"tests of m_md_parity re-run: {passed} passed, {failed} failed")
    # Batch b (n626 .. n656): the contract tests of each card, re-run on this commit by one vitest call (the new tests build the stand-ins themselves:
    # a fake plugin host, a scratch database, fixture events; the older ones are the parity files'). A node is proved when at least one of its tests
    # ran and none failed; the detail says how many.
    results = _contract_results(tmp)
    for node, (sma, what) in BATCH_B.items():
        passed, failed = results.get(sma, (0, 0))
        proofs.prove(node, passed >= 1 and failed == 0, f"{what}: tests of {sma} re-run on this commit: {passed} passed, {failed} failed")
    return proofs.verdict("sma_r07")
