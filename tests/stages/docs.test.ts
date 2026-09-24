import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDocsPages } from "../../src/host-handlers";
import {
  docsInputHash, docsScheduleDue, docsSinceEpoch, parseDocsSettings,
  selectDocsPages, validateDocsEdits,
  type DocsPage,
} from "../../src/stages/docs";

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
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("parses only supported controls and applies the defaults", () => {
    expect(parseDocsSettings({})).toEqual({enabled:false,maintain:true,since:"yesterday",pageCap:0,hour:5});
    expect(parseDocsSettings({"docs.enabled":"on","docs.maintain":false,"docs.since":"7 days ago","docs.page_cap":"8","docs.hour":23}))
      .toEqual({enabled:true,maintain:false,since:"7 days ago",pageCap:8,hour:23});
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
