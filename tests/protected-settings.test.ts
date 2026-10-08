import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { claimActivation, createRun, loadProjectSettings, openDatabase, saveProjectSetting, setRunThread } from "../src/database";
import { isProtectedSetting } from "../src/server/protected-settings";

const projectId = "proj_prot";
const pmThreadId = "thr_prot_pm";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

type Form = { threadId: string; title: string; payload: { detail?: string; options: Array<{ id: string; label: string }> } };

/** The plugin with a PM chat for the project; the owner's answer to the confirmation form is `answer` ("1" allows). */
async function setup(answer: (form: Form) => Promise<unknown> | unknown = () => new Promise(() => undefined)) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const forms: Form[] = [];
  Object.assign(bb.ui as object, { requestInput: async (form: Form) => { forms.push(form); return answer(form); } });
  createRun(db, "run-prot", projectId, "bb", "/repo");
  setRunThread(db, "run-prot", pmThreadId);
  claimActivation(db, { projectId, pmThreadId, runId: "run-prot" });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const call = (method: string, input: Record<string, unknown>) => harness.behavior.callRpc(method, { projectId, ...input }) as Promise<Record<string, any>>;
  const settled = () => new Promise((resolve) => setTimeout(resolve, 30));
  return { db, forms, call, settled };
}

describe("settings only the owner changes", () => {
  it("lists the security-relevant keys and no others", () => {
    for (const key of ["secrets.allow", "secrets.anything", "verification.sandbox_unsafe", "sandbox.backend", "integration.gate_command"]) {
      expect(isProtectedSetting(key), key).toBe(true);
    }
    for (const key of ["writer.model", "jev.modes", "docs.enabled", "workflow.model_override", "ops.pool_size", "helper.access.errand"]) expect(isProtectedSetting(key), key).toBe(false);
  });

  it("refuses save_setting of secrets.allow, asks the owner in the PM chat, and does not store it", async () => {
    const s = await setup();
    const result = await s.call("save_setting", { key: "secrets.allow", value: "*", expectedVersion: 0 });
    expect(result).toMatchObject({ ok: false, conflict: false, validation: { code: "incompatible_setting", key: "secrets.allow" } });
    expect(result.validation.params[1]).toContain("owner's confirmation");
    await s.settled();
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]).toMatchObject({ threadId: pmThreadId });
    expect(s.forms[0]!.payload.detail).toContain("secrets.allow = \"*\"");
    expect(loadProjectSettings(s.db, projectId)["secrets.allow"]).toBeUndefined();
    // Asked again while the question is open: still one form.
    await s.call("save_setting", { key: "secrets.allow", value: "*", expectedVersion: 0 });
    await s.settled();
    expect(s.forms).toHaveLength(1);
  });

  it("refuses the same through save_settings and reset_project_settings", async () => {
    const s = await setup();
    const many = await s.call("save_settings", { changes: [{ key: "docs.enabled", value: false, expectedVersion: 0 }, { key: "secrets.allow", value: "A_KEY", expectedVersion: 0 }] });
    expect(many).toMatchObject({ ok: false, validation: { code: "incompatible_setting", key: "secrets.allow" } });
    expect(loadProjectSettings(s.db, projectId)["docs.enabled"]).toBeUndefined();
    saveProjectSetting(s.db, projectId, "sandbox.backend", "auto");
    const reset = await s.call("reset_project_settings", { keys: ["sandbox.backend"], expectedVersions: { "sandbox.backend": 1 } });
    expect(reset).toMatchObject({ ok: false, validation: { code: "incompatible_setting", key: "sandbox.backend" } });
    expect(loadProjectSettings(s.db, projectId)["sandbox.backend"]).toBe("auto");
  });

  it("an unprotected key and an unchanged protected value save as before", async () => {
    const s = await setup();
    expect(await s.call("save_setting", { key: "docs.enabled", value: false, expectedVersion: 0 })).toMatchObject({ ok: true });
    saveProjectSetting(s.db, projectId, "secrets.allow", "A_KEY");
    const current = loadProjectSettings(s.db, projectId)["secrets.allow"];
    const rows = s.db.prepare("SELECT version FROM lane_pilot_project_settings WHERE project_id=? AND key='secrets.allow'").get(projectId) as { version: number };
    expect(await s.call("save_setting", { key: "secrets.allow", value: current, expectedVersion: rows.version })).toMatchObject({ ok: true });
    expect(s.forms).toHaveLength(0);
  });

  it("after the owner's yes the same value saves once, a different value does not, and the yes is spent", async () => {
    const s = await setup(() => ({ outcome: "submitted", value: { choice: "1" } }));
    await s.call("save_setting", { key: "secrets.allow", value: "MY_KEY", expectedVersion: 0 });
    await s.settled();
    expect(s.forms).toHaveLength(1);
    expect(await s.call("save_setting", { key: "secrets.allow", value: "OTHER_KEY", expectedVersion: 0 })).toMatchObject({ ok: false });
    expect(await s.call("save_setting", { key: "secrets.allow", value: "MY_KEY", expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(loadProjectSettings(s.db, projectId)["secrets.allow"]).toBe("MY_KEY");
    // The yes covered one change: another value of it asks again.
    await s.call("save_setting", { key: "secrets.allow", value: "MY_KEY, OTHER_KEY", expectedVersion: 1 });
    await s.settled();
    expect(s.forms.length).toBeGreaterThanOrEqual(2);
  });

  it("a value the setting refuses anyway is answered by its own validation and not put to the owner", async () => {
    const s = await setup();
    const result = await s.call("save_setting", { key: "sandbox.backend", value: "nonsense", expectedVersion: 0 });
    expect(result).toMatchObject({ ok: false, validation: { code: "invalid_choice", key: "sandbox.backend" } });
    await s.settled();
    expect(s.forms).toHaveLength(0);
  });

  it("a no keeps the value out and is not asked again at once", async () => {
    const s = await setup(() => ({ outcome: "submitted", value: { choice: "2" } }));
    await s.call("save_setting", { key: "secrets.allow", value: "*", expectedVersion: 0 });
    await s.settled();
    const second = await s.call("save_setting", { key: "secrets.allow", value: "*", expectedVersion: 0 });
    expect(second).toMatchObject({ ok: false });
    expect(second.validation.params[1]).toContain("declined");
    expect(s.forms).toHaveLength(1);
    expect(loadProjectSettings(s.db, projectId)["secrets.allow"]).toBeUndefined();
  });

  it("with no PM chat to ask in the change is refused and says so", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    openDatabase(bb);
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const result = await harness.behavior.callRpc("save_setting", { projectId: "proj_none", key: "secrets.allow", value: "*", expectedVersion: 0 }) as Record<string, any>;
    expect(result).toMatchObject({ ok: false, validation: { code: "incompatible_setting" } });
    expect(result.validation.params[1]).toContain("No PM chat");
  });
});
