import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pageClaims, renderAnchorBrief, scanDeclarations, spreadAnchors, type Anchor } from "../../src/rooms/docs/docs-anchors";
import { docsLineCounts } from "../../src/rooms/docs/git-docs";

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

it("takes the sentence around each citation as its claim", () => {
  const claims = pageClaims("Checks run every minute (src/checker.ts:10-12). Monitors are validated and stored (src/db.ts:5-9, src/db.ts:20).\n");
  expect(claims.map((claim) => claim.refs)).toEqual([[{ file:"src/checker.ts", start:10, end:12 }],
    [{ file:"src/db.ts", start:5, end:9 }, { file:"src/db.ts", start:20, end:20 }]]);
  expect(pageClaims("Old checks are deleted (`src/db.ts:146-179`, `190-193`).")[0]!.refs).toEqual([
    { file:"src/db.ts", start:146, end:179 }, { file:"src/db.ts", start:190, end:193 }]);
  expect(pageClaims("| `src/cli.ts:198-223`, `src/cli.ts:240-253` |")).toEqual([]);
  expect(claims[1]!.claim).toBe("Monitors are validated and stored (src/db.ts:5-9, src/db.ts:20).");
});

it("lists the declarations by file with no model marks", () => {
  const anchor = (name:string, fields:Partial<Anchor>):Anchor => ({ name, kind:"function", exported:true, file:"a.ts", line:1, endLine:2, snippet:"", ...fields });
  const brief = renderAnchorBrief([anchor("dueMonitors", {}), anchor("helper", { exported:false })], [], ["zod@4"]);
  expect(brief).toContain("`dueMonitors` a.ts:1-2 (exported, function)");
  expect(brief).toContain("`helper` a.ts:1-2 (internal, function)");
  expect(brief).not.toMatch(/Jev|importance|rule \d+%/);
});

it("ends the last declaration of a file on its last line, not on the empty element after its final newline", async () => {
  // Murdoku 2026-10-21: the code map gave `crashRoute (server/src/crash.ts:31-59)` for a 58-line file, the agent
  // cited it, and the citation check (which counts the file's real lines) failed the nightly docs unit.
  const code = ["import { send } from './route-helpers.ts';", "", "export async function crashRoute(ip, read) {", "  const b = await read();", "  return { status: 200, body: { ok: true } };", "}", ""].join("\n");
  const [anchor] = scanDeclarations("server/src/crash.ts", code);
  expect([anchor!.name, anchor!.line, anchor!.endLine]).toEqual(["crashRoute", 3, 6]);
  const dir = await mkdtemp(join(tmpdir(), "lp-anchor-eof-"));
  try {
    await mkdir(join(dir, "server/src"), { recursive:true });
    await writeFile(join(dir, "server/src/crash.ts"), code);
    const counts = await docsLineCounts({ projectCwd:dir, files:["server/src/crash.ts"] });
    expect(counts["server/src/crash.ts"]).toBe(anchor!.endLine);
  } finally { await rm(dir, { recursive:true, force:true }); }
  // Without a final newline the last line is still the end.
  expect(scanDeclarations("a.ts", "export const A = 1;\nexport const B = 2;").map((item) => item.endLine)).toEqual([1, 2]);
});
