// Region 15 · How we prove it — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The records (n1118–n1128) that write a row take their trace from the hub database. The drill machinery (n1129–n1143), the dossier read,
// the event stream and the book chain write no row: their trace is their own prove() line in the region scene
// scripts/lp_drill/scenes/sma_r15.py, which runs the real drill code of the commit (docs/sma-evidence.md).
import { distort, drill, entry, flip, part, rows, transition, wrongTarget, type RegionEvidence } from "./types";

const TRANSITION = "src/rooms/storage/attempts-store/transition.ts";
const DRILL = "scripts/lp-drill.py";
const SERIES = "scripts/lp_drill/series.py";
const COVERAGE = "src/rooms/coverage/model.ts";
const BOOK = "src/rooms/phase/logic/book.ts";
const START_SERIES = "the owner or the deploy starts the release series (lp-drill.sh --series or --suite)";

export default {
  n1118: { mutation: flip("src/rooms/migrations.ts", "BEGIN SELECT RAISE(ABORT,'attempts are append-only'); END`", "BEGIN SELECT RAISE(IGNORE); END`"), trace: transition({ to: "accepted" }) },
  n1119: { mutation: distort(TRANSITION, "operational: OPERATIONAL_MOVES }));", "operational: [] }));"), trace: rows("lane_pilot_attempt", "created_at", "id IN (SELECT attempt_id FROM lane_pilot_attempt_reasoning WHERE json_extract(trace_json, '$.stamp.transitionKey') IS NOT NULL)") },
  n1120: { mutation: distort("src/rooms/storage/attempts-store/inspect.ts", "    stream: trace?.stream ?? null,", "    stream: null,"), reach: entry("the owner or a PM tool reads one attempt's state (bb lane-pilot state <project> --attempt <id>)"), trace: drill("sma_r15") },
  n1121: { mutation: flip("packages/kit/src/hash.ts", "item.outputChanged = item.stdoutSha256 !== want;", "item.outputChanged = item.stdoutSha256 === want;"), trace: rows("lane_pilot_stage_receipt", "updated_at", "stage_id = 'verification' AND result_json LIKE '%stdoutSha256%'") },
  n1122: { mutation: distort(BOOK, '"acceptance", "lessons", "decisions"] as const;', '"lessons", "acceptance", "decisions"] as const;'), trace: part({ section: ["goal", "discussion", "plan", "design", "execution", "verification", "acceptance", "lessons", "decisions"] }) },
  n1123: { mutation: distort(BOOK, "\\n${part.kind}\\n${part.text}`);", "\\n${part.kind}`);"), reach: entry("a phase decision appends a part to the phase book"), trace: drill("sma_r15") },
  n1124: { mutation: wrongTarget("src/rooms/phase/server/driver-docs.ts", "appendPart(db, phase.id, { section, kind, text, at: now() });", 'appendPart(db, phase.id, { section: "lessons", kind, text, at: now() });'), trace: part({ kind: ["stage", "wave_stopped", "note"] }) },
  n1125: { mutation: flip(TRANSITION, ".run(attemptId, before.state, state, fields.reason ?? null, wrote ? 0 : 1, now);", ".run(attemptId, before.state, state, fields.reason ?? null, wrote ? 1 : 0, now);"), trace: rows("lane_pilot_attempt_transition", "at", "refused = 1") },
  n1126: { mutation: flip("packages/run-insights/src/triage.ts", "return rows.filter((row) => row.known !== sha(row.reason))", "return rows.filter((row) => row.known === sha(row.reason))"), trace: rows("lane_pilot_failure_triage", "triaged_at", "status = 'ok'") },
  n1127: { mutation: distort("src/rooms/platform/server/realtime.ts", "publish(lpChannel(row.projectId), { kind: row.kind,", 'publish(lpChannel(row.projectId), { kind: "helpers",'), trace: drill("sma_r15") },
  n1128: { mutation: flip("src/rooms/phase/server/driver-methods-control.ts", 'savePhase(db, phase.id, { state: "paused", at: now() });\n    return { phase: mustGet(phase.id), canceled };', 'savePhase(db, phase.id, { state: "active", at: now() });\n    return { phase: mustGet(phase.id), canceled };'), trace: part({ kind: "wave_stopped" }) },
  n1129: { mutation: flip(DRILL, 'verdict_all = "pass" if all(row["exit"] == 0 for row in receipts)', 'verdict_all = "pass" if any(row["exit"] == 0 for row in receipts)'), trace: drill("sma_r15") },
  n1130: { mutation: flip(DRILL, 'if prep["problems"]:', 'if not prep["problems"]:'), reach: entry(START_SERIES), trace: drill("sma_r15") },
  n1131: { mutation: flip(DRILL, "ungrouped = [name for name in defined if name not in members and name not in BY_NAME]", "ungrouped = [name for name in defined if name in members and name not in BY_NAME]"), trace: drill("sma_r15") },
  n1132: { mutation: flip("scripts/lp_drill/scenes/phase.py", 'if snap["stage"] not in reached:', 'if snap["stage"] in reached:'), reach: entry(`${START_SERIES}: its task, batch and phase suites run first`), trace: drill("sma_r15") },
  n1133: { mutation: wrongTarget("src/rooms/contracts/state-machine.ts", '{ from:"running", event:"checks_passed", to:"accepted" },', '{ from:"running", event:"reconcile_found", to:"accepted" },'), reach: entry(`${START_SERIES}: its window and worker suites run the story files`), trace: drill("sma_r15") },
  n1134: { mutation: wrongTarget(DRILL, '[sys.executable, "-I", __file__, "--scenario", entry]', '[sys.executable, "-I", __file__, "--scenario", suite]'), trace: drill("sma_r15") },
  n1135: { mutation: flip(DRILL, '[n for n in args.scenario.split(",") if n]', '[n for n in args.scenario.split(",") if not n]'), reach: entry("the owner names the scenes or suites to run (lp-drill.sh --scenario, --suite, --scout)"), trace: drill("sma_r15") },
  n1136: { mutation: distort(COVERAGE, '? "live" : entry.tests?.length ? "tests" : "none"', '? "tests" : entry.tests?.length ? "tests" : "none"'), reach: entry("the series preparation asks for the coverage verdict, or the owner runs bb lane-pilot coverage"), trace: drill("sma_r15") },
  n1137: { mutation: distort(COVERAGE, 'note: entry.live?.length ? entry.via ?? "" : entry.reason ?? "",', 'note: entry.live?.length ? entry.via ?? "" : "",'), trace: drill("sma_r15") },
  n1138: { mutation: flip(COVERAGE, 'rows.filter((row) => row.status === "none" && !/deferral', 'rows.filter((row) => row.status === "none" && /deferral'), reach: entry("the series preparation asks for the strict coverage verdict (bb lane-pilot coverage --json --strict)"), trace: drill("sma_r15") },
  n1139: { mutation: flip(SERIES, '(evidence or scenario.get("note"))', '(evidence and scenario.get("note"))'), reach: entry("a drill run writes its receipt: each scene is judged"), trace: drill("sma_r15") },
  n1140: { mutation: flip(SERIES, '"verdict": "pass" if not missing and not failed else "fail"', '"verdict": "pass" if not missing or not failed else "fail"'), trace: drill("sma_r15") },
  n1141: { mutation: flip(DRILL, 'suites = {name: [row for row in receipts if row["suite"] == name] for name in SUITES}', 'suites = {name: [row for row in receipts if row["suite"] != name] for name in SUITES}'), trace: drill("sma_r15") },
  n1142: { mutation: flip(DRILL, 'for r in rows if r["k"] == k}', 'for r in rows if r["k"] != k}'), trace: drill("sma_r15") },
  n1143: { mutation: flip(SERIES, "if total and accepted / total < ACCEPTED_FLOOR:", "if total and accepted / total > ACCEPTED_FLOOR:"), trace: drill("sma_r15") },
} satisfies RegionEvidence;
