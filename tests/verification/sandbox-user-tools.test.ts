import { mkdir, mkdtemp, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkUserToolHomes, userToolBins } from "../../src/rooms/verification/sandbox";

/** A project's own toolchain lives in the user's home (rokit's rojo and lune): the sandbox finds it (Vampirism Fire, 2026-10-23). */
describe("the user's tools in the check sandbox", () => {
  it("puts the tool bin folders that exist on PATH and links their homes into the temp HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "lp-home-"));
    await mkdir(join(home, ".rokit", "bin"), { recursive: true });
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    expect(userToolBins(home)).toEqual([join(home, ".rokit/bin"), join(home, ".local/bin")]);
    const temp = await mkdtemp(join(tmpdir(), "lp-sandbox-"));
    expect(await linkUserToolHomes(temp, home)).toEqual([".rokit"]);
    expect(await readlink(join(temp, ".rokit"))).toBe(join(home, ".rokit"));
  });
});
