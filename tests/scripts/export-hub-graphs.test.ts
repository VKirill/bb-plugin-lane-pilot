import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  START,
  archiveDefinition,
  definitionSha256,
  loadWorkflow,
  parseWorkflow,
} from "@lane-pilot/workflow-engine";
import { exportHubGraphs } from "../../scripts/export-hub-graphs";
import { createCore } from "../../src/rooms/core/server/core";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import { collectGraphDurability, composeDurabilityDeskSection, loadGraphDurability } from "../../src/rooms/reports/server";
import { registerCli } from "../../src/rooms/tools/server";
import type { Services } from "../../src/rooms/services";

const ROOT = resolve(import.meta.dirname, "../..");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sampleGraph(id: string, version: number, label: string): Record<string, unknown> {
  return {
    id,
    version,
    status: "published",
    name: { en: `${id} ${label}`, ru: `${id} ${label}` },
    description: { en: `Graph ${id} ${label}`, ru: `Граф ${id} ${label}` },
    category: "ops",
    inputs: [{ name: "query", type: "string", required: false }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [
      { id: "work", type: "action", action: "emit", map: { result: "$inputs.query" } },
    ],
    edges: [
      { from: START, to: "work" },
    ],
  };
}

function createTempDb(dir: string) {
  const dbPath = join(dir, "hub.db");
  const fileDb = new Database(dbPath);
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const fakeBb = {
    ...bb,
    storage: {
      ...bb.storage,
      database: () => fileDb,
    },
  };
  const db = openDatabase(fakeBb as never);
  return { dbPath, bb: fakeBb as typeof bb, harness, db };
}

describe("export-hub-graphs (Task 53)", () => {
  it("writes one evolved built-in and one new graph to workflows dir, detects unchanged on rerun, and tracks desk drift", async () => {
    const dir = makeTempDir("lp-export-hub-");
    const workflowsDir = join(dir, "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    const { dbPath, db, bb, harness } = createTempDb(dir);

    try {
      // Shipped built-in v1 on disk + archived as scope='builtin'.
      const builtinV1Raw = sampleGraph("evolved-builtin", 1, "v1");
      const builtinV1 = parseWorkflow(builtinV1Raw);
      writeFileSync(join(workflowsDir, "evolved-builtin.json"), `${JSON.stringify(builtinV1Raw, null, 2)}\n`, "utf8");
      archiveDefinition(db, {
        workflowId: "evolved-builtin",
        version: 1,
        sha: definitionSha256(builtinV1),
        json: JSON.stringify(builtinV1Raw, null, 2),
        scope: "builtin",
        archivedAt: 1_000,
      });

      // Untouched built-in v1 on disk + archived as scope='builtin': must NOT be exported.
      const untouchedRaw = sampleGraph("untouched-builtin", 1, "v1");
      const untouched = parseWorkflow(untouchedRaw);
      archiveDefinition(db, {
        workflowId: "untouched-builtin",
        version: 1,
        sha: definitionSha256(untouched),
        json: JSON.stringify(untouchedRaw, null, 2),
        scope: "builtin",
        archivedAt: 1_000,
      });

      // Evolved built-in v2 (scope='global') and brand-new graph v1 (scope='global').
      const evolvedV2Raw = sampleGraph("evolved-builtin", 2, "v2");
      const evolvedV2 = parseWorkflow(evolvedV2Raw);
      archiveDefinition(db, {
        workflowId: "evolved-builtin",
        version: 2,
        sha: definitionSha256(evolvedV2),
        json: JSON.stringify(evolvedV2Raw, null, 2),
        scope: "global",
        archivedAt: 2_000,
      });

      const brandNewRaw = sampleGraph("brand-new-graph", 1, "new");
      const brandNew = parseWorkflow(brandNewRaw);
      archiveDefinition(db, {
        workflowId: "brand-new-graph",
        version: 1,
        sha: definitionSha256(brandNew),
        json: JSON.stringify(brandNewRaw, null, 2),
        scope: "global",
        archivedAt: 2_500,
      });

      // Before export: desk durability sees 2 drifted graphs and lastExportAt = null.
      const beforeDesk = composeDurabilityDeskSection(db, { workflowsDir });
      expect(beforeDesk.summary.lastExportDate).toBeNull();
      expect(beforeDesk.summary.drifted.map((d) => [d.workflowId, d.status])).toEqual([
        ["brand-new-graph", "missing"],
        ["evolved-builtin", "modified"],
      ]);
      expect(beforeDesk.items).toHaveLength(1);
      expect(beforeDesk.text).toContain("last export: never");

      // Run export.
      const logs: string[] = [];
      let markedCount = 0;
      const res = await exportHubGraphs({
        dbPath,
        workflowsDir,
        log: (line) => logs.push(line),
        markExported: async () => {
          markedCount += 1;
          registerCli(createCore(bb, db), {} as Services, migrations);
          const cliRes = await harness.behavior.runCli(["graphs", "mark-exported", "--at", "1764200000000"]);
          expect(cliRes.exitCode).toBe(0);
        },
      });

      expect(markedCount).toBe(1);
      expect(res.exported.map((e) => [e.workflowId, e.action])).toEqual([
        ["brand-new-graph", "created"],
        ["evolved-builtin", "updated"],
      ]);
      expect(res.unchanged).toEqual([]);
      expect(logs.some((line) => line === "exported 2 graphs, unchanged 0")).toBe(true);

      // Verify files written on disk and valid via loadWorkflow.
      expect(existsSync(join(workflowsDir, "untouched-builtin.json"))).toBe(false);
      const writtenEvolved = loadWorkflow(readFileSync(join(workflowsDir, "evolved-builtin.json"), "utf8"));
      const writtenNew = loadWorkflow(readFileSync(join(workflowsDir, "brand-new-graph.json"), "utf8"));
      expect(writtenEvolved.ok).toBe(true);
      expect(writtenNew.ok).toBe(true);
      if (writtenEvolved.ok) expect(writtenEvolved.workflow.version).toBe(2);
      if (writtenNew.ok) expect(writtenNew.workflow.id).toBe("brand-new-graph");

      // After export: desk durability reports zero drift and populated last export date from KV.
      const afterDesk = await loadGraphDurability(db, { workflowsDir, kv: bb.storage.kv });
      expect(afterDesk.drifted).toEqual([]);
      expect(afterDesk.lastExportAt).toBe(1764200000000);
      expect(afterDesk.lastExportDate).toBe("2025-11-26");

      const syncDesk = collectGraphDurability(db, { workflowsDir });
      expect(syncDesk.drifted).toEqual([]);
      expect(syncDesk.lastExportAt).toBe(1764200000000);

      // Second export reports unchanged.
      const logs2: string[] = [];
      const res2 = await exportHubGraphs({
        dbPath,
        workflowsDir,
        log: (line) => logs2.push(line),
        markExported: () => undefined,
      });
      expect(res2.exported).toEqual([]);
      expect(res2.unchanged).toEqual(["brand-new-graph", "evolved-builtin"]);
      expect(logs2).toContain("exported 0 graphs, unchanged 2");
    } finally {
      db.close();
    }
  });

  it("fails on a schema-invalid definition without writing any files", async () => {
    const dir = makeTempDir("lp-export-invalid-");
    const workflowsDir = join(dir, "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    const { dbPath, db } = createTempDb(dir);

    try {
      const validRaw = sampleGraph("good-graph", 1, "ok");
      archiveDefinition(db, {
        workflowId: "good-graph",
        version: 1,
        sha: definitionSha256(parseWorkflow(validRaw)),
        json: JSON.stringify(validRaw, null, 2),
        scope: "global",
        archivedAt: 1_000,
      });

      // Invalid definition: missing nodes/edges/name.
      archiveDefinition(db, {
        workflowId: "broken-graph",
        version: 1,
        sha: "deadbeef",
        json: JSON.stringify({ id: "broken-graph", nodes: [] }),
        scope: "global",
        archivedAt: 2_000,
      });

      let marked = false;
      await expect(
        exportHubGraphs({
          dbPath,
          workflowsDir,
          markExported: () => { marked = true; },
        }),
      ).rejects.toThrow(/schema-invalid definition for "broken-graph"/);

      expect(marked).toBe(false);
      expect(existsSync(join(workflowsDir, "good-graph.json"))).toBe(false);
      expect(existsSync(join(workflowsDir, "broken-graph.json"))).toBe(false);

      // CLI invocation also exits non-zero.
      let exitCode = 0;
      try {
        execFileSync("npx", ["tsx", join(ROOT, "scripts/export-hub-graphs.ts"), "--db", dbPath, "--workflows-dir", workflowsDir], {
          cwd: ROOT,
          stdio: "pipe",
        });
      } catch (err) {
        exitCode = (err as { status?: number }).status ?? 1;
      }
      expect(exitCode).not.toBe(0);
    } finally {
      db.close();
    }
  });

  it("--dry-run writes nothing and does not call mark-exported", async () => {
    const dir = makeTempDir("lp-export-dry-");
    const workflowsDir = join(dir, "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    const { dbPath, db } = createTempDb(dir);

    try {
      const raw = sampleGraph("dry-graph", 1, "dry");
      archiveDefinition(db, {
        workflowId: "dry-graph",
        version: 1,
        sha: definitionSha256(parseWorkflow(raw)),
        json: JSON.stringify(raw, null, 2),
        scope: "global",
        archivedAt: 1_000,
      });

      let marked = false;
      const logs: string[] = [];
      const res = await exportHubGraphs({
        dbPath,
        workflowsDir,
        dryRun: true,
        log: (line) => logs.push(line),
        markExported: () => { marked = true; },
      });

      expect(res.dryRun).toBe(true);
      expect(res.exported).toHaveLength(1);
      expect(marked).toBe(false);
      expect(existsSync(join(workflowsDir, "dry-graph.json"))).toBe(false);
      expect(logs.some((line) => line.startsWith("exported 1 graphs, unchanged 0"))).toBe(true);

      // Also verify CLI --dry-run writes nothing.
      const stdout = execFileSync(
        "npx",
        ["tsx", join(ROOT, "scripts/export-hub-graphs.ts"), "--db", dbPath, "--workflows-dir", workflowsDir, "--dry-run"],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(stdout).toContain("exported 1 graphs, unchanged 0");
      expect(existsSync(join(workflowsDir, "dry-graph.json"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses when git status --porcelain workflows/ shows foreign uncommitted changes unless --force", async () => {
    const dir = makeTempDir("lp-export-git-");
    const repoDir = join(dir, "repo");
    const workflowsDir = join(repoDir, "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(workflowsDir, "existing.json"), "{}\n", "utf8");
    execFileSync("git", ["add", "workflows/existing.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });

    // Create a foreign uncommitted change in workflows/.
    writeFileSync(join(workflowsDir, "dirty.json"), "{}\n", "utf8");

    const { dbPath, db } = createTempDb(dir);
    try {
      const raw = sampleGraph("git-graph", 1, "git");
      archiveDefinition(db, {
        workflowId: "git-graph",
        version: 1,
        sha: definitionSha256(parseWorkflow(raw)),
        json: JSON.stringify(raw, null, 2),
        scope: "global",
        archivedAt: 1_000,
      });

      await expect(
        exportHubGraphs({ dbPath, workflowsDir, markExported: () => undefined }),
      ).rejects.toThrow(/uncommitted changes/);
      expect(existsSync(join(workflowsDir, "git-graph.json"))).toBe(false);

      const forced = await exportHubGraphs({
        dbPath,
        workflowsDir,
        force: true,
        markExported: () => undefined,
      });
      expect(forced.exported).toHaveLength(1);
      expect(existsSync(join(workflowsDir, "git-graph.json"))).toBe(true);
    } finally {
      db.close();
    }
  });
});
