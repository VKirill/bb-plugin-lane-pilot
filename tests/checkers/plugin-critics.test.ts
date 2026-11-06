import { describe, expect, it } from "vitest";
import { createCheckers } from "../../src/rooms/checkers/api";
import { createPluginCheckers } from "../../src/rooms/checkers/server/plugin-ports";

describe("the checker scorecard inside the plugin asks no model", () => {
  it("a score with --critic where the host asks no model says where the critics run, and names the code checkers as the plugin's part", async () => {
    const api = createCheckers({ db: {} as never, load: async () => [{ input: {} as never, open: async () => null as never }], model: () => null, log: () => undefined });
    await expect(api.score({ critic: { providerId: "codex", model: "gpt-6-luna" } })).rejects.toThrow(/plugin starts no critic threads.*scripts\/lp-checkers\.ts/);
  });

  it("the plugin's ports start no thread at all: model work is a graph, and the critics have none", async () => {
    // A fake host that records every spawn attempt: scoring through the plugin's ports must never reach one.
    const spawns: string[] = [];
    const boom = (kind: string) => () => { spawns.push(kind); throw new Error(`no spawn in plugin checkers: ${kind}`); };
    const bb = { threads: { spawn: boom("threads.spawn") }, fullAccessSpawn: boom("fullAccessSpawn"), sdk: { projects: { list: async () => [] } } };
    const db = { prepare: () => ({ all: () => [], get: () => undefined }) };
    const api = createPluginCheckers({ bb, db, host: {}, log: () => undefined } as never);
    await api.score({}).catch(() => null);
    expect(spawns).toEqual([]);
  });
});
