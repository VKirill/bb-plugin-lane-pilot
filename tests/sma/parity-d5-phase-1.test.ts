import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  acceptanceLines, nextAction, pieceLines, pieceSha, planGate, planSignature, waveLines,
  type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";
import { autoDue } from "../../src/rooms/phase/server/auto-stages";
import { milestoneOf, uatState, validationGaps } from "../../src/rooms/phase/stages";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";
import { sha256Hex } from "@lane-pilot/kit";

const phase = (record: PhaseRecord, stage: Phase["stage"] = "planning", over: Partial<Phase> = {}): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0, ...over,
});
const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: [`acc-${id}`] }, ...over,
});
const uiItem = (id: string): PlanItem => item(id, { task: { ...item(id).task, owns_paths: ["src/app.tsx"], qa_cases: [{ name: "c" }], qa_url: "http://x" } });
const fact = (taskId: string, over: Partial<TaskFact> = {}): TaskFact => ({ taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "passed", qaPlanned: true, ...over });
const SHA = "a".repeat(64);
const ctxReady = () => ({ docs: [], sha: "ctx", signedAt: 1, legacy: true });
const planRec = (items: PlanItem[], over: Partial<NonNullable<PhaseRecord["plan"]>> = {}): NonNullable<PhaseRecord["plan"]> => ({
  items, contextSha: "ctx", sha: planSignature(items, "ctx"), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } },
  objective: "o", premortem: ["a", "b", "c"], ...over });

function driver() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const writes: Array<{ path: string; content: string }> = [];
  const commits: Array<{ paths: string[]; message: string }> = [];
  const hostCalls: string[] = [];
  const texts = new Map<string, string>();
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    hostCalls.push(method);
    if (method === "writePhaseBook") return { status: "applied", writes: (input.edits as Array<{ path: string; content: string }>).map((edit) => { writes.push(edit); texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    if (method === "gitCommitDocs") { commits.push({ paths: input.paths as string[], message: input.message as string }); return { commit: "c".repeat(40) }; }
    if (method === "runCommand") return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h' WHERE id='run1'").run();
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { if (texts.has(i.path)) { const c = texts.get(i.path)!; return { content: c, sha256: sha256Hex(c), sizeBytes: c.length }; } throw new Error("no file"); },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services).phases;
  return { phases, db, writes, commits, hostCalls, texts };
}

async function opened(d: ReturnType<typeof driver>, record: PhaseRecord, stage: Phase["stage"], state: Phase["state"] = "active") {
  const phase = await d.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  savePhase(d.db, phase.id, { stage, state, runId: "run1", record: { ...phase.record, ...record }, at: 2 });
  return phase.id;
}

describe("phase parity d5", () => {
  it("[sma:k_wp_closed] a closed phase refuses returnTo planning and setState resume", async () => {
    const d = driver();
    const items = [item("p1")];
    const id = await opened(d, { plan: planRec(items, { admittedSha: planSignature(items, "ctx") }) }, "execution", "closed");
    savePhase(d.db, id, { stage: "closed", at: 3 });
    await expect(async () => d.phases.returnTo({ phaseId: id, to: "planning", note: "again" })).rejects.toThrow(/closed/);
    await expect(async () => d.phases.setState({ phaseId: id, state: "resume" })).rejects.toThrow(/closed/);
    expect(getPhase(d.db, id)!.stage).toBe("closed");
    expect(getPhase(d.db, id)!.state).toBe("closed");
  });

  it("[sma:k_wp_bounce] autoDue returns bounce once per plan sha when the setting is on, never when off", () => {
    const items = [item("p1")];
    const plan = planRec(items);
    const on = phase({ context: ctxReady(), plan, planBounce: true });
    expect(autoDue(on)).toMatchObject({ kind: "bounce" });
    const bounced = phase({ context: ctxReady(), plan: { ...plan, bounce: { sha: plan.sha, decision: "approve", at: 1 } }, planBounce: true });
    expect(autoDue(bounced)?.kind === "bounce").toBe(false);
    const off = phase({ context: ctxReady(), plan });
    expect(autoDue(off)?.kind === "bounce").toBe(false);
  });

  it("[sma:k_we_uiqa] the live check sits between the verdict and the goal audit", () => {
    const verdict = { state: "passed" as const, detail: "ok", mainSha: "h", at: 1, inputSha: "i" };
    const withUi = phase({ liveCheck: true, plan: planRec([uiItem("p1")]), verification: { verdict } }, "verification");
    expect(autoDue(withUi)).toMatchObject({ kind: "live" });
    // A project that did not switch the browser check on goes straight to the close, as before.
    expect(autoDue(phase({ plan: planRec([uiItem("p1")]), verification: { verdict } }, "verification"))).toMatchObject({ kind: "close" });
    const stored = phase({ liveCheck: true, plan: planRec([uiItem("p1")]), verification: { verdict, live: { state: "passed" as const, head: "h", at: 2 } } }, "verification");
    expect(autoDue(stored)).toMatchObject({ kind: "close" });
    const noUi = phase({ plan: planRec([item("p1")]), verification: { verdict } }, "verification");
    expect(autoDue(noUi)).toMatchObject({ kind: "close" });
    expect(nextAction(withUi, new Map()).key).toBe("verification:live");
    expect(nextAction(stored, new Map()).waitsForPm).toBe(true);
  });

  it("[sma:k_we_verify] visible work owes a live check on the same candidate", () => {
    // Plan gate: where browser_qa is on, a visible piece without qa_cases/qa_url is refused; off (the default) it is not.
    expect(validationGaps([uiItem("p1")], false).join(" ")).not.toContain("live check");
    const noQa = item("p1", { task: { ...item("p1").task, owns_paths: ["src/app.tsx"] } });
    expect(validationGaps([noQa], false).join(" ")).toContain("live check");
    expect(validationGaps([noQa])).toHaveLength(0);
    // Piece line: visible work with no passed browser check fails whether or not it planned qa_cases.
    const ui = uiItem("p1");
    expect(pieceLines(ui, fact("t1", { browserQa: "skipped", qaPlanned: false }), undefined, true).find((l) => l.id === "qa_read")!.ok).toBe(false);
    expect(pieceLines(ui, fact("t1", { browserQa: "skipped", qaPlanned: false })).find((l) => l.id === "qa_read")!.ok).toBe(true);
    // Acceptance: a live check taken on another head fails the line.
    const verdict = { state: "passed" as const, detail: "ok", mainSha: "h", at: 1, inputSha: "i" };
    const ph = phase({ liveCheck: true, plan: planRec([ui], { admittedSha: planSignature([ui], "ctx") }), ownerWords: false,
      candidate: { branch: "phase/x", trees: { "/r": { path: "/r/t", startSha: "s" } }, verified: { "/r": "v1" } },
      verification: { verdict, live: { state: "passed" as const, head: "v0", at: 2 } } }, "acceptance");
    const lines = acceptanceLines(ph, new Map([["p1", fact("t1")]]), { mainSha: "v1", openDeferrals: 0 });
    const qa = lines.find((l) => l.id === "qa_read")!;
    expect(qa.ok).toBe(false);
    expect(qa.detail).toContain("same candidate");
    const ph2 = phase({ ...ph.record, verification: { verdict, live: { state: "passed" as const, head: "v1", at: 2 } } }, "acceptance");
    expect(acceptanceLines(ph2, new Map([["p1", fact("t1")]]), { mainSha: "v1", openDeferrals: 0 }).find((l) => l.id === "qa_read")!.ok).toBe(true);
  });

  it("[sma:k_wd_c1] reporting a drawing commits exactly its manifest paths", async () => {
    const d = driver();
    const items = [uiItem("p1")];
    const id = await opened(d, { plan: planRec(items, { admittedSha: planSignature(items, "ctx") }),
      design: { decision: "needed", why: "x" } }, "design");
    d.texts.set(".agents/phases/x/design/UI-SPEC.md", "# spec\n## Actions\n## Screens\n## Texts\n## Heuristics\n## Accessibility\n");
    const drawing = await d.phases.drawing({ phaseId: id, paths: [`.agents/phases/${id}/design/UI-SPEC.md`, `.agents/phases/${id}/design/kit.png`].map((p) => { d.texts.set(p, "x"); return p; }),
      designer: "lp.draw", feasible: true, reviewer: "ui-review" });
    const commit = d.commits.find((c) => c.message.includes("drawing and UI contract"));
    expect(commit?.paths).toEqual(drawing.record.design?.drawing?.paths);
    expect(getPhase(d.db, id)!.record.design?.drawing?.commit).toBe("c".repeat(40));
  });

  it("[sma:k_wd_version] a replaced drawing keeps its commit and leaves a link", async () => {
    const d = driver();
    const items = [uiItem("p1")];
    const id = await opened(d, { plan: planRec(items, { admittedSha: planSignature(items, "ctx") }), design: { decision: "needed", why: "x" } }, "design");
    const spec = (name: string) => { const p = `.agents/phases/${id}/design/${name}`; d.texts.set(p, "# spec\n## Actions\n## Screens\n## Texts\n## Heuristics\n## Accessibility\n"); return p; };
    const a = [spec("UI-SPEC.md"), `.agents/phases/${id}/design/old.png`].map((p) => { d.texts.set(p, d.texts.get(p) ?? "old-bytes"); return p; });
    savePhase(d.db, id, { stage: "planning", at: 3 });
    savePhase(d.db, id, { stage: "design", at: 4 });
    await d.phases.drawing({ phaseId: id, paths: a, designer: "lp.draw", feasible: true, reviewer: "ui-review" });
    savePhase(d.db, id, { stage: "design", at: 5 });
    const b = [spec("UI-SPEC.md"), `.agents/phases/${id}/design/new.png`].map((p) => { d.texts.set(p, "new"); return p; });
    await d.phases.drawing({ phaseId: id, paths: b, designer: "lp.draw", feasible: true, reviewer: "ui-review" });
    const archived = getPhase(d.db, id)!.record.design?.archived?.[0];
    expect(archived?.commit).toBe("c".repeat(40));
    const stub = d.writes.find((w) => w.path === `.agents/phases/${id}/design/old.png`);
    expect(stub?.content).toContain("Superseded by");
    expect(stub?.content).toContain("new.png");
  });

  it("[sma:k_c_pause] pausing a phase writes HANDOFF.json and PAUSE.md", async () => {
    const d = driver();
    const items = [item("p1")];
    const sha = planSignature(items, "ctx");
    const id = await opened(d, { plan: planRec(items, { admittedSha: sha }),
      execution: { issued: { p1: "p1" }, issuedSha: { p1: pieceSha(items[0]!) } } }, "execution");
    await d.phases.setState({ phaseId: id, state: "pause", by: "owner" });
    await new Promise((r) => setTimeout(r, 50));
    const handoff = d.writes.find((w) => w.path.endsWith("HANDOFF.json"));
    const note = d.writes.find((w) => w.path.endsWith("PAUSE.md"));
    expect(handoff && note).toBeTruthy();
    const json = JSON.parse(handoff!.content);
    expect(json.stage).toBe("execution");
    expect(json.nextAction.key).toBeTruthy();
    expect(json.pieces[0].taskId).toBe("p1");
    expect(note!.content).toContain("resume");
  });

  it("[sma:k_we_branch] the branching setting picks the marker branch name", async () => {
    const d = driver();
    const id = await opened(d, { branch: "milestone", roadmapRow: "1.1", closedDocs: undefined }, "closed");
    savePhase(d.db, id, { record: { ...getPhase(d.db, id)!.record, bookWritten: { seq: 0, sha256: "", at: 1 } }, at: Date.now() });
    d.texts.set(".agents/planning/ROADMAP.md", "# Map\n\n## Milestone v1\n\n- [ ] 1.1 Hud — build it\n");
    expect(milestoneOf(d.texts.get(".agents/planning/ROADMAP.md")!, "1.1")).toBe("v1");
    await d.phases.tick();
    const parts = listParts(d.db, id).filter((p) => p.kind === "branch");
    // The host ran `git branch -f milestone/v1 HEAD`.
    expect(parts.at(-1)?.text).toContain("milestone/v1");
  });

  it("[sma:k_wdi_existing] an existing CONTEXT.md is kept under Earlier decisions", async () => {
    const d = driver();
    const id = await opened(d, {}, "discussion");
    d.texts.set(`.agents/phases/${id}/CONTEXT.md`, "D1: keep this decision always");
    // apply() reads via deps.readText; simulate through the wiring of the driver's auto machine is heavy —
    // exercise the doc layer directly through the auto stage's write path.
    const { createAutoStages } = await import("../../src/rooms/phase/server/auto-stages");
    const written: Array<{ path: string; content: string }> = [];
    const booked: string[] = [];
    const auto = createAutoStages({ log: () => undefined } as never, { workflowEngine: {} } as never, {
      api: { context: async () => getPhase(d.db, id)!, plan: () => getPhase(d.db, id)!, planCheck: async () => getPhase(d.db, id)!,
        question: () => getPhase(d.db, id)!, waveReview: () => getPhase(d.db, id)!, goalAudit: () => getPhase(d.db, id)!,
        lessons: () => getPhase(d.db, id)!, drawing: async () => getPhase(d.db, id)!, returnTo: () => getPhase(d.db, id)! },
      exhausted: async () => undefined, get: () => getPhase(d.db, id)!,
      save: (_id, record) => savePhase(d.db, id, { record, at: 9 }),
      book: (_p, _s, kind, text) => booked.push(`${kind}:${text}`),
      writeDocs: async (_p, files) => { written.push(...files); files.forEach((f) => d.texts.set(f.path, f.content)); return { written: files.map((f) => f.path) }; },
      readText: async (_p, path) => d.texts.get(path) ?? null,
      runtime: () => null, pmIdle: async () => true, now: () => 10,
    });
    const ph = getPhase(d.db, id)!;
    await auto.apply(ph, { kind: "analyze", wfRunId: "w1", startedAt: 1 }, { decisions: [{ id: "D2", text: "new decision" }], risks: [], open_questions: [], appetite: "small", no_gos: ["none"] });
    const doc = written.find((w) => w.path.endsWith("CONTEXT.md"));
    expect(doc?.content).toContain("D1: keep this decision always");
    expect(doc?.content).toContain("Earlier decisions (kept)");
    expect(booked.join(" ")).toContain("context_existing");
  });

  it("[sma:k_wr_commit] a finished review writes REVIEW.md with a section per wave", async () => {
    const d = driver();
    const id = await opened(d, { plan: planRec([item("p1"), item("p2", { wave: 2 })], { admittedSha: planSignature([item("p1"), item("p2", { wave: 2 })], "ctx") }),
      execution: { issued: {}, issuedSha: {}, waves: { "1": { packageSha: "x", lines: [], at: 1 } } } }, "execution");
    const { createAutoStages } = await import("../../src/rooms/phase/server/auto-stages");
    const auto = createAutoStages({ log: () => undefined } as never, { workflowEngine: {} } as never, {
      api: { context: async () => getPhase(d.db, id)!, plan: () => getPhase(d.db, id)!, planCheck: async () => getPhase(d.db, id)!,
        question: () => getPhase(d.db, id)!, waveReview: () => getPhase(d.db, id)!, goalAudit: () => getPhase(d.db, id)!,
        lessons: () => getPhase(d.db, id)!, drawing: async () => getPhase(d.db, id)!, returnTo: () => getPhase(d.db, id)! },
      exhausted: async () => undefined, get: () => getPhase(d.db, id)!,
      save: (_i, record) => savePhase(d.db, id, { record, at: 9 }),
      book: () => undefined,
      writeDocs: async (_p, files) => { files.forEach((f) => d.texts.set(f.path, f.content)); d.writes.push(...files); return { written: files.map((f) => f.path) }; },
      readText: async (_p, path) => d.texts.get(path) ?? null,
      runtime: () => null, pmIdle: async () => true, now: () => 10,
    });
    const ph = getPhase(d.db, id)!;
    await auto.apply(ph, { kind: "review", wfRunId: "w1", startedAt: 1, wave: 1 }, { status: "pass", findings: [] });
    await auto.apply(getPhase(d.db, id)!, { kind: "review", wfRunId: "w2", startedAt: 2, wave: 2 }, { status: "fail", findings: [{ file: "src/a.ts", line: 3, title: "bad" }] });
    const review = d.writes.filter((w) => w.path.endsWith("REVIEW.md")).at(-1);
    expect(review?.content).toContain("## Wave 1 — passed");
    expect(review?.content).toContain("## Wave 2 — failed");
    expect(review?.content).toContain("src/a.ts:3");
  });

  it("[sma:k_t_audit_uat] open and failed UAT lines are found across all phases", async () => {
    const d = driver();
    const a = await opened(d, { uat: { path: `.agents/phases/a/UAT.md`, sha256: "s", at: 1 } }, "acceptance");
    d.texts.set(`.agents/phases/a/UAT.md`, "- [ ] 1. p1: line open\n- [!] 2. p2: line failed\n");
    const b = await opened(d, { uat: { path: `.agents/phases/b/UAT.md`, sha256: "s", at: 1 } }, "acceptance");
    d.texts.set(`.agents/phases/b/UAT.md`, "- [x] 1. p1: done\n");
    const rows = await d.phases.uatOpen({ projectId: "projA" });
    const mine = rows.filter((r) => r.phaseId === a || r.phaseId === b);
    expect(mine).toHaveLength(2);
    expect(mine.map((r) => `${r.phaseId}:${r.state}`)).toEqual([`${a}:open`, `${a}:failed`]);
    expect(uatState(d.texts.get(`.agents/phases/b/UAT.md`)!).open).toHaveLength(0);
  });

  it("[sma:d_phase_files] phase_files lists the folder and reads one file, refusing escapes", async () => {
    const d = driver();
    const id = await opened(d, {}, "discussion");
    const listed = await d.phases.phaseFiles(id);
    expect(Array.isArray(listed.files)).toBe(true);
    const one = await d.phases.phaseFiles(id, `.agents/phases/${id}/BOOK.md`);
    expect(one.content?.text).toBe("file body");
    await expect(async () => d.phases.phaseFiles(id, `.agents/phases/${id}/../secret.txt`)).rejects.toThrow("under .agents/phases");
  });

  it("[sma:k_t_learnings] an applied lesson of project A is listed from project B's question", async () => {
    const d = driver();
    const { runLearningCli } = await import("../../src/rooms/learning/cli");
    const { createLearning } = await import("../../src/rooms/learning/service");
    // Plant a phase-lesson record of project A in the shared store.
    d.db.prepare(`INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,origin)
      VALUES('l1','projA','note','subagent','lesson A: keep tests small','[]','x',1,'phase-lessons')`).run();
    const learning = createLearning(createCore((createFakePluginHost({ pluginId: "lane-pilot" }).bb as never), d.db) as never, {} as never);
    const out = await learning.run("lessons", { text: "tests small" });
    expect(JSON.stringify(out)).toContain("projA");
    const none = await learning.run("lessons", { text: "nothing matches" });
    expect(JSON.stringify(none)).not.toContain("projA");
    void runLearningCli;
  });
});
