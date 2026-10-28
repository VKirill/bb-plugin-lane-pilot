import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readlink, writeFile } from "node:fs/promises";
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

  it("gives the temp HOME a .docker of its own with the config, the CLI plugins and the contexts linked, and nothing else", async () => {
    const home = await mkdtemp(join(tmpdir(), "lp-home-"));
    await mkdir(join(home, ".docker", "cli-plugins"), { recursive: true });
    await mkdir(join(home, ".docker", "buildx"), { recursive: true });
    await writeFile(join(home, ".docker", "config.json"), "{}");
    const temp = await mkdtemp(join(tmpdir(), "lp-sandbox-"));
    expect((await linkUserToolHomes(temp, home)).sort()).toEqual([".docker/cli-plugins", ".docker/config.json"]);
    expect(await readlink(join(temp, ".docker", "cli-plugins"))).toBe(join(home, ".docker", "cli-plugins"));
    expect((await lstat(join(temp, ".docker"))).isSymbolicLink()).toBe(false);
    expect(existsSync(join(temp, ".docker", "buildx"))).toBe(false);
  });
});
