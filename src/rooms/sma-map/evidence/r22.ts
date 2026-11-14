// Region 22 · The project. planning folder — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The phase documents are made by pure functions of src/rooms/phase/stages.ts; a document no row records is proved by the region scene
// scripts/lp_drill/scenes/sma_r22.py (its own prove() line per node), the others by the phase book parts the hub holds.
import { distort, drill, entry, flip, part, rows, type RegionEvidence, wfRun, wfStep } from "./types";

const STAGES = "src/rooms/phase/stages.ts";
const PROJECT_ACTIONS = "src/rooms/workflow/server/workflow-project-actions.ts";

export default {
  n1590: { mutation: flip(PROJECT_ACTIONS, '&& !current.content.includes("Developer preferences"))', '&& current.content.includes("Developer preferences"))'), trace: wfStep("project-start", "recap") },
  n1591: { mutation: flip(STAGES, 'return found && found[2] === row ? line.replace("- [ ]", "- [x]") : line;', 'return found && found[2] !== row ? line.replace("- [ ]", "- [x]") : line;'), trace: part({ section: "lessons", kind: "concluded" }) },
  n1592: { mutation: flip("src/rooms/phase/server/driver-docs.ts", "if (sameStateIgnoringTime(previous, next.text)) return;", "if (!sameStateIgnoringTime(previous, next.text)) return;"), trace: drill("sma_r22") },
  n1593: { mutation: distort(STAGES, 'case "discussion": return [".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md",', 'case "discussion": return [".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENT.md",'), trace: drill("sma_r22") },
  n1594: { mutation: flip("src/rooms/storage/settings-store.ts", '...["", ...scopes].map((bindingId)', '...[...scopes, ""].map((bindingId)'), trace: drill("sma_r22") },
  n1595: { mutation: distort(STAGES, 'case "planning": return [...docs, ', 'case "planning": return ['), trace: part({ section: "discussion", kind: "signed" }) },
  n1596: { mutation: distort(STAGES, '`${folder}/DISCUSSION.md`];', '`${folder}/DISCUSSION.log`];'), trace: drill("sma_r22") },
  n1597: { mutation: flip(STAGES, "phase.record.ambiguityGate === true ?", "phase.record.ambiguityGate !== true ?"), trace: drill("sma_r22") },
  n1598: { mutation: distort(STAGES, "`${folder}/RESEARCH.md`", "`${folder}/RESEARCH.txt`"), trace: drill("sma_r22") },
  n1599: { mutation: distort(STAGES, "`${folder}/PATTERNS.md`", "`${folder}/PATTERNS.txt`"), trace: drill("sma_r22") },
  n1600: { mutation: flip(STAGES, "...items.filter((item) => item.wave === wave).map((item) => [", "...items.filter((item) => item.wave !== wave).map((item) => ["), trace: part({ section: "plan", kind: "admitted" }) },
  n1601: { mutation: flip(STAGES, 'parts.filter((part) => part.kind === "return")', 'parts.filter((part) => part.kind !== "return")'), trace: part({ section: "lessons", kind: "concluded" }) },
  n1602: { mutation: distort(STAGES, 'fact?.verification ?? fact?.state ?? "not issued"', 'fact?.state ?? fact?.verification ?? "not issued"'), trace: part({ section: "verification", kind: "blind_verdict" }) },
  n1603: { mutation: flip(STAGES, '`- [${ok ? "x" : "!"}] ${row[2]}', '`- [${ok ? "!" : "x"}] ${row[2]}'), trace: drill("sma_r22") },
  n1605: { mutation: flip(STAGES, '...(findings.length ? findings : ["- no findings"])', '...(findings.length ? ["- no findings"] : findings)'), trace: [wfRun("lp.review"), drill("sma_r22")] },
  n1606: { mutation: flip("src/rooms/phase/logic/design.ts", "else if (drawing.reviewer === drawing.designer)", "else if (drawing.reviewer !== drawing.designer)"), trace: part({ section: "design", kind: "drawing" }) },
  n1607: { mutation: flip(STAGES, "filter((section) => ![...headings].some(", "filter((section) => [...headings].some("), trace: part({ section: "design", kind: "drawing" }) },
  n1608: { mutation: distort("workflows/ai-integration-phase.json", `"status": "'blocked'"`, `"status": "'done'"`), trace: drill("sma_r22") },
  n1609: { mutation: flip(STAGES, "|| /^(none|нет|no)(?![\\p{L}\\p{N}_])/u.test(risk)", "|| !/^(none|нет|no)(?![\\p{L}\\p{N}_])/u.test(risk)"), trace: drill("sma_r22") },
  n1610: { mutation: flip(STAGES, "clauses.length > 0 && clauses.every((clause) => EXISTENCE_ONLY.test(clause))", "clauses.length > 0 && clauses.some((clause) => EXISTENCE_ONLY.test(clause))"), trace: drill("sma_r22") },
  n1611: { mutation: distort("workflows/ui-audit.json", '"skip_when": "!$inputs.review_file"', '"skip_when": "$inputs.review_file"'), trace: drill("sma_r22") },
  n1612: { mutation: distort("workflows/eval-review.json", `"proposed_workflow": "'todo-add'"`, `"proposed_workflow": "'review-fix'"`), trace: drill("sma_r22") },
  n1613: { mutation: flip("src/rooms/docs/docs-lint.ts", "input.workspace ? [[\"overview\", `${docsDir}/overview.md`]]", "!input.workspace ? [[\"overview\", `${docsDir}/overview.md`]]"), trace: drill("sma_r22") },
  n1614: { mutation: flip("src/rooms/platform/code-facts.ts", "if ((head && last && head === last)", "if ((head && last && head !== last)"), trace: drill("sma_r22") },
  // One folder per task with its plan and outcome: OUTCOME.md is recorded as kind outcome in the task home (docs/task-folder.md, T14).
  n1616: { mutation: distort("src/rooms/writer/server/task-home.ts", 'kind: "outcome", name: "OUTCOME.md"', 'kind: "lesson", name: "OUTCOME.md"'),
    reach: { ...entry("a task's attempt ends accepted, blocked or canceled"), notGatedBy: { "task.outcome_file": "gates only the old-layout OUTCOME.md; a task with a home always records it in its home (attempt-reactions.ts)" } }, trace: drill("task_home") },
  n1617: { mutation: flip("src/rooms/workflow/server/workflow-task-book.ts", "if (read.exitCode === 0 && read.stdout.trim()) return { found: true, path };", "if (read.exitCode === 0 && !read.stdout.trim()) return { found: true, path };"), trace: wfStep("debug", "session") },
  n1618: { mutation: flip("src/rooms/backlog/logic.ts", "item.estimate <= MAX_ESTIMATE && item.dependsOn.every((id) => done.has(id))),", "item.estimate <= MAX_ESTIMATE && item.dependsOn.some((id) => done.has(id))),"), trace: drill("sma_r22") },
  n1619: { mutation: distort("packages/handoff/src/store.ts", "export const HANDOFF_DEFAULT_DEADLINE_MS = 48 * 3_600_000;", "export const HANDOFF_DEFAULT_DEADLINE_MS = 24 * 3_600_000;"), trace: rows("lane_pilot_handoff", "created_at") },
  n1620: { mutation: flip("src/rooms/phase/server/driver-methods-design.ts", "} else tools.writeLesson(phase, text);", "} else if (!text) tools.writeLesson(phase, text);"), trace: drill("sma_r22") },
  n1621: { mutation: flip(PROJECT_ACTIONS, "if (!kept) {", "if (kept) {"), trace: wfStep("milestone-close", "snapshot") },
  n1622: { mutation: distort("src/rooms/tools/server/verdicts.ts", 'verdict: frontValue(head, "verdict") ?? "open",', 'verdict: frontValue(head, "verdict") ?? "closed",'), trace: drill("sma_r22") },
  n1623: { mutation: flip("src/rooms/anamnesis/fragments.ts", "includes(kind) && about > 0 && confidence >= MIN_KIND_P;", "includes(kind) && about >= 0 && confidence >= MIN_KIND_P;"), trace: drill("sma_r22") },
  n1624: { mutation: distort(PROJECT_ACTIONS, "saveProjectSetting(db, rt.projectId, `profile.${key}`, String(value));", "saveProjectSetting(db, rt.projectId, `profile.${key}x`, String(value));"), trace: wfStep("project-start", "profile_write") },
} satisfies RegionEvidence;
