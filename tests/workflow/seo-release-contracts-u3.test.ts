import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

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
    ["ctr", { fix_path: "ctr-fix.md", release_item: "ctr-item.json" }, "ctr_fix"],
    ["upgrade", { spec_path: "upgrade-spec.md", rewrite_item: "rewrite-item.json" }, "spec"],
    ["fact_update", { fix_path: "fact-fix.md", dependent_count: 2, release_item: "fact-item.json" }, "fact_update"],
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
          expect(ctx.input.with.release_item).toBe(item);
          return { experiment_path: "experiment.md", due_date: "2026-12-04", release_items: [item] };
        },
        package: { package_path: "package/" },
      },
      humans: { approve: { answer: "approved", answer_kind: "approved" } },
    });

    expect(pathOf(result)).toBe(`pull diagnose route ${expectedNode} experiment approve package done`);
    expect(out(result)).toMatchObject({ status: "done", release_items: [item] });
  });

  it("returns no release item when the owner declines the proposed change", async () => {
    const result = await runSim("seo-page-refresh", {
      input: { site_url: "https://example.ru", url_list: ["/old-page"], mode: "auto", fact_revision: "" },
      stubs: {
        pull: { pull_path: "pull.json", urls: 1 },
        diagnose: { diagnosis_path: "diagnosis.md", stage: "ranking" },
        route: { status: "pass", branch: "upgrade", hypothesis_path: "hypothesis.md", url: "/old-page" },
        spec: { spec_path: "upgrade-spec.md", rewrite_item: "rewrite-item.json" },
        experiment: { experiment_path: "experiment.md", due_date: "2026-12-04", release_items: ["rewrite-item.json"] },
        package: { package_path: "package/" },
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
        fact_update: { fix_path: "fact-fix.md", dependent_count: 0, release_item: "" },
        experiment: (ctx) => {
          expect(ctx.input.with.release_item).toBe("");
          return { experiment_path: "experiment.md", due_date: "2026-12-04", release_items: [] };
        },
        package: { package_path: "package/" },
      },
      humans: { approve: { answer: "approved", answer_kind: "approved" } },
    });

    expect(pathOf(result)).toBe("pull diagnose route fact_update experiment approve package done");
    expect(out(result)).toMatchObject({ status: "done", release_items: [] });
  });
});
