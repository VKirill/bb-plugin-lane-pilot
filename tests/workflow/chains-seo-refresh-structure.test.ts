import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-page-refresh", () => {
  const input = { site_url: "https://example.ru", url_list: ["/old-page"], mode: "auto" };
  const base = () => ({
    pull: { pull_path: "pull/", urls: 1 },
    diagnose: { diagnosis_path: "diagnosis.md", stage: "ranking" },
    route: { status: "pass", branch: "upgrade", hypothesis_path: "hypothesis.md", url: "/old-page" },
    spec: { spec_path: "spec.md", rewrite_item: "rewrite-item.json" },
    ctr_fix: { fix_path: "fix.md", release_item: "item.json" },
    fact_update: { fix_path: "fix.md", dependent_count: 4, release_item: "item.json" },
    experiment: { experiment_path: "experiment.md", due_date: "2026-12-04" },
    package: { package_path: ".agents/seo/page-refresh/2026-11-06/" },
  });
  const humans = { approve: { answer: "", answer_kind: "approved" } };

  it("upgrade branch: spec -> rewrite item for seo-page -> experiment -> approve -> done", async () => {
    const r = await runSim("seo-page-refresh", { input, stubs: base(), humans });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("pull diagnose route spec experiment approve package done");
    expect(out(r)).toMatchObject({ status: "done", experiment_path: "experiment.md" });
  });

  it("ctr branch fixes the snippet and skips seo-page entirely", async () => {
    const r = await runSim("seo-page-refresh", {
      input,
      stubs: { ...base(), route: { status: "pass", branch: "ctr", hypothesis_path: "hypothesis.md", url: "/old-page" } },
      humans,
    });
    expect(pathOf(r)).toBe("pull diagnose route ctr_fix experiment approve package done");
    expect(r.called("spec")).toEqual([]);
  });

  it("a declined approval emits no release item", async () => {
    const r = await runSim("seo-page-refresh", {
      input,
      stubs: base(),
      humans: { approve: { answer: "", answer_kind: "declined" } },
    });
    expect(pathOf(r)).toBe("pull diagnose route spec experiment approve partial");
    expect(out(r)).toMatchObject({ status: "partial" });
  });
});

describe("seo-structure-audit", () => {
  const input = { site_url: "https://example.ru", mode: "reconstruction" };
  const base = () => ({
    inventory: { registry_path: "registry.csv", urls: 412 },
    quality_cohorts: { defects_path: "defects.md", defect_count: 9 },
    link_graph: { linkgraph_path: "linkgraph.md", orphans: 14 },
    prune_merge: { prune_path: "prune.md", redirects: 6 },
    restructure: { restructure_path: "restructure.md", waves: 2 },
    link_boost: { boost_path: "boost.md", boosted: 5 },
    expansion: { expansion_path: "expansion.md", mvc_packets: ["p1"] },
    critic: { status: "pass", findings: [] },
    "seo-release": { status: "done" },
    package: { report_path: ".agents/seo/structure-audit/2026-11-06/report.md" },
  });
  const humans = { approve: { answer: "", answer_kind: "approved" } };

  it("reconstruction: the full audit, owner approval, then a restructure wave through seo-release", async () => {
    const r = await runSim("seo-structure-audit", { input, stubs: base(), humans });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("inventory quality_cohorts link_graph prune_merge restructure link_boost expansion critic approve release package done");
    expect(r.skipped).toEqual(expect.arrayContaining(["link_boost", "expansion"]));
    expect(r.skipped).not.toContain("release");
    expect(out(r)).toMatchObject({ status: "done", release_status: "done" });
  });

  it("link_boost mode skips the reconstruction nodes and still ships through seo-release", async () => {
    const r = await runSim("seo-structure-audit", { input: { ...input, mode: "link_boost" }, stubs: base(), humans });
    expect(r.skipped).toEqual(expect.arrayContaining(["quality_cohorts", "link_graph", "prune_merge", "restructure", "expansion"]));
    expect(r.skipped).not.toContain("link_boost");
    expect(r.skipped).not.toContain("release");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("a declined approval ships nothing: release is skipped, no wave runs", async () => {
    const r = await runSim("seo-structure-audit", {
      input,
      stubs: base(),
      humans: { approve: { answer: "", answer_kind: "declined" } },
    });
    expect(r.skipped).toContain("release");
    expect(r.called("release")).toEqual([]);
    expect(out(r)).toMatchObject({ status: "partial" });
  });

  it("prunes and 301s never bypass seo-release: the graph has exactly one subworkflow", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-structure-audit")!.workflow;
    const subs = workflow.nodes.filter((node) => node.type === "subworkflow").map((node) => (node as { workflow: string }).workflow);
    expect(subs).toEqual(["seo-release"]);
  });
});
