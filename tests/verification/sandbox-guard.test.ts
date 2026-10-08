import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareGuardPaths, releaseGuardPaths } from "../../src/verification/sandbox";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive:true, force:true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "lane-pilot-guard-"));
  roots.push(root);
  return root;
}

describe("sandbox guard paths", () => {
  it("creates a missing guard path for the read-only mount and removes it afterwards", async () => {
    const root = workspace();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".agents"));
    const prepared = await prepareGuardPaths(root);
    expect(prepared.guardPaths).toEqual([join(root, ".git"), join(root, ".agents"), join(root, ".cls")]);
    expect(prepared.created).toEqual([join(root, ".cls")]);
    expect(existsSync(join(root, ".cls"))).toBe(true);
    await releaseGuardPaths(prepared.created);
    expect(existsSync(join(root, ".cls"))).toBe(false);
    expect(existsSync(join(root, ".agents"))).toBe(true);
  });

  it("shares a created guard path between checks running at once and removes it after the last one", async () => {
    const root = workspace();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".agents"));
    const [first, second] = await Promise.all([prepareGuardPaths(root), prepareGuardPaths(root)]);
    expect(first.created).toEqual([join(root, ".cls")]);
    expect(second.created).toEqual([join(root, ".cls")]);
    await releaseGuardPaths(first.created);
    expect(existsSync(join(root, ".cls"))).toBe(true);
    await releaseGuardPaths(second.created);
    expect(existsSync(join(root, ".cls"))).toBe(false);
  });

  it("still refuses a guard path that is a symlink", async () => {
    const root = workspace();
    symlinkSync(tmpdir(), join(root, ".agents"));
    await expect(prepareGuardPaths(root)).rejects.toThrow("sandbox_guard_path_symlink: .agents");
  });
});
