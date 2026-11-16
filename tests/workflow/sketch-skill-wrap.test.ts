import { coreFileWrite, diskStore } from "../helpers/core-files";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowEngine, registerPureActions, registerReducers, testCasesOf, runDraftTest } from "@lane-pilot/workflow-engine";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { createCore } from "../../src/rooms/core/server/core";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import type { Services } from "../../server";
import { builtinWorkflow, BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { loadWorkflowStore } from "@lane-pilot/workflow-engine";
import { sha256Hex } from "@lane-pilot/kit";

type Row = Record<string, unknown>;
const PROJECT = "sketch-wrap-project", PM = "sketch-wrap-pm", RUN = "sketch-wrap-run";
const draft = "# Compact filter bar\n\nKeep the winning direction visible at narrow widths.\n";
const reply = (body: Row) => "Done.\n\n```json\n" + JSON.stringify(body) + "\n```";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

async function setup() {
  const checkout = mkdtempSync(join(tmpdir(), "lp-sketch-wrap-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  const spawned: Row[] = [];
  const nodeOf = new Map<string, string>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async () => ({ hostId: "local", exitCode: 0, stdout: "", stderr: "" })) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => threadId === PM ? { role: "pm", lanePilotRunId: RUN } : {},
        spawn: async (args: unknown) => { const request = args as Row; spawned.push(request); const id = `helper-${spawned.length}`; nodeOf.set(id, String((request.pluginMetadata as Row).lanePilotWorkflowNode)); return { id }; },
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env" }),
        events: { list: async ({ threadId }: { threadId: string }) => { const now = Date.now(); return [{ type: "client/turn/requested", threadId, seq: 1, createdAt: now }, { type: "turn/started", threadId, seq: 2, createdAt: now + 1 }, { type: "turn/completed", threadId, seq: 3, data: { status: "completed" }, createdAt: now + 2 }]; } },
        output: async ({ threadId }: { threadId: string }) => ({ output: reply({ skill_draft: draft, handoff: "draft ready", node: nodeOf.get(threadId) }) }),
        send: async () => ({}),
        stop: async () => ({}),
      },
      environments: { get: async () => ({ id: "env", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, sources: [{ hostId: "local", path: checkout }] }) },
      files: {
        read: async ({ path }: { path: string }) => {
          if (!existsSync(path)) throw Object.assign(new Error(`file not found: ${path}`), { code: "not_found", serverCode: "file_not_found" });
          const content = readFileSync(path, "utf8");
          return { content, sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content, "utf8"), contentEncoding: "utf8" };
        },
        write: async (args: unknown) => coreFileWrite(diskStore())(args),
      },
      hosts: { directory: async () => ({ directory: checkout }) },
    },
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services) });
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);
  const workflow = builtinWorkflow("sketch-wrap-up")!;
  const start = (inputs: Row) => engine.start({ workflow, inputs, runtime: { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN } as never, link: { projectId: PROJECT, runId: RUN } });
  const dispose = () => { harness.lifecycle.dispose(); rmSync(checkout, { recursive: true, force: true }); };
  disposers.push(dispose);
  return { checkout, db, engine, start, dispose, spawned };
}

describe("sketch-wrap-up", () => {
  it("ships a built-in simulation for writing and for empty findings", async () => {
    const workflow = builtinWorkflow("sketch-wrap-up")!;
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES });
    const results = await Promise.all(testCasesOf(workflow).map((testCase) => runDraftTest({ db: openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb), harnessVersion: "test", resolveWorkflow: store.resolve }, workflow, testCase)));
    expect(results.every((result) => result.failures.length === 0)).toBe(true);
    expect(results.map((result) => result.output?.status)).toEqual(["written", "blocked"]);
  });

  it("[sma:k_c_sketchwrap] uses the registered writer for exact bytes and a non-overwriting sibling", async () => {
    const t = await setup();
    const first = await t.start({ findings: "Winning compact filter direction", skill_slug: "compact-filter-bar" }).done;
    expect(first.status, first.error ?? undefined).toBe("succeeded");
    expect(first.output).toMatchObject({ status: "written", skill_path: ".agents/forge/skills/compact-filter-bar/SKILL.md" });
    expect(readFileSync(join(t.checkout, ".agents/forge/skills/compact-filter-bar/SKILL.md"), "utf8")).toBe(draft);

    const existing = "# Keep this skill\n";
    writeFileSync(join(t.checkout, ".agents/forge/skills/compact-filter-bar/SKILL.md"), existing);
    const second = await t.start({ findings: "A revised winning direction", skill_slug: "compact-filter-bar" }).done;
    expect(second.status, second.error ?? undefined).toBe("succeeded");
    expect(second.output).toMatchObject({ status: "written", skill_path: ".agents/forge/skills/compact-filter-bar/SKILL.new.md" });
    expect(readFileSync(join(t.checkout, ".agents/forge/skills/compact-filter-bar/SKILL.md"), "utf8")).toBe(existing);
    expect(readFileSync(join(t.checkout, ".agents/forge/skills/compact-filter-bar/SKILL.new.md"), "utf8")).toBe(draft);
  });

  it("fails closed for an occupied sibling, unsafe slug, and empty findings", async () => {
    const t = await setup();
    const dir = join(t.checkout, ".agents/forge/skills/occupied");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "original\n");
    writeFileSync(join(dir, "SKILL.new.md"), "alternate\n");
    const occupied = await t.start({ findings: "A finding", skill_slug: "occupied" }).done;
    expect(occupied.status).toBe("failed");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("original\n");
    expect(readFileSync(join(dir, "SKILL.new.md"), "utf8")).toBe("alternate\n");

    const unsafe = await t.start({ findings: "A finding", skill_slug: "../escape" }).done;
    expect(unsafe.status).toBe("failed");
    expect(existsSync(join(t.checkout, ".agents/forge/escape/SKILL.md"))).toBe(false);

    const empty = await t.start({ findings: "", skill_slug: "empty-findings" }).done;
    expect(empty).toMatchObject({ status: "succeeded", output: { status: "blocked", skill_path: "" } });
    expect(existsSync(join(t.checkout, ".agents/forge/skills/empty-findings/SKILL.md"))).toBe(false);
  });
});
