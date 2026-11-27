import type { PluginCliResult } from "@get-bb/plugin-sdk";
import {
  PROVIDER_CAPABILITIES,
  ROLE_MODEL_OPTIONS,
  nativeProviderFamily,
  offeredOnHost,
  roleModelOption,
  validateChoice,
  type ModelCatalog,
} from "@lane-pilot/models";
import {
  definitionSha256,
  draftTestCaseFromReplay,
  isEvaluatorRole,
  loadWorkflowStore,
  recordWorkflowProof,
  replayCasesFromRuns,
  runDraftTest,
  testCasesOf,
  type DraftTestCase,
  type Workflow,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { CATALOG_WAIT_MS, modelCatalogOf, within } from "../../../platform/server";
import { HARNESS_VERSION, createStatusResolver, globalWorkflowDir } from "../../../storage";
import { BUILTIN_SOURCES } from "../../builtin";

export const WORKFLOW_PROVE_USAGE = "bb lane-pilot workflow prove <workflowId> --provider <p> --model <m> [--cases <n>]";

const KNOWN_PROVIDERS = new Set([
  ...Object.keys(PROVIDER_CAPABILITIES),
  ...ROLE_MODEL_OPTIONS.map((option) => option.providerId),
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type ProveWorkflowInput = {
  workflowId: string;
  provider: string;
  model: string;
  cases?: number;
  projectId?: string;
};

export type ProveWorkflowFailure = {
  caseId: string;
  reason: string;
};

export type ProveWorkflowResult = {
  ok: boolean;
  casesN: number;
  passedN: number;
  failures: ProveWorkflowFailure[];
  reason?: string;
};

export type ProveWorkflowDeps = {
  catalog?: ModelCatalog;
  hostId?: string | null;
  globalDir?: string;
  loadStore?: (projectId?: string) => Promise<WorkflowStore>;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  now?: () => number;
  timeoutMs?: number;
};

type ProveContext = Pick<ServerCore, "db" | "bb" | "log">;

function logInfo(ctx: ProveContext, message: string): void {
  const logger = ctx.bb?.log;
  if (logger?.info) logger.info(message);
  else ctx.log(message);
}

function logWarn(ctx: ProveContext, message: string): void {
  const logger = ctx.bb?.log;
  if (logger?.warn) logger.warn(message);
  else ctx.log(`WARN ${message}`);
}

function logDebug(ctx: ProveContext, message: string): void {
  const logger = ctx.bb?.log;
  if (logger?.debug) logger.debug(message);
}

function isCatalogChoiceValid(catalog: ModelCatalog, provider: string, model: string, hostId?: string | null): boolean {
  const effectiveCatalog = hostId !== undefined ? { ...catalog, runHostId: hostId } : catalog;
  if (!validateChoice(effectiveCatalog, { providerId: provider, model }).ok) return false;
  if (effectiveCatalog.runHostId && offeredOnHost(effectiveCatalog, provider, model, effectiveCatalog.runHostId) === false) {
    return false;
  }
  return true;
}

function isStaticChoiceValid(provider: string, model: string): boolean {
  if (!KNOWN_PROVIDERS.has(provider) && !provider.startsWith("acp-")) return false;
  if (nativeProviderFamily(provider) && roleModelOption(model)?.providerId !== provider) return false;
  return true;
}

function cloneWorkflowForModel(workflow: Workflow, provider: string, model: string): Workflow {
  const cloned = JSON.parse(JSON.stringify(workflow)) as Workflow;
  for (const node of cloned.nodes) {
    // Judges keep their own model so the evaluator stays frozen across candidate model proofs (R10).
    if (node.type === "agent" && !isEvaluatorRole(node.role)) {
      node.provider = provider;
      node.model = model;
    } else if (node.type === "parallel" && node.child?.type === "agent" && !isEvaluatorRole(node.child.role)) {
      node.child.provider = provider;
      node.child.model = model;
    }
  }
  return cloned;
}

function normalizeExtraTestCases(rawCases: unknown): DraftTestCase[] {
  if (!Array.isArray(rawCases)) return [];
  const out: DraftTestCase[] = [];
  for (let i = 0; i < rawCases.length; i += 1) {
    const entry = rawCases[i];
    if (!isRecord(entry)) continue;
    const stubsRaw = isRecord(entry.stubs) ? entry.stubs : {};
    const stubs: DraftTestCase["stubs"] = {};
    for (const [key, value] of Object.entries(stubsRaw)) {
      if (isRecord(value) || (Array.isArray(value) && value.every(isRecord))) {
        stubs[key] = value;
      }
    }
    const humanRaw = isRecord(entry.humanAnswers)
      ? entry.humanAnswers
      : isRecord(entry.human_answers)
        ? entry.human_answers
        : {};
    const expectPathRaw = Array.isArray(entry.expectPath)
      ? entry.expectPath
      : Array.isArray(entry.expect_path)
        ? entry.expect_path
        : undefined;
    const expectOutputRaw = isRecord(entry.expectOutput)
      ? entry.expectOutput
      : isRecord(entry.expect_output)
        ? entry.expect_output
        : undefined;
    const expectStatus = typeof entry.expectStatus === "string"
      ? entry.expectStatus
      : typeof entry.expect_status === "string"
        ? entry.expect_status
        : "succeeded";
    out.push({
      id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `case-${i + 1}`,
      input: isRecord(entry.input) ? entry.input : {},
      stubs,
      humanAnswers: humanRaw,
      expectStatus,
      ...(expectPathRaw ? { expectPath: expectPathRaw.filter((item): item is string => typeof item === "string") } : {}),
      ...(expectOutputRaw ? { expectOutput: expectOutputRaw } : {}),
      notChecked: Array.isArray(entry.notChecked)
        ? entry.notChecked.filter((item): item is string => typeof item === "string")
        : [],
    });
  }
  return out;
}

function authoredCasesOf(workflow: Workflow): DraftTestCase[] {
  const test = workflow.test as ({ id?: string; sim?: unknown; cases?: unknown } & Record<string, unknown>) | undefined;
  if (!test) return [];
  if (isRecord(test.sim)) return testCasesOf(workflow);
  if (Array.isArray(test.cases)) return normalizeExtraTestCases(test.cases);
  return [];
}

/**
 * Runs a workflow's test and replay cases on stubs with all non-judge agent nodes pinned to `provider`/`model`,
 * and records the proof outcome in `lane_pilot_wf_proof`.
 */
export async function proveWorkflow(
  ctx: ProveContext,
  deps: ProveWorkflowDeps,
  input: ProveWorkflowInput,
): Promise<ProveWorkflowResult> {
  const workflowId = input.workflowId.trim();
  const provider = input.provider.trim();
  const model = input.model.trim();
  const refuse = (reason: string): ProveWorkflowResult => {
    logWarn(ctx, `workflow prove refused wf=${workflowId || "unknown"}: ${reason}`);
    return { ok: false, casesN: 0, passedN: 0, failures: [], reason };
  };

  if (!provider || !model) return refuse("unknown_model");

  const catalog = deps.catalog
    ?? (ctx.bb?.sdk ? await within(modelCatalogOf(ctx).get(), CATALOG_WAIT_MS).catch(() => null) : null);

  if (catalog && (deps.catalog !== undefined || catalog.providers.length > 0)) {
    if (!isCatalogChoiceValid(catalog, provider, model, deps.hostId)) return refuse("unknown_model");
  } else if (!isStaticChoiceValid(provider, model)) {
    return refuse("unknown_model");
  }

  const store = deps.loadStore
    ? await deps.loadStore(input.projectId)
    : await loadWorkflowStore({
        builtin: BUILTIN_SOURCES,
        globalDir: deps.globalDir ?? globalWorkflowDir(),
        resolveStatus: createStatusResolver(ctx.db).resolve,
      });

  const item = store.get(workflowId);
  const workflow = item?.workflow ?? deps.resolveWorkflow?.(workflowId) ?? null;
  if (!workflow) return refuse("unknown_workflow");

  const definitionSha = item?.sha256 ?? definitionSha256(workflow);
  const cloned = cloneWorkflowForModel(workflow, provider, model);
  const resolveWorkflow = (id: string, version?: number): Workflow | null => {
    if (id === cloned.id && (version === undefined || version === cloned.version)) return cloned;
    return store.resolve(id, version) ?? deps.resolveWorkflow?.(id, version) ?? null;
  };

  const replayLimit = input.cases === undefined ? 10 : Math.max(0, Math.floor(input.cases));
  const replay = replayLimit > 0
    ? replayCasesFromRuns(ctx.db, workflow.id, {
        limit: replayLimit,
        workflow: cloned,
        log: { debug: (msg) => logDebug(ctx, msg) },
      }).cases.map(draftTestCaseFromReplay)
    : [];
  const cases = [...authoredCasesOf(cloned), ...replay];
  if (cases.length === 0) return refuse("no_cases");

  const failures: ProveWorkflowFailure[] = [];
  let passedN = 0;
  for (const tc of cases) {
    const result = await runDraftTest(
      {
        db: ctx.db,
        harnessVersion: HARNESS_VERSION,
        resolveWorkflow,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        log: { debug: (msg) => logDebug(ctx, msg) },
      },
      cloned,
      tc,
    );
    if (result.green) {
      passedN += 1;
    } else {
      failures.push({
        caseId: result.caseId,
        reason: result.failures.join("; ") || result.reason || result.error || result.status,
      });
    }
  }

  const casesN = cases.length;
  const at = (deps.now ?? Date.now)();
  recordWorkflowProof(ctx.db, {
    workflowId: workflow.id,
    definitionSha256: definitionSha,
    provider,
    model,
    casesN,
    passedN,
    costMicroUsd: null,
    at,
  });
  logInfo(ctx, `workflow prove wf=${workflow.id} model=${provider}/${model} passed=${passedN}/${casesN}`);
  return { ok: casesN > 0 && passedN === casesN, casesN, passedN, failures };
}

type WorkflowCliServices = {
  workflowLibrary?: { loadStore: (projectId?: string) => Promise<{ store: WorkflowStore }> };
  workflowEngine?: { resolveWorkflow?: (id: string, version?: number) => Workflow | null };
};

/** Handles `bb lane-pilot workflow prove <workflowId> --provider <p> --model <m> [--cases <n>]`. */
export async function workflowCli(
  ctx: ProveContext,
  services: WorkflowCliServices | undefined,
  args: string[],
  deps: ProveWorkflowDeps = {},
): Promise<PluginCliResult> {
  if (args[0] !== "prove") {
    return { exitCode: 1, stderr: `usage: ${WORKFLOW_PROVE_USAGE}\n` };
  }

  const positional: string[] = [];
  let provider: string | undefined;
  let model: string | undefined;
  let casesRaw: string | undefined;
  let projectId: string | undefined;
  let hostId: string | undefined;

  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    const takeValue = (name: string): string | null => {
      if (arg === name) {
        const next = rest[i + 1];
        if (next === undefined) return null;
        i += 1;
        return next;
      }
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      return null;
    };

    if (arg === "--provider" || arg.startsWith("--provider=")) {
      const value = takeValue("--provider");
      if (value === null) return { exitCode: 1, stderr: `usage: ${WORKFLOW_PROVE_USAGE}\n` };
      provider = value;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const value = takeValue("--model");
      if (value === null) return { exitCode: 1, stderr: `usage: ${WORKFLOW_PROVE_USAGE}\n` };
      model = value;
    } else if (arg === "--cases" || arg.startsWith("--cases=")) {
      const value = takeValue("--cases");
      if (value === null) return { exitCode: 1, stderr: `usage: ${WORKFLOW_PROVE_USAGE}\n` };
      casesRaw = value;
    } else if (arg === "--project" || arg.startsWith("--project=")) {
      const value = takeValue("--project");
      if (value === null) return { exitCode: 1, stderr: `usage: ${WORKFLOW_PROVE_USAGE}\n` };
      projectId = value;
    } else if (arg === "--host" || arg.startsWith("--host=")) {
      const value = takeValue("--host");
      if (value === null) return { exitCode: 1, stderr: `usage: ${WORKFLOW_PROVE_USAGE}\n` };
      hostId = value;
    } else if (arg.startsWith("-")) {
      return { exitCode: 1, stderr: `unknown option ${arg}\nusage: ${WORKFLOW_PROVE_USAGE}\n` };
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1 || !provider || !model) {
    return { exitCode: 1, stderr: `usage: ${WORKFLOW_PROVE_USAGE}\n` };
  }

  let cases: number | undefined;
  if (casesRaw !== undefined) {
    const parsed = Number(casesRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { exitCode: 1, stderr: `--cases must be a non-negative integer\nusage: ${WORKFLOW_PROVE_USAGE}\n` };
    }
    cases = parsed;
  }

  const loadStore = deps.loadStore
    ?? (services?.workflowLibrary?.loadStore ? async (pid?: string) => (await services.workflowLibrary!.loadStore(pid)).store : undefined);
  const resolveWorkflow = deps.resolveWorkflow ?? services?.workflowEngine?.resolveWorkflow;

  const result = await proveWorkflow(
    ctx,
    {
      ...deps,
      ...(loadStore ? { loadStore } : {}),
      ...(resolveWorkflow ? { resolveWorkflow } : {}),
      ...(hostId !== undefined ? { hostId } : {}),
    },
    {
      workflowId: positional[0]!,
      provider,
      model,
      ...(cases !== undefined ? { cases } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
    },
  );

  if (result.reason) {
    return { exitCode: 1, stderr: `workflow prove refused: ${result.reason}\n` };
  }
  return { exitCode: result.ok ? 0 : 1, stdout: `${JSON.stringify(result, null, 2)}\n` };
}
