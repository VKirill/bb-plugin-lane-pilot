import { describe, expect, it } from "vitest";
import { runWithFlakyRerun } from "../src/rooms/writer/server/verify";

const sequence = (...codes: number[]) => { let n = 0; const calls = () => n; return { run: async () => ({ exitCode: codes[Math.min(n++, codes.length - 1)]! }), calls }; };

describe("verification command re-run", () => {
  it("passes first time without a second run", async () => {
    const s = sequence(0); const log: string[] = [];
    expect(await runWithFlakyRerun("npm test", s.run, (l) => log.push(l))).toEqual({ exitCode: 0 });
    expect(s.calls()).toBe(1); expect(log).toEqual([]);
  });

  it("a failure that passes on the re-run is flaky and passes", async () => {
    const s = sequence(1, 0); const log: string[] = [];
    expect(await runWithFlakyRerun("npm test", s.run, (l) => log.push(l))).toEqual({ exitCode: 0, flaky: true });
    expect(s.calls()).toBe(2);
    expect(log).toEqual(["verification command passed on re-run (flaky): npm test"]);
  });

  it("a failure that fails again stays the first failure, run only twice", async () => {
    const s = sequence(2, 1, 0); const log: string[] = [];
    expect(await runWithFlakyRerun("npm test", s.run, (l) => log.push(l))).toEqual({ exitCode: 2 });
    expect(s.calls()).toBe(2); expect(log).toEqual([]);
  });

  it("does not re-run a command killed by timeout (exit 124)", async () => {
    const s = sequence(124, 0);
    expect(await runWithFlakyRerun("npm test", s.run, () => undefined)).toEqual({ exitCode: 124 });
    expect(s.calls()).toBe(1);
  });
});
