import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database";
import { RPC_CLASS, createOwnerGate } from "../src/server/owner-gate";

/**
 * The legitimate callers of Lane Pilot's RPC methods and CLI commands, each with the way in that must keep working
 * (docs/rpc-callers.md has the table). A refusal of one of these is a bug, not a security feature.
 */
const mark = (kind: string, evidence: string, extra: Record<string, unknown> = {}) => ({ experimental_vkCaller: { kind, evidence, ...extra } });
const page = mark("owner-ui", "browser-headers");
const ownerCli = mark("owner-cli", "cli-header"); // the owner's bb on a core without the owner login: client-asserted
const verifiedCli = mark("owner-cli", "owner-signature");
const otherPlugin = mark("plugin", "plugin-token", { pluginId: "project-folders" });
const agent = mark("agent-thread", "thread-token", { threadId: "thr_agent" });
const bare = mark("unknown", "none");

function gate() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return createOwnerGate({ db: openDatabase(bb), ownerAsk: undefined, log: () => undefined, denyThread: async () => null });
}
const methods = Object.keys(RPC_CLASS);
const reads = methods.filter((name) => RPC_CLASS[name as keyof typeof RPC_CLASS] === "read");
const ordinary = methods.filter((name) => ["read", "mutate", "agent"].includes(RPC_CLASS[name as keyof typeof RPC_CLASS]));

describe("legitimate callers keep a working path", () => {
  it("the Lane Pilot page (owner-ui, no owner login yet) can call every method, every anamnesis request included", async () => {
    const g = gate();
    for (const name of methods) {
      const input = name === "anamnesis" ? { request: { op: "forget", all: true } } : {};
      expect(await g.check(name, input, page), name).toEqual({ ok: true });
    }
  });

  it("the owner's bb CLI (client-asserted mark) runs the drill, the watchdogs and the deploy script without a form", async () => {
    const g = gate();
    // lp-drill.py: save_setting / reset_project_settings; self-repair-watchdog.sh, lp-canary.sh: status reads;
    // bb-plugin-push: deploy_status, deploy_drain, canary_status, self_repair_status.
    for (const name of ["save_setting", "reset_project_settings", "self_repair_status", "canary_status", "deploy_status", "deploy_drain"]) {
      expect(await g.check(name, { key: "writer.model", keys: ["writer.model"] }, ownerCli), name).toEqual({ ok: true });
    }
    for (const name of ordinary) expect(await g.check(name, {}, ownerCli), name).toEqual({ ok: true });
    expect(await g.check("workflow_run", {}, ownerCli)).toEqual({ ok: true });
  });

  it("a verified owner passes everything", async () => {
    const g = gate();
    for (const name of methods) expect(await g.check(name, name === "anamnesis" ? { request: { op: "forget", all: true } } : {}, verifiedCli), name).toEqual({ ok: true });
    expect(await g.checkCli("schedule_upsert", [], verifiedCli)).toEqual({ ok: true });
    expect(await g.checkAnamnesisCli("write-owner", [], verifiedCli)).toEqual({ ok: true });
  });

  it("another plugin (a plugin caller) passes on everything but the owner's records", async () => {
    const g = gate();
    for (const name of methods.filter((m) => m !== "anamnesis")) expect(await g.check(name, {}, otherPlugin), name).toEqual({ ok: true });
    expect(await g.check("anamnesis", { request: { op: "status" } }, otherPlugin)).toEqual({ ok: true });
  });

  it("reads and the agents' own memory (the lane-memory hub client, status polls) need no identity at all", async () => {
    const g = gate();
    for (const ctx of [bare, agent, ownerCli, {}]) {
      for (const name of [...reads, "session_memory_write", "session_lesson"]) expect(await g.check(name, {}, ctx), name).toEqual({ ok: true });
    }
  });

  it("an agent can read the owner's anamnesis (not sensitive) and the schedule board; its changes are put to the owner, not refused", async () => {
    const g = gate();
    expect(await g.check("anamnesis", { request: { op: "whoami" } }, agent)).toEqual({ ok: true });
    expect(await g.checkAnamnesisCli("read", ["whoami"], { ...agent, threadId: "thr_agent" })).toEqual({ ok: true });
    expect(await g.checkCli("schedule_run_now", [], { ...agent, threadId: "thr_agent" })).toMatchObject({ ok: false, message: expect.stringMatching(/No PM chat is open to ask in: open the project's PM chat/) });
  });

  it("every refusal tells the caller what to do", async () => {
    const g = gate();
    const refusals = [
      await g.check("save_setting", {}, bare),
      await g.check("schedule_upsert", {}, bare),
      await g.check("anamnesis", { request: { op: "status" } }, bare),
      await g.check("anamnesis", { request: { op: "get", id: "a:b", includeSensitive: true } }, agent),
      await g.check("anamnesis", { request: { op: "edit", id: "a:b", patch: { status: "confirmed" } } }, agent),
      await g.check("schedule_upsert", {}, ownerCli),
      await g.check("halt_run", {}, agent),
    ];
    for (const verdict of refusals) {
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.message).toMatch(/Use the Lane Pilot page|Tell the owner|tell the owner|owner was asked|No PM chat is open|asked in the PM chat/);
    }
  });
});
