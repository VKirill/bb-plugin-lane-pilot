import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnamnesisCli } from "../../src/anamnesis/cli";
import { anamnesisHandler } from "../../src/anamnesis/host";
import { createHub } from "../../src/anamnesis/hub";
import { profileRecords, profileSchema } from "../../src/anamnesis/profile-import";

/** A card as `bb memory-profile get --json` prints it. */
const CARD = {
  version: 14, automatic: true, updatedAt: Date.UTC(2026, 8, 30), focusConfirmedAt: Date.UTC(2026, 9, 1),
  identity: "Kirill, entrepreneur and marketer, builds agent systems", about: "Runs a small agency; works from Madrid and a Mac mini", preferences: "Reports in Russian, short, no filler",
  focus: "Lane Pilot learnability and the owner's anamnesis",
  projects: [{ key: "lane-pilot", name: "Lane Pilot", summary: "Orchestrator of coding agents", status: "active", confirmedAt: Date.UTC(2026, 9, 2) }, { key: "selfy", name: "SelfyStudio", summary: "", status: "paused", confirmedAt: Date.UTC(2026, 6, 1) }],
};

describe("the memory-profile card moves into anamnesis (A9)", () => {
  const previous = process.env.LANE_PILOT_ANAMNESIS_DIR;
  let hub: ReturnType<typeof createHub>;
  beforeEach(() => {
    process.env.LANE_PILOT_ANAMNESIS_DIR = mkdtempSync(join(tmpdir(), "anamnesis-profile-"));
    hub = createHub({
      hostCall: async (hostId, request) => (await anamnesisHandler({ requestedHostId: hostId, request })).response,
      listHosts: async () => [{ id: "mini", name: "Mac mini", connected: true }], kv: { get: async () => null, set: async () => undefined },
    });
  });
  afterEach(() => { if (previous === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previous; });
  const cli = (argv: string[]) => runAnamnesisCli(argv, { hub});

  it("turns each field into one record, with evidence that points at the card version", () => {
    const { records, skipped } = profileRecords(profileSchema.parse(CARD), 1);
    expect(records.map((r) => `${r.kind}:${r.key}`)).toEqual(["self:identity", "fact:background", "preference:profile-preferences", "fact:current-focus", "project:Lane Pilot", "project:SelfyStudio"]);
    expect(skipped).toEqual([]);
    expect((records[0]!.evidence as Array<{ ref: string }>)[0]!.ref).toBe("memory-profile:v14:identity");
    expect(profileRecords({ identity: "", about: "  " }, 1).skipped).toEqual(["identity", "about", "preferences", "focus"]);
  });

  it("confirms them as the owner's own text, so the PM's card carries what the old card did", async () => {
    const result = await hub.ask({ op: "import_profile", profile: profileSchema.parse(CARD) });
    expect(result).toMatchObject({ imported: 6, skipped: [] });
    const { records } = await hub.ask({ op: "list" });
    expect(records).toHaveLength(6);
    expect(records.every((r) => r.status === "confirmed")).toBe(true);
    const card = (await hub.ask({ op: "card" })).text;
    expect(card).toMatch(/Who: .*Kirill, entrepreneur and marketer, builds agent systems/);
    expect(card).toContain("Runs a small agency; works from Madrid and a Mac mini");
    expect(card).toContain("Preferences: Reports in Russian, short, no filler");
    expect(card).toContain("Current projects: Lane Pilot");
    const identity = (await hub.ask({ op: "get", id: "self:identity" })).record!;
    expect(identity.evidence[0]).toMatchObject({ source: "manual", ref: "memory-profile:v14:identity" });
    expect((await hub.ask({ op: "history", id: "self:identity" })).history[0]).toMatchObject({ actor: "owner", reason: "moved from the memory-profile card" });
  });

  it("a second import changes nothing, and a draft that already exists under the same name is confirmed with the card", async () => {
    await hub.ask({ op: "upsert", actor: "auto:git", reason: "t", records: [{ kind: "project", key: "Lane Pilot", title: "Lane Pilot", evidence: [{ source: "git", ref: "lp@1", at: 5 }] }] });
    expect((await hub.ask({ op: "get", id: "project:lane-pilot" })).record).toMatchObject({ status: "draft" });
    await hub.ask({ op: "import_profile", profile: profileSchema.parse(CARD) });
    expect((await hub.ask({ op: "get", id: "project:lane-pilot" })).record).toMatchObject({ status: "confirmed", statement: "Orchestrator of coding agents" });
    const again = await hub.ask({ op: "import_profile", profile: profileSchema.parse(CARD) });
    expect(again.imported).toBe(6);
    expect((await hub.ask({ op: "list" })).records).toHaveLength(6);
  });

  it("text the store refuses (a credential) is reported, not stored; a field about family stops reaching the card", async () => {
    const result = await hub.ask({ op: "import_profile", profile: profileSchema.parse({ ...CARD, about: "my SECRET_TOKEN=abcdef123456 and wife Anna", preferences: "" }) });
    expect(result.reasons).toMatchObject({ unsafe_text: 1 });
    expect(result.skipped).toEqual(["preferences"]);
    const ids = (await hub.ask({ op: "list", includeSensitive: true })).records.map((r) => r.id);
    expect(ids).not.toContain("fact:background");
    await hub.ask({ op: "import_profile", profile: profileSchema.parse({ ...CARD, about: "Lives with his wife Anna in Madrid" }) });
    expect((await hub.ask({ op: "get", id: "fact:background", includeSensitive: true })).record).toMatchObject({ sensitivity: "sensitive" });
    expect((await hub.ask({ op: "card" })).text).not.toContain("Anna");
  });

  it("the command takes the card's JSON and refuses anything else", async () => {
    expect((await cli(["import-profile"])).stderr).toMatch(/needs --profile/);
    expect((await cli(["import-profile", "--profile", "not json"])).stderr).toMatch(/not JSON/);
    expect((await cli(["import-profile", "--profile", JSON.stringify({ projects: "x" })])).stderr).toMatch(/not a memory-profile card/);
    const ok = await cli(["import-profile", "--profile", JSON.stringify(CARD)]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("moved 6 records");
  });
});
