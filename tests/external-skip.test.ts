import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instrumentInstallSh, isolatedNpmPrefix, writeSkipWrappers } from "../src/install-runner";
import { hostHasOpenCursorPackage, isolatedTestPath, linkSafeTools, snapshotGlobalOpenCursor } from "./npm-isolation";

const UPSTREAM = join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack");
const INSTALL_SH = readFileSync(join(UPSTREAM, "install.sh"), "utf8");
const NPM_BLOCK = INSTALL_SH.slice(
  INSTALL_SH.indexOf("# OpenCode → Cursor subscription models."),
  INSTALL_SH.indexOf('if [[ -f "$HOME/.config/opencode/opencode.json" && -f "$STACK_ROOT/profiles/opencode/opencode-lane.ts" ]]; then'),
);

describe("D1 skip wrappers block install.sh npm/open-cursor", () => {
  it("never execs real npm and leaves the host global prefix unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-pilot-d1-"));
    const home = join(root, "home");
    const stubDir = join(root, "stubs");
    const wrapperDir = join(root, "wrappers");
    const toolsDir = join(root, "safe-tools");
    const skipLog = join(root, "skip.log");
    const prefix = isolatedNpmPrefix(home);
    mkdirSync(join(home, ".config/opencode"), { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(home, ".config/opencode/opencode.json"), "{}\n");
    for (const name of ["opencode", "cursor-agent"]) {
      writeFileSync(join(stubDir, name), "#!/bin/bash\nexit 0\n");
      chmodSync(join(stubDir, name), 0o755);
    }
    linkSafeTools(toolsDir);
    await writeSkipWrappers(wrapperDir, skipLog);
    expect(readFileSync(join(wrapperDir, "npm"), "utf8")).not.toMatch(/\bexec\b/);
    expect(readFileSync(join(wrapperDir, "npx"), "utf8")).not.toMatch(/\bexec\b/);
    rmSync(join(wrapperDir, "open-cursor"));
    const before = snapshotGlobalOpenCursor();
    const result = spawnSync("bash", ["-c", NPM_BLOCK], {
      env: {
        HOME: home,
        PATH: isolatedTestPath([wrapperDir, stubDir, toolsDir]),
        npm_config_prefix: prefix,
        NPM_CONFIG_PREFIX: prefix,
      },
      encoding: "utf8",
    });
    const after = snapshotGlobalOpenCursor();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("real npm is never invoked");
    expect(readFileSync(skipLog, "utf8")).toMatch(/blocked npm install -g @rama_nigg\/open-cursor/);
    expect(existsSync(join(prefix, "lib/node_modules/@rama_nigg/open-cursor"))).toBe(false);
    expect(after).toEqual(before);
    expect(after.packageExists).toBe(false);
    expect(hostHasOpenCursorPackage()).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails if a leaked npm install writes the host global prefix", async () => {
    const before = snapshotGlobalOpenCursor();
    expect(hostHasOpenCursorPackage(), "host global prefix already has @rama_nigg/open-cursor").toBe(false);
    expect(before.packageExists).toBe(false);
    expect(Object.values(before.bins).some(Boolean)).toBe(false);
  });

  it("instruments all five production install.sh checkpoints", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "lane-pilot-anchors-")), "install.sh");
    await instrumentInstallSh(
      join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack"),
      dest,
    );
    const text = readFileSync(dest, "utf8");
    for (const phase of ["npm", "mkdir", "rsync", "settings", "install_json"]) {
      expect(text).toContain(`lane-pilot checkpoint ${phase}`);
    }
  });
});
