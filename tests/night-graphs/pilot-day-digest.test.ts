import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listUnprocessedTrajectoryDeltas } from "../../src/rooms/errands";
import {
  collectGraphEvolveEvidence,
  createLivePilotDayDigestDeps,
  digestPilotDayDialogues,
} from "../../src/rooms/night-graphs/server";
import {
  createAttempt,
  createRun,
  createTask,
  listPilotDayCandidates,
  listPilotDayDigests,
  openDatabase,
  recordPmSkillUse,
  savePilotDayDigest,
  saveProjectSetting,
  saveStageReceipt,
  setRunObjective,
  setRunThread,
} from "../../src/rooms/plugin-db";
import { nightWorld } from "./world";

afterEach(() => {
  forgetSecrets();
});

describe("lane_pilot_day_digest storage & candidates", () => {
  it("collects pilot_run, pilot_chat, and user workflow_run candidates, persists digests idempotently, and enforces append-only", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const t0 = Date.UTC(2026, 10, 20, 0, 0, 0);
    const sinceMs = t0;
    const untilMs = t0 + 86_400_000;

    // 1. pilot_run with tasks, attempt (>400 chars reason), stage receipt (>300 chars reason), skills, and matching activation (must NOT duplicate as pilot_chat)
    createRun(db, "run-1", "proj-1", "cli");
    setRunThread(db, "run-1", "thr-pm-1");
    setRunObjective(db, "run-1", "Ship daily digest");
    createTask(db, { id: "t-1", runId: "run-1", kind: "cli", contract: { title: "Task One" } });
    createTask(db, { id: "t-2", runId: "run-1", kind: "cli", contract: { goal: "Goal Two" } });
    createTask(db, { id: "t-3", runId: "run-1", kind: "cli", contract: {} });
    createAttempt(db, { id: "att-1", runId: "run-1", taskId: "t-1" });
    const longReason = "x".repeat(450);
    db.prepare("UPDATE lane_pilot_attempt SET thread_id=?, state=?, reason=?, updated_at=? WHERE id=?").run("thr-w-1", "failed", longReason, t0 + 10_000, "att-1");
    saveStageReceipt(db, {
      runId: "run-1", taskId: "t-1", stageId: "code-critique", contractVersion: 1, state: "failed",
      inputSha256: "a".repeat(64), outputSha256: null, attempt: 1, providerId: null, model: null,
      threadId: null, result: null, reason: "y".repeat(350), updatedAt: t0 + 10_000,
    });
    db.prepare("UPDATE lane_pilot_run SET updated_at=? WHERE id=?").run(t0 + 10_000, "run-1");
    recordPmSkillUse(db, { threadId: "thr-pm-1", projectId: "proj-1", skill: "lp-plan", at: t0 + 5_000 });
    recordPmSkillUse(db, { threadId: "thr-pm-1", projectId: "proj-1", skill: "lp-plan", at: t0 + 6_000 });
    recordPmSkillUse(db, { threadId: "thr-pm-1", projectId: "proj-1", skill: "lp-verify", at: t0 + 7_000 });
    recordPmSkillUse(db, { threadId: "thr-pm-1", projectId: "proj-1", skill: "old-skill", at: t0 - 10_000 });

    // Activation sharing thr-pm-1 should be suppressed in pilot_chat; activation on thr-pm-2 and notice on thr-pm-3 should appear
    db.prepare("INSERT INTO lane_pilot_activation(project_id,pm_thread_id,run_id,claimed_at) VALUES (?,?,?,?)")
      .run("proj-1", "thr-pm-1", "run-1", t0 + 11_000);
    db.prepare("INSERT INTO lane_pilot_activation(project_id,pm_thread_id,run_id,claimed_at) VALUES (?,?,?,?)")
      .run("proj-2", "thr-pm-2", "run-other", t0 + 12_000);
    recordPmSkillUse(db, { threadId: "thr-pm-2", projectId: "proj-2", skill: "vitest", at: t0 + 12_500 });

    // Historical run outside window + pm_notice in window linking back to proj-old
    createRun(db, "run-old", "proj-old", "cli");
    createTask(db, { id: "t-old", runId: "run-old", kind: "cli", contract: { title: "Old" } });
    createAttempt(db, { id: "att-old", runId: "run-old", taskId: "t-old" });
    db.prepare("UPDATE lane_pilot_run SET updated_at=? WHERE id=?").run(t0 - 50_000, "run-old");
    db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id=?").run(t0 - 50_000, "att-old");
    db.prepare("INSERT INTO lane_pilot_pm_notice(transition_id,attempt_id,pm_thread_id,sent_at) VALUES (?,?,?,?)")
      .run(1, "att-old", "thr-pm-3", t0 + 13_000);

    // 2. workflow_run rows: user workflow included; errand, lp.*, lp-*, sp.*, sp-*, running excluded
    const insertWf = db.prepare(`INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, reason, inputs_json, output_json, created_at, updated_at)
      VALUES (?, ?, 1, 'sha', '{}', 'proj-wf', ?, ?, ?, ?, ?, ?)`);
    insertWf.run("wf-user-1", "custom-deploy", "succeeded", "ok", '{"threadId":"thr-wf-1"}', '{"url":"done"}', t0 + 1_000, t0 + 14_000);
    insertWf.run("wf-errand", "errand", "succeeded", null, "{}", null, t0 + 1_000, t0 + 15_000);
    insertWf.run("wf-lp-dot", "lp.graph-evolve", "succeeded", null, "{}", null, t0 + 1_000, t0 + 15_000);
    insertWf.run("wf-lp-dash", "lp-task-pipeline", "succeeded", null, "{}", null, t0 + 1_000, t0 + 15_000);
    insertWf.run("wf-sp-dot", "sp.shift", "succeeded", null, "{}", null, t0 + 1_000, t0 + 15_000);
    insertWf.run("wf-sp-dash", "sp-shift", "succeeded", null, "{}", null, t0 + 1_000, t0 + 15_000);
    insertWf.run("wf-running", "custom-running", "running", null, "{}", null, t0 + 1_000, t0 + 15_000);

    const candidates = listPilotDayCandidates(db, sinceMs, untilMs, 20);
    expect(candidates.map((c) => `${c.sourceKind}:${c.sourceId}`)).toEqual([
      "workflow_run:wf-user-1",
      "pilot_chat:thr-pm-3",
      "pilot_chat:thr-pm-2",
      "pilot_run:run-1",
    ]);

    const wfCand = candidates[0]!;
    expect(wfCand.dayKey).toBe("2026-11-20");
    expect(wfCand.threadId).toBe("thr-wf-1");
    expect(wfCand.wfInputsJson).toBe('{"threadId":"thr-wf-1"}');
    expect(wfCand.wfOutputJson).toBe('{"url":"done"}');
    expect(wfCand.wfReason).toBe("ok");

    const noticeChat = candidates[1]!;
    expect(noticeChat.projectId).toBe("proj-old");

    const actChat = candidates[2]!;
    expect(actChat.pmSkills).toEqual(["vitest"]);

    const runCand = candidates[3]!;
    expect(runCand.objective).toBe("Ship daily digest");
    expect(runCand.taskSummaries).toEqual(["Task One", "Goal Two", "t-3"]);
    expect(runCand.attempts[0]?.reason?.length).toBe(400);
    expect(runCand.stageVerdicts[0]?.reason?.length).toBe(300);
    expect(runCand.pmSkills).toEqual(["lp-plan", "lp-verify"]);

    // Save with secret redaction & duplicate logging check
    const secretVal = "sk-test-super-secret-9999";
    registerSecrets([secretVal]);
    const logs: string[] = [];
    try {
      const saved1 = savePilotDayDigest(db, {
        digestId: runCand.digestId,
        dayKey: runCand.dayKey,
        sourceKind: "pilot_run",
        sourceId: "run-1",
        projectId: "proj-1",
        threadId: "thr-pm-1",
        workflowId: null,
        outcome: "failed",
        processKey: `proc-${secretVal}`,
        categoryHint: { id: "release", label: { en: "Release", ru: "Релиз" } },
        skills: ["lp-plan"],
        traps: ["missing-check"],
        maskedGoal: "Ship daily digest",
        maskedLessons: ["Run checks before merge"],
        taskCount: 3,
        createdAt: t0 + 20_000,
      }, { log: (m) => logs.push(m) });
      expect(saved1.saved).toBe(true);
      expect(saved1.row.categoryHint).toEqual({ id: "release", label: { en: "Release", ru: "Релиз" } });
      expect(logs[0]).toContain("INFO [storage.dayDigest] saved");
      expect(logs[0]).not.toContain(secretVal);

      const savedDup = savePilotDayDigest(db, {
        digestId: runCand.digestId,
        dayKey: runCand.dayKey,
        sourceKind: "pilot_run",
        sourceId: "run-1",
        outcome: "succeeded",
        processKey: "other",
        maskedGoal: "Ignored",
        createdAt: t0 + 21_000,
      }, { log: (m) => logs.push(m) });
      expect(savedDup.saved).toBe(false);
      expect(savedDup.row.outcome).toBe("failed");
      expect(logs[1]).toContain("DEBUG [storage.dayDigest] duplicate");
    } finally {
      forgetSecrets();
    }

    // Append-only trigger prevents delete
    expect(() => db.prepare("DELETE FROM lane_pilot_day_digest WHERE digest_id=?").run(runCand.digestId))
      .toThrow(/day digests are append-only/);

    // Same window now excludes run-1 AND still excludes thr-pm-1 from pilot_chat
    const remaining = listPilotDayCandidates(db, sinceMs, untilMs, 20);
    expect(remaining.map((c) => `${c.sourceKind}:${c.sourceId}`)).toEqual([
      "workflow_run:wf-user-1",
      "pilot_chat:thr-pm-3",
      "pilot_chat:thr-pm-2",
    ]);

    // Save wf-user-1 as finalized and in-progress run-2; on next day window only in-progress run-2 returns
    savePilotDayDigest(db, {
      digestId: wfCand.digestId, dayKey: wfCand.dayKey, sourceKind: "workflow_run", sourceId: "wf-user-1",
      projectId: "proj-wf", workflowId: "custom-deploy", outcome: "succeeded", processKey: "deploy",
      maskedGoal: "Deploy", createdAt: t0 + 22_000,
    });
    createRun(db, "run-2", "proj-2", "cli");
    db.prepare("UPDATE lane_pilot_run SET updated_at=? WHERE id=?").run(t0 + 16_000, "run-2");
    const run2Cand = listPilotDayCandidates(db, sinceMs, untilMs, 20).find((c) => c.sourceId === "run-2")!;
    savePilotDayDigest(db, {
      digestId: run2Cand.digestId, dayKey: run2Cand.dayKey, sourceKind: "pilot_run", sourceId: "run-2",
      projectId: "proj-2", outcome: "in_progress", processKey: "wip", maskedGoal: "WIP", createdAt: t0 + 23_000,
    });

    const nextSince = untilMs;
    const nextUntil = untilMs + 86_400_000;
    db.prepare("UPDATE lane_pilot_run SET updated_at=? WHERE id IN ('run-1','run-2')").run(nextSince + 1_000);
    db.prepare(`UPDATE lane_pilot_wf_run SET updated_at=? WHERE id='wf-user-1'`).run(nextSince + 2_000);
    const nextDay = listPilotDayCandidates(db, nextSince, nextUntil, 20);
    expect(nextDay.map((c) => c.sourceId)).toEqual(["run-2"]);

    // listPilotDayDigests returns newest first and parses malformed JSON safely
    db.prepare("UPDATE lane_pilot_day_digest SET skills_json='{bad', category_hint_json='[1]' WHERE digest_id=?").run(runCand.digestId);
    const listed = listPilotDayDigests(db, t0 + 20_000, 10);
    expect(listed.map((d) => d.digestId)).toEqual([run2Cand.digestId, wfCand.digestId, runCand.digestId]);
    expect(listed[2]?.skills).toEqual([]);
    expect(listed[2]?.categoryHint).toBeNull();

    await harness.lifecycle.dispose();
  });
});

describe("digestPilotDayDialogues and collectGraphEvolveEvidence integration", () => {
  it("digests Pilot runs & chats with masking, filters sandbox & disabled projects, records trajectory deltas, and merges into graph-evolve clusters idempotently", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const t0 = Date.UTC(2026, 10, 20, 0, 0, 0);
    const sinceMs = t0;
    const untilMs = t0 + 86_400_000;
    let currentTime = t0 + 50_000;
    const now = () => currentTime;

    const secretToken = "sk-live-secret-token-1234567890abcdef";
    const rawEmail = "owner@example.com";
    registerSecrets([secretToken]);

    // 1. Real project run with 2 tasks, writer attempt, failed + passed critic receipts, and owner correction
    createRun(db, "run_site_1", "proj_real", "cli");
    setRunThread(db, "run_site_1", "thr_pm_site");
    setRunObjective(db, "run_site_1", "Собрать лендинг кофейни с мобильной сеткой 375px");
    createTask(db, { id: "t_site_1", runId: "run_site_1", kind: "cli", contract: { title: "Сверстать первый экран" } });
    createTask(db, { id: "t_site_2", runId: "run_site_1", kind: "cli", contract: { title: "Написать продающие тексты" } });
    createAttempt(db, { id: "att_site_1", runId: "run_site_1", taskId: "t_site_1" });
    db.prepare("UPDATE lane_pilot_attempt SET thread_id=?, state=?, reason=?, updated_at=? WHERE id=?")
      .run("thr_writer_1", "accepted", "writer built hero and mobile layout", t0 + 20_000, "att_site_1");
    saveStageReceipt(db, {
      runId: "run_site_1", taskId: "t_site_1", stageId: "code-critique", contractVersion: 1, state: "failed",
      inputSha256: "a".repeat(64), outputSha256: null, attempt: 1, providerId: null, model: null,
      threadId: null, result: null, reason: "mobile grid breaks at 375px", updatedAt: t0 + 18_000,
    });
    saveStageReceipt(db, {
      runId: "run_site_1", taskId: "t_site_2", stageId: "code-critique", contractVersion: 1, state: "passed",
      inputSha256: "b".repeat(64), outputSha256: "c".repeat(64), attempt: 1, providerId: null, model: null,
      threadId: null, result: null, reason: "copy and 375px grid passed", updatedAt: t0 + 21_000,
    });
    db.prepare("UPDATE lane_pilot_run SET state='accepted', updated_at=? WHERE id=?").run(t0 + 22_000, "run_site_1");
    db.prepare(`INSERT INTO lane_pilot_learning_obs
      (id, thread_id, project_id, at, judged_at, source, chars, excerpt, state, sensitive, kind, body, prev)
      VALUES (?, ?, ?, ?, ?, 'live', 64, ?, 'observed', 0, 'correction', ?, ?)`).run(
      "obs_corr_1",
      "thr_pm_site",
      "proj_real",
      t0 + 15_000,
      t0 + 15_000,
      "задействуй скиллы копирайтинга и не ломай мобильную сетку 375px",
      "задействуй скиллы копирайтинга и не ломай мобильную сетку 375px",
      "прежний черновик",
    );

    // 2. Activated Pilot chat in another project
    db.prepare("INSERT INTO lane_pilot_activation(project_id,pm_thread_id,run_id,claimed_at) VALUES (?,?,?,?)")
      .run("proj_chat", "thr_pm_chat", "run_chat_1", t0 + 12_000);

    // 3. Sandbox project run (by name "LP sandbox OVH (drill)")
    createRun(db, "run_sandbox_1", "proj_sandbox_drill", "cli");
    db.prepare("UPDATE lane_pilot_run SET updated_at=? WHERE id=?").run(t0 + 14_000, "run_sandbox_1");

    // 4. Project with episodes.collect = false
    createRun(db, "run_disabled_1", "proj_disabled", "cli");
    db.prepare("UPDATE lane_pilot_run SET updated_at=? WHERE id=?").run(t0 + 13_000, "run_disabled_1");
    saveProjectSetting(db, "proj_disabled", "episodes.collect", false);

    const prompts: Array<{ projectId: string | null; digestId: string; prompt: string }> = [];
    const logs: string[] = [];

    const readOutline = async (threadId: string): Promise<string | null> => {
      if (threadId === "thr_pm_site") {
        return `User: Собери сайт, токен ${secretToken}, почта ${rawEmail}\nAssistant: Читаю skills/ru-text/SKILL.md и правлю мобильную сетку 375px`;
      }
      if (threadId === "thr_writer_1") {
        return "User: Сверстай первый экран\nAssistant: Проверил адаптив на 375px";
      }
      if (threadId === "thr_pm_chat") {
        return "User: Уточни оффер в шапке сайта\nAssistant: Готово";
      }
      return null;
    };

    const readEvents = async (threadId: string): Promise<unknown[]> => {
      if (threadId === "thr_pm_site" || threadId === "thr_writer_1") {
        return [
          {
            type: "item/completed",
            seq: 1,
            data: { item: { type: "toolCall", tool: "read_file", input: { path: "skills/ru-text/SKILL.md" } } },
          },
        ];
      }
      return [];
    };

    const runModel = vi.fn(async (prompt: string, projectId: string | null, digestId: string): Promise<string> => {
      prompts.push({ projectId, digestId, prompt });
      expect(prompt).not.toContain(secretToken);
      expect(prompt).not.toContain(rawEmail);

      if (projectId === "proj_real") {
        expect(prompt).toContain("[email]");
        expect(prompt).toContain("writer built hero and mobile layout");
        expect(prompt).toContain("mobile grid breaks at 375px");
        expect(prompt).toContain("copy and 375px grid passed");
        expect(prompt).toContain("задействуй скиллы копирайтинга");
        expect(prompt).toContain("ru-text");

        return JSON.stringify({
          process_key: "websites|site-creation",
          category_hint: { id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } },
          outcome: "done",
          goal: "Create a coffee shop landing page with copywriting and 375px grid",
          traps: ["mobile grid breaks at 375px without layout check"],
          lessons: ["run copywriting skills before layout pass and verify 375px grid"],
          interventions: [
            {
              kind: "skill_request",
              stage_archetype: "copy",
              summary: "Задействовать скиллы копирайтинга перед вёрсткой",
              skills: ["ru-text"],
            },
            {
              kind: "rule_added",
              stage_archetype: "verification",
              summary: "Проверять мобильную сетку 375px на этапе критика",
              skills: ["impeccable-ui"],
            },
          ],
        });
      }

      return JSON.stringify({
        process_key: "websites|copy-review",
        category_hint: { id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } },
        outcome: "done",
        goal: "Clarify header offer copy in chat",
        traps: [],
        lessons: ["keep hero offer concise"],
        interventions: [],
      });
    });

    const deps = {
      db,
      now,
      sinceMs,
      untilMs,
      projectNames: async () => new Map([
        ["proj_real", "Coffee House"],
        ["proj_chat", "B2B Site"],
        ["proj_sandbox_drill", "LP sandbox OVH (drill)"],
        ["proj_disabled", "Private App"],
      ]),
      readOutline,
      readEvents,
      runModel,
      skillCatalog: [
        { name: "ru-text", description: "Русский копирайтинг и редактура текстов", tags: ["copywriting", "ru-text"] },
        { name: "impeccable-ui", description: "Responsive layout and UI verification", tags: ["design", "layout"] },
      ],
      log: (m: string) => logs.push(m),
    };

    const summary = await digestPilotDayDialogues(deps);
    expect(summary).toEqual({
      picked: 4,
      digested: 2,
      deltasRecorded: 2,
      skippedSandbox: 1,
      skippedDisabled: 1,
      failed: 0,
    });
    expect(runModel).toHaveBeenCalledTimes(2);
    expect(prompts).toHaveLength(2);

    const deltas = listUnprocessedTrajectoryDeltas(db);
    expect(deltas).toHaveLength(2);
    const skillDelta = deltas.find((d) => d.interventionKind === "skill_request");
    const ruleDelta = deltas.find((d) => d.interventionKind === "rule_added");
    expect(skillDelta?.resolvedSkills).toContain("ru-text");
    expect(ruleDelta?.resolvedSkills).toContain("impeccable-ui");

    const storedDigests = listPilotDayDigests(db, sinceMs);
    expect(storedDigests).toHaveLength(2);
    const siteDigest = storedDigests.find((d) => d.processKey === "websites|site-creation");
    expect(siteDigest).toBeDefined();
    expect(siteDigest?.categoryHint).toEqual({ id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } });
    expect(siteDigest?.outcome).toBe("done");
    expect(siteDigest?.taskCount).toBe(2);

    const evidence = collectGraphEvolveEvidence(db, { now, log: (m) => logs.push(m) });
    expect(evidence.status).toBe("ready");
    const siteCluster = evidence.clusters.find((c) => c.processKey === "websites|site-creation");
    expect(siteCluster).toBeDefined();
    expect(siteCluster?.categoryHint).toEqual({ id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } });
    expect(siteCluster?.lessons).toEqual(["run copywriting skills before layout pass and verify 375px grid"]);
    expect(siteCluster?.traps).toEqual(["mobile grid breaks at 375px without layout check"]);
    expect(siteCluster?.topSkills).toEqual(expect.arrayContaining(["ru-text", "impeccable-ui"]));
    expect(evidence.deltas).toHaveLength(2);

    // Finalized runs & chats are excluded from candidates on repeated pass in the same day window
    const remainingCandidates = listPilotDayCandidates(db, sinceMs, untilMs, 20);
    expect(remainingCandidates.map((c) => c.sourceId)).not.toContain("run_site_1");
    expect(remainingCandidates.map((c) => c.sourceId)).not.toContain("thr_pm_chat");

    // Repeated call on the same window does not re-digest finalized runs/chats or create duplicate deltas
    currentTime += 1_000;
    const repeatSameDb = await digestPilotDayDialogues(deps);
    expect(repeatSameDb.digested).toBe(0);
    expect(repeatSameDb.deltasRecorded).toBe(0);
    expect(runModel).toHaveBeenCalledTimes(2);
    expect(listUnprocessedTrajectoryDeltas(db)).toHaveLength(2);
    expect(listPilotDayDigests(db, sinceMs)).toHaveLength(2);

    // When only finalized runs/chats exist in the window, picked is 0
    db.prepare("UPDATE lane_pilot_run SET updated_at=? WHERE id IN ('run_sandbox_1','run_disabled_1')").run(t0 - 1_000);
    const repeatClean = await digestPilotDayDialogues(deps);
    expect(repeatClean).toEqual({
      picked: 0,
      digested: 0,
      deltasRecorded: 0,
      skippedSandbox: 0,
      skippedDisabled: 0,
      failed: 0,
    });

    // Diagnostic log events emitted without leaking secrets or emails
    const joinedLogs = logs.join("\n");
    expect(joinedLogs).toContain("[nightGraphs.pilotDayDigest] start");
    expect(joinedLogs).toContain("[nightGraphs.pilotDayDigest] digested");
    expect(joinedLogs).toContain("[nightGraphs.pilotDayDigest] skipped_sandbox");
    expect(joinedLogs).toContain("[nightGraphs.pilotDayDigest] skipped_disabled");
    expect(joinedLogs).toContain("[nightGraphs.pilotDayDigest] done");
    expect(joinedLogs).not.toContain(secretToken);
    expect(joinedLogs).not.toContain(rawEmail);

    await harness.lifecycle.dispose();
  });
});

describe("createLivePilotDayDigestDeps", () => {
  it("creates an isolated $HOME/.lane-pilot/graph-evolve room via host.call and invokes ruleScan.runAnalyzer as episode-analyst", async () => {
    const w = nightWorld({
      hostReply: (command) => (command.includes('"$HOME/.lane-pilot/graph-evolve"') ? "/home/ubuntu/.lane-pilot/graph-evolve" : undefined),
    });
    const runAnalyzer = vi.fn(async () => JSON.stringify({
      process_key: "general|task",
      category_hint: null,
      outcome: "done",
      goal: "Done",
      traps: [],
      lessons: [],
      interventions: [],
    }));
    const threadEvents = vi.fn(async () => [{ type: "turn/started", seq: 1 }]);

    const deps = createLivePilotDayDigestDeps(
      w.ctx,
      {
        harness: { threadEvents },
        resolveProjectWriterHost: w.services.resolveProjectWriterHost,
        ruleScan: { runAnalyzer },
      },
      () => false,
      [],
    );

    const out = await deps.runModel("masked prompt", "proj-1", "dig_test_1");
    expect(JSON.parse(out)).toMatchObject({ process_key: "general|task", outcome: "done" });
    expect(w.state.commands.some((c) => c.startsWith("runCommand:") && c.includes('mkdir -p "$HOME/.lane-pilot/graph-evolve"'))).toBe(true);
    expect(runAnalyzer).toHaveBeenCalledTimes(1);
    expect(runAnalyzer).toHaveBeenCalledWith(
      "proj-1",
      "pilot-day-digest:dig_test_1",
      "masked prompt",
      { hostId: "host-1", path: "/home/ubuntu/.lane-pilot/graph-evolve" },
      expect.objectContaining({ providerId: expect.any(String), model: expect.any(String) }),
      { pilotDayDigest: "dig_test_1" },
      "episode-analyst",
    );

    const events = await deps.readEvents!("thr-1");
    expect(threadEvents).toHaveBeenCalledWith("thr-1", expect.any(Number));
    expect(events).toHaveLength(1);

    await w.harness.lifecycle.dispose();
  });
});
