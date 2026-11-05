import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-research", () => {
  const input = { topic: "кофемашины для дома", mode: "new_section", use_seo_tools: false };
  const base = () => ({
    charter: { charter_path: "charter.md", ok: true },
    "corpus:child": { branch: "frequency", findings_path: "frequency.md", sources: [], skipped: true },
    corpus_registry: { corpus_path: "corpus.json", missing: [] },
    discovery: { maps_path: "maps.md" },
    tasks: { tasks_path: "tasks.json", intents: 24 },
    serp_grouping: { groups_path: "groups.json", gap_verdict: "create" },
    critic: { status: "pass", findings: [] },
    package: { package_path: ".agents/seo/research/kofemashiny" },
  });

  it("happy path: charter -> owner approval -> corpus -> registry -> maps -> tasks -> serp groups -> audit -> package -> done", async () => {
    const r = await runSim("seo-research", { input, stubs: base(), humans: { charter_ok: { answer_kind: "answered", answer: "ок" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("charter charter_ok corpus corpus_registry discovery tasks serp_grouping existing_section critic package done");
    expect(r.skipped).toEqual(["existing_section"]);
    expect(out(r)).toMatchObject({ status: "done", package_path: ".agents/seo/research/kofemashiny", verdict: "pass" });
  });

  it("existing_section mode runs the section audit node", async () => {
    const r = await runSim("seo-research", {
      input: { ...input, mode: "existing_section" },
      stubs: { ...base(), existing_section: { section_audit_path: "audit.md", cards: [] } },
      humans: { charter_ok: { answer_kind: "answered", answer: "ок" } },
    });
    expect(r.skipped).toEqual([]);
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("a rework verdict loops back to the task map once", async () => {
    const r = await runSim("seo-research", {
      input,
      stubs: {
        ...base(),
        critic: [{ status: "rework", findings: [{ severity: "high", title: "no source" }] }, { status: "pass", findings: [] }],
      },
      humans: { charter_ok: { answer_kind: "answered", answer: "ок" } },
    });
    expect(pathOf(r)).toBe("charter charter_ok corpus corpus_registry discovery tasks serp_grouping existing_section critic tasks serp_grouping existing_section critic package done");
    expect(out(r)).toMatchObject({ status: "done" });
  });
});

describe("seo-brief", () => {
  const input = { slug: "vybor-kofemashiny", intent: "comparison", risk_tier: "standard" };
  const base = () => ({
    passport: { passport_path: "passport.json", focus: "f" },
    serp_gap: { gap_path: "gap.json", wireframe_path: "wireframe.md" },
    gist_core: { core_path: "core.md", job: "choose", decision_nodes: 4 },
    link_rows: { links_path: "links.json" },
    evidence: { evidence_path: "evidence.json", cards: 6 },
    utility_gate: { gate: "pass", notes: "" },
    package: { brief_path: "briefs/vybor-kofemashiny.md", evidence_path: "evidence-cards/vybor-kofemashiny.json" },
  });

  it("happy path: passport -> serp gap -> gist -> links -> evidence -> gate -> package -> done", async () => {
    const r = await runSim("seo-brief", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("passport serp_gap gist_core link_rows evidence utility_gate package done");
    expect(out(r)).toMatchObject({ status: "done", brief_path: "briefs/vybor-kofemashiny.md", gate: "pass" });
  });

  it("a rebuild verdict loops back to gist_core once", async () => {
    const r = await runSim("seo-brief", {
      input,
      stubs: { ...base(), utility_gate: [{ gate: "rebuild", notes: "thin" }, { gate: "pass", notes: "" }] },
    });
    expect(pathOf(r)).toBe("passport serp_gap gist_core link_rows evidence utility_gate gist_core link_rows evidence utility_gate package done");
    expect(out(r)).toMatchObject({ status: "done" });
  });
});

describe("seo-cocoon v2", () => {
  const input = { topic: "кофемашины для дома", geo: "RU", language: "ru", site_goal: "интернет-магазин", use_seo_tools: false, max_pages: 12 };
  const batch = [
    { slug: "page-0", intent: "buy", entity: "e0", parent: "root" },
    { slug: "page-1", intent: "buy", entity: "e1", parent: "root" },
  ];
  const base = () => ({
    chainsmith: { ok: true, vars: {}, commands: ["/исследование"] },
    "seo-research": { status: "done", package_path: ".agents/seo/research/kofemashiny" },
    boundaries: { boundaries_path: "boundaries.md", entity_graph_path: "entities.json" },
    architecture: { page_count: 10, clusters: [{ name: "выбор" }, { name: "уход" }], pages: batch, fact_registry_path: "fact_registry.json", acceptors_path: "acceptors.json", architecture_path: "architecture.json" },
    page_map: { page_map_path: "page_map.json", locked_count: 2, batch },
    "seo-brief": { status: "done", brief_path: "briefs/page-0.md" },
    audit: { status: "pass", findings: [], orphan_count: 0, cannibal_count: 0 },
    package: { folder: ".agents/seo/kofemashiny", handoff_path: ".agents/seo/kofemashiny/handoff.md" },
  });

  it("happy path: brief -> chainsmith -> research -> boundaries -> architecture -> page map -> freeze -> briefs -> audit -> package -> done", async () => {
    const r = await runSim("seo-cocoon", { input, stubs: base(), humans: { scope_freeze: { answer_kind: "approved", answer: "" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("ask_brief chainsmith research boundaries architecture page_map scope_freeze briefs audit package done");
    expect(r.skipped).toEqual(["ask_brief"]);
    expect(out(r)).toMatchObject({
      status: "done",
      clusters: [{ name: "выбор" }, { name: "уход" }],
      page_count: 10,
      briefs_dir: ".agents/seo/kofemashiny",
      audit_status: "pass",
      folder: ".agents/seo/kofemashiny",
      handoff_path: ".agents/seo/kofemashiny/handoff.md",
    });
  });

  it("skips the research subworkflow when research_package_path is given", async () => {
    const r = await runSim("seo-cocoon", {
      input: { ...input, research_package_path: ".agents/seo/research/existing" },
      stubs: base(),
      humans: { scope_freeze: { answer_kind: "approved", answer: "" } },
    });
    expect(r.skipped).toContain("research");
    expect(pathOf(r)).toBe("ask_brief chainsmith research boundaries architecture page_map scope_freeze briefs audit package done");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("a rework audit loops back to architecture once", async () => {
    const r = await runSim("seo-cocoon", {
      input,
      stubs: { ...base(), audit: [{ status: "rework", cannibal_count: 1 }, { status: "pass" }] },
      humans: { scope_freeze: { answer_kind: "approved", answer: "" } },
    });
    expect(pathOf(r)).toBe("ask_brief chainsmith research boundaries architecture page_map scope_freeze briefs audit architecture page_map scope_freeze briefs audit package done");
    expect(out(r)).toMatchObject({ status: "done", audit_status: "pass" });
  });
});

describe("seo graphs: prompt discipline", () => {
  it("no node prompt is longer than 600 characters", async () => {
    const store = await chainStore();
    for (const id of ["seo-research", "seo-brief", "seo-cocoon"]) {
      const workflow = store.get(id)!.workflow;
      for (const node of workflow.nodes) {
        const prompt = "prompt" in node ? String(node.prompt) : "question" in node ? String(node.question) : "";
        expect(prompt.length, `${id}.${node.id}`).toBeLessThanOrEqual(600);
      }
    }
  });
});
