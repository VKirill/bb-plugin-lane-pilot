import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostContract, rpcContract } from "../../src/rooms/contracts";
import { runAnamnesisCli } from "../../src/rooms/anamnesis/cli";
import { createHub, type HostInfo } from "../../src/rooms/anamnesis/hub";
import { anamnesisHandler } from "../../src/rooms/anamnesis/host";
import type { AnamnesisRequest } from "../../src/rooms/anamnesis/ops";

const T0 = Date.UTC(2026, 2, 1);
let hostCalls: Array<{ hostId: string; request: AnamnesisRequest }>;
let kv: Map<string, unknown>;
let hosts: HostInfo[];
const previousDir = process.env.LANE_PILOT_ANAMNESIS_DIR;

/** A hub whose host call goes through the real contract schemas and the real host handler, against a temp folder. */
function makeHub() {
  return createHub({
    hostCall: async (hostId, request) => {
      hostCalls.push({ hostId, request });
      const input = hostContract.anamnesis.input.parse({ requestedHostId: hostId, request });
      const answer = await anamnesisHandler(input);
      return hostContract.anamnesis.output.parse(answer).response;
    },
    listHosts: async () => hosts,
    kv: { get: async <T>(key: string) => kv.get(key) as T | undefined, set: async (key, value) => { kv.set(key, value); } },
  });
}

beforeEach(() => {
  process.env.LANE_PILOT_ANAMNESIS_DIR = mkdtempSync(join(tmpdir(), "anamnesis-host-"));
  hostCalls = []; kv = new Map();
  hosts = [{ id: "host_hub", name: "OVH Server", connected: true }, { id: "host_mini", name: "MAC Mini", connected: true }];
});
afterEach(() => { if (previousDir === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previousDir; });

const cli = (hub: ReturnType<typeof makeHub>, argv: string[]) =>
  runAnamnesisCli(argv, { hub });

describe("anamnesis contracts", () => {
  it("declares the host method and the RPC, and no more than that", () => {
    expect(Object.keys(hostContract)).toContain("anamnesis");
    expect(Object.keys(rpcContract)).toContain("anamnesis");
    expect(() => hostContract.anamnesis.input.parse({ requestedHostId: "h", request: { op: "nope" } })).toThrow();
    expect(() => hostContract.anamnesis.input.parse({ requestedHostId: "h", request: { op: "forget" } })).toThrow();
    expect(() => hostContract.anamnesis.input.parse({ requestedHostId: "h", request: { op: "forget", all: true, id: "skill:x" } })).toThrow();
  });
});

describe("hub to host to store", () => {
  it("finds the one connected Mac mini by name, and prefers the configured machine", async () => {
    const hub = makeHub();
    expect(await hub.resolveHost()).toBe("host_mini");
    await hub.setConfig({ hostId: "host_other" });
    expect(await hub.resolveHost()).toBe("host_other");
  });

  it("never guesses among several minis or none", async () => {
    const hub = makeHub();
    hosts = [{ id: "a", name: "Mac mini 1", connected: true }, { id: "b", name: "Mac mini 2", connected: true }];
    await expect(hub.resolveHost()).rejects.toThrow(/More than one/);
    hosts = [{ id: "a", name: "Mac mini", connected: false }];
    await expect(hub.resolveHost()).rejects.toThrow(/No connected Mac mini/);
  });

  it("stores through the host, answers with counts and no content, and advances the checkpoint with the batch", async () => {
    const hub = makeHub();
    const summary = await hub.ask({ op: "upsert", actor: "auto:git", reason: "pass", checkpoint: { source: "git", at: T0, detail: { repos: 2 } },
      records: [
        { kind: "skill", key: "TypeScript", title: "TypeScript", evidence: [{ source: "git", ref: "repo@a1", at: T0 }] },
        { kind: "skill", key: "NoProof", title: "No proof" },
        { kind: "person", key: "Anna", title: "Anna", attributes: { relation: "family" }, evidence: [{ source: "bb-message", ref: "t:1:0", at: T0, quote: "Anna called, token=abcd1234efgh" }] },
      ] });
    expect(summary.counts).toEqual({ created: 2, ignored: 1 });
    expect(summary.reasons).toEqual({ no_evidence: 1 });
    expect(summary.ids.sort()).toEqual(["person:anna", "skill:typescript"]);
    const status = await hub.ask({ op: "status" });
    expect(status.counts.records).toBe(2);
    expect(status.sources.find((s) => s.source === "git")!.checkpoint).toBe(T0);
    expect(hostCalls.every((call) => call.hostId === "host_mini")).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/TypeScript|Anna/);
  });

  it("the RPC `host` op reads and sets the machine", async () => {
    const hub = makeHub();
    expect(await hub.dispatch({ op: "host" })).toMatchObject({ hostId: "host_mini" });
    expect(await hub.dispatch({ op: "host", hostId: "host_mbp" })).toMatchObject({ hostId: "host_mbp", config: { hostId: "host_mbp" } });
  });
});

describe("bb lane-pilot anamnesis", () => {
  async function seeded() {
    const hub = makeHub();
    await hub.ask({ op: "upsert", actor: "auto:git", reason: "pass", records: [
      { kind: "skill", key: "Blender", title: "Blender", statement: "scripts scenes", evidence: [{ source: "git", ref: "r@1", at: T0 }] },
      { kind: "person", key: "Anna", title: "Anna", attributes: { relation: "family" }, evidence: [{ source: "bb-message", ref: "t:1:0", at: T0 }] },
    ] });
    return hub;
  }

  it("lists without sensitive records by default and with them only on the flag", async () => {
    const hub = await seeded();
    const plain = await cli(hub, ["list"]);
    expect(plain.stdout).toContain("skill:blender");
    expect(plain.stdout).not.toContain("person:anna");
    expect((await cli(hub, ["list", "--include-sensitive"])).stdout).toContain("person:anna");
    expect((await cli(hub, ["show", "person:anna"])).exitCode).toBe(1);
    expect((await cli(hub, ["show", "person:anna", "--include-sensitive"])).stdout).toContain("person:anna");
  });

  it("an edit needs a reason, goes to the history, and confirm/reject are shortcuts", async () => {
    const hub = await seeded();
    expect((await cli(hub, ["edit", "skill:blender", "--statement", "x"])).stderr).toMatch(/--reason/);
    const edit = await cli(hub, ["edit", "skill:blender", "--statement", "Procedural scenes", "--reason", "owner wording"]);
    expect(edit.exitCode).toBe(0);
    expect((await cli(hub, ["confirm", "skill:blender"])).stdout).toContain("confirmed");
    const history = await cli(hub, ["history", "skill:blender"]);
    expect(history.stdout).toContain("owner wording");
    expect(history.stdout).toContain("owner confirmed it");
    expect((await cli(hub, ["reject", "skill:blender"])).stdout).toContain("rejected");
  });

  it("forgetting everything or a source needs --yes", async () => {
    const hub = await seeded();
    expect((await cli(hub, ["forget", "--all"])).stderr).toMatch(/--yes/);
    expect((await cli(hub, ["forget", "--source", "bb-message"])).stderr).toMatch(/--yes/);
    const dropped = await cli(hub, ["forget", "--source", "bb-message", "--yes"]);
    expect(JSON.parse(dropped.stdout!)).toMatchObject({ removed: 1, evidence: 1 });
    expect(JSON.parse((await cli(hub, ["forget", "skill:blender"])).stdout!)).toEqual({ removed: 1 });
    expect((await cli(hub, ["status"])).stdout).toContain("records: 0");
  });

  it("switches a source off and on", async () => {
    const hub = await seeded();
    expect((await cli(hub, ["sources", "--set", "git=off"])).stdout).toContain("git: off");
    expect((await cli(hub, ["sources", "--set", "telegram=on"])).stdout).toContain("telegram: on");
    expect((await cli(hub, ["sources", "--set", "git=maybe"])).stderr).toMatch(/on\|off/);
  });
});
