import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256FileOrNull } from "../src/hash";
import { hideS8Files, restoreS8Files } from "../src/s8";

describe("S8 hide/restore", () => {
  it("deletes a file that did not exist before install", async () => {
    const home = mkdtempSync(join(tmpdir(), "lane-pilot-s8-"));
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents/routing.profile.yaml"), "schema_version: 1\n");
    const before = await sha256FileOrNull(join(home, ".agents/routing.profile.yaml"));
    const stash = await hideS8Files(home);
    expect(stash.existed).toEqual([".agents/routing.profile.yaml"]);
    writeFileSync(join(home, ".agents/capabilities.json"), "{}\n");
    writeFileSync(join(home, ".agents/night-shift.yaml"), "created: true\n");
    await restoreS8Files(stash, home);
    expect(await sha256FileOrNull(join(home, ".agents/routing.profile.yaml"))).toBe(before);
    expect(await sha256FileOrNull(join(home, ".agents/capabilities.json"))).toBeNull();
    expect(await sha256FileOrNull(join(home, ".agents/night-shift.yaml"))).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});
