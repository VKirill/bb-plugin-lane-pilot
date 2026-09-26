import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { boundJevState, pageClaims, renderAnchorBrief, scanDeclarations, spreadAnchors, verifyDocsCitations, type Anchor } from "../../src/verification/docs-jev";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("finds exported and internal declarations with their line spans", () => {
  const code = ["import x from 'y';", "export async function addMonitor(a) {", "  return a;", "}", "const due = (m) => m.next < Date.now();",
    "export const LIMIT = 5;", "db.exec(`CREATE TABLE IF NOT EXISTS monitors (id TEXT)`);"].join("\n");
  const found = scanDeclarations("src/a.ts", code).map((anchor) => [anchor.name, anchor.kind, anchor.exported, anchor.line, anchor.endLine]);
  expect(found).toEqual([
    ["addMonitor", "function", true, 2, 4],
    ["due", "function", false, 5, 5],
    ["LIMIT", "const", true, 6, 7],
    ["monitors", "table", true, 7, 7],
  ]);
});

it("maps Vue components and Prisma models, and spreads a capped map across files", () => {
  const vue = scanDeclarations("app/pages/Order.vue", ["<template><div/></template>", "<script setup lang=\"ts\">", "const total = (items) => items.length;", "</script>"].join("\n"));
  expect(vue.map((anchor) => [anchor.name, anchor.kind, anchor.line])).toEqual([["Order", "component", 1], ["total", "function", 3]]);
  const prisma = scanDeclarations("prisma/models/user.prisma", ["model User {", "  id String @id", "}", "enum Role {", "  ADMIN", "}", "model Order {", "}"].join("\n"));
  expect(prisma.map((anchor) => [anchor.name, anchor.kind, anchor.line, anchor.endLine])).toEqual([["User", "table", 1, 3], ["Role", "type", 4, 6], ["Order", "table", 7, 8]]);
  const anchor = (file:string, name:string, fields:Partial<Anchor> = {}):Anchor => ({ name, kind:"function", exported:true, file, line:1, endLine:1, snippet:"", ...fields });
  const picked = spreadAnchors([anchor("a.ts", "a1"), anchor("a.ts", "a2"), anchor("a.ts", "a3"), anchor("b.ts", "b1", { exported:false }), anchor("b.ts", "b2"), anchor("c.prisma", "T", { kind:"table" })], 4);
  expect(picked.map((item) => item.name)).toEqual(["T", "a1", "b2", "a2"]);
});

it("shrinks the longest text so a state fits Jev's window", () => {
  const bounded = boundJevState({ task:"a".repeat(150_000), note:"short" }, 100_000);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(100_000);
  expect(bounded.note).toBe("short");
  expect(bounded.task).toContain("characters omitted");
});

it("takes the sentence around each citation as its claim", () => {
  const claims = pageClaims("Checks run every minute (src/checker.ts:10-12). Monitors are validated and stored (src/db.ts:5-9, src/db.ts:20).\n");
  expect(claims.map((claim) => claim.refs)).toEqual([[{ file:"src/checker.ts", start:10, end:12 }],
    [{ file:"src/db.ts", start:5, end:9 }, { file:"src/db.ts", start:20, end:20 }]]);
  expect(pageClaims("Old checks are deleted (`src/db.ts:146-179`, `190-193`).")[0]!.refs).toEqual([
    { file:"src/db.ts", start:146, end:179 }, { file:"src/db.ts", start:190, end:193 }]);
  expect(pageClaims("| `src/cli.ts:198-223`, `src/cli.ts:240-253` |")).toEqual([]);
  expect(claims[1]!.claim).toBe("Monitors are validated and stored (src/db.ts:5-9, src/db.ts:20).");
});

it("lists only product code as rule and entry-point candidates", () => {
  const anchor = (name:string, fields:Partial<Anchor>):Anchor => ({ name, kind:"function", exported:true, file:"a.ts", line:1, endLine:2, snippet:"", ...fields });
  const brief = renderAnchorBrief([
    anchor("dueMonitors", { businessRule:0.9, projectSpecific:0.9, userFacing:0.2 }),
    anchor("overlayHelper", { businessRule:0.9, projectSpecific:0.1, userFacing:0.9 }),
    anchor("weakRule", { businessRule:0.55, projectSpecific:0.9 }),
    anchor("runCli", { userFacing:0.9, projectSpecific:0.9 }),
  ], [], ["zod@4"], "ok");
  const section = (title:string) => brief.split(`## ${title}\n`)[1]!.split("\n\n")[0]!;
  expect(section("Business rule candidates")).toBe("- `dueMonitors` a.ts:1-2 (rule 90%)");
  expect(section("Entry points")).toBe("- `runCli` a.ts:1-2 (function)");
  expect(brief).toContain("`overlayHelper` a.ts:1-2 (exported, function, generic)");
  expect(brief).toContain("- zod@4");
});

it("turns a citation Jev finds unsupported into a lint finding, and does nothing without a key", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-jev-"));
  try {
    await writeFile(join(root, "a.ts"), "export const LIMIT = 5;\nexport const OTHER = 1;\n");
    const pages = [{ path:"docs/a.md", content:"---\ntitle: A\n---\n# A\n\nThe limit is 5 (a.ts:1). The other is 9 (a.ts:2).\n" }];
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url:string, init:{ body:string }) => {
      const body = JSON.parse(init.body);
      if (body.questions.relation) {
        const both = `${body.state.first.statement} ${body.state.second.statement}`;
        const contradict = both.includes("is 5") && both.includes("is 7");
        return new Response(JSON.stringify({ answers:{ relation:{ type:"choice", choice:contradict ? "contradict" : "consistent",
          probabilities:{ consistent:contradict ? 0.1 : 0.9, contradict:contradict ? 0.9 : 0.1 } } } }));
      }
      const claim = body.questions.support.instructions.claim as string;
      expect(JSON.parse(init.body).state.excerpts.length).toBe(1);
      const unsupported = claim.includes("9");
      return new Response(JSON.stringify({ answers:{ support:{ type:"choice", choice:unsupported ? "unsupported" : "supported",
        probabilities:{ supported:unsupported ? 0.1 : 0.9, partial:0, unsupported:unsupported ? 0.9 : 0.1 } } } }));
    }));
    const result = await verifyDocsCitations({ projectCwd:root, pages });
    expect(result).toMatchObject({ jev:"ok", checked:2, pageStats:[{ path:"docs/a.md", checked:2, supported:1, partial:0 }] });
    expect(result.findings).toEqual([{ path:"docs/a.md", rule:"evidence-check", detail:expect.stringContaining("a.ts:2 do not back") }]);
    const conflict = await verifyDocsCitations({ projectCwd:root, pages:[{ path:"docs/b.md", content:"# B\n\nThe limit is 7 (a.ts:1).\n" }], related:pages });
    expect(conflict.findings.filter((f) => f.rule === "contradiction")).toEqual([{ path:"docs/b.md", rule:"contradiction", detail:expect.stringContaining("contradicts docs/a.md") }]);
    vi.stubEnv("TYPESAFE_API_KEY", ""); vi.stubEnv("JEV_API_KEY", ""); vi.stubEnv("HOME", root);
    expect((await verifyDocsCitations({ projectCwd:root, pages })).jev).toBe("disabled");
  } finally { await rm(root, { recursive:true, force:true }); }
});
