import { spawn } from "node:child_process";
import type { NodeForm } from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";
import { BudgetStopError, createStepBudgetGuard, holdStepForUnknownCost, stopRunChildren } from "./budgets";
import type { Compiled } from "./compiled";
import { isEngineBug } from "./engine-errors";
import { MissingValueError, evalCondition, toExpr } from "./expr";
import type { EvalEnv, Ref } from "./expr";
import type { RunRow, StepRow } from "./journal";
import { outputFields } from "./lower";
import { formChainOf, formatFallbackChain, normalizeVerifyExpr } from "./node-form";
import type { ScriptConfig, VerifyObject } from "./node-form";
import { buildStepFactColumns, stepHadAgentCall } from "./run-facts";
import type { Field, GraphNode as WorkflowNode } from "./schema";
import { checkStepOutput } from "./step-output";
import type { NodeExecutor, StepContext, StepOutcome } from "./step-types";
import { addSpend, receiptUsage } from "./usage";
import type { Usage } from "./usage";
import type { WorkflowEngine } from "./engine";

const MAX_COMMAND_OUTPUT = 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class FormSkipError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type FormAttemptMetadata = {
  formUsed: NodeForm | null;
  fallbackTaken: string | null;
  environmentFingerprint: string | null;
};

export type FormAttemptResult = FormAttemptMetadata & {
  outcome: StepOutcome;
  heldForOwner?: boolean;
};

/** Computes a deterministic SHA-256 fingerprint for the script execution environment. */
export function computeEnvironmentFingerprint(input: {
  nodeVersion?: string;
  platform?: string;
  arch?: string;
  hostId?: string;
  repoHash?: string;
  tools?: Record<string, string>;
} = {}): string {
  const payload = {
    nodeVersion: input.nodeVersion ?? process.version,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    ...(input.hostId ? { hostId: input.hostId } : {}),
    ...(input.repoHash ? { repoHash: input.repoHash } : {}),
    ...(input.tools ? { tools: Object.fromEntries(Object.entries(input.tools).sort(([a], [b]) => a.localeCompare(b))) } : {}),
  };
  return sha256Hex(JSON.stringify(payload)).slice(0, 24);
}

/** Resolves the current environment fingerprint using `EngineOptions.environmentFingerprint` or the local runtime. */
export async function resolveEnvironmentFingerprint(
  engine: WorkflowEngine,
  run: RunRow,
  step: StepRow,
  node: WorkflowNode,
): Promise<string> {
  const provider = engine.options.environmentFingerprint;
  if (typeof provider === "string") return provider;
  if (typeof provider === "function") {
    const cwd = node.type === "agent" ? node.script?.cwd : undefined;
    return await provider({ run, step, node, ...(cwd ? { cwd } : {}) });
  }
  return computeEnvironmentFingerprint();
}

function runCommandProcess(
  ctx: Pick<StepContext, "signal" | "trackChild">,
  spec: { cmd?: string; args?: readonly string[]; command?: string; cwd?: string; timeoutSec?: number; env?: Record<string, string>; stdin?: string },
): Promise<{ stdout: string; stderr: string }> {
  const executable = spec.cmd ?? (process.platform === "win32" ? "cmd" : "/bin/sh");
  const argv = spec.cmd
    ? [...(spec.args ?? [])]
    : process.platform === "win32"
      ? ["/c", spec.command ?? ""]
      : ["-c", spec.command ?? ""];

  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd: spec.cwd || undefined,
      env: { ...process.env, ...spec.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const untrack = child.pid ? ctx.trackChild?.({ pid: child.pid }) : undefined;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      untrack?.();
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };

    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      finish(new Error("aborted"));
    };
    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const timeoutMs = (spec.timeoutSec ?? 60) * 1000;
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish(new Error(`script timeout after ${spec.timeoutSec ?? 60}s`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`script exited with code ${code ?? "null"}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`));
    });

    if (spec.stdin !== undefined) child.stdin?.write(spec.stdin);
    child.stdin?.end();
  });
}

function parseScriptStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) return parsed;
  } catch { /* fall back to trailing JSON line or raw stdout */ }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[i]!);
      if (isRecord(parsed)) return parsed;
    } catch { /* keep scanning */ }
  }
  return { stdout: trimmed };
}

/** Runs a stored, parameterised script command and parses its JSON output. */
export async function runScriptCommand(ctx: StepContext, script: ScriptConfig | undefined): Promise<{ output: Record<string, unknown> }> {
  if (!script || (!script.cmd && !script.command)) {
    throw new MissingValueError("script_missing", `${ctx.nodeId}: no script command configured`);
  }
  const renderedParams = {
    ...ctx.input.with,
    ...(script.params ? (ctx.template(script.params) as Record<string, unknown>) : {}),
  };
  const cmd = script.cmd ? ctx.render(script.cmd) : undefined;
  const args = script.args ? script.args.map((arg) => ctx.render(arg)) : undefined;
  const command = script.command ? ctx.render(script.command) : undefined;
  const cwd = script.cwd ? ctx.render(script.cwd) : undefined;
  const stdinJson = Object.keys(renderedParams).length ? JSON.stringify(renderedParams) : undefined;
  const { stdout } = await runCommandProcess(ctx, {
    ...(cmd ? { cmd } : {}),
    ...(args ? { args } : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    timeoutSec: script.timeoutSec ?? ctx.node.timeoutSec ?? 60,
    env: {
      LP_RUN_ID: ctx.runId,
      LP_NODE_ID: ctx.nodeId,
      LP_SCRIPT_PARAMS: stdinJson ?? "{}",
    },
    ...(stdinJson !== undefined ? { stdin: stdinJson } : {}),
  });
  return { output: parseScriptStdout(stdout) };
}

const readPath = (value: unknown, path: readonly string[]): unknown => {
  let cur = value;
  for (const part of path) {
    if (part === "length" && (Array.isArray(cur) || typeof cur === "string")) { cur = cur.length; continue; }
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
};

/** Executes a node's mechanical `verify` check (`expr`, `requiredFields`, or `cmd`/`command`). */
export async function runVerifyCheck(
  node: Extract<WorkflowNode, { type: "agent" }>,
  output: Record<string, unknown>,
  ctx: StepContext,
): Promise<void> {
  const verify = node.verify;
  if (verify === undefined) return;

  const knownNodeIds = new Set(ctx.workflow.nodes.map((n) => n.id));
  const ownFields = outputFields(ctx.workflow, node);
  const fieldNames = new Set(ownFields === "unknown" ? [] : (ownFields as Field[]).map((f) => f.name));
  const evalEnv: EvalEnv = {
    visits: () => 1,
    read: (ref: Ref) => {
      if (ref.kind === "node" && ref.node === node.id) {
        return { ran: true, value: readPath(output, ref.path) };
      }
      if (ref.kind === "input") {
        const key = ref.path[0];
        return key !== undefined ? { ran: true, value: readPath(ctx.inputs, ref.path) } : { ran: true, value: ctx.inputs };
      }
      if (ref.kind === "mode") return { ran: true, value: ctx.mode };
      if (ref.kind === "node" && ref.node) {
        const text = `${ref.node}${ref.path.length ? `.${ref.path.join(".")}` : ""}`;
        const val = ctx.resolve(text);
        return { ran: val !== undefined, value: val };
      }
      return { ran: false, value: undefined };
    },
  };

  const checkExprSpec = (spec: string | Parameters<typeof toExpr>[0]) => {
    const expr = normalizeVerifyExpr(toExpr(spec, node.id), node.id, fieldNames, knownNodeIds);
    if (!evalCondition(expr, evalEnv, `${node.id} verify`)) {
      throw new MissingValueError("verify_failed", `${node.id}: mechanical verify check failed`);
    }
  };

  if (typeof verify === "string" || (isRecord(verify) && ("field" in verify || "all" in verify || "any" in verify || "not" in verify))) {
    checkExprSpec(verify as string | Parameters<typeof toExpr>[0]);
    return;
  }

  const obj = verify as VerifyObject;
  for (const field of obj.requiredFields ?? []) {
    const val = output[field];
    if (val === undefined || val === null || val === "") {
      throw new MissingValueError("verify_failed", `${node.id}: verify required field "${field}" is missing or empty`);
    }
  }
  const exprs = obj.expr === undefined ? [] : Array.isArray(obj.expr) ? obj.expr : [obj.expr];
  for (const expr of exprs) checkExprSpec(expr);

  if (obj.cmd || obj.command) {
    const outputJson = JSON.stringify(output);
    await runCommandProcess(ctx, {
      ...(obj.cmd ? { cmd: ctx.render(obj.cmd) } : {}),
      ...(obj.args ? { args: obj.args.map((a) => ctx.render(a)) } : {}),
      ...(obj.command ? { command: ctx.render(obj.command) } : {}),
      ...(obj.cwd ? { cwd: ctx.render(obj.cwd) } : {}),
      timeoutSec: obj.timeoutSec ?? 60,
      env: { LP_RUN_ID: ctx.runId, LP_NODE_ID: node.id, LP_STEP_OUTPUT: outputJson },
      stdin: outputJson,
    }).catch((cause) => {
      throw new MissingValueError("verify_failed", `${node.id}: verify command failed (${cause instanceof Error ? cause.message : String(cause)})`);
    });
  }
}

function attachFormMeta(cause: unknown, meta: FormAttemptMetadata, usage?: Usage): Error {
  const err = cause instanceof Error ? cause : new Error(String(cause));
  Object.assign(err, { formMeta: meta, ...(usage ? { usage } : {}) });
  return err;
}

export function readFormErrorMeta(cause: unknown): FormAttemptMetadata | null {
  if (!cause || typeof cause !== "object") return null;
  const meta = (cause as { formMeta?: FormAttemptMetadata }).formMeta;
  return meta ?? null;
}

/** Runs one step attempt across its declared form chain (`script -> plan -> agent`), recording fallback and fingerprint facts. */
export async function runAttemptWithForm(
  engine: WorkflowEngine,
  run: RunRow,
  c: Compiled,
  step: StepRow,
  node: WorkflowNode,
  executor: NodeExecutor<any>,
  context: StepContext,
  attemptAbort: AbortController,
  stepStartedAt: number,
  spentBefore: Usage | undefined,
  runVotesFn: (engine: WorkflowEngine, executor: NodeExecutor<any>, ctx: StepContext, c: Compiled, node: WorkflowNode, votes: number) => Promise<StepOutcome>,
): Promise<FormAttemptResult> {
  const j = engine.journal;
  const receipt = (extra: Record<string, unknown>) => JSON.stringify({ executor: executorKeyOf(node), harnessVersion: engine.options.harnessVersion, engineCompat: engine.compat, ...extra });
  const holdUnknown = (
    usage: Usage | undefined,
    detail: unknown,
    threadId: string | null,
    meta: FormAttemptMetadata,
    reasonDetail: string,
  ): boolean => {
    const combined = addSpend(spentBefore, usage);
    const curRun = j.getRun(run.id)!;
    const curStep = j.getStep(run.id, step.step_key)!;
    const factCols = buildStepFactColumns(curRun, curStep, "succeeded", engine.now(), {
      usage: combined,
      nodeType: node.type,
      detail,
      threadId,
      ...meta,
    });
    return holdStepForUnknownCost(engine, j, curRun, curStep, node, combined, factCols, reasonDetail, {
      threadId,
      receiptJson: receipt({ reason: "unknown_cost", usage: receiptUsage(combined), ...meta }),
    });
  };

  if (node.type !== "agent") {
    const guard = createStepBudgetGuard(engine, run, c, node, stepStartedAt, spentBefore, () => {
      attemptAbort.abort();
      void stopRunChildren(engine, run.id, step.step_key);
    });
    const ctxWithGuard: StepContext = { ...context, checkTurn: (turn) => guard.recordTurn(turn) };
    let outcome: StepOutcome;
    try {
      outcome = await executor.run(ctxWithGuard);
    } catch (cause) {
      if (isEngineBug(cause)) throw cause;
      const turnSpent = (cause as { usage?: Usage } | null)?.usage ?? guard.lastUsage();
      if (turnSpent && typeof cause === "object" && cause !== null && !(cause as { usage?: Usage }).usage) {
        Object.assign(cause, { usage: turnSpent });
      }
      const stopped = guard.stopped() ?? (cause instanceof BudgetStopError ? cause.decision : null);
      if (stopped && !(cause instanceof BudgetStopError)) throw new BudgetStopError(stopped, turnSpent);
      throw cause;
    }
    const stopped = guard.stopped();
    if (stopped) throw new BudgetStopError(stopped, outcome.usage ?? guard.lastUsage());
    if (!("wait" in outcome)) {
      const hadAgent = stepHadAgentCall("succeeded", {
        nodeType: node.type, usage: outcome.usage, output: outcome.output, detail: outcome.detail, threadId: outcome.threadId ?? null,
      });
      const post = guard.checkCompleted(outcome.usage, hadAgent);
      if (post.stop) {
        if (post.reason === "unknown_cost") {
          const held = holdUnknown(outcome.usage, outcome.detail, outcome.threadId ?? null, { formUsed: null, fallbackTaken: null, environmentFingerprint: null }, post.detail);
          return { outcome, formUsed: null, fallbackTaken: null, environmentFingerprint: null, heldForOwner: held };
        }
        throw new BudgetStopError(post, outcome.usage);
      }
      outcome = { ...outcome, output: checkStepOutput(node, outputFields(c.wf, node), outcome.output) };
    }
    return { outcome, formUsed: null, fallbackTaken: null, environmentFingerprint: null };
  }

  const chain = formChainOf(node);
  const attempted: NodeForm[] = [chain[0]!];
  let priorFormUsage: Usage | undefined;
  let observedFingerprint: string | null = null;

  for (let idx = 0; idx < chain.length; idx += 1) {
    const currentForm = chain[idx]!;
    const hasNext = idx + 1 < chain.length;
    engine.log(`wf.form node=${node.id} form=${currentForm}`, "info");

    const priorForGuard = addSpend(spentBefore, priorFormUsage);
    const guard = createStepBudgetGuard(engine, run, c, node, stepStartedAt, priorForGuard, () => {
      attemptAbort.abort();
      void stopRunChildren(engine, run.id, step.step_key);
    });
    const formContext: StepContext = { ...context, form: currentForm, checkTurn: (turn) => guard.recordTurn(turn) };
    const metaSoFar = (): FormAttemptMetadata => ({
      formUsed: currentForm,
      fallbackTaken: formatFallbackChain(attempted),
      environmentFingerprint: observedFingerprint,
    });

    try {
      if (currentForm === "script") {
        const actualFp = await resolveEnvironmentFingerprint(engine, run, step, node);
        observedFingerprint = actualFp;
        const expectedFp = node.script?.fingerprint;
        if (expectedFp && actualFp !== expectedFp) {
          engine.log(`fingerprint mismatch node=${node.id} expected=${expectedFp} actual=${actualFp} -> script skipped`, "warn");
          throw new FormSkipError("fingerprint_mismatch", `fingerprint mismatch: expected ${expectedFp}, got ${actualFp}`);
        }
        const scriptExec = engine.executors.get("builtin:script");
        if (!scriptExec) throw new Error("builtin:script executor is not registered");
        const raw = await scriptExec.run(formContext);
        const stopped = guard.stopped();
        if (stopped) throw new BudgetStopError(stopped, addSpend(priorFormUsage, raw.usage) ?? guard.lastUsage());
        const combinedUsage = addSpend(priorFormUsage, raw.usage);
        if ("wait" in raw) {
          return { outcome: combinedUsage ? { ...raw, usage: combinedUsage } : raw, ...metaSoFar() };
        }
        const hadAgent = stepHadAgentCall("succeeded", {
          nodeType: node.type, usage: combinedUsage, output: raw.output, detail: raw.detail, threadId: raw.threadId ?? null, formUsed: "script",
        });
        const post = guard.checkCompleted(raw.usage, hadAgent);
        if (post.stop) {
          if (post.reason === "unknown_cost") {
            const held = holdUnknown(combinedUsage, raw.detail, raw.threadId ?? null, metaSoFar(), post.detail);
            return { outcome: raw, ...metaSoFar(), heldForOwner: held };
          }
          throw new BudgetStopError(post, combinedUsage);
        }
        const rawOut = !node.out.some((f) => f.name === "handoff") && raw.output.handoff === undefined
          ? { ...raw.output, handoff: `script:${node.id}` }
          : raw.output;
        const checked = checkStepOutput(node, outputFields(c.wf, node), rawOut);
        await runVerifyCheck(node, checked, formContext);
        return {
          outcome: { ...raw, output: checked, ...(combinedUsage ? { usage: combinedUsage } : {}) },
          ...metaSoFar(),
        };
      }

      const votes = node.votes ?? 1;
      const raw = await (votes > 1 ? runVotesFn(engine, executor, formContext, c, node, votes) : executor.run(formContext));
      const stopped = guard.stopped();
      if (stopped) throw new BudgetStopError(stopped, addSpend(priorFormUsage, raw.usage) ?? guard.lastUsage());
      const combinedUsage = addSpend(priorFormUsage, raw.usage);
      if ("wait" in raw) {
        return { outcome: combinedUsage ? { ...raw, usage: combinedUsage } : raw, ...metaSoFar() };
      }
      const hadAgent = stepHadAgentCall("succeeded", {
        nodeType: node.type, usage: combinedUsage, output: raw.output, detail: raw.detail, threadId: raw.threadId ?? null, formUsed: currentForm,
      });
      const post = guard.checkCompleted(raw.usage, hadAgent);
      if (post.stop) {
        if (post.reason === "unknown_cost") {
          const held = holdUnknown(combinedUsage, raw.detail, raw.threadId ?? null, metaSoFar(), post.detail);
          return { outcome: raw, ...metaSoFar(), heldForOwner: held };
        }
        throw new BudgetStopError(post, combinedUsage);
      }
      const checked = checkStepOutput(node, outputFields(c.wf, node), raw.output);
      if (node.verify !== undefined) await runVerifyCheck(node, checked, formContext);
      return {
        outcome: { ...raw, output: checked, ...(combinedUsage ? { usage: combinedUsage } : {}) },
        ...metaSoFar(),
      };
    } catch (cause) {
      if (isEngineBug(cause)) throw cause;
      const turnSpent = (cause as { usage?: Usage } | null)?.usage ?? guard.lastUsage();
      priorFormUsage = addSpend(priorFormUsage, turnSpent);
      const stopped = guard.stopped() ?? (cause instanceof BudgetStopError ? cause.decision : null);
      if (stopped) {
        const stopErr = cause instanceof BudgetStopError ? cause : new BudgetStopError(stopped, priorFormUsage);
        throw attachFormMeta(stopErr, metaSoFar(), priorFormUsage);
      }
      if (context.signal.aborted || engine.stopped()) {
        throw attachFormMeta(cause, metaSoFar(), priorFormUsage);
      }
      if (hasNext) {
        const nextForm = chain[idx + 1]!;
        const reason = cause instanceof FormSkipError ? cause.code : (cause instanceof Error ? cause.message : String(cause)).slice(0, 200);
        engine.log(`fallback node=${node.id} from=${currentForm} to=${nextForm} reason=${reason}`, "warn");
        attempted.push(nextForm);
        continue;
      }
      throw attachFormMeta(cause, metaSoFar(), priorFormUsage);
    }
  }
  throw new Error(`node ${node.id}: exhausted form chain`);
}

function executorKeyOf(node: WorkflowNode): string | null {
  switch (node.type) {
    case "parallel": return "builtin:parallel";
    case "join": return node.uses ?? "builtin:join";
    case "subworkflow": return "builtin:subworkflow";
    case "decision": return node.uses ?? (node.reads_node ? "builtin:decision" : null);
    case "human": return node.uses ?? "builtin:human";
    case "agent": return node.uses ?? "agent";
    case "lp-task": return node.uses ?? "lp-task";
    case "action": return node.action === "emit" ? (node.uses ?? "builtin:emit") : node.uses ?? node.action ?? null;
  }
}
