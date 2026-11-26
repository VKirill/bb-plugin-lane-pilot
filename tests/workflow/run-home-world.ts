import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { vi } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { runCommand } from "../../src/rooms/host-worker";
import { createCore } from "../../src/rooms/core/server/core";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/services/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/services/workflow-executors";
import { registerPureActions, registerReducers, WorkflowEngine, parseWorkflow } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";
import { endedTurn } from "../helpers/ended-turn";

/**
 * A small world for the run folder (docs/task-folder.md, «The run folder»): the real engine, the real chain executors, a real git checkout in a temp
 * folder, and a BB file API with the CORE's semantics (`expectedSha256: null` is create-only: over an existing file it answers `conflict` and writes
 * nothing, without throwing; an absent key replaces). A helper thread is a scripted answer.
 */
export const PROJECT = "run-home-project", PM = "run-home-pm", RUN = "run-home-run";
export type Row = Record<string, unknown>;
export const reply = (body: Row, lead = "Done.") => `${lead}\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;
export const chain = (extra: Row): Workflow => parseWorkflow({
  schemaVersion: 1, id: "run-home-chain", name: "Run home chain", description: { en: "A chain", ru: "Цепочка" }, inputs: [], outputs: [], ...extra,
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every file under the checkout (not .git), relative, sorted: the `find` of the drill. */
export function findFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

export async function runHomeWorld(script: Record<string, string[]> = {}, options: { noPm?: boolean } = {}) {
  const checkout = mkdtempSync(join(tmpdir(), "lp-run-home-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  const spawned: Row[] = [], logs: string[] = [], refused: string[] = [];
  const nodeOf = new Map<string, string>(), counts = new Map<string, number>();
  let next = 0;
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
          const id = `helper-${next += 1}`;
          nodeOf.set(id, String((request.pluginMetadata as Row).lanePilotWorkflowNode ?? (request.pluginMetadata as Row).role));
          return { id };
        },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-pm", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
        events: { list: async ({ threadId }) => endedTurn(threadId) },
        send: async () => ({}) as never,
        stop: async () => ({ ok: true }) as never,
        output: async ({ threadId }) => {
          const node = nodeOf.get(threadId) ?? "";
          const at = counts.get(threadId) ?? 0;
          counts.set(threadId, at + 1);
          const answers = script[node] ?? [];
          return { output: answers[Math.min(at, answers.length - 1)] ?? "no script" };
        },
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: {
        read: async (args: unknown) => {
          const { path } = args as { path: string };
          if (!existsSync(path)) throw Object.assign(new Error("not found"), { code: "not_found" });
          const content = readFileSync(path, "utf8");
          return { content, sha256: sha(content), sizeBytes: Buffer.byteLength(content, "utf8") };
        },
        write: async (args: unknown) => {
          const input = args as { path: string; content: string; expectedSha256?: string | null };
          const current = existsSync(input.path) ? sha(readFileSync(input.path, "utf8")) : null;
          if (input.expectedSha256 !== undefined && input.expectedSha256 !== current) { refused.push(input.path); return { outcome: "conflict", currentSha256: current } as never; }
          mkdirSync(dirname(input.path), { recursive: true });
          writeFileSync(input.path, input.content);
          return { outcome: "written", sha256: sha(input.content), sizeBytes: Buffer.byteLength(input.content) } as never;
        },
      },
    },
  });
  const db = openDatabase(bb);
  if (!options.noPm) {
    createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
    setRunThread(db, RUN, PM);
  }
  const ctx = createCore(bb, db);
  const originalLog = ctx.log;
  ctx.log = ((line: string) => { logs.push(line); return originalLog?.(line); }) as never;
  const services = { dispatchWriter: vi.fn(async () => ({ state: "queued" })), stability: { loadParked: async () => [] }, taskUsage: () => ({}) } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services) });
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  const rt: ChainRuntime = { ctx, services, pmThreadId: options.noPm ? null : PM, projectId: PROJECT, runId: options.noPm ? null : RUN };
  const start = (workflow: Workflow, inputs: Row = {}) => engine.start({ workflow, inputs, runtime: rt, link: options.noPm ? { projectId: PROJECT } : { projectId: PROJECT, runId: RUN } });
  return { bb, db, ctx, engine, checkout, spawned, logs, refused, start, rt, find: () => findFiles(checkout), dispose: () => harness.lifecycle.dispose() };
}
