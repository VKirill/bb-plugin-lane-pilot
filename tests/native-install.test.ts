import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashBytes, planJson, transitionOwned, type NativeInstallManifest } from "../src/native-install-owned";
import { nativeInstallOperation } from "../src/native-install-host";
import { createNativeInstaller, experimental_vkLifecycle, registerNativeInstallHost } from "../src/native-install-lifecycle";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lp-owned-")); roots.push(root);
  const home = join(root, "home"), managed = join(root, "managed");
  await mkdir(home); await mkdir(join(managed, "payload"), { recursive: true });
  await writeFile(join(managed, "payload/tool"), "owned");
  const m: NativeInstallManifest = { schemaVersion: 1, home, sourceSha: "a".repeat(40), state: "prepared", files: [{ path: ".agents/bin/tool", payload: "payload/tool", mode: 0o755, hash: hashBytes("owned") }], json: [], blocks: [], preserved: [], createdConfigs: [], createdDirs: [] };
  return { root, home, managed, m };
}
function kvFixture() {
  const rows = new Map<string, unknown>();
  return { get: async <T>(key: string) => rows.get(key) as T | undefined, set: async (key: string, value: unknown) => { rows.set(key, value); }, delete: async (key: string) => { rows.delete(key); }, list: async (prefix = "") => [...rows.keys()].filter(key => key.startsWith(prefix)) };
}
describe("native installation ownership", () => {
  it("disables, restores and removes owned files while preserving JSONC user changes", async () => {
    const { home, managed, m } = await fixture();
    await writeFile(join(home, "settings.jsonc"), '// keep comment\n{"foreign": true}\n');
    m.json = await planJson(home, "settings.jsonc", { hooks: { Start: ["lane"] } });
    await transitionOwned(managed, m, "enable");
    await transitionOwned(managed, m, "disable");
    expect(await readFile(join(home, "settings.jsonc"), "utf8")).toContain("// keep comment");
    expect(await readFile(join(home, "settings.jsonc"), "utf8")).not.toContain("hooks");
    await transitionOwned(managed, m, "enable");
    expect(await readFile(join(home, ".agents/bin/tool"), "utf8")).toBe("owned");
    await nativeInstallOperation({ root: managed, home, action: "remove" });
    await expect(readFile(join(managed, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(home, "settings.jsonc"), "utf8")).toContain('"foreign": true');
  });
  it("preserves edited files and refuses removal", async () => {
    const { home, managed, m } = await fixture();
    await transitionOwned(managed, m, "enable");
    await writeFile(join(home, ".agents/bin/tool"), "user edit");
    await expect(transitionOwned(managed, m, "remove")).rejects.toThrow("changed; preserved");
    expect(await readFile(join(home, ".agents/bin/tool"), "utf8")).toBe("user edit");
  });
  it("keeps pre-existing empty arrays and removes newly created empty config files", async () => {
    const { home, managed, m } = await fixture();
    await writeFile(join(home, "existing.json"), '{"hooks": []}');
    m.json = [...await planJson(home, "existing.json", { hooks: ["lane"] }), ...await planJson(home, "new.json", { enabled: true })];
    m.createdConfigs = ["new.json"];
    await transitionOwned(managed, m, "enable"); await transitionOwned(managed, m, "disable");
    await transitionOwned(managed, m, "remove");
    expect(JSON.parse(await readFile(join(home, "existing.json"), "utf8"))).toEqual({ hooks: [] });
    await expect(readFile(join(home, "new.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects payload traversal and cancelled transitions", async () => {
    const { managed, m } = await fixture(); m.files[0]!.payload = "../outside";
    await expect(transitionOwned(managed, m, "enable")).rejects.toThrow("Invalid managed install path");
    await expect(transitionOwned(managed, m, "enable", AbortSignal.abort())).rejects.toThrow();
  });
});
describe("BB lifecycle", () => {
  it("cleans a disabled installation and keeps failed hosts registered for retry", async () => {
    const kv = kvFixture(); await registerNativeInstallHost(kv, "mini"); await registerNativeInstallHost(kv, "ovh");
    const callHost = vi.fn(async ({ hostId }: { hostId: string }) => { if (hostId === "ovh") throw new Error("offline"); });
    await expect(experimental_vkLifecycle({ kv, callHost, signal: new AbortController().signal, action: "remove" })).rejects.toThrow("offline");
    expect(await kv.list()).toEqual(["native-install:host:ovh"]);
    expect(callHost.mock.calls[0]?.[0]).toMatchObject({ input: { action: "remove" } });
  });
  it("prevents installation on a core without cleanup support", async () => {
    const call = vi.fn();
    const installer = createNativeInstaller({ supported: false, kv: kvFixture(), call, log: () => {} });
    await expect(installer.install("mini")).rejects.toThrow("experimental_vkPluginLifecycle"); expect(call).not.toHaveBeenCalled();
  });
  it("starts automatic installation and permits the next dispatch only after readiness", async () => {
    let enabled = false;
    const installer = createNativeInstaller({ supported: true, kv: kvFixture(), call: async (_, action) => { if (action === "install") enabled = true; return { status: enabled ? "enabled" : "absent" }; }, log: () => {} });
    await expect(installer.ensure("mini")).rejects.toThrow("Начата установка");
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(installer.ensure("mini")).resolves.toBeUndefined();
  });
});
