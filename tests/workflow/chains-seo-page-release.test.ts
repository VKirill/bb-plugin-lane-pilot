import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-page v2", () => {
  const input = { page_topic: "Установка кондиционеров в квартире", site_goal: "услуги", site_dir: "content/services", geo: "RU" };
  const base = () => ({
    "seo-cocoon": { status: "done", folder: ".agents/seo/conditioners", handoff_path: ".agents/seo/conditioners/handoff.md", briefs_dir: ".agents/seo/conditioners/briefs" },
    "seo-brief": { status: "done", brief_path: ".agents/seo/conditioners/briefs/page.md" },
    write: { ok: true, raw_page_path: ".agents/seo/conditioners/page_raw.md", word_count: 1200, status: "done" },
    media_brief: { media_path: ".agents/seo/conditioners/media.md" },
    quality: { status: "pass", findings: [] },
    edit: { status: "pass", clean_page_path: ".agents/seo/conditioners/page_clean.md", ru_score: 9, issues: [] },
    meta_schema: { meta_path: ".agents/seo/conditioners/meta.json" },
    risk_scan: { queue_count: 0, risk_queue: [] },
    prepublish_qa: { status: "pass", qa_path: ".agents/seo/conditioners/qa.md" },
    export: { ok: true, site_page_path: "content/services/ustanovka-kondicionerov.md", release_item: ".agents/seo/conditioners/release-item.json", status: "done" },
    indexability_gate: { status: "pass", gate_path: ".agents/seo/conditioners/indexability.md" },
  });

  it("happy path keeps today's output keys", async () => {
    const r = await runSim("seo-page", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("cocoon brief locale_plan write media_brief quality edit meta_schema risk_scan signoff prepublish_qa export indexability_gate goal_check done");
    expect(out(r)).toMatchObject({ status: "done", site_page_path: "content/services/ustanovka-kondicionerov.md", clean_page_path: ".agents/seo/conditioners/page_clean.md", cocoon_folder: ".agents/seo/conditioners", ru_score: 9 });
  });

  it("skips cocoon and brief when cocoon_folder and brief_path are given", async () => {
    const r = await runSim("seo-page", {
      input: { ...input, cocoon_folder: ".agents/seo/done-cocoon", brief_path: ".agents/seo/done-cocoon/briefs/page.md" },
      stubs: base(),
    });
    expect(r.skipped).toEqual(expect.arrayContaining(["cocoon", "brief"]));
    expect(pathOf(r)).toBe("cocoon brief locale_plan write media_brief quality edit meta_schema risk_scan signoff prepublish_qa export indexability_gate goal_check done");
    expect(out(r)).toMatchObject({ status: "done", cocoon_folder: ".agents/seo/done-cocoon" });
  });

  it("declined sign-off blocks the page before QA", async () => {
    const r = await runSim("seo-page", {
      input: { ...input, risk_tier: "ymyl" },
      stubs: { ...base(), risk_scan: { queue_count: 2, risk_queue: ["claim-a", "claim-b"] } },
      humans: { signoff: { answer_kind: "declined", answer: "нет" } },
    });
    expect(pathOf(r)).toBe("cocoon brief locale_plan write media_brief quality edit meta_schema risk_scan signoff blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});

describe("seo-release", () => {
  const input = { items: [".agents/seo/conditioners/release-item.json"], mode: "new_batch", target: "repo:site", url_changes: false };
  const base = () => ({
    baseline: { change_log_path: "change-log.json", cohort: "service" },
    plan: { plan_path: "plan.md" },
    premortem: { chains_over_1_hop: 0, loops: 0, top_url_changes: 0, report_path: "premortem.json" },
    staging_qa: { status: "pass", qa_path: "staging-qa.md" },
    publish: { publish_status: "ok" },
    prod_qa: { status: "pass" },
    submit: { submit_path: "submit.md", requested: 3 },
    indexnow: { pushed: 3, engines: ["yandex", "bing"], receipt_path: "indexnow.json" },
    lock_release: { intents: 0, locks_created: 3 },
    index_check: { index_status_path: "index-status.json", not_indexed: [] },
    package: { release_report_path: ".agents/seo/release/r1/release-report.md" },
    index_check_only: { index_status_path: "index-status.json", not_indexed: [] },
    package_check: { release_report_path: ".agents/seo/release/r1/index-check.md" },
  });

  it("happy path: baseline -> plan -> (redirects skipped) -> premortem -> staging -> owner go -> publish -> prod QA -> submit -> indexnow -> lock -> index check -> done", async () => {
    const r = await runSim("seo-release", { input, stubs: base(), humans: { owner_go: { answer_kind: "approve", answer: "да" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("baseline plan redirects premortem staging_qa owner_go publish prod_qa submit indexnow lock_release index_check package done");
    expect(r.skipped).toEqual(["redirects"]);
    expect(out(r)).toMatchObject({ status: "done", change_log_path: "change-log.json", index_status_path: "index-status.json", indexnow_pushed: 3 });
  });

  it("premortem redirect loop blocks the release before staging QA", async () => {
    const r = await runSim("seo-release", {
      input,
      stubs: { ...base(), premortem: { chains_over_1_hop: 2, loops: 1, top_url_changes: 0, report_path: "premortem.json" } },
    });
    expect(pathOf(r)).toBe("baseline plan redirects premortem blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });

  it("owner decline stops the run before publish", async () => {
    const r = await runSim("seo-release", { input, stubs: base(), humans: { owner_go: { answer_kind: "decline", answer: "не публиковать" } } });
    expect(pathOf(r)).toBe("baseline plan redirects premortem staging_qa owner_go blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });

  it("index_check mode skips the publish path and runs index_check_only", async () => {
    const r = await runSim("seo-release", { input: { ...input, mode: "index_check" }, stubs: base() });
    expect(pathOf(r)).toBe("baseline plan redirects premortem staging_qa owner_go index_check_only package_check done_check");
    expect(r.skipped).toEqual(expect.arrayContaining(["baseline", "plan", "redirects", "premortem", "staging_qa", "owner_go"]));
    expect(out(r)).toMatchObject({ status: "done", index_status_path: "index-status.json" });
  });

  it("publish has no incoming edge except from owner_go", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-release")!.workflow;
    const into = workflow.edges.filter((edge) => edge.to === "publish").map((edge) => edge.from);
    expect(into).toEqual(["owner_go"]);
  });
});
