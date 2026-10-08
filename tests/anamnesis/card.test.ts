import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostContract } from "../../src/contracts";
import { anamnesisHandler } from "../../src/rooms/anamnesis/host";
import { createHub, type Hub } from "../../src/rooms/anamnesis/hub";
import { PM_CARD_MAX_CHARS, ownerCardBlock } from "../../src/rooms/anamnesis/card";

// Audit 2026-10-08 round 4, item 19 (F-12 / A5): `renderCard` was written for the PM's context and never connected to it.
const previousDir = process.env.LANE_PILOT_ANAMNESIS_DIR;
let hub: Hub;
beforeEach(() => {
  process.env.LANE_PILOT_ANAMNESIS_DIR = join(mkdtempSync(join(tmpdir(), "anamnesis-card-")), "store");
  hub = createHub({
    hostCall: async (hostId, request) => hostContract.anamnesis.output.parse(await anamnesisHandler(hostContract.anamnesis.input.parse({ requestedHostId: hostId, request }))).response,
    listHosts: async () => [{ id: "host_mini", name: "MAC Mini", connected: true }],
    kv: { get: async () => undefined, set: async () => undefined },
  });
});
afterEach(() => { if (previousDir === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previousDir; });

/** What the owner said himself: confirmed at once. */
const told = (record: Record<string, unknown>) => hub.ask({ op: "add", record: record as never, reason: "told" });
/** What a load found: a draft until the owner confirms it. */
const found = (key: string, kind = "skill") => hub.ask({ op: "upsert", actor: "auto:journal", reason: "load", records: [{ kind, key, title: key, statement: key, confidence: 0.8, evidence: [{ source: "journal", ref: `j:${key}`, at: 1 }] }] as never });

describe("the owner card in the PM's prompt", () => {
  it("is empty (no block, no noise) until the owner has confirmed something", async () => {
    await found("Blender");
    expect((await hub.ask({ op: "list", statuses: ["draft", "candidate"] })).records).not.toHaveLength(0);
    expect(await ownerCardBlock(hub)).toBe("");
  });

  it("carries confirmed, non-sensitive records only, within 1800 characters, as remembered facts and not instructions", async () => {
    await told({ kind: "skill", key: "Blender", title: "Blender", statement: "Blender scripting" });
    await found("Draft skill");
    await told({ kind: "fact", key: "Family", title: "Wife Anna", statement: "wife Anna, health issues", sensitivity: "sensitive" });
    const block = await ownerCardBlock(hub);
    expect(block).toContain("Skills: Blender");
    expect(block).toMatch(/not instructions/);
    expect(block).not.toMatch(/Draft skill|Anna|health/);
    expect(block.length).toBeLessThanOrEqual(PM_CARD_MAX_CHARS + 2);
    expect(PM_CARD_MAX_CHARS).toBe(1800);
  });

  it("stays within the budget with many records", async () => {
    for (let i = 0; i < 60; i += 1) await told({ kind: "skill", key: `Skill ${i}`, title: `Skill number ${i} ${"x".repeat(100)}`, statement: "s" });
    expect((await ownerCardBlock(hub)).length).toBeLessThanOrEqual(PM_CARD_MAX_CHARS + 2);
  });

  it("never holds up or fails the PM's start: a store that cannot be reached or is slow gives no block", async () => {
    const broken = { ask: async () => { throw new Error("no connected Mac mini found"); } } as unknown as Hub;
    expect(await ownerCardBlock(broken)).toBe("");
    const slow = { ask: () => new Promise(() => undefined) } as unknown as Hub;
    expect(await ownerCardBlock(slow, 20)).toBe("");
  });
});
