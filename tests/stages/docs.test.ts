import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDocsPages } from "../../src/rooms/host-worker/host-handlers";
import {
  docsInputHash, docsScheduleDue, docsSinceEpoch, parseDocsSettings,
  selectDocsPages, validateDocsEdits,
  type DocsPage,
  docsSelection, docsRepairPrompt, nightlyDocsPrompt,
} from "../../src/rooms/docs/docs";
import { lintDocsPages } from "../../src/rooms/docs/docs-lint";

const now = new Date(2026, 8, 23, 5, 0, 0);
const page = (path:string, modifiedAt:number, content="# Docs"):DocsPage => ({
  path, modifiedAt, content,
  sha256:"a".repeat(64),
});

describe("living docs stage policy", () => {
  it("inventories only regular Markdown files under docs and apps, never symlinked roots", async () => {
    const root=await mkdtemp(join(tmpdir(),"lane-pilot-docs-"));
    try {
      await mkdir(join(root,"docs"));
      await mkdir(join(root,"apps"));
      await mkdir(join(root,"src"));
      await mkdir(join(root,".agents"));
      await writeFile(join(root,"docs","guide.md"),"# Guide\n");
      await writeFile(join(root,"apps","app.md"),"# App\n");
      await writeFile(join(root,"src","private.md"),"# Source\n");
      await writeFile(join(root,".agents","LESSONS.md"),"# Private\n");
      await symlink(join(root,".agents"),join(root,"docs","linked"));
      const result=await listDocsPages({requestedHostId:"host-test",projectCwd:root},undefined as never);
      expect(result.hostId).toBe("host-test");
      expect(result.pages.map((item)=>item.path).sort()).toEqual(["apps/app.md","docs/guide.md"]);
      expect(result.pages.every((item)=>/^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
      expect(result.pages.every((item)=>Number.isInteger(item.modifiedAt))).toBe(true);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("writes docs with Codex GPT-6 Luna, high, fast unless the project picks its own model", () => {
    expect(docsSelection({ "writer.provider":"acp-cursor", "writer.model":"grok-4.6" })).toEqual({ providerId:"codex", model:"gpt-6-luna", reasoningLevel:"high", serviceTier:"fast" });
    expect(docsSelection({ "docs.reasoning_effort":"xhigh" })).toMatchObject({ model:"gpt-6-luna", reasoningLevel:"xhigh", serviceTier:"fast" });
    expect(docsSelection({ "docs.provider":"claude-code", "docs.model":"claude-sonnet-5-5" })).toEqual({ providerId:"claude-code", model:"claude-sonnet-5-5", reasoningLevel:"high", serviceTier:"standard" });
    expect(docsSelection({ "docs.provider":"codex", "docs.model":"gpt-6-sol", "docs.service_tier":"fast" })).toMatchObject({ serviceTier:"fast" });
  });

  it("parses only supported controls and applies the defaults", () => {
    // Unset means auto since 0.1.44: the folder's worthiness verdict decides per place.
    expect(parseDocsSettings({})).toEqual({enabled:true,mode:"auto",maintain:true,since:"yesterday",pageCap:0,hour:5});
    expect(parseDocsSettings({"docs.enabled":"auto"})).toMatchObject({enabled:true,mode:"auto"});
    expect(parseDocsSettings({"docs.enabled":false})).toMatchObject({enabled:false,mode:"off"});
    expect(parseDocsSettings({"docs.enabled":"on","docs.maintain":false,"docs.since":"7 days ago","docs.page_cap":"8","docs.hour":23}))
      .toEqual({enabled:true,mode:"on",maintain:false,since:"7 days ago",pageCap:8,hour:23});
    expect(() => parseDocsSettings({"docs.hour":24})).toThrow("docs.hour");
    expect(() => parseDocsSettings({"docs.since":"last month"})).toThrow("docs.since");
  });

  it("uses local midnight for yesterday and duration windows for other choices", () => {
    expect(docsSinceEpoch("yesterday", now)).toBe(new Date(2026, 8, 22).getTime());
    expect(docsSinceEpoch("24 hours ago", now)).toBe(now.getTime() - 86_400_000);
    expect(docsSinceEpoch("7 days ago", now)).toBe(now.getTime() - 604_800_000);
  });

  it("selects eligible markdown pages deterministically and enforces page cap", () => {
    const since = docsSinceEpoch("yesterday", now);
    const result = selectDocsPages([
      page("docs/z.md", since + 1), page("docs/a.md", since), page("docs/old.md", since - 1),
      page(".agents/LESSONS.md", since + 1), page("src/secret.md", since + 1), page("docs/../README.md", since + 1),
    ], "yesterday", 1, now);
    expect(result.pages.map((item) => item.path)).toEqual(["docs/a.md"]);
    expect(result.truncated).toBe(true);
  });

  it("only accepts bounded edits matching selected page hashes", () => {
    const selected = [page("docs/guide.md", now.getTime())];
    const valid = [{path:"docs/guide.md",expectedSha256:"a".repeat(64),content:"# Updated"}];
    expect(validateDocsEdits(valid, selected, 1)).toEqual(valid);
    expect(() => validateDocsEdits([{...valid[0],path:".agents/LESSONS.md"}], selected, 1)).toThrow("docs/");
    expect(() => validateDocsEdits([{...valid[0],expectedSha256:"b".repeat(64)}], selected, 1)).toThrow("hash");
    expect(() => validateDocsEdits([...valid,...valid], selected, 2)).toThrow("duplicate");
    expect(() => validateDocsEdits(valid, selected, 0)).not.toThrow();
  });

  it("schedules once per local day at the configured hour and hashes stable candidate identity", () => {
    expect(docsScheduleDue(now, 5, null)).toBe(true);
    expect(docsScheduleDue(now, 4, null)).toBe(false);
    expect(docsScheduleDue(now, 5, "2026-09-23")).toBe(false);
    const selected = [page("docs/guide.md", now.getTime())];
    expect(docsInputHash(selected)).toMatch(/^[a-f0-9]{64}$/);
    expect(docsInputHash(selected)).toBe(docsInputHash(selected));
  });
});

// SelfyStudio, 2026-10-08: fixing a coverage finding, the repair round added capabilities to a 35 KB catalogue,
// pushed it past 40000 bytes and had no round left to split it.
it("reminds the one repair round of the page size limit", () => {
  const prompt = docsRepairPrompt([{ path:"docs/capabilities.md", rule:"coverage", detail:"does not link apps/api/docs/features/x.md" }]);
  expect(prompt).toContain("under 30000 bytes");
  expect(prompt).toContain("linked page of its own");
});

// SelfyStudio, 2026-10-18 (thr_4kk3pkhbfg): the only first-check finding on docs/flows/chat.md was a Jev contradiction
// with docs/DESIGN.md. In the repair round the agent cited `docs/DESIGN.md:723`, a rule nothing it was given states,
// and the pass failed on that one evidence finding.
it("tells the agent, first brief and repair round, that only code may be cited", () => {
  const contradiction = { path:"docs/flows/chat.md", rule:"contradiction",
    detail:"\"If access lookup errors, Cabinet treats access as paid for presentation\" contradicts docs/DESIGN.md: \"cabinet access loading stays neutral\" (Jev 75%)" };
  const rule = /a file:line citation of a \.md page \(a docs page, DESIGN\.md, README\.md or PROJECT\.md\) fails the checks/;
  expect(docsRepairPrompt([contradiction])).toMatch(rule);
  expect(docsRepairPrompt([contradiction])).toContain("cite the code it cites and link that page");
  expect(nightlyDocsPrompt({ since:"yesterday", hasDocs:true, changed:["apps/api/src/x.ts"] })).toMatch(rule);
  // The rule the text describes: the agent's own sentence from that round is blocked, the same claim citing code is not.
  const page = (citation:string) => ({ path:"docs/flows/chat.md", content:[
    "---", "title: Chat", "type: component", "created: 2026-09-27", "updated: 2026-10-18", "status: active", "confidence: low",
    "tags: [chat]", "sources:", "  - apps/cabinet/app/entities/wallet/use-chat-access.ts", "---", "# Chat", "TL;DR.", "## How it works",
    `During initial loading the gate stays neutral (\`apps/cabinet/app/entities/wallet/use-chat-access.ts:4-8,38-50\`; \`${citation}\`), see the [design canon](../DESIGN.md).`,
    "Refs `apps/cabinet/app/pages/generate-from-scratch.vue:7-25`.", ""].join("\n") });
  const evidence = (citation:string) => lintDocsPages([page(citation)], {}, ["docs/DESIGN.md"]).filter((finding) => finding.rule === "evidence").map((finding) => finding.detail);
  expect(evidence("docs/DESIGN.md:723")).toContain("cites docs/DESIGN.md; cite the code itself and link docs pages instead");
  expect(evidence("apps/api/src/routes/v1/chat-sessions/chat-message-charge.ts:30-45")).toEqual([]);
});

// treba, 2026-10-11: 75 bad citations on docs/api.md filled the first 80 lines of the repair round; the 22 frontmatter
// and structure findings on 16 other pages hid behind «…and 51 more of the same kinds», the agent was told to fix
// exactly the listed ones, and the same 22 failed the pass.
it("names every failing page and rule in the repair round, however many findings one page has", () => {
  const structure = "a component or flow page needs a '## How it works' section";
  const findings = [
    ...["docs/api/analytics.md", "docs/api/dashboard.md", "docs/api/tracking-direct.md", "docs/api.md"].map((path) => ({ path, rule:"structure", detail:structure })),
    ...Array.from({ length:75 }, (_, index) => ({ path:"docs/api.md", rule:"evidence", detail:`cites ../server/api/route-${index}.get.ts, which does not exist` })),
    { path:"docs/architecture.md", rule:"frontmatter", detail:"missing sources" },
    ...["app", "cluster-61", "cluster-95", "server", "tracking-attribution", "yandex-direct"].flatMap((name) => [
      { path:`docs/components/${name}.md`, rule:"frontmatter", detail:"missing tags" },
      { path:`docs/components/${name}.md`, rule:"frontmatter", detail:"missing sources" },
    ]),
    { path:"docs/components/app.md", rule:"structure", detail:structure },
    { path:"docs/components/server.md", rule:"structure", detail:structure },
    { path:"docs/data-model.md", rule:"frontmatter", detail:"missing tags" },
    { path:"docs/data-model.md", rule:"frontmatter", detail:"missing sources" },
    { path:"docs/decisions.md", rule:"frontmatter", detail:"missing sources" },
    { path:"docs/glossary.md", rule:"frontmatter", detail:"missing tags" },
    { path:"docs/gotchas.md", rule:"frontmatter", detail:"missing tags" },
    { path:"docs/gotchas.md", rule:"frontmatter", detail:"missing sources" },
    { path:"docs/overview.md", rule:"frontmatter", detail:"missing sources" },
  ];
  const prompt = docsRepairPrompt(findings);
  for (const finding of findings.filter((item) => item.rule !== "evidence")) {
    expect(prompt).toContain(`- ${finding.path} [${finding.rule}]: ${finding.detail}`);
  }
  expect(prompt).toContain("- docs/api.md [evidence]: cites ../server/api/route-0.get.ts, which does not exist");
  expect(prompt).not.toContain("of the same kinds");
  expect(prompt).toMatch(/docs\/api\.md \[evidence\] ×\d+/);
  expect(prompt.split("\n").filter((line) => line.startsWith("- ")).length).toBeLessThanOrEqual(81);
});

// D1: README is a full reference; a refresh updates facts, never shrinks or rewrites sections.
it("tells the agent README.md is a full reference that refresh passes only update, never shorten", () => {
  const rule = /full reference for people[\s\S]*never shorten it/;
  expect(nightlyDocsPrompt({ since:"yesterday", hasDocs:true, changed:["src/x.ts"] })).toMatch(rule);
  expect(nightlyDocsPrompt({ since:"yesterday", hasDocs:false, changed:[] })).toMatch(rule);
  expect(nightlyDocsPrompt({ since:"yesterday", hasDocs:true, changed:["src/x.ts"] })).not.toMatch(/short front page/);
});
