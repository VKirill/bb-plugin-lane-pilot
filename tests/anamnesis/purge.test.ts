import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnamnesisCli } from "../../src/rooms/anamnesis/cli";
import { hostContract } from "../../src/rooms/contracts";
import { anamnesisHandler } from "../../src/rooms/anamnesis/host";
import { createHub, type Hub } from "../../src/rooms/anamnesis/hub";

/** The one-shot cleanup of what the first load put into the portrait that is not about the owner as a person. */
const previousDir = process.env.LANE_PILOT_ANAMNESIS_DIR;
let hub: Hub, store: string;
beforeEach(() => {
  store = join(mkdtempSync(join(tmpdir(), "anamnesis-purge-")), "store");
  process.env.LANE_PILOT_ANAMNESIS_DIR = store;
  hub = createHub({
    hostCall: async (hostId, request) => hostContract.anamnesis.output.parse(await anamnesisHandler(hostContract.anamnesis.input.parse({ requestedHostId: hostId, request }))).response,
    listHosts: async () => [{ id: "host_mini", name: "MAC Mini", connected: true }],
    kv: { get: async () => undefined, set: async () => undefined },
  });
});
afterEach(() => { if (previousDir === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previousDir; });

const AT = Date.UTC(2026, 5, 1);
type Source = "journal" | "registry" | "lp-runs" | "claude-memory" | "bb-memory" | "git" | "bb-message";
const put = (key: string, source: Source, extra: Record<string, unknown> = {}, kind = "fact") =>
  hub.ask({ op: "upsert", actor: `auto:${source}`, reason: "load", records: [{ kind, key, title: key, statement: key, evidence: [{ source, ref: `${source}:${key}`, at: AT }], ...extra }] });

async function seed() {
  for (const source of ["journal", "registry", "lp-runs"] as const) await hub.ask({ op: "sources", set: { source, enabled: true } });   // as they were on at the first load
  await put("journal entry", "journal", {}, "event");
  await put("registry row", "registry", {}, "project");
  await put("lp project", "lp-runs", {}, "project");
  await put("claude project note", "claude-memory", { attributes: { type: "project" } });
  await put("claude reference", "claude-memory", { attributes: { type: "reference" } });
  await put("claude user fact", "claude-memory", { attributes: { type: "user" } });
  await put("claude feedback", "claude-memory", { attributes: { type: "feedback" } }, "preference");
  await put("bb decision", "bb-memory", { attributes: { memoryKind: "decision" } });
  await put("bb preference", "bb-memory", { attributes: { memoryKind: "preference" } }, "preference");
  await put("message project", "bb-message", { attributes: { bbProjectId: "proj_bb", messages: 40 } }, "project");
  await put("jev fragment", "bb-message", { attributes: { origin: "jev-fragment" } });
  await put("git skill", "git", {}, "skill");
  // Mixed evidence: one personal source is enough to keep it.
  await hub.ask({ op: "upsert", actor: "auto:mix", reason: "load", records: [{ kind: "fact", key: "journal and chat", title: "journal and chat", statement: "x", evidence: [{ source: "journal", ref: "j:1", at: AT }, { source: "bb-message", ref: "thr_1:2:0", at: AT }] }] });
  // A record the owner confirmed from a technical source stays, and so does one he has touched while still a draft.
  await put("confirmed journal", "journal", {}, "event");
  await hub.ask({ op: "edit", id: "event:confirmed-journal", patch: { status: "confirmed" }, reason: "owner" });
  await put("touched registry", "registry", {}, "project");
  await hub.ask({ op: "edit", id: "project:touched-registry", patch: { statement: "my own words", status: "draft" }, reason: "owner" });
  // A legacy draft with infrastructure text, written before the filter existed (straight into the file).
  const db = new DatabaseSync(join(store, "anamnesis.db"));
  db.prepare("INSERT INTO records(id,kind,title,statement,attributes,sensitivity,confidence,status,first_seen,last_seen,manual_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("fact:legacy-infra", "fact", "ssh to the hub", "ssh -i ~/.ssh/key root@10.0.0.5", "{}", "private", 0.6, "draft", AT, AT, 0, AT, AT);
  db.prepare("INSERT INTO evidence(record_id,source,ref,at) VALUES (?,?,?,?)").run("fact:legacy-infra", "bb-message", "thr_9:1:0", AT);
  db.close();
}

const ids = async () => (await hub.ask({ op: "list", includeSensitive: true, limit: 500 })).records.map((r) => r.id).sort();

describe("purge-technical", () => {
  it("counts what it would delete without deleting anything (dry run)", async () => {
    await seed();
    const before = await ids();
    const report = await hub.ask({ op: "purge_technical", dryRun: true });
    expect(report).toMatchObject({ dryRun: true, deleted: 8 });
    expect(await ids()).toEqual(before);
  });

  it("deletes drafts that came only from project data or look like infrastructure, and keeps everything else", async () => {
    await seed();
    const report = await hub.ask({ op: "purge_technical" });
    expect(report).toMatchObject({ dryRun: false, deleted: 8, byReason: { technical_source: 6, project_activity: 1, infrastructure: 1 }, byStatus: { draft: 8 } });
    expect(report.byKind).toMatchObject({ event: 1, project: 3, fact: 4 });
    expect(await ids()).toEqual([
      "event:confirmed-journal", "fact:claude-user-fact", "fact:jev-fragment", "fact:journal-and-chat", "preference:bb-preference", "preference:claude-feedback",
      "project:touched-registry", "skill:git-skill",
    ]);
    // Confirmed and touched records are counted as kept, never deleted.
    expect(report.kept).toEqual({ confirmed: 1, ownerTouched: 1 });
    expect((await hub.ask({ op: "get", id: "event:confirmed-journal" })).record).toMatchObject({ status: "confirmed" });
    expect((await hub.ask({ op: "get", id: "project:touched-registry" })).record).toMatchObject({ statement: "my own words" });
    // Done once: the next run finds nothing.
    expect(await hub.ask({ op: "purge_technical" })).toMatchObject({ deleted: 0 });
  });

  it("is a command: bb lane-pilot anamnesis purge-technical [--dry-run] reports counts", async () => {
    await seed();
    const dry = await runAnamnesisCli(["purge-technical", "--dry-run"], { hub });
    expect(dry.stdout).toContain("would delete 8 of");
    const real = await runAnamnesisCli(["purge-technical"], { hub });
    expect(real.stdout).toContain("deleted 8 of");
    expect(real.stdout).toMatch(/technical_source/);
    expect(real.stdout).toContain("1 confirmed, 1 touched by you");
  });
});
