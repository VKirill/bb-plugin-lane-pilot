import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKLINKS_MARK, blockingDocsFindings, buildBacklinks, expandCitationLists, pageCitations, unlinkedPages, buildDocsIndex, docsCompletenessGaps, lintDocsPages, pagesToRefresh, withCitedSources, withVerifiedConfidence } from "../../src/stages/docs-lint";
import { commitDocs } from "../../src/verification/git-docs";

const page = (fields: Record<string, string>, body: string) => [
  "---",
  ...Object.entries({ title: "Checks", type: "component", created: "2026-09-26", updated: "2026-09-26", status: "active",
    confidence: "medium", tags: "[http]", ...fields }).map(([key, value]) => `${key}: ${value}`),
  "sources:", "  - src/check.ts", "---", "", body,
].join("\n");
const good = "# Checks\n\nChecks run each minute (src/check.ts:1-3).\n\n## How it works\n\nStatus is recorded (src/check.ts:5). Errors are kept (src/check.ts:7). See [CLI](cli.md).\n";

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

it("adds cited files missing from sources and asks for deployment when the project builds", () => {
  const cites = page({}, "# Checks\n\nA (src/check.ts:1). B (src/other.ts:2). C (src/check.ts:3).\n");
  expect(withCitedSources(cites)).toContain("sources:\n  - src/check.ts\n  - src/other.ts\n---");
  expect(withCitedSources(withCitedSources(cites))).toBe(withCitedSources(cites));
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
  const draft = page({ status:"draft", confidence:"low" }, good);
  const verified = withVerifiedConfidence(draft, { checked:10, supported:5, partial:4 });
  expect(verified).toMatch(/^confidence: medium$/m);
  expect(verified).toMatch(/^status: active$/m);
  expect(withVerifiedConfidence(draft, { checked:10, supported:2, partial:4 })).toMatch(/^status: draft$/m);
  expect(withVerifiedConfidence(content, { checked:0, supported:0 })).toBe(content);
});

it("checks and indexes a workspace's own docs folder, and links the workspaces from the root index", () => {
  const pages = [
    { path:"apps/api/docs/overview.md", content:page({ title:"API", type:"overview" }, "# API\n\nServes (src/check.ts:1, src/check.ts:2, src/check.ts:3). See [architecture](../../../docs/architecture.md) and [gone](missing.md).\n") },
    { path:"docs/architecture.md", content:page({ title:"Architecture", type:"architecture" }, "# Architecture\n\nParts (src/check.ts:1-3). API: [overview](../apps/api/docs/overview.md). A (src/check.ts:4). B (src/check.ts:5).\n") },
  ];
  expect(lintDocsPages(pages, { "src/check.ts": 9 }).map((finding) => `${finding.path} ${finding.rule}`)).toEqual(["apps/api/docs/overview.md links"]);
  expect(lintDocsPages([pages[1]!], { "src/check.ts": 9 }).map((finding) => finding.rule)).toEqual(["links-external"]);
  expect(buildDocsIndex(pages, "apps/api/docs")).toContain("| [API](overview.md) | overview |");
  expect(buildDocsIndex(pages, "apps/api/docs")).not.toContain("Architecture");
  expect(buildDocsIndex(pages, "docs", [{ name:"@x/api", docsDir:"apps/api/docs" }])).toContain("| @x/api | [apps/api/docs/](../apps/api/docs/index.md) |");
  expect(buildBacklinks(pages).find((p) => p.path === "docs/architecture.md")!.content).toContain("- [API](../apps/api/docs/overview.md)");
  expect(docsCompletenessGaps([], { tables:[], core:[], docsDir:"apps/api/docs", workspace:true }).missingPages).toEqual(["apps/api/docs/overview.md"]);
});

it("reads citations of Nuxt route files with brackets", () => {
  const nuxt = page({}, "# Checks\n\n## How it works\n\nA (server/api/[slug].get.ts:1). B (server/api/[slug].get.ts:2). C (server/api/[slug].get.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/features/checks.md", content:nuxt }], { "server/api/[slug].get.ts":9 })).toEqual([]);
});

it("asks behaviour pages to say how it works and lists missing flow pages", () => {
  const thin = page({}, "# Checks\n\nA (src/check.ts:1). B (src/check.ts:2). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/features/checks.md", content:thin }], { "src/check.ts":9 }).map((f) => f.detail)).toEqual([expect.stringContaining("'## How it works'")]);
  expect(docsCompletenessGaps([], { tables:[], core:[], flows:["billing"] }).missingPages).toEqual(expect.arrayContaining(["docs/capabilities.md", "docs/audiences/copy.md", "docs/audiences/seo.md", "docs/audiences/design.md"]));
  const flow = page({ type:"flow" }, "# Checks\n\n## How it works\n\nA (src/check.ts:1). B (src/check.ts:2). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/flows/checks.md", content:flow }], { "src/check.ts":9 }).map((f) => f.detail)).toEqual([
    "needs at least 15 file:line citations, found 3", expect.stringContaining("'## Capabilities'")]);
});

it("asks data-model pages for relations and the meaning of fields", () => {
  const dump = page({ type:"data-model" }, "# Checks\n\n| Field | Type |\n|---|---|\n| id | String (src/check.ts:1) |\n\nB (src/check.ts:2). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/data-model.md", content:dump }], { "src/check.ts":9 }).map((f) => f.detail)).toEqual([
    expect.stringContaining("erDiagram"), expect.stringContaining("Meaning column")]);
  const explained = page({ type:"data-model" }, "# Checks\n\n```mermaid\nerDiagram\n```\n\n| Field | Meaning |\n|---|---|\n| id | Row key (src/check.ts:1) |\n\nB (src/check.ts:2). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/data-model.md", content:explained }], { "src/check.ts":9 })).toEqual([]);
});

it("holds only a flow's main page to the flow rules, not the part pages it splits into", () => {
  const part = page({ type:"flow" }, "# Checks\n\nA (src/check.ts:1). B (src/check.ts:2). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/flows/vk-promo/details.md", content:part }], { "src/check.ts":9 })).toEqual([]);
});

it("reads a list of ranges after one file, and refuses docs and Lane Pilot files as evidence", () => {
  expect(expandCitationLists("dim 0-0.9 (`schema.ts:19-25,125-143`)")).toBe("dim 0-0.9 (`schema.ts:19-25, schema.ts:125-143`)");
  expect(pageCitations("A (a.ts:1-2, 7).").map((c) => `${c.start}-${c.end}`)).toEqual(["1-2", "7-7"]);
  const cited = page({}, "# Checks\n\n## How it works\n\nA (.git/lane-pilot/docs-anchors.md:10). B (docs/flows/content.md:3). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/features/checks.md", content:cited }], { "src/check.ts":9 }).map((f) => f.detail)).toEqual([
    "cites .git/lane-pilot/docs-anchors.md; cite the code itself and link docs pages instead", "cites docs/flows/content.md; cite the code itself and link docs pages instead"]);
});

it("lists the pages a catalogue does not link", () => {
  const catalogue = { path:"docs/capabilities.md", content:"# C\n\nSee [wardrobe](../apps/cabinet/docs/features/wardrobe.md).\n" };
  expect(unlinkedPages(catalogue, ["apps/cabinet/docs/features/wardrobe.md", "apps/cabinet/docs/features/profiles.md"])).toEqual(["apps/cabinet/docs/features/profiles.md"]);
});

it("does not take a host and port for a file citation", () => {
  expect(pageCitations("Listens on 0.0.0.0:3000 (src/server.ts:12).")).toEqual([{ file:"src/server.ts", start:12, end:12 }]);
});

it("leaves the design canon alone", () => {
  const pages = [{ path:"apps/web/docs/DESIGN.md", content:"# Design\n\nNo frontmatter here.\n" }, { path:"apps/web/docs/overview.md", content:page({ title:"Web", type:"overview" }, "# Web\n\nA (src/check.ts:1). B (src/check.ts:2). C (src/check.ts:3). See [design](DESIGN.md).\n") }];
  expect(lintDocsPages(pages, { "src/check.ts":9 })).toEqual([]);
  expect(buildBacklinks(pages).map((p) => p.path)).toEqual(["apps/web/docs/overview.md"]);
  expect(buildDocsIndex(pages, "apps/web/docs")).not.toContain("DESIGN");
});

// SelfyStudio, 2026-10-08: the repair round grew docs/capabilities.md past 40000 bytes, so the page was listed as
// oversized and left out of the pages; 16 of the 17 findings then said that links to it point at a missing page.
it("treats a page too large to read as present for links", () => {
  const feature = { path:"docs/features/payments.md", content:page({ title:"Payments" }, good.replace("# Checks", "# Payments").replace("[CLI](cli.md)", "[capabilities](../capabilities.md)")) };
  expect(lintDocsPages([feature], { "src/check.ts":9 }).map((finding) => `${finding.rule} ${finding.target}`)).toEqual(["links docs/capabilities.md"]);
  expect(lintDocsPages([feature], { "src/check.ts":9 }, ["docs/capabilities.md"])).toEqual([]);
});

// treba, 2026-10-02..07: docs/ predates the method (auto-wiki pages: type explanation, no sources, docs/_briefs/,
// docs/plans/). The refresh wrote a few pages, the lint held it to every page in the folder (215 findings on main
// alone), one repair round could not convert them, and every night failed without landing anything.
it("blocks a docs pass only on the pages it wrote, or on links to pages it removed", () => {
  const legacy = { path:"docs/ARCHITECTURE.md", content:"---\ntitle: Architecture\ntype: explanation\nstatus: current\n---\n\n# Architecture\n\nSee [old](old.md).\n" };
  const written = { path:"docs/deployment.md", content:page({ title:"Deployment", type:"deployment", tags:"" }, "# Deployment\n\nShips (src/check.ts:1).\n") };
  const findings = lintDocsPages([legacy, written], { "src/check.ts":9 });
  expect(findings.some((finding) => finding.path === legacy.path)).toBe(true);
  expect(blockingDocsFindings(findings, [written.path]).map((finding) => `${finding.path} ${finding.rule}`).sort())
    .toEqual(["docs/deployment.md evidence", "docs/deployment.md frontmatter"]);
  // The pass removed docs/old.md: the untouched page that links to it is now broken by this pass.
  expect(blockingDocsFindings(findings, [written.path, "docs/old.md"]).map((finding) => `${finding.path} ${finding.rule}`))
    .toContain("docs/ARCHITECTURE.md links");
  expect(blockingDocsFindings(findings, [])).toEqual([]);
});
