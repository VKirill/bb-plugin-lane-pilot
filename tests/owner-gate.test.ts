import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { rpcContract } from "../src/contracts";
import { claimActivation, createRun, loadProjectSettings, openDatabase, setRunThread } from "../src/database";
import { OWNER_ONLY_RPC, readVkCaller } from "../src/server/owner-gate";

const projectId = "proj_gate";
const pmThreadId = "thr_gate_pm";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

type Form = { threadId: string; title: string; payload: { detail?: string; question: string; options: Array<{ id: string; label: string }> } };
type Handler = (input: unknown, ctx?: unknown) => Promise<Record<string, any>>;

const owner = { experimental_vkCaller: { kind: "owner-ui", evidence: "browser-headers" } };
const cli = { experimental_vkCaller: { kind: "owner-cli", evidence: "cli-header" } };
const otherPlugin = { experimental_vkCaller: { kind: "plugin", pluginId: "project-folders", evidence: "plugin-token" } };
const agent = { experimental_vkCaller: { kind: "agent-thread", threadId: "thr_agent", evidence: "thread-token" } };
const anonymous = { experimental_vkCaller: { kind: "unknown", evidence: "none" } };

/** The plugin with a PM chat for the project and the raw handlers (what a core calls, with its context as the second argument). */
async function setup(answer: (form: Form) => Promise<unknown> | unknown = () => new Promise(() => undefined)) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const forms: Form[] = [];
  Object.assign(bb.ui as object, { requestInput: async (form: Form) => { forms.push(form); return answer(form); } });
  let handlers: Record<string, Handler> = {};
  const rpc = bb.rpc as unknown as { register: (contract: unknown, map: Record<string, Handler>) => unknown };
  const register = rpc.register.bind(rpc);
  rpc.register = (contract, map) => { handlers = map; return register(contract, map); };
  createRun(db, "run-gate", projectId, "bb", "/repo");
  setRunThread(db, "run-gate", pmThreadId);
  claimActivation(db, { projectId, pmThreadId, runId: "run-gate" });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const call = (method: string, input: Record<string, unknown>, ctx?: unknown) => handlers[method]!({ projectId, ...input }, ctx);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 30));
  return { db, forms, call, settled, handlers: () => handlers };
}

const save = { key: "docs.enabled", value: false, expectedVersion: 0 };

describe("owner-only RPC methods", () => {
  it("lists real methods only, and none of the read-only ones or the agents' memory", () => {
    const real = new Set(Object.keys(rpcContract));
    for (const name of OWNER_ONLY_RPC) expect(real.has(name), name).toBe(true);
    for (const name of ["get_screen", "get_globals", "helper_access_view", "deploy_status", "self_repair_status", "canary_status", "session_memory_write", "session_memory_search", "session_lesson", "workflow_get", "token_usage"]) {
      expect(OWNER_ONLY_RPC.has(name), name).toBe(false);
    }
    // Every save_*, reset_* and set_* method of the contract is owner-only.
    for (const name of real) if (/^(save|reset|set)_/.test(name)) expect(OWNER_ONLY_RPC.has(name), name).toBe(true);
    for (const name of ["self_repair_configure", "deploy_drain", "halt_run", "workflow_model_override", "save_agent_profile"]) expect(OWNER_ONLY_RPC.has(name), name).toBe(true);
  });

  it("reads the mark, and treats an unknown kind as no credentials", () => {
    expect(readVkCaller(undefined)).toBeUndefined();
    expect(readVkCaller({})).toBeUndefined();
    expect(readVkCaller({ experimental_vkCaller: { kind: "root" } })).toEqual({ kind: "unknown" });
    expect(readVkCaller(agent)?.kind).toBe("agent-thread");
  });

  it("the owner's page, the owner's CLI and another plugin save as before", async () => {
    const s = await setup();
    for (const [index, ctx] of [owner, cli, otherPlugin].entries()) {
      expect(await s.call("save_setting", { ...save, value: index % 2 === 1, expectedVersion: index }, ctx)).toMatchObject({ ok: true });
    }
    expect(s.forms).toHaveLength(0);
  });

  it("a core without the function (no mark) keeps the old behaviour", async () => {
    const s = await setup();
    expect(await s.call("save_setting", save)).toMatchObject({ ok: true });
    expect(await s.call("save_setting", { ...save, value: true, expectedVersion: 1 }, {})).toMatchObject({ ok: true });
    expect(s.forms).toHaveLength(0);
  });

  it("an anonymous script is refused on every owner-only method, with no form", async () => {
    const s = await setup();
    for (const name of OWNER_ONLY_RPC) {
      await expect(s.call(name, {}, anonymous), name).rejects.toThrow(/Refused: .* only from the Lane Pilot page/);
    }
    await s.settled();
    expect(s.forms).toHaveLength(0);
    expect(loadProjectSettings(s.db, projectId)["docs.enabled"]).toBeUndefined();
  });

  it("read-only methods and the agents' memory do not look at the caller", async () => {
    const s = await setup();
    for (const ctx of [anonymous, agent]) {
      expect(await s.call("deploy_status", {}, ctx)).toBeTruthy();
      expect(await s.call("get_screen", {}, ctx)).toBeTruthy();
    }
    expect(s.forms).toHaveLength(0);
  });

  it("an agent's call is put to the owner in the PM chat and is not run", async () => {
    const s = await setup();
    await expect(s.call("save_setting", save, agent)).rejects.toThrow(/only the owner does that.*asked in the PM chat/s);
    await s.settled();
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]).toMatchObject({ threadId: pmThreadId });
    expect(s.forms[0]!.payload.question).toContain("save_setting");
    expect(s.forms[0]!.payload.detail).toContain("docs.enabled");
    expect(loadProjectSettings(s.db, projectId)["docs.enabled"]).toBeUndefined();
    // Asked again while the question is open: still one form.
    await expect(s.call("save_setting", save, agent)).rejects.toThrow(/question is open/);
    await s.settled();
    expect(s.forms).toHaveLength(1);
  });

  it("after the owner's yes the same call runs once; another input or another call does not", async () => {
    const s = await setup(() => ({ outcome: "submitted", value: { choice: "1" } }));
    await expect(s.call("save_setting", save, agent)).rejects.toThrow();
    await s.settled();
    await expect(s.call("save_setting", { ...save, value: true }, agent)).rejects.toThrow();
    await expect(s.call("reset_project_settings", { keys: ["docs.enabled"], expectedVersions: {} }, agent)).rejects.toThrow();
    expect(await s.call("save_setting", save, agent)).toMatchObject({ ok: true });
    expect(loadProjectSettings(s.db, projectId)["docs.enabled"]).toBe(false);
    // The yes is spent.
    await expect(s.call("save_setting", save, agent)).rejects.toThrow();
  });

  it("the key order of the input does not matter to the approval", async () => {
    const s = await setup(() => ({ outcome: "submitted", value: { choice: "1" } }));
    await expect(s.call("save_setting", save, agent)).rejects.toThrow();
    await s.settled();
    expect(await s.call("save_setting", { expectedVersion: 0, value: false, key: "docs.enabled" }, agent)).toMatchObject({ ok: true });
  });

  it("a no keeps the call out and is not asked again at once", async () => {
    const s = await setup(() => ({ outcome: "submitted", value: { choice: "2" } }));
    await expect(s.call("save_setting", save, agent)).rejects.toThrow();
    await s.settled();
    await expect(s.call("save_setting", save, agent)).rejects.toThrow(/declined/);
    expect(s.forms).toHaveLength(1);
  });

  it("a protected setting is left to its own form, so the owner is asked once", async () => {
    const s = await setup();
    const result = await s.call("save_setting", { key: "secrets.allow", value: "*", expectedVersion: 0 }, agent);
    expect(result).toMatchObject({ ok: false, validation: { code: "incompatible_setting", key: "secrets.allow" } });
    await s.settled();
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]!.payload.question).toContain("settings");
    expect(loadProjectSettings(s.db, projectId)["secrets.allow"]).toBeUndefined();
  });

  it("an anonymous script cannot reach a protected setting either", async () => {
    const s = await setup();
    await expect(s.call("save_setting", { key: "secrets.allow", value: "*", expectedVersion: 0 }, anonymous)).rejects.toThrow(/Refused/);
    await s.settled();
    expect(s.forms).toHaveLength(0);
  });

  it("with no PM chat and no thread on the mark the agent is told to open one", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    openDatabase(bb);
    let handlers: Record<string, Handler> = {};
    const rpc = bb.rpc as unknown as { register: (contract: unknown, map: Record<string, Handler>) => unknown };
    const register = rpc.register.bind(rpc);
    rpc.register = (contract, map) => { handlers = map; return register(contract, map); };
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const bare = { experimental_vkCaller: { kind: "agent-thread", evidence: "cli-header" } };
    await expect(handlers.halt_run!({ runId: "x" }, bare)).rejects.toThrow(/No PM chat/);
  });
});
