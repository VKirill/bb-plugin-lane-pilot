import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { rpcContract } from "../src/contracts";
import { claimActivation, createRun, loadProjectSettings, openDatabase, setRunThread } from "../src/database";
import { OWNER_ONLY_RPC, RPC_CLASS, readCliCaller, readVkCaller } from "../src/server/owner-gate";

const projectId = "proj_gate";
const pmThreadId = "thr_gate_pm";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

type Form = { threadId: string; title: string; payload: { detail?: string; question: string; options: Array<{ id: string; label: string }> } };
type Handler = (input: unknown, ctx?: unknown) => Promise<Record<string, any>>;

// A verified owner (a core with the owner login proves it: evidence other than the client's own headers).
const owner = { experimental_vkCaller: { kind: "owner-ui", evidence: "owner-session" } };
const cli = { experimental_vkCaller: { kind: "owner-cli", evidence: "owner-signature" } };
// What the current core sends: client-asserted marks, and the kind a newer core gives them.
const forgedCli = { experimental_vkCaller: { kind: "owner-cli", evidence: "cli-header" } };
const pageHeaders = { experimental_vkCaller: { kind: "owner-ui", evidence: "browser-headers" } };
const unverified = { experimental_vkCaller: { kind: "unverified-owner", evidence: "cli-header" } };
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
  it("names every method of the contract once, and the gate covers all that are not plain reads", () => {
    const real = Object.keys(rpcContract);
    expect(Object.keys(RPC_CLASS).sort()).toEqual([...real].sort());
    for (const name of OWNER_ONLY_RPC) expect(real.includes(name), name).toBe(true);
    for (const name of ["get_screen", "get_globals", "helper_access_view", "deploy_status", "self_repair_status", "canary_status", "workflow_get", "token_usage", "schedule_list", "schedule_get", "secret_issuance"]) {
      expect(RPC_CLASS[name as keyof typeof RPC_CLASS], name).toBe("read");
      expect(OWNER_ONLY_RPC.has(name), name).toBe(false);
    }
    // The agents' own memory stays open to every caller.
    for (const name of ["session_memory_write", "session_lesson"]) { expect(RPC_CLASS[name as keyof typeof RPC_CLASS], name).toBe("agent"); expect(OWNER_ONLY_RPC.has(name), name).toBe(false); }
    // Every save_*, reset_*, set_*, schedule_* (but the reads) and workflow_* that starts or changes something is behind the gate.
    for (const name of real) {
      if (/^(save|reset|set)_/.test(name)) expect(OWNER_ONLY_RPC.has(name), name).toBe(true);
      if (/^schedule_/.test(name) && !/^schedule_(list|get|runs|preview|calendar)$/.test(name)) expect(OWNER_ONLY_RPC.has(name), name).toBe(true);
    }
    for (const name of ["self_repair_configure", "deploy_drain", "halt_run", "workflow_model_override", "save_agent_profile", "workflow_run", "workflow_draft_patch", "prepare_native_session", "anamnesis", "schedule_upsert"]) expect(OWNER_ONLY_RPC.has(name), name).toBe(true);
  });

  it("registers no method that the table does not name", async () => {
    const s = await setup();
    expect(Object.keys(s.handlers()).every((name) => name in RPC_CLASS)).toBe(true);
  });

  it("reads the mark, and treats an unknown kind as no credentials", () => {
    expect(readVkCaller(undefined)).toBeUndefined();
    expect(readVkCaller({})).toBeUndefined();
    expect(readVkCaller({ experimental_vkCaller: { kind: "root" } })).toEqual({ kind: "unknown" });
    expect(readVkCaller(agent)?.kind).toBe("agent-thread");
  });

  it("an owner mark with only the client's own words behind it is an unverified owner; a proved one is the owner", () => {
    expect(readVkCaller(forgedCli)?.kind).toBe("unverified-owner");
    expect(readVkCaller(pageHeaders)?.kind).toBe("unverified-owner");
    expect(readVkCaller({ experimental_vkCaller: { kind: "owner-cli" } })?.kind).toBe("unverified-owner");
    expect(readVkCaller(unverified)?.kind).toBe("unverified-owner");
    expect(readVkCaller(owner)?.kind).toBe("owner-ui");
    expect(readVkCaller(cli)?.kind).toBe("owner-cli");
  });

  it("a command that says it runs in a thread is an agent's unless the core proved the owner", () => {
    expect(readCliCaller({ ...forgedCli, threadId: "thr_x" })).toMatchObject({ kind: "agent-thread", threadId: "thr_x" });
    expect(readCliCaller({ ...anonymous, threadId: "thr_x" })).toMatchObject({ kind: "agent-thread", threadId: "thr_x" });
    expect(readCliCaller({ ...cli, threadId: "thr_x" })?.kind).toBe("owner-cli");
    expect(readCliCaller({ ...forgedCli })?.kind).toBe("unverified-owner");
    expect(readCliCaller({ threadId: "thr_x" })).toBeUndefined();
  });

  it("the verified owner, an unverified one (ordinary settings) and another plugin save as before", async () => {
    const s = await setup();
    for (const [index, ctx] of [owner, cli, otherPlugin, forgedCli, pageHeaders, unverified].entries()) {
      expect(await s.call("save_setting", { ...save, value: index % 2 === 1, expectedVersion: index }, ctx)).toMatchObject({ ok: true });
    }
    expect(s.forms).toHaveLength(0);
  });

  it("an unverified owner meets the form on a schedule, an agent profile and the installs; the verified owner does not", async () => {
    const s = await setup();
    const definition = { name: "x", task: { kind: "script", hostId: "h", command: "echo hi" } };
    for (const ctx of [forgedCli, pageHeaders, unverified]) {
      await expect(s.call("schedule_upsert", { definition }, ctx)).rejects.toThrow(/cannot be told from an agent's.*asked in the PM chat|question is open/s);
    }
    await s.settled();
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]!.payload.question).toContain("schedule_upsert");
    expect(s.forms[0]!.payload.detail).toContain("echo hi");
    for (const name of ["schedule_resume", "schedule_run_now"]) await expect(s.call(name, { id: "sch_x" }, forgedCli), name).rejects.toThrow(/owner's confirmation/);
    for (const name of ["stack_install", "self_repair_configure", "save_agent_profile", "native_install_start", "workflow_draft_publish"]) await expect(s.call(name, {}, forgedCli), name).rejects.toThrow(/owner's confirmation/);
    // The verified owner, and a stop that only holds work back, pass.
    expect(await s.call("schedule_run_now", { id: "sch_x" }, owner)).toMatchObject({ ok: false });
    expect(await s.call("schedule_delete", { id: "sch_x" }, forgedCli)).toMatchObject({ ok: false });
    expect(await s.call("schedule_pause", { id: "sch_x" }, forgedCli)).toMatchObject({ schedule: null });
  });

  it("an agent is put to the owner on a schedule too, and the long command is shown whole", async () => {
    const s = await setup();
    const command = `echo ${"a".repeat(2000)}`;
    await expect(s.call("schedule_upsert", { definition: { projectId, name: "x", task: { kind: "script", hostId: "h", command } } }, agent)).rejects.toThrow(/only the owner does that/);
    await s.settled();
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]).toMatchObject({ threadId: pmThreadId });
    expect(s.forms[0]!.payload.detail).toContain(command);
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
