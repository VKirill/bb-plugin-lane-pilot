import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import { jevProviderRpc } from "../../src/rooms/secrets/server";

const OPEN_KEY = "sk-open-secret-1234";
const TYPE_KEY = "sk-type-secret-5678";

/** A core on a fake host with an Env Catalog stub (`catalog` is the store; `down` makes every catalog call fail); the Jev provider RPCs on it. */
function setup(catalog: Record<string, string>, options: { provider?: string; down?: boolean } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { plugins: { callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: Record<string, unknown> }) => {
      expect(pluginId).toBe("env-catalog");
      calls.push({ method, input });
      if (options.down) throw new Error("env-catalog is not running");
      if (method === "env_list") return { variables: Object.keys(catalog).map((name) => ({ name, kind: "secret", maskedValue: "sk-…" })) };
      if (method === "env_get_value") {
        if (!(String(input.name) in catalog)) throw new Error("not found");
        return { name: input.name, kind: "secret", value: catalog[String(input.name)], access: null };
      }
      if (method === "env_save") { catalog[String(input.name)] = String(input.value); return { success: true, name: input.name }; }
      throw new Error(`unexpected ${method}`);
    } } } as never,
  });
  const db = openDatabase(bb);
  if (options.provider) saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "jev.provider", options.provider);
  const core = createCore(bb, db);
  return { rpc: jevProviderRpc(core), calls, catalog, harness };
}

const fakeFetch = (reply: { status?: number; body?: unknown }) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } }));

afterEach(() => { vi.unstubAllGlobals(); });

describe("Jev provider status", () => {
  it("says which provider has a key, from names alone, and never carries a key", async () => {
    const { rpc, calls, harness } = setup({ OPENLUX_API_KEY: OPEN_KEY, TYPESAFE_API_KEY: TYPE_KEY });
    const status = await rpc.jev_provider_status();
    expect(status).toEqual({
      chosen: "openlux", effective: "openlux", catalog: "ok",
      providers: [
        { id: "typesafe", keyName: "TYPESAFE_API_KEY", model: "jev-latest", hasKey: true },
        { id: "openlux", keyName: "OPENLUX_API_KEY", model: "jev-1.13.0:stable", hasKey: true },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(calls.map((call) => call.method)).toEqual(["env_list"]);
    await harness.lifecycle.dispose();
  });

  it("follows the global setting and reports the provider Jev really runs on", async () => {
    const onlyTypesafe = setup({ TYPESAFE_API_KEY: TYPE_KEY });
    expect(await onlyTypesafe.rpc.jev_provider_status()).toMatchObject({ chosen: "openlux", effective: "typesafe", catalog: "ok" });
    await onlyTypesafe.harness.lifecycle.dispose();

    const chosenTypesafe = setup({ OPENLUX_API_KEY: OPEN_KEY }, { provider: "typesafe" });
    expect(await chosenTypesafe.rpc.jev_provider_status()).toMatchObject({ chosen: "typesafe", effective: null });
    await chosenTypesafe.harness.lifecycle.dispose();

    const none = setup({});
    expect(await none.rpc.jev_provider_status()).toMatchObject({ chosen: "openlux", effective: null, catalog: "ok" });
    await none.harness.lifecycle.dispose();
  });

  it("reports an Env Catalog that does not answer", async () => {
    const { rpc, harness } = setup({ OPENLUX_API_KEY: OPEN_KEY }, { down: true });
    const status = await rpc.jev_provider_status();
    expect(status).toMatchObject({ catalog: "unavailable", effective: null });
    expect(status.providers.every((provider) => !provider.hasKey)).toBe(true);
    await harness.lifecycle.dispose();
  });
});

describe("Jev provider key save", () => {
  it("writes the key into Env Catalog under the provider's name and answers with the status only", async () => {
    const { rpc, calls, catalog, harness } = setup({});
    const status = await rpc.jev_provider_save_key({ provider: "openlux", key: `  ${OPEN_KEY}\n` });
    expect(catalog).toEqual({ OPENLUX_API_KEY: OPEN_KEY });
    expect(calls.find((call) => call.method === "env_save")!.input).toMatchObject({ name: "OPENLUX_API_KEY", kind: "secret", value: OPEN_KEY });
    expect(status).toMatchObject({ chosen: "openlux", effective: "openlux" });
    expect(status.providers.find((provider) => provider.id === "openlux")!.hasKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain(OPEN_KEY);
    await harness.lifecycle.dispose();
  });

  it("refuses a key with spaces or line breaks and saves nothing", async () => {
    const { rpc, calls, harness } = setup({});
    await expect(rpc.jev_provider_save_key({ provider: "typesafe", key: "two words" })).rejects.toThrow(/one line/);
    await expect(rpc.jev_provider_save_key({ provider: "typesafe", key: "a\nb" })).rejects.toThrow(/one line/);
    expect(calls.some((call) => call.method === "env_save")).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("fails visibly when Env Catalog does not answer, without the key in the message", async () => {
    const { rpc, harness } = setup({}, { down: true });
    const failure = await rpc.jev_provider_save_key({ provider: "openlux", key: OPEN_KEY }).then(() => null, (cause: Error) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).not.toContain(OPEN_KEY);
    await harness.lifecycle.dispose();
  });
});

describe("Jev provider test request", () => {
  it("sends one request to the chosen provider with its key and reports model and latency", async () => {
    const { rpc, harness } = setup({ OPENLUX_API_KEY: OPEN_KEY, TYPESAFE_API_KEY: TYPE_KEY });
    const fetchMock = fakeFetch({ body: { answers: { check: { type: "noul", noul: 0.98 } }, model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 1 } } });
    vi.stubGlobal("fetch", fetchMock);
    const result = await rpc.jev_provider_test();
    expect(result).toMatchObject({ ok: true, provider: "openlux", model: "jev-1.13.0", error: null });
    expect(Number.isInteger(result.latencyMs)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openlux.ai/v1/systemone");
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${OPEN_KEY}`);
    expect(JSON.stringify(result)).not.toContain(OPEN_KEY);
    await harness.lifecycle.dispose();
  });

  it("tests TypeSafe when the setting says so, and uses a key saved a moment ago", async () => {
    const { rpc, harness } = setup({}, { provider: "typesafe" });
    vi.stubGlobal("fetch", fakeFetch({ body: { answers: { check: { type: "noul", noul: 0.9 } } } }));
    expect(await rpc.jev_provider_test()).toMatchObject({ ok: false, provider: "typesafe" });
    await rpc.jev_provider_save_key({ provider: "typesafe", key: TYPE_KEY });
    const fetchMock = fakeFetch({ body: { answers: { check: { type: "noul", noul: 0.9 } } } });
    vi.stubGlobal("fetch", fetchMock);
    expect(await rpc.jev_provider_test()).toMatchObject({ ok: true, provider: "typesafe", model: "jev-latest" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.typesafe.ai/v1/systemone");
    await harness.lifecycle.dispose();
  });

  it("reports a refused key as an error, not as a throw", async () => {
    const { rpc, harness } = setup({ OPENLUX_API_KEY: OPEN_KEY });
    vi.stubGlobal("fetch", fakeFetch({ status: 401 }));
    const result = await rpc.jev_provider_test();
    expect(result).toMatchObject({ ok: false, provider: "openlux", model: null, error: "http 401" });
    await harness.lifecycle.dispose();
  });

  it("does not call out when the chosen provider has no key", async () => {
    const { rpc, harness } = setup({ TYPESAFE_API_KEY: TYPE_KEY });
    const fetchMock = fakeFetch({});
    vi.stubGlobal("fetch", fetchMock);
    expect(await rpc.jev_provider_test()).toMatchObject({ ok: false, provider: "openlux", error: "no OPENLUX_API_KEY in Env Catalog" });
    expect(fetchMock).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });
});
