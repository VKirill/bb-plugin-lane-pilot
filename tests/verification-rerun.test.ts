import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { failIfNoTestRan, runWithFlakyRerun } from "../src/rooms/writer/server/verify";
import type { MachineReading } from "../src/rooms/verification";

const sequence = (...codes: number[]) => { let n = 0; const calls = () => n; return { run: async () => ({ exitCode: codes[Math.min(n++, codes.length - 1)]!, stdout: `out ${n}`, stderr: `err ${n}` }), calls }; };
const GB = 1024 ** 3;
const quiet: MachineReading = { hostId: "mini", at: 1, load1: 2, cpuCount: 10, memFreeBytes: 4 * GB, memTotalBytes: 16 * GB, diskFreeBytes: 200 * GB, diskTotalBytes: 500 * GB };
const sampled = (...readings: Array<MachineReading | null>) => { let n = 0; return async () => readings[Math.min(n++, readings.length - 1)] ?? null; };

describe("verification command re-run", () => {
  it("passes first time without a second run", async () => {
    const s = sequence(0); const log: string[] = [];
    expect(await runWithFlakyRerun("npm test", s.run, (l) => log.push(l))).toEqual({ exitCode: 0, stdout: "out 1", stderr: "err 1" });
    expect(s.calls()).toBe(1); expect(log).toEqual([]);
  });

  it("a failure that passes on the re-run is flaky and passes, and the first failure is kept", async () => {
    const s = sequence(1, 0); const log: string[] = [];
    const result = await runWithFlakyRerun("npm test", s.run, (l) => log.push(l));
    expect(result).toMatchObject({ exitCode: 0, flaky: true, flakyEvidence: { firstFailure: { exitCode: 1, outputTail: "err 1\nout 1" }, classification: "unexplained" } });
    expect(s.calls()).toBe(2);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("verification command passed on re-run (flaky): npm test");
    expect(log[0]).toContain("first exit 1, unexplained");
  });

  it("without a sampler no load is claimed", async () => {
    const result = await runWithFlakyRerun("npm test", sequence(1, 0).run, () => undefined);
    expect(result.flakyEvidence).toMatchObject({ classification: "unexplained", readings: { beforeFirst: null, beforeRerun: null } });
    expect(result.flakyEvidence!.basis).toContain("no machine reading was available");
    expect(result.flakyEvidence!.basis).not.toMatch(/load average/);
  });

  it("a reading over a limit before the failing attempt makes it machine_pressure, with the numbers and the sampling limit", async () => {
    const busy: MachineReading = { ...quiet, load1: 18.4, memFreeBytes: 0.3 * GB };
    const result = await runWithFlakyRerun("npm test", sequence(1, 0).run, () => undefined, sampled(busy, quiet));
    const evidence = result.flakyEvidence!;
    expect(evidence.classification).toBe("machine_pressure");
    expect(evidence.basis).toContain("load average 18.4 on 10 CPUs");
    expect(evidence.basis).toContain("available memory 0.3 GB of 16.0 GB");
    expect(evidence.basis).toContain("not during it");
    expect(evidence.readings).toEqual({ beforeFirst: busy, beforeRerun: quiet });
  });

  it("pressure only at the re-run does not explain the first failure", async () => {
    const busy: MachineReading = { ...quiet, load1: 30 };
    const evidence = (await runWithFlakyRerun("npm test", sequence(1, 0).run, () => undefined, sampled(quiet, busy))).flakyEvidence!;
    expect(evidence.classification).toBe("unexplained");
    expect(evidence.basis).toContain("a spike during the run is not seen");
    expect(evidence.basis).toContain("on mini");
  });

  it("a full disk before the failing attempt is pressure", async () => {
    const full: MachineReading = { ...quiet, diskFreeBytes: 1.2 * GB };
    const evidence = (await runWithFlakyRerun("npm test", sequence(1, 0).run, () => undefined, sampled(full))).flakyEvidence!;
    expect(evidence.classification).toBe("machine_pressure");
    expect(evidence.basis).toContain("free disk 1.2 GB of 500.0 GB");
  });

  it("the first failure's output is bounded", async () => {
    let n = 0;
    const run = async () => (n++ === 0 ? { exitCode: 1, stdout: "x".repeat(50_000), stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    expect((await runWithFlakyRerun("npm test", run, () => undefined)).flakyEvidence!.firstFailure.outputTail.length).toBe(2000);
  });

  it("a failure that fails again stays the first failure, run only twice", async () => {
    const s = sequence(2, 1, 0); const log: string[] = [];
    expect(await runWithFlakyRerun("npm test", s.run, (l) => log.push(l))).toMatchObject({ exitCode: 2, stdout: "out 1" });
    expect(s.calls()).toBe(2); expect(log).toEqual([]);
  });

  const XCRUN = "python3: error: couldn't create cache file '/var/folders/gs/T/xcrun_db-WOHYd8bg' (errno=Operation not permitted)\r\n";
  const twoRuns = (first: { exitCode: number; stdout: string }, again: { exitCode: number; stdout: string }) => { let n = 0; return async () => ({ ...(n++ === 0 ? first : again), stderr: "" }); };

  it("Vampirism Fire 2026-10-24: a re-run that exits 0 with only the sandbox's refusal and no report is not a flaky pass", async () => {
    const log: string[] = [];
    const result = await runWithFlakyRerun("cd game && python3 -I scripts/studio_test.py --filter Par042",
      twoRuns({ exitCode: 1, stdout: "FAIL Par042\n1 checks, 1 failed\r\n" }, { exitCode: 0, stdout: XCRUN }), (l) => log.push(l));
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.flaky).toBeUndefined();
    expect(result.stdout).toContain("1 checks, 1 failed");
    expect(result.stderr).toContain("the re-run exited 0 but");
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("did not run");
  });

  it("a re-run without the summary the first run printed is not a flaky pass", async () => {
    const result = await runWithFlakyRerun("npm test", twoRuns({ exitCode: 1, stdout: " Tests  1 failed | 2 passed (3)\n" }, { exitCode: 0, stdout: "" }), () => undefined);
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.flaky).toBeUndefined();
  });

  it("a re-run that prints its report is still a flaky pass, even beside a sandbox warning", async () => {
    const result = await runWithFlakyRerun("cd game && python3 -I scripts/studio_test.py --filter Par042",
      twoRuns({ exitCode: 1, stdout: "boom" }, { exitCode: 0, stdout: `${XCRUN}12 checks, 0 failed\r\n` }), () => undefined);
    expect(result).toMatchObject({ exitCode: 0, flaky: true });
  });

  it("a silent tool (tsc) that failed once and passes silently on the re-run stays a flaky pass", async () => {
    const result = await runWithFlakyRerun("npx tsc --noEmit", twoRuns({ exitCode: 2, stdout: "a.ts(1,1): error TS2322" }, { exitCode: 0, stdout: "" }), () => undefined);
    expect(result).toMatchObject({ exitCode: 0, flaky: true });
  });

  it("does not re-run a command killed by timeout (exit 124)", async () => {
    const s = sequence(124, 0);
    expect(await runWithFlakyRerun("npm test", s.run, () => undefined)).toMatchObject({ exitCode: 124 });
    expect(s.calls()).toBe(1);
  });
});

describe("a green check that ran no test fails", () => {
  const output = (name: string) => readFileSync(new URL(`./fixtures/test-runner-output/${name}.txt`, import.meta.url), "utf8");

  it("vitest -t with a name that matches nothing: exit 0 becomes exit 1 with the reason first in stderr", () => {
    const result = failIfNoTestRan({ command: "npx vitest run a.test.ts -t zzzz", exitCode: 0, stdout: output("vitest-filter-none"), stderr: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^check failed: the check exited 0 but ran no test: 4 skipped/);
    expect(result.stdout).toContain("4 skipped"); // the runner's own output stays
  });

  it("a real run, a failing check and a check that is not a test run stay as they are", () => {
    const real = { exitCode: 0, stdout: output("vitest-mixed"), stderr: "" };
    expect(failIfNoTestRan(real)).toBe(real);
    const red = { exitCode: 1, stdout: output("vitest-filter-none"), stderr: "boom" };
    expect(failIfNoTestRan(red)).toBe(red);
    const tsc = { exitCode: 0, stdout: "", stderr: "" };
    expect(failIfNoTestRan(tsc)).toBe(tsc);
  });

  it("a Studio report with no checks fails; a real one passes", () => {
    const empty = failIfNoTestRan({ exitCode: 0, stdout: "0 checks, 0 failed\r\n", stderr: "" });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("(studio)");
    const real = { exitCode: 0, stdout: "python3: error: couldn't create cache file\r\n12 checks, 0 failed\r\n", stderr: "" };
    expect(failIfNoTestRan(real)).toBe(real);
  });

  it("a flaky pass that ran no test is still not a pass", async () => {
    let n = 0;
    const run = async () => (n++ === 0 ? { exitCode: 1, stdout: "FAIL", stderr: "" } : { exitCode: 0, stdout: output("node-skipped-only"), stderr: "" });
    const result = failIfNoTestRan(await runWithFlakyRerun("node --test", run, () => undefined));
    expect(result.exitCode).toBe(1);
    expect(result.flaky).toBe(true);
  });
});
