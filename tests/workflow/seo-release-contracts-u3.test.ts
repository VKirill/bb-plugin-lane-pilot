import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { out, pathOf } from "./chain-helpers";
import { chainStore, runSim } from "./chain-harness";
import { chain, reply, runHomeWorld } from "./run-home-world";
import type { Row } from "./run-home-world";

const packageGraph = async (sourceId: "ctr_fix" | "spec", packageId: "package_ctr" | "package_upgrade" | "package_split", sourceOutput: Row, packagePath?: string) => {
  const shipped = (await chainStore()).get("seo-page-refresh")!.workflow;
  const route = shipped.nodes.find((node) => node.id === "route")!;
  const diagnose = shipped.nodes.find((node) => node.id === "diagnose")!;
  const source = shipped.nodes.find((node) => node.id === sourceId)!;
  const experiment = shipped.nodes.find((node) => node.id === "experiment")!;
  const shippedPackage = shipped.nodes.find((node) => node.id === packageId)!;
  const packageNode = packagePath
    ? { ...shippedPackage, params: { ...((shippedPackage as { params?: Row }).params ?? {}), path: packagePath } }
    : shippedPackage;
  return {
    workflow: chain({
      id: `seo-page-refresh-${packageId.replaceAll("_", "-")}-real`,
      outputs: [
        { name: "status", type: "string", required: false },
        { name: "package_path", type: "string", required: false },
        { name: "release_items", type: "array", required: false },
        { name: "rewrite_items", type: "array", required: false },
      ],
      nodes: [
        route,
        diagnose,
        source,
        experiment,
        packageNode,
        { id: "done", type: "action", action: "emit", map: {
          status: "done",
          package_path: `${packageId}.package_path`,
          release_items: sourceId === "ctr_fix" ? `{{${sourceId}.release_items}}` : [],
          rewrite_items: sourceId === "spec" ? `{{${sourceId}.rewrite_items}}` : [],
        } },
      ],
      edges: [
        { from: "start", to: "route", pass: "artifact" },
        { from: "route", to: "diagnose", pass: "artifact" },
        { from: "diagnose", to: sourceId, pass: "artifact", when: sourceId === "ctr_fix" ? "route.branch == 'ctr'" : `route.branch == '${packageId === "package_split" ? "split" : "upgrade"}'` },
        { from: sourceId, to: "experiment", pass: "artifact", with: sourceId === "ctr_fix"
          ? { release_items: `${sourceId}.release_items` }
          : { rewrite_items: `${sourceId}.rewrite_items` } },
        { from: "experiment", to: packageId, pass: "artifact" },
        { from: packageId, to: "done", pass: "artifact" },
      ],
    }),
    sourceOutput,
    experimentOutput: { experiment_path: "experiment.md", due_date: "2026-12-04", release_items: ["foreign-model-item.json"], handoff: "experiment complete" },
  };
};

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
    expect(node("package_ctr").params?.contents).toMatchObject({ "release-items.json": "{{ctr_fix.release_items}}", "rewrite-items.json": [] });
    expect(node("package_fact").params?.contents).toMatchObject({ "release-items.json": "{{fact_update.release_items}}", "rewrite-items.json": [] });
    expect(node("package_upgrade").params?.contents).toMatchObject({ "release-items.json": [], "rewrite-items.json": "{{spec.rewrite_items}}" });
    expect(node("package_split").params?.contents).toMatchObject({ "release-items.json": [], "rewrite-items.json": "{{spec.rewrite_items}}" });
    expect((await chainStore()).get("seo-page-refresh")!.workflow.nodes.find((candidate) => candidate.id === "experiment")).not.toMatchObject({ out: expect.arrayContaining([expect.objectContaining({ name: "release_items" })]) });
    expect(node("done_ctr").map).toMatchObject({ release_items: "{{ctr_fix.release_items}}", rewrite_items: [] });
    expect(node("done_fact").map).toMatchObject({ release_items: "{{fact_update.release_items}}", rewrite_items: [] });
    expect(node("done_upgrade").map).toMatchObject({ release_items: [], rewrite_items: "{{spec.rewrite_items}}" });
    expect(node("done_split").map).toMatchObject({ release_items: [], rewrite_items: "{{spec.rewrite_items}}" });
  });

  it("runs the shipped CTR package node through real fs.write and persists an exact JSON list", async () => {
    const graph = await packageGraph("ctr_fix", "package_ctr", { fix_path: "ctr-fix.md", release_items: [".agents/seo/release/ctr-item.json"], handoff: "CTR fix complete" });
    const world = await runHomeWorld({
      route: [reply({ status: "pass", branch: "ctr", hypothesis_path: "hypothesis.md", url: "/old-page", handoff: "route complete" })],
      diagnose: [reply({ diagnosis_path: "diagnosis.md", stage: "ranking", handoff: "diagnosis complete" })],
      ctr_fix: [reply(graph.sourceOutput)],
      experiment: [reply(graph.experimentOutput)],
    });
    try {
      const result = await world.start(graph.workflow).done;
      expect(result.status, result.error ?? "no error").toBe("succeeded");
      const packagePath = String(result.output?.package_path);
      const releaseFile = join(world.checkout, packagePath, "release-items.json");
      const rewriteFile = join(world.checkout, packagePath, "rewrite-items.json");
      expect(JSON.parse(readFileSync(releaseFile, "utf8"))).toEqual([".agents/seo/release/ctr-item.json"]);
      expect(JSON.parse(readFileSync(rewriteFile, "utf8"))).toEqual([]);
      expect(readFileSync(releaseFile, "utf8")).not.toContain("{{");
      expect(readFileSync(releaseFile, "utf8")).not.toContain("# SEO page refresh");
    } finally {
      world.dispose();
    }
  });

  it.each([
    ["package_upgrade", ["rewrite-spec.json"]],
    ["package_split", ["split-spec.json"]],
  ] as const)("runs the shipped %s package node through real fs.write and keeps rewrite specs out of release-items.json", async (packageId, rewriteItems) => {
    const graph = await packageGraph("spec", packageId, { spec_path: "spec.md", rewrite_items: rewriteItems, handoff: "rewrite spec complete" });
    const world = await runHomeWorld({
      route: [reply({ status: "pass", branch: packageId === "package_split" ? "split" : "upgrade", hypothesis_path: "hypothesis.md", url: "/old-page", handoff: "route complete" })],
      diagnose: [reply({ diagnosis_path: "diagnosis.md", stage: "ranking", handoff: "diagnosis complete" })],
      spec: [reply(graph.sourceOutput)],
      experiment: [reply(graph.experimentOutput)],
    });
    try {
      const result = await world.start(graph.workflow).done;
      expect(result.status, result.error ?? "no error").toBe("succeeded");
      const packagePath = String(result.output?.package_path);
      expect(JSON.parse(readFileSync(join(world.checkout, packagePath, "release-items.json"), "utf8"))).toEqual([]);
      expect(JSON.parse(readFileSync(join(world.checkout, packagePath, "rewrite-items.json"), "utf8"))).toEqual(rewriteItems);
    } finally {
      world.dispose();
    }
  });

  it("rejects a failed shipped package write that escapes the checkout", async () => {
    const graph = await packageGraph("ctr_fix", "package_ctr", { fix_path: "ctr-fix.md", release_items: ["ctr-item.json"], handoff: "CTR fix complete" }, "../escape/");
    const world = await runHomeWorld({
      route: [reply({ status: "pass", branch: "ctr", hypothesis_path: "hypothesis.md", url: "/old-page", handoff: "route complete" })],
      diagnose: [reply({ diagnosis_path: "diagnosis.md", stage: "ranking", handoff: "diagnosis complete" })],
      ctr_fix: [reply(graph.sourceOutput)],
      experiment: [reply(graph.experimentOutput)],
    });
    try {
      const result = await world.start(graph.workflow).done;
      expect(result.status, result.error ?? "no error").toBe("failed");
      expect(result.error).toContain("not inside the checkout");
    } finally {
      world.dispose();
    }
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
