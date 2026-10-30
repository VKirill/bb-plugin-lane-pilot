import { execFileSync } from "node:child_process";
import { access, mkdtemp, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOwnershipNoise } from "@lane-pilot/settings-catalog";
import { applyOwnsBarrier, liftOwnsBarrier } from "../src/rooms/verification/git-integrate";
import { dropSatellites, satelliteOf } from "../src/rooms/verification/ownership";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function seededRepo(files: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "lp-owns-barrier-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  for (const file of files) {
    await writeFile(join(dir, file), `${file}\n`, { flag: "w" }).catch(async () => {
      await execFileSync("mkdir", ["-p", join(dir, file.split("/").slice(0, -1).join("/"))]);
      await writeFile(join(dir, file), `${file}\n`);
    });
  }
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
  return dir;
}

describe("owns-paths satellites (F-02)", () => {
  const anchors = ["src/foo.ts", "game/src/match.luau", "packages/i18n/src/keys.ts"];

  it("lets a test and a locale of an owned area pass, keeps other strays as violations", () => {
    const flagged = ["tests/foo.test.ts", "src/foo.test.ts", "game/assets/lang/en.json", "packages/i18n/locales/ru.json", ".cls/catalog.json", "yaml.py", "docs/guide.md"];
    const dropped = dropSatellites(flagged, anchors);
    expect(dropped.unowned).toEqual([".cls/catalog.json", "docs/guide.md", "yaml.py"]);
    expect(dropped.satellites).toEqual(["game/assets/lang/en.json", "packages/i18n/locales/ru.json", "src/foo.test.ts", "tests/foo.test.ts"]);
  });

  it("needs an owned change: a stray test with no anchor stays a violation", () => {
    expect(dropSatellites(["tests/foo.test.ts"], []).unowned).toEqual(["tests/foo.test.ts"]);
    expect(satelliteOf("tests/foo.test.ts", ["docs/other.ts"])).toBe(false);
  });

  it("treats build output wider than tool caches as ownership noise, no anchor needed", () => {
    for (const path of ["packages/app/dist/index.js", "game/build/out.bin", "pkg/target/bin/app", "web/.next/static/x.js", "app/coverage/lcov.info", "src/module.tsbuildinfo"])
      expect(isOwnershipNoise(path)).toBe(true);
    for (const path of ["src/build/helper.ts", "tools/target/run.sh"])
      expect(isOwnershipNoise(path)).toBe(true);
  });
});

describe("owns-paths barrier (F-01)", () => {
  it("locks tracked files outside the contract, frees satellites, restores modes on lift", async () => {
    const dir = await seededRepo(["src/a.ts", "src/b.ts", "tests/a.test.ts", "docs/en.json", "docs/guide.md"]);
    const locked = await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: [] });
    // src/b.ts (unowned), docs/en.json (locale without an owned anchor in its area), docs/guide.md are locked;
    // src/a.ts is owned, tests/a.test.ts is a satellite of src/a.ts — both stay writable.
    expect(locked.locked).toBe(3);
    await expect(access(join(dir, "src/b.ts"), constants.W_OK)).rejects.toThrow();
    await expect(access(join(dir, "docs/guide.md"), constants.W_OK)).rejects.toThrow();
    await access(join(dir, "src/a.ts"), constants.W_OK);
    await access(join(dir, "tests/a.test.ts"), constants.W_OK);
    const restored = await liftOwnsBarrier(dir);
    expect(restored.restored).toBe(3);
    await access(join(dir, "src/b.ts"), constants.W_OK);
    await access(join(dir, "docs/guide.md"), constants.W_OK);
    // A second lift finds no barrier state and does nothing.
    expect((await liftOwnsBarrier(dir)).restored).toBe(0);
  });

  it("keeps a file a writer never_touches locked even when it looks like a test", async () => {
    const dir = await seededRepo(["src/a.ts", "src/a.test.ts"]);
    const locked = await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: ["src/a.test.ts"] });
    expect(locked.locked).toBe(1);
    await expect(access(join(dir, "src/a.test.ts"), constants.W_OK)).rejects.toThrow();
    await liftOwnsBarrier(dir);
  });
});
