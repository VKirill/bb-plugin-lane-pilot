"""bb-core nodes · the live trace of the SMA map (docs/sma-evidence.md, «Proofs in a sibling repository», «Trace»).

The code of these nodes is the BB core (vk layer, sibling repository bb-core). Their behaviour test and killed mutation live there; this scene
is the fourth proof: it asks the DEPLOYED hub and writes what the core answered into the receipt with prove(node, ok, detail). It sees the core
only from outside: the `bb` CLI of the drill machine (every `bb ...` talks to the live hub) and the hub's own HTTP routes (the URL `bb` itself
uses: BB_SERVER_URL). No model call, no restart, no setting change, no thread history read.

Safety. By default the scene only reads, or sends a request the door refuses before it touches anything (a nonexistent thread id, a body the
schema refuses, a wrong key at the internal door): no row is written. The two nodes that can only be seen by writing (n723, n724: a project
is added and renamed) need a fixture the scene makes and removes itself; it runs only with LP_DRILL_SMA_CORE_WRITES=1 and then touches nothing
but two projects named «Sma-Core-Drill-…», each deleted in `finally` after the scene has checked it is its own, empty project.
The remaining nodes of the 35 the two core batches proved are NOT here: each is listed in NOT_PROVED with the reason (internal function, plugin
disabled on the hub, needs a fixture on the core side).

What this trace is worth: it shows the behaviour on the build the hub runs now; it cannot say since when the hub runs a given core commit
(docs/sma-evidence.md, «Change point»): the receipt records the running core build (`coreBuild`) so a later reader can.
Run: LP_DRILL_HUB_RECEIPTS=off scripts/lp-drill.sh --scenario sma_core   (add LP_DRILL_SMA_CORE_WRITES=1 for the project fixture).
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from lp_drill.env import SANDBOX
from lp_drill.hub import bb as run_bb
from lp_drill.prove import Proofs
from lp_drill.scenes.sma_core_last import NODES_LAST, prove_last

NODES = ["n531", "n532", "n540", "n616", "n673", "n680", "n694", "n723", "n724", "n725", "n728", "n1352", "n1412"]
NODES = NODES + NODES_LAST
ENV_WRITES = "LP_DRILL_SMA_CORE_WRITES"
FIXTURE_PREFIX = "Sma-Core-Drill-"
GONE = "thr_sma_core_drill_no_such_thread"  # an id no thread has: the doors answer before any lookup writes anything
RESOLVED_BY_KIT = ("codex", "claude-code", "acp-cursor")  # the providers whose maintenance status calls resolveExecutablePath (opencode2 says «installed» by another way, with no path)
UNAUTHORIZED = {"code": "unauthorized", "message": "Unauthorized"}

# The other nodes of the two core batches (sib-core-server-a, sib-core-rest) with a killed mutation: why this scene does not prove them.
NOT_PROVED = {
    # internal: a pure function or a type whose only door is its own test; a live read cannot reach it
    "n533": "the persisted lifecycle wrapper is observed locally by sma_r06 on sibling PRIMARY; this HTTP scene does not prove a deployed process stop",
    "n615": "internal: resolveClaudeCodeExecutable runs when a Claude Code session starts on a machine (the maintenance status uses resolveExecutablePath, n616); needs a session start on the Windows machine",
    "n1305": "internal: stageInjectedSkillSources runs inside the host daemon when a session starts; its catalog is not readable from outside",
    # the window components: drawn in the browser, not through bb or a route
    "n837": "internal: AttachmentPreview is a window component; a person sees it in the browser, the scene has no browser",
    "n896": "internal: the accounts window of the account-pool plugin (component); plugin disabled on the hub",
    "n897": "internal: the account row of the account-pool plugin (component); plugin disabled on the hub",
    "n898": "internal: the add-account menu of the account-pool plugin (component); plugin disabled on the hub",
    # plugin disabled on the hub: enabling it is the owner's decision
    "n596": "plugin account-pool is disabled on the hub (bb plugin list); enabling it is the owner's decision, and its add writes a real account record",
    "n597": "plugin account-pool is disabled on the hub; the launch environment of a thread is not readable from outside either",
    "n598": "plugin account-pool is disabled on the hub; the account secret file is on the machine, not readable through bb",
    "n812": "plugin account-pool is disabled on the hub; its add command writes a real account into the owner's pool",
    "n1677": "plugin provider-usage is disabled on the hub (selectUsageResources is its code); `bb settings usage` is n1412's source",
    # needs a fixture on the core side: the only way to see it is a change of hub state no scene may make
    "n676": "needs a core-side fixture: the lockout of the owner pairing burns the code of the real owner login; a scene may not make wrong attempts against it",
    "n707": "needs a core-side fixture: minting an invitation writes a real one-shot key into the hub's key table",
    "n708": "needs a core-side fixture: the book holds real invitations; a one-shot code can be seen only by minting and spending one",
    "n709": "needs a core-side fixture: a joining machine creates a machine row and credentials; removal must follow it",
    "n711": "needs a core-side fixture: the register is written only by an accepted enrollment (the refused one writes nothing, but that is half of the card)",
    "n712": "needs a core-side fixture: letting a machine go revokes credentials of a real machine; only a machine the scene enrolled itself may be removed",
    "n693": "needs a core-side fixture: the library write needs a skill of the library to write to (there is no create command); only the refusal of a stale revision is readable",
    "n1351": "needs a core-side fixture: a new workspace appears when a thread is spawned with a worktree environment, which costs a model turn and has no create command",
    "n612": "needs a core-side fixture: the sandbox and approval policy ride a real Codex turn (a model call)",
}


def _http_base() -> str | None:
    base = os.environ.get("LP_DRILL_HUB_URL") or os.environ.get("BB_SERVER_URL")
    if not base:
        _, out, _ = run_bb("--help", timeout=60)
        found = re.search(r"BB_SERVER_URL:\s*(\S+)", out)
        base = found.group(1) if found else None
    return base.rstrip("/") if base else None


def _http(base: str, method: str, path: str, body=None, raw: str | None = None, timeout: int = 60) -> tuple[int, object]:
    """One request to the hub's HTTP routes; (status, parsed JSON or text). A gateway answer (502-504) or a dropped connection is asked again twice."""
    data = raw.encode() if raw is not None else (json.dumps(body).encode() if body is not None else None)
    last: tuple[int, object] = (0, "no answer")
    for attempt in range(3):
        request = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json"} if data is not None else {})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as answer:
                status, text = answer.status, answer.read().decode("utf8", "replace")
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read().decode("utf8", "replace")
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last = (0, str(error)[:120])
            time.sleep(5)
            continue
        try:
            parsed: object = json.loads(text)
        except ValueError:
            parsed = text[:200]
        last = (status, parsed)
        if status in (502, 503, 504):
            time.sleep(5)
            continue
        return last
    return last


def _bbj(*args: str, timeout: int = 120):
    """`bb ... --json` -> parsed JSON, or None when the command failed (the failure text is not kept: it can name an account)."""
    rc, out, _ = run_bb(*args, "--json", timeout=timeout)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def _core_build(skills: list[dict]) -> str:
    """The running core build, from where bb shows it: the runtime folder in a builtin plugin's skill path («bb-server-runtime-0.48.1-vk.6»), else `bb settings version`."""
    for skill in skills:
        found = re.search(r"bb-server-runtime-([0-9][^/\\]*)", str(skill.get("filePath", "")))
        if found:
            return found.group(1)
    version = _bbj("settings", "version") or {}
    return str(version.get("currentVersion") or "unknown")


def scenario_sma_core(tmp) -> dict:
    proofs = Proofs()
    not_proved: dict[str, str] = dict(NOT_PROVED)
    problems: list[str] = []
    sandbox, nogit = SANDBOX["project"], os.environ.get("LP_DRILL_NOGIT_PROJECT", "proj_cpxzk7r2vs")

    projects = _bbj("project", "list")
    base = _http_base()
    if not isinstance(projects, list):
        reason = "the hub did not answer `bb project list`: nothing of the core can be seen from this machine"
        return proofs.verdict("sma_core", [reason], notProved={**not_proved, **{n: reason for n in NODES}})
    plugin_rows = _bbj("plugin", "list") or []
    plugin_rows = plugin_rows.get("plugins", []) if isinstance(plugin_rows, dict) else plugin_rows
    running = [p["id"] for p in plugin_rows if isinstance(p, dict) and p.get("status") == "running"]
    skills = (_bbj("skill", "list", "--project", sandbox, timeout=180) or {}).get("skills", [])
    core_build = _core_build(skills)

    def skip(node: str, why: str) -> None:
        not_proved[node] = why

    # ---- the hub's HTTP routes: doors that refuse before they touch anything -------------------------------------------------------------
    if base is None:
        for node in ("n673", "n680", "n531", "n532", "n540", "n725"):
            skip(node, "no hub URL: BB_SERVER_URL is not set on this machine and `bb --help` does not show it")
    else:
        # n673 The plugin door: a closed table behind one dispatcher. A declared method is answered; an unknown plugin, an undeclared method and a body that is not JSON are refused with a fixed status.
        plugin = "lane-pilot" if "lane-pilot" in running else (running[0] if running else "")
        s_plug, b_plug = _http(base, "POST", "/api/v1/plugins/sma-core-nobody/rpc/ping", {})
        s_meth, b_meth = _http(base, "POST", f"/api/v1/plugins/{plugin}/rpc/sma_core_not_in_the_table", {})
        s_json, b_json = _http(base, "POST", f"/api/v1/plugins/{plugin}/rpc/ping", raw="{")
        env_id = SANDBOX["environment"]
        s_ok, b_ok = _http(base, "POST", "/api/v1/plugins/bb--git/rpc/branches", {"environmentId": env_id, "limit": 5}) if "bb--git" in running else (0, "bb--git not running")
        refused = (s_plug == 404 and b_plug == {"ok": False, "error": 'unknown plugin "sma-core-nobody"'}
                   and s_meth == 404 and b_meth == {"ok": False, "error": {"code": "unknown_method", "message": f'plugin "{plugin}" has no rpc method "sma_core_not_in_the_table"'}}
                   and s_json == 400 and isinstance(b_json, dict) and b_json.get("ok") is False and (b_json.get("error") or {}).get("code") == "invalid_json")
        answered = s_ok == 200 and isinstance(b_ok, dict) and b_ok.get("ok") is True
        if not plugin:
            skip("n673", "no running plugin on the hub to ask for an undeclared method")
        elif not answered and refused:
            skip("n673", f"the refusals are as the card says, but the declared method (bb--git branches) was not answered here: HTTP {s_ok}")
        else:
            proofs.prove("n673", refused and answered, f"unknown plugin {s_plug} {b_plug}; undeclared method of {plugin} {s_meth} {(b_meth or {}).get('error', {}).get('code') if isinstance(b_meth, dict) and isinstance(b_meth.get('error'), dict) else b_meth}; body «{{» {s_json}; declared bb--git branches {s_ok} ok={b_ok.get('ok') if isinstance(b_ok, dict) else b_ok}")

        # n680 Constant 401 answer: every refusal at the internal door is the same body, no reason and no route.
        attempts = [("POST", "/internal/session/open", {}), ("POST", "/internal/session/open", {"authorization": "Basic abc"}), ("POST", "/internal/session/open", {"authorization": "Bearer "}),
                    ("POST", "/internal/no-such-route", {}), ("POST", "/internal/no-such-route/", {}), ("POST", "/internal/hosts/enroll", {"authorization": "Bearer bbde_sma-core-not-a-real-code"})]
        enroll_body = {"hostId": "host_sma_core_drill_none", "hostName": "sma core drill"}  # a whole body: the door checks the body before the key
        answers = []
        for method, path, headers in attempts:
            request = urllib.request.Request(base + path, data=json.dumps(enroll_body if path == "/internal/hosts/enroll" else {}).encode(), method=method, headers={"content-type": "application/json", **headers})
            try:
                with urllib.request.urlopen(request, timeout=60) as answer:
                    answers.append((answer.status, answer.read().decode("utf8", "replace")))
            except urllib.error.HTTPError as error:
                answers.append((error.code, error.read().decode("utf8", "replace")))
            except (urllib.error.URLError, TimeoutError, OSError):
                answers.append((0, "no answer"))
        bodies = {text for _, text in answers}
        if any(code == 0 for code, _ in answers):
            skip("n680", "the hub did not answer every attempt at the internal door")
        else:
            same = all(code == 401 for code, _ in answers) and len(bodies) == 1 and json.loads(next(iter(bodies))) == UNAUTHORIZED
            proofs.prove("n680", same, f"{len(answers)} refusals (no key, Basic, empty Bearer, unknown routes, a made-up enroll code): statuses {sorted({c for c, _ in answers})}, distinct bodies {len(bodies)} = {next(iter(bodies))[:80]}")

        # n531 Conversation list: one project and the archived flag are taken; a list of more ids than the cap, a bad flag and a negative limit are refused.
        ids = lambda n: ",".join(f"thr_sma_core_{i}" for i in range(n))  # noqa: E731
        s_flag, b_flag = _http(base, "GET", "/api/v1/threads?archived=maybe")
        s_cap, b_cap = _http(base, "GET", f"/api/v1/threads?threadIds={ids(201)}")
        s_at, b_at = _http(base, "GET", f"/api/v1/threads?threadIds={ids(200)}")
        s_neg, _ = _http(base, "GET", "/api/v1/threads?limit=-1")
        s_one, b_one = _http(base, "GET", f"/api/v1/threads?projectId={sandbox}&archived=false&limit=3")
        one_ok = s_one == 200 and isinstance(b_one, list) and len(b_one) <= 3 and all(t.get("projectId") == sandbox for t in b_one)
        ok = (s_flag == 400 and s_cap == 400 and "at most 200" in str(b_cap) and s_at == 200 and b_at == [] and s_neg == 400 and one_ok)
        proofs.prove("n531", ok, f"archived=maybe {s_flag}; 201 ids {s_cap} «{(b_cap or {}).get('message') if isinstance(b_cap, dict) else b_cap}»; 200 ids {s_at} {b_at}; limit=-1 {s_neg}; one project, limit 3 -> {len(b_one) if isinstance(b_one, list) else b_one} rows all in it {one_ok}")

        # n532 Conversation name by hand — DIAGNOSTIC ONLY (CSP-01): the refusals and the 404 on a missing thread are real
        # schema observations, but a 404 before the lookup proves neither the persisted rename nor the unchanged transcript
        # nor the card's 60-character limit (core 0.49 accepts a nonempty title of any length). Not proved until an
        # authorized real-thread fixture reads the rename back.
        s_empty, b_empty = _http(base, "PATCH", f"/api/v1/threads/{GONE}", {"title": ""})
        s_none, b_none = _http(base, "PATCH", f"/api/v1/threads/{GONE}", {})
        s_good, b_good = _http(base, "PATCH", f"/api/v1/threads/{GONE}", {"title": "x"})
        s_long, _ = _http(base, "PATCH", f"/api/v1/threads/{GONE}", {"title": "a" * 61})
        code_of = lambda b: b.get("code") if isinstance(b, dict) else b  # noqa: E731
        skip("n532", f"diagnostic only: title «» {s_empty} {code_of(b_empty)}; empty body {s_none} {code_of(b_none)}; good title on no thread {s_good} {code_of(b_good)}; 61-char title {s_long}. "
                     "404 proves no persisted rename or transcript invariant; the 60-char card effect stays unproved")

        # n540 Conversation turn through the door — DIAGNOSTIC ONLY (CSP-01): refusals and the 404 are real schema
        # observations, but a stripped-vs-preserved extra field and the 8 KB card limit are not observable through a
        # missing thread (the registered mutation z.object -> z.looseObject would pass this predicate unchanged).
        item = [{"type": "text", "text": "x"}]
        s_a, b_a = _http(base, "POST", f"/api/v1/threads/{GONE}/send", {})
        s_b, b_b = _http(base, "POST", f"/api/v1/threads/{GONE}/send", {"input": [], "mode": "queue-if-active"})
        s_c, b_c = _http(base, "POST", f"/api/v1/threads/{GONE}/send", {"input": item})
        s_d, b_d = _http(base, "POST", f"/api/v1/threads/{GONE}/send", {"input": item, "mode": "queue-if-active", "smuggled": "x", "cwd": "/etc"})
        s_big, _ = _http(base, "POST", f"/api/v1/threads/{GONE}/send", {"input": [{"type": "text", "text": "a" * 9000}], "mode": "queue-if-active"})
        skip("n540", f"diagnostic only: empty body {s_a}; input [] {s_b}; no mode {s_c}; whole body on no thread {s_d} {code_of(b_d)}; 9 KB body {s_big}. "
                     "Dropped fields and the 8 KB card effect are not observable through a 404; stays unproved")

        # n725 Select the active project: there is no switch; GET /projects?include=threads nests each project's own
        # threads (buildProjectsWithThreadsResponse) and the nesting must equal the per-project thread list — nonvacuous,
        # distinct groups only (CSP-03: a swapped group must fail this predicate).
        g_status, grouped = _http(base, "GET", "/api/v1/projects?include=threads")
        if g_status != 200 or not isinstance(grouped, list):
            skip("n725", f"GET /api/v1/projects?include=threads answered {g_status}: the nested grouping the card is about is not readable")
        else:
            by_id = {p.get("id"): p for p in grouped if isinstance(p, dict)}
            nested: dict[str, set] = {}
            direct: dict[str, set] = {}
            per_ok = True
            foreign = 0
            for project in (sandbox, nogit):
                entry = by_id.get(project) or {}
                nested_rows = [t for t in (entry.get("threads") or []) if isinstance(t, dict)]
                foreign += sum(1 for t in nested_rows if t.get("projectId") != project)
                d_status, d_rows = _http(base, "GET", f"/api/v1/threads?projectId={project}&archived=false&limit=500")
                time.sleep(1)
                direct_rows = d_rows if d_status == 200 and isinstance(d_rows, list) else []
                nested[project] = {t.get("id") for t in nested_rows}
                direct[project] = {t.get("id") for t in direct_rows}
                per_ok = per_ok and d_status == 200 and foreign == 0 and not any(t.get("projectId") != project for t in direct_rows) and nested[project] == direct[project]
            if len(direct[sandbox]) >= 500 or len(direct[nogit]) >= 500:
                skip("n725", f"a direct list reached the 500 bound (sandbox {len(direct[sandbox])}, nogit {len(direct[nogit])}): the comparison would be paginated, not proven")
            elif not nested[sandbox] or not nested[nogit]:
                skip("n725", f"a nested group is empty (sandbox {len(nested[sandbox])}, nogit {len(nested[nogit])}): project separation cannot be shown non-vacuously")
            else:
                ok = per_ok and not (nested[sandbox] & nested[nogit])
                proofs.prove("n725", ok, f"nested groups == direct archived=false lists: sandbox {len(nested[sandbox])} threads, nogit {len(nested[nogit])}; foreign projectIds in groups {foreign}; disjoint {not (nested[sandbox] & nested[nogit])}")

    # ---- the bb CLI -----------------------------------------------------------------------------------------------------------------------
    # n728 Default project: a project's folder is its default source; every project that has sources has exactly one default.
    with_sources = [p for p in projects if p.get("sources")]
    defaults = [sum(1 for s in p["sources"] if s.get("isDefault")) for p in with_sources]
    default_ok = bool(with_sources) and all(n == 1 for n in defaults)

    # n694 Two skill stores: project skills and the machine library; each listed skill names its own.
    shown = _bbj("project", "show", sandbox) or {}
    roots = [str(s.get("path", "")).rstrip("/\\") for s in shown.get("sources", []) if s.get("path")]
    stores = {s.get("scope") for s in skills}
    library = [s for s in skills if s.get("scope") == "bb-user"]
    project_level = [s for s in skills if s.get("scope") in ("bb-project", "provider-project")]
    in_library = all(re.search(r"[/\\]\.bb[/\\]skills[/\\]", str(s.get("filePath", ""))) for s in library)
    in_project = all(any(str(s.get("filePath", "")).startswith(root) for root in roots) for s in project_level)
    if skills and library and project_level:
        proofs.prove("n694", all(s.get("scope") and s.get("filePath") for s in skills) and in_library and in_project, f"{len(skills)} skills in stores {sorted(map(str, stores))}: {len(library)} of the machine library all under .bb/skills {in_library}, {len(project_level)} of the project all under its folders {in_project}")
    else:
        skip("n694", f"the sandbox project showed {len(skills)} skills, {len(library)} of the library and {len(project_level)} of the project: two stores are not both there to compare")

    # n1352 list-workspaces: environments come oldest first, can be narrowed by project and status and paged.
    head = _bbj("environment", "list", "--limit", "6") or []
    page = _bbj("environment", "list", "--limit", "3", "--offset", "3") or []
    by_project = _bbj("environment", "list", "--project", sandbox, "--limit", "20") or []
    by_status = _bbj("environment", "list", "--status", "ready", "--limit", "20") or []
    times = [e.get("createdAt") for e in head]
    paged = [e.get("id") for e in page] == [e.get("id") for e in head[3:6]]
    if len(head) >= 4:
        ok = times == sorted(times) and paged and by_project and all(e.get("projectId") == sandbox for e in by_project) and by_status and all(e.get("status") == "ready" for e in by_status)
        proofs.prove("n1352", bool(ok), f"first {len(head)} oldest first {times == sorted(times)}; limit 3 offset 3 equals rows 4-6 of the first six {paged}; project filter {len(by_project)} rows all of it; status filter {len(by_status)} rows all ready")
    else:
        skip("n1352", f"the hub listed only {len(head)} environments: not enough to show paging")

    # n1412 Subscription window figure for the daemon — DIAGNOSTIC ONLY (CSP-02): `bb settings usage` reaches
    # system.usageLimits directly and never runs the mapped provider-claude-code usage-source wrapper (its accountKey
    # copy and failure shape stay unobserved), and no failed read happened, so the vacuous-truth failure branch is not
    # covered either. The observation is kept as a diagnostic; the node stays notProved until the registered
    # usage-source consumer is observed.
    usage = _bbj("settings", "usage", timeout=180)
    if isinstance(usage, dict) and "claude-code" in usage:
        reads = {k: v for k, v in usage.items() if isinstance(v, dict)}
        good = {k: v for k, v in reads.items() if v.get("status") == "ok"}
        broken = {k: v for k, v in reads.items() if v.get("status") != "ok"}
        skip("n1412", f"diagnostic only: `bb settings usage` bypasses the mapped usage-source wrapper — {len(reads)} providers read upstream, {len(good)} with figures, {len(broken)} failed reads; "
                      "wrapper execution, the accountKey transform and the failed-read branch remain unobserved")
    else:
        skip("n1412", "`bb settings usage` did not answer with a claude-code reading; the mapped usage-source wrapper was not observed either way")

    # n616 Is the vendor program present: the maintenance status resolves the program's name on the machine's PATH: a full path where it is, nothing where it is not.
    machines = [m for m in (_bbj("machine", "list") or []) if isinstance(m, dict) and m.get("status") == "connected"]
    resolved, absent, asked = 0, [], 0
    shape_ok = True
    for machine in machines[:4]:
        rows = _bbj("machine", "provider-cli", "status", str(machine.get("id")), timeout=180)
        time.sleep(1)
        if not isinstance(rows, dict):
            continue
        asked += 1
        for provider, row in rows.items():
            if provider not in RESOLVED_BY_KIT:
                continue
            path = row.get("executablePath")
            if row.get("installed"):
                resolved += 1
                shape_ok = shape_ok and isinstance(path, str) and bool(re.match(r"^(/|[A-Za-z]:\\)", path))
            else:
                absent.append(provider)
                shape_ok = shape_ok and path is None
    if asked and resolved and absent:
        proofs.prove("n616", shape_ok, f"{asked} connected machines asked: {resolved} provider programs resolved to a full path, {len(absent)} not found resolve to nothing ({', '.join(sorted(set(absent)))})")
    else:
        skip("n616", f"{asked} machines answered, {resolved} programs found, {len(absent)} absent: the negative half (a name that is not there) needs a machine that lacks a provider program")

    # ---- the fixture: a project the scene adds, renames and removes itself ---------------------------------------------------------------
    fixture = _project_fixture(tmp, projects, base) if os.environ.get(ENV_WRITES) == "1" else None
    if fixture is None:
        why = f"own fixture, not run: set {ENV_WRITES}=1 on the drill machine (the scene then adds two projects «{FIXTURE_PREFIX}…» and deletes them)"
        skip("n723", why)
        skip("n724", why)
        proofs.prove("n728", default_ok, f"{len(with_sources)} projects with sources, each has exactly one default source {default_ok} (read only: the explicit --root / no-explicit-default creation check runs with {ENV_WRITES}=1)")
    else:
        if fixture.get("error"):
            problems.append(f"project fixture: {fixture['error']}")
            for node in ("n723", "n724"):
                skip(node, fixture["error"])
            proofs.prove("n728", default_ok, f"{len(with_sources)} projects with sources, each has exactly one default source {default_ok} (the fixture failed: no creation check)")
        else:
            proofs.prove("n723", fixture["add_ok"], fixture["add_detail"])
            proofs.prove("n724", fixture["rename_ok"], fixture["rename_detail"])
            proofs.prove("n728", default_ok and fixture["default_ok"], f"{len(with_sources)} projects with sources, each has exactly one default source {default_ok}; a project created with an explicit --root source and no explicit default selection: {fixture['default_detail']}")

    not_proved.update(prove_last(proofs, tmp))
    fixture_receipt = None if fixture is None else {"cleanup": fixture.get("cleanup"), "cleanupOk": fixture.get("cleanup_ok")}
    return proofs.verdict("sma_core", problems, notProved=not_proved, coreBuild=core_build, hubUrl=bool(base), projectFixture=fixture_receipt)


def _project_fixture(tmp, before: list[dict], base: str) -> dict:
    """Two projects with one name and two folders, one renamed, then both deleted. Never touches a project the scene did not create.
    The machine is resolved to exactly one connected host BEFORE anything is created — missing or ambiguous means no fixture.
    Both projects are read back: exact name, canonical source path and that host binding (CSP-05); the second must stay
    unchanged by the first's rename. Cleanup deletes only own, empty fixtures and counts a project gone only on an actual
    GET /projects/<id> 404 project_not_found; a transport or auth failure is unknown, never claimed. The receipt keeps the
    minted ids, paths and the cleanup result; a failed cleanup downgrades every fixture-derived ok."""
    name = f"{FIXTURE_PREFIX}{uuid.uuid4().hex[:8]}"
    machine = os.environ.get("LP_DRILL_SMA_CORE_MACHINE", "OVH")
    machines = _bbj("machine", "list") or []
    matches = [str(m.get("id")) for m in machines if isinstance(m, dict) and m.get("status") == "connected" and (m.get("name") == machine or m.get("id") == machine)]
    out: dict = {}
    if len(matches) != 1:
        out["error"] = f"machine {machine!r} resolves to {len(matches)} connected hosts {matches}: no fixture is created"
        return out
    host_id = matches[0]
    root_a, root_b = Path(tmp) / "project-a", Path(tmp) / "project-b"
    root_a.mkdir(parents=True, exist_ok=True)
    root_b.mkdir(parents=True, exist_ok=True)
    created: list[str] = []
    try:
        made = []
        for root in (root_a, root_b):
            data = _bbj("project", "create", "--name", name, "--root", str(root), "--machine", machine)
            project = (data or {}).get("project", data) if isinstance(data, dict) else None
            if not isinstance(project, dict) or not project.get("id"):
                out["error"] = f"`bb project create` on machine {machine} did not return a project" if not created else "the second `bb project create` failed"
                return out
            created.append(project["id"])
            made.append(project)
        first, second = made
        shown_a = _bbj("project", "show", first["id"]) or {}
        shown_b = _bbj("project", "show", second["id"]) or {}
        canon_a, canon_b = os.path.realpath(str(root_a)), os.path.realpath(str(root_b))
        readback = {}
        binding_ok = True
        for tag, shown, canon in (("a", shown_a, canon_a), ("b", shown_b, canon_b)):
            sources = shown.get("sources") or []
            single = sources[0] if len(sources) == 1 and isinstance(sources[0], dict) else {}
            path_ok = bool(single.get("path")) and os.path.realpath(str(single.get("path"))) == canon
            host_ok = single.get("hostId") == host_id
            binding_ok = binding_ok and shown.get("name") == name and path_ok and host_ok
            readback[tag] = {"id": shown.get("id"), "name": shown.get("name"), "path": single.get("path"), "hostId": single.get("hostId"),
                             "isDefault": single.get("isDefault"), "sources": len(sources)}
        host_ids = [readback["a"]["hostId"], readback["b"]["hostId"]]
        host_bound = host_ids[0] == host_id and host_ids[1] == host_id
        out["add_ok"] = (bool(re.match(r"^proj_", first["id"])) and bool(re.match(r"^proj_", second["id"])) and first["id"] != second["id"]
                         and binding_ok and host_bound)
        out["add_detail"] = (f"ids {first['id']} {second['id']}; names stored {readback['a']['name']!r} / {readback['b']['name']!r}; "
                             f"canonical source paths {canon_a} / {canon_b} stored {readback['a']['path']!r} / {readback['b']['path']!r}; "
                             f"host binding {host_ids[0]} (machine {machine} resolves to {host_id})")
        out["default_ok"] = all(readback[t]["sources"] == 1 and readback[t]["isDefault"] is True for t in ("a", "b"))
        out["default_detail"] = f"explicit --root source on each, no explicit default selection; isDefault {readback['a']['isDefault']} / {readback['b']['isDefault']}, one source each {out['default_ok']}"
        renamed = _bbj("project", "update", first["id"], "--name", name + "-renamed")
        again_a = _bbj("project", "show", first["id"]) or {}
        again_b = _bbj("project", "show", second["id"]) or {}
        out["rename_ok"] = (isinstance(renamed, (dict, list))
                            and again_a.get("id") == first["id"] and again_a.get("name") == name + "-renamed" and again_a.get("sources") == shown_a.get("sources")
                            and again_b.get("id") == second["id"] and again_b.get("name") == name and again_b.get("sources") == shown_b.get("sources"))
        out["rename_detail"] = (f"ids {first['id']} {second['id']}: first keeps its id {again_a.get('id') == first['id']}, takes the new name {again_a.get('name') == name + '-renamed'}, sources unchanged {again_a.get('sources') == shown_a.get('sources')}; "
                                f"second untouched: same id {again_b.get('id') == second['id']}, name still {again_b.get('name') == name}, sources unchanged {again_b.get('sources') == shown_b.get('sources')}")
        return out
    finally:
        cleanup = []
        for project_id in created:
            shown = _bbj("project", "show", project_id) or {}
            rows = _bbj("thread", "list", "--project", project_id)
            own_empty = str(shown.get("name", "")).startswith(FIXTURE_PREFIX) and rows == []
            deleted = False
            if own_empty:
                rc, _, _ = run_bb("project", "delete", project_id, "--yes", timeout=120)
                deleted = rc == 0
            s_gone, b_gone = _http(base, "GET", f"/api/v1/projects/{project_id}") if base else (0, None)
            err = b_gone.get("error") if isinstance(b_gone, dict) and isinstance(b_gone.get("error"), dict) else b_gone
            gone = s_gone == 404 and isinstance(err, dict) and err.get("code") == "project_not_found"
            cleanup.append({"id": project_id, "ownEmpty": own_empty, "deleted": deleted, "gone": gone})
        out["cleanup"] = cleanup
        out["cleanup_ok"] = len(cleanup) == len(created) and all(c["ownEmpty"] and c["deleted"] and c["gone"] for c in cleanup)
        for key in ("add_ok", "rename_ok", "default_ok"):
            if isinstance(out.get(key), bool):
                out[key] = out[key] and out["cleanup_ok"]
