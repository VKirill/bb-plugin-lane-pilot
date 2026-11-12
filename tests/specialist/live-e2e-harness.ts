import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  contractSample,
  type Field,
  type GraphNode,
  loadWorkflowStore,
  lowerWorkflow,
  registerPureActions,
  registerReducers,
  WorkflowEngine,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import { vi } from "vitest";
import type { Services } from "../../server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { createCore } from "../../src/rooms/core/server/core";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import "../../src/rooms/jev/judgments";

export type Row = Record<string, unknown>;
export type AgentReplyCtx = { checkout: string; workflowId: string; nodeId: string; visit: number };
export type AgentReplySpec = Row | ((ctx: AgentReplyCtx) => Row);
export type HumanAnswerSpec = { choice?: string; text?: string };

const PROJECT = "sp-live-project";
const PM = "sp-live-pm";
const RUN = "sp-live-run";

let cachedStore: Promise<WorkflowStore> | null = null;
export const getBuiltinStore = (): Promise<WorkflowStore> => (cachedStore ??= loadWorkflowStore({ builtin: BUILTIN_SOURCES }));

const FALSE_BY_NAME = /(^|_)(stalled|warn|has_ui|blocked|failed|thin|timeout|drift|error|errors|missing|dirty|unmet|needs|skipped|breaking|regression|rejected|duplicate|no|drop_due|refresh_due|structure_due|tech_due|release_due|ai_visibility_due)(_|$)/;

function defaultForField(f: Field): unknown {
  switch (f.type) {
    case "string":
      return f.default ?? (f.name.endsWith("_json") ? "{}" : f.name.endsWith("_path") ? `.agents/report-${f.name}.json` : "ok");
    case "number":
      return f.default ?? 1;
    case "boolean":
      return f.default ?? !FALSE_BY_NAME.test(f.name);
    case "enum":
      return f.default ?? f.values?.[0] ?? "";
    case "array":
      return f.default ?? [];
    case "object":
    case "json":
      return f.default ?? {};
  }
}

export const jsonReply = (body: Row, lead = "Выполнено.") => `${lead}\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

export async function setupLiveSpecialistEnv(
  agentReplies: Record<string, AgentReplySpec> = {},
  humanChoices: Record<string, HumanAnswerSpec> = {},
) {
  const store = await getBuiltinStore();
  const checkout = mkdtempSync(join(tmpdir(), "sp-live-e2e-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=e2e@bb", "-c", "user.name=e2e", ...args], { cwd: checkout });
  git("init", "-q");
  writeFileSync(join(checkout, "README.md"), "# Specialist OS Live E2E Project\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "initial");

  const nodeMeta = new Map<string, { workflowId: string; nodeId: string; spawnId: string }>();
  const visits = new Map<string, number>();
  const spawned: Row[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const dispatchedWriters: Row[] = [];
  const savedSchedules: Row[] = [];
  const backlogScans: string[] = [];
  let seq = 0;

  const findLoweredAgentNode = (workflowId: string, nodeId: string): Extract<GraphNode, { type: "agent" }> | null => {
    const wf = store.get(workflowId)?.workflow;
    if (!wf) return null;
    const lowered = lowerWorkflow(wf, (id, ver) => store.resolve(id, ver));
    const hit = lowered.nodes.find((n) => n.id === nodeId && n.type === "agent");
    return (hit as Extract<GraphNode, { type: "agent" }> | undefined) ?? null;
  };

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
          const req = args as unknown as Row;
          spawned.push(req);
          const id = `sp-helper-${(seq += 1)}`;
          const meta = (req.pluginMetadata ?? {}) as Row;
          const spawnId = String(meta.spawnId ?? "");
          const nodeId = String(meta.lanePilotWorkflowNode ?? meta.role ?? "");
          const wfRunId = String(meta.lanePilotWorkflowRunId ?? "");
          const wfId = wfRunId ? (engine.journal.getRun(wfRunId)?.workflow_id ?? "") : "";
          nodeMeta.set(id, { workflowId: wfId, nodeId, spawnId });
          return { id };
        },
        get: async ({ threadId }) => ({
          id: threadId,
          status: "idle",
          projectId: PROJECT,
          environmentId: "env-pm",
          sourceThreadId: PM,
          lifecycleOwnerThreadId: PM,
        }),
        events: {
          list: async ({ threadId }) => [
            { type: "turn/started", threadId, seq: 1 },
            { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
          ],
        },
        send: async () => ({}) as never,
        stop: async () => ({ ok: true }) as never,
        output: async ({ threadId }) => {
          const info = nodeMeta.get(threadId) ?? { workflowId: "", nodeId: "", spawnId: "" };
          if (info.spawnId.endsWith(":question")) {
            return { output: jsonReply({ question: "Подтвердите выполнение шага владельцем?" }) };
          }
          const vKey = `${info.workflowId}:${info.nodeId}`;
          const visit = (visits.get(vKey) ?? 0) + 1;
          visits.set(vKey, visit);

          const loweredNode = findLoweredAgentNode(info.workflowId, info.nodeId);
          const fields = loweredNode?.out ?? [];
          const base: Row = {
            ...Object.fromEntries(fields.map((f) => [f.name, defaultForField(f)])),
            ...contractSample(loweredNode?.produces, fields),
            outcome: "done",
            handoff: `completed ${info.nodeId}`,
          };

          const baseNodeId = info.nodeId.replace(/:child$/, "");
          const spec =
            agentReplies[`${info.workflowId}:${info.nodeId}`] ??
            agentReplies[`${info.workflowId}:${baseNodeId}`] ??
            agentReplies[info.nodeId] ??
            agentReplies[baseNodeId];
          const custom = typeof spec === "function" ? spec({ checkout, workflowId: info.workflowId, nodeId: info.nodeId, visit }) : (spec ?? {});
          return { output: jsonReply({ ...base, ...custom }) };
        },
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Specialist Live Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: {
        read: async (args: unknown) => {
          const input = args as { path: string };
          if (!existsSync(input.path)) {
            throw Object.assign(new Error(`ENOENT: no such file ${input.path}`), { code: "ENOENT" });
          }
          const content = readFileSync(input.path, "utf8");
          return { content, contentEncoding: "utf8", sha256: "", sizeBytes: Buffer.byteLength(content) } as never;
        },
        write: async (args: unknown) => {
          const input = args as { path: string; content: string };
          mkdirSync(dirname(input.path), { recursive: true });
          writeFileSync(input.path, input.content, "utf8");
          writes.push({ path: input.path, content: input.content });
          return { ok: true } as never;
        },
      },
    },
  });

  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = {
    dispatchWriter: vi.fn(async (args: Row) => {
      dispatchedWriters.push(args);
      return { runId: RUN, taskId: (args.task as Row).id, state: "queued" };
    }),
    stability: { loadParked: async () => [] },
    taskUsage,
  } as unknown as Services;

  const engine = new WorkflowEngine({
    db,
    harnessVersion: "sp-live-e2e",
    resolveWorkflow: (id, ver) => store.resolve(id, ver),
    runtimeFor: chainRuntimeFor(ctx, services),
  });
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);

  // Mirror server.ts initialization order: schedules and backlog attach AFTER registerChainExecutors!
  (services as unknown as Record<string, unknown>).workflowEngine = engine;
  (services as unknown as Record<string, unknown>).workflowCatalog = {
    resolve: (id: string, ver?: number) => store.resolve(id, ver),
  };
  (services as unknown as Record<string, unknown>).schedules = {
    save: vi.fn(async (raw: Row) => {
      const id = `sched_${savedSchedules.length + 1}`;
      savedSchedules.push({ id, ...raw });
      return { ok: true, schedule: { id } };
    }),
  };
  (services as unknown as Record<string, unknown>).backlog = {
    scan: vi.fn(async (pid?: string | number) => {
      backlogScans.push(typeof pid === "string" ? pid : PROJECT);
      return { ok: true };
    }),
  };
  (services as unknown as Record<string, unknown>).executeMutation = vi.fn((item: Row) => ({
    ok: true,
    externalReceipt: { adapter: "e2e_mock", entityId: item.entity_id ?? "entity" },
  }));
  (services as unknown as Record<string, unknown>).allowScriptFixtureFallback = true;

  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };

  const runWorkflowLive = async (workflowId: string, inputs: Row = {}) => {
    const wf = store.get(workflowId)?.workflow;
    if (!wf) throw new Error(`Unknown workflow: ${workflowId}`);
    const answeredForms = new Set<string>();
    const started = engine.start({ workflow: wf, inputs, runtime: rt, link: { projectId: PROJECT, runId: RUN } });

    for (let tick = 0; tick < 600; tick += 1) {
      for (const item of harness.pendingInteractions) {
        if (answeredForms.has(item.id)) continue;
        answeredForms.add(item.id);
        const payload = (item.payload ?? {}) as { options?: Array<{ id: string; label: string }> };
        const opts = payload.options ?? [];
        const payloadStr = JSON.stringify(item.payload ?? {});
        const matchedKey = Object.keys(humanChoices).find(
          (k) => item.id.includes(k) || String(item.title ?? "").includes(k) || payloadStr.includes(k),
        );
        const spec = (matchedKey ? humanChoices[matchedKey] : humanChoices["*"]) ?? {};
        if (opts.length > 0) {
          const byLabel = spec.choice ? opts.find((o) => o.label === spec.choice || o.id === spec.choice) : opts[0];
          harness.behavior.submitInteraction(item.id, { choice: byLabel?.id ?? "1", text: spec.text ?? "" });
        } else {
          harness.behavior.submitInteraction(item.id, { text: spec.text ?? "logs and crawl ready" });
        }
      }
      const cur = engine.get(started.runId);
      if (cur && ["succeeded", "failed", "blocked", "cancelled"].includes(cur.status)) break;
      await new Promise((r) => setTimeout(r, 15));
    }

    await engine.idle();
    const finalRun = engine.get(started.runId)!;
    const snapshot = engine.snapshot(started.runId)!;
    if (finalRun.status !== "succeeded") {
      const badSteps = snapshot.steps
        .filter((s) => s.state === "failed" || s.state === "interrupted")
        .map((s) => `${s.node_id}(${s.state})`);
      throw new Error(`Workflow ${workflowId} ended ${finalRun.status} (${finalRun.reason ?? ""} / ${finalRun.error ?? ""}) — steps: ${badSteps.join(" | ")}`);
    }
    return { runId: started.runId, summary: finalRun, snapshot, answeredFormsCount: answeredForms.size };
  };

  const writeCheckoutJson = (relPath: string, data: unknown, commit = false) => {
    const full = join(checkout, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(data, null, 2), "utf8");
    if (commit) {
      git("add", relPath);
      git("commit", "-q", "-m", `seed ${relPath}`);
    }
    return relPath;
  };

  return {
    bb,
    harness,
    db,
    engine,
    store,
    checkout,
    projectId: PROJECT,
    spawned,
    writes,
    dispatchedWriters,
    savedSchedules,
    backlogScans,
    ctx,
    services,
    rt,
    runWorkflowLive,
    writeCheckoutJson,
    dispose: () => harness.lifecycle.dispose(),
  };
}
