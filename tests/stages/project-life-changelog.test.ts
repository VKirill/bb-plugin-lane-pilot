import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changelogCommand, changelogLine } from "../../src/rooms/project-life/project-life";

describe("project-life changelog by script", () => {
  it("appends one line and commits only CHANGELOG, leaving other staged work alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-cl-"));
    const sh = (cmd: string) => execSync(cmd, { cwd: dir, encoding: "utf8", shell: "/bin/sh" });
    sh("git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init");
    writeFileSync(join(dir, "app.txt"), "owner work\n"); sh("git add app.txt");
    const line = changelogLine({ date: "2026-11-03", runId: "lprun_abc", tasks: [{ id: "t1", title: "Fix\n login 'quotes' $HOME", objective: "", acceptanceSummary: "" }] });
    const sha = sh(changelogCommand(line, "lprun_abc")).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(dir, ".agents/CHANGELOG.md"), "utf8")).toBe("# Changelog\n\n- 2026-11-03 lprun_abc: Fix login 'quotes' $HOME (t1)\n");
    expect(sh("git show --name-only --format= HEAD").trim()).toBe(".agents/CHANGELOG.md");
    expect(sh("git diff --cached --name-only").trim()).toBe("app.txt");
    sh(changelogCommand(changelogLine({ date: "2026-11-03", runId: "lprun_abd", tasks: [{ id: "t2", title: "Two", objective: "", acceptanceSummary: "" }] }), "lprun_abd"));
    expect(readFileSync(join(dir, ".agents/CHANGELOG.md"), "utf8").split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("refuses a run id that could break the shell", () => {
    expect(() => changelogCommand("- x\n", "a'; rm -rf /")).toThrow("project_life_run_id_unsafe");
  });
});
