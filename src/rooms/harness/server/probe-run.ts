import { PROBE_DEFAULTS, formatProbeContrasts, selectProbeAttempts, type ProbeBudget, type ProbeContrast, type Tree } from "@lane-pilot/harness-core";
import { prepareCheckoutCommand, type HostPort } from "../../bench/server";
import { mapVerificationCwd } from "../../tasks";
import { writeFileCommands } from "./evidence";

/**
 * A real probe: the candidate harness is written into a bench checkout of a saved task (prepareCheckoutCommand)
 * and that task's verification commands are run there. No model is started. The composer reads whether the
 * checks passed and how many tokens the run reported (`probe-tokens: N` on stdout).
 */
export type ProbeTask = {
  attemptId: string;
  /** Commit the checkout is reset to. Empty: the task is recorded and not run. */
  sha: string;
  tokens: number;
  verification: ReadonlyArray<{ command: string; cwd?: string }>;
};

export type ProbeReplay = {
  attemptId: string;
  candidate: string;
  passed: boolean;
  tokens: number;
  seconds: number;
  detail: string;
};

export type ProbeClock = { now(): number };

const reportedTokens = (stdout: string): number => {
  const match = /probe-tokens:\s*(\d+)/.exec(stdout);
  return match ? Number(match[1]) : 0;
};

/** Installs each candidate and runs the saved checks. A false switch or a zero budget returns nothing and does not call the host. */
export async function runHarnessProbe(input: {
  host: HostPort;
  hostId: string;
  /** Empty directory on the host. Never the live working tree. */
  checkout: string;
  repo: string;
  candidates: ReadonlyArray<{ label: string; tree: Tree }>;
  tasks: ReadonlyArray<ProbeTask>;
  budget?: ProbeBudget;
  clock?: ProbeClock;
}): Promise<ProbeReplay[]> {
  const budget = { ...PROBE_DEFAULTS, ...input.budget };
  const picked = selectProbeAttempts(input.tasks.map((task) => ({ attemptId: task.attemptId, tokens: Math.max(1, task.tokens), brief: "", outcome: "" })), budget);
  if (!picked.length) return [];
  const wanted = new Set(picked.map((row) => row.attemptId));
  const clock = input.clock ?? { now: () => Date.now() };
  const started = clock.now();
  const timeBudget = budget.timeBudgetSec ?? PROBE_DEFAULTS.timeBudgetSec ?? 0;
  const out: ProbeReplay[] = [];
  let spent = 0;
  const roomLeft = (): boolean => spent < budget.tokenBudget && (clock.now() - started) / 1000 < timeBudget;

  for (const task of input.tasks) {
    if (!wanted.has(task.attemptId)) continue;
    for (const candidate of input.candidates) {
      if (!roomLeft()) return out;
      const mark = clock.now();
      const fail = (detail: string, tokens = 0): ProbeReplay => ({ attemptId: task.attemptId, candidate: candidate.label, passed: false, tokens, seconds: Math.max(0, (clock.now() - mark) / 1000), detail });
      if (!task.sha) { out.push(fail("no base commit, not replayed")); continue; }
      if (!task.verification.length) { out.push(fail("the saved task has no verification command")); continue; }
      const checkout = await input.host.run(input.hostId, "/", prepareCheckoutCommand(input.repo, input.checkout, task.sha), 120);
      if (checkout.exitCode !== 0) { out.push(fail(`checkout failed: ${(checkout.stderr || checkout.stdout).slice(0, 200)}`)); continue; }
      const files = Object.fromEntries(Object.entries(candidate.tree).map(([rel, body]) => [`.lane-pilot/harness-probe/${rel}`, body]));
      let wrote = true;
      for (const command of writeFileCommands(input.checkout, files)) {
        const result = await input.host.run(input.hostId, "/", command, 60);
        if (result.exitCode !== 0) { out.push(fail(`harness write failed: ${(result.stderr || result.stdout).slice(0, 200)}`)); wrote = false; break; }
      }
      if (!wrote) continue;
      let passed = true;
      let tokens = 0;
      let detail = "checks passed";
      for (const check of task.verification) {
        const cwd = mapVerificationCwd(check.cwd || input.repo, input.repo, input.checkout) ?? input.checkout;
        const ran = await input.host.run(input.hostId, cwd, check.command, 120);
        tokens += reportedTokens(ran.stdout);
        if (ran.exitCode !== 0) { passed = false; detail = `${check.command} exited ${ran.exitCode}`; break; }
      }
      spent += tokens;
      out.push({ attemptId: task.attemptId, candidate: candidate.label, passed, tokens, seconds: Math.max(0, (clock.now() - mark) / 1000), detail });
    }
  }
  return out;
}

/** context/probe.md from a host replay. */
export function formatProbeReplays(rows: readonly ProbeReplay[]): string {
  const contrasts: ProbeContrast[] = rows.map((row) => ({
    attemptId: row.attemptId, candidate: row.candidate, tokens: row.tokens, seconds: row.seconds, passed: row.passed, added: row.detail, outcome: row.passed ? "checks passed" : row.detail,
  }));
  return formatProbeContrasts(contrasts);
}
