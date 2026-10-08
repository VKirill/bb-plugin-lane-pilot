import { createHash } from "node:crypto";
import type { TaskV2 } from "../contracts";
import { getAttempt, getRun, getRunWriterHost, listAttemptsForTask, listOpenAttempts } from "../database";
import { redactKnown } from "../redact";
import { validateTaskV2 } from "../task-v2";
import { agentPrompt, outputContract, parseAgentOutput } from "../workflow/agent-output";
import type { NodeExecutor, PollResult, StepContext, WorkflowEngine } from "../workflow/engine";
import type { RunRow } from "../workflow/journal";
import { outputFields } from "../workflow/lower";
import type { Field, GraphNode } from "../workflow/schema";
import { createTaskLinter } from "./lint-task";
import { agentRequest, createWorkflowAgents, withResolvedModel } from "./workflow-agent";
import type { WorkflowAgents } from "./workflow-agent";
import { lpTaskPipelineExecutor } from "./writer/dispatch-workflow";
import type { DispatchRuntime } from "./writer/dispatch-workflow";
import { keyedSpawnSupported } from "./thread-keys";
import { threadUsage } from "./token-usage";
import { stringAt } from "./values";
import type { ChainRuntime } from "./workflow-runtime";
import type { ServerCore } from "./core";
import type { Services } from "./services";

/**
 * The executors that run a chain on the host: the generic agent step, the owner's question, the code task of a chain, the actions
 * that read the plugin's own state or the PM's checkout, and the actions that go through a helper thread (a skill, an MCP tool, the
 * owner's accounts) the way errands do. The pure ones (dedupe, the verdict thresholds, the citation check) are in workflow/actions.ts.
 */
type Row = Record<string, unknown>;
const rec = (value: unknown): Row => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The runtime of a chain run rebuilt from its row after a reload; undefined for the per-task pipeline, which needs its own in-memory runtime. */
export function chainRuntimeFor(ctx: ServerCore, services: Services) {
  return (run: RunRow): ChainRuntime | undefined => {
    if (run.workflow_id === "lp-task-pipeline" || run.idem_key?.startsWith("lp-task:")) return undefined;
    if (!run.project_id || !run.link_run_id) return undefined;
    const linked = getRun(ctx.db, run.link_run_id);
    if (!linked?.pm_thread_id) return undefined;
    return { ctx, services, pmThreadId: linked.pm_thread_id, projectId: run.project_id, runId: run.link_run_id };
  };
}

const need = (c: StepContext<ChainRuntime>): ChainRuntime => {
  if (!c.runtime) throw new Error("this workflow run has no PM chat to work in (its run was closed or the plugin lost it); start it again");
  return c.runtime;
};

/** The PM's checkout: where a chain writes its reports and reads its diffs. */
async function pmCheckout(rt: ChainRuntime): Promise<{ hostId: string; path: string }> {
  const { bb } = rt.ctx;
  const pm = await bb.sdk.threads.get({ threadId: rt.pmThreadId });
  const environmentId = stringAt(pm, "environmentId");
  const env = environmentId ? await bb.sdk.environments.get({ environmentId }).catch(() => null) : null;
  const path = stringAt(env, "path"), hostId = stringAt(env, "hostId");
  if (!path || !hostId) throw new Error("the PM chat has no checkout to work in");
  return { hostId, path };
}

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
const PRUNE = /(^|\/)(node_modules|vendor|dist|build)\/|\.lock$|\.min\.[a-z]+$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

// ---------------------------------------------------------------- the owner's question

/** The enum values that carry words, not a decision: a free answer may stand for one of them, never for approve/deploy/send/proceed. */
const TEXT_KINDS = ["text", "answered", "provide", "given", "reason", "chosen", "resolved"];

/** What the form offers: the values of the node's `answer_kind` that a person can pick (not the clock's `timeout`, not the skip markers). */
export function humanOptions(node: Extract<GraphNode, { type: "human" }>): string[] {
  const kind = node.out.find((field) => field.name === "answer_kind");
  return (kind?.values ?? node.options).filter((value) => !["timeout", "none", "given"].includes(value));
}

const normalizeChoice = (text: string) => text.toLowerCase().replace(/[_\-\s]+/g, " ").replace(/^[\s.,;:!?'"«»()]+|[\s.,;:!?'"«»()]+$/g, "");

/** The 1-based option a typed answer names outright (the option's own words, or its number); never a guess from the wording around it. */
function namedOption(options: string[], text: string): number | null {
  const said = normalizeChoice(text);
  if (!said) return null;
  const byName = options.findIndex((value) => normalizeChoice(value) === said);
  if (byName >= 0) return byName + 1;
  const byNumber = /^(?:option|choice|вариант|№|#)?\s*(\d{1,2})$/.exec(said);
  const number = byNumber ? Number(byNumber[1]) : 0;
  return number >= 1 && number <= options.length ? number : null;
}

/** The node's output with `answer_kind` set to `kind` and the words as `answer`; the other fields empty. */
export function humanFields(node: Extract<GraphNode, { type: "human" }>, kind: string | undefined, text: string): Row {
  const out: Row = {};
  for (const field of node.out) {
    if (field.name === "answer_kind") { if (kind !== undefined) out.answer_kind = kind; continue; }
    if (field.name === "answer") { out.answer = text; continue; }
    out[field.name] = field.type === "array" ? (text && node.out.filter((other) => other.type === "array").length === 1 ? [{ answer: text }] : []) : field.type === "number" ? 0 : field.type === "boolean" ? false : field.type === "object" ? {} : field.type === "enum" ? field.values![0] : "";
  }
  return out;
}

/**
 * The node's output from the owner's answer: the chosen value as `answer_kind`, the words as `answer`, the other fields empty.
 * Words alone make a choice only when they name an option; otherwise they are a text answer if the node has a text kind.
 * Null when the answer decides nothing (an approval answered with a remark): the step keeps waiting and the owner is asked again.
 */
export function humanOutput(node: Extract<GraphNode, { type: "human" }>, answer: { choiceIndex: number | null; text: string }): Row | null {
  const options = humanOptions(node);
  const values = node.out.find((field) => field.name === "answer_kind")?.values ?? [];
  const index = answer.choiceIndex ?? (answer.text ? namedOption(options, answer.text) : null);
  const chosen = index !== null ? options[index - 1] : undefined;
  if (chosen !== undefined) return humanFields(node, chosen, answer.text);
  if (!answer.text) return options.length ? null : humanFields(node, undefined, "");
  const kind = TEXT_KINDS.find((value) => values.includes(value));
  return kind !== undefined || !values.length ? humanFields(node, kind, answer.text) : null;
}

// ---------------------------------------------------------------- code tasks of a chain

const TERMINAL_ATTEMPT = ["accepted", "blocked", "canceled"];
const safeId = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

type HelperUsage = { tokens: number; costUsd: number; unknown?: true };
type LpTaskNode = Extract<GraphNode, { type: "lp-task" }>;

export function registerChainExecutors(engine: WorkflowEngine, ctx: ServerCore, services: Services, agents: WorkflowAgents = createWorkflowAgents()): void {
  const { bb, db, host } = ctx;
  const lintTask = createTaskLinter(ctx, services);
  const rebuild = chainRuntimeFor(ctx, services);
  const runtimeOf = (c: { runtime: unknown }, runId?: string): ChainRuntime | undefined => {
    if (c.runtime) return c.runtime as ChainRuntime;
    const row = runId ? engine.journal.getRun(runId) : undefined;
    return row ? rebuild(row) : undefined;
  };

  // ---------------------------------------------------------------- agent
  engine.register<ChainRuntime>("agent", {
    // A re-run after a reload is safe only when the spawn is idempotent (the VK thread keys); else the step is interrupted instead.
    get reentrant() { return keyedSpawnSupported(bb); },
    run: async (c) => {
      need(c);
      const result = await agents.run(await withResolvedModel(agentRequest(c, c.node as Extract<GraphNode, { type: "agent" }>)));
      return { output: result.output, threadId: result.threadId, ...(result.usage ? { usage: result.usage } : {}) };
    },
  } as NodeExecutor<ChainRuntime>);

  // ---------------------------------------------------------------- human: the owner's question as a BB form
  const openForms = new Set<string>();
  const ask = async (rt: ChainRuntime, runId: string, stepKey: string, node: Extract<GraphNode, { type: "human" }>, question: string, deadline?: number): Promise<void> => {
    const key = `${runId}|${stepKey}`;
    if (openForms.has(key)) return;
    const options = humanOptions(node);
    const shown = await rt.ctx.ownerAsk.askInBackground(rt.pmThreadId, { source: "pm", question, detail: `Workflow run ${runId}, step ${node.id}.`, options: options.map((value) => value.replace(/_/g, " ")), allowText: true },
      async (answer) => {
        openForms.delete(key);
        if (answer.outcome === "answered") {
          const output = humanOutput(node, { choiceIndex: answer.choice ? Number(answer.choice.id) : null, text: answer.text });
          // Words that name no option and fit no text kind decide nothing: the step keeps waiting and the owner is asked again, with the options listed.
          if (!output) { await ask(rt, runId, stepKey, node, `Your answer did not choose an option (${options.map((value) => value.replace(/_/g, " ")).join(" / ")}). ${question}`, deadline); return; }
          // The form opens while the step is being recorded as waiting: an answer that arrives first is retried until the step can take it.
          for (let tries = 0; tries < 50; tries += 1) {
            if (await engine.resolve(runId, stepKey, output)) return;
            const state = engine.journal.getStep(runId, stepKey)?.state;
            if (state !== "running" && state !== "waiting" && state !== "pending") return;
            if (state !== "waiting") await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        // A dismissed or timed-out form leaves the step waiting: the next poll asks again, or the step's own timeout answers it.
      }, { timeoutMs: deadline ? Math.max(1000, deadline - Date.now()) : undefined });
    if (shown) openForms.add(key);
  };
  engine.register<ChainRuntime>("builtin:human", {
    run: async (c) => {
      const node = c.node as Extract<GraphNode, { type: "human" }>;
      const question = c.render(node.question);
      const deadline = node.timeoutSec ? Date.now() + node.timeoutSec * 1000 : undefined;
      const rt = runtimeOf(c, c.runId);
      if (rt) void ask(rt, c.runId, c.stepKey, node, question, deadline).catch((cause) => bb.log.warn(`Lane Pilot could not ask the owner (${node.id}): ${cause instanceof Error ? cause.message : String(cause)}`));
      return { wait: { kind: "human", detail: { question, options: humanOptions(node) }, ...(deadline ? { deadline } : {}) } };
    },
    poll: async (step, { node, runtime }): Promise<PollResult> => {
      const human = node as Extract<GraphNode, { type: "human" }>;
      if (step.await.deadline && Date.now() >= step.await.deadline) {
        // A question whose answer kinds include `timeout` is answered by the clock; otherwise onTimeout says.
        const kind = human.out.find((field) => field.name === "answer_kind");
        if (kind?.values?.includes("timeout")) return { output: humanFields(human, "timeout", "") };
        if (human.onTimeout === "default" && human.defaultOption) {
          const field = human.out.find((candidate) => candidate.type === "string" || candidate.type === "enum");
          return { output: field ? { [field.name]: human.defaultOption } : {} };
        }
        return { error: "human_timeout" };
      }
      // After a reload the form is gone with the old instance: ask again.
      const rt = runtimeOf({ runtime }, step.runId);
      const detail = step.await.detail as { question?: string } | undefined;
      if (rt && detail?.question) await ask(rt, step.runId, step.stepKey, human, detail.question, step.await.deadline);
      return null;
    },
  } as NodeExecutor<ChainRuntime>);

  // ---------------------------------------------------------------- lp-task: one code task through the writer pipeline
  const pipeline = lpTaskPipelineExecutor(engine);
  const chainTask: NodeExecutor<ChainRuntime> = {
    reentrant: true,
    run: async (c) => {
      const rt = need(c);
      const node = c.node as LpTaskNode;
      const { contract, usage: planned } = await contractOf(c, rt, node);
      const run = getRun(db, rt.runId);
      if (!run?.writer_workspace_path) throw new Error("the run has no workspace to build in");
      const stem = createHash("sha256").update(`${c.runId}|${c.stepKey}`).digest("hex").slice(0, 8);
      const task = { ...contract, id: `w${stem}-${safeId(str(contract.id) || node.id)}`, project_cwd: run.writer_workspace_path, ...(node.quality_mode && node.quality_mode !== "{{$mode}}" ? { quality_mode: node.quality_mode } : { quality_mode: c.mode }) };
      const valid = validateTaskV2(task);
      if (!valid.ok) return { output: failedTask("failed", `task-v2 invalid: ${valid.errors.join("; ")}`) };
      const hostId = getRunWriterHost(db, rt.runId) ?? "";
      const lint = await lintTask(rt.projectId, rt.runId, valid.task, run.writer_workspace_path, hostId).catch(() => null);
      if (lint?.errors.length) return { output: failedTask("failed", `contract lint: ${lint.errors.map((error) => error.message).join("; ").slice(0, 600)}`) };
      const reply = await services.dispatchWriter({ threadId: rt.pmThreadId, projectId: rt.projectId, task: valid.task, plan: valid.task.objective });
      if (reply.state === "rejected") return { output: failedTask("blocked", String(reply.reason ?? "the dispatch was rejected")) };
      const taskId = str(reply.taskId) || valid.task.id;
      return { wait: { kind: "attempt", detail: { runId: str(reply.runId) || rt.runId, taskId, files: valid.task.owns_paths } }, ...(planned ? { usage: planned } : {}) };
    },
    poll: async (step): Promise<PollResult> => {
      const detail = step.await.detail as { runId: string; taskId: string } | undefined;
      if (!detail) return { error: "the waiting step does not say which task it waits for" };
      const listed = listAttemptsForTask(db, detail.runId, detail.taskId);
      const latest = listed.at(-1) ? getAttempt(db, listed.at(-1)!.id) : null;
      if (!latest || !TERMINAL_ATTEMPT.includes(latest.state)) return null;
      const reason = latest.reason ?? "";
      const state = latest.state === "accepted" ? "accepted" : latest.state === "canceled" ? "cancelled" : /needs[_ -]?human/i.test(reason) ? "needs_human" : "blocked";
      const rt = runtimeOf({ runtime: undefined }, step.runId);
      const merge = state === "accepted" && rt ? await mergeFacts(rt, latest.id) : { commit: "", files: [] as string[] };
      // What the writer attempts of this task spent: the threads of every attempt, read once, when the task is over.
      const threads = [...new Set(listed.map((row) => getAttempt(db, row.id)?.thread_id).filter((id): id is string => Boolean(id)))];
      const spent = await Promise.all(threads.map((threadId) => threadUsage(bb, threadId)));
      const usage: HelperUsage = { tokens: spent.reduce((sum, row) => sum + row.tokens, 0), costUsd: spent.reduce((sum, row) => sum + row.costUsd, 0),
        ...(spent.some((row) => !row.known || row.unknown) ? { unknown: true as const } : {}) };
      return { output: { state, attempts: listed.length, merge_commit: merge.commit, files: merge.files,
        verdict: { status: state === "accepted" ? "pass" : "rework", summary: reason, findings: [], evidence: reason || state } }, usage };
    },
  };
  const failedTask = (state: string, reason: string): Row => ({ state, attempts: 0, merge_commit: "", files: [], verdict: { status: "rework", summary: reason, findings: [], evidence: reason } });

  /** The task contract of an lp-task node: the `contract` as rendered, or one written from `contract_template` and the step's data by a planner helper. */
  async function contractOf(c: StepContext<ChainRuntime>, rt: ChainRuntime, node: LpTaskNode): Promise<{ contract: Row; usage?: HelperUsage }> {
    if (node.contract !== undefined) {
      const rendered = c.template(node.contract);
      const value = typeof rendered === "string" ? (() => { try { return JSON.parse(rendered) as unknown; } catch { return rendered; } })() : rendered;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return { contract: value as Row };
      throw new Error(`the contract of ${node.id} is not an object (got ${typeof value})`);
    }
    const template = typeof node.contract_template === "string" ? node.contract_template : JSON.stringify(node.contract_template ?? {});
    const fields = taskContractFields();
    const result = await agents.run({
      rt, workflowRunId: c.runId, stepKey: c.stepKey, nodeId: node.id, spawnKey: c.spawnKey, role: "planner", title: `contract for ${node.id}`, fields, signal: c.signal,
      prompt: agentPrompt({ workflow: c.workflow.id, node: node.id, title: `contract for ${node.id}`, role: "planner", mode: c.mode, task: `Write ONE task-v2 contract for a writer from this template and the run's artifacts. Template: ${template}\nThe repository paths come from the artifacts in the run's folder; use only real paths. Put the whole contract object in the field \`contract\`.`, inputs: c.input.with, contract: outputContract(fields), readOnly: true }),
    });
    return { contract: rec(result.output.contract), ...(result.usage ? { usage: result.usage } : {}) };
  }

  /** The merge commit of an accepted attempt (found by the trailer every merge commit carries) and the files it changed. */
  async function mergeFacts(rt: ChainRuntime, attemptId: string): Promise<{ commit: string; files: string[] }> {
    const run = getRun(db, rt.runId);
    const hostId = getRunWriterHost(db, rt.runId);
    if (!run?.writer_workspace_path || !hostId) return { commit: "", files: [] };
    const ran = await host.call("runCommand", { requestedHostId: hostId, cwd: run.writer_workspace_path, timeoutSec: 30,
      command: `c=$(git log --all -1 --format=%H --grep=${quote(`Lane-Pilot-Attempt: ${attemptId}`)}) && echo "$c" && git show --name-only --format= "$c"` }, { hostId, timeoutMs: 45_000 }).catch(() => null);
    if (!ran || ran.exitCode !== 0) return { commit: "", files: [] };
    const [commit = "", ...files] = ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return { commit, files };
  }

  // One key serves the per-task pipeline (its runtime has an attempt) and the code tasks of a chain.
  engine.register<ChainRuntime | DispatchRuntime>("lp-task", {
    reentrant: true,
    run: (c) => ((c.runtime as { attemptId?: string } | undefined)?.attemptId !== undefined ? pipeline.run(c as StepContext<DispatchRuntime>) : chainTask.run(c as StepContext<ChainRuntime>)),
    // A step of the per-task pipeline waits on an attempt it started itself (its detail names the attempt); a chain's code task waits on a dispatched task.
    poll: (step, extra) => (step.await.detail && "attemptId" in (step.await.detail as object)
      ? pipeline.poll!(step, extra as { runtime: DispatchRuntime | undefined; node: GraphNode }) : chainTask.poll!(step, extra as { runtime: ChainRuntime | undefined; node: GraphNode })),
  } as NodeExecutor<ChainRuntime | DispatchRuntime>);

  // ---------------------------------------------------------------- actions on the plugin's own state and the PM's checkout
  const action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) =>
    engine.register<ChainRuntime>(key, { reentrant: true, run: async (c) => ({ output: await run(c, need(c)) }) } as NodeExecutor<ChainRuntime>);

  action("fs.write", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = node.params as Row;
    const checkout = await pmCheckout(rt);
    const rel = c.render(str(params.path)).replace(/^\/+/, "");
    if (!rel || rel.includes("..") || rel.includes("\0")) throw new Error(`fs.write: the path "${rel}" is not inside the checkout`);
    const isFolder = rel.endsWith("/");
    const write = async (path: string, content: string) => {
      await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${path}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
    };
    const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
    let first = rel;
    if (params.contents && typeof params.contents === "object") {
      for (const [name, template] of Object.entries(params.contents as Row)) { const value = c.template(template); await write(`${rel}${name}`, asText(value ?? "")); first = first === rel ? `${rel}${name}` : first; }
    } else if (!isFolder) {
      await write(rel, asText(reportBody(c, params)));
    }
    const out: Row = {};
    for (const field of c.node.out) {
      if (field.name === "folder") out.folder = isFolder ? rel : rel.slice(0, rel.lastIndexOf("/") + 1) || "./";
      else if (field.name === "handoff_path") out.handoff_path = isFolder ? `${rel}handoff.md` : rel;
      else if (field.name.endsWith("_path")) out[field.name] = isFolder && !params.contents ? rel : first;
    }
    return out;
  });

  /** A file the chain writes: JSON of what it `reads`, else a Markdown report of the run so far. */
  function reportBody(c: StepContext<ChainRuntime>, params: Row): unknown {
    const reads = list(rec(c.node).reads).map(String);
    if (reads.length) return Object.fromEntries(reads.map((ref) => [ref.split(".").pop()!, c.resolve(ref)]));
    const rows = c.workflow.nodes.filter((node) => node.type !== "note" && node.id !== c.nodeId).map((node) => [node.id, c.resolve(node.id)] as const).filter(([, value]) => value !== undefined && Object.keys(rec(value)).length);
    return [`# ${c.workflow.name.en}`, "", str(params.template) ? `Contents: ${str(params.template)}.` : "", ...rows.flatMap(([id, value]) => ["", `## ${id}`, "```json", JSON.stringify(value, null, 1).slice(0, 12_000), "```"])].join("\n");
  }

  action("git.diff_files", async (c, rt) => {
    const checkout = await pmCheckout(rt);
    const files = c.resolve("$inputs.files"), range = c.resolve("$inputs.range"), pr = str(c.resolve("$inputs.pr"));
    let names: string[] = [];
    if (Array.isArray(files) && files.length) names = files.map(String);
    else {
      const command = Array.isArray(range) && range.length ? `git show --name-only --format= ${range.map((commit) => quote(String(commit))).join(" ")}`
        : typeof range === "string" && range ? `git diff --name-only ${quote(range)}` : pr ? `gh pr diff ${quote(pr)} --name-only` : "";
      if (command) {
        const ran = await ctx.host.call("runCommand", { requestedHostId: checkout.hostId, cwd: checkout.path, command, timeoutSec: 60 }, { hostId: checkout.hostId, timeoutMs: 75_000 });
        if (ran.exitCode !== 0) throw new Error(`git.diff_files: ${ran.stderr.trim().slice(0, 300) || `exit ${ran.exitCode}`}`);
        names = [...new Set(ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
      }
    }
    const kept = names.filter((name) => !PRUNE.test(name));
    return { files: kept, count: kept.length, level: kept.length <= 3 ? "quick" : kept.length >= 20 ? "deep" : "standard" };
  });

  action("lp.state_probe", async (_c, rt) => {
    const checkout = await pmCheckout(rt).catch(() => null);
    let hasPassport = false, hasUi = false;
    if (checkout) {
      const ran = await ctx.host.call("runCommand", { requestedHostId: checkout.hostId, cwd: checkout.path, timeoutSec: 20,
        command: "ls .agents/PASSPORT.md .agents/passport.md PROJECT.md 2>/dev/null | head -1; echo ---; ls package.json src/ui app components 2>/dev/null | head -3" }, { hostId: checkout.hostId, timeoutMs: 30_000 }).catch(() => null);
      const [passport = "", ui = ""] = (ran?.stdout ?? "").split("---");
      hasPassport = passport.trim().length > 0; hasUi = /app|components|ui/.test(ui);
    }
    const open = listOpenAttempts(db).filter((row) => row.project_id === rt.projectId).length;
    return { has_passport: hasPassport, open_tasks: open, plan_exists: open > 0, has_ui: hasUi };
  });

  action("lp.run_status", async (c, rt) => {
    const runId = str(c.resolve("$inputs.run_id")) || rt.runId;
    const open = listOpenAttempts(db).filter((row) => row.run_id === runId);
    const tasks = db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{ id: string }>;
    const latest = tasks.map((task) => listAttemptsForTask(db, runId, task.id).at(-1)).filter(Boolean) as Array<{ state: string }>;
    const failed = latest.filter((attempt) => ["blocked", "canceled", "validation_failed"].includes(attempt.state)).length;
    return { open_tasks: tasks.length - latest.filter((attempt) => attempt.state === "accepted").length - failed, failed_tasks: failed, unmerged: 0, gate_ok: failed === 0, running_attempts: open.length, merged_commits: list(c.resolve("ctx.merged_commits")).map(String) };
  });

  // The integration gate keeps no receipt of its own (a red gate dispatches a repair task and tells the PM), so there is nothing to read here yet.
  action("lp.integration_gate_status", async () => ({ ok: true, failing: [], skipped: true }));

  action("lp.run_close", async (c, rt) => {
    const runId = str(c.resolve("$inputs.run_id")) || rt.runId;
    // The PM's run is closed by the PM chat's own lifecycle (closeAbandonedRuns); this marks the workflow's end and leaves the run to it.
    return { archived: Boolean(getRun(db, runId)) };
  });

  action("lp.lint_contract", async (c, rt) => {
    const tasks = list(c.resolve("plan.tasks"));
    const waves = list(c.resolve("plan.waves")).map((wave) => list(wave).map(String));
    const run = getRun(db, rt.runId);
    const hostId = getRunWriterHost(db, rt.runId) ?? "";
    const errors: string[] = [];
    const parsed: TaskV2[] = [];
    for (const [at, raw] of tasks.entries()) {
      const valid = validateTaskV2({ ...rec(raw), project_cwd: run?.writer_workspace_path ?? str(rec(raw).project_cwd) });
      if (!valid.ok) { errors.push(`task #${at + 1} (${str(rec(raw).id) || "no id"}): ${valid.errors.join("; ")}`); continue; }
      parsed.push(valid.task);
      if (run?.writer_workspace_path) {
        const lint = await lintTask(rt.projectId, rt.runId, valid.task, run.writer_workspace_path, hostId).catch(() => null);
        for (const error of lint?.errors ?? []) errors.push(`${valid.task.id}: ${error.message}`);
      }
    }
    // Tasks of one wave run together: their owned paths must not meet.
    const own = (task: TaskV2) => task.owns_paths.map((path) => path.replace(/\/?\*+.*$/, "").replace(/\/$/, ""));
    for (const wave of waves) {
      const members = parsed.filter((task) => wave.includes(task.id));
      for (const [i, a] of members.entries()) for (const b of members.slice(i + 1)) {
        const clash = own(a).find((x) => own(b).some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
        if (clash !== undefined) errors.push(`${a.id} and ${b.id} run in the same wave but both own ${clash || "the repository root"}`);
      }
    }
    if (!tasks.length) errors.push("the plan has no tasks");
    return { ok: errors.length === 0, errors };
  });

  // ---------------------------------------------------------------- actions that go through a helper thread (skills, MCP, accounts)
  const DELEGATED: Record<string, { role: string; skills: string[]; how: string }> = {
    "telegram.send_rich": { role: "errand", skills: ["telegram-user", "telegram-rich-messages"], how: "Send the markdown as a Telegram rich message from the owner's account to `target` with the telegram-user skill (`tg rich-send --execute`). The send has receipts: never repeat it blindly, and if the first attempt may have gone through, read the chat before you try again. Report the message id, its link and the status the receipt gives." },
    "shell.skill_script": { role: "errand", skills: [], how: "Run the named script of the named skill with the given args, from the skill's own folder, and report the fields below from what it printed. Do not run any other script." },
    "shell.repo_script": { role: "errand", skills: [], how: "Run the named script of the repository (and only it) with the args and env given, from the repository root, and report the fields below. A deploy script has its own gates: report them, never bypass them." },
    "deploy.post_check": { role: "errand", skills: ["browser-automation"], how: "Check that the deployment works as the rule says and report ok with details (what you ran and saw)." },
    "lp.preflight": { role: "errand", skills: [], how: "Check the repository state the rule lists with read-only commands and report each field as you found it. Change nothing." },
    "lp.project_checks": { role: "errand", skills: [], how: "Run the project's own check commands (its test script and linter, as the project documents them; the gate detection notes of the project if there are any) and report the counts. Change nothing." },
    "bb.tasks.get": { role: "errand", skills: [], how: "Read the BB Tasks card named by `ref` with the BB tasks tools you have and report the fields; found is false when there is no such card." },
    "bb.tasks.update": { role: "errand", skills: [], how: "Update the BB Tasks card named by `ref` with the values in `set`, with the BB tasks tools you have, and report the card's status after the update." },
    "bb.tasks.create": { role: "errand", skills: [], how: "Create BB Tasks cards from the findings (severity to priority as the mapping says); when dry_run is true create nothing and report the ids that would be created as an empty list." },
  };
  for (const [key, spec] of Object.entries(DELEGATED)) {
    engine.register<ChainRuntime>(key, {
      get reentrant() { return keyedSpawnSupported(bb); },
      run: async (c) => {
        const rt = need(c);
        const node = c.node as Extract<GraphNode, { type: "action" }>;
        const fields = outputFields(c.workflow, node) as Field[];
        const params = rec(c.template(node.params));
        const reads = Object.fromEntries(list(rec(node).reads).map(String).map((ref) => [ref, c.resolve(ref)]));
        const title = `${key}${node.title ? `: ${node.title.en}` : ""}`;
        const prompt = agentPrompt({ workflow: c.workflow.id, node: node.id, title, role: "errand", mode: c.mode, readOnly: key === "lp.preflight" || key === "bb.tasks.get",
          task: `${spec.how}\n\nAction: ${key}\nParameters: ${redactKnown(JSON.stringify(params))}`, inputs: { ...c.input.with, ...reads }, contract: outputContract(fields),
          skills: [...spec.skills, ...stringList(params.skill)] });
        const result = await agents.run(await withResolvedModel({ rt, workflowRunId: c.runId, workflowId: c.workflow.id, stepKey: c.stepKey, nodeId: node.id, spawnKey: c.spawnKey, role: spec.role, title, prompt, fields, ...(node.model_preset ? { preset: node.model_preset } : {}), skills: [...spec.skills, ...stringList(params.skill)], signal: c.signal }));
        return { output: result.output, threadId: result.threadId, ...(result.usage ? { usage: result.usage } : {}) };
      },
    } as NodeExecutor<ChainRuntime>);
  }
}

const stringList = (value: unknown): string[] => (typeof value === "string" && value ? [value] : []);
const taskContractFields = (): Field[] => [
  { name: "contract", type: "object", required: true, ref: "Task", description: "one task-v2 contract object (objective, read_first, owns_paths, never_touch, acceptance, verification ...)" },
  { name: "handoff", type: "string", required: true },
];
