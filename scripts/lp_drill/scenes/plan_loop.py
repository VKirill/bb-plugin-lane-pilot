"""The planner <-> critic loop on direct dispatch: plan_revise, plan_revise_cap, plan_l.

The plan of a direct dispatch (bb lane-pilot dispatch-bb) is the task's objective (src/rooms/writer/server/dispatch.ts: args.plan ?? objective),
so a plan defect is planted in the objective text. Each scene sets its own project settings and puts them back (lp_drill.scoped_settings)."""
from __future__ import annotations

import re
import shlex

from lp_drill.env import STAMP
from lp_drill.hub import hubsql
from lp_drill.report import summarize, verdict
from lp_drill.scoped_settings import scoped_settings
from lp_drill.tasks import task

# plan_revise: risk high, so the critic runs on the task's own risk (plan_critique.on_high_risk) and min_score stays at its default.
PLAN_REVISE_SETTINGS = {"plan_critique.enabled": True, "plan_critique.revise_by": "planner"}
# plan_revise_cap: risk high as well; the structural finding blocks before any model is asked.
PLAN_REVISE_CAP_SETTINGS = {"plan_critique.enabled": True, "plan_critique.revise_by": "planner"}
# plan_l: risk medium and one task, so only owns_paths >= 8 can bring the critic; min_score / min_write_tasks stay at their defaults.
PLAN_L_SETTINGS = {"plan_critique.enabled": True, "plan_critique.min_owns_paths": 8}
PLAN_L_PATHS = 8
REVISION = re.compile(r"^planner_revision:(\d+)/(\d+)$")


def _check(paths: list[str], cwd: str) -> list[dict]:
    """One check for every file: red on the base, green once each file's first line is its own heading."""
    command = " && ".join(f"test \"$(sed -n 1p {shlex.quote(p)})\" = {shlex.quote('# ' + p.rsplit('/', 1)[-1])}" for p in paths)
    return [{"command": command, "cwd": cwd}]


def plan_revise_task(ctx: "Context") -> dict:
    """Both files are expected and owned, the acceptance and the check ask for both, and the plan (the objective) names a step for the first
    only: the critic should return the plan, and the planner can fix it by editing the plan text alone."""
    first, second = f"notes/drill/plan-revise-{STAMP}/alpha.md", f"notes/drill/plan-revise-{STAMP}/beta.md"
    return task(f"drill-{STAMP}-plan-revise", f"Drill {STAMP} plan revise: two notes", [first, second],
                f"Create the file {first} with exactly one line: `# alpha.md`. That is the whole job; nothing else is created.",
                [f"{first} exists and its first line is `# alpha.md`.", f"{second} exists and its first line is `# beta.md`."], ctx.cwd,
                verification=_check([first, second], ctx.cwd))


def plan_revise_cap_task(ctx: "Context") -> dict:
    """A defect in a field only the PM may change: an acceptance line still holds the template's REPLACE_ME. The plan critique finds it
    structurally (task_placeholder, an error) before any model is asked, and the planner may not touch acceptance, so the task goes straight
    to the PM. Not a self-dependency or an expected output outside owns_paths: the dispatch lint refuses both (depends_self, output_unowned)
    before the plan critique ever runs, so the scene would test the lint."""
    first = f"notes/drill/plan-cap-{STAMP}/note.md"
    return task(f"drill-{STAMP}-plan-cap", f"Drill {STAMP} plan cap: an unwritten acceptance", [first],
                f"Create the file {first} with exactly one line: `# note.md`. Nothing else.",
                [f"{first} exists and its first line is `# note.md`.", "REPLACE_ME: the second check the PM has not written yet."], ctx.cwd,
                verification=_check([first], ctx.cwd))


def plan_l_task(ctx: "Context") -> dict:
    """A medium-risk single task with exactly eight owns_paths."""
    paths = [f"notes/drill/plan-l-{STAMP}/part{n}.md" for n in range(1, PLAN_L_PATHS + 1)]
    return task(f"drill-{STAMP}-plan-l", f"Drill {STAMP} plan l: eight notes", paths,
                "Create each of these files with exactly one line, its own file name as a heading (`# partN.md`): " + ", ".join(paths) + ". Nothing else.",
                ["Each of the eight files exists and its first line is `# partN.md`."], ctx.cwd, risk="medium",
                verification=_check(paths, ctx.cwd))


def plan_loop_evidence(ctx: "Context", task_id: str) -> dict:
    """What the loop left on the hub for one task: contract editions, the plan-critique receipt, the plan-revise steps of the pipeline run."""
    quoted = task_id.replace("'", "''")
    editions = hubsql(f"select edition, reason from lane_pilot_task_contract_edition where task_id='{quoted}' order by edition;")
    receipts = hubsql(f"select state, reason, result_json from lane_pilot_stage_receipt where run_id='{ctx.run_id}' and task_id='{quoted}' and stage_id='plan-critique' order by updated_at;")
    steps = hubsql("select s.node_id as node_id, s.state as state from lane_pilot_wf_step s join lane_pilot_wf_run r on r.id=s.run_id "
                   f"where r.workflow_id='lp-task-pipeline' and r.link_task_id='{quoted}' order by s.rowid;")
    return {"editions": editions, "receipts": receipts, "steps": steps}


def revisions_of(evidence: dict) -> list[str]:
    return [str(row.get("reason") or "") for row in evidence.get("editions") or [] if str(row.get("reason") or "").startswith("planner_revision:")]


def revise_problems(row: dict, evidence: dict) -> list[str]:
    """plan_revise: the planner fixed the plan, the critic passed it, the writer ran, the PM was not involved."""
    problems: list[str] = []
    revisions = revisions_of(evidence)
    if not revisions:
        problems.append("no planner_revision edition: the critic never returned the plan, or the planner never revised it")
    for reason in revisions:
        match = REVISION.match(reason)
        if not match or not 1 <= int(match.group(1)) <= int(match.group(2)):
            problems.append(f"an edition reason is not planner_revision:<n>/<max>: {reason}")
    if not any(step.get("node_id") == "plan-revise" for step in evidence.get("steps") or []):
        problems.append("the pipeline journal has no plan-revise step")
    receipts = evidence.get("receipts") or []
    if not receipts or receipts[-1].get("state") != "passed":
        problems.append(f"the final plan-critique receipt is not passed: {[(r.get('state'), r.get('reason')) for r in receipts]}")
    if "blocked" in (row.get("states") or []):
        problems.append(f"the attempt went blocked (the PM would have been involved): {row.get('states')} {row.get('reason')}")
    if row.get("state") != "accepted":
        problems.append(f"the task did not land: {row.get('states')} {row.get('reason')}")
    return problems


def cap_problems(row: dict, evidence: dict) -> list[str]:
    """plan_revise_cap: blocked at once on the structural finding, the planner never asked."""
    problems: list[str] = []
    reason = str(row.get("reason") or "")
    if row.get("state") != "blocked":
        problems.append(f"the attempt is not blocked: {row.get('states')} {reason}")
    elif not (reason.startswith("structural_plan_critique_blocked") or reason.startswith("plan_critique")):
        problems.append(f"the block does not name the plan critique: {reason}")
    if revisions_of(evidence):
        problems.append(f"a planner_revision edition exists although acceptance is not the planner's to fix: {revisions_of(evidence)}")
    if any(step.get("node_id") == "plan-revise" for step in evidence.get("steps") or []):
        problems.append("the pipeline journal has a plan-revise step for a finding the planner may not fix")
    return problems


def plan_l_problems(row: dict, evidence: dict) -> list[str]:
    """plan_l: the critic ran (passed or blocked), it was not skipped below the threshold; the wording of its reason is not asserted."""
    receipts = evidence.get("receipts") or []
    if not receipts:
        return ["no plan-critique receipt"]
    problems = []
    last = receipts[-1]
    if last.get("state") == "skipped" or any(r.get("state") == "skipped" and r.get("reason") == "below_critique_threshold" for r in receipts):
        problems.append(f"the plan critique was skipped with eight owns_paths and min_owns_paths=8: {last.get('state')} {last.get('reason')}")
    elif last.get("state") not in ("passed", "blocked"):
        problems.append(f"the plan critique did not finish: {last.get('state')} {last.get('reason')}")
    if row.get("state") not in ("accepted", "blocked"):
        problems.append(f"the task did not end: {row.get('states')} {row.get('reason')}")
    return problems


def run_loop_task(ctx: "Context", spec: dict, settings: dict, judge) -> tuple[dict, dict, list[str]]:
    """Dispatches one task under the scene's settings (put back afterwards, an exception included) and judges what the hub holds."""
    problems: list[str] = []
    row: dict = {}
    evidence: dict = {}
    with scoped_settings(ctx, settings, problems):
        if not ctx.dispatch(spec):
            problems.append("dispatch-bb exited with an error")
        else:
            row = summarize(ctx.wait_ended([spec["id"]]), spec["id"], ctx.cwd, spec["expected_outputs"][0])
            evidence = plan_loop_evidence(ctx, spec["id"])
            problems += judge(row, evidence)
    return row, evidence, problems


def scenario_plan_revise(ctx: "Context") -> dict:
    """A plan with a planted hole (no step for beta.md, which is owned and expected) goes through the critic with plan_critique.revise_by=planner:
    the planner revises the plan text, the critic passes it, the writer lands the task, and the attempt is never blocked."""
    row, evidence, problems = run_loop_task(ctx, plan_revise_task(ctx), PLAN_REVISE_SETTINGS, revise_problems)
    return verdict("plan_revise", problems, tasks=[row] if row else [], editions=evidence.get("editions"), receipts=[r.get("state") for r in evidence.get("receipts") or []],
                   steps=[s.get("node_id") for s in evidence.get("steps") or []])


def scenario_plan_revise_cap(ctx: "Context") -> dict:
    """An unwritten acceptance line (REPLACE_ME) cannot be fixed by the planner: the attempt is blocked at once for the PM (structural_plan_critique_blocked),
    with no planner_revision edition and no plan-revise step."""
    row, evidence, problems = run_loop_task(ctx, plan_revise_cap_task(ctx), PLAN_REVISE_CAP_SETTINGS, cap_problems)
    return verdict("plan_revise_cap", problems, tasks=[row] if row else [], editions=evidence.get("editions"), receipts=[r.get("state") for r in evidence.get("receipts") or []],
                   steps=[s.get("node_id") for s in evidence.get("steps") or []])


def scenario_plan_l(ctx: "Context") -> dict:
    """A medium-risk single task with eight owns_paths gets the plan critic under plan_critique.min_owns_paths=8: the receipt is not skipped below the threshold."""
    row, evidence, problems = run_loop_task(ctx, plan_l_task(ctx), PLAN_L_SETTINGS, plan_l_problems)
    mentions = any("owns_paths" in str(r.get("reason") or "") + str(r.get("result_json") or "") for r in evidence.get("receipts") or [])
    return verdict("plan_l", problems, tasks=[row] if row else [], receipts=[(r.get("state"), r.get("reason")) for r in evidence.get("receipts") or []], namesOwnsPaths=mentions)
