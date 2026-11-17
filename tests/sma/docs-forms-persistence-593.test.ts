import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import hostEntry from "../../host";
import { localDateKey, nightlyDocsPrompt } from "../../src/rooms/docs/docs";
import type { DocsUnit } from "../../src/rooms/docs/docs";
import { docsCompletenessGaps } from "../../src/rooms/docs/docs-lint";
import { listDocsPages } from "../../src/rooms/host-worker/host-handlers";
import { docsUnitRecordKey } from "../../src/rooms/docs/server/docs-unit-records";
import { openDatabase, saveProjectSetting, savePrototypeConfig } from "../../src/rooms/plugin-db";

type FakeHost = ReturnType<typeof createFakePluginHost>;
type DocsReport = { state: string; commit?: string | null; reason?: string; findings?: Array<{ path: string; rule: string; detail: string }> };

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const hostId = process.env.BB_HOST_ID || "scratch-docs";
const required = { tables: [] as string[], core: [] };
const page = (type: string, citation = "src/forms.ts:3") => `---
title: ${type}
type: ${type}
created: 2026-11-17
updated: 2026-11-17
status: active
confidence: low
tags: [codebase]
sources: [src/forms.ts]
---
# ${type}

The code owns the following values.

\`alpha\` is defined in src/forms.ts:1.
\`beta\` is defined in src/forms.ts:2.
\`gamma\` is defined in ${citation}.

## Relations

The values share the source module.
`;

async function scratch(tables: string[] = [], options: { deploy?: boolean; unit?: DocsUnit } = {}) {
  const root = await mkdtemp(join(tmpdir(), "docs-forms-593-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git("config", "--local", "commit.gpgsign", "false");
  git("config", "--local", "core.hooksPath", "/dev/null");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/forms.ts"), "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n");
  git("add", "src/forms.ts");
  git("-c", "user.name=Scratch", "-c", "user.email=scratch@localhost", "commit", "--quiet", "-m", "fixture source");
  const unit = options.unit ?? { docsDir: "docs" };
  const inputs = { ...required, tables, deploy: options.deploy ?? false, docsDir: unit.docsDir, workspace: Boolean(unit.workspace), flows: unit.flows };
  const paths = unit.flow ? [`docs/flows/${unit.flow.slug}.md`] : docsCompletenessGaps([], inputs).missingPages;
  for (const path of paths) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    const type = unit.flow ? "flow" : path.includes("/audiences/") ? "audience" : path.split("/").pop()!.slice(0, -3);
    const body = unit.flow ? page(type) + "\n## How it works\n\n## Capabilities\n\n" + "`alpha` is defined in src/forms.ts:1.\n".repeat(12) : page(type);
    await writeFile(join(root, path), body);
  }
  const inventory = () => listDocsPages({ requestedHostId: hostId, projectCwd: root, roots: [unit.docsDir] }, undefined as never);
  return { root, git, inputs, paths, inventory, unit };
}

// Resume from persisted model output. Only model repair, thread observations and SDK file transport are doubles;
// the registered graph, verdict, host handlers, CAS builders and git commit all execute their real code.
async function finish(fixture: Awaited<ReturnType<typeof scratch>>, options: {
  phase?: "writing" | "repairing"; repair?: () => Promise<void>; legacy?: boolean; requirements?: unknown; beforeDirty?: string[];
  active?: () => boolean; observationFault?: boolean; fresh?: boolean; anchorFault?: "failure" | "malformed";
  drive?: (state: { bb: FakeHost["bb"]; harness: FakeHost["harness"]; key: string; calls: string[]; spawns: unknown[] }) => Promise<void>;
} = {}) {
  const { root } = fixture;
  const calls: string[] = [];
  const allowed = new Set(["gitDocsScope", "listDocsPages", "docsLineCounts", "readBoundedFile", "writeDocsPages", "gitCommitDocs", "gitRevertPaths", "docsAnchors", "docsFlows"]);
  const messages: string[] = [];
  const spawns: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      projects: {
        get: async () => ({ id: "proj_forms", sources: [{ hostId, path: root, isDefault: true }] }) as never,
        list: async () => [{ id: "proj_forms" }] as never,
      } as never,
      providers: {
        list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }] as never,
        models: async () => ({ models: [{ id: "gpt-6-luna", model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] }) as never,
      } as never,
      files: { read: async ({ path }: { path: string }) => {
        if (!resolve(path).startsWith(`${root}/`)) throw new Error(`outside scratch: ${path}`);
        return { content: await readFile(path, "utf8") } as never;
      }, write: async ({ path, content, contentEncoding }: { path: string; content: string; contentEncoding: string }) => {
        if (!resolve(path).startsWith(`${root}/.agents/docs-night/`)) throw new Error(`outside docs material: ${path}`);
        expect(contentEncoding).toBe("utf8");
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, content);
        return {} as never;
      } } as never,
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: threadId === "thr_docs" && options.active?.() ? "running" : "idle" }) as never,
        events: { list: async ({ threadId }: { threadId: string }) => {
          if (options.observationFault) throw new Error("thread observation unavailable");
          const now = Date.now(); return [
          ...(threadId === "thr_docs" && options.active?.() ? [] : [{ seq: 3, type: "turn/completed", createdAt: now + 2, threadId, data: { status: "completed" } }]),
          { seq: 2, type: "turn/started", createdAt: now + 1, threadId, data: {} },
          { seq: 1, type: "client/turn/requested", createdAt: now, threadId, data: {} },
        ] as never; } },
        spawn: async (input: unknown) => {
          spawns.push(input);
          if (options.active?.()) throw new Error("overlapping model spawn");
          if (!options.fresh && !options.drive) throw new Error("model spawn forbidden");
          return { id: "thr_fresh" } as never;
        },
        send: async (input: { input: Array<{ text: string }> }) => {
          messages.push(input.input.map((part) => part.text).join("\n"));
          await options.repair?.();
          return {} as never;
        },
      } as never,
    },
    experimental_callHostRpc: async (call) => {
      if (call.method === "gitCreateWorktree") {
        expect((call.input as { basePath: string }).basePath).toBe(root);
        calls.push(call.method);
        return { hostId, status: "failed", path: null, branch: null, reason: "controlled in-place fallback" };
      }
      if (!allowed.has(call.method)) throw new Error(`unexpected host operation: ${call.method}`);
      expect((call.input as { projectCwd: string }).projectCwd).toBe(root);
      calls.push(call.method);
      if (call.method === "docsAnchors" && options.anchorFault === "failure") throw new Error("controlled code-map read failure");
      if (call.method === "docsAnchors" && options.anchorFault === "malformed") return { hostId, briefPath: "unused", anchors: 0, tables: [123], deploy: "unknown", core: [], productFiles: [] };
      const handler = hostEntry.handlers[call.method as keyof typeof hostEntry.handlers];
      return handler(call.input as never, undefined as never);
    },
  });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const db = openDatabase(bb);
  if (options.fresh || options.drive) {
    savePrototypeConfig(db, { projectId: "proj_forms", hostId, pmWorkspacePath: root, writerWorkspacePath: root, pmProviderId: "codex", pmModel: "gpt-6-luna", writerProviderId: "codex", writerModel: "gpt-6-luna" });
    saveProjectSetting(db, "proj_forms", "docs.enabled", true);
  }
  if (options.fresh) {
    const output = await harness.behavior.runCli(["docs-nightly", "proj_forms"]) as { stdout: string };
    const rows = JSON.parse(output.stdout) as DocsReport[];
    return { row: rows[0]!, calls, messages, spawns, failures: db.prepare("SELECT node_id,error FROM lane_pilot_wf_step WHERE state='failed'").all() };
  }
  const label = fixture.unit.flow ? `docs/flows/${fixture.unit.flow.slug}.md` : fixture.unit.docsDir;
  const key = docsUnitRecordKey("proj_forms", root, label);
  await bb.storage.kv.set(key, { version: 1, projectId: "proj_forms", place: { hostId, path: root }, label, unit: fixture.unit, threadId: "thr_docs",
    phase: options.phase ?? "repairing", beforeDirty: options.beforeDirty ?? [], localDate: localDateKey(new Date()), since: "24 hours ago", roots: [fixture.unit.docsDir], workspaces: [], hasDocs: false,
    ...(Object.hasOwn(options, "requirements") ? { requirements: options.requirements } : !options.legacy ? { requirements: { tables: fixture.inputs.tables, deploy: fixture.inputs.deploy } } : {}),
    changedCount: 1, refresh: [], gaps: { missingPages: [], uncoveredCore: [] }, anchors: null, core: [], kvKey: "forms-report" });
  await bb.storage.kv.set("docs-units-open", { [key]: true });
  await harness.runSchedule("docs-nightly-catchup");
  await options.drive?.({ bb, harness, key, calls, spawns });
  const failed = () => db.prepare("SELECT reason FROM lane_pilot_wf_run WHERE status='failed'").get() as { reason: string } | undefined;
  await expect.poll(async () => Boolean(await bb.storage.kv.get("forms-report")) || Boolean(failed()), { timeout: 10_000 }).toBe(true);
  if (failed()) {
    const step = db.prepare("SELECT node_id,error FROM lane_pilot_wf_step WHERE state='failed'").get() as { node_id: string; error: string };
    console.log(JSON.stringify({ scope: "failed-admission-step", runReason: failed()!.reason, step, calls }));
    throw new Error(step.error);
  }
  const row = await bb.storage.kv.get("forms-report") as DocsReport;
  const steps = openDatabase(bb).prepare("SELECT node_id FROM lane_pilot_wf_step ORDER BY started_at").all() as Array<{ node_id: string }>;
  expect(steps.map((step) => step.node_id)).toEqual(["prepare", "write", "verify", "commit", "done"]);
  expect(calls).toEqual(expect.arrayContaining(["gitDocsScope", "listDocsPages", "docsLineCounts", "readBoundedFile"]));
  return { row, calls, messages, spawns, failures: [] };
}

describe("n1648 persisted adaptive docs forms, source/scratch evidence only", () => {
  it.each([{ tables: [] }, { tables: ["widgets"] }])("checks real persisted forms and commits the generated index (tables=$tables)", async ({ tables }) => {
    const fixture = await scratch(tables);
    const { row, calls } = await finish(fixture);
    expect(row).toMatchObject({ state: "passed", commit: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(calls).toEqual(expect.arrayContaining(["writeDocsPages", "gitCommitDocs"]));
    const persisted = await fixture.inventory();
    expect(persisted.pages.map((item) => item.path).sort()).toEqual([...fixture.paths, "docs/index.md"].sort());
    expect(docsCompletenessGaps(persisted.pages, fixture.inputs)).toEqual({ missingPages: [], uncoveredCore: [] });
    for (const item of persisted.pages) {
      const bytes = await readFile(join(fixture.root, item.path), "utf8");
      expect(sha(bytes)).toBe(item.sha256);
      expect(fixture.git("show", `HEAD:${item.path}`)).toBe(bytes);
    }
    console.log(JSON.stringify({ scope: "scratch-persisted-forms", conditionalTables: fixture.inputs.tables, paths: persisted.pages.map((item) => ({ path: item.path, sha256: item.sha256 })), commit: row.commit, calls }));
  });

  it.each(["unknown-type", "invalid-citation", "wrong-symbol-range"])("rejects persisted %s without committing", async (fault) => {
    const fixture = await scratch();
    await writeFile(join(fixture.root, "docs/testing.md"), fault === "unknown-type" ? page("unrecognized") : page("testing", fault === "invalid-citation" ? "src/forms.ts:99" : "src/forms.ts:1"));
    const before = fixture.git("rev-parse", "HEAD");
    const { row, calls } = await finish(fixture);
    expect(row.state).toBe("failed");
    expect(row.findings).toEqual(expect.arrayContaining([expect.objectContaining({ path: "docs/testing.md", rule: fault === "unknown-type" ? "frontmatter" : "evidence" })]));
    expect(calls).not.toContain("writeDocsPages");
    expect(calls).not.toContain("gitCommitDocs");
    expect(fixture.git("rev-parse", "HEAD")).toBe(before);
    console.log(JSON.stringify({ scope: "scratch-invalid-page", fault, findings: row.findings, calls }));
  });

  it("keeps a missing unconditional form blocking after an unrepaired round", async () => {
    const fixture = await scratch();
    await rm(join(fixture.root, "docs/testing.md"));
    const persisted = await fixture.inventory();
    const gaps = docsCompletenessGaps(persisted.pages, fixture.inputs);
    expect(gaps).toEqual({ missingPages: ["docs/testing.md"], uncoveredCore: [] });
    expect(nightlyDocsPrompt({ since: "24 hours ago", hasDocs: true, changed: [], missingPages: gaps.missingPages })).toContain("- docs/testing.md");
    const before = fixture.git("rev-parse", "HEAD");
    const { row, calls, messages } = await finish(fixture, { phase: "writing" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("docs/testing.md [completeness]");
    expect(row).toMatchObject({ state: "failed", commit: null, findings: expect.arrayContaining([expect.objectContaining({ path: "docs/testing.md", rule: "completeness" })]) });
    expect(calls).not.toContain("gitCommitDocs");
    expect(fixture.git("rev-parse", "HEAD")).toBe(before);
    console.log(JSON.stringify({ scope: "missing-form-admission", gaps, row, messages }));
  });

  it("admits a required form actually persisted by the model-boundary repair", async () => {
    const fixture = await scratch();
    await rm(join(fixture.root, "docs/testing.md"));
    const { row, messages } = await finish(fixture, { phase: "writing", repair: () => writeFile(join(fixture.root, "docs/testing.md"), page("testing")) });
    expect(messages).toHaveLength(1);
    expect(row.state).toBe("passed");
    expect(fixture.git("show", "HEAD:docs/testing.md")).toBe(await readFile(join(fixture.root, "docs/testing.md"), "utf8"));
  });

  it.each([
    { tables: ["widgets"], deploy: false, missing: "docs/data-model.md", unit: undefined },
    { tables: [], deploy: true, missing: "docs/deployment.md", unit: undefined },
    { tables: ["widgets"], deploy: false, missing: "apps/worker/docs/data-model.md", unit: { docsDir: "apps/worker/docs", workspace: { path: "apps/worker", name: "worker" } } },
    { tables: [], deploy: false, missing: "docs/capabilities.md", unit: { docsDir: "docs", flows: ["checkout"] } },
  ])("blocks persisted conditional requirements on resume: $missing", async ({ tables, deploy, missing, unit }) => {
    const fixture = await scratch(tables, { deploy, unit });
    await rm(join(fixture.root, missing));
    const { row, calls } = await finish(fixture);
    expect(row).toMatchObject({ state: "failed", findings: expect.arrayContaining([expect.objectContaining({ path: missing, rule: "completeness" })]) });
    expect(calls).not.toContain("gitCommitDocs");
  });

  it("preserves workspace inheritance without requiring the root forms in that workspace", async () => {
    const fixture = await scratch([], { unit: { docsDir: "apps/worker/docs", workspace: { path: "apps/worker", name: "worker" } } });
    const { row } = await finish(fixture);
    expect(row.state).toBe("passed");
    expect(fixture.paths).toEqual(["apps/worker/docs/overview.md"]);
  });

  it("requires the root audience paths while keeping a flow-only unit independent", async () => {
    const root = await scratch([], { unit: { docsDir: "docs", flows: ["checkout"] } });
    await rm(join(root.root, "docs/audiences/design.md"));
    const { row } = await finish(root);
    expect(row).toMatchObject({ state: "failed", findings: expect.arrayContaining([expect.objectContaining({ path: "docs/audiences/design.md", rule: "completeness" })]) });
    const flow = await scratch([], { unit: { docsDir: "docs", flow: { slug: "checkout", name: "Checkout", briefPath: ".agents/checkout.md", files: ["src/forms.ts"], calls: [] } } });
    const done = await finish(flow, { legacy: true });
    expect(done.row.state).toBe("passed");
    expect(done.calls).not.toContain("docsAnchors");
  });

  it("fails closed for a legacy nonflow record with unknown conditional requirements", async () => {
    const fixture = await scratch();
    const before = fixture.git("rev-parse", "HEAD");
    await expect(finish(fixture, { legacy: true })).rejects.toThrow("docs completeness requirements unavailable");
    expect(fixture.git("rev-parse", "HEAD")).toBe(before);
  });

  it.each(["failure", "malformed"] as const)("refuses fresh %s requirements before any model spawn in fallback mode", async (anchorFault) => {
    const fixture = await scratch();
    const before = await fixture.inventory();
    const head = fixture.git("rev-parse", "HEAD");
    const result = await finish(fixture, { fresh: true, anchorFault });
    expect(result.row.state).toBe("failed");
    expect(result.calls).toContain("gitCreateWorktree");
    expect(result.spawns).toHaveLength(0);
    expect(result.messages).toHaveLength(0);
    expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining({ node_id: "prepare", error: expect.stringContaining("docs completeness requirements unavailable") })]));
    expect(result.calls).not.toContain("writeDocsPages");
    expect(result.calls).not.toContain("gitCommitDocs");
    expect((await fixture.inventory()).pages.map(({ path, sha256 }) => ({ path, sha256 }))).toEqual(before.pages.map(({ path, sha256 }) => ({ path, sha256 })));
    expect(fixture.git("rev-parse", "HEAD")).toBe(head);
    console.log(JSON.stringify({ scope: "fresh-requirements-pre-spawn-refusal", anchorFault, failures: result.failures, spawns: result.spawns.length, calls: result.calls }));
  });

  it.each([{ tables: [123], deploy: false }, { tables: [], deploy: "unknown" }])("refuses malformed persisted requirements after settlement and scope cleanup: %j", async (requirements) => {
    const fixture = await scratch();
    await expect(finish(fixture, { requirements })).rejects.toThrow("docs completeness requirements unavailable");
  });

  it.each(["writing", "repairing"] as const)("drains active legacy %s before scoped fallback cleanup and fresh preparation", async (phase) => {
    const fixture = await scratch();
    const source = await readFile(join(fixture.root, "src/forms.ts"), "utf8");
    await writeFile(join(fixture.root, "user-notes.txt"), "pre-existing user work\n");
    const beforeDirty = (await hostEntry.handlers.gitDocsScope({ requestedHostId: hostId, projectCwd: fixture.root, sinceEpochMs: 0 }, undefined as never)).dirty;
    await writeFile(join(fixture.root, "src/forms.ts"), "unapproved model edit\n");
    await writeFile(join(fixture.root, "src/agent-only.txt"), "unapproved model file\n");
    let active = true;
    let recovered = false;
    await expect(finish(fixture, { legacy: true, phase, beforeDirty, active: () => active, drive: async ({ bb, harness, key, calls, spawns }) => {
      const overlap = harness.behavior.runCli(["docs-nightly", "proj_forms"]);
      await expect.poll(() => calls.includes("gitCreateWorktree")).toBe(true);
      expect(await bb.storage.kv.get(key)).toMatchObject({ threadId: "thr_docs", beforeDirty });
      expect(await bb.storage.kv.get("docs-units-open")).toMatchObject({ [key]: true });
      expect(spawns).toHaveLength(0);
      expect(calls).not.toContain("gitRevertPaths");
      active = false;
      const joined = await overlap as { stdout: string };
      console.log(JSON.stringify({ scope: "legacy-joined-pass", phase, rows: JSON.parse(joined.stdout), calls }));
      expect(JSON.parse(joined.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ state: "failed" })]));
      await expect.poll(async () => await bb.storage.kv.get(key)).toBeUndefined();
      expect(await readFile(join(fixture.root, "src/forms.ts"), "utf8")).toBe(source);
      await expect(readFile(join(fixture.root, "src/agent-only.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(fixture.root, "user-notes.txt"), "utf8")).toBe("pre-existing user work\n");
      expect(spawns).toHaveLength(0);
      const fresh = await harness.behavior.runCli(["docs-nightly", "proj_forms"]) as { stdout: string };
      console.log(JSON.stringify({ scope: "legacy-fresh-pass", phase, rows: JSON.parse(fresh.stdout), calls, spawns: spawns.length }));
      expect(JSON.parse(fresh.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ state: "passed", commit: expect.stringMatching(/^[a-f0-9]{40}$/) })]));
      expect(spawns).toHaveLength(1);
      expect(calls).toEqual(expect.arrayContaining(["gitRevertPaths", "docsAnchors", "gitCommitDocs"]));
      expect(await readFile(join(fixture.root, "user-notes.txt"), "utf8")).toBe("pre-existing user work\n");
      recovered = true;
      console.log(JSON.stringify({ scope: "active-legacy-fallback-recovery", phase, beforeDirty, spawns: spawns.length, recovered, calls }));
    } })).rejects.toThrow("docs completeness requirements unavailable");
    expect(recovered).toBe(true);
  });

  it("keeps unknown legacy ownership when thread observation fails before settlement", async () => {
    const fixture = await scratch();
    await expect(finish(fixture, { legacy: true, phase: "writing", observationFault: true, drive: async ({ bb, key, calls, spawns }) => {
      await expect.poll(() => openDatabase(bb).prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_run WHERE status='failed'").get()).toEqual({ n: 1 });
      expect(await bb.storage.kv.get(key)).toMatchObject({ threadId: "thr_docs", phase: "writing" });
      expect(await bb.storage.kv.get("docs-units-open")).toMatchObject({ [key]: true });
      expect(calls).not.toContain("gitRevertPaths");
      expect(spawns).toHaveLength(0);
    } })).rejects.toThrow("thread observation unavailable");
  });
});
