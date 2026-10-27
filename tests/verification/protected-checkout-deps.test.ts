import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorktree, protectedCheckout } from "../../src/rooms/verification/git-integrate";
import { git } from "./git-integrate-helpers";

/**
 * Оживить фото, 2026-10-27: the writers T3 and T6 (acp-cursor) stopped before any work with «EPERM: operation not permitted, open
 * '…/Documents/Мои проекты/TELEGRAM BOTs/Оживить фото/node_modules/vitest/vitest.mjs'»: their worktree sat in ~/.lane-pilot/worktrees,
 * its node_modules linked every package back into the checkout under ~/Documents, and the writer's sandbox may not read there.
 */
describe("a checkout in a protected macOS folder", () => {
  const home = process.env.HOME;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // The rule is macOS's; on another host the test plays macOS (the clone falls back to a plain copy there), so it runs everywhere.
  const asMac = () => Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  afterEach(() => { process.env.HOME = home; Object.defineProperty(process, "platform", platform); });

  it("is recognised only on macOS, under Documents, Desktop, Downloads or iCloud Drive", () => {
    expect(protectedCheckout("/Users/k/Documents/Мои проекты/bot", "/Users/k", "darwin")).toBe(true);
    expect(protectedCheckout("/Users/k/Library/Mobile Documents/x", "/Users/k", "darwin")).toBe(true);
    expect(protectedCheckout("/Users/k/Projects/bot", "/Users/k", "darwin")).toBe(false);
    expect(protectedCheckout("/Users/k/DocumentsOld/bot", "/Users/k", "darwin")).toBe(false);
    expect(protectedCheckout("/home/k/Documents/bot", "/home/k", "linux")).toBe(false);
  });

  it("gives the worktree its own packages, not links into the checkout", async () => {
    const fakeHome = await realpath(await mkdtemp(join(tmpdir(), "lp-home-")));
    process.env.HOME = fakeHome;
    asMac();
    const base = join(fakeHome, "Documents", "Оживить фото");
    await mkdir(join(base, "node_modules", "vitest"), { recursive: true });
    await writeFile(join(base, "node_modules", "vitest", "vitest.mjs"), "export {}\n");
    await mkdir(join(base, "node_modules", "@scope", "lib"), { recursive: true });
    await writeFile(join(base, "node_modules", "@scope", "lib", "index.js"), "1\n");
    await writeFile(join(base, ".gitignore"), "node_modules/\n");
    await writeFile(join(base, "index.ts"), "x\n");
    execFileSync("git", ["init", "-q", "-b", "main", base]);
    git(base, "add", "-A"); git(base, "commit", "-qm", "base");
    const attempt = join(await realpath(await mkdtemp(join(tmpdir(), "lp-wt-"))), "lpattempt_t3");
    git(base, "worktree", "add", "-q", "-b", "bb/t3", attempt, "main");

    await prepareWorktree({ basePath: base, worktreePath: attempt });

    for (const rel of [["vitest"], ["@scope", "lib"]]) {
      const info = await lstat(join(attempt, "node_modules", ...rel));
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.isDirectory()).toBe(true);
    }
    expect(await readFile(join(attempt, "node_modules", "vitest", "vitest.mjs"), "utf8")).toBe("export {}\n");
  });

  it("replaces the links an older worktree already holds", async () => {
    const fakeHome = await realpath(await mkdtemp(join(tmpdir(), "lp-home-")));
    process.env.HOME = fakeHome;
    asMac();
    const base = join(fakeHome, "Documents", "bot");
    await mkdir(join(base, "node_modules", "vitest"), { recursive: true });
    await writeFile(join(base, "node_modules", "vitest", "vitest.mjs"), "export {}\n");
    await writeFile(join(base, ".gitignore"), "node_modules/\n");
    await writeFile(join(base, "index.ts"), "x\n");
    execFileSync("git", ["init", "-q", "-b", "main", base]);
    git(base, "add", "-A"); git(base, "commit", "-qm", "base");
    const attempt = join(await realpath(await mkdtemp(join(tmpdir(), "lp-wt-"))), "lpattempt_t6");
    git(base, "worktree", "add", "-q", "-b", "bb/t6", attempt, "main");
    // The T6 state: node_modules itself a link to the checkout's.
    await symlink(join(base, "node_modules"), join(attempt, "node_modules"), "dir");

    await prepareWorktree({ basePath: base, worktreePath: attempt });

    expect((await lstat(join(attempt, "node_modules"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(attempt, "node_modules", "vitest"))).isSymbolicLink()).toBe(false);
  });
});
