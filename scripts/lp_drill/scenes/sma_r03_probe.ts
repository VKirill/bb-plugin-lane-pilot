// Probe of scenes/sma_r03.py (region 3, the worker): runs the REAL code of THIS checkout (the commit under drill) on stand-in hosts, scratch databases and
// temporary folders, and prints what it saw as one JSON line. It judges nothing: the scene compares each value with the card's expected result and
// prove()s it. No model turn, no hub write, no real sudo (a fake one is put on PATH for the script checks).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WORKER_ENVELOPE } from "../../../src/rooms/tasks/rails";
import { adapterVersions, capabilityTable, dueProbes } from "../../../src/rooms/capability/logic";
import { asWorker, workerReachable } from "../../../src/rooms/verification/worker-user";
import { resolveSandboxBackend } from "../../../src/rooms/verification/sandbox";
import { runCodeCritique } from "../../../src/rooms/critique/server/critique-runs";
import { stageHelperSettings } from "../../../src/rooms/settings/server/stage-settings";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveProjectSetting, setRunThread } from "../../../src/rooms/plugin-db";
import { creatorBrief } from "../../../src/rooms/forge/logic";
import { CORE_PROVIDER_GROUPS } from "../../../src/rooms/contracts/helper-context";
import {
  acceptedReceipts, capabilitySweep, checksAsWorker, confinedRun, contract, criticEnvironments, folderGrants, guardOnce, permitChannel, permitDecision,
  pmActivation, roleModels, workerUserScript, writerLauncher, writerLaunch,
} from "../../../tests/sma/r03-world-a";

const ROOT = join(__dirname, "../../..");
const flow = (file: string) => (JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { nodes: Array<{ id: string; role?: string }> }).nodes;
const attempt = (run: () => unknown) => { try { run(); return null; } catch (cause) { return (cause as Error).message; } };

async function critic(answer: string) {
  const spawns: Array<Record<string, unknown>> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const models = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol", "test-model"];
  harness.sdk.stub("providers.list", async () => ["claude-code", "codex"].map((id) => ({ id, available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] })));
  harness.sdk.stub("providers.models", async () => ({ models: models.map((id) => ({ id, model: id, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort })) })) }));
  harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", projectId: "P", parentThreadId: "thr_root", sourceThreadId: "thr_root", lifecycleOwnerThreadId: "thr_root", status: "idle" }));
  harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: `crit${spawns.length}` }; });
  harness.sdk.stub("threads.output", async () => ({ output: answer }));
  harness.sdk.stub("threads.stop", async () => undefined);
  harness.sdk.stub("files.read", async () => ({ content: "export const a = 1;\n", contentEncoding: "utf8" }));
  bb.hosts.experimental_client = (() => ({ call: async () => ({}) })) as never;
  const db = openDatabase(bb);
  createRun(db, "r", "P", "bb", "/repo");
  setRunThread(db, "r", "thr_pm");
  const task = { ...contract("t1"), project_cwd: "/repo", risk: "medium" } as never;
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
  createAttempt(db, { id: "a1", runId: "r", taskId: "t1" });
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo', environment_id='env_wt' WHERE id='a1'").run();
  saveProjectSetting(db, "P", "code_critique.enabled", true);
  saveProjectSetting(db, "P", "code_critique.mode", "gate");
  const hash = "d".repeat(64);
  const evidence = { truncated: false, artifactRevisionSha256: hash, evidenceSha256: hash, revisionSha256: hash, produced: ["src/a.ts"], hashes: {}, baselineHashes: {},
    verification: [{ command: "npm test", exitCode: 0 }], files: [{ path: "src/a.ts", diff: "+export const a = 1;", content: "export const a = 1;\n" }],
    packetSha256: hash, outputSha256: hash, ownsPaths: ["src/**"], neverTouch: [] };
  const config = { projectId: "P", hostId: "h1", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "claude-code", pmModel: "claude-opus-5-5", writerProviderId: "claude-code", writerModel: "claude-opus-5-5" } as never;
  const result = await runCodeCritique({ stageHelperSettings, bb, db, projectId: "P", runId: "r", taskId: "t1", config, task, evidence } as never);
  const receipt = listStageReceipts(db, "r", "t1").find((row) => row.stageId === "code-critique");
  await harness.lifecycle.dispose();
  return { allowed: (result as { allowed: boolean }).allowed, role: (spawns[0]?.pluginMetadata as { role?: string } | undefined)?.role, environment: spawns[0]?.environment, receipt: receipt?.state };
}

const ALL_CELLS = ["answers", "documentary.nested", "documentary.role", "documentary.hooks", "documentary.session_end", "pause", "accounting", "progress", "gate"];
const observe: Record<string, () => unknown> = {
  n383: () => ({ keys: Object.keys(WORKER_ENVELOPE), files: WORKER_ENVELOPE.files }),
  n384: () => writerLauncher(),
  n385: () => ({ writerClean: guardOnce("git clean -fd", "writer", "writer").tickets.map((row) => row.category), writerReset: guardOnce("git reset --hard", "writer", "writer").tickets.map((row) => row.category) }),
  n386: () => permitChannel(),
  n387: () => permitDecision(),
  n388: () => capabilityTable(new Map([["codex", "m"], ["claude-code", "m"]]), new Map([["codex", "1#k"]]), [{ providerId: "codex", version: "1#k", capability: "pause", state: "supported", model: "m", detail: null, at: 1 }]),
  sweep: () => capabilitySweep(),
  n392: () => ({
    unprobed: dueProbes(new Map([["codex", "m"]]), new Map([["codex", "1"]]), []),
    noVersion: dueProbes(new Map([["codex", "m"]]), new Map([["codex", null]]), []),
    settled: dueProbes(new Map([["codex", "m"]]), new Map([["codex", "1"]]), ALL_CELLS.map((capability) => ({ providerId: "codex", version: "1", capability: capability as never, state: "supported" as const, model: "m", detail: null, at: 1 }))),
  }),
  n395: () => [...adapterVersions([{ id: "codex", pluginId: "provider-codex" }, { id: "acp", pluginId: null }, { id: "ghost", pluginId: "gone" }], [{ id: "provider-codex", version: "0.1.0" }]).entries()],
  n396: () => workerUserScript(),
  n398: () => ({ args: asWorker("lp-worker", "/bin/echo", ["hi"], ["A", "B", "A"]), threw: attempt(() => asWorker("Bad User", "x", [], [])) }),
  n399: () => folderGrants(),
  n400: async () => ({ on: await checksAsWorker({ "worker.strict_user": "on" }), off: await checksAsWorker({}) }),
  n401: async () => ({ resolved: [resolveSandboxBackend("auto", "linux", false, true), resolveSandboxBackend("auto", "darwin", true, false)], missing: attempt(() => resolveSandboxBackend("auto", "linux", false, false)), run: await confinedRun() }),
  n402: () => criticEnvironments(),
  n403: () => acceptedReceipts(),
  n404: async () => ({ invalid: await workerReachable("Bad User"), unknown: await workerReachable("lp-sma-no-such-user") }),
  n406: async () => ({ writer: await writerLaunch(false), emergency: (await writerLaunch(true)).role }),
  n407: () => flow("workflows/lp.plan.json").filter((node) => node.role).map((node) => node.role),
  n408: () => flow("workflows/lp.draw.json").filter((node) => node.role).map((node) => `${node.id}:${node.role}`),
  n409: async () => critic(JSON.stringify({ decision: "approve", summary: "fine", findings: [] })),
  n410: () => pmActivation(),
  n411: () => creatorBrief("skill", "cell-sum", "skip empty cells"),
  n412: () => CORE_PROVIDER_GROUPS,
  n413: () => roleModels(),
};

async function main() {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(observe);
  const seen: Record<string, unknown> = {};
  for (const name of names) {
    try { seen[name] = await observe[name]!(); } catch (cause) { seen[name] = { threw: cause instanceof Error ? cause.message : String(cause) }; }
  }
  process.stdout.write(`${JSON.stringify(seen)}\n`);
}
void main();
