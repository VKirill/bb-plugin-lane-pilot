import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ hashes: [] as string[] }));
vi.mock("@lane-pilot/kit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@lane-pilot/kit")>();
  return { ...real, hashPath: async (path: string) => { seen.hashes.push(path); return real.hashPath(path); } };
});

import { hashPath } from "@lane-pilot/kit";
import { seedCompatibleEngine } from "./upstream-adapter/coexistence-helpers";
import { inventoryCoexistenceAtHome, runCoexistenceOperationAtHome } from "../src/rooms/native-install/coexistence";

const input = { projectId: "fixture", hostId: process.env.BB_HOST_ID ?? "fixture-host" };

async function seed() {
  const home = await mkdtemp(join(tmpdir(), "audit-install-meta-"));
  const engine = join(home, "engine");
  await seedCompatibleEngine(engine);
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(join(home, ".agents/install.json"), JSON.stringify({ source_repo: engine, source_sha: "a".repeat(40) }));
  return { home, engine };
}

it("J-003 one read-only inventory hashes an engine root once", async () => {
  const { home, engine } = await seed();
  try {
    seen.hashes = [];
    await inventoryCoexistenceAtHome(input, home);
    const count = seen.hashes.filter((path) => path === engine).length;
    expect(count).toBe(1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("A-029 failed plugin ownership metadata must leave no installed orphan", async () => {
  const { home } = await seed();
  try {
    const ledger = join(home, ".agents/lane-pilot/coexistence/ownership.json");
    await mkdir(join(ledger, ".."), { recursive: true });
    await writeFile(ledger, "invalid-json");
    const row = (await inventoryCoexistenceAtHome(input, home)).managers.find((item) => item.manager === "opencode-plugin")!;
    let failure = "";
    try {
      await runCoexistenceOperationAtHome({ ...input, operation: "install", manager: "opencode-plugin", path: row.path, expectedSha256: null }, home);
    } catch (error) { failure = String(error); }
    expect(failure).toContain("ownership ledger is invalid JSON");
    const remains = await stat(row.path).then(() => true, () => false);
    const hash = remains ? (await hashPath(row.path)).sha256 : null;
    const retry = await runCoexistenceOperationAtHome({ ...input, operation: "install", manager: "opencode-plugin", path: row.path, expectedSha256: hash }, home);
    expect(remains, JSON.stringify({ failure, pluginRemains: remains, retryStatus: retry.status, ledger: await readFile(ledger, "utf8") })).toBe(false);
    expect(retry.status).toBe("ok");
    expect(await stat(row.path).then(() => true, () => false)).toBe(true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
