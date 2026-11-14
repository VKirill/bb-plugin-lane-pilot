// Probe of scenes/sma_r15.py: runs the real record and registry code of THIS checkout (the commit under drill) on a scratch in-memory
// database and prints what it returned as one JSON line. It judges nothing: the scene compares each value with the node card's result.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { runCoverageCli } from "../../../src/rooms/coverage/cli";
import { coverageRows } from "../../../src/rooms/coverage";
import { brokenLink, GENESIS } from "../../../src/rooms/phase/logic/book";
import { appendPart, listParts } from "../../../src/rooms/phase/store";
import { createRealtime, mountHelperSignals, REALTIME_WINDOW_MS } from "../../../src/rooms/platform/server/realtime";
import * as pluginDb from "../../../src/rooms/plugin-db";

// A namespace import: the room barrels re-export through chains that plain node ESM cannot name one by one.
const { createAttempt, createRun, createTask, inspectAttempt, openDatabase, saveReasoningTrace, transitionAttempt } = ((pluginDb as { default?: typeof pluginDb }).default ?? pluginDb);

const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
const db = openDatabase(bb);

// n1123: three appended parts chain from the genesis; a rewritten part is named
appendPart(db, "ph_probe", { section: "goal", kind: "opened", text: "one", at: 1000 });
appendPart(db, "ph_probe", { section: "plan", kind: "admitted", text: "two", at: 2000 });
appendPart(db, "ph_probe", { section: "decisions", kind: "note", text: "three", at: 3000 });
const parts = listParts(db, "ph_probe");
const chain = {
  links: parts.map((part, index) => part.prevHash === (index === 0 ? GENESIS : parts[index - 1]!.hash)),
  first: parts[0]!.hash === sha256Hex(`${GENESIS}\n1\n1000\ngoal\nopened\none`),
  intact: brokenLink(parts),
  rewritten: brokenLink(parts.map((part) => (part.seq === 2 ? { ...part, text: "rewritten" } : part))),
};

// n1120: one attempt's dossier
createRun(db, "run_p", "proj_p");
createTask(db, { id: "tp", runId: "run_p", kind: "bb", contract: { verification: [{ command: "npm test" }] } });
createAttempt(db, { id: "ap", runId: "run_p", taskId: "tp" });
saveReasoningTrace(db, { runId: "run_p", attemptId: "ap", threadId: "thr_w", planSha256: "p", sourceLength: 1, requestedReasoningLevel: "r", effectiveReasoningLevel: "r", fallbackReason: null,
  providerId: "codex", model: "m", serviceTier: null, requestedServiceTier: "default", stream: { excerpt: "wrote hello.txt", chars: 15, sha256: "s".repeat(64) } } as never);
db.prepare("UPDATE lane_pilot_attempt SET barrier_json=? WHERE id='ap'").run(JSON.stringify({ gate: "validate", status: "passed" }));
const dossier = inspectAttempt(db, "proj_p", "ap")!.dossier as { stream: { excerpt?: string } | null; verifierInput: { commands: string[]; sha256: string | null }; verdict: unknown };

// n1127: a burst is one signal, and an attempt move of a PM chat's run signals its helpers
const realtime = createRealtime(bb, () => undefined);
realtime.notify("proj_rt", "workflow", "thr_a", "wfrun_1");
realtime.notify("proj_rt", "workflow", "thr_a", "wfrun_1");
createRun(db, "run_rt", "proj_rt", "bb", "/w");
db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run_rt'").run();
mountHelperSignals(bb, db, realtime);
createTask(db, { id: "trt", runId: "run_rt", kind: "bb", contract: {} });
createAttempt(db, { id: "art", runId: "run_rt", taskId: "trt" });
transitionAttempt(db, "art", "spawn_requested", { reason: "go" });
await new Promise((resolve) => setTimeout(resolve, REALTIME_WINDOW_MS + 150));
const signals = harness.realtimeSignals.map((row) => ({ channel: row.channel, payload: row.payload }));
realtime.dispose();

// n1136–n1138: the registry of this commit
const rows = coverageRows();
const strict = runCoverageCli(["--json", "--strict"]);
const answer = JSON.parse(strict.stdout ?? "{}") as { gaps?: string[]; untermed?: string[] };
const liveBy = (scenario: string) => rows.filter((row) => row.status === "live" && row.live.includes(scenario)).length;

process.stdout.write(JSON.stringify({
  chain,
  dossier: { stream: dossier.stream?.excerpt ?? null, commands: dossier.verifierInput.commands, sha: dossier.verifierInput.sha256 === sha256Hex(JSON.stringify(["npm test"])), verdict: dossier.verdict },
  signals,
  coverage: {
    rows: rows.length, live: rows.filter((row) => row.status === "live").length, none: rows.filter((row) => row.status === "none").length,
    noneWithoutReason: rows.filter((row) => row.status === "none" && row.note.length <= 20).length,
    liveTask: liveBy("parallel3"), livePhase: liveBy("phase") + liveBy("phase_route"), liveBatch: liveBy("helper_providers") + liveBy("flow_contract") + liveBy("live_word"),
    strictExit: strict.exitCode, gaps: answer.gaps ?? null, untermed: answer.untermed ?? null,
  },
}));
process.exit(0);
