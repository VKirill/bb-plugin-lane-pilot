// Probe of scenes/sma_r00_b.py (region 0, batch b: plan hand-in, drawing stage, start of the execution): runs the REAL code of THIS checkout — the phase
// logic, the phase driver on a scratch database and a fake host, the auto stage — and prints what it returned as one JSON line. It judges nothing: the
// scene compares each value with the card's expected result and prove()s it. No model, no hub write. The observations are tests/sma/r00-world-b.ts `observe`.
import { observe } from "../../../tests/sma/r00-world-b";
import { world as planningWorld, piece as planningPiece } from "../../../tests/sma/r00-world-a";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { getPhase, savePhase } from "../../../src/rooms/phase/store";
import { planGate } from "../../../src/rooms/phase/logic";
import { createRun, createTask, openDatabase } from "../../../src/rooms/plugin-db";
import { renderTaskManifest } from "../../../src/rooms/storage";
import { bbTaskFileIo } from "../../../src/rooms/storage";
import { writeDispatchHome } from "../../../src/rooms/writer/server/task-home";

async function ownerWordPlanning() {
  const w = planningWorld("on");
  try {
    w.seed("docs/CONTEXT.md");
    const opened = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "skip blanks" });
    await w.phases.context({ phaseId: opened.id, docs: ["docs/CONTEXT.md"], risks: { value: "none", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] });
    await w.phases.word({ phaseId: opened.id, turn: "context", decision: "yes", text: "да", by: "owner via screen" });
    w.phases.plan({ phaseId: opened.id, items: [planningPiece("a")], objective: "the goal", premortem: ["r1", "r2", "r3"], by: "planner" });
    const planned = getPhase(w.db, opened.id)!;
    const planSha = planned.record.plan!.sha;
    // The card's gap must be the owner's word, with all other plan-gate inputs already valid.
    savePhase(w.db, opened.id, {
      record: { ...planned.record, plan: { ...planned.record.plan!, critique: { decision: "approve", by: "critic", independence: { ok: true, why: "separate probe" } } } },
      at: 3,
    });
    const held = getPhase(w.db, opened.id)!;
    const gate = planGate(held.record);
    const afterWord = await w.phases.word({ phaseId: opened.id, turn: "planning", decision: "yes", text: "да", by: "owner", key: planSha });
    return {
      heldStage: held.stage,
      planningAsked: held.record.wordTurns?.planning?.asks ?? false,
      gate: gate.ok ? [] : gate.why,
      afterStage: afterWord.stage,
      admitted: afterWord.record.plan?.admittedSha === planSha,
      planningWord: afterWord.record.words?.some((word) => word.turn === "planning" && word.decision === "yes") ?? false,
    };
  } finally {
    w.restore();
  }
}

async function taskHomeParent() {
  const BASE = "/srv/proj";
  const { bb: host } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(host);
  createRun(db, "lprun_t", "proj", "bb", BASE);
  const files = new Map<string, string>();
  const bb = {
    log: { warn: () => undefined, info: () => undefined },
    sdk: { files: {
      read: async ({ path }: { path: string }) => (files.has(path) ? { content: files.get(path) } : null),
      write: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); },
    } },
  };
  const io = bbTaskFileIo(bb as never, "h1", BASE);
  const task = {
    schema_version: 2, id: "t1", title: "T", risk: "high", lane: "writer", project_cwd: BASE, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["src/a.ts"], owns_paths: ["src/**"], never_touch: [], depends_on: [], objective: "Save the form", acceptance: ["the form saves"],
    verify: "none", verification: [{ command: "npm test", cwd: BASE, timeout_sec: 60 }],
  };
  createTask(db, { id: "t1", runId: "lprun_t", kind: "bb", contract: task as never });
  await writeDispatchHome(db, io, { taskId: "t1", projectId: "proj", runId: "lprun_t", basePath: BASE, hostId: "h1", task: task as never, plan: "plan", phaseId: "ph_abc" });
  const manifest = renderTaskManifest(db, "t1") as { phase_id?: string | null; parent?: unknown } | null;
  return { phaseId: manifest?.phase_id ?? null, parent: manifest?.parent ?? null };
}

// Keep the drill's input set tied to real batch-b observations. The two cross-world observations below cover
// n33's planning-word hold and n67's task-home parent consumer; neither uses a hub or live scene.
const BATCH_B_OBSERVATIONS = [
  "question", "planHandIn", "planComposition", "drawStart", "admission", "designDecisions", "designWord", "drawingFolder",
  "drawStage", "designReadiness", "edition", "feasibility", "confirmed", "reviewTime", "execution", "designDoor", "phaseRow", "rubric",
] as const satisfies ReadonlyArray<keyof typeof observe>;

async function main() {
  const wanted = process.argv.slice(2);
  const names = (wanted.length ? wanted : [...BATCH_B_OBSERVATIONS, "ownerWordPlanning", "taskHomeParent"]) as string[];
  const seen: Record<string, unknown> = {};
  for (const name of names) {
    try {
      const run = name === "ownerWordPlanning" ? ownerWordPlanning : name === "taskHomeParent" ? taskHomeParent : (observe[name as keyof typeof observe] as () => unknown);
      seen[name] = await run();
    } catch (cause) { seen[name] = { threw: cause instanceof Error ? cause.message : String(cause) }; }
  }
  process.stdout.write(`${JSON.stringify(seen)}\n`);
}
void main();
