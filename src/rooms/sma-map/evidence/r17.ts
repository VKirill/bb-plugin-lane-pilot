// Region 17 · Agent roles (subagents) — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// A role of this region is a prompt plus a spawn profile: the mutations change what the role is GIVEN (its tools, skills, role row), what
// it may write, which field carries its answer or where the graph sends that answer. The behaviour tests are
// tests/sma/four-proofs-r17-a*.test.ts and the older [sma:k_ag_*] tests they sit beside. Roles that write no row to the hub database
// (a session, a checked graph that never ran live) are traced by their own prove() line in the region scene scripts/lp_drill/scenes/sma_r17.py.
import { distort, drill, entry, flip, part, rows, voidIsHave, voidStays, wfRun, wfStep, wrongTarget, type RegionEvidence } from "./types";

const BUNDLED = "src/rooms/contracts/bundled-agents.json";
const STAGES = "src/rooms/phase/stages.ts";
// The tail every bundled session prompt shares, up to the start of its `tools` list: a role's sentence plus this is unique in the file.
const TAIL = "\\n\\nDo not edit product source or DESIGN.md. Lane Pilot writes `docs/`, `README.md` and `PROJECT.md` nightly from the code and reverts other edits there, read, do not write.\\n\\n## Schedule\\nWork the owner wants on a rhythm («every Monday collect…») is a scheduled task: `lane_pilot_schedule` with `action: list` first, then `create` (definition: name, task, when). Say in your reply what you scheduled. A thread that a schedule started cannot create schedules: write in your report that a follow-up is needed.\\n\\n## Skill catalog\\nSkills are many and filed by section. Run `bb tools skills-tree --skills --json`. Start with your sections, then the neighbours. Load only what this task needs (the Skill tool, or read that skill's SKILL.md). If `progressive_skill_used` is available, call it for each skill you use. Do not load skills just in case.\\n";
const TOOLS = "\",\n    \"tools\": [\n      \"Read\",\n      \"Grep\",\n      \"Glob\",\n      \"Bash\",\n      \"WebFetch\",\n      \"WebSearch\"";
/** The role's session is given a write tool as well: it could then change files its card says it must not. */
const givenWrite = (lastSentence: string) => distort(BUNDLED, `${lastSentence}${TAIL}${TOOLS}\n    ],`, `${lastSentence}${TAIL}${TOOLS},\n      "Write"\n    ],`);

export default {
  n1368: { mutation: givenWrite("Do not build the feature."), trace: drill("sma_r17"), reach: entry("the owner opens a framework-selector session, or the ai-integration-phase graph runs its select step") },
  n1369: { mutation: wrongTarget("workflows/ai-integration-phase.json", "\"id\": \"research\",\n      \"type\": \"agent\",\n      \"role\": \"specialist:tavily\",", "\"id\": \"research\",\n      \"type\": \"agent\",\n      \"role\": \"analyst\","), trace: [wfStep("ai-integration-phase", "research"), drill("sma_r17")] },
  n1370: { mutation: distort("workflows/ai-integration-phase.json", "\"implementation_notes\": \"string\",\n        \"domain_notes\": \"string\"", "\"implementation_notes\": \"string\",\n        \"domain_note\": \"string\""), trace: [wfStep("ai-integration-phase", "research"), drill("sma_r17")] },
  n1371: { mutation: distort("workflows/ai-integration-phase.json", "\"out\": {\n        \"eval_plan\": \"string\"\n      },", "\"out\": {\n        \"eval_plan\": \"number\"\n      },"), trace: [wfStep("ai-integration-phase", "spec"), drill("sma_r17")] },
  n1372: { mutation: distort(STAGES, "}): ${item.promise.then}`", "}): ${item.promise.when}`"), trace: [part({ section: "lessons", kind: "concluded" }), drill("sma_r17")] },
  n1373: { mutation: flip(STAGES, "notes && motionRows([item]).length ?", "notes && !motionRows([item]).length ?"), trace: drill("sma_r17") },
  n1374: { mutation: wrongTarget("workflows/review-fix.json", "\"tasks\": \"{{plan_fix2.tasks}}\"", "\"tasks\": \"{{plan_fix.tasks}}\""), trace: [wfRun("review-fix"), drill("sma_r17")] },
  n1375: { mutation: wrongTarget("src/rooms/critique/role-method.ts", "case \"debugger\": return SCIENTIFIC_DEBUG_METHOD;", "case \"debugger\": return FAILURE_TRIAGE_METHOD;"), trace: [wfStep("debug", "investigate"), drill("sma_r17")] },
  n1376: { mutation: flip("workflows/debug.json", "visits('investigate') < 3", "visits('investigate') < 2"), trace: [wfStep("debug", "verify_cause"), drill("sma_r17")] },
  n1377: { mutation: flip("src/rooms/phase/logic/verdict.ts", "if (fact?.planFact === \"failed\") problems.push(", "if (fact?.planFact !== \"failed\") problems.push("), trace: [part({ section: "verification", kind: "blind_verdict" }), drill("sma_r17")] },
  n1378: { mutation: wrongTarget("src/rooms/baseline/server/baseline.ts", "const red = turnedRed(row.checks, input.checks);", "const red = redBeforeAndAfter(row.checks, input.checks);"), trace: [rows("lane_pilot_baseline", "at", "after_json IS NOT NULL"), drill("sma_r17")] },
  n1379: { mutation: givenWrite("Follow the lane-pilot skill (`references/contract.md`) for how a check is named."), trace: drill("sma_r17") },
  n1380: { mutation: flip("workflows/security-audit.json", "\"skip_when\": \"!$inputs.phase_id\"", "\"skip_when\": \"$inputs.phase_id\""), trace: [wfStep("security-audit", "threat_model"), drill("sma_r17")] },
  n1381: { mutation: flip("workflows/ui-audit.json", "\"skip_when\": \"!$inputs.review_file\"", "\"skip_when\": \"$inputs.review_file\""), trace: [wfStep("ui-audit", "review_doc"), drill("sma_r17")] },
  n1382: { mutation: flip("src/rooms/qa/server/qa-thread.ts", "const verdict = parsed.verdict === \"passed\" && !allPassed ? \"blocked\" : parsed.verdict;", "const verdict = parsed.verdict === \"passed\" && allPassed ? \"blocked\" : parsed.verdict;"), trace: drill("sma_r17") },
  n1383: { mutation: flip("workflows/eval-review.json", "\"when\": \"review.flawed\"", "\"when\": \"!review.flawed\""), trace: [wfStep("eval-review", "review"), drill("sma_r17")] },
  n1384: { mutation: flip(STAGES, ".filter((section) => ![...headings].some(", ".filter((section) => [...headings].some("), trace: drill("sma_r17") },
  n1385: { mutation: flip("src/rooms/docs/docs.ts", "...(input.assignment?.trim() ? [{ tag: \"owner_assignment\", title: `The owner's assignment for this pass; write", "...(!input.assignment?.trim() ? [{ tag: \"owner_assignment\", title: `The owner's assignment for this pass; write"), trace: drill("sma_r17") },
  n1386: { mutation: flip("src/rooms/docs/docs-lint.ts", "if (!claim.identifiers.some((id) => text.includes(id) ||", "if (claim.identifiers.some((id) => text.includes(id) ||"), trace: drill("sma_r17"), voidReview: voidIsHave("утверждения документации сверяются с живым кодом без модели: lintCitationClaims читает процитированные строки, отсутствующий идентификатор — находка; шаг lp.docs_verify в ночном графе (текущий ours-текст устарел)") },
  n1387: { mutation: givenWrite("Change nothing."), trace: drill("sma_r17") },
  n1388: { voidReview: voidStays("слитой копии документов не делается (plan-import режет план в задачи, исполнители читают документы на месте), поэтому слияния по приоритету и файла конфликтов нет") },
  n1389: { mutation: wrongTarget("workflows/analyze-code.json", "\"scope\": \"{{$inputs.scope}}\"", "\"scope\": \"{{$inputs.goal}}\""), trace: [wfStep("analyze-code", "analyze"), drill("sma_r17")] },
  n1391: { mutation: flip("src/rooms/anamnesis/fragments.ts", "&& confidence >= MIN_KIND_P;", "&& confidence < MIN_KIND_P;"), trace: drill("sma_r17") },
  n1392: { mutation: wrongTarget("workflows/lp.plan.json", "\"premortem\": \"plan.premortem\",\n        \"research_md\": \"research.research_md\",\n        \"patterns_md\": \"patterns.patterns_md\",", "\"premortem\": \"plan.premortem\",\n        \"research_md\": \"research.research_md\",\n        \"patterns_md\": \"research.research_md\","), trace: [wfStep("lp.plan", "plan"), drill("sma_r17")] },
  n1393: { mutation: flip("workflows/grill-plan.json", "\"when\": \"synth.open.length > 0\"", "\"when\": \"synth.open.length == 0\""), trace: [wfRun("grill-plan"), drill("sma_r17")] },
  n1394: { mutation: distort(BUNDLED, `Write \`.agents/research/advisor-<slug>.md\` when a file is needed.${TAIL}${TOOLS}\n    ],\n    "skills": [\n      "tavily"`, `Write \`.agents/research/advisor-<slug>.md\` when a file is needed.${TAIL}${TOOLS}\n    ],\n    "skills": [\n      "lane-pilot"`), trace: drill("sma_r17") },
  n1395: { mutation: wrongTarget("workflows/lp.analyze.json", "\"stack\": \"gather.stack\"", "\"stack\": \"gather.features\""), trace: [wfStep("lp.analyze", "gather"), drill("sma_r17")] },
  n1396: { mutation: flip("packages/workflow-engine/src/reducers.ts", "if (url && seen.has(url)) continue;", "if (url && !seen.has(url)) continue;"), trace: [wfRun("web-research"), drill("sma_r17")] },
  n1397: { mutation: flip("workflows/roadmap-driven.json", "visits('validate') < 3", "visits('validate') < 1"), trace: [wfRun("roadmap-driven"), drill("sma_r17")] },
  n1398: { mutation: distort("src/rooms/native-agent/native-agent-overlay.ts", "if (tool === \"Agent\" || tool === \"Task\") return `${tool}(Explore, Plan)`;", "if (tool === \"Agent\" || tool === \"Task\") return `${tool}(Explore, Plan, general-purpose)`;"), reach: entry("a PM chat session starts: its tool list is built from the stock profile of the coordinator"), trace: drill("sma_r17") },
  n1399: { mutation: flip("src/rooms/session-hooks/logic.ts", "if (input.role === \"writer\" && !DOCUMENTARY_AGENTS.includes(", "if (input.role === \"writer\" && DOCUMENTARY_AGENTS.includes("), reach: entry("a writer session calls the Task tool: the PreToolUse hook asks pretaskDecision"), trace: drill("sma_r17") },
} satisfies RegionEvidence;
