import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { candidatePath } from "../src/rooms/phase/server/candidate";
import { autoInputs } from "../src/rooms/phase/server/auto-stages";
import { candidateOn, planSignature, type PlanItem } from "../src/rooms/phase/logic";
import { recordStage } from "../src/rooms/runs/server";
import { listParts, savePhase } from "../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../src/rooms/storage";

// SMA p6_prepared → p6_authorized → p6_merge (2026-10-29 conformance audit, C-03): the pieces of a phase merged into main one by one and
// the phase was verified after; now they collect on phase/<id>, the verdict reads that tree and main gets it only once accepted.
const SHA = (n: number) => String(n).repeat(40).slice(0, 40);
const piece: PlanItem = { id: "hud", title: "Hud", wave: 1, promise: { given: "g", when: "w", then: "t" },
  task: { id: "hud", project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test", cwd: "/repo/app" }], acceptance: ["the bar stays centred"] } };

function world(opts: { sync?: string; integrate?: string; ensureFail?: boolean } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let head = SHA(1);
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    calls.push({ method, input });
    if (method === "runCommand" && opts.ensureFail && String(input.command).includes("worktree add")) return { exitCode: 4, stdout: "", stderr: "disk full" };
    if (method === "runCommand" && input.cwd === "/repo2" && String(input.command).includes("worktree add")) return { exitCode: 3, stdout: "", stderr: ".git is a file" };
    if (method === "runCommand") return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
    if (method === "gitSyncWorktree") return { status: opts.sync ?? "up-to-date", head, reason: null, conflicts: opts.sync === "conflict" ? ["src/hud.ts"] : [] };
    if (method === "gitIntegrate") return { status: opts.integrate ?? "merged", commit: SHA(9), conflicts: [], reason: null, base: SHA(1) };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const sent: Array<Record<string, unknown>> = [];
  const regressions: Array<Record<string, unknown>> = [];
  const services = {
    runBudgets: { get: () => undefined },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { sent.push(input.task); createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async (input: Record<string, unknown>) => { regressions.push(input); return { projects: [{ projectId: "projA", head, tasks: [{ taskId: "hud", checks: [{ command: "npm test", state: "green" }] }], findings: [] }] }; } },
    runGoal: { check: async () => { throw new Error("the run's goal check reads main, not the candidate"); } },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  return { phases, db, calls, sent, regressions, setHead: (sha: string) => { head = sha; } };
}

async function admitted(w: ReturnType<typeof world>) {
  const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  const sha = planSignature([piece], "ctx");
  savePhase(w.db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, waveReview: false, plan: { items: [piece], contextSha: "ctx", sha, admittedSha: sha } } as never, at: 2 });
  return phase.id;
}

function accept(w: ReturnType<typeof world>) {
  createAttempt(w.db, { id: "att1", runId: "run1", taskId: "hud" });
  w.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
  for (const stageId of ["verification", "plan-fact", "code-critique"] as const) recordStage(w.db, { runId: "run1", taskId: "hud", stageId, state: "passed", attempt: 1, input: stageId });
}

describe("the phase candidate", () => {
  it("issues every piece into the phase branch's tree, its absolute check folders moved with it [sma:p6_prepared]", async () => {
    const w = world();
    const id = await admitted(w);
    const after = await w.phases.drive(w.phases.list({ live: true })[0]!);
    const tree = candidatePath("/repo", id);
    expect(w.sent[0]).toMatchObject({ id: "hud", project_cwd: tree, verification: [{ command: "npm test", cwd: `${tree}/app` }] });
    expect(after.record.candidate).toMatchObject({ branch: `phase/${id}`, trees: { "/repo": { path: tree, startSha: SHA(1) } } });
    expect(w.calls.find((call) => call.method === "gitPrepareWorktree")?.input).toMatchObject({ basePath: "/repo", worktreePath: tree });
    expect(listParts(w.db, id).map((part) => part.kind)).toContain("candidate");
  });

  it("verifies the candidate's own tree and lands it on main only after every acceptance line holds [sma:p6_merge]", async () => {
    const w = world();
    const id = await admitted(w);
    await w.phases.drive(w.phases.list({ live: true })[0]!);
    accept(w);
    let phase = await w.phases.drive(w.phases.list({ live: true })[0]!);
    expect(phase.stage).toBe("verification");
    expect(w.regressions[0]).toMatchObject({ runId: "run1", basePaths: [candidatePath("/repo", id)] });
    expect(phase.record.candidate?.verified).toEqual({ "/repo": SHA(1) });
    expect(w.calls.some((call) => call.method === "gitIntegrate")).toBe(false);
    savePhase(w.db, id, { record: { ...phase.record, verification: { ...phase.record.verification!, model: { state: "met", by: "lp.close", summary: "ok", at: 3 } } } as never, at: 3 });
    phase = await w.phases.drive(w.phases.list({ live: true })[0]!);
    const integrate = w.calls.find((call) => call.method === "gitIntegrate");
    expect(integrate?.input).toMatchObject({ basePath: "/repo", worktreePath: candidatePath("/repo", id), committedOnly: true });
    expect(phase.record.candidate).toMatchObject({ landed: { "/repo": SHA(9) }, landedAt: expect.any(Number) });
    expect(["lessons", "closed"]).toContain(phase.stage);
    expect(w.calls.some((call) => call.method === "gitRemoveWorktree")).toBe(true);
  });

  async function atAcceptance(w: ReturnType<typeof world>) {
    const id = await admitted(w);
    await w.phases.drive(w.phases.list({ live: true })[0]!);
    accept(w);
    const phase = await w.phases.drive(w.phases.list({ live: true })[0]!);
    savePhase(w.db, id, { record: { ...phase.record, verification: { ...phase.record.verification!, model: { state: "met", by: "lp.close", summary: "ok", at: 3 } } } as never, at: 3 });
    return id;
  }

  it("verifies again when main moved into the candidate at the landing, and lands nothing [sma:p6_stale]", async () => {
    const w = world({ sync: "synced" });
    const id = await atAcceptance(w);
    const phase = await w.phases.drive(w.phases.list({ live: true })[0]!);
    expect(phase.stage).toBe("verification");
    expect(phase.record.verification?.verdict).toBeUndefined();
    expect(phase.record.candidate?.landedAt).toBeUndefined();
    expect(w.calls.some((call) => call.method === "gitIntegrate")).toBe(false);
    expect(listParts(w.db, id).at(-1)?.text).toMatch(/not the verified package: main moved/);
  });

  it("fails the verdict with the files of a conflict with main, so the machine plans the fix", async () => {
    const w = world({ sync: "conflict" });
    await atAcceptance(w);
    const phase = await w.phases.drive(w.phases.list({ live: true })[0]!);
    expect(phase.stage).toBe("verification");
    expect(phase.record.verification?.verdict).toMatchObject({ state: "failed", detail: expect.stringContaining("src/hud.ts") });
    expect(w.calls.some((call) => call.method === "gitIntegrate")).toBe(false);
  });

  it("waits at acceptance while main is busy, and says so once", async () => {
    const w = world({ integrate: "busy" });
    const id = await atAcceptance(w);
    await w.phases.drive(w.phases.list({ live: true })[0]!);
    const phase = await w.phases.drive(w.phases.list({ live: true })[0]!);
    expect(phase.stage).toBe("acceptance");
    expect(listParts(w.db, id).filter((part) => part.kind === "landing_wait")).toHaveLength(1);
  });

  it("points the wave review and the goal audit at the branch, not at main", async () => {
    const w = world();
    const id = await admitted(w);
    const phase = await w.phases.drive(w.phases.list({ live: true })[0]!);
    const review = autoInputs({ ...phase, record: { ...phase.record, execution: { ...phase.record.execution!, baseSha: SHA(1) } } }, { kind: "review", wave: 1 }) as { range: string; criteria: string[] };
    expect(review.range).toBe(`${SHA(1)}..phase/${id}`);
    expect(review.criteria[0]).toContain(candidatePath("/repo", id));
    expect((autoInputs(phase, { kind: "close" }) as { summary: string }).summary).toContain(`branch phase/${id}`);
  });

  it("keeps a phase that issued into main before going that way", async () => {
    const w = world();
    const id = await admitted(w);
    const phase = w.phases.list({ live: true })[0]!;
    savePhase(w.db, id, { record: { ...phase.record, execution: { issued: { other: "other" }, startedAt: 1 } } as never, at: 3 });
    const after = await w.phases.drive(w.phases.list({ live: true })[0]!);
    expect(after.record.candidate?.off).toMatch(/before the phase branch existed/);
    expect(w.sent[0]).toMatchObject({ project_cwd: "/repo" });
  });

  // SMA audit of C-03: a new head of the candidate before the acceptance cleared the verdict but kept the old goal check, so the new
  // verdict read the old trees' result; and a branch that could not be made (a full disk) sent the pieces to main before any acceptance.
  it("a candidate that moved before the acceptance is checked again, not judged by the old goal check [sma:p6_stale]", async () => {
    const w = world();
    const id = await admitted(w);
    await w.phases.drive(w.phases.status(id).phase);
    accept(w);
    let phase = await w.phases.drive(w.phases.status(id).phase);
    savePhase(w.db, id, { record: { ...phase.record, verification: { ...phase.record.verification!, model: { state: "met", by: "auditor", summary: "ok", at: 3 } } } as never, at: 3 });
    w.setHead(SHA(2));
    phase = await w.phases.drive(w.phases.status(id).phase);
    expect(phase.stage).toBe("verification");
    phase = await w.phases.drive(w.phases.status(id).phase);
    expect(w.regressions.length).toBe(2);
    expect(phase.record.candidate?.verified).toEqual({ "/repo": SHA(2) });
  });

  it("a phase branch that cannot be made for a passing reason holds the piece instead of sending it to main [sma:p6_merge]", async () => {
    const w = world({ ensureFail: true });
    const id = await admitted(w);
    const phase = await w.phases.drive(w.phases.status(id).phase);
    expect(w.sent).toHaveLength(0);
    expect(phase.record.candidate?.off).toBeUndefined();
    expect(phase.record.execution?.issueErrors?.hud).toContain("disk full");
  });

  // SMA audit R-04: a second checkout that cannot branch switched the whole candidate off after a piece was on it, and its piece went to main.
  it("a checkout without a branch of its own holds its piece and leaves the phase's candidate on [sma:p6_merge]", async () => {
    const w = world();
    const id = await admitted(w);
    const phase = w.phases.status(id).phase;
    const pieces = [piece, { ...piece, id: "second", task: { ...piece.task, id: "second", project_cwd: "/repo2", verification: [{ command: "npm test", cwd: "/repo2" }] } }];
    const sha = planSignature(pieces, "ctx");
    savePhase(w.db, id, { record: { ...phase.record, plan: { items: pieces, contextSha: "ctx", sha, admittedSha: sha } } as never, at: 3 });
    const after = await w.phases.drive(w.phases.status(id).phase);
    expect(candidateOn(after.record)).toBe(true);
    expect(w.sent.map((task) => task.project_cwd)).not.toContain("/repo2");
    expect(after.record.execution?.issueErrors?.second).toContain("lands as one package");
  });
});
