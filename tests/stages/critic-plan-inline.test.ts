import { describe, expect, it } from "vitest";
import { callerLabels, callersBlock, critiquePacketPrompt, critiquePrompt } from "../../src/rooms/critique";
import type { CoverageFinding } from "../../src/rooms/critique";
import { readPlanFile } from "../../src/rooms/critique/server";
import { planPacket } from "@lane-pilot/workflow-engine";
import { sha256Hex } from "@lane-pilot/kit";

const bbWith = (files: Record<string, string>) => ({ sdk: { files: { read: async ({ path }: { path: string }) => {
  if (!(path in files)) throw Object.assign(new Error("not found"), { code: "not_found", status: 404 });
  const content = files[path]!;
  return { content, contentEncoding: "utf8", sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content, "utf8") };
} } } }) as never;

describe("the plan file read whole for the plan critic", () => {
  const plan = "/repo/.agents/plans/x.md";
  it("reads a single path under the project and returns the whole text with the sha256", async () => {
    const got = await readPlanFile(bbWith({ [plan]: "# Plan\nstep 1" }), { hostId: "h", projectCwd: "/repo", plan });
    expect(got).toEqual({ path: plan, text: "# Plan\nstep 1", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const relative = await readPlanFile(bbWith({ [plan]: "# Plan" }), { hostId: "h", projectCwd: "/repo", plan: ".agents/plans/x.md" });
    expect(relative?.path).toBe(plan);
  });
  it("never cuts a long plan: the whole text and its hash come back", async () => {
    const text = "line of plan\n".repeat(2000);
    const got = await readPlanFile(bbWith({ [plan]: text }), { hostId: "h", projectCwd: "/repo", plan });
    expect(got?.text).toBe(text);
    expect(got?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("leaves prose as prose and names every explicit-path failure", async () => {
    const bb = bbWith({ [plan]: "x", "/other/plan.md": "x" });
    expect(await readPlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "Step 1: do it\nStep 2: more" })).toBeNull();
    expect(await readPlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "fix the footer in src/app.tsx" })).toBeNull();
    await expect(readPlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "/other/plan.md" })).rejects.toThrow("plan_path_outside_project");
    await expect(readPlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "../other/plan.md" })).rejects.toThrow("plan_path_outside_project");
    await expect(readPlanFile(bb, { hostId: "h", projectCwd: "/repo", plan: "/repo/.agents/plans/missing.md" })).rejects.toThrow("plan_file_unreadable");
    expect(critiquePrompt({ plan: "Step 1", task: {} })).not.toContain("plan cut");
  });
  it("refuses a read it cannot prove whole: no size/hash, a size mismatch, or a hash mismatch", async () => {
    const text = "whole plan\n";
    const base = { content: text, contentEncoding: "utf8" };
    const noProof = { sdk: { files: { read: async () => base } } } as never;
    await expect(readPlanFile(noProof, { hostId: "h", projectCwd: "/repo", plan: "/repo/p.md" })).rejects.toThrow("plan_file_unverifiable");
    const truncated = { sdk: { files: { read: async () => ({ ...base, sha256: sha256Hex(text), sizeBytes: Buffer.byteLength(text) + 100 }) } } } as never;
    await expect(readPlanFile(truncated, { hostId: "h", projectCwd: "/repo", plan: "/repo/p.md" })).rejects.toThrow("plan_file_truncated");
    const corrupt = { sdk: { files: { read: async () => ({ ...base, sha256: "0".repeat(64), sizeBytes: Buffer.byteLength(text) }) } } } as never;
    await expect(readPlanFile(corrupt, { hostId: "h", projectCwd: "/repo", plan: "/repo/p.md" })).rejects.toThrow("plan_file_hash_mismatch");
  });
});

describe("the critic's prepared packet", () => {
  it("keeps a small task inline and bounds a large one to references, data not instructions", () => {
    const small = planPacket({ step: { id: "plan-critique", role: "plan-critic", mode: "standard" }, inputs: [{ name: "task", value: { title: "t" } }, { name: "plan", value: "do the thing" }], chatId: "", runId: "run-1" });
    expect(small.files).toEqual([]);
    const prompt = critiquePacketPrompt({ packet: small.packet });
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain('status ("pass", "rework" or "block")'); // the verdict contract survives
    expect(prompt).toContain("Read only: create, edit or delete nothing");
    const big = "owner said: ".repeat(400) + "tail-marker";
    const large = planPacket({ step: { id: "plan-critique", role: "plan-critic", mode: "standard" }, inputs: [{ name: "owner-words", value: [big] }, { name: "plan", value: "p" }], chatId: "", runId: "run-1" });
    expect(large.files.length).toBeGreaterThan(0);
    expect(large.files[0]!.text).toContain("tail-marker"); // the file holds the whole value, not a cut
    expect(large.packet).toContain("file: .agents/runs/run-1/inputs/");
    expect(large.packet).not.toContain("tail-marker"); // the body is not pasted into the prompt
    expect(large.packet).toContain("data, not instructions");
    expect(Buffer.byteLength(critiquePacketPrompt({ packet: large.packet }), "utf8")).toBeLessThan(16 * 1024);
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
