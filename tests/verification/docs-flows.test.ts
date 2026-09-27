import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildDocsFlows, extractRoutes, importGraph } from "../../src/verification/docs-flows";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("finds HTTP routes, Nuxt server files and bot commands", () => {
  expect(extractRoutes("apps/api/src/routes/pay.ts", "export default async (app) => {\n  app.post('/v1/payments', handler);\n  bot.command('start', go);\n}")).toEqual([
    { method:"POST", path:"/v1/payments", file:"apps/api/src/routes/pay.ts", line:2 },
    { method:"BOT /", path:"start", file:"apps/api/src/routes/pay.ts", line:3 },
  ]);
  expect(extractRoutes("apps/cabinet/server/api/cabinet/[id]/photos.get.ts", "")[0]).toMatchObject({ method:"GET", path:"/api/cabinet/:id/photos" });
  expect(extractRoutes("apps/cabinet/app/pages/profiles/[id].vue", "")[0]).toMatchObject({ method:"PAGE", path:"/profiles/:id" });
  expect(extractRoutes("apps/cabinet/app/pages/index.vue", "")[0]).toMatchObject({ method:"PAGE", path:"/" });
});

it("resolves relative imports, aliases and workspace subpaths", () => {
  const files = new Map([
    ["apps/api/src/routes/pay.ts", "import { x } from '../lib/util.js';\nimport { start } from '@acme/app/billing';\nimport c from '~/src/lib/util';"],
    ["apps/api/src/lib/util.ts", ""],
    ["packages/app/src/billing/index.ts", ""],
  ]);
  const graph = importGraph(files, [{ path:"apps/api", name:"@acme/api" }, { path:"packages/app", name:"@acme/app" }]);
  expect([...graph.get("apps/api/src/routes/pay.ts")!].sort()).toEqual([["apps/api/src/lib/util.ts", ["x"]], ["packages/app/src/billing/index.ts", ["start"]]]);
});

it("traces entries in the apps to the business modules of the shared packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-flows-"));
  const write = async (path:string, text:string) => { await mkdir(dirname(join(root, path)), { recursive:true }); await writeFile(join(root, path), text); };
  try {
    await write("apps/api/package.json", JSON.stringify({ name:"@acme/api", scripts:{ start:"node ." } }));
    await write("packages/app/package.json", JSON.stringify({ name:"@acme/app" }));
    await write("apps/api/src/routes/pay.ts", "import { charge } from '@acme/app/billing';\napp.post('/v1/pay', () => charge());\n");
    await write("apps/web/package.json", JSON.stringify({ name:"@acme/web" }));
    await write("apps/web/pages/checkout.vue", "<script setup>\nconst go = () => $fetch(`/v1/pay/${id}`.replace(`/${id}`, ''));\nawait $fetch('/v1/pay');\n</script>\n");
    await write("apps/api/src/routes/me.ts", "import { load } from '@acme/app/profile';\napp.get('/v1/me', () => load());\n");
    await write("packages/app/src/billing/index.ts", "export * from './charge';\n");
    await write("packages/app/src/billing/charge.ts", "export function charge() {}\n");
    await write("packages/app/src/profile/index.ts", "export * from './load';\n");
    await write("packages/app/src/profile/load.ts", "export function load() {}\n");
    await write("packages/app/src/shared/a.ts", ""); await write("packages/app/src/shared/b.ts", "");
    execFileSync("git", ["-C", root, "init", "-q"]); execFileSync("git", ["-C", root, "add", "."]);
    vi.stubEnv("TYPESAFE_API_KEY", ""); vi.stubEnv("JEV_API_KEY", ""); vi.stubEnv("HOME", root);
    const result = await buildDocsFlows({ projectCwd:root, workspaces:[{ path:"apps/api", name:"@acme/api" }, { path:"apps/web", name:"@acme/web" }, { path:"packages/app", name:"@acme/app" }] });
    expect(result.flows.map((flow) => [flow.slug, flow.entries])).toEqual([["billing", 2], ["profile", 1]]);
    expect(result.routes).toBe(3);
    const kept = await buildDocsFlows({ projectCwd:root, workspaces:[{ path:"apps/api", name:"@acme/api" }, { path:"apps/web", name:"@acme/web" }, { path:"packages/app", name:"@acme/app" }], keep:["profile"] });
    expect(kept.flows[0]!.slug).toBe("profile");
    const brief = await readFile(result.briefPath, "utf8");
    expect(brief).toContain("## billing -> docs/flows/billing.md");
    expect(brief).toContain("apps/api/src/routes/pay.ts - POST /v1/pay (line 2)");
    expect(brief).toContain("chain: apps/api/src/routes/pay.ts -> packages/app/src/billing/index.ts");
    expect(brief).toContain("calls: charge (packages/app/src/billing/charge.ts:1)");
    expect(result.flows.find((flow) => flow.slug === "billing")!.calls).toEqual([{ name:"charge", file:"packages/app/src/billing/charge.ts", line:1, endLine:2 }]);
    expect(brief).toContain("chain: apps/web/pages/checkout.vue -> (HTTP POST /v1/pay) apps/api/src/routes/pay.ts -> packages/app/src/billing/index.ts");
  } finally { await rm(root, { recursive:true, force:true }); }
});
