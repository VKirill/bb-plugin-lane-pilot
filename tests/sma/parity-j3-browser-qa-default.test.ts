import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { acceptanceLines, pieceLines, planSignature, type Phase, type PhaseRecord, type PlanItem, type TaskFact } from "../../src/rooms/phase/logic";
import { autoDue } from "../../src/rooms/phase/server/auto-stages";
import { validationGaps } from "../../src/rooms/phase/stages";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";
import { saveProjectSetting } from "../../src/rooms/storage";
import { LP_DEFAULTS_KEY } from "@lane-pilot/settings-catalog";
import { switchOn } from "@lane-pilot/models";
import { sha256Hex } from "@lane-pilot/kit";

const NO_HOST_REASON = "no browser machine named: bb lane-pilot setting browser_qa.host_id=<host>";

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
const planRec = (items: PlanItem[], over: Partial<NonNullable<PhaseRecord["plan"]>> = {}): NonNullable<PhaseRecord["plan"]> => ({
  items, contextSha: "ctx", sha: planSignature(items, "ctx"), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } },
  objective: "o", premortem: ["a", "b", "c"], ...over });
const verdict = { state: "passed" as const, detail: "ok", mainSha: "h", at: 1, inputSha: "i" };

function driver() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") return { status: "applied", writes: (input.edits as Array<{ path: string; content: string }>).map((edit) => { texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    if (method === "gitCommitDocs") return { commit: "c".repeat(40) };
    if (method === "runCommand") return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h' WHERE id='run1'").run();
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { const c = texts.get(i.path); if (c !== undefined) return { content: c, sha256: sha256Hex(c), sizeBytes: c.length }; throw new Error("no file"); },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services).phases;
  return { bb, phases, db };
}

async function opened(d: ReturnType<typeof driver>, record: PhaseRecord, stage: Phase["stage"]) {
  const phase = await d.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  savePhase(d.db, phase.id, { stage, runId: "run1", record: { ...phase.record, ...record }, at: 2 });
  return phase.id;
}

describe("phase parity j3: browser QA on by default", () => {
  it("[sma:k_we_verify] unset browser_qa.enabled with a browser machine named: visible work owes a passed live check", async () => {
    const d = driver();
    saveProjectSetting(d.db, "projA", "browser_qa.host_id", "h_qa");
    const id = await d.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" }).then((p) => p.id);
    expect(getPhase(d.db, id)!.record.liveCheck).toBe(true);
    // The gate then refuses a visible piece that names no qa_cases/qa_url, and the piece line holds it to a passed check.
    const noQa = item("p1", { task: { ...item("p1").task, owns_paths: ["src/app.tsx"] } });
    expect(validationGaps([noQa], getPhase(d.db, id)!.record.liveCheck !== true).join(" ")).toContain("live check");
    const ui = uiItem("p1");
    expect(pieceLines(ui, fact("t1", { browserQa: "skipped", qaPlanned: false }), undefined, true).find((l) => l.id === "qa_read")!.ok).toBe(false);
  });

  it("[sma:k_we_verify] the hub-wide browser machine counts as named", async () => {
    const d = driver();
    await d.bb.storage.kv.set(LP_DEFAULTS_KEY, { qaHostId: "h_hub" });
    const id = await d.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" }).then((p) => p.id);
    expect(getPhase(d.db, id)!.record.liveCheck).toBe(true);
  });

  it("[sma:k_we_verify] unset browser_qa.enabled and no browser machine named: the live check is recorded as not run and the phase goes on", async () => {
    const d = driver();
    const id = await opened(d, { plan: planRec([uiItem("p1")], { admittedSha: planSignature([uiItem("p1")], "ctx") }) }, "verification");
    const record = getPhase(d.db, id)!.record;
    expect(record.liveCheck ?? false).toBe(false);
    expect(record.verification?.live).toMatchObject({ state: "skipped", reason: NO_HOST_REASON });
    expect(listParts(d.db, id).map((part) => part.text).join(" ")).toContain("no browser machine named");
    // The phase goes on: the live stage is not due, the goal audit is.
    const atVerification = phase({ ...record, verification: { ...record.verification, verdict } }, "verification");
    expect(autoDue(atVerification)).toMatchObject({ kind: "close" });
    // And the plan gate does not ask visible pieces for qa_cases it cannot run.
    const noQa = item("p1", { task: { ...item("p1").task, owns_paths: ["src/app.tsx"] } });
    expect(validationGaps([noQa], record.liveCheck !== true)).toHaveLength(0);
  });

  it("[sma:k_we_verify] an explicit off — the stored boolean or the word — keeps the browser check off even with a machine named", async () => {
    for (const value of [false, "off", 0, "false"] as const) {
      const d = driver();
      saveProjectSetting(d.db, "projA", "browser_qa.host_id", "h_qa");
      saveProjectSetting(d.db, "projA", "browser_qa.enabled", value);
      const id = await d.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" }).then((p) => p.id);
      const record = getPhase(d.db, id)!.record;
      expect(record.liveCheck ?? false).toBe(false);
      expect(record.verification?.live).toBeUndefined();
      const atVerification = phase({ plan: planRec([uiItem("p1")]), liveCheck: record.liveCheck, verification: { verdict } }, "verification");
      expect(autoDue(atVerification)).toMatchObject({ kind: "close" });
    }
  });

  it("[sma:k_we_uiqa] with the check on by default and a machine named, ui-audit runs between the verdict and the goal audit", async () => {
    const d = driver();
    saveProjectSetting(d.db, "projA", "browser_qa.host_id", "h_qa");
    const id = await opened(d, { plan: planRec([uiItem("p1")]) }, "verification");
    const record = getPhase(d.db, id)!.record;
    expect(record.liveCheck).toBe(true);
    const passed = phase({ ...record, verification: { ...record.verification, verdict } }, "verification");
    expect(autoDue(passed)).toMatchObject({ kind: "live" });
    const checked = phase({ ...passed.record, verification: { ...passed.record.verification, live: { state: "passed" as const, head: "h", at: 2 } } }, "verification");
    expect(autoDue(checked)).toMatchObject({ kind: "close" });
    // A skipped record (no machine) goes on to the audit too — never held.
    const skipped = phase({ plan: planRec([uiItem("p1")]), verification: { verdict, live: { state: "skipped" as const, reason: NO_HOST_REASON, at: 2 } } }, "verification");
    expect(autoDue(skipped)).toMatchObject({ kind: "close" });
  });

  it("[sma:k_we_verify] acceptance of visible work with the check skipped says no live check is owed", () => {
    const ui = uiItem("p1");
    const ph = phase({ plan: planRec([ui], { admittedSha: planSignature([ui], "ctx") }), ownerWords: false,
      verification: { verdict, live: { state: "skipped" as const, reason: NO_HOST_REASON, at: 2 } } }, "acceptance");
    const qa = acceptanceLines(ph, new Map([["p1", fact("t1")]]), { mainSha: "h", openDeferrals: 0 }).find((line) => line.id === "qa_read")!;
    expect(qa.ok).toBe(true);
    expect(qa.detail).toContain("no live check owed");
    expect(switchOn({}, "browser_qa.enabled")).toBe(true);
    expect(switchOn({ "browser_qa.enabled": false }, "browser_qa.enabled")).toBe(false);
    expect(switchOn({ "browser_qa.enabled": "off" }, "browser_qa.enabled")).toBe(false);
  });
});
