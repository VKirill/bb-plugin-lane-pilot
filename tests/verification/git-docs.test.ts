import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nightlyDocsPrompt } from "../../src/stages/docs";
import { gitDocsScope } from "../../src/verification/git-docs";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
const gitAt = (date: string, cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });

it("lists code changed since the window, not docs or tooling, and tells a repo root from a subfolder", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await writeFile(join(root, "old.ts"), "1");
    git(root, "add", "."); gitAt("2000-01-01T00:00:00", root, "commit", "-qm", "old");
    const since = Date.now() - 60_000;
    await mkdir(join(root, "lib")); await writeFile(join(root, "lib/new.ts"), "2");
    await mkdir(join(root, "docs")); await writeFile(join(root, "docs/a.md"), "# a");
    git(root, "add", "."); git(root, "commit", "-qm", "new");
    await writeFile(join(root, "draft.ts"), "3");
    const scope = await gitDocsScope({ projectCwd: root, sinceEpochMs: since });
    expect(scope).toMatchObject({ status: "ready", isRepoRoot: true, hasDocs: true, changed: ["draft.ts", "lib/new.ts"], dirty: ["draft.ts"] });
    expect(scope.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await gitDocsScope({ projectCwd: join(root, "lib"), sinceEpochMs: since })).isRepoRoot).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reports a folder outside git", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-"));
  try { expect((await gitDocsScope({ projectCwd: root, sinceEpochMs: 0 })).status).toBe("not-git"); }
  finally { await rm(root, { recursive: true, force: true }); }
});

it("asks for onboarding without docs/ and for changed-code pages otherwise", () => {
  const onboarding = nightlyDocsPrompt({ since: "yesterday", hasDocs: false, changed: [] });
  expect(onboarding).toContain("there is no docs/ yet");
  expect(onboarding).toContain("docs/architecture.md");
  const prompt = nightlyDocsPrompt({ since: "yesterday", hasDocs: true, changed: ["lib/a.ts"], refresh: ["docs/features/a.md"] });
  expect(prompt).toContain("- lib/a.ts");
  expect(prompt).toContain("- docs/features/a.md");
  expect(prompt).toContain("Write only docs/**, README.md and PROJECT.md");
});
