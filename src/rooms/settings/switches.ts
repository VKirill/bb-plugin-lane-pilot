/**
 * Settings that have no row in the settings window: `bb lane-pilot setting` lists and sets them, so a behaviour that ships off can be
 * turned on at all. A key the window knows is set in the window. The scope says where a reader looks:
 * - `project`: the project's own row, else the hub-wide one (`global`);
 * - `project-only`: the project's own row, nothing is inherited;
 * - `global`: the hub-wide row only — a project row is never read, so the verb refuses to write one.
 */
export type SwitchScope = "project" | "project-only" | "global";
export const UNLISTED_SWITCHES: Readonly<Record<string, readonly [scope: SwitchScope, values: string, what: string]>> = {
  // phase (read once, when a phase is opened: phases already open keep what they were opened with)
  "phase.diagnose": ["project", "on|off", "a failed verdict is diagnosed by parallel debuggers before the replan (up to six model sessions per verdict)"],
  "phase.gray_areas": ["project", "on|off", "the analysis asks the owner which gray areas to discuss and runs an adviser per chosen area (up to six)"],
  "phase.research": ["project", "on|off", "the plan stage starts with a research step (one model session)"],
  "phase.pattern_map": ["project", "on|off", "the plan stage maps the code patterns the plan must follow (one model session)"],
  "phase.validation": ["project", "on|off", "the plan stage writes a validation strategy and an auditor reads it (one model session)"],
  "phase.draw_material": ["project", "on|off", "the drawing stage first collects design material (one model session)"],
  "phase.plan_bounce": ["project", "on|off", "an approved plan goes once more through plan-review-convergence; requested changes replan once"],
  "phase.design_points": ["project", "on|off", "every checkable item of UI-SPEC.md becomes an acceptance line the goal audit must answer"],
  "phase.doc_files": ["project", "on|off", "the phase writes STATE.md (its marked block), SPEC.md, PLAN.md and VERIFICATION.md into the project and commits them"],
  "phase.commit_docs": ["project", "on|off", "off: the phase's documents are written but not committed (unset commits, as before)"],
  "phase.ambiguity_gate": ["project", "on|off", "a plan is not admitted while the share of open planning questions is too high"],
  "phase.grill_gate": ["project", "on|off", "a plan grilled with open challenges is not admitted until the owner's word or a plan that answers them lifts it (unset: on)"],
  "phase.piece_notes": ["project", "on|off", "a piece's plan carries its predictions, risk and motion lines"],
  "phase.threat_closure": ["project", "on|off", "a passed blind verdict fails while a threat row has no file:line mitigation in the code"],
  "phase.branch": ["project", "none|phase|milestone", "a closed phase leaves a branch: phase/<id>, or milestone/<slug> of its roadmap section"],
  // graphs
  "ship.full_gate": ["project", "on|off", "ship stops while the full check is red or older than six hours"],
  "review.prepass": ["project", "strict|off", "strict: a suspicious line found by the review's scan without a model sends the work back; unset, the scan only leaves notes"],
  "retro.living": ["project", "on|off", "a retro updates the living retrospective file"],
  "milestone.archive": ["project", "on|off", "closing a milestone archives its phase folders"],
  "milestone.summary": ["project", "on|off", "closing a milestone writes MILESTONE-SUMMARY.md (one model session)"],
  "project.start_research": ["project", "on|off", "project start asks about the project, researches the stack and writes requirements (a question to the owner, two model sessions)"],
  // shipping
  "ship.watch": ["project-only", "on|off", "the hub posts an owner item when unshipped commits pile up past ship.max_batch_commits or ship.max_batch_days"],
  "ship.max_batch_commits": ["project-only", "number", "how many unshipped commits make a pile (with ship.watch)"],
  "ship.max_batch_days": ["project-only", "number", "how many days of unshipped commits make a pile (with ship.watch)"],
  // writers
  "writer.max_turns": ["project", "number", "a writer attempt is stopped at this many tool calls, its worktree kept (unset: 300; 0: no ceiling)"],
  "writer.launch_parity": ["project", "refuse|warn", "refuse: a writer that started on another provider than asked is stopped and the pair held for 30 minutes (unset warns)"],
  "writer.qa_stop_after": ["project", "number", "after this many failed QA receipts of a task family the advice is to stop, not to follow up (unset: 2; 0 or off: always a follow-up, as before)"],
  "writer.lesson_from_accepted": ["project", "on|off", "LESSON: lines of an accepted attempt are filed as lesson proposals"],
  "writer.models_off": ["project", "json", "a list of writer profile keys, provider/model ids or bare model ids no writer is given (the pick and the fallback chain skip them; all off: the task waits, the owner is told)"],
  // money (hub-wide)
  "money.strict": ["global", "on|off", "a free subscription member of the writer chain is taken before a free paid one that stands earlier"],
  "money.task_ceiling": ["global", "on|off", "with a money cap set, a task whose estimate would pass the cap waits for next month"],
  "money.cap_unset_zero": ["global", "on|off", "an unset money cap reads as zero for paid lanes: a lane paid by the token stays closed until the monthly cap is set, subscription lanes never wait for money (unset: on; off: an unset cap means no limit)"],
  "money.silent_estimate_tokens": ["global", "number", "an attempt whose paid provider reported no usage is priced at this many tokens"],
  // session hooks
  "hook.prompt_recall": ["project", "on|off", "a session's prompt of 3 words or more is answered with pointers to the project's confirmed notes that match its words (word index only, no model call; ON when unset: off silences it)"],
  "hook.subagent_pack": ["project", "on|off", "a Task call's subagent is born with the project's accepted rules and confirmed memory lessons in its context pack (unset: the pack holds the repo and the window's claimed files only)"],
  // docs
  "docs.gitnexus_refresh": ["project", "on|off", "the nightly docs pass refreshes the GitNexus code index (.gitnexus) of a checkout that lacks it or lags HEAD"],
  "docs.review": ["project", "gate|off", "a separate reviewer role reads the docs maintainer's edits before a page is written and committed; a refusal gets one rework round, then an owner item (unset: gate; off: no review)"],
  // capability
  "capability.documentary_gate": ["project", "hold|observe", "a documentary stage holds on a provider whose adapter version has a red documentary receipt; no receipt or a stale one is probed (one cell per stage start, 60 s at most); a probe that could not run is observed and the stage runs, only a probe that answered wrong holds (unset: hold; observe: only logs; lift a hold with bb lane-pilot capabilities --probe)"],
  // the second address (SMA d_project_planning): unset, the checkout's own .agents is the planning home
  "project.planning_home": ["project", "absolute path", "the planning home: .agents/phases, .agents/planning and .agents/todos are read and written under this folder on the project's host instead of the checkout's (unset: the checkout)"],
  // the infra profile (SMA k_pl_infra): free text, one writer — `bb lane-pilot profile` and the start's profile writer
  "profile.stack": ["project", "text", "infra profile: languages and frameworks"],
  "profile.test_command": ["project", "text", "infra profile: how the project's checks run"],
  "profile.release": ["project", "text", "infra profile: how a release ships"],
  "profile.hosts": ["project", "text", "infra profile: the machines the project lives on"],
  "profile.start": ["project", "text", "infra profile: how the project starts locally"],
  "profile.deploy": ["project", "text", "infra profile: how it deploys"],
  "profile.logs": ["project", "text", "infra profile: where the logs are"],
  "profile.style": ["project", "text", "infra profile: the owner's working style"],
  // checks
  "verification.ssh_keys": ["project", "on|off", "on: this project's checks can read ~/.ssh (the owner's ssh keys), so a check that clones or fetches over ssh works, and a check can also push with them; unset or off: ~/.ssh is masked inside checks, with the other credential stores (publication closed)"],
  "verification.copy": ["project", "on|off", "a check called from a chat runs in a throwaway copy (a git worktree of the workspace head) instead of the live checkout; a workspace with uncommitted changes is checked where it stands and the measure says so; off: the chat check always runs in the live checkout. A writer's checks run in the attempt's own worktree and the landing sweep in its own, whatever this says (unset: on)"],
  "verification.project_suite": ["project", "text", "the command of the project's own suite; the landing sweep runs it on the merged head in its throwaway worktree and a red one becomes an owner item (unset: the project has none, it is never guessed)"],
  "worker.strict_user": ["project", "on|off", "on: this project's checks run as a separate OS user (worker.user, lp-worker when none is named) through sudo -n -u, and each task gets a fresh codex home (unset: off, checks run as the owner)"],
  "worker.user": ["project", "text", "the OS user a strict worker's checks run as (unset: lp-worker); read only where worker.strict_user is on"],
  // hub-wide jobs
  "curriculum.weekly": ["global", "on|off", "every Monday the hub clusters the week's misses into a ten-line brief (bb lane-pilot curriculum --brief)"],
  "task.outcome_file": ["global", "on|off", "a finished task leaves OUTCOME.md beside its PLAN.md where the task folder still exists"],
  "protection.rearm": ["global", "on|off", "off: a protection whose disarm term ended stays off (unset: the daily pass switches it back on, to the level it had before, and tells the owner)"],
};

/** The text a person typed for a value, as the readers expect it stored: a number, JSON for a map or list, else the word. */
export function switchValue(key: string, text: string): { value: unknown } | { problem: string } {
  const [, values] = UNLISTED_SWITCHES[key]!;
  const word = text.trim();
  if (values === "number") return /^\d+(\.\d+)?$/.test(word) ? { value: Number(word) } : { problem: `${key} takes a number, got «${text}»` };
  if (values === "absolute path") {
    if (/^\/+$/.test(word)) return { problem: `${key} must not be the root folder «/»` };
    const path = word.replace(/\/+$/, "");
    return path.startsWith("/") && !path.includes("\0") && !path.includes("\\") && !path.split("/").includes("..") ? { value: path } : { problem: `${key} takes an absolute path with no «..», got «${text}»` };
  }
  if (values === "text") return word.length >= 1 && word.length <= 1000 ? { value: word } : { problem: `${key} takes text of at most 1000 characters` };
  if (values === "json") {
    try { const parsed: unknown = JSON.parse(word); return parsed !== null && typeof parsed === "object" ? { value: parsed } : { problem: `${key} takes a JSON map or list` }; }
    catch { return { problem: `${key} takes JSON, got «${text}»` }; }
  }
  return values.split("|").includes(word.toLowerCase()) ? { value: word.toLowerCase() } : { problem: `${key} takes ${values}, got «${text}»` };
}
