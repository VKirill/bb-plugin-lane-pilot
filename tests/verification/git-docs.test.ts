import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { flowDocsWritable, nightlyDocsPrompt } from "../../src/rooms/docs/docs";
import { docsWorthinessFacts, gitDocsScope, revertPaths } from "../../src/rooms/verification/git-docs";

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

it("finds a monorepo's workspaces and scopes a workspace's own docs folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-mono-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces:["apps/*", "packages/infra/*"] }));
    for (const [dir, files] of [["apps/api", 3], ["apps/web", 1], ["packages/infra/db", 2], ["packages/loose", 4]] as const) {
      await mkdir(join(root, dir, "src"), { recursive:true });
      await writeFile(join(root, dir, "package.json"), JSON.stringify({ name:`@x/${dir.split("/").pop()}` }));
      for (let i = 0; i < files; i++) await writeFile(join(root, dir, "src", `f${i}.ts`), "1");
    }
    await writeFile(join(root, "apps/api/src/f0.test.ts"), "1");
    await mkdir(join(root, "apps/api/docs")); await writeFile(join(root, "apps/api/docs/overview.md"), "# a");
    git(root, "add", "."); git(root, "commit", "-qm", "base");
    await writeFile(join(root, "apps/api/src/f1.ts"), "2"); await writeFile(join(root, "apps/api/docs/overview.md"), "# b");
    const scope = await gitDocsScope({ projectCwd:root, sinceEpochMs:0, docsDir:"apps/api/docs" });
    expect(scope.workspaces).toEqual([
      { path:"apps/api", name:"@x/api", codeFiles:3 }, { path:"apps/web", name:"@x/web", codeFiles:1 }, { path:"packages/infra/db", name:"@x/db", codeFiles:2 },
    ]);
    expect(scope).toMatchObject({ hasDocs:true, changed:["apps/api/src/f1.ts"] });
    expect((await gitDocsScope({ projectCwd:root, sinceEpochMs:0 })).hasDocs).toBe(false);
  } finally { await rm(root, { recursive:true, force:true }); }
});

it("puts back files changed outside docs and removes files created there", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-revert-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await writeFile(join(root, "AGENTS.md"), "rules"); git(root, "add", "."); git(root, "commit", "-qm", "base");
    await writeFile(join(root, "AGENTS.md"), "rewritten"); await writeFile(join(root, "stray.ts"), "x");
    expect(await revertPaths({ projectCwd:root, paths:["AGENTS.md", "stray.ts", "../escape"] })).toEqual({ reverted:["AGENTS.md", "stray.ts"], failed:["../escape"] });
    expect(git(root, "status", "--porcelain").toString()).toBe("");
  } finally { await rm(root, { recursive:true, force:true }); }
});

it("tells a workspace's docs agent to stay in its folder and link to the root docs", () => {
  const prompt = nightlyDocsPrompt({ since:"yesterday", hasDocs:false, changed:[], unit:{ docsDir:"apps/api/docs", workspace:{ path:"apps/api", name:"@x/api" } } });
  expect(prompt).toContain("Create:\n- apps/api/docs/overview.md (overview)");
  expect(prompt).toContain("../../../docs/architecture.md");
  expect(prompt).toContain("Write only apps/api/docs/**;");
  const rootPrompt = nightlyDocsPrompt({ since:"yesterday", hasDocs:false, changed:[], unit:{ docsDir:"docs", workspaces:[
    { path:"apps/api", name:"@x/api", docsDir:"apps/api/docs" }, { path:"packages/result", name:"@x/result", docsDir:null }] } });
  expect(rootPrompt).toContain("- @x/api: apps/api/docs/overview.md");
  expect(rootPrompt).toContain("docs/packages.md (component)");
  expect(rootPrompt).toContain("Write only docs/**, README.md and PROJECT.md;");
});

it("gives each flow its own agent, page and skeleton, and has the root link the flows", () => {
  const flow = { slug:"generation", name:"generation", briefPath:"/repo/.git/lane-pilot/docs-flow-generation.md", files:[], calls:[] };
  const prompt = nightlyDocsPrompt({ since:"yesterday", hasDocs:false, changed:[], unit:{ docsDir:"docs", flow } });
  expect(prompt).toContain("Task: write docs/flows/generation.md.");
  expect(prompt).toContain("/repo/.git/lane-pilot/docs-flow-generation.md");
  expect(prompt).toContain("Write only docs/flows/generation.md and docs/flows/generation/**;");
  expect(flowDocsWritable("generation")("docs/flows/generation/modes.md")).toBe(true);
  expect(flowDocsWritable("generation")("docs/flows/payment.md")).toBe(false);
  const root = nightlyDocsPrompt({ since:"yesterday", hasDocs:false, changed:[], unit:{ docsDir:"docs", flows:["generation"] } });
  expect(root).toContain("do not write docs/flows/:\n- docs/flows/generation.md");
});

it("keeps the root's base on its own pages when flow pages are committed after a code change", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-base-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await mkdir(join(root, "docs/flows"), { recursive:true }); await writeFile(join(root, "docs/overview.md"), "# o"); await writeFile(join(root, "a.ts"), "1");
    git(root, "add", "."); git(root, "commit", "-qm", "root docs");
    await writeFile(join(root, "a.ts"), "2"); git(root, "commit", "-qam", "code");
    await writeFile(join(root, "docs/flows/x.md"), "# x"); git(root, "add", "."); git(root, "commit", "-qm", "flow docs");
    expect((await gitDocsScope({ projectCwd:root, sinceEpochMs:0 })).changed).toEqual([]);
    expect((await gitDocsScope({ projectCwd:root, sinceEpochMs:0, exclude:["docs/flows"] })).changed).toEqual(["a.ts"]);
  } finally { await rm(root, { recursive:true, force:true }); }
});

it("asks the root to turn new decision drafts into ADRs", () => {
  const prompt = nightlyDocsPrompt({ since:"yesterday", hasDocs:true, changed:[], unit:{ docsDir:"docs" }, decisionDrafts:[".agents/decisions/2026-09-27-refund-once.md"] });
  expect(prompt).toContain("Add each draft below as an ADR");
  expect(prompt).toContain("- .agents/decisions/2026-09-27-refund-once.md");
});

it("tells a codebase from a content folder, counting only the folder's own commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-worth-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await mkdir(join(root, "app/src"), { recursive: true }); await mkdir(join(root, "app/tests")); await mkdir(join(root, "ads"));
    await writeFile(join(root, "app/package.json"), "{}");
    for (const name of ["a", "b", "c"]) await writeFile(join(root, `app/src/${name}.ts`), "export {}");
    await writeFile(join(root, "app/tests/a.test.ts"), "1");
    await writeFile(join(root, "app/Dockerfile"), "FROM node");
    for (const name of ["banner.png", "copy.md", "plan.csv"]) await writeFile(join(root, `ads/${name}`), "x");
    git(root, "add", "app"); gitAt("2000-01-01T00:00:00", root, "commit", "-qm", "old app");
    git(root, "add", "ads"); git(root, "commit", "-qm", "ads now");
    const app = await docsWorthinessFacts({ projectCwd: join(root, "app") });
    expect(app).toMatchObject({ status: "ready", codeFiles: 3, testFiles: 1, contentFiles: 0, manifests: ["package.json"], deploy: true, commits30d: 0, docsPages: 0 });
    expect(app.languages).toEqual([{ ext: "ts", files: 3 }]);
    const ads = await docsWorthinessFacts({ projectCwd: join(root, "ads") });
    expect(ads).toMatchObject({ status: "ready", codeFiles: 0, contentFiles: 3, commits30d: 1 });
    expect((await docsWorthinessFacts({ projectCwd: tmpdir() })).status).toBe("not-git");
  } finally { await rm(root, { recursive: true, force: true }); }
});
