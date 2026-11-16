import { describe, expect, it } from "vitest";
import { finding, firstInput, out, pathOf, task } from "./chain-helpers";
import { chainStore, runSim } from "./chain-harness";

/**
 * review591 residual matrix P04-R6: status contracts that must stay honest.
 * - brainstorm-driven / issue-batch: an lp.build `blocked` result must not fall through to `partial`.
 * - grill-plan: `blocked` was declared but unreachable - the enum now matches what the graph can emit.
 * - review-fix: fix_rounds counts the builds that ran; a round-2 block reports the latest review's findings.
 * - todo-add: `line` is a code-owned literal emitted by done after the write, not a model claim.
 * - seo-page: a ready cocoon folder supplies the briefs dir; the locale plan path reaches the writer.
 */

type RawNode = { prompt?: unknown; out?: unknown; skip_out?: Record<string, unknown> };
const nodeOf = async (workflow: string, id: string) => {
  const store = await chainStore();
  const wf = store.get(workflow)!.workflow;
  const node = wf.nodes.find((n) => n.id === id)! as unknown as RawNode;
  return { wf, node };
};

describe("brainstorm-driven: a blocked build stays blocked", () => {
  const input = { goal: "Reminders service", research: false, quality_mode: "standard" };
  const base = () => ({ "lp.brainstorm": { status: "ok", guidance: "G", features: [{ id: "F-001" }] }, "lp.plan": { status: "ok", tasks: [task("b1")] }, "lp.close": { status: "closed" } });

  it("lp.build blocked ends at the blocked emit, not partial", async () => {
    const r = await runSim("brainstorm-driven", { input, stubs: { ...base(), "lp.build": { status: "blocked", merged_commits: [], failed_findings: [finding("high")] } } });
    expect(pathOf(r)).toBe("research brainstorm plan build blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });

  it("a second partial build still falls through to partial after the one replan", async () => {
    const r = await runSim("brainstorm-driven", {
      input,
      stubs: { ...base(), "lp.build": [{ status: "partial", merged_commits: ["b1"] }, { status: "partial", merged_commits: ["b1", "b2"] }], replan: { status: "ok", tasks: [task("b2")] } },
    });
    expect(pathOf(r)).toBe("research brainstorm plan build replan build partial");
    expect(out(r)).toMatchObject({ status: "partial" });
  });

  it("a blocked second build keeps the first build's merges as partial, not blocked", async () => {
    const r = await runSim("brainstorm-driven", {
      input,
      stubs: { ...base(), "lp.build": [{ status: "partial", merged_commits: ["b1"] }, { status: "blocked", merged_commits: [], failed_findings: [finding("high")] }], replan: { status: "ok", tasks: [task("b2")] } },
    });
    expect(pathOf(r)).toBe("research brainstorm plan build replan build partial");
    expect(out(r)).toMatchObject({ status: "partial" });
    expect(out(r)?.merged_commits).toEqual(expect.arrayContaining(["b1"]));
  });
});

describe("issue-batch: a blocked build or failed plan is blocked, not partial", () => {
  const input = { title: "Three small fixes", text: "Typo in the Send button; the header icon color; the login hint." };
  const planned = { "lp.plan": { status: "ok", task_count: 3, tasks: [task("b1"), task("b2"), task("b3")], waves: [["b1", "b2", "b3"]] } };

  it("lp.build blocked ends at the new blocked emit", async () => {
    const r = await runSim("issue-batch", { input, stubs: { ...planned, "lp.build": { status: "blocked", merged_commits: [] } } });
    expect(pathOf(r)).toBe("plan build blocked");
    expect(out(r)).toMatchObject({ status: "blocked", resolution: "open" });
  });

  it("a failed plan ends blocked instead of claiming partial delivery", async () => {
    const r = await runSim("issue-batch", { input, stubs: { "lp.plan": { status: "failed" } } });
    expect(pathOf(r)).toBe("plan blocked");
    expect(out(r)).toMatchObject({ status: "blocked", resolution: "open" });
  });

  it("done and partial builds keep their contracts", async () => {
    const closed = await runSim("issue-batch", { input, stubs: { ...planned, "lp.build": { status: "done", merged_commits: ["b1", "b2", "b3"] } } });
    expect(pathOf(closed)).toBe("plan build closed");
    expect(out(closed)).toMatchObject({ status: "closed", resolution: "fixed" });
    const partial = await runSim("issue-batch", { input, stubs: { ...planned, "lp.build": { status: "partial", merged_commits: ["b1"] } } });
    expect(pathOf(partial)).toBe("plan build partial");
    expect(out(partial)).toMatchObject({ status: "partial", resolution: "open" });
  });
});

describe("grill-plan: the declared status enum matches what the graph emits", () => {
  const input = { goal: "Add Redis cache", plan: "cache GET by URL for 60s" };
  const walked = { branches_walked: 5, questions_without_anchor: 0 };

  it("open questions end open, a clean synthesis ends done, and no path can emit blocked", async () => {
    const open = await runSim("grill-plan", { input, stubs: { walk: walked, synth: { locked: ["GET only"], open: ["invalidation on write"], deferred: [], risk_register: [] } } });
    expect(out(open)).toMatchObject({ status: "open" });
    const done = await runSim("grill-plan", { input, stubs: { walk: walked, synth: { locked: ["GET only"], open: [], deferred: [], risk_register: [] } } });
    expect(out(done)).toMatchObject({ status: "done" });
    const { wf } = await nodeOf("grill-plan", "synth");
    const status = wf.outputs.find((f) => f.name === "status");
    expect(status?.type).toBe("enum");
    expect(status?.values).toEqual(["done", "open"]);
  });
});

describe("review-fix: fix_rounds and blocked findings stay current", () => {
  const input = { goal: "Fix review findings", findings: [finding("high", { file: "src/a.ts" })] };
  const planOk = { "lp.plan": { status: "ok", task_count: 1, tasks: [task("f1")] } };
  const buildOk = { "lp.build": { status: "done", merged_commits: ["f1"] } };

  it("a clean first review reports zero fix rounds and the first review's status", async () => {
    const r = await runSim("review-fix", { input: { goal: "g", findings: [] }, stubs: { "lp.review": { status: "pass", findings: [], remaining_actionable: 0 } } });
    expect(pathOf(r)).toBe("first_review done_first");
    expect(out(r)).toMatchObject({ status: "done", review_status: "pass", fix_rounds: 0 });
  });

  it("one fix round reports one, two rounds report two", async () => {
    const one = await runSim("review-fix", { input, stubs: { ...planOk, ...buildOk, re_review: { status: "pass", findings: [], remaining_actionable: 0 } } });
    expect(out(one)).toMatchObject({ status: "done", fix_rounds: 1 });
    const two = await runSim("review-fix", {
      input,
      stubs: {
        plan_fix: { status: "ok", tasks: [task("f1")] },
        build_fix: { status: "done", merged_commits: ["f1"] },
        re_review: [{ status: "rework", findings: [finding("high", { file: "src/b.ts" })], remaining_actionable: 1 }, { status: "pass", findings: [], remaining_actionable: 0 }],
        plan_fix2: { status: "ok", tasks: [task("f2")] },
        build_fix2: { status: "done", merged_commits: ["f2"] },
      },
    });
    expect(pathOf(two)).toBe("first_review plan_fix build_fix re_review plan_fix2 build_fix2 re_review done");
    expect(out(two)).toMatchObject({ status: "done", review_status: "pass", fix_rounds: 2 });
  });

  it("a round-2 blocked build reports the latest review findings, not the first review's", async () => {
    const r = await runSim("review-fix", {
      input,
      stubs: {
        plan_fix: { status: "ok", tasks: [task("f1")] },
        build_fix: { status: "done", merged_commits: ["f1"] },
        re_review: { status: "rework", findings: [finding("high", { file: "src/b.ts" })], remaining_actionable: 1 },
        plan_fix2: { status: "ok", tasks: [task("f2")] },
        build_fix2: { status: "blocked", merged_commits: [] },
      },
    });
    expect(pathOf(r)).toBe("first_review plan_fix build_fix re_review plan_fix2 build_fix2 blocked_round2");
    expect(out(r)).toMatchObject({ status: "blocked", fix_rounds: 2, remaining: [expect.objectContaining({ file: "src/b.ts" })] });
    expect(out(r)?.merged_commits).toEqual(expect.arrayContaining(["f1"]));
  });

  it("a round-1 blocked build still reports the first review findings", async () => {
    const r = await runSim("review-fix", {
      input,
      stubs: { plan_fix: { status: "ok", tasks: [task("f1")] }, build_fix: { status: "blocked", merged_commits: [] } },
    });
    expect(pathOf(r)).toBe("first_review plan_fix build_fix blocked");
    expect(out(r)).toMatchObject({ remaining: [expect.objectContaining({ file: "src/a.ts" })] });
  });

  it("the classified partial reports the rounds that ran", async () => {
    const r = await runSim("review-fix", {
      input,
      stubs: {
        plan_fix: { status: "ok", tasks: [task("f1")] },
        build_fix: { status: "done", merged_commits: ["f1"] },
        re_review: { status: "rework", findings: [finding("high", { file: "src/b.ts" })], remaining_actionable: 1 },
        plan_fix2: { status: "failed", tasks: [] },
        classify: { remaining: [finding("high", { file: "src/b.ts" })] },
      },
      humans: { ask: { answer_kind: "accept" } },
    });
    expect(pathOf(r)).toBe("first_review plan_fix build_fix re_review plan_fix2 classify ask partial");
    expect(out(r)).toMatchObject({ status: "partial", review_status: "rework", fix_rounds: 1 });
  });
});

describe("todo-add: the confirmation line is code-owned, emitted after the write", () => {
  it("shape does not ask the model for `line`; both paths answer the literal 'todo added'", async () => {
    const { node } = await nodeOf("todo-add", "shape");
    expect(String(node.prompt)).not.toContain("`line`");
    const fields = node.out as { name: string }[];
    expect(fields.map((f) => f.name)).not.toContain("line");
    const skipped = await runSim("todo-add", { input: { title: "Fix flaky test", thought: "fix the flaky payments test" }, stubs: { "fs.write": { todo_path: ".agents/todos/items/x" } } });
    expect(skipped.skipped).toContain("shape");
    expect(out(skipped)).toMatchObject({ status: "done", line: "todo added" });
  });

  it("the shaped path returns the same literal after the writer ran, ignoring any model-supplied line", async () => {
    const r = await runSim("todo-add", {
      input: { thought: "fix the flaky payments test" },
      stubs: { shape: { title: "Fix the flaky payments test", body: "fix the flaky payments test", line: "model claims it worked", priority: "normal" }, "fs.write": { todo_path: ".agents/todos/items/x" } },
    });
    expect(pathOf(r)).toBe("shape write done");
    expect(out(r)).toMatchObject({ status: "done", line: "todo added" });
  });
});

describe("seo-page: a ready cocoon folder still gives the writer its briefs", () => {
  const input = { page_topic: "Установка кондиционеров в квартире", site_goal: "услуги", site_dir: "content/services", geo: "RU" };
  const base = () => ({
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

  it("cocoon_folder without brief_path skips both context nodes and the writer still gets the briefs dir", async () => {
    const r = await runSim("seo-page", { input: { ...input, cocoon_folder: ".agents/seo/ready-cocoon" }, stubs: base() });
    expect(r.skipped).toEqual(expect.arrayContaining(["cocoon", "brief", "locale_plan"]));
    expect(pathOf(r)).toBe("cocoon brief locale_plan write media_brief quality edit meta_schema risk_scan signoff prepublish_qa export indexability_gate goal_check done");
    expect(out(r)).toMatchObject({ status: "done", cocoon_folder: ".agents/seo/ready-cocoon" });
  });

  it("brief_path alone keeps its own skip path", async () => {
    const r = await runSim("seo-page", { input: { ...input, brief_path: ".agents/seo/ready-cocoon/briefs/page.md" }, stubs: base() });
    expect(r.skipped).toEqual(expect.arrayContaining(["cocoon", "brief", "locale_plan"]));
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("the graph wires the cocoon briefs dir and the locale plan into the writer prompt", async () => {
    const { node: cocoon } = await nodeOf("seo-page", "cocoon");
    expect(cocoon.skip_out?.briefs_dir).toBe("{{$inputs.cocoon_folder}}");
    const { node: write } = await nodeOf("seo-page", "write");
    expect(String(write.prompt)).toContain("{{cocoon.briefs_dir}}");
    expect(String(write.prompt)).toContain("{{locale_plan.locale_plan_path}}");
  });
});
