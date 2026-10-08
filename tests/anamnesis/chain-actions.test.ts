import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anamnesisHandler } from "../../src/rooms/anamnesis/host";
import { createHub } from "../../src/rooms/anamnesis/hub";
import { checkArtifact, publicFacts, registerAnamnesisActions } from "../../src/rooms/anamnesis/chain-actions";

/** A8: the chains read the public, confirmed records only, and what they write is checked against them. Real store, no Jev. */
const previous = process.env.LANE_PILOT_ANAMNESIS_DIR;
let hub: ReturnType<typeof createHub>;
const at = Date.UTC(2026, 5, 1);

beforeEach(async () => {
  process.env.LANE_PILOT_ANAMNESIS_DIR = mkdtempSync(join(tmpdir(), "anamnesis-chain-"));
  hub = createHub({
    hostCall: async (hostId, request) => (await anamnesisHandler({ requestedHostId: hostId, request })).response,
    listHosts: async () => [{ id: "mini", name: "Mac mini", connected: true }], kv: { get: async () => null, set: async () => undefined },
  });
  const ev = (ref: string) => [{ source: "git", ref, at }];
  await hub.ask({ op: "upsert", actor: "auto:git", reason: "t", records: [
    { kind: "project", key: "Lane Pilot", title: "Lane Pilot", statement: "Orchestrator, see https://lanepilot.example", evidence: ev("a@1"), firstSeen: at, lastSeen: at },
    { kind: "project", key: "Private plan", title: "Private plan", statement: "the secret project", evidence: ev("a@2") },
    { kind: "project", key: "Draft one", title: "Draft one", statement: "never confirmed", evidence: ev("a@3") },
    { kind: "person", key: "Anna", title: "Anna the client", attributes: { relation: "client" }, evidence: ev("a@4") },
  ] });
  // Public marking is the owner's: the edit is the owner's call.
  await hub.ask({ op: "edit", id: "project:lane-pilot", patch: { sensitivity: "public", status: "confirmed" }, reason: "owner" });
  await hub.ask({ op: "edit", id: "project:private-plan", patch: { sensitivity: "private", status: "confirmed" }, reason: "owner" });
  await hub.ask({ op: "edit", id: "project:draft-one", patch: { sensitivity: "public" }, reason: "owner" });
  await hub.ask({ op: "edit", id: "person:anna", patch: { status: "confirmed" }, reason: "owner" });
});
afterEach(() => { if (previous === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previous; });

describe("anamnesis.public", () => {
  it("returns what is both public and confirmed, and nothing else", async () => {
    const facts = await publicFacts(hub, "site");
    expect(facts).toMatchObject({ records: 1, empty: false });
    expect(facts.text).toContain("Lane Pilot");
    expect(facts.text).not.toMatch(/Private plan|secret project|Draft one|Anna/);
    // A draft marked public is still a draft: not shown. The sensitive count is not even mentioned in a public view.
    expect(facts.text).not.toMatch(/sensitive/);
  });

  it("is empty when the owner has marked nothing, for every view", async () => {
    await hub.ask({ op: "edit", id: "project:lane-pilot", patch: { sensitivity: "private" }, reason: "owner" });
    for (const view of ["site", "resume", "year"] as const) expect(await publicFacts(hub, view, 2026)).toMatchObject({ records: 0, empty: true });
  });

  it("the year view is the year review of that year, public only", async () => {
    const facts = await publicFacts(hub, "year", 2026);
    expect(facts.text).toContain("Year in review 2026");
    expect(facts.text).toContain("Lane Pilot (started");
    expect(facts.text).not.toMatch(/Private plan|Anna/);
    expect((await publicFacts(hub, "year", 2019)).text).toContain("Nothing recorded for this year yet.");
  });

  it("is registered as an action that reads the view and year of its node", async () => {
    const executors = new Map<string, { run: (c: unknown) => Promise<{ output: Record<string, unknown> }> }>();
    registerAnamnesisActions({ register: (key: string, executor: never) => { executors.set(key, executor); } } as never, {} as never, () => hub);
    const node = (params: Record<string, unknown>) => ({ node: { type: "action", params }, template: (value: unknown) => value });
    expect((await executors.get("anamnesis.public")!.run(node({ view: "site" }))).output).toMatchObject({ records: 1, empty: false });
    expect((await executors.get("anamnesis.public")!.run(node({ view: "year", year: 2026 }))).output.text).toContain("Year in review 2026");
    await expect(executors.get("anamnesis.public")!.run(node({ view: "everything" }))).rejects.toThrow(/view must be/);
    expect((await executors.get("anamnesis.check")!.run(node({ artifact: "see https://x.example", facts: "" }))).output).toEqual({ ok: false, violations: ["url_unknown:https://x.example"] });
  });
});

describe("anamnesis.check", () => {
  const FACTS = "Orchestrator, see https://lanepilot.example/ and write to me@kirill.example";

  it("lets through a text whose links and addresses are in the facts, and the page's own markup links", () => {
    expect(checkArtifact('<a href="https://lanepilot.example">Lane Pilot</a> me@kirill.example <svg xmlns="http://www.w3.org/2000/svg"></svg>', FACTS)).toEqual([]);
  });

  it("refuses an invented link or address, a draft mark, an empty text and an enormous one", () => {
    expect(checkArtifact("see https://invented.example/page and ceo@invented.example", FACTS)).toEqual(["url_unknown:https://invented.example/page", "email_unknown:ceo@invented.example"]);
    expect(checkArtifact("Lane Pilot [draft]", FACTS)).toEqual(["draft_mark"]);
    expect(checkArtifact("   ", FACTS)).toEqual(["empty_artifact"]);
    expect(checkArtifact("x".repeat(60_001), FACTS)).toEqual(["too_long:60001"]);
  });
});
