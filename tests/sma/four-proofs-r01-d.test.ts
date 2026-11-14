// Region 1 · Task graph, batch d (file 1): the verification barrier's checks, the attempt automaton, the push rule and the landing word.
// Each test checks the result the node's card names, on the real code; the same observers feed the scene (scripts/lp_drill/scenes/sma_r01_d.py).
import { describe, expect, it, vi } from "vitest";
import {
  observeAuthorized, observeAutomaton, observeBlocks, observeCandidateMerge, observeContract, observeCriticRoute, observeLanded, observeProofGap,
  observePushRefused, observeSandboxCheck, observeStepRecord,
} from "./r01-world-d";

vi.setConfig({ testTimeout: 120_000 });

describe("the contract and the critic", () => {
  it("[sma:av_contract] the verdict is read against the confirmed edition: a worker's own key, a missing acceptance or output, a foreign verify word are refused", () => {
    expect(observeContract()).toEqual({ confirmed: true, workerKey: false, noAcceptance: false, noOutputs: false, badVerify: false, relativeCwd: false });
  });

  it("[sma:av_critic_route] the code critic of the writer's own model moves to the other vendor when the host has it; with none on offer the same pair is kept", async () => {
    const seen = await observeCriticRoute();
    expect(seen.moved).toEqual({ pair: seen.sol, changed: true });
    expect(seen.onlyOwn).toEqual({ pair: seen.opus, changed: false });
    expect(seen.otherWriter).toEqual({ pair: seen.opus, changed: false });
    expect(seen.noWriter).toEqual({ pair: seen.opus, changed: false });
  });

  it("[sma:av_blocks] a blocking finding is kept whole for the person, and a change request with no blocking finding is an approval that carries the warnings", () => {
    const seen = observeBlocks();
    expect(seen.decision).toBe("changes_requested");
    expect(seen.findings).toEqual([{ id: "f1", severity: "blocking", finding: "the guard is missing", criterion: "inputs are validated", path: "src/a.ts", line: 12, evidence: "export const a = 1;", impact: "a crash on empty input" }]);
    expect(seen.warnedDecision).toBe("approve");
    expect(seen.warnedCount).toBe(1);
  });
});

describe("the candidate and its own checks", () => {
  it("[sma:av_candidate] the worker's copy is committed and merged with main; the merge names the commit, what main was and what changed; a clash leaves main as it was", async () => {
    const seen = await observeCandidateMerge();
    expect(seen.made).toEqual({ status: "ready", branch: "lane/lpattempt_d1" });
    expect(seen.merged).toEqual({ status: "merged", commit: seen.head, base: seen.moved, changed: [{ status: "A", path: "c.txt" }], rebased: true, worktreeRemoved: true });
    expect(seen.hasCandidateFile && seen.hasMainFile && seen.gone).toBe(true);
    expect(seen.refused).toEqual({ status: "conflict", conflicts: ["c.txt"], commit: null });
    expect(seen.mainAfterClash).toBe(seen.before);
  });

  it("[sma:av_regression] the daemon's own check runs in the candidate's folder and returns the real exit code and both streams; a folder outside the copy is refused", async () => {
    const seen = await observeSandboxCheck();
    expect(seen.green).toMatchObject({ exitCode: 0, stdout: "green-out\n", stderr: "green-err\n", backend: "linux-bubblewrap", workspacePath: seen.ws });
    expect(seen.red).toMatchObject({ exitCode: 3, stdout: "red-out\n", stderr: "red-err\n" });
    expect(seen.wherePwd).toBe(`${seen.ws}/sub`);
    expect(seen.outside).toBe("sandbox_cwd_outside_workspace");
  });

  it("[sma:av_step] a verify step is a durable receipt: its state, the hash of its input, one row per stage, the attempt number kept in 0-2", () => {
    const seen = observeStepRecord();
    expect(seen.count).toBe(1);
    expect(seen.row).toMatchObject({ stageId: "verification", state: "running", inputSha256: seen.inputSha, attempt: 2, providerId: "p", model: "m" });
  });
});

describe("the attempt automaton", () => {
  const automaton = () => observeAutomaton();

  it("[sma:f_ready] a task becomes an attempt in the state queued, number one", () => {
    expect(automaton().ready).toEqual({ form: "queued", row: "queued", no: 1 });
  });

  it("[sma:f_claimed] a queued attempt asked for a writer is spawn_requested, and cannot skip to running", () => {
    expect(automaton().claimed).toEqual({ to: "spawn_requested", row: "spawn_requested", skipRunning: false });
  });

  it("[sma:f_running] a spawn that answered makes the attempt running and stamps its thread", () => {
    expect(automaton().running).toEqual({ to: "running", row: "running", thread: "thr_w" });
  });

  it("[sma:f_produced] checks passed on a running attempt make it accepted, a failed validation makes it validation_failed, and accepted does not move back", () => {
    expect(automaton().produced).toEqual({ to: "accepted", failedTo: "validation_failed", row: "accepted", reopened: false, still: "accepted" });
  });

  it("[sma:f_retryable] a failed attempt is retried once, then retry is exhausted and it is blocked; an accepted one cannot be retried", () => {
    expect(automaton().retryable).toEqual({ first: "retry", exhausted: "retry_exhausted", to: "queued", spent: "blocked", accepted: "retry is not legal from accepted" });
  });

  it("[sma:f_cancelled] a stop goes through cancel_requested to canceled, and a late acceptance does not overwrite it", () => {
    expect(automaton().cancelled).toEqual({ cancelTo: "cancel_requested", to: "canceled", row: "canceled", late: false, still: "canceled" });
  });

  it("[sma:ta_landed] work that landed in main moves the attempt to accepted from every state that ended without it; accepted never moves back", () => {
    expect(observeLanded()).toEqual({
      landed: { cancel_requested: "accepted", blocked: "accepted", provider_error: "accepted", timeout: "accepted", empty_output: "accepted", validation_failed: "accepted" },
      mainfix: true, backToRunning: false, backToQueued: false,
    });
  });
});

describe("acceptance rules", () => {
  it("[sma:f_inv_accept] a model's opinion alone never accepts a task: one stage decided by code is needed, and the refusal says which case it is", () => {
    const seen = observeProofGap();
    expect(seen.opinion).toBe("acceptance_without_code_proof: only advisory stages passed (plan-critique, code-critique); a model's opinion cannot accept a task on its own");
    expect(seen.none).toBe("acceptance_without_code_proof: no stage passed");
    expect(seen.code).toBeNull();
    expect(seen.mixed).toBeNull();
  });

  it("[sma:f_inv_push] a writer's launch is refused push, merge, tag and release in the line itself; a critic's launch carries only the helper list and a PM's none", () => {
    const seen = observePushRefused();
    expect(seen.writer).toBe("Workflow,ScheduleWakeup,AskUserQuestion,Agent,Bash(git push:*),Bash(git merge:*),Bash(git tag:*),Bash(gh release:*)");
    expect(seen.critic).toBe("Workflow,ScheduleWakeup,AskUserQuestion,Agent");
    expect(seen.pm).toBeNull();
  });

  it("[sma:ta_authorized] the owner's yes binds this very candidate: no word, a no and a yes for another candidate hold the landing; the latest word wins", () => {
    const seen = observeAuthorized();
    expect(seen.off).toBeNull();
    expect(seen.none).toMatch(/^owner_word: owner\.words is on — the task is verified and waits for the owner's word/);
    expect(seen.yes).toBeNull();
    expect(seen.no).toBe("owner_word: the owner said no to this task — не сливать");
    expect(seen.other).toBe("owner_word: the owner's yes was given for another candidate of this task (attempt att-0); ask him for the word on this one");
    expect(seen.latestWins).toBeNull();
  });
});
