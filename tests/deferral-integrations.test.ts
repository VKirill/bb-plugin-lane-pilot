import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { deferralMigrations } from "../src/rooms/deferral";
import { pmDeferralLines } from "../src/rooms/deferral/server";
import { insertDeferral, type Deferral } from "../src/rooms/deferral/store";
import { createRelay, TASK_NOTICE, type RelayItem } from "../src/rooms/relay/server/relay";
import { openDatabase, type TaskOutcome } from "../src/rooms/storage/database";

// SMA rule 5, "turns red by itself": the drill, the PM's task-result message and the daily Telegram line read the register.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));
const daily = readFileSync(new URL("../scripts/lp-metrics-daily.sh", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY = 86_400_000;

const row = (patch: Partial<Deferral>): Deferral => ({
  id: "dfr_000000000001", projectId: null, what: "thing", kind: "gate", area: "", dueAt: null, dueSource: null, ownerRef: null, ownerQuote: null,
  state: "open", history: [], source: "cli", createdAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY, closedAt: null, closedBy: null, ...patch,
});

function database() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

/** Runs scenario_deferrals against a fake `bb` whose `plugin rpc call` prints `reply` (or fails with `failure`); returns the verdict and the refs it sent. */
function runDrill(reply: unknown, failure?: string) {
  const dir = mkdtempSync(join(tmpdir(), "lp-drill-deferrals-"));
  const fake = join(dir, "bb");
  writeFileSync(join(dir, "reply.json"), JSON.stringify({ result: reply }));
  writeFileSync(fake, `#!/bin/sh
# argv: plugin rpc call lane-pilot deferral_list --input-file F --json
[ "$5" = "deferral_list" ] || { echo "unexpected: $*" >&2; exit 5; }
cp "$7" "${dir}/input.json"
${failure ? `echo '${failure}' >&2; exit 1` : `cat "${dir}/reply.json"`}
`);
  chmodSync(fake, 0o755);
  const code = `
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.scenario_deferrals(pathlib.Path("/tmp"))))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000, env: { ...process.env, BB_CLI: fake } });
  const line = res.stdout.trim().split("\n").pop() ?? "";
  let input: { refs: string[] } | null = null;
  try { input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8")); } catch { /* the call did not happen */ }
  return { res, input, verdict: line.startsWith("{") ? JSON.parse(line) as { result: string; problems: string[]; registerDeployed: boolean; counts?: Record<string, number> } : null };
}

describe("the drill's deferrals scenario", () => {
  it("passes on a clean register, sends every id cited beside a skipped test, and counts entries without a term", () => {
    const { verdict, input } = runDrill({ counts: { open: 1, overdue: 0, closed: 0, needs_owner_term: 21 }, overdue: [], needsOwnerTerm: new Array(21).fill({}), entries: [], badRefs: [] });
    expect(verdict).toMatchObject({ result: "pass", problems: [], registerDeployed: true });
    expect(input!.refs).toContain("dfr_seed_skip_pipeline");
    expect(input!.refs.length).toBeGreaterThan(10);
  });

  it("fails on an overdue deferral and says how to close it or get a new date from the owner", () => {
    const { verdict } = runDrill({ counts: {}, overdue: [{ id: "dfr_abc123abc123", kind: "drill_scenario", what: "reload scenario", due: "2026-11-05" }], needsOwnerTerm: [], entries: [], badRefs: [] });
    expect(verdict!.result).toBe("fail");
    expect(verdict!.problems).toHaveLength(1);
    expect(verdict!.problems[0]).toMatch(/overdue deferral dfr_abc123abc123 \(drill_scenario: reload scenario\): the owner's term 2026-11-05 passed/);
    expect(verdict!.problems[0]).toMatch(/bb lane-pilot defer-close dfr_abc123abc123 --evidence/);
    expect(verdict!.problems[0]).toMatch(/new date from the owner.*bb lane-pilot defer dfr_abc123abc123 --owner-msg/);
  });

  it("fails on a skipped test that cites an entry the register lacks or holds closed", () => {
    const { verdict } = runDrill({ counts: {}, overdue: [], needsOwnerTerm: [], entries: [], badRefs: [{ id: "dfr_x", problem: "unknown" }, { id: "dfr_y", problem: "closed" }] });
    expect(verdict!.result).toBe("fail");
    expect(verdict!.problems[0]).toMatch(/deferral:dfr_x, which is not in the register/);
    expect(verdict!.problems[1]).toMatch(/deferral:dfr_y, which is closed/);
  });

  it("passes with a note while the running plugin has no register yet, and fails when the register cannot be read for another reason", () => {
    const old = runDrill(null, "error: unknown rpc method deferral_list");
    expect(old.verdict).toMatchObject({ result: "pass", registerDeployed: false });
    const broken = runDrill(null, "error: hub unreachable");
    expect(broken.verdict!.result).toBe("fail");
    expect(broken.verdict!.problems[0]).toMatch(/could not be read: .*hub unreachable/);
  });
});

describe("what the PM reads before it promises a date", () => {
  it("lists the overdue and the open deferrals of its project and the global ones, not those without a term, not other projects'", () => {
    const db = database();
    insertDeferral(db, row({ id: "dfr_000000000001", what: "reload drill", dueAt: NOW - DAY, dueSource: "explicit", state: "overdue" }));
    insertDeferral(db, row({ id: "dfr_000000000002", what: "stale open row", dueAt: NOW - 2 * DAY, state: "open" }));
    insertDeferral(db, row({ id: "dfr_000000000003", what: "later", dueAt: NOW + 5 * DAY, projectId: "P" }));
    insertDeferral(db, row({ id: "dfr_000000000004", what: "other project", dueAt: NOW - DAY, projectId: "Q", state: "overdue" }));
    insertDeferral(db, row({ id: "dfr_000000000005", what: "no term", state: "needs_owner_term" }));
    insertDeferral(db, row({ id: "dfr_000000000006", what: "done", dueAt: NOW - DAY, state: "closed" }));
    const text = pmDeferralLines(db, "P", NOW).join("\n");
    expect(text).toContain("- overdue 2:");
    expect(text).toContain("reload drill (dfr_000000000001, term 2026-11-09)");
    expect(text).toContain("stale open row (dfr_000000000002");
    expect(text).toContain("- open 1, next term 2026-11-15");
    expect(text).toContain("An overdue term turns the deploy drill red");
    expect(text).not.toMatch(/other project|no term|done/);
    expect(pmDeferralLines(db, "R", NOW).join("\n")).toContain("overdue 2");
    expect(pmDeferralLines(database(), "P", NOW)).toEqual([]);
  });

  it("comes with the batched task-result message of the relay", async () => {
    const db = database();
    insertDeferral(db, row({ what: "reload drill", dueAt: NOW - DAY, state: "overdue" }));
    let items: RelayItem[] = [];
    const sent: string[] = [];
    let reported = false;
    const relay = createRelay({
      load: async () => structuredClone(items), save: async (next) => { items = structuredClone(next); },
      send: async (_thread, text) => { sent.push(text); }, settled: async () => false, output: async () => "", busy: async () => false,
      taskStates: async () => ({}),
      taskOutcomes: async () => reported ? [] : [{ transitionId: 1, attemptId: "a1", projectId: "P", pmThreadId: "pm", taskId: "t1", state: "accepted", reason: null, at: NOW - TASK_NOTICE.quietMs } satisfies TaskOutcome],
      tasksAtWork: async () => [], markReported: async () => { reported = true; },
      deferralLines: (projectId) => pmDeferralLines(db, projectId, NOW),
      now: () => NOW, log: () => undefined,
    });
    await relay.sweep();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("- t1 — accepted");
    expect(sent[0]).toContain("Deferrals (read before you promise a date");
    expect(sent[0]).toContain("- overdue 1: reload drill");
  });
});

describe("the daily Telegram line", () => {
  const sql = /dfr=\$\(day "(select 'Отсрочки.*?)" 2>\/dev\/null\)/s.exec(daily)![1]!;

  function line(rows: Array<Partial<Deferral>>) {
    const db = new Database(":memory:");
    for (const statement of deferralMigrations) db.exec(statement);
    rows.forEach((patch, index) => insertDeferral(db, row({ id: `dfr_00000000000${index}`, ...patch })));
    const cell = db.prepare(sql.replaceAll("$now_ms", String(NOW))).pluck().get() as string;
    db.close();
    return cell;
  }

  it("counts overdue, open and the entries that need a term from the owner, and names the overdue", () => {
    expect(line([
      { what: "reload drill", dueAt: NOW - DAY, state: "overdue" },
      { what: "stale", dueAt: NOW - 3 * DAY, state: "open" },
      { what: "soon", dueAt: NOW + DAY },
      { what: "t1", state: "needs_owner_term" }, { what: "t2", state: "needs_owner_term" },
      { what: "done", dueAt: NOW - DAY, state: "closed" },
    ])).toBe("Отсрочки: просрочено 2, открыто 1, нужен срок от владельца 2 (просрочено: stale [dfr_000000000001]; reload drill [dfr_000000000000])");
  });

  it("is a line of zeros on an empty register and is added to the message only when the query answered", () => {
    expect(line([])).toBe("Отсрочки: просрочено 0, открыто 0, нужен срок от владельца 0");
    expect(daily).toContain("${dfr:+ ${dfr}.}");
    expect(daily).toContain(`2>/dev/null) || dfr=""`);
  });
});
