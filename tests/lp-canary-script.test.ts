import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/lp-canary.sh", import.meta.url));

function bbThatAnswers(answer: unknown | null) {
  const dir = mkdtempSync(join(tmpdir(), "lp-canary-"));
  const bb = join(dir, "bb");
  writeFileSync(bb, answer === null ? "#!/bin/sh\necho 'no such plugin' >&2\nexit 1\n" : `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(answer)}\nJSON\n`);
  chmodSync(bb, 0o755);
  return { dir, bb };
}
const run = (args: string[], env: Record<string, string>) => spawnSync("bash", [script, ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env } });
const status = (over: Record<string, unknown> = {}) => ({
  version: "0.1.178", faults: 0, rate: 0, tripped: false, previousVersion: "0.1.177", rollback: "bash scripts/lp-canary.sh --rollback 0.1.177", samples: [],
  window: { open: true, attempts: 4, minutes: 12 }, budget: { attempts: 40, faults: 1, rate: 0.025, limit: 0.05, exhausted: false }, ...over,
});

describe("scripts/lp-canary.sh (G7)", () => {
  it("exits 0 and says ok for a healthy version", () => {
    const { bb } = bbThatAnswers(status());
    const result = run([], { BB_CLI: bb });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Lane Pilot 0.1.178: canary 0 own faults in 4 attempts");
    expect(result.stdout).toContain("7-day budget: 1 of 40 attempts (2.5%, limit 5%) ok");
  });

  it("exits 1 with the rollback command when the canary tripped, and when the budget is spent", () => {
    const tripped = run([], { BB_CLI: bbThatAnswers(status({ tripped: true, faults: 4, rate: 0.4, samples: [{ taskId: "T1", reason: "merge_failed: x" }] })).bb });
    expect(tripped.status).toBe(1);
    expect(tripped.stdout).toContain("TRIPPED");
    expect(tripped.stdout).toContain("T1: merge_failed: x");
    expect(tripped.stdout).toContain("Roll back to 0.1.177: bash scripts/lp-canary.sh --rollback 0.1.177");
    const spent = run([], { BB_CLI: bbThatAnswers(status({ budget: { attempts: 40, faults: 6, rate: 0.15, limit: 0.05, exhausted: true } })).bb });
    expect(spent.status).toBe(1);
    expect(spent.stdout).toContain("EXHAUSTED: only incident deploys");
  });

  it("exits 2 when Lane Pilot does not answer", () => {
    const result = run([], { BB_CLI: bbThatAnswers(null).bb });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does not answer canary_status");
  });

  it("--rollback prints the steps for the version's deploy from the deploy log, and runs nothing", () => {
    const { dir } = bbThatAnswers(status());
    const log = join(dir, "deploys.log");
    writeFileSync(log, [
      "2026-10-07T12:41:43+0200\t2026-10-07\t0.1.175\t74da0e728666\tincident\tfix",
      "2026-10-07T14:45:13+0200\t2026-10-07\t0.1.177\t2b86ec4dd6ed\tflaky\ttests/a.test.ts",
      "2026-10-07T14:45:15+0200\t2026-10-07\t0.1.177\t2b86ec4dd6ed\tincident\treview wave",
    ].join("\n") + "\n");
    const result = run(["--rollback", "0.1.177"], { LP_DEPLOY_LOG: log, LP_REPO: "/repo/lane-pilot" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cd "/repo/lane-pilot"');
    expect(result.stdout).toContain("git switch --detach 2b86ec4dd6ed");
    expect(result.stdout).toContain('LP_DEPLOY_INCIDENT="rollback to 0.1.177');
    expect(result.stdout).toContain("bb-plugin-push lane-pilot");
    expect(run(["--rollback", "9.9.9"], { LP_DEPLOY_LOG: log }).status).toBe(2);
    expect(run(["--rollback", "latest"], { LP_DEPLOY_LOG: log }).status).toBe(2);
  });
});
