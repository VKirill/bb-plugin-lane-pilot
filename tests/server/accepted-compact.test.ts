import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { memoryMaintenancePrompt, parseMemorySettings } from "../../packages/memory-core/src";
import { nightReviewPrompt } from "../../src/rooms/night/night";
import { compactAcceptedResult } from "../../src/server/accepted-compact";

/**
 * Real memory-maintenance briefs of the SelfyStudio project on the hub (first turn, 2026-10-02..07), task and accepted
 * result split out: `median` 50k chars, `p90` 324k, `max` 639k. 95 % of such a brief was the acceptance record, mostly
 * every check's full stdout/stderr with terminal escapes (review2-jev, L1).
 */
type Fixture = { source: string; briefChars: number; task: unknown; acceptedResult: Record<string, any> };
const load = (name: string): Fixture => JSON.parse(gunzipSync(readFileSync(new URL(`../fixtures/accepted-results/${name}.json.gz`, import.meta.url))).toString("utf8"));
const settings = parseMemorySettings({});
const memoryBrief = (task: unknown, acceptedResult: unknown) => memoryMaintenancePrompt({ task, acceptedResult, settings });
const nightBrief = (task: unknown, acceptedResult: unknown) => nightReviewPrompt({ agent: "n", task, acceptedResult, workspace: "/w", maxFindings: 5 });

describe("compactAcceptedResult on real accepted results", () => {
  for (const [name, cap] of [["median", 10_000], ["p90", 10_000], ["max", 10_000]] as const) {
    it(`${name}: the memory brief shrinks to a few kB and keeps what the maintainer writes notes from`, () => {
      const { task, acceptedResult, briefChars } = load(name);
      const before = memoryBrief(task, acceptedResult).length;
      const compact = compactAcceptedResult(acceptedResult) as Record<string, any>;
      const brief = memoryBrief(task, compact);
      expect(before).toBeGreaterThan(briefChars * 0.9);
      expect(brief.length).toBeLessThan(cap);
      expect(brief.length).toBeLessThan(before * (name === "median" ? 0.25 : 0.05));
      // The writer's report, in full (it is under the cap), and every file it produced.
      expect(compact.output).toBe(acceptedResult.output);
      expect(compact.produced).toEqual(acceptedResult.produced);
      expect(compact.status).toBe("accepted");
      // Every check: command, exit code, and the runner's own summary when it printed one.
      expect(compact.verification).toHaveLength(acceptedResult.verification.length);
      acceptedResult.verification.forEach((check: any, index: number) => {
        expect(compact.verification[index].command).toBe(check.command);
        expect(compact.verification[index].exitCode).toBe(check.exitCode);
        expect(compact.verification[index].outputChars).toBe(check.stdout.length + check.stderr.length);
        const summary = [...String(check.stdout).replace(/\x1b\[[0-9;]*m|\r/g, "").matchAll(/^\s*Tests\s+.*$/gm)].at(-1);
        if (summary) expect(compact.verification[index].tail.replace(/ +/g, " ")).toContain(summary[0].trim().replace(/ +/g, " "));
        expect(compact.verification[index].tail ?? "").not.toMatch(/npm notice|^\\$/m);
      });
      // What is dropped: raw output, escapes, the reasoning trace, the duplicate acceptance object, ids.
      const json = JSON.stringify(compact);
      expect(json).not.toMatch(/\\u001b|\\r\\n/);
      for (const dropped of ["reasoning", "planSha256", "runV2", "executionPacketSha256", "acceptancePath", "lanePilotRunId", "schema_version"]) expect(json).not.toContain(dropped);
    });

    it(`${name}: the night review brief shrinks the same way`, () => {
      const { task, acceptedResult } = load(name);
      const before = nightBrief(task, acceptedResult).length;
      const brief = nightBrief(task, compactAcceptedResult(acceptedResult));
      expect(brief.length).toBeLessThan(cap);
      expect(brief.length).toBeLessThan(before * 0.5);
      expect(brief).toContain(JSON.stringify(task));
    });
  }
});

describe("compactAcceptedResult edge cases", () => {
  it("a failed check keeps its complaint, its exit code and the saved log path", () => {
    const stderr = `${"npm notice padding\n".repeat(50)}\x1b[31mFAIL\x1b[39m src/a.test.ts > adds\nAssertionError: expected 2 to be 3\n    at src/a.test.ts:4:5\n${"noise line\n".repeat(400)}Tests  1 failed | 2 passed (3)\n`;
    const compact = compactAcceptedResult({ status: "accepted", output: "done", produced: ["src/a.ts"], checkLogPath: ".agents/plans/items/t1/logs/npm-test.log",
      verification: [{ command: "npm test", exitCode: 1, stdout: "", stderr }] }) as Record<string, any>;
    expect(compact.checkLogPath).toBe(".agents/plans/items/t1/logs/npm-test.log");
    expect(compact.verification[0].exitCode).toBe(1);
    expect(compact.verification[0].tail).toContain("AssertionError: expected 2 to be 3");
    expect(compact.verification[0].tail).toContain("Tests  1 failed");
    expect(compact.verification[0].tail).not.toContain("\x1b");
    expect(compact.verification[0].tail.length).toBeLessThan(600);
  });

  it("caps a long report and a long list, and says how much it left out", () => {
    const compact = compactAcceptedResult({ status: "accepted", output: "x".repeat(5000), produced: Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`),
      verification: Array.from({ length: 30 }, (_, i) => ({ command: `c${i}`, exitCode: 0, stdout: "ok\n", stderr: "" })), warnings: ["w"] }) as Record<string, any>;
    expect(compact.output.length).toBeLessThan(2100);
    expect(compact.output).toContain("[+3000 chars]");
    expect(compact.produced).toHaveLength(61);
    expect(compact.produced.at(-1)).toBe("… +40 more");
    expect(compact.verification).toHaveLength(21);
    expect(compact.verification.at(-1)).toEqual({ omitted: 10 });
    expect(compact.warnings).toEqual(["w"]);
  });

  it("passes anything that is not a record through, and survives a record without checks", () => {
    expect(compactAcceptedResult(null)).toBeNull();
    expect(compactAcceptedResult("text")).toBe("text");
    expect(compactAcceptedResult({})).toEqual({ output: "", produced: [], verification: [] });
  });
});
