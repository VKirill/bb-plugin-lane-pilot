import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  buildProfileReport,
  helperThreads,
  latestProfileCheck,
  profileCheckMorningLine,
  saveProfileCheck,
} from "../src/rooms/native-agent";
import { coreRequiredSessionAdvertisement, type RequiredSessionAdvertisement } from "../src/rooms/contracts/helper-context";
import { createProfileCheck, PROFILE_CHECK_OWNER_KEY } from "../src/rooms/native-agent/server/profile-check";
import { openDatabase } from "../src/rooms/plugin-db";

const NOW = Date.UTC(2026, 10, 6, 9, 0, 0);
const HOUR = 3_600_000;

/** The slice of BB's core database the check reads: `threads` + `thread_plugin_metadata`. */
function core(threads: Array<{ id: string; role: string | null; at?: number; probe?: boolean; bench?: boolean; parent?: string | null; plugin?: string; policy?: object | null }>) {
  const db = new Database(":memory:");
  db.exec(`create table threads(id text primary key, created_at integer not null, parent_thread_id text, visibility text default 'hidden');
    create table thread_plugin_metadata(thread_id text not null, plugin_id text not null, metadata_json text not null, primary key(thread_id, plugin_id));`);
  for (const thread of threads) {
    db.prepare("insert into threads values (?, ?, ?, 'hidden')").run(thread.id, thread.at ?? NOW - HOUR, thread.parent === undefined ? "thr_parent" : thread.parent);
    const metadata = { ...(thread.role ? { role: thread.role } : {}), ...(thread.probe ? { helperProbe: true } : {}), ...(thread.bench ? { lanePilotBench: true } : {}) };
    db.prepare("insert into thread_plugin_metadata values (?, 'lane-pilot', ?)").run(thread.id, JSON.stringify(metadata));
    if (thread.policy) db.prepare("insert into thread_plugin_metadata values (?, '__vk.required-session-policy', ?)").run(thread.id, JSON.stringify(thread.policy));
  }
  return db;
}

const policy = (over: { skills?: string[]; mcpServers?: string[]; bbPlugins?: string[] } = {}) => ({
  version: 1,
  policy: {
    bbPlugins: { mode: "allow", names: ["environment-project-checkout", "project-folders", ...(over.bbPlugins ?? [])], allOf: [] },
    skills: { mode: "allow", names: over.skills ?? [], allOf: [] },
    mcpServers: { mode: "allow", names: ["bb-bridge", ...(over.mcpServers ?? [])], allOf: [] },
    claudeAiSync: false,
  },
});

const agents = (advertised: RequiredSessionAdvertisement | null) =>
  advertised === null ? {} : { experimental_vkRequiredSessionPolicy: () => advertised };

/** A writer profile: skills writer-practices + karpathy-guidelines, mcpServers gitnexus + metamcp. */
const writerPolicy = () => policy({ skills: ["writer-practices", "karpathy-guidelines"], mcpServers: ["gitnexus", "metamcp"] });

function pluginDb() {
  const db = new Database(":memory:");
  db.exec("create table lane_pilot_profile_check (id integer primary key, at integer not null, report_json text not null)");
  return db;
}

describe("the profile check report", () => {
  it("all good: every helper carries a policy, capability required, provider rows match — green", () => {
    const report = buildProfileReport({
      threads: [
        { threadId: "w1", role: "writer", policyJson: JSON.stringify(writerPolicy()) },
        { threadId: "c1", role: "code-critic", policyJson: JSON.stringify(policy({ mcpServers: ["gitnexus"] })) },
        { threadId: "e1", role: "errand", policyJson: JSON.stringify(policy({ skills: ["browser-automation", "computer-use", "env-catalog"], bbPlugins: ["browser-automation", "env-catalog"] })) },
      ],
      agents: agents(coreRequiredSessionAdvertisement()),
      now: NOW,
    });
    expect(report.red).toEqual([]);
    expect(report.unverified).toBeNull();
    expect(report.requiredSessionPolicy).toBe("required");
    expect(report.providers.every((row) => row.ok)).toBe(true);
    expect(report.withPolicy).toBe(3);
    expect(report.noPolicy).toBe(0);
    expect(report.narrowed).toBe(0);
  });

  it("one helper without a policy: red naming the role", () => {
    const report = buildProfileReport({
      threads: [
        { threadId: "w1", role: "writer", policyJson: JSON.stringify(writerPolicy()) },
        { threadId: "w2", role: "writer", policyJson: null },
        { threadId: "p1", role: "pm-reader", policyJson: JSON.stringify(policy()) },
      ],
      agents: agents(coreRequiredSessionAdvertisement()),
      now: NOW,
    });
    expect(report.red.some((line) => line.includes("writer"))).toBe(true);
    expect(report.noPolicy).toBe(1);
    expect(report.roles.find((row) => row.role === "writer")).toMatchObject({ total: 2, withPolicy: 1, noPolicy: 1 });
  });

  it("a drifted provider row: red naming the provider", () => {
    const drifted = JSON.parse(JSON.stringify(coreRequiredSessionAdvertisement())) as RequiredSessionAdvertisement;
    (drifted.providerGroups as Record<string, readonly string[]>).opencode2 = ["bbPlugins", "nativePlugins"];
    const report = buildProfileReport({
      threads: [{ threadId: "w1", role: "writer", policyJson: JSON.stringify(writerPolicy()) }],
      agents: agents(drifted),
      now: NOW,
    });
    expect(report.red.some((line) => line.includes("opencode2"))).toBe(true);
    expect(report.providers.find((row) => row.provider === "opencode2")).toMatchObject({ ok: false });
  });

  it("no capability: red says requiredSessionPolicy «none», expected «required»", () => {
    const report = buildProfileReport({ threads: [], agents: agents(null), now: NOW });
    expect(report.requiredSessionPolicy).toBe("none");
    expect(report.red.some((line) => line.includes("requiredSessionPolicy"))).toBe(true);
  });

  it("a parent ceiling that cut a profile skill below the role list counts as narrowed", () => {
    const cut = writerPolicy();
    (cut.policy.skills.names as string[]).splice(cut.policy.skills.names.indexOf("karpathy-guidelines"), 1);
    const report = buildProfileReport({
      threads: [
        { threadId: "w1", role: "writer", policyJson: JSON.stringify(writerPolicy()) },
        { threadId: "w2", role: "writer", policyJson: JSON.stringify(cut) },
      ],
      agents: agents(coreRequiredSessionAdvertisement()),
      now: NOW,
    });
    expect(report.narrowed).toBe(1);
    expect(report.red).toEqual([]);
  });
});

describe("helperThreads over the core tables", () => {
  it("reads only hidden child helpers of the window, by marker not by role name", () => {
    const db = core([
      { id: "w", role: "writer" },
      // A real writer without a policy stays in; probes and bench lanes leave by their markers.
      { id: "probe-writer", role: "writer", probe: true },
      { id: "bench", role: "writer", bench: true },
      // A root thread is not a child helper even when it carries a role.
      { id: "root", role: "writer", parent: null },
      { id: "pm", role: "pm" },
      { id: "wp", role: "workspace-provisioner" },
      { id: "norole", role: null },
      { id: "old", role: "writer", at: NOW - 30 * HOUR },
    ]);
    // pm/provisioner return in the raw rows (rolePolicyCounts drops them); markers, roots, old and role-less do not.
    expect(helperThreads(db, NOW - 24 * HOUR).map((row) => row.threadId).sort()).toEqual(["pm", "w", "wp"]);
  });

  it("reads the plugin marker exactly: a look-alike plugin id does not match", () => {
    const db = new Database(":memory:");
    db.exec(`create table threads(id text primary key, created_at integer not null, parent_thread_id text);
      create table thread_plugin_metadata(thread_id text not null, plugin_id text not null, metadata_json text not null, primary key(thread_id, plugin_id));
      insert into threads values ('x', ${NOW - HOUR}, 'thr_parent'), ('y', ${NOW - HOUR}, 'thr_parent');
      insert into thread_plugin_metadata values ('x', 'lane-pilot-junior', '{"role":"writer"}'), ('y', 'lane-pilot', '{"role":"writer"}');`);
    expect(helperThreads(db, NOW - 24 * HOUR).map((row) => row.threadId)).toEqual(["y"]);
  });
});

describe("the check against an owner item", () => {
  /** A real plugin base (lane_pilot_owner_item, lane_pilot_profile_check) and a file the check can open as the core base. */
  function rig(threads: Array<{ id: string; role: string; policy?: object | null }>, advertised: RequiredSessionAdvertisement | null = coreRequiredSessionAdvertisement()) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const dir = mkdtempSync(join(tmpdir(), "lp-profile-check-"));
    const corePath = join(dir, "bb.db");
    const coreDb = new Database(corePath);
    coreDb.exec(`create table threads(id text primary key, created_at integer not null, parent_thread_id text);
      create table thread_plugin_metadata(thread_id text not null, plugin_id text not null, metadata_json text not null, primary key(thread_id, plugin_id));`);
    for (const thread of threads) {
      coreDb.prepare("insert into threads values (?, ?, 'thr_parent')").run(thread.id, NOW - HOUR);
      coreDb.prepare("insert into thread_plugin_metadata values (?, 'lane-pilot', ?)").run(thread.id, JSON.stringify({ role: thread.role }));
      if (thread.policy) coreDb.prepare("insert into thread_plugin_metadata values (?, '__vk.required-session-policy', ?)").run(thread.id, JSON.stringify(thread.policy));
    }
    coreDb.close();
    (bb as { agents?: unknown }).agents = advertised === null ? {} : { experimental_vkRequiredSessionPolicy: () => advertised };
    const api = createProfileCheck({ db, bb, log: () => undefined, isDisposed: () => false } as never).profileCheck;
    const ownerRow = () => db.prepare("SELECT state, why FROM lane_pilot_owner_item WHERE key=?").get(PROFILE_CHECK_OWNER_KEY) as { state: string; why: string } | undefined;
    return { api, corePath, ownerRow, db };
  }

  it("red -> green -> red: the owner row closes on green and reopens on the next red", () => {
    const { api, corePath, ownerRow } = rig([{ id: "w", role: "writer", policy: null }]);
    api.check(NOW, corePath);
    expect(ownerRow()?.state).toBe("open");
    expect(ownerRow()?.why).toContain("writer");

    coreDbReuse(corePath, [{ id: "w2", role: "writer", policy: writerPolicy() }]);
    api.check(NOW + HOUR, corePath);
    expect(ownerRow()?.state).toBe("closed");

    coreDbReuse(corePath, [{ id: "w3", role: "writer", policy: null }]);
    api.check(NOW + 2 * HOUR, corePath);
    expect(ownerRow()?.state).toBe("open");
    expect(ownerRow()?.why).toContain("writer");
  });

  it("an unreadable core base is «не проверено»: report saved, no owner item", () => {
    const { api, ownerRow, db } = rig([]);
    const report = api.check(NOW, join(tmpdir(), "lp-profile-check-no-such-dir", "bb.db"));
    expect(report.unverified).not.toBeNull();
    expect(report.red).toEqual([]);
    expect(ownerRow()).toBeUndefined();
    expect(profileCheckMorningLine(db as never)).toContain("не проверено");
  });
});

/** Rewrites the core fixture file in place (the check opens it by path on every run). */
function coreDbReuse(path: string, threads: Array<{ id: string; role: string; policy?: object | null }>) {
  const coreDb = new Database(path);
  coreDb.exec("delete from threads; delete from thread_plugin_metadata;");
  for (const thread of threads) {
    coreDb.prepare("insert into threads values (?, ?, 'thr_parent')").run(thread.id, NOW - HOUR);
    coreDb.prepare("insert into thread_plugin_metadata values (?, 'lane-pilot', ?)").run(thread.id, JSON.stringify({ role: thread.role }));
    if (thread.policy) coreDb.prepare("insert into thread_plugin_metadata values (?, '__vk.required-session-policy', ?)").run(thread.id, JSON.stringify(thread.policy));
  }
  coreDb.close();
}

describe("the stored report and the morning line", () => {
  it("null before the first check, one line after — red facts are named in it", () => {
    const db = pluginDb();
    expect(profileCheckMorningLine(db)).toBeNull();
    expect(latestProfileCheck(db)).toBeNull();
    const report = buildProfileReport({
      threads: [{ threadId: "w2", role: "writer", policyJson: null }],
      agents: agents(coreRequiredSessionAdvertisement()),
      now: NOW,
    });
    saveProfileCheck(db, report);
    expect(latestProfileCheck(db)).toMatchObject({ noPolicy: 1 });
    const line = profileCheckMorningLine(db);
    expect(line).toContain("КРАСНОЕ");
    expect(line).toContain("writer");
  });
});
