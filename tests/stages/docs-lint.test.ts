import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKLINKS_MARK, buildBacklinks, buildDocsIndex, docsCompletenessGaps, lintDocsPages, pagesToRefresh, withVerifiedConfidence } from "../../src/stages/docs-lint";
import { commitDocs } from "../../src/verification/git-docs";

const page = (fields: Record<string, string>, body: string) => [
  "---",
  ...Object.entries({ title: "Checks", type: "component", created: "2026-09-26", updated: "2026-09-26", status: "active",
    confidence: "medium", tags: "[http]", ...fields }).map(([key, value]) => `${key}: ${value}`),
  "sources:", "  - src/check.ts", "---", "", body,
].join("\n");
const good = "# Checks\n\nChecks run each minute (src/check.ts:1-3). Status is recorded (src/check.ts:5). Errors are kept (src/check.ts:7). See [CLI](cli.md).\n";

it("passes a page that follows the methodology", () => {
  const pages = [{ path: "docs/features/checks.md", content: page({}, good) }, { path: "docs/features/cli.md", content: page({ title: "CLI" }, good.replace("# Checks", "# CLI")) }];
  expect(lintDocsPages(pages, { "src/check.ts": 9 })).toEqual([]);
});

it("reports each rule a page breaks", () => {
  const bad = page({ type: "tutorial", confidence: "certain" }, "# Other title\n\nA powerful checker (src/check.ts:40). See [missing](nope.md).\n\n## Referenced by\n");
  const rules = lintDocsPages([{ path: "docs/features/checks.md", content: bad }], { "src/check.ts": 9 }).map((finding) => `${finding.rule}:${finding.detail}`);
  expect(rules).toEqual(expect.arrayContaining([
    expect.stringMatching(/^frontmatter:type must be/),
    expect.stringMatching(/^frontmatter:confidence must be/),
    "structure:H1 must match the frontmatter title",
    expect.stringMatching(/^builder:/),
    expect.stringMatching(/^evidence:needs at least 3/),
    "evidence:cites src/check.ts:40, but the file has 9 lines",
    'wording:marketing word "powerful"',
    expect.stringMatching(/^links:link nope.md/),
  ]));
  expect(lintDocsPages([{ path: "docs/x.md", content: "# no frontmatter" }], {})[0]!.rule).toBe("frontmatter");
});

it("refreshes pages whose sources changed and indexes every page", () => {
  const pages = [{ path: "docs/features/checks.md", content: page({}, good) }, { path: "docs/other.md", content: page({ title: "Other", status: "draft" }, good) }];
  expect(pagesToRefresh(pages, ["src/check.ts"])).toEqual(["docs/features/checks.md", "docs/other.md"]);
  expect(pagesToRefresh(pages, ["src/unrelated.ts"])).toEqual(["docs/other.md"]);
  expect(buildDocsIndex(pages)).toContain("| [Checks](features/checks.md) | component | active | 2026-09-26 |");
});

it("commits only the docs paths it is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-commit-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  try {
    git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    await writeFile(join(root, "a.ts"), "1"); git("add", "."); git("commit", "-qm", "base");
    await mkdir(join(root, "docs")); await writeFile(join(root, "docs/a.md"), "# a\n"); await writeFile(join(root, "a.ts"), "2");
    const result = await commitDocs({ projectCwd: root, paths: ["docs/a.md"], message: "docs: test" });
    expect(result.status).toBe("committed");
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("docs/a.md");
    expect(git("status", "--porcelain").trim()).toBe("M a.ts");
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("2");
    expect((await commitDocs({ projectCwd: root, paths: ["docs/a.md"], message: "docs: again" })).status).toBe("nothing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("lists missing required pages and core code no citation covers", () => {
  const pages = [{ path:"docs/overview.md", content:page({ type:"overview", title:"Overview" }, "# Overview\n\nRuns checks (src/check.ts:1-3).\n") }];
  const gaps = docsCompletenessGaps(pages, { tables:["monitors"], core:[
    { name:"runChecks", file:"src/check.ts", line:2, endLine:6 },
    { name:"parseArgv", file:"src/cli.ts", line:10, endLine:30 },
  ] });
  expect(gaps).toEqual({ missingPages:["docs/architecture.md", "docs/gotchas.md", "docs/data-model.md"], uncoveredCore:["parseArgv (src/cli.ts:10-30)"] });
  expect(docsCompletenessGaps(pages, { tables:[], core:[] }).missingPages).not.toContain("docs/data-model.md");
});

it("needs every cited file in sources and asks for deployment when the project builds", () => {
  const cites = page({}, "# Checks\n\nA (src/check.ts:1). B (src/other.ts:2). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/a.md", content:cites }], { "src/check.ts":9, "src/other.ts":9 }).map((f) => f.detail))
    .toContain("sources must list every cited file; missing src/other.ts");
  expect(docsCompletenessGaps([], { tables:[], deploy:true, core:[] }).missingPages).toContain("docs/deployment.md");
});

it("builds Referenced by blocks the lint accepts, and rebuilds them without duplicates", () => {
  const pages = [
    { path:"docs/features/checks.md", content:page({}, good) },
    { path:"docs/features/cli.md", content:page({ title:"CLI" }, good.replace("# Checks", "# CLI").replace("[CLI](cli.md)", "[Checks](checks.md)")) },
    { path:"docs/overview.md", content:page({ title:"Overview", type:"overview" }, "# Overview\n\nSee [checks](features/checks.md) (src/check.ts:1, src/check.ts:2, src/check.ts:3).\n") },
  ];
  const built = buildBacklinks(pages);
  const checks = built.find((p) => p.path === "docs/features/checks.md")!.content;
  expect(checks).toContain(`${BACKLINKS_MARK}\n## Referenced by\n\n- [CLI](cli.md)\n- [Overview](../overview.md)\n`);
  expect(buildBacklinks(built).find((p) => p.path === "docs/features/checks.md")!.content).toBe(checks);
  expect(lintDocsPages(built, { "src/check.ts": 9 })).toEqual([]);
});

it("sets confidence from the verified share of claims", () => {
  const content = page({}, good);
  expect(withVerifiedConfidence(content, { checked:12, supported:12 })).toMatch(/^confidence: high$/m);
  expect(withVerifiedConfidence(content, { checked:10, supported:5 })).toMatch(/^confidence: low$/m);
  expect(withVerifiedConfidence(content, { checked:0, supported:0 })).toBe(content);
});
