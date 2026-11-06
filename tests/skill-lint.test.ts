import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintDraft } from "../src/rooms/forge";
import { lintSkillDir, runSkillLintCli, type SkillFile } from "../src/rooms/forge";

const goodSkill = (body = "Steps: do the thing. Not for bulk edits."): SkillFile[] => [
  { path: "SKILL.md", text: `---\nname: cell-sum\ndescription: Sums empty cells in a sheet. Use when the owner asks for a forged draft of this one skill and nothing else; not for bulk edits.\n---\n${body}\n` },
];

describe("lintSkillDir", () => {
  it("passes a good skill", () => {
    expect(lintSkillDir(goodSkill())).toEqual({ errors: [], warnings: [] });
  });

  it("errors when the description has no «Use when» trigger", () => {
    const files = goodSkill();
    files[0]!.text = files[0]!.text.replace("Use when the owner asks for a forged draft of this one skill and nothing else; not for bulk edits.", "Sums cells in a sheet for the owner when asked nicely please.");
    const { errors } = lintSkillDir(files);
    expect(errors.some((line) => line.includes("trigger"))).toBe(true);
  });

  it("errors when the description is over 1024 characters", () => {
    const files = goodSkill();
    files[0]!.text = files[0]!.text.replace("Sums empty cells", `${"x".repeat(1100)} Sums empty cells`);
    const { errors } = lintSkillDir(files);
    expect(errors.some((line) => line.includes("1024"))).toBe(true);
  });

  it("errors when SKILL.md names a references/ or scripts/ file the folder does not carry", () => {
    const files = goodSkill("Read references/missing.md first, then run scripts/go.sh.");
    const { errors } = lintSkillDir(files);
    expect(errors.filter((line) => line.includes("is named but the skill does not carry it")).length).toBe(2);
    expect(errors.some((line) => line.includes("references/missing.md") && line.includes("scripts/go.sh"))).toBe(false);
  });

  it("passes when the named files exist", () => {
    const files = [...goodSkill("Read references/detail.md, then run scripts/go.sh."),
      { path: "references/detail.md", text: "# detail\n" },
      { path: "scripts/go.sh", text: "#!/bin/sh\necho ok\n" }];
    expect(lintSkillDir(files).errors).toEqual([]);
  });

  it("warns on `|| true` in a script, naming the line", () => {
    const files = [...goodSkill("Run scripts/check.sh."),
      { path: "scripts/check.sh", text: "#!/bin/sh\nmake test || true\n" }];
    const { warnings } = lintSkillDir(files);
    expect(warnings.some((line) => line.includes("scripts/check.sh:2") && line.includes("|| true"))).toBe(true);
  });

  it("warns on `except: pass`, `2>/dev/null` on the main command and an empty catch", () => {
    const files = [...goodSkill(),
      { path: "scripts/a.py", text: "try:\n    run()\nexcept Exception: pass\n" },
      { path: "scripts/b.sh", text: "#!/bin/sh\nprobe 2>/dev/null || fallback\nmain 2>/dev/null\n" },
      { path: "scripts/c.ts", text: "try { go() } catch {}\n" }];
    const { warnings } = lintSkillDir(files);
    expect(warnings.some((line) => line.includes("a.py:3"))).toBe(true);
    expect(warnings.some((line) => line.includes("b.sh:3"))).toBe(true);
    expect(warnings.some((line) => line.includes("c.ts:1"))).toBe(true);
    expect(warnings.some((line) => line.includes("b.sh:2"))).toBe(false);
  });

  it("parses a multi-line `description: >`", () => {
    const files = [{ path: "SKILL.md", text: "---\nname: cell-sum\ndescription: >\n  Sums empty cells in a sheet for the owner.\n  Use when the owner asks for a forged draft of this one skill; not for bulk edits.\n---\nbody\n" }];
    const { errors, warnings } = lintSkillDir(files);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warns, not errors, when the «not for» clause is missing or the body is long", () => {
    const files = [{ path: "SKILL.md", text: `---\nname: cell-sum\ndescription: Sums empty cells in a sheet. Use when the owner asks for a forged draft of this one skill and nothing else.\n---\n${"x\n".repeat(600)}` }];
    const { errors, warnings } = lintSkillDir(files);
    expect(errors).toEqual([]);
    expect(warnings.some((line) => line.includes("not to use"))).toBe(true);
    expect(warnings.some((line) => line.includes("under 500"))).toBe(true);
  });
});

describe("lintDraft on a skill draft", () => {
  it("runs the same rules: a missing «Use when» is an error, warnings do not block", () => {
    const text = "---\nname: cell-sum\ndescription: Sums cells nicely for the owner without any trigger words at all here.\n---\nbody\n";
    expect(lintDraft("skill", "cell-sum", text).map((row) => row.code)).toContain("trigger");
    const good = "---\nname: cell-sum\ndescription: Sums empty cells in a sheet. Use when the owner asks for a forged draft of this one skill and nothing else.\n---\nbody\n";
    expect(lintDraft("skill", "cell-sum", good)).toEqual([]);
  });

  it("a skill draft naming a missing script fails the lint", () => {
    const text = "---\nname: cell-sum\ndescription: Sums empty cells in a sheet. Use when the owner asks for a forged draft of this one skill and nothing else.\n---\nRun scripts/go.sh.\n";
    expect(lintDraft("skill", "cell-sum", text).map((row) => row.code)).toContain("missing_file");
  });
});

describe("runSkillLintCli", () => {
  it("reads a local skill folder: exit 1 on errors, warnings alone exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-lint-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "SKILL.md"), goodSkill("Run scripts/check.sh.")[0]!.text);
    writeFileSync(join(dir, "scripts", "check.sh"), "#!/bin/sh\nmake test || true\n");
    const warned = runSkillLintCli([dir]);
    expect(warned.exitCode).toBe(0);
    expect(warned.stdout).toContain("warning:");
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here\n");
    const failed = runSkillLintCli([dir]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("error:");
    expect(runSkillLintCli([]).exitCode).toBe(1);
    expect(runSkillLintCli([join(dir, "nope")]).exitCode).toBe(1);
  });
});
