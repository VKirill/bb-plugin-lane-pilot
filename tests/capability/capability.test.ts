import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { adapterVersions, capabilityTable, dueProbes, listReceipts, providersInUse } from "../../src/rooms/capability";
import { BASE_PROVIDERS, createCapabilities, runCapabilityCli } from "../../src/rooms/capability/server";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/storage/database";

describe("the capability table", () => {
  it("knows the providers in use from settings, then the base ones, and their adapter versions", () => {
    const inUse = providersInUse([
      { key: "writer.provider", value: "acp-cursor" }, { key: "writer.model", value: "composer-2.5" },
      { key: "pmProviderId", value: "claude-code" }, { key: "pmModel", value: "claude-opus-5-5" },
    ], BASE_PROVIDERS);
    expect([...inUse]).toEqual([["acp-cursor", "composer-2.5"], ["claude-code", "claude-opus-5-5"], ["codex", "gpt-6-luna"], ["opencode2", "zai-coding-plan/glm-5.3-flash"]]);
    const versions = adapterVersions([{ id: "codex", pluginId: "provider-codex" }, { id: "opencode2", pluginId: "opencode2" }, { id: "x" }], [{ id: "provider-codex", version: "0.1.0" }, { id: "opencode2", version: "1.1.0" }]);
    expect([...versions]).toEqual([["codex", "0.1.0"], ["opencode2", "1.1.0"], ["x", null]]);
  });

  it("a version with no receipt is due and unproven; a receipt settles it until the version changes", () => {
    const inUse = new Map([["codex", "gpt-6-luna"], ["opencode2", "glm"]]);
    const versions = new Map<string, string | null>([["codex", "0.1.0"], ["opencode2", "1.2.0"]]);
    const receipts = [{ providerId: "codex", version: "0.1.0", capability: "answers" as const, state: "supported" as const, model: "gpt-6-luna", detail: null, at: 1 },
      { providerId: "opencode2", version: "1.1.0", capability: "answers" as const, state: "supported" as const, model: "glm", detail: null, at: 1 }];
    expect(dueProbes(inUse, versions, receipts)).toEqual([{ providerId: "opencode2", model: "glm", version: "1.2.0" }]);
    expect(capabilityTable(inUse, versions, receipts)).toEqual([
      { providerId: "codex", version: "0.1.0", capabilities: { answers: "supported" } },
      { providerId: "opencode2", version: "1.2.0", capabilities: { answers: "unproven" } },
    ]);
  });
});

describe("the sweep", () => {
  it("probes each new version once on the sandbox, keeps the receipt and opens the breaker on a failure", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }, { id: "opencode2", pluginId: "opencode2" }, { id: "claude-code", pluginId: "provider-claude-code" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }, { id: "opencode2", version: "1.2.0" }, { id: "provider-claude-code", version: "0.1.0" }]);
    const db = openDatabase(bb);
    createRun(db, "run_s", "proj_3tb652jpsi", "bb", "/s");
    setRunThread(db, "run_s", "thr_pm");
    harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", status: "idle", archivedAt: null }));
    const probes: string[] = [], tripped: string[] = [];
    const services = {
      startHelperProbe: async (_project: string, _run: string, provider: string) => { probes.push(provider); return provider === "opencode2" ? { ok: false, reason: "did not answer" } : { ok: true, reason: null }; },
      providerBreaker: { record: (key: string) => { tripped.push(key); } },
    };
    const api = createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never, services as never).capabilities;
    const first = await api.sweep();
    expect(first.map((row) => [row.providerId, row.state])).toEqual([["claude-code", "supported"], ["codex", "supported"], ["opencode2", "not_supported"]]);
    expect(tripped).toEqual([expect.stringContaining("opencode2")]);
    expect(await api.sweep()).toEqual([]);
    expect(listReceipts(db)).toHaveLength(3);
    const cli = await runCapabilityCli(api, []);
    expect(cli.exitCode).toBe(1);
    expect(JSON.parse(cli.stdout!).table.find((row: { providerId: string }) => row.providerId === "opencode2").capabilities.answers).toBe("not_supported");
    expect((await runCapabilityCli(api, ["--bogus"])).exitCode).toBe(1);
  });

  it("a probe that cannot be set up (archived parent, unknown model) writes no receipt and trips no breaker; an archived PM chat is skipped", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }]);
    harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle", archivedAt: args.threadId === "thr_new" ? "2026-10-23T00:00:00Z" : null }));
    const db = openDatabase(bb);
    createRun(db, "run_old", "proj_3tb652jpsi", "bb", "/s"); setRunThread(db, "run_old", "thr_old");
    db.prepare("UPDATE lane_pilot_run SET created_at=1 WHERE id='run_old'").run();
    createRun(db, "run_new", "proj_3tb652jpsi", "bb", "/s"); setRunThread(db, "run_new", "thr_new");
    const usedRuns: string[] = [], tripped: string[] = [];
    let reason = "HTTP 400: Parent thread is invalid";
    const services = {
      startHelperProbe: async (_p: string, run: string) => { usedRuns.push(run); return { ok: false, started: false, reason }; },
      providerBreaker: { record: (key: string) => { tripped.push(key); } },
    };
    const api = createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never, services as never).capabilities;
    expect((await api.sweep()).map((row) => row.state)).toEqual(["not_probed"]);
    expect(new Set(usedRuns)).toEqual(new Set(["run_old"]));
    expect(listReceipts(db)).toEqual([]);
    expect(tripped).toEqual([]);
    reason = "spawn failed: provider crashed";
    expect((await api.sweep()).every((row) => row.state === "not_supported")).toBe(true);
    expect(tripped.length).toBeGreaterThan(0);
  });

  it("pairs a provider with a model within one project, never across projects", () => {
    expect([...providersInUse([{ key: "writer.provider", value: "acp-cursor" }, { key: "writer.model", value: "composer-2.5" }])]).toEqual([["acp-cursor", "composer-2.5"]]);
    expect([...providersInUse([{ key: "writer.provider", value: "acp-cursor" }])]).toEqual([]);
  });
});
