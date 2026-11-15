import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { sha256Hex } from "@lane-pilot/kit";
import { runPlanCritique } from "../src/rooms/critique/server/critique-runs/plan-critique";
import { prepareCriticPacket } from "../src/rooms/critique/server/critique-packet";
import { createRun, createTask, listRunFiles, openDatabase, openTaskHome, recordTaskFile, runHomeOf, setRunThread } from "../src/rooms/plugin-db";
import { bbTaskFileIo } from "../src/rooms/storage";

// The critic's input is one prepared packet (planPacket): small values inline, big ones as files under
// .agents/runs/<run>/inputs/ written, read back, hash-checked and recorded in the run manifest as step-input.
// A materialization failure is a named blocked result BEFORE any spawn — never an inline cut, never a silent proceed.

const task = { schema_version:2, id:"t1", title:"Fix", risk:"high", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:["a.ts"], owns_paths:["a.ts"], never_touch:[], depends_on:[], objective:"fix", acceptance:["done"], verify:"npm test",
  verification:[{ command:"npm test", cwd:"/repo" }] } as never;

function rig(filesWrite?: (args: { path: string; content: string }, store: Map<string, string>) => Promise<unknown>, readPatch?: (path: string, base: Record<string, unknown>) => Record<string, unknown>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const spawns: Array<{ prompt?: string }> = [];
  const files = new Map<string, string>();
  harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    if (!files.has(path)) throw Object.assign(new Error("not found"), { code: "not_found", status: 404 });
    const content = files.get(path)!;
    const base = { content, contentEncoding: "utf8", sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content, "utf8") };
    return readPatch ? readPatch(path, base) : base;
  });
  harness.sdk.stub("files.write", async (args: { path: string; content: string }) => {
    if (filesWrite) return filesWrite(args, files);
    files.set(args.path, args.content);
    return { outcome: "written" };
  });
  harness.sdk.stub("providers.list", async () => [{ id: "p1", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }]);
  harness.sdk.stub("providers.models", async () => ({ models: [{ id: "m1", model: "m1", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }));
  harness.sdk.stub("threads.spawn", async (args: { prompt?: string }) => { spawns.push(args); return { id: `thr_c${spawns.length}` }; });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_c1", status: "idle", projectId: "P" }));
  harness.sdk.stub("threads.output", async () => ({ output: '{"status":"pass","summary":"ok","findings":[],"evidence":"checked the plan"}' }));
  // waitThreadIdle completes only on a finished turn in the event stream; without it the spawn "times out" as infra.
  harness.sdk.stub("threads.events.list", async (args: { threadId?: string }) => [
    { type: "turn/started", threadId: args?.threadId, seq: 1 },
    { type: "turn/completed", threadId: args?.threadId, seq: 2, data: { status: "completed" } },
  ]);
  const db = openDatabase(bb);
  createRun(db, "r", "P", "cli", "/repo");
  setRunThread(db, "r", "pm-thread");
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
  const input = {
    bb, db, projectId: "P", runId: "r",
    stageHelperSettings: async () => ({ "plan_critique.provider": "p1", "plan_critique.model": "m1" }),
    taskId: "t1", config: { hostId: "h" } as never, task, plan: "plan\nwith lines",
  };
  return { bb, db, spawns, files, input };
}

it("a large plan and task reach the critic as refs: the prompt is bounded, the files are whole and hashed", async () => {
  const { db, spawns, files, input } = rig();
  const bigPlan = `PLAN-BODY-START\n${"plan line\n".repeat(900)}PLAN-BODY-END`;
  const out = await runPlanCritique({ ...input, plan: bigPlan } as never);
  expect(out.allowed).toBe(true);
  expect(spawns).toHaveLength(1);
  const prompt = String(spawns[0]!.prompt);
  expect(prompt).toContain(".agents/runs/r/inputs/");
  expect(prompt).toContain("file:");
  expect(prompt).not.toContain("PLAN-BODY-END"); // the body is not pasted into the prompt
  const refs = [...files.keys()].filter((path) => path.includes("/.agents/runs/r/inputs/"));
  expect(refs.length).toBeGreaterThan(0);
  const planFile = refs.map((path) => files.get(path)!).find((text) => text.includes("PLAN-BODY-END"))!;
  expect(planFile).toContain(bigPlan); // the file holds the WHOLE plan, not a cut
  const rows = listRunFiles(db, "r").filter((row) => row.kind === "step-input");
  expect(rows.length).toBe(refs.length);
  for (const row of rows) expect(row.sha256).toBe(sha256Hex(files.get(`/repo/${row.repo_path}`)!));
  expect(runHomeOf(db, "r")?.base_path).toBe("/repo");
});

it("a write failure is a named blocked result with zero critic spawns", async () => {
  const { db, spawns, input } = rig(async () => { throw new Error("disk full"); });
  const out = await runPlanCritique({ ...input, plan: "x".repeat(2000) } as never);
  expect(out.allowed).toBe(false);
  expect(out.reason).toMatch(/^plan_critique_input_failed:/);
  expect(spawns).toHaveLength(0);
});

it("a read-back that does not match the written bytes blocks the same way", async () => {
  const { spawns, input } = rig(async ({ content }) => { return { outcome: "written", _stored: content }; });
  // files.write "succeeds" but stores nothing readable: the verify read returns not_found.
  const out = await runPlanCritique({ ...input, plan: "x".repeat(2000) } as never);
  expect(out.allowed).toBe(false);
  expect(out.reason).toMatch(/^plan_critique_input_failed:packet_ref_verify_failed/);
  expect(spawns).toHaveLength(0);
});

it("a retry after a materialization failure re-materializes the same content-addressed refs and then spawns", async () => {
  let fail = true;
  const { db, spawns, input } = rig(async (args, store) => {
    if (fail) throw new Error("disk full");
    store.set(args.path, args.content);
    return { outcome: "written" };
  });
  const plan = { ...input, plan: "y".repeat(1500) };
  const first = await runPlanCritique(plan as never);
  expect(first.allowed).toBe(false);
  expect(first.reason).toMatch(/^plan_critique_input_failed:/);
  expect(spawns).toHaveLength(0);
  fail = false;
  const second = await runPlanCritique(plan as never);
  expect(second.allowed).toBe(true);
  expect(spawns).toHaveLength(1);
  const paths = listRunFiles(db, "r").filter((row) => row.kind === "step-input").map((row) => row.repo_path);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => path.startsWith(".agents/runs/r/inputs/"))).toBe(true);
  // the packet the retry spawned with names the same refs the failed attempt would have written (content-addressed)
  expect(String(spawns[0]!.prompt)).toContain(paths[0]!.split("/").pop()!);
});

it("different bytes already at a content-addressed path refuse the write: zero spawns; same bytes are reused", async () => {
  const conflict = rig(async () => ({ outcome: "conflict", currentSha256: "0".repeat(64) }));
  const blocked = await runPlanCritique({ ...conflict.input, plan: "x".repeat(2000) } as never);
  expect(blocked.allowed).toBe(false);
  expect(blocked.reason).toMatch(/^plan_critique_input_failed:/);
  expect(conflict.spawns).toHaveLength(0);
  // Real CAS: only the content-addressed input refs "already exist" with the same bytes; the run manifest is a fresh write.
  const reuse = rig(async (args, store) => {
    store.set(args.path, args.content);
    return args.path.includes("/.agents/runs/") && args.path.includes("/inputs/")
      ? { outcome: "conflict", currentSha256: sha256Hex(args.content) }
      : { outcome: "written" };
  });
  const ok = await runPlanCritique({ ...reuse.input, plan: "x".repeat(2000) } as never);
  expect(ok.allowed).toBe(true);
  expect(reuse.spawns).toHaveLength(1);
});

it("a homed task's changed PLAN.md or plan-source revision invalidates a kept passed receipt", async () => {
  const { bb, db, spawns, input } = rig();
  openTaskHome(db, { taskId: "t1", projectId: "P", runId: "r", basePath: "/repo", hostId: "h" });
  const io = bbTaskFileIo(bb as never, "h", "/repo");
  const producer = { node: "dispatch" };
  await recordTaskFile(db, io, { taskId: "t1", kind: "plan", name: "PLAN.md", content: "plan v1\n", producer });
  await recordTaskFile(db, io, { taskId: "t1", kind: "plan-source", name: "context/plan-source.md", content: "source v1\n", producer });
  const call = { ...input, plan: "the plan text" };
  await runPlanCritique(call as never);
  expect(spawns).toHaveLength(1);
  // A kept pass on this exact input is reused without a spawn.
  db.prepare("UPDATE lane_pilot_stage_receipt SET state='passed', result_json=? WHERE run_id='r' AND task_id='t1' AND stage_id='plan-critique'").run(JSON.stringify({ decision: "approve" }));
  await runPlanCritique(call as never);
  expect(spawns).toHaveLength(1);
  // A new PLAN.md revision changes the manifest hash bound into the input: the kept receipt no longer matches.
  await recordTaskFile(db, io, { taskId: "t1", kind: "plan", name: "PLAN.md", content: "plan v2 changed\n", producer });
  await runPlanCritique(call as never);
  expect(spawns).toHaveLength(2);
  // Same for the plan-source snapshot.
  db.prepare("UPDATE lane_pilot_stage_receipt SET state='passed', result_json=? WHERE run_id='r' AND task_id='t1' AND stage_id='plan-critique'").run(JSON.stringify({ decision: "approve" }));
  await recordTaskFile(db, io, { taskId: "t1", kind: "plan-source", name: "context/plan-source.md", content: "source v2 changed\n", producer });
  await runPlanCritique(call as never);
  expect(spawns).toHaveLength(3);
});

it("a drifted plan-source file blocks even over a kept passed receipt: zero new spawns", async () => {
  const { bb, db, spawns, files, input } = rig();
  openTaskHome(db, { taskId: "t1", projectId: "P", runId: "r", basePath: "/repo", hostId: "h" });
  const io = bbTaskFileIo(bb as never, "h", "/repo");
  const producer = { node: "dispatch" };
  await recordTaskFile(db, io, { taskId: "t1", kind: "plan", name: "PLAN.md", content: "plan v1\n", producer });
  await recordTaskFile(db, io, { taskId: "t1", kind: "plan-source", name: "context/plan-source.md", content: "source v1\n", producer });
  const call = { ...input, plan: "the plan text" };
  await runPlanCritique(call as never);
  expect(spawns).toHaveLength(1);
  db.prepare("UPDATE lane_pilot_stage_receipt SET state='passed', result_json=? WHERE run_id='r' AND task_id='t1' AND stage_id='plan-critique'").run(JSON.stringify({ decision: "approve" }));
  // The manifest still records source v1, but the file on the host now holds different bytes: drift, not a new revision.
  files.set("/repo/.agents/tasks/t1/context/plan-source.md", "tampered source\n");
  const out = await runPlanCritique(call as never);
  expect(out.allowed).toBe(false);
  expect(out.reason).toMatch(/^plan_critique_input_failed:plan_source_hash_mismatch/);
  expect(spawns).toHaveLength(1); // the kept receipt was never reached: validation precedes reuse
});

it("an explicit plan path whose read cannot be proven whole is a named failure with zero spawns", async () => {
  const { spawns, files, input } = rig(undefined, (path, base) =>
    path === "/repo/PLAN-FILE.md" ? { ...base, sizeBytes: Number(base.sizeBytes) + 500 } : base);
  files.set("/repo/PLAN-FILE.md", "short plan\n");
  const out = await runPlanCritique({ ...input, plan: "/repo/PLAN-FILE.md" } as never);
  expect(out.allowed).toBe(false);
  expect(out.reason).toMatch(/^plan_critique_input_failed:plan_file_truncated/);
  expect(spawns).toHaveLength(0);
});

it("prepareCriticPacket keeps a small input fully inline with no files and no run home", async () => {
  const { bb, db } = rig();
  const got = await prepareCriticPacket(bb, db, {
    runId: "r2", projectId: "P", hostId: "h", checkoutPath: "/repo",
    step: { id: "plan-critique", role: "plan-critic", mode: "standard" },
    inputs: [{ name: "task", value: { title: "tiny" } }, { name: "plan", value: "do it" }],
  });
  expect(got.packet).toContain("do it");
  expect(Object.keys(got.refs)).toEqual([]);
  expect(runHomeOf(db, "r2")).toBeNull(); // nothing spilled -> no empty run folder
});

// The PM reader's report reaches the critic only as its openQuestions (critique.ts boundary): summary/keyFacts
// stay out of the prompt and every packet file, a short set stays inline, a long one goes by reference, and a
// malformed or empty context contributes no questions input at all.
const pmReadWith = (openQuestions: string[]) =>
  JSON.stringify({ summary: "PM-SUMMARY-SECRET", keyFacts: ["PM-FACT-SECRET"], openQuestions });

it("the packet carries only the reader's open questions: short inline, long by reference, secrets nowhere", async () => {
  const short = rig();
  const outShort = await runPlanCritique({ ...short.input, pmReadContext: pmReadWith(["Does the plan cover the retry path?"]) } as never);
  expect(outShort.allowed).toBe(true);
  const promptShort = String(short.spawns[0]!.prompt);
  expect(promptShort).toContain("Does the plan cover the retry path?");
  expect(promptShort).not.toContain("PM-SUMMARY-SECRET");
  expect([...short.files.values()].join("\n")).not.toContain("PM-SUMMARY-SECRET");
  expect(promptShort).not.toContain("PM-FACT-SECRET");
  expect([...short.files.values()].join("\n")).not.toContain("PM-FACT-SECRET");

  const long = rig();
  const questions = Array.from({ length: 8 }, (_, i) => `Question ${i}? ${"detail ".repeat(60)}`);
  const outLong = await runPlanCritique({ ...long.input, pmReadContext: pmReadWith(questions) } as never);
  expect(outLong.allowed).toBe(true);
  const promptLong = String(long.spawns[0]!.prompt);
  const questionPath = [...long.files.keys()].find((key) => long.files.get(key)!.includes("Question 0?"))!;
  expect(questionPath).toContain("/.agents/runs/r/inputs/");
  expect(promptLong).toContain(`file: ${questionPath.replace(/^\/repo\//, "")}`);
  expect(promptLong).not.toContain(questions[7]!);
  const questionFile = long.files.get(questionPath)!;
  for (const question of questions) expect(questionFile).toContain(question);
  const deliveredLong = [...long.files.values()].join("\n");
  expect(promptLong).not.toContain("PM-SUMMARY-SECRET");
  expect(deliveredLong).not.toContain("PM-SUMMARY-SECRET");
  expect(promptLong).not.toContain("PM-FACT-SECRET");
  expect(deliveredLong).not.toContain("PM-FACT-SECRET");
});

it("malformed, empty or questionless pm-read context yields no questions input", async () => {
  for (const pmReadContext of ["not json{", "", JSON.stringify({ summary: "PM-SUMMARY-SECRET" }), undefined]) {
    const { spawns, files, input } = rig();
    const out = await runPlanCritique({ ...input, pmReadContext } as never);
    expect(out.allowed).toBe(true);
    const all = String(spawns[0]!.prompt) + "\n" + [...files.values()].join("\n");
    expect(all).not.toContain("pm-read-open-questions");
    expect(all).not.toContain("PM-SUMMARY-SECRET");
  }
});
