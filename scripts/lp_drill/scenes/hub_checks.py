"""Hub-side checks needing no run: the lead shadow state and the episode store."""
from __future__ import annotations

import json

from lp_drill.hub import bb, hubsql, setting_rpc, RPC_MISSING
from lp_drill.report import verdict

def scenario_lead_shadow(tmp: Path) -> dict:
    """The lead («Штурман») in shadow (roadmap WP3/WP4 acceptance): the running plugin answers lead_state; the drill never switches
    lead.enabled on, so no tick runs by itself here; no class decides without an exam row or a policy start at decides, and money / external stay owner_only;
    the CLI's status, rights, exam and road read the same rows without an error. A tick's own run needs an agent and is checked on the live hub."""
    try:
        state = setting_rpc("lead_state", {})
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return verdict("lead_shadow", [], leadDeployed=False, note=f"the running plugin has no lead yet: {str(cause)[:160]}")
        return verdict("lead_shadow", [f"lead_state failed: {str(cause)[:200]}"])
    problems: list[str] = []
    rights = state.get("rights") or []
    tiers = {row.get("class"): row.get("tier") for row in rights}
    if len(rights) < 7:
        problems.append(f"the rights table lists {len(rights)} classes, the policy has 7")
    for row in rights:
        # Policy v2 (owner's word 2026-11-02) starts the safe classes at decides; a class may decide without an exam only
        # when the policy file starts it there — the exam alone must not open one the file keeps at proposes.
        if row.get("tier") == "decides" and not row.get("exam") and row.get("start") != "decides":
            problems.append(f"class {row.get('class')} decides without an exam row behind it or a policy start at decides")
    for cls in ("money", "external"):
        if tiers.get(cls) != "owner_only":
            problems.append(f"class {cls} is {tiers.get(cls)}, the policy keeps it owner_only")
    for args in (("status",), ("rights",), ("exam",), ("road", "--tree", "--history"), ("ticks",)):
        rc, out, err = bb("lane-pilot", "lead", *args)
        if rc != 0:
            problems.append(f"bb lane-pilot lead {' '.join(args)} exited {rc}: {(err or out).strip()[:160]}")
    settings = state.get("settings") or {}
    return verdict("lead_shadow", problems, leadDeployed=True, enabled=bool(settings.get("enabled")), tickCron=settings.get("tickCron"),
                   ticks=len(state.get("ticks") or []), proposalsOpen=state.get("proposalsOpen"), journal=state.get("journal"), tiers=tiers)


def scenario_episodes(tmp: Path) -> dict:
    """Errand episodes (stage 1 R1/R3/R5/R7): every errand run that ended after the episodes shipped has its episode row (the recorder
    hangs off the engine's onEvent, so a missing row is a dropped hook); a done run carries a parsed `verified`; the sweep moves rows out
    of pending within two hours; the diagnosis command answers. Reads the live hub, starts nothing."""
    try:
        first = hubsql("SELECT MIN(created_at) AS at FROM lane_pilot_errand_episode")
    except RuntimeError as cause:
        if "no such table" in str(cause):
            return verdict("episodes", [], episodesDeployed=False, note="the running plugin has no episode table yet")
        return verdict("episodes", [f"hub query failed: {str(cause)[:200]}"])
    since = (first[0] or {}).get("at") if first else None
    if not since:
        return verdict("episodes", [], episodesDeployed=True, note="no episode written yet: no errand ended since the deploy")
    problems: list[str] = []
    missing = hubsql(f"""SELECT r.id FROM lane_pilot_wf_run r WHERE r.workflow_id='errand' AND r.status IN
        ('succeeded','failed','canceled','blocked','interrupted','not_verified') AND r.updated_at >= {int(since)}
        AND NOT EXISTS (SELECT 1 FROM lane_pilot_errand_episode e WHERE e.run_id=r.id) LIMIT 5""")
    if missing:
        problems.append(f"{len(missing)}+ ended errand runs have no episode, e.g. {missing[0].get('id')}")
    # Recent = the errand RUN started after the first episode row and within 3 days: a backfilled row is new but its run predates
    # the `CHECK:` lines, so it has no verdict to parse. A pending row is stale only when the sweep enriched nothing for 2 h — a
    # backfill queues 100+ rows that the 10-per-hour sweep takes hours to clear.
    counts = hubsql(f"""SELECT COUNT(*) AS n,
        SUM(e.outcome='done' AND e.verified IS NULL AND r.created_at >= {int(since)} AND r.created_at > strftime('%s','now','-3 days')*1000) AS doneNoVerdict,
        SUM(e.enrichment_state='pending' AND e.created_at < (strftime('%s','now')-7200)*1000) AS stalePending,
        (SELECT COUNT(*) FROM lane_pilot_errand_episode WHERE enriched_at > (strftime('%s','now')-7200)*1000) AS enrichedRecently,
        SUM(e.enrichment_state='held') AS held
        FROM lane_pilot_errand_episode e LEFT JOIN lane_pilot_wf_run r ON r.id=e.run_id""")[0]
    if counts.get("doneNoVerdict"):
        problems.append(f"{counts['doneNoVerdict']} recent done episodes have no parsed verified outcome")
    if counts.get("stalePending") and not counts.get("enrichedRecently"):
        problems.append(f"{counts['stalePending']} episodes stayed pending for over 2 h: the sweep lp.episodes is not running")
    rc, out, err = bb("lane-pilot", "errands", "diagnose", "--json")
    if rc != 0:
        problems.append(f"bb lane-pilot errands diagnose exited {rc}: {(err or out).strip()[:160]}")
    return verdict("episodes", problems, episodesDeployed=True, episodes=counts.get("n"), held=counts.get("held"), since=since)
