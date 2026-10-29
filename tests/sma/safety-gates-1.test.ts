import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { scheduleIsolated } from "../../src/rooms/core/server/schedules";
import { setConveyor } from "../../src/rooms/conveyor";
import { internalIds, parityGaps, UNSHOWN_FIELDS } from "../../src/rooms/guard-tools";
import { capOf, moneyHold, spendBook } from "../../src/rooms/money";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { createPhaseDriver } from "../../src/rooms/phase/server/driver";
import { planSignature, type PlanItem } from "../../src/rooms/phase/logic";
import { savePhase } from "../../src/rooms/phase/store";
import { isHeld } from "../../src/rooms/runs/server/runs-pause";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";

describe("daemon tick gates", () => {
  it("[sma:dt_timer] a pass is registered isolated, so a tick still running is skipped instead of waited for", () => {
    const registered: Array<{ name: string; options: { isolated: boolean; overlap: string; timeoutMs: number } }> = [];
    const bb = {
      background: {
        experimental_vkSchedule(name: string, _cron: string, _fn: unknown, options: { isolated: boolean; overlap: string; timeoutMs: number }) {
          registered.push({ name, options });
        },
        schedule() { throw new Error("the isolated timer must not fall back to a schedule that waits"); },
      },
    };
    scheduleIsolated(bb as never, "daemon-pass", "*/5 * * * * *", () => undefined, { timeoutMs: 4_000 });
    expect(registered).toEqual([{ name: "daemon-pass", options: { isolated: true, timeoutMs: 4_000, overlap: "skip" } }]);
  });

  it("[sma:dt_switch] a switched-off conveyor holds a run, so no new work is issued", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const kv = bb.storage.kv;
    expect(await isHeld(kv as never, "run1")).toBe(false);
    await setConveyor(kv as never, false, "owner stopped the line");
    expect(await isHeld(kv as never, "run1")).toBe(true);
    expect(await isHeld(kv as never, "run2")).toBe(true);
    await setConveyor(kv as never, true);
    expect(await isHeld(kv as never, "run1")).toBe(false);
  });

  it.todo("[sma:dt_switch] an empty store leaves the conveyor on; off is not the factory default");

  it.todo("[sma:dt_all_busy] waitForAdmission does not skip a claim when every worker is already busy");

  it.todo("[sma:dt_lease] releaseActivation does not heartbeat a lease for an attempt that has no process");

  it.todo("[sma:dt_finally] abortable frees the schedule waiter; it does not release the writer seat or stop a lease");
});

describe("money and an overspent batch", () => {
  it("[sma:k_v_spend] [sma:k_lib_spend] the spend book prices local rows, and with no human cap nothing is held", () => {
    const now = Date.parse("2026-10-15T12:00:00.000Z");
    const book = spendBook([
      { day: "2026-10-02", providerId: "anthropic", model: "claude-haiku", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 },
      { day: "2026-10-02", providerId: "claude-code", model: "claude-sonnet", inputTokens: 5_000_000, outputTokens: 0, cachedTokens: 0 },
      { day: "2026-09-02", providerId: "anthropic", model: "claude-haiku", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 },
    ], now);
    expect(book.monthUsd).toBe(0.8);
    expect(book.byProvider.anthropic).toBe(0.8);
    expect(book.byProvider["claude-code"]).toBe(0);
    expect(capOf(undefined)).toBeNull();
    expect(capOf(0)).toBeNull();
    expect(capOf("")).toBeNull();
    expect(moneyHold("anthropic", book.monthUsd, null)).toBeNull();
    expect(moneyHold("claude-code", 999, 1)).toBeNull();
    expect(moneyHold("anthropic", 0.8, 0.8)).toMatch(/money cap/);
    expect(moneyHold("anthropic", 0.79, 0.8)).toBeNull();
  });
});

const OFF = { branch: "phase/test", trees: {}, off: "no phase branch in this test" };

function piece(id: string, appetite?: number): PlanItem {
  return {
    id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" },
    task: { id, owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["passes"], project_cwd: "/repo", ...(appetite === undefined ? {} : { appetite: { tokens: appetite } }) },
  };
}

async function driveIssue(items: PlanItem[], options: { issueCap?: number; subagents?: boolean; openAttempts?: number; budget?: { tokens: number; maxTokens: number } } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "active", environmentId: "env_pm" }));
  harness.sdk.stub("environments.get", async () => ({ path: "/work/bot", hostId: "h1" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  for (let n = 0; n < (options.openAttempts ?? 0); n += 1) {
    createTask(db, { id: `seat-${n}`, runId: "run1", kind: "bb", contract: { id: `seat-${n}` } as never });
    createAttempt(db, { id: `att-seat-${n}`, runId: "run1", taskId: `seat-${n}` });
  }
  const sent: string[] = [];
  const services = {
    dispatchWriter: async (input: { task: { id: string } }) => { sent.push(input.task.id); return { taskId: input.task.id, runId: "run1" }; },
    runBudgets: { get: () => options.budget ? { snapshot: () => ({ tokens: options.budget!.tokens, limits: { maxTokens: options.budget!.maxTokens } }) } : undefined },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Batch", goal: "pieces" });
  const sha = planSignature(items, "ctx");
  savePhase(db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, issueCap: options.issueCap, subagents: options.subagents, candidate: OFF, plan: { items, contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } } } as never, at: 2 });
  const after = await phases.drive(phases.list({ live: true })[0]!);
  return { sent, after };
}

describe("batch issue", () => {
  it("[sma:dt_overspent] a wave whose appetite does not fit the remaining budget is not issued", async () => {
    const held = await driveIssue([piece("a", 50), piece("b", 50)], { budget: { tokens: 80, maxTokens: 100 } });
    expect(held.sent).toEqual([]);
    expect(held.after.record.execution?.issueErrors?.budget).toMatch(/wave budget/);
    const fits = await driveIssue([piece("a", 10)], { budget: { tokens: 80, maxTokens: 100 } });
    expect(fits.sent).toEqual(["a"]);
  });

  it("[sma:dt_capacity] only as many pieces start as there are free seats", async () => {
    const capped = await driveIssue([piece("a"), piece("b")], { issueCap: 1 });
    expect(capped.sent).toEqual(["a"]);
    const open = await driveIssue([piece("a"), piece("b")], { issueCap: 8 });
    expect(open.sent).toEqual(["a", "b"]);
  });

  it("[sma:dt_seats] a seat already taken is not issued again, and one worker means one seat", async () => {
    const full = await driveIssue([piece("a"), piece("b")], { issueCap: 1, openAttempts: 1 });
    expect(full.sent).toEqual([]);
    const one = await driveIssue([piece("a"), piece("b")], { subagents: false, issueCap: 8 });
    expect(one.sent).toEqual(["a"]);
  });
});

describe("guard tools", () => {
  it("[sma:m_tl_rebrand_ids] a house id in a text a person reads is refused, and a placeholder is not", () => {
    expect(internalIds({
      "home.title": "Open thr_nj6fa3v9 to continue",
      "home.body": "Task {taskId} is waiting",
      "home.short": "thr_short is too small to be an id",
    })).toEqual(["home.title"]);
  });

  it("[sma:m_tl_not_shown] every field a screen does not draw has a reason of at least three words", () => {
    const entries = Object.entries(UNSHOWN_FIELDS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [field, reason] of entries) {
      expect(field).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/);
      expect(reason.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("[sma:m_tl_rules_parity] [sma:k_lib_parity] a tool only the worker has, and a tool only the person has, are both named", () => {
    expect(parityGaps(["Read", "Bash"], ["Read"])).toEqual({ onlySession: ["Bash"], onlyTerminal: [] });
    expect(parityGaps(["Read"], ["Read", "Bash"])).toEqual({ onlySession: [], onlyTerminal: ["Bash"] });
    expect(parityGaps(["Read", "Bash"], ["Bash", "Read"])).toEqual({ onlySession: [], onlyTerminal: [] });
  });

  it.todo("[sma:m_tl_rebrand] leaks() matches secret shapes, not the old brand, colours, or internal ids");

  it("[sma:k_lib_actionclient] a writer command is refused until the controller grants it, and the grant is used once", () => {
    const dir = mkdtempSync(join(tmpdir(), "sma-permit-"));
    const hook = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
    try {
      const out = execFileSync("python3", ["-c", `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("guard_shell", ${JSON.stringify(hook)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.PERMIT_DIR = __import__("pathlib").Path(${JSON.stringify(dir)})
p = {"session_id": "s1", "cwd": ${JSON.stringify(dir)}}
cmd = "rm customer.csv"
os.environ.pop("LANE_PILOT_ROLE", None)
flat = mod._permit_or_ticket(p, cmd, "delete_for_good", "REFUSED")
assert flat == "REFUSED", flat
os.environ["LANE_PILOT_ROLE"] = "writer"
first = mod._permit_or_ticket(p, cmd, "delete_for_good", "REFUSED")
assert first and "Permit ticket" in first and "REFUSED" in first, first
folder = list(mod.PERMIT_DIR.glob("s1"))[0]
digest = next(folder.glob("*.ticket.json")).name.split(".")[0]
(folder / f"{digest}.answer.json").write_text(json.dumps({"decision": "allow"}))
second = mod._permit_or_ticket(p, cmd, "delete_for_good", "REFUSED")
assert second is None, second
third = mod._permit_or_ticket(p, cmd, "delete_for_good", "REFUSED")
assert third and "Permit ticket" in third, third
print("ok")
`], { encoding: "utf8" });
      expect(out.trim()).toBe("ok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("guards the pointed code does not keep", () => {
  it.todo("[sma:k_lib_stpa] a lane session is refused writes to protections; a disabled protection is not re-armed");
  it.todo("[sma:k_v_gates] gateTriagePrompt has no full-gate marker, firing report, or false-alarm ack");
  it.todo("[sma:k_v_breaker] a failed answers probe is not a list of tripped rules you re-arm after review");
  it.todo("[sma:k_v_evidence] [sma:k_lib_evidence] recordStage does not store a reason and checks before a force push or a foreign-claim clear");
});
