import { describe, expect, it } from "vitest";
import { PLAN_INLINE_BYTES, callersBlock, critiquePrompt } from "../../src/rooms/critique/critique";
import { callerLabels } from "../../src/rooms/critique/critique-coverage";
import type { CoverageFinding } from "../../src/rooms/critique/critique-coverage";
import { inlinePlanFile } from "../../src/rooms/critique/server/critique-runs/plan-text";

const bbWith = (files: Record<string, string>) => ({ sdk: { files: { read: async ({ path }: { path: string }) => {
  if (!(path in files)) throw Object.assign(new Error("not found"), { code: "not_found", status: 404 });
  return { content: files[path], contentEncoding: "utf8" };
} } } }) as never;

describe("the plan file inlined for the plan critic", () => {
  const plan = "/repo/.agents/plans/x.md";
  it("reads a single path under the project and keeps the sha256 of the whole file", async () => {
    const got = await inlinePlanFile(bbWith({ [plan]: "# Plan\nstep 1" }), { hostId: "h", projectCwd: "/repo", plan });
    expect(got?.inlined).toEqual({ path: plan, text: "# Plan\nstep 1", truncated: false });
    expect(got?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const relative = await inlinePlanFile(bbWith({ [plan]: "# Plan" }), { hostId: "h", projectCwd: "/repo", plan: ".agents/plans/x.md" });
    expect(relative?.inlined.path).toBe(plan);
  });
  it("cuts a long plan at the cap but hashes all of it", async () => {
    const text = "line of plan\n".repeat(2000);
    const got = await inlinePlanFile(bbWith({ [plan]: text }), { hostId: "h", projectCwd: "/repo", plan });
    expect(got?.inlined.truncated).toBe(true);
    expect(Buffer.byteLength(got!.inlined.text)).toBeLessThanOrEqual(PLAN_INLINE_BYTES);
    const prompt = critiquePrompt({ plan, task: {}, planText: got!.inlined });
    expect(prompt).toContain(`CANONICAL PLAN:\n\n${plan}`);
    expect(prompt).toContain(`[… plan cut at ${PLAN_INLINE_BYTES} bytes; read the rest in ${plan}]`);
  });
  it("leaves prose, a path outside the project and a missing file as they are", async () => {
    const bb = bbWith({ [plan]: "x", "/other/plan.md": "x" });
    expect(await inlinePlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "Step 1: do it\nStep 2: more" })).toBeNull();
    expect(await inlinePlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "/other/plan.md" })).toBeNull();
    expect(await inlinePlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "../other/plan.md" })).toBeNull();
    expect(await inlinePlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "/repo/.agents/plans/missing.md" })).toBeNull();
    expect(critiquePrompt({ plan: "Step 1", task: {} })).not.toContain("plan cut");
  });
  it("puts the plan text after the path line", () => {
    const prompt = critiquePrompt({ plan, task: {}, planText: { path: plan, text: "THE TEXT OF THE PLAN", truncated: false } });
    expect(prompt.indexOf(plan, prompt.indexOf("CANONICAL PLAN:"))).toBeLessThan(prompt.indexOf("THE TEXT OF THE PLAN"));
  });
});

describe("the callers block of the plan critic", () => {
  const callers = [{ file: "src/a.ts", symbol: "doIt", callers: ["src/x.ts:run", "src/y.ts:go", "src/z.ts:also", "src/q.ts:q", "src/w.ts:w"], total: 8 }];
  const gap = (code: CoverageFinding["code"], path: string): CoverageFinding => ({ code, path, severity: "warning", finding: `${path} is not owned` });
  it("lists up to 5 callers per symbol with the count of the rest, and marks one no task owns", () => {
    const block = callersBlock(callers, new Set(["src/y.ts"]));
    expect(block).toBe("- src/a.ts#doIt: src/x.ts:run, src/y.ts:go (no task owns it), src/z.ts:also, src/q.ts:q, src/w.ts:w (+3 more)");
    expect(callersBlock(undefined)).toBe("");
  });
  it("is in the prompt and replaces the separate gaps it covers, keeping the others", () => {
    const findings = [gap("caller_unowned", "src/y.ts"), gap("owns_gap", "src/x.ts"), gap("owns_gap", "src/sibling.test.ts"), gap("owns_empty", "tasks/t")];
    const prompt = critiquePrompt({ plan: "p", task: {}, structuralFindings: findings, callers });
    expect(prompt).toContain("Callers of what the plan changes");
    expect(prompt).toContain("src/y.ts:go (no task owns it)");
    const sent = prompt.slice(prompt.indexOf("Deterministic structural findings"));
    expect(sent).not.toContain('"path":"src/y.ts"');
    expect(sent).not.toContain('"path":"src/x.ts"');
    expect(sent).toContain("src/sibling.test.ts");
    expect(sent).toContain("owns_empty");
    // without a block every gap is sent as before
    expect(critiquePrompt({ plan: "p", task: {}, structuralFindings: findings })).toContain('"path":"src/y.ts"');
  });
  it("reads the direct callers of a graph answer as file:symbol", () => {
    expect(callerLabels({ byDepth: { "1": [{ name: "run", filePath: "src/x.ts" }, { name: "go", filePath: "/repo/src/y.ts" }, { name: "out", filePath: "../elsewhere.ts" }, { filePath: "src/n.ts" }] } }, "/repo"))
      .toEqual(["src/x.ts:run", "src/y.ts:go", "src/n.ts"]);
    expect(callerLabels({}, "/repo")).toEqual([]);
  });
});
