// Region 1 · Task graph, batch e (n288..n302): the task's landing, its birth gates and its contract. Each test runs the node's real code through tests/sma/r01-world-e.ts.
import { describe, expect, it, vi } from "vitest";
import { bookCloseObs, birthKindsObs, contractObs, decisionsObs, harvestObs, holderObs, mergeVerifiedObs, oldPathObs, promiseObs, replaceObs, staleObs, tornObs, unverifiedObs, validateObs } from "./r01-world-e";

vi.setConfig({ testTimeout: 120_000 });

describe("the landing of a task (ta_*)", () => {
  it("[sma:ta_decisions] with owner.words on, «useful» and «limits acknowledged» each need the person's own yes on this package", () => {
    const seen = decisionsObs();
    expect(seen.none).toEqual([false, false]);
    expect(seen.yes).toEqual([true, true]);
    expect(seen.onlyUseful).toEqual([true, false]);
    expect(seen.otherPackage).toBe(false);
    expect(seen.notAsked).toBe(true);
  });

  it("[sma:ta_unverified] a verification that did not run, or ran red, leaves the composition line red; only a passed verdict turns it on", () => {
    expect(unverifiedObs()).toEqual({ none: [false, "no blind verdict yet"], failed: [false, "blind check red: 2 failed"], passed: [true, "blind check green"] });
  });

  it("[sma:ta_holder] a merge that lost the race says busy and names who holds the checkout; its work stays committed, main is untouched", async () => {
    const seen = await holderObs();
    expect(seen.status).toBe("busy");
    expect(seen.holder).toBe("writer-a: Fix the form");
    expect(seen.reason).toBe("another writer integration holds the base checkout: writer-a: Fix the form");
    expect(seen.mainKept).toBe(true);
    expect(seen.committed).toBe(true);
  });

  it("[sma:ta_merge] only the tree that was verified lands: a worktree that moved after its verdict is refused and main stays; the verified head lands as it is", async () => {
    const seen = await mergeVerifiedObs();
    expect(seen.refused).toEqual(["failed", true, true, false]);
    expect(seen.landed).toEqual(["merged", "verified\n", true]);
  });

  it("[sma:ta_book_close] acceptance holds until BOOK.md is written through the last part and reads back", () => {
    expect(bookCloseObs()).toEqual({ intact: true, behind: false, tampered: false, neverWritten: false });
  });

  it("[sma:ta_old_path] a piece whose verify is none needs no check command; any other verify does", () => {
    expect(oldPathObs()).toEqual({ none: false, tests: true, testsWithCheck: false });
  });

  it("[sma:ta_harvest] an accepted task starts the after-acceptance run (memory harvest); a blocked, failed or phase event starts nothing", () => {
    expect(harvestObs()).toEqual({ name: "workflow:after-accept", started: [["proj", "run", "t-task-accepted", "pm"]] });
  });

  it("[sma:ta_torn] a merge that landed with its reply lost is accepted after restart with a receipt, once, and the intent is dropped", async () => {
    const seen = await tornObs();
    expect(seen.merged).toBe("merged");
    expect(seen.before).toBe("running");
    expect(seen.first).toEqual(["T1"]);
    expect(seen.after).toBe("accepted");
    expect(seen.gate).toMatchObject([{ gate: "accept", status: "passed" }]);
    expect(seen.stages).toEqual(["passed", "passed", "passed"]);
    expect(seen.intentLeft).toBe(false);
    expect(seen.second).toEqual([]);
    expect(seen.maintained).toEqual(["T1"]);
  });

  it("[sma:ta_replace] a yes for one candidate is revoked when another candidate replaces it", () => {
    const seen = replaceObs();
    expect(seen.same).toBeNull();
    expect(seen.other).toMatch(/^owner_word: the owner's yes was given for another candidate of this task \(attempt att-A\)/);
    expect(seen.noCandidate).toBeNull();
    expect(seen.off).toBeNull();
  });

  it("[sma:ta_stale] a word given on an older package does not count: a new plan or a new tree asks the person again", () => {
    const seen = staleObs();
    expect(seen.keyChanges).toEqual([true, true]);
    expect(seen.same).toBe(true);
    expect(seen.replanned).toEqual([false, true]);
    expect(seen.newTree).toBe(false);
  });
});

describe("the birth of a task (tb_*), first part", () => {
  it("[sma:tb_birth_kinds] the birth kind chooses the gates", () => {
    const seen = birthKindsObs();
    expect(seen.pm).toEqual([[], ["promise_missing"]]);
    expect(seen.phase).toEqual([["promise_missing"], []]);
    expect(seen.bench).toEqual({ errors: [], warnings: [] });
    expect(seen.loops).toEqual([true, false, false, false]);
    expect(seen.redoPromise).toBe("warn");
  });

  it("[sma:tb_validate] a refused enqueue says nothing was dispatched and classes each finding; a contract with an unknown field is not the schema", () => {
    const seen = validateObs();
    expect(seen.state).toBe("validation_failed");
    expect(seen.runId).toBe("run-1");
    expect(seen.nothing).toBe(true);
    expect(seen.findings).toEqual([{ code: "clarify_open", message: "the task has open clarification questions: Which currency?", blockingClass: "missing_info" }]);
    expect(seen.classes).toEqual(["missing_info"]);
    expect(seen.closed).toEqual([true, false]);
  });

  it("[sma:tb_contract] each word change mints a numbered hashed edition and keeps the old ones", () => {
    const seen = contractObs();
    expect(seen.editions).toEqual([1, 2, 3]);
    expect(seen.distinct).toBe(3);
    expect(seen.first).toEqual({ title: "v1" });
  });

  it("[sma:tb_promise] a promise missing a clause is refused; a medium feature with none is warned; a whole one passes clean", () => {
    expect(promiseObs()).toEqual({ incomplete: ["promise_incomplete"], missing: ["promise_missing"], whole: [[], []] });
  });
});
