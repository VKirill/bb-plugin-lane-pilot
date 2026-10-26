import { createProviderBreaker } from "@lane-pilot/resilience";
import { describe, expect, it } from "vitest";
import { FREE_CLASSES, PARKED_CLASSES, failureClass, isEnvironmentCheckFailure, nextStep, repeatedFailureReason, taskFamily } from "../src/rooms/runs/failure-class";
import { classifyWriterOutput } from "../src/rooms/tasks/validate-output";
import type { TaskV2 } from "../src/rooms/contracts";
import { providerLimitNotice, providerStreamError } from "../src/rooms/writer/server/writer-task";

describe("failure classes", () => {
  it("keeps provider, limit and catalog faults on the provider path for the writer chain", () => {
    expect(failureClass("provider_error", "thread status error")).toBe("provider");
    expect(failureClass("spawn_rejected", "writer_provider_unavailable: catalog down")).toBe("provider");
    expect(failureClass("timeout", null)).toBe("provider");
    expect(failureClass("empty_output", "writer returned no output")).toBe("provider");
  });

  it("reads an empty_output with a writer answer as the task's failure, not the model's", () => {
    expect(failureClass("empty_output", "writer answered but changed no files")).toBe("task");
    expect(failureClass("empty_output", "writer changed no files")).toBe("task");
    // A contract-named reason keeps its class, and a provider fault never turns into a task failure.
    expect(failureClass("empty_output", "missing expected_outputs: src/a.ts")).toBe("contract");
    expect(failureClass("validation_failed", "writer answered but changed no files")).toBe("task");
  });

  it("classes a git index lock as infra under both wordings", () => {
    expect(failureClass("validation_failed", "git merge failed: fatal: Unable to create '/repo/.git/index.lock': File exists")).toBe("infra");
    // Linux git 2.43 names no lock file: «error: Unable to write index.» (OVH 2026-10-06).
    expect(failureClass("validation_failed", "git merge failed: error: Unable to write index.")).toBe("infra");
    expect(failureClass("validation_failed", "git merge failed: error: Unable to write index. (index.lock present)")).toBe("infra");
  });
});

describe("a permission error is the machine's only when the code is not red", () => {
  const EACCES = "[nitro] ERROR Error: EACCES: permission denied, rmSync '/work/base/apps/web/.output/public/_nuxt'";
  const vitestRed = "stderr | tests/fs.test.ts > reads a locked file\nError: EACCES: permission denied, open '/root/secret'\n\n FAIL  tests/fs.test.ts > reads a locked file\nAssertionError: expected 1 to be 2\n\n Test Files  1 failed (1)\n      Tests  1 failed | 3 passed (4)";
  const task = { expected_outputs:["src/a.ts"], owns_paths:["src/"], never_touch:[], verify:"none", verification:[] } as unknown as TaskV2;
  const reasonOf = (check:{ stdout:string; stderr:string }) => {
    const result = classifyWriterOutput({ task, produced:["src/a.ts"], contents:{ "src/a.ts":"x" }, verifies:[{ command:"npm run build", exitCode:1, ...check }] });
    if (result.ok) throw new Error("expected a failed check");
    return result.reason;
  };

  it("reads a Studio MCP that does not answer and the sandbox refusing a tool's cache as the environment, unless a test is red (live 2026-10-26)", () => {
    const studioDown = "== Par028 ==\n19 checks, 0 failed\npython3: error: couldn't create cache file '/var/folders/gs/T/xcrun_db-BzY6ivJ7' (errno=Operation not permitted)\n" +
      "studio_test error: MCP list_roblox_studios error: Unable to reach Roblox Studio right now. Ask the user to confirm that Studio is running with the MCP server enabled in Assistant settings.";
    expect(isEnvironmentCheckFailure({ stdout:studioDown })).toBe(true);
    expect(isEnvironmentCheckFailure({ stderr:"studio_test error: No Roblox Studio instances are connected" })).toBe(true);
    expect(isEnvironmentCheckFailure({ stdout:"== Par030 ==\nFAIL BG4 leak feed on pickup\n12 checks, 1 failed\nUnable to reach Roblox Studio right now." })).toBe(false);
  });

  it("reads the other ways a Studio runner dies of the machine as the environment, and a free attempt (live audit 2026-10-26, Vampirism Fire)", () => {
    const cache = "python3: error: couldn't create cache file '/var/folders/gs/T/xcrun_db-4Qqb8Tvs' (errno=Operation not permitted)\n";
    const lines = [
      "studio_test error: MCP execute_luau error: The requested `studio_id` is not connected — that Roblox Studio instance may have been closed or its place unloaded. Call `list_roblox_studios` for the current instances.",
      "studio_test error: MCP execute_luau: timeout",
      "studio_test error: MCP execute_luau error: Network action ExecuteLuau.runCode sent to DMN_ID_PLAYSERVER failed - Target is not reachable (ExecuteLuau.runCode, DMN_ID_PLAYSERVER). No OnInvoke handler responded for this action.",
      "studio_test error: MCP execute_luau error: Server datamodel is not available in Edit mode",
      "studio_test error: vf-tests-2.rbxl did not load MapData within 180s",
      "studio_test error: MCP start_stop_play error: Stop play hasn't finished yet",
      "studio_test: Studio MCP lists no Studio; waiting for it to come back …",
      "studio_test error: [Errno 1] Operation not permitted: 'ps'",
      "RuntimeError: timed out waiting for lock /tmp/vf-tests/studio.lock",
      "test window unusable: restart it",
    ];
    for (const line of lines) {
      expect(isEnvironmentCheckFailure({ stderr:line }), line).toBe(true);
      expect(isEnvironmentCheckFailure({ stdout:`Using Studio window: vf-tests.rbxl (2c6189dd)\n${line}\n`, stderr:cache }), line).toBe(true);
      // A red test next to it stays the task's.
      expect(isEnvironmentCheckFailure({ stdout:`== Par030 ==\nFAIL BG4 leak feed on pickup\n12 checks, 1 failed\n${line}` }), line).toBe(false);
    }
    // The same words in a test's own output, with no runner error line, are not the environment.
    expect(isEnvironmentCheckFailure({ stderr:"expected the request to time out and the target to be reachable" })).toBe(false);
    expect(isEnvironmentCheckFailure({ stdout:"FAIL spawn waits for MapData" })).toBe(false);
    const reason = reasonOf({ stdout:"Using Studio window: vf-tests.rbxl\nstudio_test error: MCP execute_luau: timeout", stderr:cache });
    expect(reason).toContain("verification failed (npm run build): environment: ");
    expect(failureClass("validation_failed", reason)).toBe("infra");
  });

  it("reads a runner report whose only failure is «DebugHook missing» as the environment, never a real red next to it", () => {
    const hook = "Using Studio window: vf-tests.rbxl (2c6189dd)\n0 checks, 1 failed\nFAIL DebugHook missing\nerror: no checks ran\n";
    expect(isEnvironmentCheckFailure({ stdout:hook })).toBe(true);
    expect(isEnvironmentCheckFailure({ stdout:"error: no checks ran\n\n0 checks, 1 failed\nFAIL DebugHook missing\n" })).toBe(true);
    expect(isEnvironmentCheckFailure({ stderr:"python3: error: couldn't create cache file '/x' (errno=Operation not permitted)", stdout:hook })).toBe(true);
    expect(failureClass("validation_failed", reasonOf({ stdout:hook, stderr:"" }))).toBe("infra");
    // Other failures in the same report, or checks that ran, keep it the task's.
    expect(isEnvironmentCheckFailure({ stdout:"0 checks, 2 failed\nFAIL DebugHook missing\nFAIL revive keeps XP\n" })).toBe(false);
    expect(isEnvironmentCheckFailure({ stdout:"5 checks, 1 failed\nFAIL DebugHook missing\n" })).toBe(false);
    expect(isEnvironmentCheckFailure({ stdout:"0 checks, 1 failed\nFAIL revive keeps XP\n" })).toBe(false);
    expect(isEnvironmentCheckFailure({ stdout:"FAIL revive keeps XP\n0 checks, 1 failed\nFAIL DebugHook missing\n" })).toBe(false);
  });

  it("keeps a red test that logs EACCES a task failure, with its two attempts", () => {
    expect(isEnvironmentCheckFailure({ stdout:vitestRed })).toBe(false);
    expect(isEnvironmentCheckFailure({ stderr:"Error: EPERM: operation not permitted, unlink '/x'", stdout:"FAIL src/b.test.ts\n Tests  2 failed (5)" })).toBe(false);
    expect(isEnvironmentCheckFailure({ stdout:"# pass 3\n# fail 1\nnot ok 4 - reads a locked file\n  error: 'EACCES: permission denied, open \\'/x\\''" })).toBe(false);
    const reason = reasonOf({ stdout:vitestRed, stderr:"Error: EACCES: permission denied, open '/root/secret'" });
    expect(reason).toMatch(/^verification failed \(npm run build\): Error: EACCES/);
    expect(failureClass("validation_failed", reason)).toBe("task");
    expect(failureClass("validation_failed", `turn limit 5 reached: ${reason}`)).toBe("task");
  });

  it("keeps a bare mention of a permission string out of the environment class", () => {
    expect(isEnvironmentCheckFailure({ stderr:"expected the handler to survive EACCES" })).toBe(false);
    expect(failureClass("validation_failed", "verification failed (npm test): expected the handler to survive EACCES")).toBe("task");
  });

  it("still reads a check that died of the machine as infra, before any test ran", () => {
    expect(isEnvironmentCheckFailure({ stderr:EACCES })).toBe(true);
    expect(isEnvironmentCheckFailure({ stderr:"sh: 1: vitest: Permission denied" })).toBe(true);
    expect(isEnvironmentCheckFailure({ stderr:"npm error code EACCES\nnpm error syscall mkdir" })).toBe(true);
    const reason = reasonOf({ stdout:"", stderr:EACCES });
    expect(reason).toContain("environment: ");
    expect(failureClass("validation_failed", reason)).toBe("infra");
    expect(failureClass("validation_failed", `turn limit 5 reached: ${reason}`)).toBe("infra");
  });

  it("keeps the infra class for the snapshot's PermissionError and for non-check reasons", () => {
    expect(failureClass("validation_failed", "snapshot_failed: PermissionError: [Errno 13] Permission denied: '/x'")).toBe("infra");
    expect(failureClass("validation_failed", "merge failed: error: cannot open .git/FETCH_HEAD: Permission denied")).toBe("infra");
  });
});

describe("repeated failures", () => {
  it("blocks two consecutive attempts that failed the same way", () => {
    const first = { state:"validation_failed", reason:"verification failed (npm run typecheck): error TS2345 in thr_abc at line 12" };
    const again = { state:"validation_failed", reason:"verification failed (npm run typecheck): error TS2345 in thr_def at line 13" };
    expect(repeatedFailureReason(first, again)).toMatch(/^repeated_failure: verification failed \(npm run typecheck\)/);
    expect(repeatedFailureReason(again, first)).toMatch(/^repeated_failure: /);
  });

  it("lets different reasons, classes and first attempts through", () => {
    expect(repeatedFailureReason(null, { state:"validation_failed", reason:"x" })).toBeNull();
    expect(repeatedFailureReason(undefined, { state:"provider_error", reason:"thread status error" })).toBeNull();
    expect(repeatedFailureReason(
      { state:"validation_failed", reason:"verification failed (npm run typecheck): a" },
      { state:"validation_failed", reason:"verification failed (npm run vitest): b" },
    )).toBeNull();
    // An answered empty_output is a task failure; a silent one is the provider's — never the same failure.
    expect(repeatedFailureReason(
      { state:"empty_output", reason:"writer returned no output" },
      { state:"empty_output", reason:"writer answered but changed no files" },
    )).toBeNull();
    expect(repeatedFailureReason(
      { state:"empty_output", reason:"writer answered but changed no files" },
      { state:"empty_output", reason:"writer answered but changed no files" },
    )).toMatch(/^repeated_failure: /);
    // A contract failure repeats too: a contract no attempt can meet fails the same way twice and then stops.
    expect(repeatedFailureReason(
      { state:"validation_failed", reason:"missing expected_outputs: src/a.ts" },
      { state:"validation_failed", reason:"missing expected_outputs: src/a.ts" },
    )).toMatch(/^repeated_failure: missing expected_outputs/);
    // Free classes keep their own parks and caps.
    expect(repeatedFailureReason(
      { state:"validation_failed", reason:"merge_conflict: main changed since this attempt started: src/a.ts" },
      { state:"validation_failed", reason:"merge_conflict: main changed since this attempt started: src/a.ts" },
    )).toBeNull();
  });
});

describe("task families", () => {
  it("groups a task with its redispatches and mainfixes", () => {
    expect(taskFamily("P1")).toBe("P1");
    expect(taskFamily("P1.2")).toBe("P1");
    expect(taskFamily("P1.2.3")).toBe("P1");
    expect(taskFamily("x-mainfix")).toBe("x");
    expect(taskFamily("x-mainfix.2")).toBe("x");
    expect(taskFamily("lptask_abc")).toBe("lptask_abc");
  });

  // content-factory editor-policy-ui(.2), 2026-10-06: acp-cursor/grok-4.6 answered only this, twice per task.
  it("reads a provider's plan or quota notice as a limit: uncharged, never a repeated task failure", () => {
    const notice = providerLimitNotice("\n\nUpgrade your plan to continue\n");
    expect(notice).toBe("Upgrade your plan to continue");
    const reason = `writer_provider_limit: ${notice}`;
    expect(failureClass("provider_error", reason)).toBe("limit");
    expect(FREE_CLASSES.has("limit")).toBe(true);
    expect(repeatedFailureReason({ state:"provider_error", reason }, { state:"provider_error", reason })).toBeNull();
    expect(failureClass("spawn_rejected", "writer_provider_unavailable:breaker_open:acp-cursor/grok-4.6: 1 provider failures in 10 min")).toBe("limit");
    for (const text of ["You've hit your usage limit. Try again in 3 hours.", "Error: quota exceeded for this month", "429 Too Many Requests",
      "You are out of credits.", "Your credit balance is too low to access the API"]) expect(providerLimitNotice(text)).not.toBeNull();
  });

  // The whole answers of the acp-cursor writers of cakekeeper ck-18, ck-21 and ck-25 (2026-10-12): read as reports, they
  // failed «missing expected_outputs» for a stage note the cut-off turn had not written yet.
  it("reads a provider's stream error as the whole answer as a cut-off turn, not a report", () => {
    for (const answer of ["\n\nError: RetriableError: [resource_exhausted] Error", "\n\nError: RetriableError: [unavailable] Error",
      "\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)"]) {
      expect(providerStreamError(answer)).toBe(answer.trim());
      expect(providerLimitNotice(answer)).toBeNull();
    }
    expect(providerStreamError("Fixed the retry: a RetriableError: [unavailable] from the API is now retried twice.\nChanged api/retry.ts")).toBeNull();
    expect(providerStreamError(`Error: RetriableError: [unavailable] Error\n${"Changed paths: a.ts. ".repeat(30)}`)).toBeNull();
    expect(providerStreamError("")).toBeNull();
  });

  // The same provider ends a turn on a 503 as NonRetriableError without a bracketed code: cakekeeper ck-y19-screens-canon.2
  // (2026-10-13, four turns in a row) and SelfyStudio admin-seo-clusters-tree-ui failed «missing expected_outputs» for them.
  it("reads a provider's NonRetriableError as the whole answer as a cut-off turn", () => {
    for (const answer of ["\n\nError: NonRetriableError: Service Unavailable Service Unavailable",
      "\n\nError: NonRetriableError: Provider Error We're having trouble connecting to the model provider. This might be temporary - please try again in a moment."]) {
      expect(providerStreamError(answer)).toBe(answer.trim());
      expect(providerLimitNotice(answer)).toBeNull();
    }
    expect(providerStreamError("Handled NonRetriableError: Service Unavailable in api/client.ts; changed api/client.ts")).toBeNull();
  });

  it("keeps a real writer report about rate limits a report", () => {
    expect(providerLimitNotice("Added a token bucket to api/limiter.ts.")).toBeNull();
    expect(providerLimitNotice(`Changed api/limiter.ts: requests over the rate limit reached now get 429.\n${"Checks: npm test passed. ".repeat(20)}`)).toBeNull();
    expect(providerLimitNotice("")).toBeNull();
  });
});

it("classes a permission error at the workspace snapshot as the machine's, not Lane Pilot's (live sandbox 2026-10-07)", () => {
  expect(failureClass("blocked", "attempt_workspace_snapshot_failed:cannot read writer-workspace git diff: Traceback … PermissionError: [Errno 13] Permission denied: 'src/x.js'")).toBe("infra");
});

// A folder without git is a mode of its own: its limits are the owner's to settle, never a Lane Pilot fault to park.
it("never parks a folder without git: «not a git repository» and the no-git limits are the contract's", () => {
  const live = "attempt_workspace_snapshot_failed:cannot read writer-workspace git diff: fatal: not a git repository (or any of the parent directories): .git";
  expect(failureClass("blocked", live)).toBe("contract");
  expect(failureClass("validation_failed", "fatal: not a git repository")).toBe("contract");
  const large = "attempt_workspace_snapshot_failed:folder too large for no-git mode: 51234 files; put it under git";
  expect(failureClass("blocked", large)).toBe("contract");
  expect(failureClass("spawn_rejected", "attempt_workspace_backup_failed:owned files too large for no-git mode: 2100 MB cannot be backed up for a rollback; narrow owns_paths")).toBe("contract");
  expect(PARKED_CLASSES.has(failureClass("blocked", large))).toBe(false);
  expect(FREE_CLASSES.has(failureClass("blocked", large))).toBe(false);
  expect(nextStep("blocked", large)).toMatch(/put it under git/);
});

// Reasons copied from the hub's lane_pilot_attempt table (7 days up to 2026-10-08): 35 of the 106 «harness» faults of the error
// budget were the first two, 2 were a red check whose log printed EROFS.
describe("reasons from the hub that were counted as Lane Pilot's own faults", () => {
  const erofs = "npm warn using --force Recommended protections disabled.\nfailed to load config from /home/ubuntu/.lane-pilot/worktrees/lpattempt_ac105192f5024278b9b802a6e5f4881d/selfystudio/apps/marketing/vitest.config.ts\n\nError: EROFS: read-only file system, open '/home/ubuntu/.lane-pilot/worktrees/lpattempt_ac105192f5024278b9b802a6e5f4881d/selfystudio/apps/marketing/node_modules/.vite-temp/vitest.config.ts.timestamp-1790944873211-7800d1bbf19b4.mjs'";
  it.each([
    ["validation_failed", "merge_conflict: main changed since this attempt started: ", "merge"],
    ["blocked", "retry limit 2 exhausted: merge_conflict: main changed since this attempt started: ", "merge"],
    ["validation_failed", "merge_conflict: main changed since this attempt started: src/sum.js", "merge"],
    ["validation_failed", `verification failed (npm -w @selfystudio/marketing run test -- ArticleBody): ${erofs}`, "task"],
    ["blocked", `retry limit 2 exhausted: verification failed (npm -w @selfystudio/marketing run test -- ArticleBody): ${erofs}`, "task"],
    ["blocked", "retry limit 2 exhausted: verification failed (npx vitest run --exclude 'tests/guard*.test.ts' --exclude tests/native-session-hooks.test.ts --exclude 'tests/verification/**'): exit 1", "task"],
    ["validation_failed", "verification failed (node --test tests/): exit 1", "task"],
    ["blocked", "retry limit 2 exhausted: verification failed (npm run typecheck && npm test && npm run build): exit 1", "task"],
    // The wrapper is X tried too often: it classifies by X.
    ["blocked", "retry limit 2 exhausted: writer_model_unavailable:codex/lp-drill-model-that-does-not-exist", "provider"],
    ["blocked", "retry limit 2 exhausted: missing expected_outputs: CardMockCard.vue", "contract"],
    ["blocked", "retry limit 2 exhausted: writer changed no files", "task"],
    ["blocked", "retry limit 2 exhausted: writer thread status error", "task"],
    ["blocked", "retry limit 2 exhausted: system_error:thread_provisioning_failed:Provisioning thread failed", "harness"],
    ["blocked", "retry limit 2 exhausted: ownership run scope invalid: run scope contains a non-BB or invalid task contract", "harness"],
  ] as const)("%s %s → %s", (state, reason, klass) => {
    expect(failureClass(state, reason)).toBe(klass);
  });

  it("a merge conflict stays a free redo and a red check stays a charged attempt", () => {
    expect(FREE_CLASSES.has(failureClass("blocked", "retry limit 2 exhausted: merge_conflict: main changed since this attempt started: "))).toBe(true);
    expect(PARKED_CLASSES.has(failureClass("blocked", "retry limit 2 exhausted: merge_conflict: main changed since this attempt started: "))).toBe(false);
    expect(FREE_CLASSES.has(failureClass("blocked", "retry limit 2 exhausted: verification failed (node --test tests/): exit 1"))).toBe(false);
  });

  it("a real fault of Lane Pilot is still one, and so is a check that died of the environment", () => {
    expect(failureClass("blocked", "attempt_worktree_holder_ambiguous:page_cap")).toBe("harness");
    expect(failureClass("blocked", "reconcile_page_cap")).toBe("harness");
    expect(failureClass("blocked", "internal_error: illegal stage transition writer-agent: failed -> running")).toBe("harness");
    expect(failureClass("validation_failed", "merge_failed: git merge failed: fatal: Unable to create '/repo/.git/index.lock': File exists.")).toBe("infra");
    expect(failureClass("validation_failed", "verification failed (npm run build): environment: Error: EACCES: permission denied, rmSync '/x/.output'")).toBe("infra");
  });
});

describe("hub 2026-10-08 budget rows that are not Lane Pilot faults", () => {
  it("reads a merge refused over uncommitted edits in the base as a dirty base (parked, not redone), and an unsafe contract path as the PM's contract", () => {
    expect(failureClass("validation_failed", "merge_failed: git merge failed: error: Your local changes to the following files would be overwritten by merge:\n  .agents/PROGRESS.md")).toBe("dirty_base");
    expect(failureClass("blocked", "base checkout has uncommitted changes in files this attempt also changes")).toBe("dirty_base");
    expect(failureClass("blocked", "merge_blocked: base checkout has uncommitted changes in files this task changes: owner.ts")).toBe("contract");
    expect(failureClass("validation_failed", "merge_conflict: src/a.ts")).toBe("merge");
    expect(FREE_CLASSES.has("dirty_base")).toBe(true);
    expect(PARKED_CLASSES.has("dirty_base")).toBe(true);
    expect(nextStep("validation_failed", "merge_failed: ... would be overwritten by merge")).toMatch(/commit or discard them there/);
    expect(failureClass("blocked", "ownership run scope invalid: run task wp-drafts-login-catalog: unsafe owns_paths ../bb-plugin-env-catalog/")).toBe("contract");
    expect(failureClass("blocked", "merge_failed: git merge failed: fatal: refusing to merge unrelated histories")).toBe("harness");
  });
});

describe("provider breaker hold for a writer_provider_limit", () => {
  const MIN = 60_000;
  const NOW = 1_800_000_000_000;
  const KEY = "acp-opencode/router9/ag/gemini-3.8-flash-high";

  it("stays open for the 5-minute cooldown when the limit names no reset time", () => {
    const breaker = createProviderBreaker();
    breaker.record(KEY, "exhausted", NOW);
    expect(breaker.decide(KEY, NOW + 4 * MIN)).toMatchObject({ allow:false, retryAt:NOW + 5 * MIN });
    expect(breaker.decide(KEY, NOW + 5 * MIN)).toMatchObject({ allow:true, state:"half_open" });
  });

  it("stays open until the reset time when the limit names one, past the cooldown", () => {
    const breaker = createProviderBreaker();
    const resetAt = NOW + 160 * MIN;
    breaker.record(KEY, "exhausted", NOW, resetAt);
    expect(breaker.decide(KEY, NOW + 90 * MIN)).toMatchObject({ allow:false, retryAt:resetAt });
    expect(breaker.decide(KEY, resetAt - 1)).toMatchObject({ allow:false });
    expect(breaker.decide(KEY, resetAt)).toMatchObject({ allow:true, state:"half_open" });
  });

  it("is not shortened by a later limit without a reset time, and a past reset time is ignored", () => {
    const breaker = createProviderBreaker();
    breaker.record(KEY, "exhausted", NOW, NOW + 160 * MIN);
    breaker.record(KEY, "exhausted", NOW + 10 * MIN);
    expect(breaker.decide(KEY, NOW + 30 * MIN)).toMatchObject({ allow:false, retryAt:NOW + 160 * MIN });
    breaker.record("other/model", "exhausted", NOW, NOW - MIN);
    expect(breaker.decide("other/model", NOW + MIN)).toMatchObject({ allow:false, retryAt:NOW + 5 * MIN });
  });

  it("is cleared by a successful attempt", () => {
    const breaker = createProviderBreaker();
    breaker.record(KEY, "exhausted", NOW, NOW + 160 * MIN);
    breaker.record(KEY, "ok", NOW + MIN);
    expect(breaker.decide(KEY, NOW + 2 * MIN)).toMatchObject({ allow:true, state:"closed" });
  });
});
