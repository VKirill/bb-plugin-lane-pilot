import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import { openDatabase } from "../../src/rooms/plugin-db";
import { migrations } from "../../src/rooms/migrations";
import {
  SKILL_DOMAIN_SYNONYMS,
  TRAJECTORY_DELTA_TABLE,
  episodeSkills,
  hasExplicitSkillIntent,
  resolveSkillIntent,
  trajectoryDeltaMigrations,
  type SkillCatalogItem,
  type TrajectoryInterventionKind,
} from "../../src/rooms/errands";
import {
  listUnprocessedTrajectoryDeltas,
  markTrajectoryDeltasProcessed,
  recordTrajectoryDelta,
} from "../../src/rooms/errands/server";
import migrationLock from "../fixtures/migrations.lock.json";

const CATALOG: readonly SkillCatalogItem[] = [
  {
    name: "ru-text",
    description: "Russian copywriting, editorial tone, headlines and text review",
    tags: ["copywriting", "editorial", "ru"],
    triggers: ["русский текст", "копирайтинг"],
  },
  {
    name: "copywriting-pro",
    description: "Продающие тексты, слоганы, заголовки, копирайтинг и редактура",
    tags: ["copywriting", "editorial"],
  },
  {
    name: "seo-audit",
    description: "Technical SEO audit, meta tags, schema, sitemap and search snippets",
    tags: ["seo", "search"],
    triggers: ["проверь seo", "сниппет"],
  },
  {
    name: "impeccable-ui",
    description: "Design, layout, visual typography, styling and landing review",
    tags: ["design", "layout", "ui"],
    triggers: ["ревью вёрстки", "дизайн"],
  },
  {
    name: "browser-qa",
    description: "Browser QA verification, regression checks and layout review",
    tags: ["qa", "browser"],
  },
  {
    name: "architecture-guard",
    description: "Check module boundaries, architecture contracts and database schema",
    tags: ["architecture", "module", "boundary"],
  },
  {
    name: "sql-ops",
    description: "SQLite maintenance, vacuum and backup operations",
    tags: ["ops", "sqlite"],
  },
];

const toolCall = (seq: number, tool: string, args: unknown) => ({
  type: "item/completed",
  seq,
  data: {
    item: {
      type: "toolCall",
      server: "bb",
      tool,
      arguments: args,
      status: "completed",
    },
  },
});

afterEach(() => {
  forgetSecrets();
});

describe("SkillIntentResolver", () => {
  it("resolves Russian copywriting requests including typos to copywriting skills only and logs INFO", () => {
    expect(Object.keys(SKILL_DOMAIN_SYNONYMS)).toEqual(
      expect.arrayContaining(["copywriting", "seo", "design", "qa", "architecture"]),
    );
    expect(hasExplicitSkillIntent("задействуй скиллы копирайтинга")).toBe(true);
    expect(hasExplicitSkillIntent("задейстувуй скиллы копирайтинга")).toBe(true);
    expect(hasExplicitSkillIntent("use the skills for SEO")).toBe(true);
    expect(hasExplicitSkillIntent("просто поправь отступ")).toBe(false);

    for (const phrase of [
      "задействуй скиллы копирайтинга",
      "задейстувуй скиллы копирайтинга",
    ]) {
      const logs: string[] = [];
      const matches = resolveSkillIntent(phrase, CATALOG, { log: (m) => logs.push(m) });
      const names = matches.map((m) => m.name);

      expect(names).toEqual(expect.arrayContaining(["ru-text", "copywriting-pro"]));
      expect(names).not.toContain("sql-ops");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^INFO \[errands\.skillIntent\] resolved /);
      const payload = JSON.parse(logs[0]!.replace(/^INFO \[errands\.skillIntent\] resolved /, "")) as {
        count: number;
        skills: Array<{ name: string; score: number }>;
      };
      expect(payload.count).toBe(matches.length);
      expect(payload.skills.map((s) => s.name)).toEqual(names);
    }
  });

  it("resolves multi-domain Russian and English queries to copywriting, SEO, design/QA and architecture skills", () => {
    const multiMatches = resolveSkillIntent("проверь русский текст и SEO", CATALOG);
    const multiNames = multiMatches.map((m) => m.name);
    expect(multiNames).toEqual(expect.arrayContaining(["ru-text", "seo-audit"]));
    expect(multiNames).not.toContain("sql-ops");

    const layoutMatches = resolveSkillIntent("сделай ревью вёрстки", CATALOG);
    expect(layoutMatches.map((m) => m.name)).toEqual(
      expect.arrayContaining(["impeccable-ui", "browser-qa"]),
    );

    const archMatches = resolveSkillIntent("check module boundaries", CATALOG);
    expect(archMatches[0]?.name).toBe("architecture-guard");
    expect(archMatches.map((m) => m.name)).not.toContain("ru-text");
  });

  it("ranks exact skill name mentions first and strips scope prefixes", () => {
    const scopedCatalog: readonly SkillCatalogItem[] = [
      { name: "editorial-helper", description: "General copywriting helper", tags: ["copywriting"] },
      { name: "vechkasov:impeccable-ui", description: "Visual layout polish", tags: ["design"] },
    ];
    const matches = resolveSkillIntent("apply impeccable-ui for design review", scopedCatalog);
    expect(matches[0]?.name).toBe("impeccable-ui");
    expect(matches.every((m) => !m.name.includes(":"))).toBe(true);
  });

  it("logs DEBUG on empty match, masks registered secrets, and respects a warn log level", () => {
    const secret = "sk-live-secret-999";
    registerSecrets([secret]);

    const debugLogs: string[] = [];
    const emptyMatches = resolveSkillIntent(`unrelated token ${secret}`, CATALOG, {
      log: (m) => debugLogs.push(m),
    });
    expect(emptyMatches).toEqual([]);
    expect(debugLogs).toHaveLength(1);
    expect(debugLogs[0]).toMatch(/^DEBUG \[errands\.skillIntent\] resolved /);
    expect(debugLogs[0]).not.toContain(secret);
    const debugPayload = JSON.parse(debugLogs[0]!.replace(/^DEBUG \[errands\.skillIntent\] resolved /, "")) as {
      count: number;
      intent: string;
    };
    expect(debugPayload.count).toBe(0);
    expect(debugPayload.intent).not.toContain(secret);

    // The level comes in as a parameter: LOG_LEVEL is read once at the plugin entry (initRuntimeEnv), not per call.
    const suppressedLogs: string[] = [];
    const matched = resolveSkillIntent("задействуй скиллы копирайтинга", CATALOG, {
      log: (m) => suppressedLogs.push(m),
      logLevel: "warn",
    });
    expect(matched.length).toBeGreaterThan(0);
    expect(suppressedLogs).toEqual([]);
  });
});

describe("unoffered SKILL.md reads & direct skill calls", () => {
  it("records offered:false skills from SKILL.md reads and direct skill calls while ignoring bb:bash", () => {
    const logs: string[] = [];
    const events = [
      toolCall(1, "read", { path: "/workspace/vechkasov.ru/.agents/skills/impeccable-ui/SKILL.md" }),
      toolCall(2, "read", { path: "/workspace/vechkasov.ru/.agents/skills/ru-text/SKILL.md" }),
      toolCall(3, "skill", { id: "ru-text" }),
      toolCall(4, "bb:bash", { command: "npm run build" }),
    ];

    const skills = episodeSkills([], events, { log: (m) => logs.push(m) });

    expect(skills).toEqual([
      { name: "impeccable-ui", offered: false, read: true, used: false },
      { name: "ru-text", offered: false, read: true, used: true },
    ]);
    expect(skills.some((s) => s.name.includes("bash") || s.name === "bb")).toBe(false);
    expect(logs.some((line) => line.includes("[errands.skillIntent] unoffered_skills") && line.includes("impeccable-ui") && line.includes("ru-text"))).toBe(true);
  });
});

describe("lane_pilot_trajectory_delta & migrations.lock.json", () => {
  it("records, masks PII/secrets, deduplicates, rejects invalid deltas, lists and marks processed", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const secret = "sk-live-secret-999";
    registerSecrets([secret]);

    try {
      const logs: string[] = [];
      const warns: string[] = [];
      const baseInput = {
        projectId: "proj-1",
        threadId: "thr-1",
        workflowId: "errand",
        stageArchetype: "Design & Copy!",
        interventionKind: "skill_request" as const,
        rawSummary: `Задействуй скиллы копирайтинга, напиши owner@example.com или +7 999 123-45-67, ключ ${secret}`,
        catalog: CATALOG,
        now: 1_730_000_001_000,
        log: (m: string) => logs.push(m),
        warn: (m: string) => warns.push(m),
      };

      const first = recordTrajectoryDelta(db, baseInput);
      expect(first.status).toBe("recorded");
      expect(first.row).not.toBeNull();
      expect(first.row?.stageArchetype).toBe("design-copy");
      expect(first.row?.resolvedSkills).toEqual(expect.arrayContaining(["ru-text", "copywriting-pro"]));
      expect(first.row?.maskedSummary).toContain("[email]");
      expect(first.row?.maskedSummary).toContain("[phone]");
      expect(first.row?.maskedSummary).not.toContain("owner@example.com");
      expect(first.row?.maskedSummary).not.toContain("123-45-67");
      expect(first.row?.maskedSummary).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
      expect(logs.some((l) => l.startsWith("INFO [errands.trajectoryDelta] recorded "))).toBe(true);

      const dup = recordTrajectoryDelta(db, baseInput);
      expect(dup.status).toBe("duplicate");
      expect(dup.row?.id).toBe(first.row?.id);
      expect(logs.some((l) => l.startsWith("DEBUG [errands.trajectoryDelta] duplicate "))).toBe(true);

      const badKind = recordTrajectoryDelta(db, {
        projectId: "proj-1",
        interventionKind: "unknown_kind" as TrajectoryInterventionKind,
        rawSummary: `bad ${secret}`,
        warn: (m) => warns.push(m),
      });
      expect(badKind).toEqual({ status: "rejected", row: null, reason: "invalid_kind" });

      const emptySummary = recordTrajectoryDelta(db, {
        projectId: "proj-1",
        interventionKind: "rule_added",
        rawSummary: "   ",
        warn: (m) => warns.push(m),
      });
      expect(emptySummary).toEqual({ status: "rejected", row: null, reason: "empty_summary" });
      expect(warns.some((w) => w.startsWith("WARN [errands.trajectoryDelta] rejected "))).toBe(true);
      expect(warns.join("\n")).not.toContain(secret);

      const unaccepted = recordTrajectoryDelta(db, {
        projectId: "proj-1",
        interventionKind: "variant_selected",
        rawSummary: "Rejected variant B for hero section",
        ownerAccepted: false,
        now: 1_730_000_002_000,
      });
      expect(unaccepted.status).toBe("recorded");

      const otherProject = recordTrajectoryDelta(db, {
        projectId: "proj-2",
        interventionKind: "step_inserted",
        rawSummary: "Insert browser QA gate before deploy",
        now: 1_730_000_003_000,
      });
      expect(otherProject.status).toBe("recorded");

      const acceptedProj1 = listUnprocessedTrajectoryDeltas(db, { projectId: "proj-1" });
      expect(acceptedProj1.map((r) => r.id)).toEqual([first.row!.id]);

      const allProj1 = listUnprocessedTrajectoryDeltas(db, { projectId: "proj-1", onlyAccepted: false });
      expect(allProj1.map((r) => r.id)).toEqual([first.row!.id, unaccepted.row!.id]);

      const processedLogs: string[] = [];
      const marked = markTrajectoryDeltasProcessed(
        db,
        [first.row!.id],
        1_730_000_010_000,
        (m) => processedLogs.push(m),
      );
      expect(marked).toBe(1);
      expect(processedLogs).toHaveLength(1);
      expect(processedLogs[0]).toMatch(/^INFO \[errands\.trajectoryDelta\] processed /);

      expect(listUnprocessedTrajectoryDeltas(db, { projectId: "proj-1" })).toEqual([]);

      expect(() =>
        db.prepare(`DELETE FROM ${TRAJECTORY_DELTA_TABLE} WHERE id = ?`).run(first.row!.id),
      ).toThrow(/trajectory deltas are append-only/);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("matches trajectoryDeltaMigrations hashes in migrations and migrations.lock.json", () => {
    const lockHashes = migrationLock as string[];
    const migrationHashes = migrations.map((statement) =>
      createHash("sha256").update(statement).digest("hex"),
    );
    const deltaHashes = trajectoryDeltaMigrations.map((statement) =>
      createHash("sha256").update(statement).digest("hex"),
    );
    const startIdx = migrations.indexOf(trajectoryDeltaMigrations[0]!);

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(migrationHashes).toHaveLength(lockHashes.length);
    expect(migrationHashes.slice(startIdx, startIdx + deltaHashes.length)).toEqual(deltaHashes);
    expect(lockHashes.slice(startIdx, startIdx + deltaHashes.length)).toEqual(deltaHashes);
  });
});
