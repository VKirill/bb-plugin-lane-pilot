// Region 2 · Batch graph — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The batch graph is the phase driver (src/rooms/phase/**): the plan's pieces, the waves laid out from depends_on, the issue,
// the wave's lines and the owner's words. A node that writes a book part reads it from lane_pilot_phase_part; a pure check proves
// itself with a line of the region scene scripts/lp_drill/scenes/sma_r02.py (+ sma_r02_probe.ts).
import { distort, drill, entry, flip, part, rows, wrongTarget, type RegionEvidence } from "./types";

const RUN_GOAL = "src/rooms/run-goal/logic.ts";
const ACCEPTANCE = "src/rooms/phase/logic/acceptance.ts";
const VERDICT = "src/rooms/phase/logic/verdict.ts";
const NEXT = "src/rooms/phase/logic/next-action.ts";
const ADMISSION = "src/rooms/phase/server/driver-methods-admission.ts";
const GATES = "src/rooms/phase/logic/gates.ts";
const DESIGN = "src/rooms/phase/logic/design.ts";
const WAVES = "src/rooms/phase/logic/waves.ts";
const STORE = "src/rooms/phase/store.ts";
const CONTROL = "src/rooms/phase/server/driver-methods-control.ts";
const STEPS = "src/rooms/phase/server/driver-steps.ts";
const PILOT = "src/rooms/writer/server/pilot/logic.ts";

export default {
  n345: { mutation: flip(RUN_GOAL, 'if (red.length) return { state: "failed", red,', 'if (!red.length) return { state: "failed", red,'), reach: entry("a run is done (every task accepted or canceled, two accepted) and the run-goal sweep checks it"), trace: rows("lane_pilot_run_goal", "at", "state IN ('passed','failed')") },
  n346: { mutation: flip(ACCEPTANCE, "|| coverageGaps(phase.record).length === 0,", "|| coverageGaps(phase.record).length > 0,"), trace: drill("sma_r02") },
  n347: { mutation: flip(VERDICT, 'else if (runGoal.state === "failed") problems.push(', 'else if (runGoal.state === "passed") problems.push('), trace: rows("lane_pilot_phase_part", "at", "kind = 'blind_verdict' AND text LIKE 'failed%'") },
  n348: { mutation: distort(ADMISSION, "sha: planSignature(items, contextSha), rounds:", 'sha: planSignature(items, "x"), rounds:'), trace: part({ kind: "submitted" }) },
  n349: { mutation: wrongTarget(ADMISSION, "title: input.title.slice(0, 200), goal: input.goal.slice(0, 4000), at: now() });", "title: input.goal.slice(0, 200), goal: input.title.slice(0, 4000), at: now() });"), trace: part({ kind: "opened" }) },
  n350: { mutation: flip(NEXT, 'if (wordAsked(r, "issue") && !wordOf(r, "issue")) return', 'if (wordAsked(r, "issue") && wordOf(r, "issue")) return'), trace: part({ kind: "word_issue" }) },
  n351: { mutation: flip(GATES, "if (!owns.length) why.push(", "if (owns.length) why.push("), trace: part({ kind: "submitted" }) },
  n352: { mutation: flip(STORE, "changed ? 1 : 0, patch.at, closedAt, id);", "changed ? 0 : 1, patch.at, closedAt, id);"), trace: part({ kind: "submitted" }) },
  n353: { mutation: flip(GATES, "else if (dep !== item.id && other.wave >= item.wave) why.push(", "else if (dep !== item.id && other.wave < item.wave) why.push("), trace: part({ kind: "submitted" }) },
  n354: { mutation: flip(DESIGN, "return ui.length ? { decision: \"needed\", why:", "return !ui.length ? { decision: \"needed\", why:"), reach: entry("the PM submits a plan whose pieces own screen files"), trace: drill("sma_r02") },
  n355: { mutation: distort(DESIGN, "pieces that change screens: ${ui.map((item) => item.id).join(\", \")}", "pieces that change screens: ${ui.slice(0, 1).map((item) => item.id).join(\", \")}"), trace: drill("sma_r02") },
  n356: { mutation: distort("src/rooms/phase/server/driver-methods-design.ts", "sha256: await tools.drawingSha(phase, input.paths.slice(0, 30))", "sha256: \"x\""), trace: part({ kind: "drawing" }) },
  n357: { mutation: flip(DESIGN, 'if (said?.decision !== "yes" ||', 'if (said?.decision === "yes" ||'), trace: part({ kind: "word_design" }) },
  n358: { mutation: flip("src/rooms/tasks/rails.ts", "if (input.appetite !== null && input.appetite > free) return", "if (input.appetite !== null && input.appetite < free) return"), trace: drill("sma_r02") },
  n359: { mutation: flip(WAVES, ".filter((item) => !issued[item.id] || (issuedSha[item.id]", ".filter((item) => !!issued[item.id] || (issuedSha[item.id]"), trace: part({ kind: "issued" }) },
  n360: { mutation: wrongTarget(STORE, "JSON.stringify(record), patch.runId === undefined", "JSON.stringify(current.record), patch.runId === undefined"), trace: part({ kind: "issued" }) },
  n361: { mutation: wrongTarget(STEPS, "execution.issued[item.id] = taskId;\n        if (issuedTask.dropped)", "execution.issued[item.id] = taskIdForIssue;\n        if (issuedTask.dropped)"), reach: entry("the phase driver's pass at the execution stage issues the pieces whose dependencies are accepted"), trace: part({ kind: "issued" }) },
  n362: { mutation: flip(WAVES, "items.some((other) => other.id === dep) && accepted(dep)", "items.some((other) => other.id === dep) && !accepted(dep)"), trace: drill("sma_r02") },
  n363: { mutation: flip(PILOT, ".sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];\n  return pilot &&", ".sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];\n  return pilot &&"), trace: drill("sma_r02") },
  n364: { mutation: flip(PILOT, "if (families.size < min) return null;\n  const pilot", "if (families.size <= min) return null;\n  const pilot"), trace: drill("sma_r02") },
  n365: { mutation: flip(WAVES, 'if (record.waveReview && done.review?.state !== "passed") return false;', 'if (record.waveReview && done.review?.state === "passed") return false;'), trace: drill("sma_r02") },
  n366: { mutation: flip(NEXT, '["blocked", "canceled"].includes(facts.get(item.id)?.state ?? "")', '["blocked", "queued"].includes(facts.get(item.id)?.state ?? "")'), reach: entry("a piece's attempt ends blocked or canceled during execution"), trace: drill("sma_r02") },
  n367: { mutation: flip(CONTROL, "if (!broken) throw new PhaseRefusal(", "if (broken) throw new PhaseRefusal("), trace: part({ kind: ["retry", "scope_withdrawn"] }) },
  n368: { mutation: flip(CONTROL, "const items = plan.items.filter((item) => !input.pieces.includes(item.id));", "const items = plan.items.filter((item) => input.pieces.includes(item.id));"), trace: part({ kind: "scope_withdrawn" }) },
  n369: { mutation: flip(CONTROL, "for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && families.has(taskFamily(row.task_id)))) {", "for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && !families.has(taskFamily(row.task_id)))) {"), trace: drill("sma_r02") },
  n370: { mutation: flip("src/rooms/runs/server/runs-pause.ts", 'running: rows.filter((row) => row.state !== "queued")', 'running: rows.filter((row) => row.state === "queued")'), trace: drill("sma_r02") },
  n371: { mutation: flip(CONTROL, 'issued.has(taskFamily(row.task_id)) && row.state === "queued")', 'issued.has(taskFamily(row.task_id)) && row.state === "running")'), trace: part({ kind: "wave_stopped" }) },
  n372: { mutation: flip(CONTROL, '(SMA bi_revise): the new scope asks for a new «issue» word.\n    const revoked = ', '(SMA bi_revise): the new scope asks for a new «issue» word.\n    const revoked = !'), trace: part({ kind: ["scope_withdrawn", "revised"] }) },
  n373: { mutation: flip(WAVES, 'if (state !== "accepted") why.push(`${item.id} is ${state}`);', 'if (state === "accepted") why.push(`${item.id} is ${state}`);'), trace: drill("sma_r02") },
  n374: { mutation: distort(WAVES, "facts.get(item.id)?.state ?? null, facts.get(item.id)?.planFact ?? null", "null, facts.get(item.id)?.planFact ?? null"), trace: part({ kind: "wave_table" }) },
  n375: { mutation: distort("src/rooms/phase/server/driver-methods-words.ts", "review: { state: input.state, by: input.by,", 'review: { state: "failed", by: input.by,'), trace: part({ kind: ["wave_passed", "wave_failed"] }) },
  n376: { mutation: flip("src/rooms/run-goal/server/run-goal.ts", "if (!runReady(taskStates(id))) continue;", "if (runReady(taskStates(id))) continue;"), reach: entry("a run is done (every task accepted or canceled, two accepted) and the run-goal sweep runs every 20 minutes"), trace: rows("lane_pilot_run_goal", "at", "state IN ('passed','failed','partial')") },
  n377: { mutation: flip(WAVES, "if (!issued[item.id]) { why.push(`${item.id} is not issued yet`); continue; }", "if (issued[item.id]) { why.push(`${item.id} is not issued yet`); continue; }"), trace: drill("sma_r02") },
  n378: { mutation: distort("src/rooms/tasks/rails.ts", "const free = input.budgetTokens - input.spentTokens - reserved;", "const free = input.budgetTokens - input.spentTokens;"), trace: drill("sma_r02") },
  n379: { mutation: flip(WAVES, "return { id, ok: failing.length === 0,", "return { id, ok: failing.length > 0,"), trace: part({ kind: "wave_in" }) },
  n380: { mutation: flip(WAVES, "if (!done || !done.lines.every((line) => line.ok)) return false;", "if (!done || !done.lines.some((line) => line.ok)) return false;"), trace: drill("sma_r02") },
  n381: { mutation: flip(WAVES, 'ok: fact?.state === "accepted", detail: fact?.state === "accepted" ?', 'ok: fact?.state !== "accepted", detail: fact?.state === "accepted" ?'), trace: part({ kind: "accepted" }) },
  n382: { mutation: flip(STEPS, "if (waves[String(wave)]?.packageSha === wavePackage(pieces, f)) continue;", "if (waves[String(wave)]?.packageSha !== wavePackage(pieces, f)) continue;"), trace: part({ kind: "wave_in" }) },
} satisfies RegionEvidence;
