import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../../src/rooms/contracts";
import { openDatabase } from "../../src/rooms/storage/database";
import { createWriterVerify } from "../../src/rooms/writer/server/verify";
import { beginChecks, checksInFlight, checksMoved } from "../../src/rooms/runs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "lp-checks-in-flight-")));
const task = (verification:TaskV2["verification"]):TaskV2 => ({
  schema_version:2, id:"vf-runner-pool.2", title:"t", risk:"low", lane:"writer", project_cwd:root, read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:["a.txt"], owns_paths:["a.txt"], never_touch:[], depends_on:[], objective:"x", acceptance:["x"], verify:"tests", verification,
});

describe("checks in flight", () => {
  it("a writer's checks are in flight while they wait for the run's check pool and while they run, and leave it after", async () => {
    // No BB terminals: the check runs through the host call.
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ terminals:{} } as never });
    const db = openDatabase(bb);
    const host = { call: async () => ({ hostId:"h", backend:"macos-seatbelt", workspacePath:root, cwd:root, exitCode:0, policySha256:"a".repeat(64), stdout:"", stderr:"" }) };
    const ctx = { bb, db, host, runPolicyFor: () => ({ pools:{ verification:2 } }), secrets:{ resolve: async () => null } };
    // The pool is full (other tasks' Studio tests, Vampirism Fire 2026-10-24): the check waits until a slot frees.
    let free!: () => void;
    const slot = new Promise<void>((resolve) => { free = resolve; });
    const services = { runWriterPool:{ acquire: async () => { await slot; return () => undefined; } } };
    const verify = createWriterVerify(ctx as never, services as never);
    const done = verify.runVerification({ hostId:"h", projectId:"P" } as never,
      task([{ command:"cd game && python3 -I scripts/studio_test.py --filter T00", cwd:root }]), "lprun_vf", "thr_yi3sjj9g36");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(checksInFlight("thr_yi3sjj9g36")?.pool).toBe("verification:lprun_vf");
    free();
    expect((await done).map((row) => row.exitCode)).toEqual([0]);
    expect(checksInFlight("thr_yi3sjj9g36")).toBeNull();
  });

  it("a pool's movement is the last check that started or ended in it", () => {
    const end = beginChecks("thr_a", "verification:lprun_x", 1_000);
    expect(checksInFlight("thr_a")).toEqual({ pool:"verification:lprun_x", movedAt:1_000 });
    checksMoved("verification:lprun_x", 5_000);
    expect(checksInFlight("thr_a")?.movedAt).toBe(5_000);
    const again = beginChecks("thr_a", "verification:lprun_x", 9_000);
    end();
    expect(checksInFlight("thr_a")).not.toBeNull();
    again();
    again();
    expect(checksInFlight("thr_a")).toBeNull();
  });
});
