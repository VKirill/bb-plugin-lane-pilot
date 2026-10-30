import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerSecrets } from "@lane-pilot/kit";
import { openDatabase } from "../../src/rooms/storage/database";
import {
  PM_CONTEXT_MAX_CHARS,
  buildPmContextContent,
  compilePmContextFromDb,
  formatPmContextSection,
  getPmContextSummary,
  getStoredPmContext,
  pmContextMorningLine,
  savePmContext,
  type PmContextData,
} from "../../src/rooms/native-agent";
import {
  LANE_PILOT_PM_SESSION,
  lanePmOverlayPrompt,
} from "../../src/rooms/native-agent/native-agent-overlay";

describe("PM context.md (Item 5)", () => {
  it("buildPmContextContent formats concise Markdown with all sections", () => {
    const data: PmContextData = {
      projectId: "proj_demo",
      activeRunId: "run_42",
      runObjective: "Refactor database queries and add caching",
      acceptedTasks: [
        { id: "task_1", title: "Add Redis client", state: "accepted" },
      ],
      openTasks: [
        { id: "task_2", title: "Benchmark latency", state: "running" },
      ],
      activeRules: [
        { id: "rule_1", text: "Always close Redis connections" },
      ],
      openWalls: [
        { classKey: "cls_1", failureClass: "infra", reasonNorm: "Redis connection timeout" },
      ],
    };

    const res = buildPmContextContent(data);
    expect(res.sectionsCount).toBe(6);
    expect(res.bytes).toBeGreaterThan(100);
    expect(res.content).toContain("# Project Context: proj_demo");
    expect(res.content).toContain("## Active State");
    expect(res.content).toContain("Run: run_42");
    expect(res.content).toContain("## Recent Accepted Tasks");
    expect(res.content).toContain("task_1: Add Redis client (accepted)");
    expect(res.content).toContain("## Open Tasks & Blockers");
    expect(res.content).toContain("task_2: Benchmark latency [running]");
    expect(res.content).toContain("## Active Project Rules");
    expect(res.content).toContain("rule_1");
    expect(res.content).toContain("## Open Failure Classes");
    expect(res.content).toContain("Redis connection timeout");
  });

  it("compilePmContextFromDb queries DB and assembles live project context", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = Date.now();

    // Seed active run
    db.prepare(`
      INSERT INTO lane_pilot_run (id, project_id, state, objective, created_at, updated_at)
      VALUES ('run_100', 'proj_test', 'running', 'Build user auth', ?, ?)
    `).run(now - 5000, now);

    // Seed accepted task
    db.prepare(`
      INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at)
      VALUES ('task_done_1', 'run_100', 'bb', json_object('title', 'Login API'), ?)
    `).run(now - 4000);

    db.prepare(`
      INSERT INTO lane_pilot_attempt (id, run_id, task_id, state, created_at, updated_at)
      VALUES ('att_done_1', 'run_100', 'task_done_1', 'accepted', ?, ?)
    `).run(now - 3500, now - 3000);

    // Seed open task
    db.prepare(`
      INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at)
      VALUES ('task_open_1', 'run_100', 'bb', json_object('title', 'OAuth provider'), ?)
    `).run(now - 2000);

    const compiled = compilePmContextFromDb(db, "proj_test", now);
    expect(compiled.content).toContain("Run: run_100");
    expect(compiled.content).toContain("task_done_1: Login API (accepted)");
    expect(compiled.content).toContain("task_open_1: OAuth provider [pending]");
  });

  it("savePmContext persists directly to database table without touching filesystem", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = 1730000000000;

    const res = savePmContext(db, "proj_live", now);
    expect(res.bytes).toBeGreaterThan(30);

    const stored = getStoredPmContext(db, "proj_live");
    expect(stored).not.toBeNull();
    expect(stored).toContain("# Project Context: proj_live");

    const summary = getPmContextSummary(db, now - 1000, now + 1000);
    expect(summary).not.toBeNull();
    expect(summary!.projectsCount).toBe(1);
    expect(summary!.avgKb).toBeGreaterThanOrEqual(1);

    const morningLine = pmContextMorningLine(db, now);
    expect(morningLine).toContain("PM context.md: обновлён для 1 проектов");
  });

  it("formatPmContextSection enforces <= 2000 chars limit with truncation notice and redacts secrets", () => {
    const SECRET = "super_secret_pm_token_xyz";
    registerSecrets([SECRET]);

    const longText = `Secret: ${SECRET}\n` + "x".repeat(3000);
    const formatted = formatPmContextSection(longText);

    expect(formatted.length).toBeLessThanOrEqual(PM_CONTEXT_MAX_CHARS);
    expect(formatted).not.toContain(SECRET);
    expect(formatted).toContain("***");
    expect(formatted).toContain("... [truncated to 2000 chars]");

    const shortText = `Secret: ${SECRET}\nSimple context`;
    const shortFormatted = formatPmContextSection(shortText);
    expect(shortFormatted).not.toContain("truncated");
    expect(shortFormatted).not.toContain(SECRET);
    expect(shortFormatted).toContain("***");
  });

  it("pmContextMorningLine returns null when no updates in window", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(pmContextMorningLine(db)).toBeNull();
  });

  it("lanePmOverlayPrompt injects context into prompt while keeping base PM session within ceiling", () => {
    expect(LANE_PILOT_PM_SESSION.length).toBeLessThanOrEqual(20_000);

    const contextMd = "## Recent Accepted Tasks\n- Task A: Done";
    const prompt = lanePmOverlayPrompt("dev-orchestrator", contextMd);
    expect(prompt).toContain("You are **dev-orchestrator**");
    expect(prompt).toContain("## Project Context (context.md)");
    expect(prompt).toContain(contextMd);
  });
});
