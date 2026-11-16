import { coreFileWrite, diskStore } from "../helpers/core-files";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { registerPureActions, registerReducers, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { loadWorkflowStore } from "@lane-pilot/workflow-engine";

type Row = Record<string, unknown>;
const PM = "pm-spike-skill", PROJECT = "project-spike-skill", RUN = "run-spike-skill";
const reply = (body: Row): string => `Done.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
const disposers: Array<() => void> = [];

afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

/** Real chain composition and real fs.write; only the analyst's model response is scripted. */
async function setup(experiment: Row, before?: (checkout: string) => void) {
  const checkout = mkdtempSync(join(tmpdir(), "lp-spike-skill-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  before?.(checkout);
  const spawned: Array<Row> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Row }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => (threadId === PM ? { role: "pm", lanePilotRunId: RUN } : {}),
        spawn: async (args) => {
          const request = args as unknown as Row;
          spawned.push(request);
          const id = `helper-${spawned.length}`;
          return { id };
        },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-spike", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
        events: { list: async ({ threadId }) => {
          const now = Date.now();
          return [{ type: "client/turn/requested", threadId, seq: 1, createdAt: now }, { type: "turn/started", threadId, seq: 2, createdAt: now + 1 }, { type: "turn/completed", threadId, seq: 3, data: { status: "completed" }, createdAt: now + 2 }];
        } },
        send: async () => ({} as never),
        stop: async () => ({ ok: true }) as never,
        output: async () => ({ output: reply(experiment) }),
      },
      environments: { get: async () => ({ id: "env-spike", hostId: "local", path: checkout, status: "ready" }) as never },
      projects: { get: async () => ({ id: PROJECT, name: "Spike project", sources: [{ hostId: "local", path: checkout }] }) },
      files: {
        write: async (args: unknown) => coreFileWrite(diskStore())(args) as never,
        read: async (args: unknown) => {
          const path = String((args as { path?: unknown }).path ?? "");
          if (!existsSync(path)) throw Object.assign(new Error(`file not found: ${path}`), { code: "not_found", serverCode: "file_not_found" });
          const content = readFileSync(path, "utf8");
          const { sha256Hex } = await import("@lane-pilot/kit");
          return { content, sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content, "utf8"), contentEncoding: "utf8", truncated: false };
        },
      },
      hosts: { directory: async () => ({ directory: checkout }) },
    },
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { dispatchWriter: vi.fn(async (args: Row) => ({ runId: RUN, taskId: (args.task as Row).id, state: "queued" })), stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services) });
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES });
  const workflow = store.resolve("spike") as Workflow;
  const start = (inputs: Row = {}) => engine.start({ workflow, inputs, runtime: rt, link: { projectId: PROJECT, runId: RUN } });
  disposers.push(() => { harness.lifecycle.dispose(); rmSync(checkout, { recursive: true, force: true }); });
  return { checkout, start, spawned };
}

describe("spike wrap_skill persistence through the real engine", () => {
  it("[sma:k_c_spikewrap] writes the exact supplied skill_draft and reports the actual skill path", async () => {
    const draft = "---\nname: persist-exact\ndescription: exact bytes\n---\n\nUnicode: ё\ntrailing spaces  \n";
    const t = await setup({ answered: true, decision: "yes", document: "# Spike\n", skill_draft: draft, handoff: "answered" });
    const summary = await t.start({ question: "prove draft persistence", wrap_skill: "persist-exact" }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "answered", skill_path: ".agents/forge/skills/persist-exact/SKILL.md" });
    expect(readFileSync(join(t.checkout, ".agents/forge/skills/persist-exact/SKILL.md"), "utf8")).toBe(draft);
    expect(t.spawned).toHaveLength(1);
  });

  it("diverts an existing skill file to .new.md without changing original bytes", async () => {
    const original = "original skill bytes\n";
    const draft = "replacement draft must not clobber\n";
    const t = await setup({ answered: true, decision: "yes", document: "# Spike\n", skill_draft: draft, handoff: "answered" }, (checkout) => {
      mkdirSync(join(checkout, ".agents/forge/skills/keep"), { recursive: true });
      writeFileSync(join(checkout, ".agents/forge/skills/keep/SKILL.md"), original);
    });
    const summary = await t.start({ question: "prove create-only", wrap_skill: "keep" }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(readFileSync(join(t.checkout, ".agents/forge/skills/keep/SKILL.md"), "utf8")).toBe(original);
    expect(readFileSync(join(t.checkout, ".agents/forge/skills/keep/SKILL.new.md"), "utf8")).toBe(draft);
    expect(summary.output).toMatchObject({ status: "answered", skill_path: ".agents/forge/skills/keep/SKILL.new.md" });
  });

  it("omits skill output and writes no skill file when wrap_skill is omitted", async () => {
    const t = await setup({ answered: true, decision: "yes", document: "# Spike\n", skill_draft: "unsolicited draft must not be persisted\n", handoff: "answered" });
    const summary = await t.start({ question: "no wrapping requested" }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "answered", skill_path: "" });
    expect(existsSync(join(t.checkout, ".agents/forge/skills"))).toBe(false);
  });
});
