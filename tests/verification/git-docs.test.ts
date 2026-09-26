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

it("lists code changed since the docs were last committed, not docs or tooling", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await writeFile(join(root, "old.ts"), "1");
    await mkdir(join(root, "docs")); await writeFile(join(root, "docs/a.md"), "# a");
    git(root, "add", "."); gitAt("2000-01-01T00:00:00", root, "commit", "-qm", "docs");
    const docsCommit = git(root, "rev-parse", "HEAD").toString().trim();
    await mkdir(join(root, "lib")); await writeFile(join(root, "lib/new.ts"), "2");
    git(root, "add", "."); git(root, "commit", "-qm", "code");
    await writeFile(join(root, "draft.ts"), "3");
    // The window says "since a minute ago", but the docs describe the code of 2000: that is the base.
    const scope = await gitDocsScope({ projectCwd: root, sinceEpochMs: Date.now() - 60_000 });
    expect(scope).toMatchObject({ status: "ready", isRepoRoot: true, hasDocs: true, base: docsCommit, changed: ["draft.ts", "lib/new.ts"], dirty: ["draft.ts"] });
    expect(scope.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await gitDocsScope({ projectCwd: join(root, "lib"), sinceEpochMs: 0 })).isRepoRoot).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("falls back to the time window when no commit has touched docs/", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await writeFile(join(root, "old.ts"), "1"); git(root, "add", "."); gitAt("2000-01-01T00:00:00", root, "commit", "-qm", "old");
    const since = Date.now() - 60_000;
    await writeFile(join(root, "new.ts"), "2"); git(root, "add", "."); git(root, "commit", "-qm", "new");
    expect((await gitDocsScope({ projectCwd: root, sinceEpochMs: since })).changed).toEqual(["new.ts"]);
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
