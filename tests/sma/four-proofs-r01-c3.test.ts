// Region 1 · Task graph, batch c (third file): the prompts and the session (as_prompt_*, as_worker_ctx, as_launchable, as_spawn, as_stream, as_continue).
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { TaskV2 } from "../../src/rooms/contracts";
import { designGate, nextAction, phaseFolder, type Phase, type PhaseRecord } from "../../src/rooms/phase/logic";
import { SKILL_CATALOG_BLOCK } from "../../src/rooms/native-agent/skill-catalog";
import { writerBriefSegments } from "../../src/rooms/writer/server/writer-task";
import { createWriterSpawn } from "../../src/rooms/writer/server/spawn";
import { createAttempt, createRun, createTask, getAttempt, getReasoningTrace, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { tokenCursorRow } from "../../src/rooms/usage/server/token-usage";
import { config, taskOf } from "./r01-world-c";

const phaseAt = (record: PhaseRecord, stage: Phase["stage"] = "design"): Phase => ({
  id: "ph_c", projectId: "p", pmThreadId: "t", runId: "r", title: "Hud", goal: "a hud", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

describe("the drawing step and the feasibility answer", () => {
  it("[sma:as_prompt_design] at the design stage with no drawing the PM is told Lane Pilot draws the screens itself into the phase's design folder, not to start a designer, and where a correction goes", () => {
    const next = nextAction(phaseAt({ design: { decision: "needed", why: "pieces that change screens: hud" } }), new Map());
    expect(next).toMatchObject({ stage: "design", waitsForPm: true });
    const folder = phaseFolder("ph_c");
    expect(next.text.split("\n")[0]).toBe(`Phase ph_c «Hud» — stage 3, design (pieces that change screens: hud). Lane Pilot draws the screens itself (lp.draw: design-lead draws into ${folder}/design/ with UI-SPEC.md, another role checks); its drawing comes to this chat. Do not start a designer; a correction for the drawing goes to lane_pilot_phase {action:"correct", phaseId:"ph_c", note}.`);
    // With a drawing recorded the text changes: the PM is told how to redraw and who may review.
    const drawn = nextAction(phaseAt({ design: { decision: "needed", why: "screens", drawing: { paths: [`${folder}/design/UI-SPEC.md`], sha256: "x", designer: "lp.draw", feasible: true, reviewer: "lp.draw" } } }), new Map());
    expect(drawn.text).not.toContain("Do not start a designer");
    expect(drawn.text).toContain("the reviewer is a role other than the designer");
  });

  it("[sma:as_prompt_feas] the drawing answer names feasibility as feasible, or the contradiction with the plan; no answer, or a contradiction, keeps the phase at design", () => {
    const record = (feasible: boolean | undefined, over: Record<string, unknown> = {}): PhaseRecord => ({ design: { decision: "needed", why: "screens",
      drawing: { paths: [`${phaseFolder("ph_c")}/design/UI-SPEC.md`], sha256: "x", designer: "lp.draw", reviewer: "ui-review", ...(feasible === undefined ? {} : { feasible }), ...over } } }) as PhaseRecord;
    const drawn = nextAction(phaseAt(record(true)), new Map());
    expect(drawn.text).toContain("lane_pilot_phase {action:\"drawing\", phaseId:\"ph_c\", paths:[...], designer, feasible:true|false, contradiction?, reviewer}");
    expect(designGate(record(undefined))).toEqual({ ok: false, why: ["no feasibility answer: feasible, or the contradiction with the plan"] });
    expect(designGate(record(false, { contradiction: "the bar cannot be both fixed and scrolling" }))).toEqual({ ok: false, why: ["the drawing contradicts the plan: the bar cannot be both fixed and scrolling — return the phase to planning"] });
    expect(designGate(record(true))).toEqual({ ok: true });
    // The open reason rides on the PM's text.
    expect(nextAction(phaseAt(record(false, { contradiction: "c" })), new Map()).text).toContain("Open: the drawing contradicts the plan: c");
  });
});

describe("the worker's brief and its session", () => {
  it("[sma:as_worker_ctx] the brief names the writer's role, the skills picked for the task (or the catalog when skills are broad) and carries the read-first excerpts and project knowledge as data", () => {
    const task: TaskV2 = taskOf("w1");
    const picked = writerBriefSegments(task, "memory: a.ts is the entry", "FILE src/a.ts\nexport const a = 1;", undefined, "Lane Pilot writer", "", "", "", null, false, { skills: ["lp-writer", "browser-automation"] });
    const instructions = picked[0]!;
    expect(instructions.hidden).toBe(true);
    const lines = instructions.text.split("\n");
    expect(lines[0]).toBe("You are Lane Pilot writer, the Lane Pilot writer for one bounded task.");
    expect(lines).toContain("Your skills for this task: lp-writer, browser-automation.");
    expect(instructions.text).not.toContain(SKILL_CATALOG_BLOCK);
    expect(picked.some((segment) => segment.hidden && segment.text.includes("export const a = 1;"))).toBe(true);
    expect(picked.some((segment) => segment.hidden && segment.text.includes("memory: a.ts is the entry"))).toBe(true);
    // A thread whose skills are not narrowed gets the catalog instead of the picked line.
    const broad = writerBriefSegments(task, "", "", undefined, "Lane Pilot writer", "", "", "", null, false, { broadSkills: true })[0]!;
    expect(broad.text).toContain(SKILL_CATALOG_BLOCK);
    expect(broad.text).not.toContain("Your skills for this task:");
  });

  it("[sma:as_spawn] the writer's session is spawned in the attempt's copy with the brief, the attempt runs on the thread that came back, and its trace and spend row exist from that second", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    setRunThread(db, "run", "pm");
    const task = taskOf("t1", { project_cwd: "/repo", owns_paths: ["note.txt"], expected_outputs: ["note.txt"], verify: "none", verification: [] });
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const spawns: Array<Record<string, unknown>> = [];
    const ctx = {
      bb: { storage: bb.storage, log: { info() {}, warn: (line: string) => console.log("WARN", line) },
        sdk: { projects: { get: async () => ({ sources: [] }) },
          providers: { list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
            models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }) },
          files: { read: async () => ({ content: null }) },
          threads: { get: async () => ({ id: "pm", projectId: "P", status: "idle", providerId: "codex", model: "codex-test" }), stop: async () => ({}),
            spawn: async (args: Record<string, unknown>) => { spawns.push(args); return { id: "writer-1" }; } } } },
      db,
      host: { call: async (method: string) => {
        if (method === "runCommand") return { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" };
        if (method === "gitCreateWorktree") return { status: "ready", path: "/wt/a1/repo", branch: "lane/a1", reason: null, baseSha: "a".repeat(40) };
        return {};
      } },
      effectiveProjectSettings: async () => ({ values: { "memory.enabled": false, "adoc.040": "auto" } }),
    };
    const services = { providerBreaker: { decide: () => ({ allow: true }), record: () => undefined, releaseTrial: () => undefined }, ruleScan: { chainForRun: async () => [] } };
    const writer = createWriterSpawn(ctx as never, services as never);
    const cfg = { ...config, projectId: "P", hostId: "h", writerWorkspacePath: "/repo", pmWorkspacePath: "/repo", writerProviderId: "codex", writerModel: "codex-test", pmProviderId: "codex", pmModel: "codex-test" };
    const out = await writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config: cfg, task, plan: "write", pmThreadId: "pm" } as never);
    expect(out).toMatchObject({ ok: true, threadId: "writer-1", providerId: "codex", model: "codex-test" });
    expect(getAttempt(db, "a1")).toMatchObject({ state: "running", thread_id: "writer-1" });
    expect(spawns).toHaveLength(1);
    expect(JSON.stringify(spawns[0])).toContain("/wt/a1/repo");
    expect(getReasoningTrace(db, "a1")).toMatchObject({ threadId: "writer-1", providerId: "codex", model: "codex-test" });
    expect(tokenCursorRow(db, "writer-1")).toMatchObject({ provider_id: "codex" });
  });
});
