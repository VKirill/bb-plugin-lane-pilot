import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { rpcContract } from "../src/rooms/contracts";
import { openDatabase } from "../src/rooms/storage/database";
import { closeOwnerItem, collectOwnerWaiting, postOwnerItem } from "../src/rooms/owner-waiting";
import { runWaitingCli } from "../src/rooms/owner-waiting/cli";
import { ackDigest, inQuietHours, loadPushConfig, planDigest, savePushConfig } from "../src/rooms/owner-waiting/push";

const HOUR = 3_600_000;
// 2026-10-22 09:00 in Madrid (CEST, UTC+2).
const NOW = Date.UTC(2026, 9, 22, 7, 0, 0);

function seeded() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("INSERT INTO lane_pilot_rule_proposal(id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,evidence_json,first_seen_at,last_seen_at,updated_at) VALUES ('r1','proj_1','s','Never edit lockfiles by hand','model','proposed',3,2,'[\"npm i changed the lock\"]','[{\"runId\":\"run_1\",\"taskId\":\"t1\",\"attemptId\":\"att_1\",\"reason\":\"lockfile edited\"}]',?,?,?)").run(NOW - 9 * HOUR, NOW - 8 * HOUR, NOW - 8 * HOUR);
  db.prepare("INSERT INTO lane_pilot_rule_proposal(id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at) VALUES ('r2','proj_1','s2','done rule','model','accepted',1,1,'[]',?,?,?)").run(NOW, NOW, NOW);
  db.prepare("INSERT INTO lane_pilot_learning_item(id,obs_id,project_id,thread_id,kind,text,reach,state,evidence,created_at) VALUES ('i1','o1','proj_1','t','preference','Prefer short answers','owner','pending_owner','you said so',?)").run(NOW - HOUR);
  const deferral = (id: string, kind: string, state: string, dueAt: number | null, what = `${id} thing`) => db.prepare("INSERT INTO lane_pilot_deferral(id,project_id,what,kind,state,due_at,owner_quote,created_at,updated_at) VALUES (?,NULL,?,?,?,?,?,?,?)").run(id, what, kind, state, dueAt, dueAt ? "до пятницы" : null, NOW - 50 * HOUR, NOW);
  deferral("dfr_a", "skipped_test", "needs_owner_term", null);
  deferral("dfr_b", "gate", "overdue", NOW - 5 * HOUR);
  deferral("dfr_c", "gate", "open", NOW + 5 * HOUR);
  deferral("dfr_d", "memory_conflict", "needs_owner_term", null);
  deferral("dfr_e", "gate", "closed", NOW - HOUR);
  db.prepare("INSERT INTO lane_pilot_memory_conflict(id,project_id,note_a,note_b,kind,subject,evidence_a,evidence_b,state,deferral_id,detected_at) VALUES ('mc1','proj_1','na','nb','value','port','port is 80','port is 8080','held','dfr_d',?)").run(NOW - 2 * HOUR);
  db.prepare("INSERT INTO lane_pilot_memory_conflict(id,project_id,note_a,note_b,kind,subject,state,detected_at) VALUES ('mc2','proj_1','nc','nd','value','x','settled',?)").run(NOW - 2 * HOUR);
  return db;
}

describe("the owner's waiting list", () => {
  it("reads every source in one shape: what, why it is the owner's, evidence, the exact action", () => {
    const waiting = collectOwnerWaiting(seeded(), NOW);
    expect(waiting.counts).toEqual({ deferral_overdue: 1, memory_conflict: 1, rule_proposal: 1, learning: 1, deferral_term: 1 });
    expect(waiting.items.map((item) => item.key)).toEqual(["deferral:dfr_b", "memory_conflict:mc1", "rule:proj_1:r1", "learning:i1", "deferral:dfr_a"]);
    for (const item of waiting.items) {
      expect(item.what.length, item.key).toBeGreaterThan(0);
      expect(item.why.length, item.key).toBeGreaterThan(20);
      expect(item.evidence.length, item.key).toBeGreaterThan(0);
      expect(item.actions.length, item.key).toBeGreaterThan(0);
      for (const action of item.actions) expect(action.cli, `${item.key} ${action.id}`).toMatch(/^(bb |echo )/);
    }
  });

  it("gives a rule proposal accept and reject as buttons that call the existing RPC, with the attempt as evidence", () => {
    const rule = collectOwnerWaiting(seeded(), NOW).items.find((item) => item.source === "rule_proposal")!;
    expect(rule.evidence[0]).toMatchObject({ kind: "attempt", ref: "att_1" });
    expect(rule.actions.map((action) => action.rpc)).toEqual([
      { method: "decide_rule_proposal", input: { projectId: "proj_1", id: "r1", action: "accept" } },
      { method: "decide_rule_proposal", input: { projectId: "proj_1", id: "r1", action: "reject" } },
    ]);
    expect(rule.actions[0]!.cli).toContain("decide_rule_proposal");
    // The RPC the button calls exists in the contract, with that input.
    expect(rpcContract.decide_rule_proposal.input.safeParse(rule.actions[0]!.rpc!.input).success).toBe(true);
  });

  it("shows a deferral's term as a command that needs the owner's own message, never as a button", () => {
    const items = collectOwnerWaiting(seeded(), NOW).items;
    for (const key of ["deferral:dfr_a", "deferral:dfr_b"]) {
      const term = items.find((item) => item.key === key)!.actions.find((action) => action.id === "term")!;
      expect(term.needsOwnerMessage).toBe(true);
      expect(term.rpc).toBeUndefined();
      expect(term.cli).toContain("--owner-msg <threadId>#<seq>");
      expect(term.hint).toContain("events-list");
    }
    // An overdue entry wakes the owner; one that only lacks a term waits on the screen.
    expect(items.find((item) => item.key === "deferral:dfr_b")!.wake).toBe(true);
    expect(items.find((item) => item.key === "deferral:dfr_a")!.wake).toBe(false);
  });

  it("counts a held memory conflict once (its deferral entry is not a second item) and names the settle command", () => {
    const items = collectOwnerWaiting(seeded(), NOW).items;
    expect(items.some((item) => item.key === "deferral:dfr_d")).toBe(false);
    const conflict = items.find((item) => item.source === "memory_conflict")!;
    expect(conflict.actions[0]!.cli).toContain("memory-conflict-settle mc1 --keep a|b|both|none --evidence");
    expect(conflict.wake).toBe(true);
  });

  it("holds the night loop's rows in a stable shape: posted once per key, shown, closed", () => {
    const db = seeded();
    const row = { key: "night:proposal:graph-1", source: "night", kind: "proposal", what: "Add a stage between plan and writer", why: "Any graph change is the owner's (policy owner_only)",
      evidence: [{ kind: "file" as const, ref: "policy/night-policy.json" }], actions: [{ id: "yes", label: "Принять", cli: "bb lane-pilot night apply graph-1" }] };
    expect(postOwnerItem(db, row, NOW).created).toBe(true);
    expect(postOwnerItem(db, row, NOW + HOUR).created).toBe(false);
    const posted = collectOwnerWaiting(db, NOW).items.find((item) => item.key === row.key)!;
    expect(posted).toMatchObject({ source: "night", wake: true, since: NOW, projectId: null, evidence: row.evidence, actions: row.actions });
    expect(collectOwnerWaiting(db, NOW).items[1]!.source).toBe("night");
    expect(() => postOwnerItem(db, { ...row, key: "k2", why: " " })).toThrow(/needs a key, what and why/);
    expect(closeOwnerItem(db, row.key, "applied in 0.1.270", NOW)).toBe(true);
    expect(closeOwnerItem(db, row.key, "again", NOW)).toBe(false);
    expect(collectOwnerWaiting(db, NOW).items.some((item) => item.key === row.key)).toBe(false);
  });

  it("reports what went red overnight (with the attempts to open) and what was accepted", () => {
    const db = seeded();
    const attempt = (id: string, state: string, at: number) => db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, "run_1", `t_${id}`, state, at, at);
    attempt("a1", "validation_failed", NOW - 3 * HOUR); attempt("a2", "validation_failed", NOW - 4 * HOUR); attempt("a3", "accepted", NOW - HOUR); attempt("a4", "validation_failed", NOW - 40 * HOUR);
    const { overnight } = collectOwnerWaiting(db, NOW);
    expect(overnight.red).toEqual([{ state: "validation_failed", count: 2, attempts: ["a1", "a2"] }]);
    expect(overnight.accepted).toBe(1);
  });

  it("works on a database from before the tables: no source breaks the read", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    for (const table of ["lane_pilot_owner_item", "lane_pilot_owner_push", "lane_pilot_owner_config"]) db.exec(`DROP TABLE ${table}`);
    expect(collectOwnerWaiting(db, NOW).items).toEqual([]);
  });
});

describe("the Telegram digest", () => {
  it("pushes only new wake items, once, and the daily report stays the reminder", () => {
    const db = seeded();
    const first = planDigest(db, NOW);
    expect(first).toMatchObject({ send: true, reason: null, keys: ["deferral:dfr_b", "memory_conflict:mc1"] });
    expect(first.text).toContain("новых — 2");
    expect(first.text).toContain("просрочена отсрочка");
    expect(first.text).not.toContain("Never edit lockfiles");
    // Not acknowledged (the send failed): the next tick offers the same keys again.
    expect(planDigest(db, NOW + HOUR).keys).toEqual(first.keys);
    expect(ackDigest(db, first.keys, NOW)).toBe(2);
    expect(ackDigest(db, first.keys, NOW)).toBe(0);
    expect(planDigest(db, NOW + HOUR)).toMatchObject({ send: false, reason: "nothing_new" });
    postOwnerItem(db, { key: "night:wall:1", source: "wall", kind: "wall", what: "Stuck: three tasks fail the same check", why: "The loop stopped", evidence: [{ kind: "text", ref: "x" }], actions: [{ id: "a", label: "a", cli: "bb lane-pilot walls" }] }, NOW + HOUR);
    expect(planDigest(db, NOW + 2 * HOUR).keys).toEqual(["night:wall:1"]);
  });

  it("is silent in quiet hours (23:00-08:00 Europe/Madrid) and sends what piled up after", () => {
    const db = seeded();
    const madrid = (hour: number, minute = 0, month = 9, day = 22) => Date.UTC(2026, month, day, hour - (month === 9 ? 2 : 1), minute);
    expect(planDigest(db, madrid(23, 30))).toMatchObject({ send: false, reason: "quiet_hours" });
    expect(planDigest(db, madrid(3))).toMatchObject({ send: false, reason: "quiet_hours" });
    expect(planDigest(db, madrid(7, 59))).toMatchObject({ send: false, reason: "quiet_hours" });
    expect(planDigest(db, madrid(8)).send).toBe(true);
    expect(planDigest(db, madrid(22, 59)).send).toBe(true);
    // Winter time (UTC+1) is read from the zone, not from a fixed offset.
    expect(inQuietHours(Date.UTC(2026, 11, 1, 22, 30), "23:00-08:00", "Europe/Madrid")).toBe(true);
    expect(inQuietHours(Date.UTC(2026, 11, 1, 21, 30), "23:00-08:00", "Europe/Madrid")).toBe(false);
    expect(inQuietHours(Date.UTC(2026, 9, 22, 10, 0), "00:00-00:00", "Europe/Madrid")).toBe(false);
    expect(inQuietHours(Date.UTC(2026, 9, 22, 10, 0), "09:00-13:00", "Europe/Madrid")).toBe(true);
  });

  it("names six items at most and counts the rest; every key is acknowledged after the send", () => {
    const db = seeded();
    for (let i = 0; i < 9; i++) postOwnerItem(db, { key: `night:p${i}`, source: "night", kind: "proposal", what: `proposal ${i}`, why: "graph change", evidence: [], actions: [] }, NOW);
    const digest = planDigest(db, NOW);
    expect(digest.keys).toHaveLength(11);
    expect(digest).toMatchObject({ shown: 6, more: 5 });
    expect(digest.text).toContain("…и ещё 5.");
  });

  it("has settings: on/off, quiet hours and time zone, refused when wrong", () => {
    const db = seeded();
    expect(loadPushConfig(db)).toEqual({ enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" });
    expect(savePushConfig(db, { quiet: "22:00-07:30", timezone: "Europe/Moscow" }, NOW)).toEqual({ enabled: true, quiet: "22:00-07:30", timezone: "Europe/Moscow" });
    expect(() => savePushConfig(db, { quiet: "25:00-08:00" })).toThrow(/HH:MM-HH:MM/);
    expect(() => savePushConfig(db, { timezone: "Mars/Base" })).toThrow(/unknown time zone/);
    expect(() => savePushConfig(db, { enabled: "maybe" })).toThrow(/on or off/);
    expect(() => savePushConfig(db, { colour: "red" })).toThrow(/unknown setting/);
    savePushConfig(db, { enabled: "off" }, NOW);
    expect(planDigest(db, NOW)).toMatchObject({ send: false, reason: "disabled" });
  });
});

describe("bb lane-pilot waiting", () => {
  it("prints the list with action lines, and digest / ack / config / post / close work from the command line", () => {
    const db = seeded();
    const list = runWaitingCli(db, [], NOW);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("Ждут владельца: 5. Ничего не блокируется.");
    expect(list.stdout).toContain("--owner-msg <threadId>#<seq>");
    expect(list.stdout).toContain("(нужно твоё сообщение)");
    const digest = JSON.parse(runWaitingCli(db, ["digest", "--json"], NOW).stdout!);
    expect(digest.keys).toHaveLength(2);
    expect(JSON.parse(runWaitingCli(db, ["ack", ...digest.keys], NOW).stdout!)).toEqual({ acknowledged: 2 });
    expect(runWaitingCli(db, ["digest"], NOW).stdout).toBe("nothing to send (nothing_new)");
    expect(JSON.parse(runWaitingCli(db, ["config", "quiet=22:00-07:00"], NOW).stdout!).quiet).toBe("22:00-07:00");
    expect(runWaitingCli(db, ["config", "quiet=nope"], NOW)).toMatchObject({ exitCode: 1 });
    expect(JSON.parse(runWaitingCli(db, ["post", JSON.stringify({ key: "n1", source: "night", kind: "k", what: "w", why: "y" })], NOW).stdout!)).toEqual({ created: true });
    expect(JSON.parse(runWaitingCli(db, ["close", "n1", "--by", "done by hand"], NOW).stdout!)).toEqual({ closed: true });
    expect(runWaitingCli(db, ["nonsense"], NOW)).toMatchObject({ exitCode: 1 });
  });

  it("says so when nothing waits", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    expect(runWaitingCli(db, [], NOW).stdout).toContain("Владельца ничто не ждёт.");
  });
});

describe("the RPCs", () => {
  it("are in the contract", () => {
    for (const method of ["owner_waiting", "owner_waiting_digest", "owner_waiting_ack", "owner_waiting_config"] as const) expect(rpcContract[method], method).toBeDefined();
  });
});
