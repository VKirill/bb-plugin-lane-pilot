import { describe, expect, it } from "vitest";
import { createCheckers } from "../../src/rooms/checkers/api";
import { createPluginCheckers } from "../../src/rooms/checkers/server/plugin-ports";

describe("the checker scorecard inside the plugin asks no model", () => {
  it("a score with --critic where the host asks no model says where the critics run, and names the code checkers as the plugin's part", async () => {
    const api = createCheckers({ db: {} as never, load: async () => [{ input: {} as never, open: async () => null as never }], model: () => null, log: () => undefined });
    await expect(api.score({ critic: { providerId: "codex", model: "gpt-6-luna" } })).rejects.toThrow(/plugin starts no critic threads.*scripts\/lp-checkers\.ts/);
  });

  it("the plugin's ports start no thread at all: model work is a graph, and the critics have none", async () => {
    // Built with a ctx that offers no threads/host spawn: any hidden spawn would throw here, and the critic path
    // is the same refusal the scorecard test above asserts — `model` is null by construction.
    const api = createPluginCheckers({ bb: { sdk: { projects: { list: async () => [] } } }, db: {}, host: {}, log: () => undefined } as never);
    expect(Object.keys(api).filter((key) => /spawn|thread/i.test(key))).toEqual([]);
  });
});
