import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSync } from "esbuild";
import { prepareWorktree } from "../../src/rooms/worktree";

it.each([["", ""], ["aiphoto_bot", "aiphoto_bot"], ["aiphoto_bot", ""]])("workspace %s → %s gets root tools plus the destination's sibling SDK", async (prefix, targetPrefix) => {
  // Independent temporary repositories model source/destination; no linked worktree or live project is created.
  const temp = await mkdtemp(join(tmpdir(), "lp-section-deps-"));
  const base = join(temp, "base"), target = join(temp, "target");
  try {
    for (const [root, label] of [[base, "base"], [target, "target"]] as const) {
      await mkdir(join(root, "aiphoto_bot"), { recursive:true });
      await mkdir(join(root, "platform/sdk"), { recursive:true });
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, ".gitignore"), "node_modules/\n");
      await writeFile(join(root, "package.json"), JSON.stringify({ private:true, workspaces:["platform/sdk"] }));
      await writeFile(join(root, "platform/sdk/package.json"), JSON.stringify({ name:"@fleet/sdk", main:"index.js" }));
      await writeFile(join(root, "platform/sdk/index.js"), `module.exports = ${JSON.stringify(label)};\n`);
    }
    await mkdir(join(base, "node_modules/.bin"), { recursive:true });
    await mkdir(join(base, "node_modules/typescript/bin"), { recursive:true });
    await mkdir(join(base, "node_modules/@fleet"), { recursive:true });
    await writeFile(join(base, "node_modules/typescript/bin/tsc"), '#!/usr/bin/env node\nconsole.log("fixture-tsc");\n');
    await chmod(join(base, "node_modules/typescript/bin/tsc"), 0o755);
    await symlink("../typescript/bin/tsc", join(base, "node_modules/.bin/tsc"));
    await symlink("../../platform/sdk", join(base, "node_modules/@fleet/sdk"));
    const section = join(target, targetPrefix);
    await prepareWorktree({ basePath:join(base, prefix), worktreePath:section });
    expect(execFileSync(targetPrefix ? "../node_modules/.bin/tsc" : "./node_modules/.bin/tsc", [], { cwd:section, encoding:"utf8" }).trim()).toBe("fixture-tsc");
    expect(execFileSync(process.execPath, ["-e", 'console.log(require("@fleet/sdk"))'], { cwd:section, encoding:"utf8" }).trim()).toBe("target");
    expect(await readFile(join(base, "platform/sdk/index.js"), "utf8")).toBe('module.exports = "base";\n');
  } finally { await rm(temp, { recursive:true, force:true }); }
});


it("refuses mismatched section paths before preparing dependencies", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lp-section-mismatch-"));
  const base = join(temp, "base"), target = join(temp, "target");
  try {
    for (const root of [base, target]) {
      await mkdir(join(root, "bot"), { recursive:true });
      execFileSync("git", ["init", "-q", root]);
    }
    await mkdir(join(target, "other"));
    await expect(prepareWorktree({ basePath:join(base, "bot"), worktreePath:join(target, "other") }))
      .rejects.toThrow("worktree_workspace_mismatch");
    await expect(prepareWorktree({ basePath:join(base, "bot"), worktreePath:target, ownsBarrier:true, ownsPaths:["src/**"] }))
      .rejects.toThrow("worktree_workspace_mismatch");
    await expect(access(join(target, "node_modules"))).rejects.toThrow();
  } finally { await rm(temp, { recursive:true, force:true }); }
});

it("preserves a deep standalone section's dependencies and repoints its sibling SDK", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lp-deep-section-"));
  const base = join(temp, "base"), target = join(temp, "target"), prefix = "apps/group/deep/bot";
  try {
    for (const [root, label] of [[base, "base"], [target, "target"]] as const) {
      await mkdir(join(root, prefix), { recursive:true });
      await mkdir(join(root, "sdk"), { recursive:true });
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, ".gitignore"), "node_modules/\n");
      await writeFile(join(root, prefix, "package.json"), '{"name":"standalone-section"}\n');
      await writeFile(join(root, "sdk/package.json"), '{"name":"sdk","main":"index.js"}\n');
      await writeFile(join(root, "sdk/index.js"), `module.exports = ${JSON.stringify(label)};\n`);
    }
    await mkdir(join(base, prefix, "node_modules/local-tool"), { recursive:true });
    await writeFile(join(base, prefix, "node_modules/local-tool/index.js"), 'module.exports = "local-tool";\n');
    await symlink(join(base, "sdk"), join(base, prefix, "node_modules/sdk"));
    const cwd = join(target, prefix);
    await prepareWorktree({ basePath:join(base, prefix), worktreePath:cwd });
    expect(execFileSync(process.execPath, ["-e", 'console.log(require("local-tool"), require("sdk"))'], { cwd, encoding:"utf8" }).trim())
      .toBe("local-tool target");
  } finally { await rm(temp, { recursive:true, force:true }); }
});


it("installs a standalone section's local dependencies with an isolated home and offline npm", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lp-section-install-"));
  const base = join(temp, "base"), target = join(temp, "target");
  try {
    for (const [root, label] of [[base, "base"], [target, "target"]] as const) {
      await mkdir(join(root, "bot/tool"), { recursive:true });
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, ".gitignore"), "node_modules/\n");
      await writeFile(join(root, "bot/package.json"), JSON.stringify({ name:"section", version:"1.0.0", dependencies:{ "local-tool":"file:tool" } }));
      await writeFile(join(root, "bot/tool/package.json"), JSON.stringify({ name:"local-tool", version:"1.0.0", main:"index.js" }));
      await writeFile(join(root, "bot/tool/index.js"), `module.exports = ${JSON.stringify(label)};\n`);
      await writeFile(join(root, "bot/package-lock.json"), JSON.stringify({ name:"section", version:"1.0.0", lockfileVersion:3, requires:true, packages:{
        "":{ name:"section", version:"1.0.0", dependencies:{ "local-tool":"file:tool" } },
        "node_modules/local-tool":{ resolved:"tool", link:true }, "tool":{ name:"local-tool", version:"1.0.0" },
      } }));
    }
    const script = join(temp, "prepare.cjs");
    buildSync({ stdin:{ contents:`import { prepareWorktree } from ${JSON.stringify(join(process.cwd(), "src/rooms/worktree/worktree-lifecycle.ts"))}; prepareWorktree(JSON.parse(process.argv[2])).catch(e => { console.error(e); process.exitCode=1; });`, resolveDir:process.cwd(), loader:"ts" },
      bundle:true, platform:"node", format:"cjs", outfile:script, logLevel:"silent" });
    execFileSync(process.execPath, [script, JSON.stringify({ basePath:join(base, "bot"), worktreePath:join(target, "bot") })], {
      env:{ ...process.env, HOME:join(temp, "home"), npm_config_cache:join(temp, "cache"), npm_config_offline:"true", npm_config_ignore_scripts:"true" }, timeout:30_000,
    });
    expect(execFileSync(process.execPath, ["-e", 'console.log(require("local-tool"))'], { cwd:join(target, "bot"), encoding:"utf8" }).trim()).toBe("target");
    const journal = await readFile(join(temp, "home/.lane-pilot/store-journal.jsonl"), "utf8");
    expect(JSON.parse(journal.trim().split("\n")[0]!)).toMatchObject({ dir:join(base, "bot"), command:"npm ci --no-audit --no-fund", exitCode:0 });
  } finally { await rm(temp, { recursive:true, force:true }); }
}, 45_000);
