import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, saveProjectSetting, type LanePilotDatabase } from "../src/rooms/storage/database";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  ERRAND_EPISODE_TABLE, codeFailureClass, enrichEpisode, episodeSkills, episodesBackfill,
  parseEpisodeAnswer, pendingEpisodes, recordErrandEpisode, sweepErrandEpisodes,
} from "../src/rooms/errands";
import { runEpisodesCli } from "../src/rooms/errands/server";
import { applyOutcomeLabels, labelErrandFailure } from "../packages/jev/src/labels-outcome";
import { errandFailureJudgment, ERRAND_FAILURE_CLASSES, ERRAND_FAILURE_ID } from "../src/rooms/errands";

// maskPii throws only on a marker so the held-state path is reachable; every other test gets the real masker.
vi.mock("../src/rooms/anamnesis/pii", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rooms/anamnesis/pii")>();
  return {
    ...actual,
    maskPii: (input: string) => {
      if (input.includes("MASK-BOOM")) throw new Error("mask boom");
      return actual.maskPii(input);
    },
  };
});

/**
 * Errand episodes, phase B (R5): the hourly sweep's enrichment. The recorder writes the phase-A rows, the sweep's
 * deps are fakes — a canned outline, canned events, a canned model answer — so masking order, the held/pending state
 * machine, code-first failure classes, the per-pass cap and the backfill bias are all pinned without engine or model.
 */
const PROJECT = "proj-1";
const ANSWER = JSON.stringify({
  goal: "Count open leads in the CRM",
  params: [{ name: "view", value: "open leads" }],
  steps_that_worked: ["opened the leads view", "exported the count"],
  traps: ["the export button moved"],
  check: "count matched the on-screen total",
  failure_class: null,
  process_key_proposed: "crm|count-open-leads",
});

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { db: openDatabase(bb) };
}

function addRun(db: LanePilotDatabase, input: { id: string; workflowId?: string; status?: string; projectId?: string | null; title?: string; task?: string; inputs?: Record<string, unknown>; output?: unknown; reason?: string | null; at?: number }) {
  const now = input.at ?? Date.now();
  const inputs = input.inputs ?? { title: input.title ?? "Check the CRM pipeline", task: input.task ?? "" };
  db.prepare(`INSERT INTO lane_pilot_wf_run
    (id, idem_key, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, reason, inputs_json, output_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.id, `key-${input.id}`, input.workflowId ?? "errand", 1, "sha", "{}", input.projectId === undefined ? PROJECT : input.projectId,
      input.status ?? "succeeded", input.reason ?? null, JSON.stringify(inputs),
      input.output === undefined ? null : JSON.stringify(input.output), now, now);
}

function addSpawn(db: LanePilotDatabase, runId: string, threadId: string) {
  const now = Date.now();
  db.prepare(`INSERT INTO lane_pilot_wf_effect (id, run_id, step_key, effect_key, kind, state, result_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`eff-${runId}`, runId, "work", "spawn", "errand.spawn", "done", JSON.stringify({ threadId }), now, now);
}

const toolCall = (seq: number, tool: string, args: unknown) =>
  ({ type: "item/completed", seq, data: { item: { type: "toolCall", server: "bb", tool, arguments: args, status: "completed" } } });

const EVENTS = [toolCall(1, "browser", { url: "https://crm.example.com/leads" }), toolCall(2, "bash", { command: "curl count" })];

async function recorded(db: LanePilotDatabase, runId: string, options: { events?: unknown[]; output?: unknown; status?: string; reason?: string | null } = {}) {
  addSpawn(db, runId, `thr-${runId}`);
  await recordErrandEpisode({ db, runId, readEvents: async () => options.events ?? EVENTS });
}

const deps = (db: LanePilotDatabase, over: Partial<Parameters<typeof sweepErrandEpisodes>[0]> = {}) => ({
  db,
  readOutline: async () => "User: count the open leads\nAssistant: done, 42 leads",
  readEvents: async () => EVENTS,
  runModel: async () => ({ text: ANSWER, model: "fake/analyst-1" }),
  ...over,
});

const row = (db: LanePilotDatabase, runId: string) =>
  db.prepare(`SELECT * FROM ${ERRAND_EPISODE_TABLE} WHERE run_id=?`).get(runId) as Record<string, unknown>;

describe("errand episode sweep", () => {
  it("a pending episode is enriched: masked text reaches the model, strict JSON lands in the columns, the candidate becomes process_key", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-1", inputs: { title: "Count open leads", skills: ["browser-qa", "crm-export"], task: "count leads; mail boss@secret-mail.example the number" }, output: { state: "done", verified: "done_checked" } });
    await recorded(db, "wfrun-1");
    const prompts: string[] = [];
    const judged: unknown[] = [];
    const result = await sweepErrandEpisodes(deps(db, {
      readOutline: async () => "User: count leads, write to boss@secret-mail.example\nAssistant: wrote it",
      runModel: async (prompt) => { prompts.push(prompt); return { text: ANSWER, model: "fake/analyst-1" }; },
      judge: (input) => { judged.push(input); },
    }));

    expect(result).toMatchObject({ picked: 1, enriched: 1 });
    const stored = row(db, "wfrun-1");
    expect(stored).toMatchObject({
      enrichment_state: "enriched", enriched_model: "fake/analyst-1", failure_class: null, process_key: "crm|count-open-leads",
      process_key_proposed: "crm|count-open-leads", enrichment_reason: null,
    });
    expect(stored.enriched_at).toBeTypeOf("number");
    const summary = JSON.parse(String(stored.summary_json)) as { goal: string; skills: Array<{ name: string; offered: boolean; read: boolean; used: boolean }> };
    expect(summary.goal).toBe("Count open leads in the CRM");
    expect(summary.skills).toEqual([
      { name: "browser-qa", offered: true, read: false, used: false },
      { name: "crm-export", offered: true, read: false, used: false },
    ]);
    // Privacy: the model saw the masked text, never the raw address; nothing unmasked was stored.
    expect(prompts[0]).toContain("[email]");
    expect(prompts[0]).not.toContain("boss@secret-mail.example");
    expect(prompts[0]).toContain("reference material");
    expect(String(stored.summary_json)).not.toContain("boss@secret-mail.example");
    expect(judged).toHaveLength(1);
  });

  it("enriches up to three episodes at once; their keys are chosen one at a time and each sees the previous", async () => {
    const { db } = world();
    for (const id of ["wfrun-a", "wfrun-b", "wfrun-c"]) {
      addRun(db, { id, inputs: { title: "Count open leads", task: "count" }, output: { state: "done", verified: "done_checked" } });
      await recorded(db, id);
    }
    let inModel = 0, maxInModel = 0, inKey = 0, maxInKey = 0;
    const knownSeen: number[] = [];
    const result = await sweepErrandEpisodes(deps(db, {
      readOutline: async () => "User: count\nAssistant: done",
      runModel: async () => { inModel += 1; maxInModel = Math.max(maxInModel, inModel); await new Promise((r) => setTimeout(r, 20)); inModel -= 1; return { text: ANSWER, model: "m" }; },
      chooseKey: async ({ candidate, known }) => { inKey += 1; maxInKey = Math.max(maxInKey, inKey); knownSeen.push(known.length); await new Promise((r) => setTimeout(r, 5)); inKey -= 1; return candidate; },
    }));
    expect(result).toMatchObject({ picked: 3, enriched: 3 });
    expect(maxInModel).toBe(3);
    expect(maxInKey).toBe(1);
    expect(knownSeen).toEqual([0, 1, 1]);
  });

  it("a second pass while one runs picks nothing (no double enrichment)", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-1", inputs: { title: "Count open leads", task: "count" }, output: { state: "done", verified: "done_checked" } });
    await recorded(db, "wfrun-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = sweepErrandEpisodes(deps(db, {
      readOutline: async () => "User: count\nAssistant: done",
      runModel: async () => { calls += 1; await gate; return { text: ANSWER, model: "fake/analyst-1" }; },
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await sweepErrandEpisodes(deps(db, { readOutline: async () => "x", runModel: async () => { calls += 1; return { text: ANSWER, model: "m" }; } }))).toMatchObject({ picked: 0 });
    release();
    expect(await first).toMatchObject({ picked: 1, enriched: 1 });
    expect(calls).toBe(1);
  });

  it("R6 wiring: chooseKey gets the candidate, the title and the known keys; its answer is the stored process_key", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-old", inputs: { title: "Count leads in CRM", task: "count" }, output: { state: "done" } });
    await recorded(db, "wfrun-old");
    db.prepare("UPDATE lane_pilot_errand_episode SET process_key='crm|count-leads', enrichment_state='enriched' WHERE run_id='wfrun-old'").run();
    addRun(db, { id: "wfrun-1", inputs: { title: "Count open leads", task: "count" }, output: { state: "done", verified: "done_checked" } });
    await recorded(db, "wfrun-1");
    const seen: unknown[] = [];
    await sweepErrandEpisodes(deps(db, {
      readOutline: async () => "User: count\nAssistant: done",
      runModel: async () => ({ text: ANSWER, model: "fake/analyst-1" }),
      chooseKey: async (input) => { seen.push(input); return "crm|count-leads"; },
    }));
    expect(seen).toEqual([{ candidate: "crm|count-open-leads", title: "Count open leads", known: [{ key: "crm|count-leads", titles: ["Count leads in CRM"] }] }]);
    expect(row(db, "wfrun-1")).toMatchObject({ process_key: "crm|count-leads", process_key_proposed: "crm|count-open-leads" });
    // A throwing chooser leaves the candidate.
    db.prepare("UPDATE lane_pilot_errand_episode SET enrichment_state='pending', enriched_at=NULL, process_key=NULL WHERE run_id='wfrun-1'").run();
    await sweepErrandEpisodes(deps(db, {
      readOutline: async () => "User: count\nAssistant: done",
      runModel: async () => ({ text: ANSWER, model: "fake/analyst-1" }),
      chooseKey: async () => { throw new Error("jev down"); },
    }));
    expect(row(db, "wfrun-1").process_key).toBe("crm|count-open-leads");
  });

  it("a masking failure leaves the row held and logs episode_mask_failed:<runId>", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-m", output: { state: "done", verified: "done_checked" } });
    await recorded(db, "wfrun-m");
    const warns: string[] = [];
    const result = await sweepErrandEpisodes(deps(db, {
      readOutline: async () => "MASK-BOOM secret text",
      warn: (m) => warns.push(m),
    }));
    expect(result).toMatchObject({ held: 1, enriched: 0 });
    expect(row(db, "wfrun-m")).toMatchObject({ enrichment_state: "held" });
    expect(warns.some((m) => m.startsWith("episode_mask_failed:wfrun-m"))).toBe(true);
    // Held is not pending within the hour; after it (a reload mid-call left it held) it is tried again.
    expect(pendingEpisodes(db, Date.now(), 10)).toEqual([]);
    expect(pendingEpisodes(db, Date.now() + 2 * 3_600_000, 10).map((pending) => pending.runId)).toEqual(["wfrun-m"]);
  });

  it("a model failure returns the row to pending with the same-hour backoff and logs episode_enrich_failed", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-f1", output: { state: "failed", reason: "provider died" } });
    await recorded(db, "wfrun-f1");
    const warns: string[] = [];
    const result = await sweepErrandEpisodes(deps(db, {
      runModel: async () => { throw new Error("model down"); },
      warn: (m) => warns.push(m),
    }));
    expect(result).toMatchObject({ failed: 1, enriched: 0 });
    const stored = row(db, "wfrun-f1");
    expect(stored).toMatchObject({ enrichment_state: "pending" });
    expect(stored.enriched_at).toBeTypeOf("number");
    expect(warns.some((m) => m.startsWith("episode_enrich_failed:wfrun-f1:model down"))).toBe(true);
    // Backoff: a second pass inside the hour picks nothing.
    expect(await sweepErrandEpisodes(deps(db, { runModel: async () => ({ text: ANSWER, model: "m" }) }))).toMatchObject({ picked: 0 });
  });

  it("code-computed classes beat the model's: looped, timeout, stopped_early, unverified", async () => {
    const { db } = world();
    const looped = [toolCall(1, "browser", { url: "https://x" }), toolCall(2, "browser", { url: "https://x" }), toolCall(3, "browser", { url: "https://x" })];
    addRun(db, { id: "wfrun-l", status: "failed", reason: "gave up", output: { state: "failed" } });
    addRun(db, { id: "wfrun-t", status: "failed", reason: "run timed out after 30 minutes", output: { state: "failed" } });
    addRun(db, { id: "wfrun-s", output: { state: "done", verified: "done_checked" } });
    addRun(db, { id: "wfrun-u", output: { state: "done", verified: "done_unchecked" } });
    await recorded(db, "wfrun-l", { events: looped });
    await recorded(db, "wfrun-t");
    await recorded(db, "wfrun-s", { events: [toolCall(1, "browser", { url: "https://x" })] });
    await recorded(db, "wfrun-u");

    const modelSays = JSON.stringify({ ...JSON.parse(ANSWER), failure_class: "site_changed" });
    await sweepErrandEpisodes(deps(db, { runModel: async () => ({ text: modelSays, model: "m" }) }));

    expect(row(db, "wfrun-l").failure_class).toBe("looped");
    expect(row(db, "wfrun-t").failure_class).toBe("timeout");
    expect(row(db, "wfrun-s").failure_class).toBe("stopped_early");
    expect(row(db, "wfrun-u").failure_class).toBe("unverified");
    // And the code path alone, without any model:
    expect(codeFailureClass({ status: "failed", outcome: "failed", verified: null, reason: "timed out", trace: null, traceStats: null })).toBe("timeout");
    expect(codeFailureClass({ status: "succeeded", outcome: "done", verified: "done_checked", reason: null, trace: null, traceStats: { actions: 9, failedObservations: 0, errors: 0, userTurns: 1 } })).toBeNull();
  });

  it("an episode with no thread is skipped with the reason stored", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-n" });
    await recordErrandEpisode({ db, runId: "wfrun-n" });
    const result = await sweepErrandEpisodes(deps(db));
    expect(result).toMatchObject({ skipped: 1 });
    expect(row(db, "wfrun-n")).toMatchObject({ enrichment_state: "skipped", enrichment_reason: "no_thread" });
  });

  it("episodes.collect off: the sweep picks rows but writes nothing", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-off", output: { state: "done", verified: "done_checked" } });
    await recorded(db, "wfrun-off");
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "episodes.collect", false);
    const result = await sweepErrandEpisodes(deps(db));
    expect(result.picked).toBe(1);
    expect(row(db, "wfrun-off")).toMatchObject({ enrichment_state: "pending", enriched_at: null });
  });

  it("one pass enriches at most ten episodes, oldest first", async () => {
    const { db } = world();
    for (let index = 0; index < 12; index += 1) {
      const id = `wfrun-${index}`;
      addRun(db, { id, output: { state: "done", verified: "done_checked" }, at: Date.now() - (12 - index) * 1000 });
      await recorded(db, id);
    }
    const result = await sweepErrandEpisodes(deps(db));
    expect(result).toMatchObject({ picked: 10, enriched: 10 });
    const states = db.prepare(`SELECT enrichment_state FROM ${ERRAND_EPISODE_TABLE}`).all() as Array<{ enrichment_state: string }>;
    expect(states.filter((s) => s.enrichment_state === "enriched")).toHaveLength(10);
    expect(states.filter((s) => s.enrichment_state === "pending")).toHaveLength(2);
  });
});

describe("episode answer parsing and skills", () => {
  it("rejects unknown keys, cuts long strings, maps an invalid class to other and a bad process key to null", () => {
    expect(() => parseEpisodeAnswer('{"goal":"x","surprise":1}')).toThrow(/unknown_key/);
    const parsed = parseEpisodeAnswer(JSON.stringify({
      goal: "g".repeat(500), params: [{ name: "n".repeat(100), value: "v".repeat(300) }],
      steps_that_worked: ["s".repeat(300)], traps: "not-a-list", check: 42,
      failure_class: "made_up_class", process_key_proposed: "Not A Key!",
    }));
    expect(parsed.goal.length).toBeLessThanOrEqual(300);
    expect(parsed.params[0]!.name.length).toBeLessThanOrEqual(60);
    expect(parsed.traps).toEqual([]);
    expect(parsed.check).toBeNull();
    expect(parsed.failure_class).toBe("other");
    expect(parsed.process_key_proposed).toBeNull();
    expect(parseEpisodeAnswer('{"failure_class":"no_skill","process_key_proposed":"CRM|Export Leads"}')).toMatchObject({ failure_class: "no_skill", process_key_proposed: null });
  });

  it("episodeSkills marks every offered skill and detects use and SKILL.md reads from events", () => {
    const events = [
      ...EVENTS,
      { type: "item/completed", seq: 3, data: { item: { type: "toolCall", server: "bb", tool: "skill", arguments: { id: "browser-qa" }, status: "completed" } } },
      { type: "item/completed", seq: 4, data: { item: { type: "toolCall", server: "bb", tool: "read", arguments: { path: "/repo/.claude/skills/crm-export/SKILL.md" }, status: "completed" } } },
    ];
    expect(episodeSkills(["browser-qa", "crm-export", "scope:other-skill"], events)).toEqual([
      { name: "browser-qa", offered: true, read: false, used: true },
      { name: "crm-export", offered: true, read: true, used: false },
      { name: "other-skill", offered: true, read: false, used: false },
    ]);
  });
});

describe("episodes-backfill", () => {
  it("writes phase-A rows repeated processes first and reports the selection bias", async () => {
    const { db } = world();
    // A process of three runs (same title stem), one failed single, one done single.
    for (let index = 0; index < 3; index += 1) {
      addRun(db, { id: `grp-${index}`, title: "Weekly CRM pipeline check", status: index === 2 ? "failed" : "succeeded", reason: index === 2 ? "died" : null, output: index === 2 ? { state: "failed" } : { state: "done", verified: "done_checked" }, at: Date.now() - index * 60_000 });
    }
    addRun(db, { id: "single-f", title: "One-off invoice scan", status: "failed", reason: "no access", output: { state: "failed" } });
    addRun(db, { id: "single-d", title: "Archive old exports", status: "succeeded", output: { state: "done", verified: "done_checked" } });

    const result = await episodesBackfill({ db, readEvents: async () => [] });
    expect(result).toMatchObject({ picked: 5, total: 5, groups: 3, failed: 2, single: 2, written: 5 });
    const rows = db.prepare(`SELECT run_id FROM ${ERRAND_EPISODE_TABLE} ORDER BY run_id`).all() as Array<{ run_id: string }>;
    expect(rows.map((r) => r.run_id).sort()).toEqual(["grp-0", "grp-1", "grp-2", "single-d", "single-f"]);
    // Second run finds nothing left to write.
    expect(await episodesBackfill({ db })).toMatchObject({ picked: 0, total: 0 });

    const cli = await runEpisodesCli({ db, readEvents: async () => [] }, "episodes-backfill", ["--limit", "30"]);
    expect(cli.exitCode).toBe(0);
    // Fresh world for the printed line: the table is already filled here, so check the format on a new one.
    const { db: db2 } = world();
    addRun(db2, { id: "a1", title: "Weekly CRM pipeline check", output: { state: "done", verified: "done_checked" } });
    addRun(db2, { id: "a2", title: "Weekly CRM pipeline check", output: { state: "done", verified: "done_checked" } });
    addRun(db2, { id: "a3", title: "Weekly CRM pipeline check", output: { state: "done", verified: "done_checked" } });
    const cli2 = await runEpisodesCli({ db: db2 }, "episodes-backfill", []);
    expect(cli2.stdout).toContain("picked 3 of 3: groups 3, failed 0, single 0");

    // episodes-sweep: refuses without live deps; with them, one pass over the pending rows.
    expect((await runEpisodesCli({ db: db2 }, "episodes-sweep", [])).exitCode).toBe(1);
    const swept = await runEpisodesCli({ db: db2, sweepDeps: () => ({ db: db2 }) }, "episodes-sweep", ["--limit", "5"]);
    expect(swept.exitCode).toBe(0);
    expect(swept.stdout).toMatch(/^episodes: \d+ enriched, \d+ skipped, \d+ failed, \d+ held of 3 picked/);
  });
});

describe("errand.failure judgment and labels", () => {
  it("is a shadow choice judgment over the closed class list", () => {
    expect(ERRAND_FAILURE_ID).toBe("errand.failure");
    expect(errandFailureJudgment.id).toBe("errand.failure");
    expect(errandFailureJudgment.defaultMode).toBe("shadow");
    expect(ERRAND_FAILURE_CLASSES).toContain("looped");
    expect(ERRAND_FAILURE_CLASSES).toContain("other");
    expect(errandFailureJudgment.describe?.({ cls: "timeout" } as never)).toBe("timeout");
  });

  it("labelErrandFailure grades a receipt against the episode's stored failure_class", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-j", status: "failed", reason: "died", output: { state: "failed" } });
    await recorded(db, "wfrun-j");
    await sweepErrandEpisodes(deps(db, {
      runModel: async () => ({ text: JSON.stringify({ ...JSON.parse(ANSWER), failure_class: "tool_error" }), model: "m" }),
      judge: undefined,
    }));
    expect(row(db, "wfrun-j").failure_class).toBe("tool_error");
    const at = Date.now() - 25 * 3_600_000;
    const receipt = db.prepare(`INSERT INTO lane_pilot_jev_receipt
      (judgment,version,model,mode,project_id,run_id,subject,input_sha256,input_chars,questions,status,answers_json,decision,decided_by,at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    receipt.run(ERRAND_FAILURE_ID, 1, "m", "shadow", PROJECT, "wfrun-j", "wfrun-j", "sha", 10, 1, "ok", "{}", "tool_error", "jev", at);
    receipt.run(ERRAND_FAILURE_ID, 1, "m", "shadow", PROJECT, "wfrun-j", "wfrun-j", "sha", 10, 1, "ok", "{}", "no_skill", "jev", at);
    const labels = labelErrandFailure(db as never, Date.now());
    expect(labels).toHaveLength(2);
    applyOutcomeLabels(db as never, Date.now());
    const outcomes = db.prepare(`SELECT outcome FROM lane_pilot_jev_receipt WHERE run_id='wfrun-j' ORDER BY id`).all() as Array<{ outcome: string }>;
    expect(outcomes.map((o) => o.outcome)).toEqual(["agree:outcome", "disagree:outcome"]);
  });
});
