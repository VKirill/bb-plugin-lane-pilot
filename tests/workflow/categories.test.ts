import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyDraftOps,
  definitionSha256,
  loadWorkflow,
  parseWorkflowObject,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { workflowCategory } from "../../src/rooms/workflow/categories";
import { buildWorkflowExport, exportMarkdown, type WorkflowExportEntry } from "../../src/rooms/workflow/workflow-export";
import { codes, workflow } from "./fixtures";

describe("workflow categories", () => {
  it("puts every built-in graph on a shelf by its id and tags", () => {
    const of = (id: string) => workflowCategory(JSON.parse(readFileSync(`workflows/${readdirSync("workflows").find((f) => f === `${id}.json`)}`, "utf8")));
    expect([of("seo-page"), of("seo-ai-visibility"), of("mkt-project-intake"), of("mkt-direct-search-campaign"), of("lp.plan"), of("lead-tick"), of("sp-specialist-tick"), of("lp.specialist-eval"), of("lp.curriculum-ingest"), of("invoice-send"), of("ins.post"), of("social-post"), of("roblox-asset"), of("macos-routine"), of("quality-loop"), of("issue-quick")])
      .toEqual(["seo", "seo", "marketing", "marketing", "service", "service", "service", "service", "service", "business", "research", "content", "games", "routines", "code", "code"]);
    expect(of("site-creation")).toBe("websites");
    expect(workflowCategory({ id: "client-thing" })).toBe("code");
  });

  it("keeps built-in graphs without category unchanged and preserves definitionSha256 across serialization", () => {
    const raw = JSON.parse(readFileSync("workflows/seo-page.json", "utf8")) as Record<string, unknown>;
    const loaded = loadWorkflow(raw, { resolve: builtinWorkflow });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("expected seo-page to load");
    expect("category" in loaded.workflow).toBe(false);
    expect(loaded.workflow.category).toBeUndefined();

    const roundTripped = loadWorkflow(JSON.parse(JSON.stringify(loaded.workflow)), { resolve: builtinWorkflow });
    expect(roundTripped.ok).toBe(true);
    if (!roundTripped.ok) throw new Error("expected serialized seo-page to reload");
    expect(definitionSha256(loaded.workflow)).toBe(definitionSha256(roundTripped.workflow));
  });

  it("validates dynamic category labels and allows builtin category slugs in loadWorkflow", () => {
    const missingLabel = loadWorkflow(workflow({ category: { id: "analytics-ops" } }));
    expect(missingLabel.ok).toBe(false);
    if (missingLabel.ok) throw new Error("expected missing dynamic category label to fail");
    expect(codes(missingLabel.problems)).toContain("category_label_required");

    const dynamicValid = loadWorkflow(workflow({
      category: { id: "analytics-ops", label: { en: "Analytics & BI", ru: "Аналитика и BI" } },
    }));
    expect(dynamicValid.ok).toBe(true);
    if (!dynamicValid.ok) throw new Error("expected dynamic category with bilingual label to pass");
    expect(dynamicValid.workflow.category).toEqual({
      id: "analytics-ops",
      label: { en: "Analytics & BI", ru: "Аналитика и BI" },
    });

    const builtinString = loadWorkflow(workflow({ category: "seo" }));
    expect(builtinString.ok).toBe(true);
    if (!builtinString.ok) throw new Error("expected builtin category string to pass");
    expect(builtinString.workflow.category).toEqual({ id: "seo" });
  });

  it("sets and clears category via applyDraftOps set_meta", () => {
    const base = workflow();
    const setRes = applyDraftOps(base, [
      { op: "set_meta", set: { category: { id: "analytics-ops", label: { en: "Analytics & BI", ru: "Аналитика и BI" } } } },
    ]);
    expect(setRes.ok).toBe(true);
    if (!setRes.ok) throw new Error("expected set_meta to succeed");
    expect(setRes.definition.category).toEqual({
      id: "analytics-ops",
      label: { en: "Analytics & BI", ru: "Аналитика и BI" },
    });

    const clearRes = applyDraftOps(setRes.definition, [
      { op: "set_meta", set: { category: null } },
    ]);
    expect(clearRes.ok).toBe(true);
    if (!clearRes.ok) throw new Error("expected clearing category to succeed");
    expect("category" in clearRes.definition).toBe(false);
  });

  it("exports site-creation with dynamic websites category in manifest and markdown", () => {
    const raw = JSON.parse(readFileSync("workflows/site-creation.json", "utf8")) as Record<string, unknown>;
    const parsed = parseWorkflowObject(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected site-creation to parse");

    const entries: WorkflowExportEntry[] = [{ definition: raw, workflow: parsed.data as Workflow, scope: "builtin" }];
    const exported = buildWorkflowExport({ entries, redact: true, version: "0.0.0-test", commit: null, now: new Date(0) });
    expect(exported.manifest.graphs[0]).toMatchObject({ id: "site-creation", category: "websites" });
    expect(exported.markdown).toContain("## websites");
    expect(exportMarkdown(entries, "en", true)).toContain("## websites");
  });
});
