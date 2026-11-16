import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { chainStore, runSim } from "./chain-harness";

describe("U3 SEO release contracts", () => {
  const releaseInput = {
    items: [".agents/seo/release/r1/item.json"],
    mode: "new_batch",
    target: "repo:site",
    url_changes: false,
  };

  const releaseStubs = () => ({
    baseline: { change_log_path: "change-log.json", cohort: "service" },
    plan: { plan_path: "plan.md" },
    premortem: { chains_over_1_hop: 0, loops: 0, top_url_changes: 0, report_path: "premortem.json" },
    staging_qa: { status: "pass", qa_path: "staging-qa.md" },
    publish: { publish_status: "ok" },
    prod_qa: { status: "pass" },
    submit: { submit_path: "submit.md", requested: 1 },
    indexnow: { pushed: 1, engines: ["yandex"], receipt_path: "indexnow.json" },
    lock_release: { intents: 0, locks_created: 1 },
    index_check: { index_status_path: "index-status.json", not_indexed: [] },
    package: { release_report_path: "release-report.md" },
    index_check_only: { index_status_path: "index-status.json", not_indexed: [] },
    package_check: { release_report_path: "index-check.md" },
  });

  it("persists producer-owned arrays as JSON package files, independent of experiment output", async () => {
    const workflow = (await chainStore()).get("seo-page-refresh")!.workflow;
    const node = (id: string) => workflow.nodes.find((candidate) => candidate.id === id) as { params?: Record<string, unknown>; map?: Record<string, unknown> };
    expect(node("package_ctr").params?.["release-items.json"]).toBe("{{ctr_fix.release_items}}");
    expect(node("package_fact").params?.["release-items.json"]).toBe("{{fact_update.release_items}}");
    expect(node("package_upgrade").params?.["release-items.json"]).toEqual([]);
    expect(node("package_upgrade").params?.["rewrite-items.json"]).toBe("{{spec.rewrite_items}}");
    expect(node("package_split").params?.["release-items.json"]).toEqual([]);
    expect(node("package_split").params?.["rewrite-items.json"]).toBe("{{spec.rewrite_items}}");
    expect(node("done_ctr").map).toMatchObject({ release_items: "{{ctr_fix.release_items}}", rewrite_items: [] });
    expect(node("done_fact").map).toMatchObject({ release_items: "{{fact_update.release_items}}", rewrite_items: [] });
    expect(node("done_upgrade").map).toMatchObject({ release_items: [], rewrite_items: "{{spec.rewrite_items}}" });
    expect(node("done_split").map).toMatchObject({ release_items: [], rewrite_items: "{{spec.rewrite_items}}" });
  });

  it("routes a normal owner timeout to blocked, never to the index-check receipt", async () => {
    const result = await runSim("seo-release", {
      input: releaseInput,
      stubs: releaseStubs(),
      humans: { owner_go: { answer: "", answer_kind: "timeout" } },
    });

    expect(pathOf(result)).toBe("baseline plan redirects premortem staging_qa owner_go blocked");
    expect(result.called("done_check")).toEqual([]);
    expect(out(result)).toMatchObject({ status: "blocked" });
  });

  it("keeps the scheduled index-check fallback when owner_go is skipped", async () => {
    const result = await runSim("seo-release", {
      input: { ...releaseInput, mode: "index_check" },
      stubs: releaseStubs(),
    });

    expect(pathOf(result)).toBe("baseline plan redirects premortem staging_qa owner_go index_check_only package_check done_check");
    expect(result.skipped).toEqual(expect.arrayContaining(["owner_go"]));
    expect(out(result)).toMatchObject({ status: "done", index_status_path: "index-status.json" });
  });

  it.each([
    ["ctr", { fix_path: "ctr-fix.md", release_items: ["ctr-item.json"] }, "ctr_fix"],
    ["upgrade", { spec_path: "upgrade-spec.md", rewrite_items: ["rewrite-item.json"] }, "spec"],
    ["fact_update", { fix_path: "fact-fix.md", dependent_count: 2, release_items: ["fact-item.json"] }, "fact_update"],
  ] as const)("collects the %s branch's actual release item", async (branch, branchReply, expectedNode) => {
    const item = branch === "upgrade" ? "rewrite-item.json" : `${branch === "ctr" ? "ctr" : "fact"}-item.json`;
    const result = await runSim("seo-page-refresh", {
      input: { site_url: "https://example.ru", url_list: ["/old-page"], mode: "auto", fact_revision: "" },
      stubs: {
        pull: { pull_path: "pull.json", urls: 1 },
        diagnose: { diagnosis_path: "diagnosis.md", stage: "ranking" },
        route: { status: "pass", branch, hypothesis_path: "hypothesis.md", url: "/old-page" },
        [expectedNode]: branchReply,
        experiment: (ctx) => {
          const branchItems = branch === "upgrade" ? ["rewrite-item.json"] : [item];
          const incoming = branch === "upgrade" ? ctx.input.with.rewrite_items : ctx.input.with.release_items;
          expect(incoming).toEqual(branchItems);
          return { experiment_path: "experiment.md", due_date: "2026-12-04", release_items: ["foreign-model-item.json"] };
        },
        [`package_${branch === "ctr" ? "ctr" : branch === "fact_update" ? "fact" : "upgrade"}`]: { package_path: "package/" },
      },
      humans: { approve: { answer: "approved", answer_kind: "approved" } },
    });

    const packageNode = branch === "ctr" ? "package_ctr" : branch === "fact_update" ? "package_fact" : "package_upgrade";
    const doneNode = branch === "ctr" ? "done_ctr" : branch === "fact_update" ? "done_fact" : "done_upgrade";
    expect(pathOf(result)).toBe(`pull diagnose route ${expectedNode} experiment approve ${packageNode} ${doneNode}`);
    expect(out(result)).toMatchObject({
      status: "done",
      release_items: branch === "upgrade" ? [] : [item],
      rewrite_items: branch === "upgrade" ? ["rewrite-item.json"] : [],
    });
  });

  it("returns no release item when the owner declines the proposed change", async () => {
    const result = await runSim("seo-page-refresh", {
      input: { site_url: "https://example.ru", url_list: ["/old-page"], mode: "auto", fact_revision: "" },
      stubs: {
        pull: { pull_path: "pull.json", urls: 1 },
        diagnose: { diagnosis_path: "diagnosis.md", stage: "ranking" },
        route: { status: "pass", branch: "upgrade", hypothesis_path: "hypothesis.md", url: "/old-page" },
        spec: { spec_path: "upgrade-spec.md", rewrite_items: ["rewrite-item.json"] },
        experiment: { experiment_path: "experiment.md", due_date: "2026-12-04", release_items: ["foreign-model-item.json"] },
        package_upgrade: { package_path: "package/" },
      },
      humans: { approve: { answer: "declined", answer_kind: "declined" } },
    });

    expect(pathOf(result)).toBe("pull diagnose route spec experiment approve partial");
    expect(out(result)).toMatchObject({ status: "partial", release_items: [] });
  });

  it("does not fabricate an item when the selected branch produces none", async () => {
    const result = await runSim("seo-page-refresh", {
      input: { site_url: "https://example.ru", url_list: ["/old-page"], mode: "auto", fact_revision: "" },
      stubs: {
        pull: { pull_path: "pull.json", urls: 1 },
        diagnose: { diagnosis_path: "diagnosis.md", stage: "ranking" },
        route: { status: "pass", branch: "fact_update", hypothesis_path: "hypothesis.md", url: "/old-page" },
        fact_update: { fix_path: "fact-fix.md", dependent_count: 0, release_items: [] },
        experiment: (ctx) => {
          expect(ctx.input.with.release_items).toEqual([]);
          return { experiment_path: "experiment.md", due_date: "2026-12-04", release_items: ["foreign-model-item.json"] };
        },
        package_fact: { package_path: "package/" },
      },
      humans: { approve: { answer: "approved", answer_kind: "approved" } },
    });

    expect(pathOf(result)).toBe("pull diagnose route fact_update experiment approve package_fact done_fact");
    expect(out(result)).toMatchObject({ status: "done", release_items: [] });
  });
});
