import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-trust", () => {
  const input = { project_passport_path: ".agents/seo/site/passport.json", brandcore_path: ".agents/seo/site/brandcore.md", run_gbp: true, recovery: false };
  const base = () => ({
    trust_nodes: { trust_specs_path: "trust-specs.md", spec_paths: ["about", "editorial-policy"], org_graph_path: "org-graph.json" },
    authors: { author_specs_path: "author-specs.md", spec_paths: ["authors/ivan"] },
    footprint: { footprint_path: "entity-footprint.md", remediation_path: "remediation.md" },
    eeat: { status: "pass", eeat_path: "eeat-audit.md" },
    gbp: { gbp_report_path: "gbp-report.md", drafts_path: "gbp-drafts.md" },
    gbp_apply: { applied_count: 2, apply_path: "gbp-applied.md" },
    "trust_pages:child": { status: "done", site_page_path: "content/pages/about.md" },
    "author_pages:child": { status: "done", site_page_path: "content/pages/authors-ivan.md" },
    package: { package_path: ".agents/seo/trust/r1/" },
    goal_check: { ok: true },
  });
  const humans = { intake: { answer_kind: "given", answer: "данные приложены" }, send_ok: { answer_kind: "approve", answer: "публикуй" } };

  it("happy path: intake -> specs -> footprint -> eeat -> gbp drafts -> owner ok -> apply -> pages -> done", async () => {
    const r = await runSim("seo-trust", { input, stubs: base(), humans });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("intake trust_nodes authors footprint eeat recovery gbp send_ok gbp_apply trust_pages author_pages package goal_check done");
    expect(r.skipped).toEqual(expect.arrayContaining(["recovery"]));
    expect(out(r)).toMatchObject({ status: "done", trust_specs_path: "trust-specs.md", eeat_path: "eeat-audit.md" });
  });

  it("run_gbp=false skips the GBP branch entirely and still finishes", async () => {
    const r = await runSim("seo-trust", { input: { ...input, run_gbp: false }, stubs: base(), humans: { intake: humans.intake } });
    expect(pathOf(r)).toBe("intake trust_nodes authors footprint eeat recovery gbp send_ok trust_pages author_pages package goal_check done");
    expect(r.skipped).toEqual(expect.arrayContaining(["gbp", "send_ok", "recovery"]));
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("nothing is posted without the owner's word: gbp_apply's only incoming edge is send_ok", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-trust")!.workflow;
    const into = workflow.edges.filter((edge) => edge.to === "gbp_apply").map((edge) => edge.from);
    expect(into).toEqual(["send_ok"]);
  });

  it("owner decline keeps drafts unposted and still builds the pages", async () => {
    const r = await runSim("seo-trust", { input, stubs: base(), humans: { intake: humans.intake, send_ok: { answer_kind: "decline", answer: "не публиковать" } } });
    expect(pathOf(r)).toBe("intake trust_nodes authors footprint eeat recovery gbp send_ok trust_pages author_pages package goal_check done");
    expect(pathOf(r)).not.toContain("gbp_apply");
    expect(out(r)).toMatchObject({ status: "done" });
  });
});
