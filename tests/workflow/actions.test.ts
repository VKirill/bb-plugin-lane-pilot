import { describe, expect, it } from "vitest";
import { pureActionExecutor } from "@lane-pilot/workflow-engine";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { REDUCERS } from "@lane-pilot/workflow-engine";
import type { JoinInput } from "@lane-pilot/workflow-engine";

type Row = Record<string, unknown>;
/** Runs a code action the way the engine does: the node lists what it reads, `resolve` answers by reference. */
const act = async (action: string, reads: string[], values: Record<string, unknown>, extra: Row = {}) => {
  const ctx = { node: { type: "action", action, reads, out: [], params: extra }, resolve: (ref: string) => values[ref], template: (value: unknown) => value } as unknown as StepContext;
  return (await pureActionExecutor(action).run(ctx)) as { output: Row; detail?: unknown };
};

describe("items.dedupe", () => {
  it("posts: the same url or text once, the more engaged copy stays, a bare repost goes", async () => {
    const posts = [
      { url: "https://x.com/a/1?s=20", text: "Design systems are boring", likes: 1 },
      { url: "https://x.com/a/1/", text: "Design systems are boring", likes: 40 },
      { url: "https://x.com/b/2", text: "design   systems are boring" },
      { url: "https://x.com/c/3", text: "", is_repost: true },
      { url: "https://x.com/d/4", text: "Tokens first" },
    ];
    const { output } = await act("items.dedupe", ["collect.items"], { "collect.items": posts }, {});
    expect((output.items as Row[]).map((post) => [post.url, post.likes ?? null])).toEqual([["https://x.com/a/1/", 40], ["https://x.com/d/4", null]]);
    expect(output.count).toBe(2);
  });

  it("findings: one place once, overlapping text merged, the higher severity stays", async () => {
    const ctx = { node: { type: "action", action: "items.dedupe", reads: ["scan.findings"], out: [{ name: "findings" }, { name: "merged" }], params: {} }, resolve: () => [
      { file: "a.ts", line: 10, severity: "medium", description: "token compared with ==" },
      { file: "a.ts", line: 10, severity: "high", description: "different words entirely" },
      { file: "b.ts", line: 3, severity: "low", description: "unused variable left in the handler after refactor" },
      { file: "b.ts", line: 9, severity: "low", description: "unused variable left in the handler after refactor of it" },
      { file: "c.ts", line: 1, severity: "info", description: "same text" },
    ], template: (value: unknown) => value } as unknown as StepContext;
    const { output } = (await pureActionExecutor("items.dedupe").run(ctx)) as { output: Row };
    expect((output.findings as Row[]).map((finding) => [finding.file, finding.line, finding.severity])).toEqual([["a.ts", 10, "high"], ["b.ts", 3, "low"], ["c.ts", 1, "info"]]);
    expect(output.merged).toBe(2);
  });
});

describe("dag.validate", () => {
  const sessions = (list: Row[]) => ({ "roadmap.sessions": list });
  it("accepts a DAG where every requirement maps to one session", async () => {
    const { output } = await act("dag.validate", ["roadmap.sessions", "roadmap.requirement_map"], { ...sessions([{ id: "s1", depends_on: [] }, { id: "s2", depends_on: ["s1"] }]), "roadmap.requirement_map": { R1: "s1", R2: ["s2"] } });
    expect(output).toEqual({ ok: true, errors: [], cycles: [] });
  });
  it("names cycles, unknown dependencies and requirements mapped to none or to several", async () => {
    const { output } = await act("dag.validate", ["roadmap.sessions", "roadmap.requirement_map"], { ...sessions([{ id: "s1", depends_on: ["s3"] }, { id: "s2", depends_on: ["s1"] }, { id: "s3", depends_on: ["s2"] }, { id: "s4", depends_on: ["nope"] }]), "roadmap.requirement_map": { R1: [], R2: ["s1", "s2"], R3: "ghost" } });
    expect(output.ok).toBe(false);
    expect(output.cycles).toEqual(["s1>s3>s2>s1"]);
    expect(output.errors).toEqual(expect.arrayContaining(["s4 depends on unknown session nope", "requirement R1 maps to no session", expect.stringContaining("R2 maps to 2 sessions"), "requirement R3 maps to unknown session ghost"]));
  });
});

describe("digest.check", () => {
  const items = [{ url: "https://x.com/a/1", text: "Design systems fail when nobody owns the tokens" }, { url: "https://x.com/b/2", text: "Dark mode is a token problem, not a color problem" }];
  const check = (text: string) => act("digest.check", ["summarize.summary_md", "score.kept"], { "summarize.summary_md": text, "score.kept": items });
  it("passes a digest whose quotes and links come from the items", async () => {
    const { output } = await check("# Digest\n> Design systems fail … nobody owns the tokens\nSee https://x.com/a/1 and «Dark mode is a token problem».");
    expect(output).toEqual({ ok: true, violations: [], parts: 1 });
  });
  it("catches an invented quote, a foreign link, a secret-like string and a long text", async () => {
    const { output } = await check(`"We shipped a design system in a week" https://evil.example/x sk-abcdefghijklmnopqrstuvwxyz0123 ${"word ".repeat(1200)}`);
    expect(output.ok).toBe(false);
    expect(output.violations).toEqual(expect.arrayContaining([expect.stringContaining("quote_not_found:"), "url_unknown:https://evil.example/x", "secret_like:api_key"]));
    expect(output.parts).toBe(2);
  });
});

describe("citations.check", () => {
  const sources = [{ url: "https://a.example" }, { url: "https://b.example" }];
  it("every [n] names a source and every source is cited", async () => {
    expect((await act("citations.check", ["report.report_md", "search.sources"], { "report.report_md": "Claim one [1]. Claim two [2]. A [link](https://c.example).", "search.sources": sources })).output)
      .toEqual({ citation_ok: true, broken: [], unresolved: [] });
    expect((await act("citations.check", ["report.report_md", "search.sources"], { "report.report_md": "Claim [1] and [3].", "search.sources": sources })).output)
      .toEqual({ citation_ok: false, broken: ["[3]"], unresolved: ["[2] https://b.example"] });
  });
});

describe("verdict.aggregate", () => {
  const finding = (severity: string, extra: Row = {}) => ({ id: `${severity}-${Math.random()}`, file: "a.ts", line: 3, severity, evidence: "quoted code that shows the problem", dimension: "correctness", ...extra });
  const run = (values: Row) => act("verdict.aggregate", [], { "dims.findings": [], "confirm.dropped_ids": [], "dims.unchecked": [], "spec_check.unmet_count": 0, ...values });
  it("a critical finding or more than 5 high sends the work back", async () => {
    expect((await run({ "dims.findings": [finding("critical")] })).output).toMatchObject({ status: "rework", critical_count: 1, warn: false });
    expect((await run({ "dims.findings": Array.from({ length: 6 }, () => finding("high")) })).output).toMatchObject({ status: "rework", high_count: 6 });
    expect((await run({ "spec_check.unmet_count": 1 })).output).toMatchObject({ status: "rework" });
  });
  it("one to five high is a pass with a warning; nothing is a plain pass", async () => {
    expect((await run({ "dims.findings": [finding("high"), finding("high"), finding("medium")] })).output).toMatchObject({ status: "pass", warn: true, high_count: 2, remaining_actionable: 2 });
    expect((await run({})).output).toMatchObject({ status: "pass", warn: false, critical_count: 0 });
  });
  it("a serious finding without a line or evidence counts as medium; dropped findings are gone", async () => {
    const weak = finding("critical", { line: null }), shallow = finding("high", { evidence: "x" }), gone = finding("critical", { id: "gone" });
    const { output } = await run({ "dims.findings": [weak, shallow, gone], "confirm.dropped_ids": ["gone"] });
    expect(output).toMatchObject({ status: "pass", critical_count: 0, high_count: 0 });
    expect((output.findings as Row[]).map((item) => item.severity)).toEqual(["medium", "medium"]);
  });
  it("an unchecked dimension with nothing to fix blocks; with findings to fix it is a rework that says so", async () => {
    expect((await run({ "dims.unchecked": ["security"] })).output).toMatchObject({ status: "block", verdict: { status: "block", summary: expect.stringContaining("security") } });
    expect((await run({ "dims.unchecked": ["security"], "dims.findings": [finding("critical")] })).output).toMatchObject({ status: "rework" });
  });
});

describe("lp.propose_workflow", () => {
  it("records the offer in the receipt and renders its inputs", async () => {
    const result = await act("lp.propose_workflow", [], {}, { workflow: "review-fix", inputs: { findings: "x" } });
    expect(result.detail).toEqual({ proposed: "review-fix", inputs: { findings: "x" } });
  });
});

describe("join reducers", () => {
  const rows = (...items: Array<{ item: unknown; data?: Row; error?: string; blocked?: boolean }>): JoinInput => {
    const all: JoinInput["rows"] = items.map((entry, branch) => ({ branch, item: entry.item, ok: entry.data !== undefined, ...(entry.data ? { data: entry.data } : { error: entry.error ?? "x", blocked: entry.blocked ?? false }) }));
    return { rows: all, results: all.filter((row) => row.ok).map((row) => row.data!), failed: all.filter((row) => !row.ok).map((row) => ({ branch: row.branch, item: row.item, error: row.error!, blocked: row.blocked! })), items: all.map((row) => row.item) };
  };
  it("lp.build: accepted, failed and blocked ids, commits and the findings of a failed task", () => {
    const out = REDUCERS["reduce.lp.build.run_tasks"]!(rows(
      { item: { id: "t1" }, data: { state: "accepted", merge_commit: "c1" } },
      { item: { id: "t2" }, data: { state: "failed", verdict: { findings: [{ file: "a", severity: "high" }] } } },
      { item: { id: "t3" }, data: { state: "needs_human" } },
      { item: { id: "t4" }, error: "upstream_blocked:t2", blocked: true },
      { item: { id: "t5" }, error: "boom" },
    ));
    expect(out).toEqual({ accepted_ids: ["t1"], failed_ids: ["t2", "t5"], blocked_ids: ["t3", "t4"], failed_findings: [{ file: "a", severity: "high" }], accepted_count: 1, failed_count: 2, blocked_count: 2, merged_commits: ["c1"] });
  });
  it("lp.review: dimensions stamp finding ids and count by severity; a failed check drops nothing", () => {
    const dims = REDUCERS["reduce.lp.review.dims"]!(rows({ item: "correctness", data: { findings: [{ severity: "critical", file: "a", line: 1, evidence: "e" }] } }, { item: "security", data: { findings: [{ severity: "high", id: "k" }] } }, { item: "performance", error: "down" }));
    expect(dims).toMatchObject({ critical_count: 1, high_count: 1, unchecked: ["performance"] });
    expect((dims.findings as Row[])[1]!.id).toBe("k");
    expect((dims.findings as Row[])[0]!.id).toMatch(/^f:a:1:[a-f0-9]{6}$/);
    expect(REDUCERS["reduce.lp.review.confirm"]!(rows({ item: { id: "k" }, data: { finding_id: "k", confirmed: false } }, { item: { id: "m" }, data: { finding_id: "m", confirmed: true } }, { item: { id: "n" }, error: "down" })))
      .toEqual({ confirmed_ids: ["m", "n"], dropped_ids: ["k"] });
  });
  it("roadmap sessions, brainstorm roles, web search: partial results are named", () => {
    expect(REDUCERS["reduce.roadmap-driven.sessions"]!(rows({ item: { id: "s1" }, data: { status: "done" } }, { item: { id: "s2" }, data: { status: "partial" } }, { item: { id: "s3" }, error: "x" })))
      .toEqual({ done_ids: ["s1"], blocked_ids: ["s2", "s3"], done_count: 1, blocked_count: 2 });
    expect(REDUCERS["reduce.lp.brainstorm.designs"]!(rows({ item: "pm", data: { role: "pm", digest: { a: 1 }, ok: true } }, { item: "ux", data: { role: "ux", ok: false } }, { item: "arch", error: "x" })))
      .toEqual({ digests: [{ a: 1 }], ok_count: 1, failed_roles: ["arch", "ux"] });
    expect(REDUCERS["reduce.web-research.search"]!(rows({ item: "q1", data: { subquestion: "q1", sources: [{ url: "u1" }, { url: "u2" }] } }, { item: "q2", data: { subquestion: "q2", sources: [{ url: "u1" }] } }, { item: "q3", data: { subquestion: "q3", sources: [] } })))
      .toEqual({ sources: [{ url: "u1" }, { url: "u2" }], source_count: 2, unavailable: ["q3"] });
  });
  it("x digest: keeps the posts the scorer kept, matching by item or by batch order", () => {
    const out = REDUCERS["reduce.x-to-telegram-digest.score"]!(rows({ item: [{ url: "p1" }, { url: "p2" }, { url: "p3" }], data: { scores: [{ keep: true, topic: "tokens" }, { keep: false }, { item: { url: "p3" }, keep: true, topic: "tokens" }] } }));
    expect(out).toEqual({ kept: [{ url: "p1" }, { url: "p3" }], topics: ["tokens"], kept_count: 2 });
  });
});
