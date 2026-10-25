import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareWorktree } from "../../src/rooms/verification/git-integrate";
import { linkUserToolHomes } from "../../src/rooms/verification/sandbox";
import { git, repo } from "./git-integrate-helpers";

/**
 * Two checks of the class «verification failed (<check>)» that were red only in Lane Pilot's environment (2026-10-24, SelfyStudio on OVH):
 * - site-en-home-client-js: Playwright in the sandbox's temp HOME found no browsers («Executable doesn't exist at
 *   …/lane-pilot-sandbox-…/.cache/ms-playwright/chromium_headless_shell-1234/…»);
 * - site-seo-shared: site-og-renderer had merged satori and @resvg/resvg-js into package-lock.json, main's node_modules never got
 *   them, and the worktree mirrored from it failed `npm run typecheck` with TS2307 in a file the task did not own.
 */
describe("the user's browsers in the check sandbox", () => {
  it("links each installed Playwright browser into a cache folder the temp HOME owns", async () => {
    const home = await mkdtemp(join(tmpdir(), "lp-home-"));
    const cache = join(home, ".cache", "ms-playwright");
    await mkdir(join(cache, "chromium_headless_shell-1234", "chrome-headless-shell-linux64"), { recursive: true });
    await writeFile(join(cache, "chromium_headless_shell-1234", "INSTALLATION_COMPLETE"), "");
    await mkdir(join(cache, "__dirlock"));
    await mkdir(join(cache, ".links"));
    await mkdir(join(home, "Library", "Caches", "ms-playwright", "chromium-1248"), { recursive: true });
    const temp = await mkdtemp(join(tmpdir(), "lp-sandbox-"));

    expect((await linkUserToolHomes(temp, home)).sort()).toEqual([".cache/ms-playwright/chromium_headless_shell-1234", "Library/Caches/ms-playwright/chromium-1248"]);
    expect(await readlink(join(temp, ".cache", "ms-playwright", "chromium_headless_shell-1234"))).toBe(join(cache, "chromium_headless_shell-1234"));
    // The cache folder itself is the sandbox's: `playwright install` of another version and its lock write there, not into the user's cache.
    expect((await lstat(join(temp, ".cache", "ms-playwright"))).isSymbolicLink()).toBe(false);
    await expect(lstat(join(temp, ".cache", "ms-playwright", "__dirlock"))).rejects.toThrow();
    await expect(lstat(join(temp, ".cache", "ms-playwright", ".links"))).rejects.toThrow();
    // Releasing the sandbox removes the links, never the user's browsers.
    await rm(temp, { recursive: true, force: true });
    expect((await lstat(join(cache, "chromium_headless_shell-1234", "INSTALLATION_COMPLETE"))).isFile()).toBe(true);
  });

  it("links nothing when the user has no browser cache", async () => {
    const home = await mkdtemp(join(tmpdir(), "lp-home-"));
    const temp = await mkdtemp(join(tmpdir(), "lp-sandbox-"));
    expect(await linkUserToolHomes(temp, home)).toEqual([]);
    await expect(lstat(join(temp, ".cache"))).rejects.toThrow();
  });
});

describe("main's packages follow a merged lockfile", () => {
  const path = process.env.PATH;
  let bin = "";
  let log = "";
  beforeEach(async () => {
    // A stand-in for npm: `install --no-save` installs what the lockfile lists under "packages" into node_modules and writes npm's record.
    bin = await mkdtemp(join(tmpdir(), "lp-npm-"));
    log = join(bin, "calls.log");
    await writeFile(join(bin, "npm"), `#!/bin/sh
echo "$PWD $*" >> ${JSON.stringify(log)}
node -e 'const fs=require("fs");const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8"));for(const key of Object.keys(lock.packages)){if(key)fs.mkdirSync(key,{recursive:true});}fs.writeFileSync("node_modules/.package-lock.json",JSON.stringify(lock));'
`);
    await chmod(join(bin, "npm"), 0o755);
    process.env.PATH = `${bin}:${path}`;
  });
  afterEach(() => { process.env.PATH = path; });

  const lockfile = (packages: string[]) => `${JSON.stringify({ name: "selfystudio", lockfileVersion: 3,
    packages: Object.fromEntries([["", {}], ...packages.map((name) => [`node_modules/${name}`, { version: "1.0.0" }])]) }, null, 2)}\n`;
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

  async function installedMain() {
    const { base, worktree } = await repo();
    await writeFile(join(base, ".gitignore"), "node_modules\n");
    await writeFile(join(base, "package-lock.json"), lockfile(["typescript"]));
    git(base, "add", "-A"); git(base, "commit", "-qm", "lockfile");
    await mkdir(join(base, "node_modules", "typescript"), { recursive: true });
    await writeFile(join(base, "node_modules", ".package-lock.json"), lockfile(["typescript"]));
    return { base, worktree };
  }

  /** site-og-renderer's merge: the lockfile gains packages, written after npm's record of the last install. */
  async function mergeDependencies(base: string, packages: string[]) {
    await writeFile(join(base, "package-lock.json"), lockfile(packages));
    git(base, "commit", "-qam", "site-og-renderer: satori + @resvg/resvg-js");
    const before = new Date(Date.now() - 60_000);
    await utimes(join(base, "node_modules", ".package-lock.json"), before, before);
  }

  it("installs a merged dependency into main before a worktree mirrors it (site-seo-shared, 2026-10-24)", async () => {
    const { base, worktree } = await installedMain();
    await mergeDependencies(base, ["typescript", "satori", "@resvg/resvg-js"]);
    const attempt = await worktree("site-seo-shared");

    await prepareWorktree({ basePath: base, worktreePath: attempt });

    expect(await calls()).toEqual([`${await realpath(base)} install --no-save --no-audit --no-fund`]);
    expect(await realpath(join(attempt, "node_modules", "satori"))).toBe(await realpath(join(base, "node_modules", "satori")));
    expect(await realpath(join(attempt, "node_modules", "@resvg", "resvg-js"))).toBe(await realpath(join(base, "node_modules", "@resvg", "resvg-js")));
    // The lockfile is main's as merged, and an installed main is not installed again.
    expect(git(base, "status", "--porcelain")).toBe("");
    await prepareWorktree({ basePath: base, worktreePath: await worktree("site-en-home") });
    expect(await calls()).toHaveLength(1);
  });

  it("adds what main installed since to a worktree mirrored before (a sticky writer synced with main)", async () => {
    const { base, worktree } = await installedMain();
    const attempt = await worktree("site-seo-shared");
    await prepareWorktree({ basePath: base, worktreePath: attempt });
    expect(await calls()).toEqual([]);
    await mergeDependencies(base, ["typescript", "satori", "@resvg/resvg-js"]);

    await prepareWorktree({ basePath: base, worktreePath: attempt });

    expect(await realpath(join(attempt, "node_modules", "satori"))).toBe(await realpath(join(base, "node_modules", "satori")));
    expect(await realpath(join(attempt, "node_modules", "@resvg", "resvg-js"))).toBe(await realpath(join(base, "node_modules", "@resvg", "resvg-js")));
    expect(await realpath(join(attempt, "node_modules", "typescript"))).toBe(await realpath(join(base, "node_modules", "typescript")));
  });

  it("does not run a failing install again for the same lockfile", async () => {
    const { base, worktree } = await installedMain();
    await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(log)}\nexit 1\n`);
    await mergeDependencies(base, ["typescript", "satori"]);
    await prepareWorktree({ basePath: base, worktreePath: await worktree("a") });
    await prepareWorktree({ basePath: base, worktreePath: await worktree("b") });
    expect(await calls()).toHaveLength(1);
  });
});
