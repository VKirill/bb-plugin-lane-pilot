import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GRAPH_CATEGORIES,
  GRAPH_CATEGORY_IDS,
  MIN_GRAPH_DESCRIPTION_LENGTH,
  isKnownGraphCategory,
} from "@lane-pilot/contracts";
import {
  START,
  dice,
  grams,
  parseShippedWorkflowObject,
  parseWorkflow,
  registerPureActions,
  stems,
  validateWorkflow,
  workflowRunFactSummaries,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import {
  builtinWorkflow,
  builtinWorkflows,
  loadBuiltinSourcesFromDir,
} from "../../src/rooms/workflow/builtin";
import { workflowCategory } from "../../src/rooms/workflow/models/categories";
import { buildPmCatalog, routeTool, type WorkflowToolDeps } from "../../src/rooms/workflow/server/handlers/workflow-tools";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import { engineOn } from "./engine-helpers";

const SIMILARITY_THRESHOLD = 0.45;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-graph-lib-"));
  tempDirs.push(dir);
  return dir;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function notForMentions(notFor: readonly string[], targetId: string): boolean {
  const rx = new RegExp(`(?<![a-z0-9.-])${escapeRegExp(targetId)}(?![a-z0-9.-])`);
  return notFor.some((entry) => rx.test(entry));
}

function findUnseparatedNearDuplicates(workflows: readonly Workflow[], threshold = SIMILARITY_THRESHOLD) {
  const byCategory = new Map<string, Workflow[]>();
  for (const wf of workflows) {
    const cat = workflowCategory(wf);
    const list = byCategory.get(cat) ?? [];
    list.push(wf);
    byCategory.set(cat, list);
  }
  const collisions: Array<{ category: string; a: string; b: string; similarity: number }> = [];
  for (const [category, list] of byCategory) {
    const gramCache = new Map(list.map((wf) => [wf.id, grams(stems(wf.description.en).join(" "))]));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        const similarity = dice(gramCache.get(a.id)!, gramCache.get(b.id)!);
        if (similarity >= threshold && !notForMentions(a.not_for, b.id) && !notForMentions(b.not_for, a.id)) {
          collisions.push({ category, a: a.id, b: b.id, similarity });
        }
      }
    }
  }
  return collisions;
}

function minimalGraph(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: { en: `Graph ${id}`, ru: `Граф ${id}` },
    description: {
      en: "Executes a clear bounded task and returns a structured status output for the caller.",
      ru: "Выполняет чёткую ограниченную задачу и возвращает структурированный статус вызывающему.",
    },
    category: "code",
    status: "published",
    triggers: ["manual"],
    outputs: [{ name: "status", type: "string" }],
    nodes: [
      { id: "work", type: "action", action: "noop", out: [{ name: "done", type: "string" }] },
      { id: "done", type: "action", action: "emit", map: { status: "'ok'" } },
    ],
    edges: [
      { from: START, to: "work" },
      { from: "work", to: "done" },
    ],
    ...extra,
  };
}

describe("Task 44: graph library categories, descriptions, directory loader, and PM catalog", () => {
  it("keeps one home of graph categories with unique ids and bilingual labels", () => {
    const ids = GRAPH_CATEGORIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...GRAPH_CATEGORY_IDS]);
    for (const entry of GRAPH_CATEGORIES) {
      expect(entry.label.en.trim().length).toBeGreaterThan(0);
      expect(entry.label.ru.trim().length).toBeGreaterThan(0);
    }
  });

  it("validates every shipped file in workflows/ with a known category and minimum description length", () => {
    // council.json is being deleted in parallel by Task 35.
    const files = readdirSync("workflows").filter((name) => name.endsWith(".json") && name !== "council.json").sort();
    expect(files.length).toBeGreaterThan(100);

    const parsed: Workflow[] = [];
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join("workflows", file), "utf8")) as Record<string, unknown>;
      const checked = parseShippedWorkflowObject(raw);
      expect(checked.success, `${file}: ${!checked.success ? checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : ""}`).toBe(true);
      if (!checked.success) continue;
      expect(isKnownGraphCategory(checked.data.category.id), `${file}: unknown category ${checked.data.category.id}`).toBe(true);
      expect(checked.data.description.en.trim().length, `${file} description.en`).toBeGreaterThanOrEqual(MIN_GRAPH_DESCRIPTION_LENGTH);
      expect(checked.data.description.ru.trim().length, `${file} description.ru`).toBeGreaterThanOrEqual(MIN_GRAPH_DESCRIPTION_LENGTH);
      const problems = validateWorkflow(checked.data, { resolve: builtinWorkflow, shipped: true }).filter((p) => p.level === "error");
      expect(problems, `${file} errors`).toEqual([]);
      parsed.push(checked.data);
    }

    expect(findUnseparatedNearDuplicates(parsed)).toEqual([]);
  });

  it("rejects two graphs with near-identical descriptions in one category unless not_for separates them", () => {
    const desc = {
      en: "Audits checkout payment handler edge cases and writes a full markdown verdict report without modifying files.",
      ru: "Проверяет граничные случаи обработчика оплаты и пишет отчёт без изменения файлов.",
    };
    const alpha = parseWorkflow(minimalGraph("alpha-audit", { category: "qa", description: desc }));
    const beta = parseWorkflow(minimalGraph("beta-audit", { category: "qa", description: desc }));
    expect(findUnseparatedNearDuplicates([alpha, beta])).toHaveLength(1);

    const betaSeparated = parseWorkflow(minimalGraph("beta-audit", {
      category: "qa",
      description: desc,
      not_for: ["alpha-audit: use alpha-audit for single-module payment checks"],
    }));
    expect(findUnseparatedNearDuplicates([alpha, betaSeparated])).toEqual([]);
  });

  it("loads a new graph file added in a temp dir without a code change and logs INFO/WARN accurately", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "custom-billing.json"), JSON.stringify(minimalGraph("custom-billing", { category: "business" }), null, 2));
    writeFileSync(join(dir, "uncategorized-short.json"), JSON.stringify({
      ...minimalGraph("uncategorized-short", { description: { en: "Too short", ru: "Коротко" } }),
      category: undefined,
    }, null, 2));

    const info: string[] = [];
    const warn: string[] = [];
    const result = loadBuiltinSourcesFromDir(dir, { log: { info: (m) => info.push(m), warn: (m) => warn.push(m) } });

    expect(result.workflows.map((w) => w.id)).toEqual(["custom-billing", "uncategorized-short"]);
    expect(info).toEqual(["workflow.library loaded graphs=2 categories=2"]);
    expect(warn).toEqual([
      "workflow.library missing category id=uncategorized-short file=uncategorized-short.json",
      `workflow.library short description id=uncategorized-short len=7 min=${MIN_GRAPH_DESCRIPTION_LENGTH} file=uncategorized-short.json`,
    ]);
  });

  it("groups the PM catalog by category with description, not_for, and Task 26 run facts when present", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    let clock = 10_000;
    const wfRunTarget = parseWorkflow(minimalGraph("invoice-check", {
      category: "business",
      not_for: ["billing-batch"],
      nodes: [
        { id: "work", type: "agent", role: "analyst", prompt: "Check invoice", out: [{ name: "done", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { status: "'ok'" } },
      ],
      edges: [{ from: START, to: "work" }, { from: "work", to: "done" }],
    }));
    const wfUnused = parseWorkflow(minimalGraph("seo-brief-demo", { category: "seo", not_for: ["seo-cocoon"] }));
    const wfInternal = parseWorkflow(minimalGraph("hidden-sub", { category: "service", internal: true }));

    const engine = engineOn(
      db,
      {
        agent: {
          run: async () => {
            clock += 300;
            return {
              output: { done: "yes", handoff: "done" },
              usage: {
                tokens: 1_500,
                costUsd: 0.007,
                inputTokens: 1_000,
                outputTokens: 500,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                requestedProvider: "anthropic",
                requestedModel: "claude-sonnet-5-5",
                answeredProvider: "anthropic",
                answeredModel: "claude-sonnet-5-5",
                costState: "measured",
              },
            };
          },
        },
      },
      { now: () => clock },
    );
    registerPureActions(engine);
    const run = engine.start({ workflow: wfRunTarget, inputs: {} });
    const summary = await run.done;
    expect(summary.status).toBe("succeeded");

    const facts = workflowRunFactSummaries(db);
    const catalog = buildPmCatalog([wfInternal, wfUnused, wfRunTarget], { facts });
    expect(catalog.map((c) => c.id)).toEqual(["seo", "business"]);

    const business = catalog.find((c) => c.id === "business")!;
    expect(business.label).toBe("Business and documents");
    expect(business.graphs).toEqual([
      expect.objectContaining({
        id: "invoice-check",
        description: wfRunTarget.description.en,
        not_for: ["billing-batch"],
        runFacts: expect.objectContaining({
          runs: 1,
          workDone: 1,
          costState: "measured",
          costUsd: 0.007,
          passedSteps: 2,
          avgDurationMs: 300,
        }),
      }),
    ]);

    const seo = catalog.find((c) => c.id === "seo")!;
    expect(seo.graphs[0]).not.toHaveProperty("runFacts");

    // Also verify routeTool returns the grouped catalog.
    const fakeStore = {
      list: () => [wfRunTarget, wfUnused, wfInternal].map((wf) => ({ workflow: wf, origin: "builtin" as const, source: `${wf.id}.json`, sha256: "sha", warnings: [] })),
      get: (id: string) => {
        const found = [wfRunTarget, wfUnused, wfInternal].find((wf) => wf.id === id);
        return found ? { workflow: found, origin: "builtin" as const, source: `${found.id}.json`, sha256: "sha", warnings: [] } : null;
      },
      resolve: () => null,
      problems: [],
    };
    const deps: WorkflowToolDeps = {
      db: db as never,
      store: async () => fakeStore,
      engine: () => ({}) as never,
      runtime: () => ({} as never),
      runFacts: () => workflowRunFactSummaries(db),
      warn: () => undefined,
    };
    const routed = JSON.parse(await routeTool(deps, { intent: "Check the invoice status" }, { threadId: "pm-1", projectId: "proj-1" })) as {
      catalog: Array<{ id: string; graphs: Array<{ id: string; runFacts?: unknown }> }>;
    };
    expect(routed.catalog.map((c) => c.id)).toEqual(["seo", "business"]);
    expect(routed.catalog.find((c) => c.id === "business")?.graphs[0]?.runFacts).toBeTruthy();

    // Verify shipped builtins list is non-empty and matches workflows/ directory load.
    expect(builtinWorkflows().length).toBeGreaterThan(100);
  });
});
