import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { runMemoryGate, type MemoryGate } from "../../src/rooms/memory-eval/server/gate";

describe("frozen memory gate", () => {
  it("passes the forty cases with no leak, no cut rule and no overflow", () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/memory-gate.json", import.meta.url), "utf8")) as MemoryGate;
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    expect(runMemoryGate(db, fixture)).toEqual({ cases: 40, leaks: [], overflows: [], cutRules: [], misses: [], errors: [] });
  });
});
