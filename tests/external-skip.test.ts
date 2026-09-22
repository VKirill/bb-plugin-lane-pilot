import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instrumentInstallSh, writeSkipWrappers } from "../src/install-runner";

const UPSTREAM = join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack");
const INSTALL_SH = readFileSync(join(UPSTREAM, "install.sh"), "utf8");
const NPM_BLOCK = INSTALL_SH.slice(
  INSTALL_SH.indexOf("# OpenCode → Cursor subscription models."),
  INSTALL_SH.indexOf('if [[ -f "$HOME/.config/opencode/opencode.json" && -f "$STACK_ROOT/profiles/opencode/opencode-lane.ts" ]]; then'),
);

describe("D1 skip wrappers block install.sh npm/open-cursor", () => {
  it("blocks npm install -g @rama_nigg/open-cursor when open-cursor is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-pilot-d1-"));
    const home = join(root, "home");
    const stubDir = join(root, "stubs");
    const wrapperDir = join(root, "wrappers");
    const stubLog = join(root, "stub.log");
    const skipLog = join(root, "skip.log");
    mkdirSync(join(home, ".config/opencode"), { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(home, ".config/opencode/opencode.json"), "{}\n");
    for (const name of ["npm", "opencode", "cursor-agent"]) {
      writeFileSync(join(stubDir, name), `#!/bin/bash
printf '%s\\n' "STUB ${name} $*" >> ${JSON.stringify(stubLog)}
if [[ "${name}" == "npm" && "$*" == *@rama_nigg/open-cursor* ]]; then
  printf '%s\\n' STUB_INSTALLED >> ${JSON.stringify(stubLog)}
fi
exit 0
`);
      chmodSync(join(stubDir, name), 0o755);
    }
    const previousPath = process.env.PATH;
    process.env.PATH = stubDir;
    await writeSkipWrappers(wrapperDir, skipLog);
    process.env.PATH = previousPath;
    rmSync(join(wrapperDir, "open-cursor"));
    const result = spawnSync("bash", ["-c", NPM_BLOCK], {
      env: { ...process.env, HOME: home, PATH: `${wrapperDir}:${stubDir}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("skipped npm install -g @rama_nigg/open-cursor");
    expect(existsSync(stubLog) ? readFileSync(stubLog, "utf8") : "").not.toContain("STUB_INSTALLED");
    expect(readFileSync(skipLog, "utf8")).toMatch(/blocked npm install -g @rama_nigg\/open-cursor/);
    rmSync(root, { recursive: true, force: true });
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
