import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { firstInput, out, pathOf } from "./chain-helpers";
import { chainStore, runSim } from "./chain-harness";
import { reply, runHomeWorld } from "./run-home-world";

const input = { topic: "кофемашины для дома", geo: "", language: "ru", site_goal: "", use_seo_tools: false, max_pages: 12 };
const initialBatch = [
  { slug: "page-0", intent: "buy", entity: "e0", parent: "root" },
  { slug: "page-1", intent: "buy", entity: "e1", parent: "root" },
];
const revisedBatch = [initialBatch[1]!];

const base = (pageMapBatch = initialBatch) => ({
  chainsmith: { ok: true, vars: {}, commands: ["/исследование"] },
  "seo-research": { status: "done", package_path: ".agents/seo/research/kofemashiny" },
  boundaries: { boundaries_path: "boundaries.md", entity_graph_path: "entities.json" },
  architecture: {
    page_count: pageMapBatch.length,
    clusters: [{ name: "выбор" }],
    pages: pageMapBatch,
    fact_registry_path: "fact_registry.json",
    acceptors_path: "acceptors.json",
    architecture_path: "architecture.json",
  },
  page_map: { page_map_path: "page_map.json", locked_count: pageMapBatch.length, batch: pageMapBatch },
  "seo-brief": ((ctx: { input: { item?: unknown } }) => ({
    status: "done",
    brief_path: `briefs/${(ctx.input.item as { slug: string }).slug}.md`,
  })) as never,
  audit: { status: "pass", findings: [], orphan_count: 0, cannibal_count: 0 },
  package: { folder: ".agents/seo/kofemashiny", handoff_path: ".agents/seo/kofemashiny/handoff.md" },
});

describe("seo-cocoon contracts", () => {
  it("delivers the nondefault owner brief answer to chainsmith exactly", async () => {
    const r = await runSim("seo-cocoon", {
      input,
      stubs: base(),
      humans: {
        ask_brief: { answer_kind: "answered", answer: "RU / B2B service / only installation pages / use the supplied CSV" },
        scope_freeze: { answer_kind: "approved", answer: "approve" },
      },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(firstInput(r, "chainsmith")).toMatchObject({
      brief_answer: "RU / B2B service / only installation pages / use the supplied CSV",
      brief_answer_kind: "answered",
    });
    expect(pathOf(r)).toContain("chainsmith");
  });

  it("reconciles an edited batch before fanout and requires explicit approval", async () => {
    const r = await runSim("seo-cocoon", {
      input,
      stubs: {
        ...base(),
        page_map: [
          { page_map_path: "page_map-v1.json", locked_count: initialBatch.length, batch: initialBatch },
          { page_map_path: "page_map-v2.json", locked_count: revisedBatch.length, batch: revisedBatch },
        ],
      },
      humans: {
        ask_brief: { answer_kind: "answered", answer: "RU / shop" },
        scope_freeze: [
          { answer_kind: "edited", answer: "Keep only page-1; defer page-0 with a note." },
          { answer_kind: "approved", answer: "approved after reconciliation" },
        ],
      },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toContain("scope_freeze briefs");
    expect(r.called("page_map")).toHaveLength(2);
    expect(r.called("page_map")[1]!.input).toMatchObject({
      owner_edit: "Keep only page-1; defer page-0 with a note.",
      owner_answer_kind: "edited",
    });
    expect(r.called("briefs:child")).toHaveLength(1);
    expect(r.called("briefs:child")[0]!.input.slug).toBe("page-1");
  });

  it("blocks truthfully on timeout and on a second unreconciled edit", async () => {
    const timedOut = await runSim("seo-cocoon", {
      input,
      stubs: base(),
      humans: { ask_brief: { answer_kind: "answered", answer: "RU / shop" }, scope_freeze: { answer_kind: "timeout", answer: "" } },
    });
    expect(pathOf(timedOut)).toMatch(/scope_freeze blocked$/);
    expect(out(timedOut)).toMatchObject({ status: "blocked" });
    expect(timedOut.called("briefs:child")).toHaveLength(0);

    const exhausted = await runSim("seo-cocoon", {
      input,
      stubs: { ...base(), page_map: { page_map_path: "page_map.json", locked_count: initialBatch.length, batch: initialBatch } },
      humans: {
        ask_brief: { answer_kind: "answered", answer: "RU / shop" },
        scope_freeze: [
          { answer_kind: "edited", answer: "First edit" },
          { answer_kind: "edited", answer: "Second edit without approval" },
        ],
      },
    });
    expect(pathOf(exhausted)).toMatch(/scope_freeze blocked$/);
    expect(out(exhausted)).toMatchObject({ status: "blocked" });
    expect(exhausted.called("briefs:child")).toHaveLength(0);
  });

  it("uses an explicit producer manifest instead of a literal glob", async () => {
    const workflow = JSON.parse(await readFile(new URL("../../workflows/seo-cocoon.json", import.meta.url), "utf8")) as {
      nodes: Array<{ id: string; files?: unknown; contents?: Record<string, unknown> }>;
    };
    const packageNode = workflow.nodes.find((node) => node.id === "package")!;
    expect(packageNode.files).toBeUndefined();
    const contents = packageNode.contents!;
    expect(contents).toMatchObject({
      "manifest.json": expect.objectContaining({ briefs_dir: "{{$inputs.briefs_dir}}", brief_paths: "{{briefs.brief_paths}}" }),
      "handoff.md": expect.stringContaining("exact file-specific paths"),
    });
    expect(contents["manifest.json"]).not.toHaveProperty("architecture_path");
    expect(contents["manifest.json"]).not.toHaveProperty("page_map_path");
    expect(JSON.stringify(packageNode)).not.toContain("*.md");
  });

  it("threads the actual brief root through seo-page's public result", async () => {
    const page = JSON.parse(await readFile(new URL("../../workflows/seo-page.json", import.meta.url), "utf8")) as {
      outputs: Record<string, string>;
      nodes: Array<{ id: string; map?: Record<string, string> }>;
    };
    expect(page.outputs.briefs_dir).toBe("string");
    expect(page.nodes.find((node) => node.id === "done")?.map?.briefs_dir).toBe("cocoon.briefs_dir");
  });

  it("returns file-specific paths from the real seo-brief fs.write nodes and preserves their bytes", async () => {
    const store = await chainStore();
    const world = await runHomeWorld({
      passport: [reply({ passport_path: "passport.json", focus: "coffee choice", handoff: "passport" })],
      serp_gap: [reply({ gap_path: "gap.json", wireframe_path: "wireframe.md", handoff: "gap" })],
      gist_core: [reply({ core_path: "core.md", job: "choose", decision_nodes: 2, handoff: "gist" })],
      link_rows: [reply({ links_path: "links.json", handoff: "links" })],
      evidence: [reply({ evidence_path: "evidence.json", cards: 2, handoff: "evidence" })],
      utility_gate: [reply({ gate: "pass", notes: "ready", handoff: "gate" })],
    });
    try {
      const result = await world.start(store.get("seo-brief")!.workflow, { slug: "real-page", intent: "comparison" }).done;
      expect(result.status).toBe("succeeded");
      expect(result.output?.brief_path).toMatch(/^\.agents\/seo\/briefs\/real-page\/[^/]+\/brief\.md$/);
      expect(result.output?.evidence_path).toMatch(/^\.agents\/seo\/briefs\/real-page\/[^/]+\/evidence-cards\.json$/);
      const briefPath = String(result.output?.brief_path), evidencePath = String(result.output?.evidence_path);
      expect(await readFile(`${world.checkout}/${briefPath}`, "utf8")).toContain("# GIST brief");
      expect(await readFile(`${world.checkout}/${evidencePath}`, "utf8")).toContain("utility_gate");
    } finally {
      await world.dispose();
    }
  });
});
