import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKLINKS_MARK, blockingDocsFindings, parseFrontmatter, buildBacklinks, expandCitationLists, pageCitations, uncataloguedPages, unlinkedPages, buildDocsIndex, docsCompletenessGaps, lintDocsPages, pagesToRefresh, withCitedSources, withVerifiedConfidence } from "../../src/rooms/docs/docs-lint";
import { commitDocs } from "../../src/rooms/verification/git-docs";

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

// SelfyStudio, 2026-10-09: the repair round kept docs/capabilities.md under 30000 bytes by moving the operator
// entries to docs/capabilities/operators.md, which it links; the coverage check read only the catalogue page,
// so 5 findings became 39, 29 of them for pages the area page links.
it("counts links on the area pages a catalogue links", () => {
  const features = ["apps/admin/docs/features/analytics.md", "apps/cabinet/docs/features/wardrobe.md", "apps/api/docs/features/admin-challenges.md", "apps/worker/docs/features/runtime.md"];
  const catalogue = { path:"docs/capabilities.md", content:"# C\n\n- [Wardrobe](../apps/cabinet/docs/features/wardrobe.md)\n- [Operator capabilities](capabilities/operators.md)\n" };
  const operators = { path:"docs/capabilities/operators.md", content:"# Operators\n\n- [Analytics](../../apps/admin/docs/features/analytics.md)\n" };
  // An area page the catalogue does not link is not part of it.
  const orphan = { path:"docs/capabilities/orphan.md", content:"# Orphan\n\n- [Runtime](../../apps/worker/docs/features/runtime.md)\n" };
  expect(unlinkedPages(catalogue, features)).toEqual(["apps/admin/docs/features/analytics.md", "apps/api/docs/features/admin-challenges.md", "apps/worker/docs/features/runtime.md"]);
  expect(uncataloguedPages(catalogue, [catalogue, operators, orphan], features)).toEqual(["apps/api/docs/features/admin-challenges.md", "apps/worker/docs/features/runtime.md"]);
});

// treba, 2026-10-17: docs/components/tracking-attribution.md as the docs agent left it after the repair round. Its lists
// sit at the key's own indent, which YAML allows; the lint read them as empty and failed the pass three times that night.
const TREBA_TRACKING = `---
title: Tracking and order attribution
type: component
created: 2026-09-11
updated: 2026-10-17
status: active
confidence: high
tags:
- tracking
- attribution
sources:
- server/utils/attribution.ts
- server/utils/sync-orders.ts
---
# Tracking and order attribution

## How it works

Visits are matched to orders (server/utils/attribution.ts:10-20), synced orders carry the click ids (server/utils/sync-orders.ts:5)
and the tracker posts them (public/t.js:1-3).
`;

it("reads frontmatter lists written at the key's own indent", () => {
  expect(parseFrontmatter(TREBA_TRACKING)?.data).toMatchObject({ tags:["tracking", "attribution"], sources:["server/utils/attribution.ts", "server/utils/sync-orders.ts"] });
  const findings = lintDocsPages([{ path:"docs/components/tracking-attribution.md", content:TREBA_TRACKING }],
    { "server/utils/attribution.ts":100, "server/utils/sync-orders.ts":50, "public/t.js":10 });
  expect(findings.filter((finding) => finding.rule === "frontmatter")).toEqual([]);
});

it("adds cited sources at the indent of the list already there", () => {
  const sourced = withCitedSources(TREBA_TRACKING);
  expect(sourced).toContain("sources:\n- server/utils/attribution.ts\n- server/utils/sync-orders.ts\n- public/t.js\n---");
  expect(parseFrontmatter(sourced)?.data.sources).toEqual(["server/utils/attribution.ts", "server/utils/sync-orders.ts", "public/t.js"]);
  const indented = TREBA_TRACKING.replace(/^- server/gm, "  - server");
  expect(withCitedSources(indented)).toContain("  - server/utils/sync-orders.ts\n  - public/t.js\n---");
});

// SelfyStudio, 2026-10-21: the repair round said to move new content to a linked page of its own; the agent moved six
// admin operations to apps/api/docs/admin-api-details.md (type component), each with its own '### How it works',
// Modes and Failures. The check wanted a '## How it works' heading, so its one finding failed the pass and the 6 pages
// written that night stayed uncommitted.
it("accepts a component page that gives each operation its own '### How it works'", async () => {
  const content = await readFile(join(__dirname, "../fixtures/docs/selfystudio-admin-api-details.md"), "utf8");
  const findings = lintDocsPages([{ path:"apps/api/docs/admin-api-details.md", content }], {}, ["apps/api/docs/admin-api.md"]);
  expect(findings.filter((finding) => finding.rule === "structure")).toEqual([]);
  // A page with no How it works at any level, or a main flow page that splits it, still fails.
  const thin = page({}, "# Checks\n\n## Alerts\n\nA (src/check.ts:1). B (src/check.ts:2). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"docs/features/checks.md", content:thin }], { "src/check.ts":9 }).map((f) => f.rule)).toEqual(["structure"]);
  const flow = page({ type:"flow" }, "# Checks\n\n## Alerts\n\n### How it works\n\nA (src/check.ts:1).\n");
  expect(lintDocsPages([{ path:"docs/flows/checks.md", content:flow }], { "src/check.ts":9 }).map((f) => f.detail)).toContainEqual(expect.stringContaining("'## How it works'"));
});

// treba, 2026-10-22: the agent's script glued the closing '---' to the last source of four pages it had switched from
// reference to component. The check stopped at «page must start with a YAML frontmatter block», the repair round fixed
// only that, and then the same pages failed on the missing '## How it works' with no round left. This is the agent's page.
it("reports a page's other findings when its frontmatter's closing '---' is glued to the last field", async () => {
  const content = await readFile(join(__dirname, "../fixtures/docs/treba-cluster-87-glued-frontmatter.md"), "utf8");
  const findings = lintDocsPages([{ path:"docs/components/cluster-87.md", content }], {});
  expect(findings.map((finding) => finding.rule)).toEqual(["frontmatter", "structure"]);
  expect(findings[0]!.detail).toMatch(/^the frontmatter's closing '---' must be on a line of its own/);
  expect(findings[1]!.detail).toMatch(/^a component or flow page needs a '## How it works' section/);
  expect(findings[0]!.detail).toContain('at the end of "- tests/server/yandex-direct-campaign-revenue.spec.ts---"');
  // A page with no frontmatter at all is still checked by its body.
  const bare = "# Checks\n\nA powerful check (src/check.ts:1).\n";
  expect(lintDocsPages([{ path:"docs/features/checks.md", content:bare }], { "src/check.ts":9 }).map((f) => f.rule)).toEqual(["frontmatter", "evidence", "wording"]);
});

// SelfyStudio, 2026-10-21: docs/capabilities/operators.md was 29967 bytes, so the repair round, as its prompt says, put the
// three missing capabilities on a linked page of their own, docs/capabilities/operators/scenario-runner.md. The coverage
// check counted only area pages the catalogue links directly, so the same 3 findings failed the pass and none of the
// 13 pages written that night was committed. These are the agent's real pages.
it("counts links on a page an area page links under the catalogue's folder", async () => {
  const dir = join(__dirname, "../fixtures/docs/selfystudio-capabilities");
  const read = async (path:string) => ({ path:`docs/${path}`, content:await readFile(join(dir, path), "utf8") });
  const [catalogue, operators, runner] = await Promise.all(["capabilities.md", "capabilities/operators.md", "capabilities/operators/scenario-runner.md"].map(read));
  const missing = ["apps/admin/docs/features/scenario-cluster-source.md", "apps/scenario-runner/docs/features/content-publishing-step-details.md", "apps/scenario-runner/docs/features/media-execution-details.md"];
  const features = [...missing, "apps/worker/docs/features/never-linked.md"];
  expect(uncataloguedPages(catalogue!, [catalogue!, operators!, runner!], features)).toEqual(["apps/worker/docs/features/never-linked.md"]);
  // Without the area page in between, the nested page is not part of the catalogue.
  expect(uncataloguedPages(catalogue!, [catalogue!, runner!], features)).toEqual(features);
});

// treba, 2026-10-20: docs/api/chat-and-dashboard.md showed the metrics response as a ```text sample starting with
// '# HELP ...'; the H1 check read that line as a second heading, and the agent deleted the sample to pass.
it("does not count a '# ' line inside a code block as a heading", () => {
  const sample = good.replace("## How it works", "**Response:**\n```text\n# HELP ...\n# TYPE x counter\n```\n\n~~~bash\n# comment\n~~~\n\n## How it works");
  const structure = (content:string) => lintDocsPages([{ path:"docs/features/checks.md", content }], { "src/check.ts":9 }).filter((f) => f.rule === "structure").map((f) => f.detail);
  expect(structure(page({}, sample))).toEqual([]);
  // A real second H1 after the block still fails.
  const twice = page({}, `${sample}\n# Second\n`);
  expect(structure(twice)).toEqual(["page needs exactly one H1, found 2"]);
});

it("reads Expo Router paths: a (group) folder and a +api file", () => {
  // Murdoku 2026-10-21: `mobile/src/app/(tabs)/_layout.tsx:21-48` was read as `/_layout.tsx` and
  // `mobile/src/app/api/ask+api.ts:9-18` as `api.ts`, both «does not exist»; the agent's repair cited the five
  // `(tabs)/*.tsx` route files instead and failed the unit with 10 such findings.
  const body = "Tabs (`mobile/src/app/(tabs)/_layout.tsx:21-47`), home (mobile/src/app/(tabs)/index.tsx:5-8), ask (`mobile/src/app/api/ask+api.ts:9-18`), not found (src/app/+not-found.tsx:3).";
  expect(pageCitations(body)).toEqual([
    { file:"mobile/src/app/(tabs)/_layout.tsx", start:21, end:47 },
    { file:"mobile/src/app/(tabs)/index.tsx", start:5, end:8 },
    { file:"mobile/src/app/api/ask+api.ts", start:9, end:18 },
    { file:"src/app/+not-found.tsx", start:3, end:3 },
  ]);
  expect(expandCitationLists("(`mobile/src/app/(tabs)/index.tsx:5-8,12`)")).toBe("(`mobile/src/app/(tabs)/index.tsx:5-8, mobile/src/app/(tabs)/index.tsx:12`)");
  // A citation in parentheses keeps the parenthesis out of its path.
  expect(pageCitations("Order (src/a.ts:1) and (src/b.ts:2-3).").map((c) => c.file)).toEqual(["src/a.ts", "src/b.ts"]);
  const cited = page({}, "# Checks\n\n## How it works\n\nA (mobile/src/app/(tabs)/index.tsx:1). B (mobile/src/app/api/ask+api.ts:2). C (src/check.ts:3).\n");
  expect(lintDocsPages([{ path:"mobile/docs/api.md", content:cited }], { "mobile/src/app/(tabs)/index.tsx":8, "mobile/src/app/api/ask+api.ts":18, "src/check.ts":9 })).toEqual([]);
});

it("fails a citation whose range does not contain the identifier its claim names", async () => {
  const { lintCitationClaims } = await import("../../src/rooms/docs/docs-lint");
  const lines = ["export function runPmRead() {", "  return read();", "}", "", "export function other() {}", "  return 1;", "}", "", "export const TASK_LIMIT = 12;"];
  const read = async (file: string, start: number, end: number) => file === "src/check.ts" ? lines.slice(start - 1, end).join("\n") : null;
  // The claim names runPmRead but points at the lines of `other`: drift the bounds check cannot see.
  const drifted = page({}, "# Checks\n\n## How it works\n\n`runPmRead` reads the excerpts (src/check.ts:5-6).\n");
  expect((await lintCitationClaims([{ path: "docs/features/checks.md", content: drifted }], read)).map((f) => f.detail))
    .toEqual([expect.stringContaining("none of the identifiers it names")]);
  const right = page({}, "# Checks\n\n## How it works\n\n`runPmRead` reads the excerpts (src/check.ts:1-2).\n");
  expect(await lintCitationClaims([{ path: "docs/features/checks.md", content: right }], read)).toEqual([]);
  // Bare identifiers (call-shaped and CONSTANT-shaped) count too; a claim naming none is skipped.
  const bare = page({}, "# Checks\n\n## How it works\n\nTASK_LIMIT is enforced (src/check.ts:9). The pass runs nightly (src/check.ts:8-9).\n");
  expect(await lintCitationClaims([{ path: "docs/features/checks.md", content: bare }], read)).toEqual([]);
  // A missing file is left to the bounds check.
  const missing = page({}, "# Checks\n\n## How it works\n\n`runPmRead` reads (src/gone.ts:1).\n");
  expect(await lintCitationClaims([{ path: "docs/features/checks.md", content: missing }], read)).toEqual([]);
});
