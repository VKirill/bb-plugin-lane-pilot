import { z } from "zod";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import { collectCapabilities, CAPABILITY_SECTIONS } from "@lane-pilot/workflow-engine";
import { draftOpSchema, checkDraft, isLearnedDraftSource, permissionDiff } from "@lane-pilot/workflow-engine";
import type { DraftCheck } from "@lane-pilot/workflow-engine";
import { evaluateLearnedDraftGuard, grantFlaggedDraft, makeGuardLog, resolveDraftGuardBase } from "./draft-guard-policy";
import { createDraftStore } from "../../../storage";
import type { DraftRow, DraftStore } from "../../../storage";
import { testCasesOf } from "@lane-pilot/workflow-engine";
import { resolveDraftTestFromRuns, runArchitectDraftTests } from "./workflow-architect-test";
import { builtinWorkflow, builtinWorkflows, isEvolvableDomainBuiltinId, setBuiltinArchiveDb } from "../../builtin";
import { casWriteWorkflowFile } from "../../../storage";
import { archivePreviousRevision, archivePublishedRevision, makeArchiveLogger } from "./archive-publish";
import { sha256Hex, bestEffort } from "@lane-pilot/kit";
import { executorKey, lowerWorkflow } from "@lane-pilot/workflow-engine";
import type { DraftMetadata, RawDefinition, Workflow } from "@lane-pilot/workflow-engine";
import { createStatusResolver } from "../../../storage";
import { checkRequires, effectiveRequires } from "@lane-pilot/workflow-engine";
import { definitionSha256 } from "../../../storage";
import { loadWorkflow } from "@lane-pilot/workflow-engine";
import { registerObservedTool } from "../../../platform/server";
import { ToolError } from "../../../contracts/server";
import { stringAt } from "@lane-pilot/kit";
import { DRILL_SANDBOX_PROJECT_IDS, isSandboxProjectName } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { createDedupeGate, type DedupeGateDecision, type DedupeGateRefusal } from "./dedupe-gate";
import { consumeAuthority, draftSha256, grantOwner, grantOwnerFromChatConfirmation, publishGateLog } from "./publish-gate";
import { realDeps, type ArchitectDeps, type Services } from "./workflow-architect-deps";

export { realDeps, type ArchitectDeps } from "./workflow-architect-deps";

const bilingual = z.union([z.string().trim().min(1).max(2000), z.object({ en: z.string().trim().min(1).max(2000), ru: z.string().trim().min(1).max(2000) }).strict()]);
const MAX_SHOWN_PROBLEMS = 30;

/** What the architect touches outside the plugin's database; a test replaces them. */
const FIXTURE_ID = /^(pm-)?fixture-/;

const bothLanguages = (value: unknown): { en: string; ru: string } => {
  if (typeof value === "string") return { en: value, ru: value };
  const row = (value ?? {}) as { en?: unknown; ru?: unknown };
  const en = typeof row.en === "string" ? row.en : typeof row.ru === "string" ? row.ru : "";
  return { en, ru: typeof row.ru === "string" ? row.ru : en };
};

type CreateInputBase = {
  projectId: string;
  threadId: string;
  name: string | { en: string; ru: string };
  description: string | { en: string; ru: string };
  scope: "global" | "project";
  workflowId?: string;
  definition?: Record<string, unknown>;
  metadata?: DraftMetadata;
};
type CreateDedupeInput = CreateInputBase & { dedupe: true; trace?: readonly string[]; signature?: ReadonlySet<string>; exemptWorkflowId?: string; branchOf?: string };
type CreateResult = { draftId: string; workflowId: string; version: number; scope: "global" | "project"; status: DraftRow["status"]; metadata?: DraftMetadata; next: string };

export function createWorkflowArchitect(ctx: ServerCore, services: Pick<Services, "workflowEngine"> & Partial<Pick<Services, "workflowCatalog" | "workflowTriggers" | "workflowLibrary" | "dedupeThreshold">>, deps: ArchitectDeps = realDeps(ctx, services as Services)) {
  const { db } = ctx;
  setBuiltinArchiveDb(db);
  const drafts: DraftStore = createDraftStore(db);
  const resolve = (id: string, version?: number) => builtinWorkflow(id, version, db);
  const changed = (draft: DraftRow, threadId?: string) => ctx.realtime.notify(draft.projectId, "workflow-draft", threadId ?? draft.threadId ?? undefined, draft.id);
  const debugLog = (message: string) => {
    const bbLog = (ctx.bb as { log?: { debug?: (msg: string) => void } } | undefined)?.log;
    if (bbLog?.debug) bbLog.debug(message);
    else ctx.log(message);
  };
  const archiveLog = makeArchiveLogger(ctx);
  const guardLog = makeGuardLog(ctx);
  const dedupeGate = createDedupeGate({
    threshold: () => (typeof deps.dedupeThreshold === "function" ? deps.dedupeThreshold() : deps.dedupeThreshold) ?? (typeof services.dedupeThreshold === "function" ? services.dedupeThreshold() : services.dedupeThreshold),
    db,
    loadLibraryWorkflows: async ({ scope, projectId }) => {
      if (deps.loadLibraryWorkflows) return await deps.loadLibraryWorkflows({ scope, projectId });
      if (typeof services.workflowLibrary?.loadStore === "function") return (await services.workflowLibrary.loadStore(projectId)).store.list();
      return builtinWorkflows();
    },
    debug: debugLog,
  });

  const validation = { resolve, ...(deps.specialistKnown ? { specialistKnown: deps.specialistKnown } : {}) };
  const checkOf = (draft: DraftRow): DraftCheck => checkDraft(draft.definition, validation);
  const loaded = (draft: DraftRow) => loadWorkflow(draft.definition, validation);

  function testedState(draft: DraftRow): "none" | "red" | "green" {
    if (!draft.tests || draft.tests.version !== draft.version) return "none";
    return draft.tests.green ? "green" : "red";
  }

  function summary(draft: DraftRow, check = checkOf(draft)) {
    return {
      id: draft.id, projectId: draft.projectId, threadId: draft.threadId, workflowId: draft.workflowId, scope: draft.scope, name: bothLanguages(draft.definition.name),
      status: draft.status, version: draft.version, nodes: check.nodes, edges: check.edges, errors: check.errors, tested: testedState(draft),
      publishedPath: draft.publishedPath, updatedAt: draft.updatedAt,
    };
  }

  function problemsOf(check: DraftCheck) {
    const sorted = [...check.problems].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
    return { problems: sorted.slice(0, MAX_SHOWN_PROBLEMS), ...(sorted.length > MAX_SHOWN_PROBLEMS ? { moreProblems: sorted.length - MAX_SHOWN_PROBLEMS } : {}) };
  }

  function nextStep(draft: DraftRow, check: DraftCheck): string {
    if (check.errors) return "fix the errors above with lane_pilot_workflow_draft, action patch (they say which node or edge); an unfinished draft is normal while you build it";
    if (draft.status === "published") return "the draft is published; further patches start a new version that must be tested and published again";
    if (testedState(draft) !== "green") return "run lane_pilot_workflow_draft, action test; the test case lives in set_meta {test:{id, sim:{input, stubs, human_answers, expect_path, expect_output}}}";
    return "show the owner the graph and what the test did, ask for approval, then lane_pilot_workflow_draft, action publish with confirm: true";
  }

  function own(draftId: string, projectId: string): DraftRow {
    const draft = drafts.get(draftId);
    if (!draft || draft.projectId !== projectId) throw new ToolError(`draft ${draftId} does not exist in this project`, { code: "not_found", retryable: false, sideEffects: "none", next: "lane_pilot_workflow_draft, action get without a draftId lists the drafts of this project" });
    return draft;
  }

  function create(input: CreateDedupeInput): Promise<CreateResult | DedupeGateRefusal>;
  function create(input: CreateInputBase & { dedupe?: false }): CreateResult;
  function create(input: CreateInputBase & { dedupe?: boolean; trace?: readonly string[]; signature?: ReadonlySet<string>; exemptWorkflowId?: string; branchOf?: string }): CreateResult | Promise<CreateResult | DedupeGateRefusal> {
    if (input.workflowId && builtinWorkflow(input.workflowId)) throw new ToolError(`workflow id "${input.workflowId}" belongs to a built-in workflow`, { code: "id_reserved", retryable: false, sideEffects: "none" });
    const branchOf = input.branchOf ?? input.metadata?.branchOf;
    const baseMeta = branchOf ? { ...input.metadata, branchOf } : input.metadata;
    const finalize = (dedupe?: DedupeGateDecision): CreateResult => {
      const metadata: DraftMetadata | undefined = dedupe ? { ...baseMeta, dedupe } : baseMeta;
      const draft = drafts.create({ projectId: input.projectId, threadId: input.threadId, scope: input.scope, name: input.name, description: input.description, workflowId: input.workflowId, definition: input.definition, metadata });
      changed(draft, input.threadId);
      return {
        draftId: draft.id, workflowId: draft.workflowId, version: draft.version, scope: draft.scope, status: draft.status, ...(metadata ? { metadata } : {}),
        next: "ask the owner the short questions, then build with lane_pilot_workflow_draft, action patch: set_meta (inputs, outputs, requires), then the nodes and edges a step at a time",
      };
    };
    if (!input.dedupe) return finalize();
    return dedupeGate.check({ scope: input.scope, projectId: input.projectId, definition: input.definition as RawDefinition | undefined, trace: input.trace, signature: input.signature, exemptWorkflowId: input.exemptWorkflowId ?? branchOf }).then((gate) =>
      gate.ok ? finalize(gate.decision) : { ok: false, reason: gate.reason, workflowId: gate.workflowId, score: gate.score, threshold: gate.threshold, outcome: gate.outcome, decision: gate.decision },
    );
  }

  function patch(input: { projectId: string; threadId?: string; draftId: string; ops: z.input<typeof draftOpSchema>[]; expectedVersion?: number; source?: string }) {
    const existing = own(input.draftId, input.projectId);
    const source = input.source ?? (isLearnedDraftSource(existing.metadata?.source) ? existing.metadata.source : "owner");
    const result = drafts.patch(input.draftId, input.ops, { expectedVersion: input.expectedVersion, validate: validation, source });
    if (!result.ok) {
      if (source === "evolve" && result.reason === "refused" && result.refused?.some((r) => r.reason === "widens_permissions")) {
        guardLog.warn(`draft guard source=evolve draft=${existing.id} widening=1`);
      }
      if (result.reason === "refused") return { ok: false, applied: false, refused: result.refused, note: "nothing was changed: fix the refused operations and send the patch again" };
      if (result.reason === "version_conflict") return { ok: false, applied: false, reason: "version_conflict", currentVersion: result.currentVersion, note: "the draft changed since you read it (the owner or another chat): lane_pilot_workflow_draft, action get, then patch again" };
      throw new ToolError("draft does not exist", { code: "not_found", retryable: false, sideEffects: "none" });
    }
    const base = resolveDraftGuardBase({ draft: existing, drafts, resolve });
    const guarded = evaluateLearnedDraftGuard({ db, drafts, draft: result.draft, source, base, log: guardLog });
    changed(guarded, input.threadId);
    return { ok: true, applied: true, draftId: guarded.id, version: guarded.version, status: guarded.status, changes: result.changes,
      valid: result.check.valid, errors: result.check.errors, warnings: result.check.warnings, nodes: result.check.nodes, edges: result.check.edges, ...problemsOf(result.check), next: nextStep(guarded, result.check) };
  }

  function grant(input: { projectId: string; draftId: string; by?: string }) {
    const draft = own(input.draftId, input.projectId);
    const updated = grantFlaggedDraft({ db, drafts, draft, by: input.by, log: guardLog });
    changed(updated, updated.threadId ?? undefined);
    return { ok: true, draftId: updated.id, granted: true };
  }

  function get(input: { projectId: string; draftId?: string; history?: boolean }) {
    if (!input.draftId) {
      return { drafts: drafts.list(input.projectId).map((draft) => summary(draft)), next: "pass a draftId to read one; lane_pilot_workflow_draft, action create starts a new one" };
    }
    const draft = own(input.draftId, input.projectId);
    const check = checkOf(draft);
    return { draft: summary(draft, check), definition: draft.definition, ...(draft.metadata ? { metadata: draft.metadata } : {}), valid: check.valid, ...problemsOf(check), tests: draft.tests && { version: draft.tests.version, green: draft.tests.green, stale: draft.tests.version !== draft.version,
      cases: draft.tests.results.map((result) => ({ caseId: result.caseId, green: result.green, failures: result.failures })) },
    ...(input.history ? { history: drafts.history(draft.id) } : {}), next: nextStep(draft, check) };
  }

  async function capabilities(input: { projectId: string; threadId: string; sections?: string[]; query?: string }) {
    return await collectCapabilities(deps.capabilityPorts({ projectId: input.projectId, threadId: input.threadId }), { sections: input.sections, query: input.query });
  }

  /** The executors the graph names that this instance has not registered: they are stubbed in tests and need a registration to run live. */
  function unregisteredExecutors(workflow: Workflow): string[] {
    const keys = new Set<string>();
    for (const node of lowerWorkflow(workflow, resolve).nodes) {
      if (node.type === "note") continue;
      const key = executorKey(node);
      if (key && !key.startsWith("builtin:") && !deps.hasExecutor(key)) keys.add(key);
    }
    return [...keys].sort();
  }

  /** The skills, BB plugins and MCP servers the chain names (in `requires` and on its agent steps) that the machine does not list. */
  async function unavailableCapabilities(workflow: Workflow, projectId: string, threadId: string): Promise<string[]> {
    const ports = deps.capabilityPorts({ projectId, threadId });
    const check = await checkRequires(effectiveRequires(workflow), {
      ...(ports.skills ? { skills: async () => (await ports.skills!()).map((row) => row.name) } : {}),
      ...(ports.plugins ? { plugins: async () => (await ports.plugins!()).map((row) => row.id) } : {}),
      ...(ports.mcpServers ? { mcpServers: async () => (await ports.mcpServers!()).map((row) => row.name) } : {}),
    });
    return check.issues.filter((issue) => issue.level === "missing").map((issue) => issue.message);
  }

  async function test(input: { projectId: string; threadId?: string; draftId: string; testCaseId?: string; fromRuns?: { limit?: number; runIds?: string[] } }) {
    const draft = own(input.draftId, input.projectId);
    const load = loaded(draft);
    if (!load.ok) return { draftId: draft.id, version: draft.version, green: false, ran: false, reason: "invalid", problems: load.problems.filter((problem) => problem.level === "error").slice(0, MAX_SHOWN_PROBLEMS), next: "fix the errors with lane_pilot_workflow_draft, action patch first" };
    return await runArchitectDraftTests({
      draft, workflow: load.workflow, resolve, db, drafts, debugLog, changed,
      threadId: input.threadId, testCaseId: input.testCaseId, fromRuns: resolveDraftTestFromRuns(draft, input.fromRuns),
    });
  }

  async function publish(input: { projectId: string; threadId?: string; draftId: string; ownerGrant?: boolean }) {
    let draft = own(input.draftId, input.projectId);
    const refuse = (reason: string, next: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, draftId: draft.id, published: false, reason, next, ...extra });
    const authority = consumeAuthority(db, draft.id, draftSha256(draft.definition), { log: publishGateLog(ctx) });
    if (!authority.ok) {
      return refuse(
        authority.reason,
        authority.reason === "draft_changed_after_grant"
          ? "the draft changed after the owner's grant: ask the owner again and re-grant before publishing"
          : "publish requires an owner grant (`bb lane-pilot workflow publish <draftId> --owner`, owner confirmation in chat, or review desk) or an evolution gate receipt",
      );
    }
    if (draft.metadata?.needs_owner_review === "widens") {
      if (!input.ownerGrant) {
        guardLog.warn(`workflow_publish_refused:needs_owner_review ${draft.id} ${draft.workflowId}`);
        return refuse("needs_owner_review", "a learned draft widens permissions; review the diff on the desk item and grant it before publishing", { wideningDiff: draft.metadata.wideningDiff });
      }
      draft = grantFlaggedDraft({ db, drafts, draft, by: "owner", log: guardLog });
    }
    // A test fixture (pm-fixture-*, fixture-*) is published only into a sandbox project, never globally: the router of a real project must not offer it.
    const draftId = stringAt(draft.definition, "id") ?? "";
    if (FIXTURE_ID.test(draftId) && !(draft.scope === "project" && (DRILL_SANDBOX_PROJECT_IDS.includes(draft.projectId) || isSandboxProjectName(await deps.projectName?.(draft.projectId) ?? null)))) {
      ctx.log(`workflow_publish_refused:fixture_outside_sandbox ${draftId} ${draft.projectId}`);
      return refuse("fixture_outside_sandbox", "a test fixture is published only into a sandbox project (LP sandbox / LP bench); rename it with set_meta {id} if it is real");
    }
    const load = loaded(draft);
    if (!load.ok) return refuse("invalid", "fix the errors with lane_pilot_workflow_draft, action patch", { problems: load.problems.filter((problem) => problem.level === "error").slice(0, MAX_SHOWN_PROBLEMS) });
    if (!draft.tests) return refuse("no_tests", "run lane_pilot_workflow_draft, action test first");
    if (draft.tests.version !== draft.version) return refuse("tests_stale", "the draft changed after its last test: run lane_pilot_workflow_draft, action test again");
    const cases = testCasesOf(load.workflow);
    if (!draft.tests.green || !cases.every((item) => draft.tests!.results.some((row) => row.caseId === item.id && row.green))) {
      return refuse("tests_not_green", "fix the failing cases and test again; a draft is published only when every case is green", { failing: draft.tests.results.filter((row) => !row.green).map((row) => ({ caseId: row.caseId, failures: row.failures })) });
    }
    const id = load.workflow.id;
    const existingBuiltin = builtinWorkflow(id);
    if (existingBuiltin && !(draft.scope === "global" && isEvolvableDomainBuiltinId(id))) {
      return refuse("id_reserved", `"${id}" is a built-in workflow: rename with set_meta {id}`);
    }
    const version = draft.publishedVersion
      ? draft.publishedVersion + 1
      : draft.metadata?.source === "evolve"
        ? (existingBuiltin ? existingBuiltin.version : load.workflow.version) + 1
        : load.workflow.version;
    const final: Workflow = { ...load.workflow, status: "published", version, scope: draft.scope === "project" ? { level: "project", projectId: draft.projectId } : { level: "global" } };
    const reloaded = loadWorkflow(JSON.parse(JSON.stringify(final)), { resolve });
    if (!reloaded.ok) return refuse("round_trip_failed", "the file would not load back; fix the errors", { problems: reloaded.problems.slice(0, MAX_SHOWN_PROBLEMS) });
    const content = `${JSON.stringify(final, null, 2)}\n`;
    await archivePreviousRevision(ctx, { draft, drafts, globalDir: deps.globalDir(), resolve, log: archiveLog });
    // The file may be overwritten only when it is the one this draft published earlier (same place, same content).
    const expected = draft.publishedSha256 && draft.publishedPath?.endsWith(`${id}.json`) ? draft.publishedSha256 : null;
    let written: { status: "applied" | "conflict"; path: string; afterSha256: string | null; reason: string | null };
    if (draft.scope === "project") {
      const place = input.threadId ? await deps.projectPlace(input.threadId) : await deps.projectPlaceOf?.(input.projectId) ?? null;
      if (!place) return refuse("project_place_unknown", "this chat has no project folder on a machine to write into; start the architect from the project's own chat, or publish as global");
      written = await deps.writeProjectFile(place, id, content, expected);
    } else {
      written = await casWriteWorkflowFile(deps.globalDir(), id, content, expected);
    }
    if (written.status === "conflict") return refuse("file_conflict", `${written.reason}; choose another id with set_meta {id} or ask the owner`, { path: written.path });
    const sha256 = written.afterSha256 ?? sha256Hex(content);
    archivePublishedRevision(ctx, { workflow: reloaded.workflow, json: content, scope: draft.scope, log: archiveLog });
    // The file is only as good as its tests: the receipt says this exact definition passed them, which the library asks for before it counts the file as published.
    createStatusResolver(db).recordTest(id, definitionSha256(reloaded.workflow), true, draft.tests.results.map((row) => ({ caseId: row.caseId, green: row.green, path: row.path })));
    const published = drafts.markPublished(draft.id, { version: draft.version, path: written.path, sha256, workflowVersion: version }) ?? draft;
    changed(published, input.threadId);
    services.workflowCatalog?.invalidate();
    // A published workflow with a schedule trigger gets its schedule-board row (and a changed one its update).
    await services.workflowTriggers?.syncTriggers?.(draft.projectId);
    const missing = unregisteredExecutors(final);
    // Names the chain asks for that this machine does not have: said at publish, not refused (the project's machine may differ from the one that runs it).
    const capabilityWarnings = await bestEffort(ctx.log, "architect capability warnings", unavailableCapabilities(final, draft.projectId, input.threadId ?? ""), []);
    return {
      draftId: draft.id, published: true, workflowId: id, workflowVersion: version, scope: draft.scope, path: written.path,
      ...(capabilityWarnings.length ? { capabilityWarnings } : {}),
      liveReady: missing.length === 0, ...(missing.length ? { unregisteredExecutors: missing, warning: "these actions have no executor registered in this Lane Pilot yet: they ran on stubs in the test and a live run stops at them" } : {}),
      next: "tell the owner where the chain is (Workflows tab, library) and how to start it; changes to this draft start a new version",
    };
  }

  const rpc = {
    workflow_draft_list: ({ projectId, threadId }) => ({ drafts: drafts.list(projectId, { threadId }).map((draft) => summary(draft)) }),
    workflow_draft_get: ({ draftId, history }) => {
      const draft = drafts.get(draftId);
      if (!draft) return { draft: null, definition: null, check: null, tests: null, history: [] };
      const check = checkOf(draft);
      return { draft: summary(draft, check), definition: draft.definition, check: { valid: check.valid, errors: check.errors, warnings: check.warnings, nodes: check.nodes, edges: check.edges, problems: check.problems }, tests: draft.tests, history: history ? drafts.history(draft.id) : [] };
    },
    // The editor in the Workflows tab changes a draft through the same functions the architect's tools call, so the validator,
    // the version counter, the test reset and the «workflow-draft» signal behave the same for the owner and for the chat.
    workflow_draft_patch: ({ draftId, ops, expectedVersion }) => {
      const draft = drafts.get(draftId);
      if (!draft) throw new Error(`draft ${draftId} does not exist`);
      const parsed = z.array(draftOpSchema).min(1).max(40).safeParse(ops);
      if (!parsed.success) return { ok: false, applied: false, refused: parsed.error.issues.slice(0, 5).map((issue) => ({ index: typeof issue.path[0] === "number" ? issue.path[0] : 0, op: "invalid", reason: issue.message })) };
      const result = patch({ projectId: draft.projectId, threadId: draft.threadId ?? undefined, draftId, ops: parsed.data, expectedVersion, source: "owner" }) as Record<string, unknown>;
      return result.applied ? { ...result, definition: drafts.get(draftId)?.definition } as never : result as never;
    },
    workflow_draft_restore: ({ draftId, version, expectedVersion }) => {
      const result = drafts.restore(draftId, version, { expectedVersion });
      if (!result.ok) return { ok: false, reason: result.reason, ...(result.currentVersion !== undefined ? { currentVersion: result.currentVersion } : {}) };
      changed(result.draft);
      return { ok: true, version: result.draft.version, definition: result.draft.definition };
    },
    workflow_draft_test: async ({ draftId, testCaseId, fromRuns }) => {
      const draft = drafts.get(draftId);
      if (!draft) throw new Error(`draft ${draftId} does not exist`);
      return await test({ projectId: draft.projectId, threadId: draft.threadId ?? undefined, draftId, testCaseId, fromRuns }) as never;
    },
    workflow_draft_publish: async ({ draftId }) => {
      const draft = drafts.get(draftId);
      if (!draft) throw new Error(`draft ${draftId} does not exist`);
      grantOwner(db, draftId, "desk", { log: publishGateLog(ctx) });
      return await publish({ projectId: draft.projectId, threadId: draft.threadId ?? undefined, draftId }) as never;
    },
    workflow_draft_grant: ({ draftId }) => {
      const draft = drafts.get(draftId);
      if (!draft) return { ok: false, draftId, granted: false, reason: "not_found" };
      return grant({ projectId: draft.projectId, draftId, by: "owner" });
    },
    workflow_capabilities: async ({ projectId, draftId }) => {
      const draft = draftId ? drafts.get(draftId) : null;
      return { capabilities: await capabilities({ projectId, threadId: draft?.threadId ?? "", sections: ["skills", "plugins", "mcpServers", "secrets", "hosts", "specialists"] }) };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workflow_draft_list" | "workflow_draft_get" | "workflow_draft_patch" | "workflow_draft_restore" | "workflow_draft_test" | "workflow_draft_publish" | "workflow_draft_grant" | "workflow_capabilities">;

  type CreateFromBase = {
    projectId: string; scope: "global" | "project"; workflowId: string; definition: Record<string, unknown>; name: { en: string; ru: string }; description: { en: string; ru: string };
    base?: { path: string; sha256: string; version: number }; metadata?: DraftMetadata;
  };
  type CreateFromDedupe = CreateFromBase & { dedupe: true; trace?: readonly string[]; signature?: ReadonlySet<string>; exemptWorkflowId?: string; branchOf?: string };
  function createFrom(input: CreateFromDedupe): Promise<DraftRow | DedupeGateRefusal>;
  function createFrom(input: CreateFromBase & { dedupe?: false }): DraftRow;
  /** A draft that starts from a workflow that exists: a copy of a built-in one, or the file of one the owner edits. */
  function createFrom(input: CreateFromBase & { dedupe?: boolean; trace?: readonly string[]; signature?: ReadonlySet<string>; exemptWorkflowId?: string; branchOf?: string }): DraftRow | Promise<DraftRow | DedupeGateRefusal> {
    const branchOf = input.branchOf ?? input.metadata?.branchOf;
    const baseMeta = branchOf ? { ...input.metadata, branchOf } : input.metadata;
    const save = (dedupe?: DedupeGateDecision, fallbackBase?: Workflow | null): DraftRow => {
      const source = baseMeta?.source;
      const baseDef = isLearnedDraftSource(source) ? resolveDraftGuardBase({ branchOf, source, resolve, fallbackWorkflow: fallbackBase }) : null;
      if (source === "evolve" && permissionDiff(baseDef, input.definition).length > 0) {
        const diffs = permissionDiff(baseDef, input.definition);
        guardLog.warn(`draft guard source=evolve draft=${input.workflowId} widening=${diffs.length}`);
        throw new ToolError("evolve draft widens permissions", { code: "widens_permissions", retryable: false, sideEffects: "none" });
      }
      const metadata = dedupe ? { ...baseMeta, dedupe } : baseMeta;
      const draft = drafts.create({ projectId: input.projectId, threadId: null, scope: input.scope, name: input.name, description: input.description, workflowId: input.workflowId, definition: input.definition, base: input.base, metadata });
      const guarded = evaluateLearnedDraftGuard({ db, drafts, draft, source, base: baseDef, log: guardLog });
      changed(guarded);
      return guarded;
    };
    if (!input.dedupe) return save();
    return dedupeGate.check({ scope: input.scope, projectId: input.projectId, definition: input.definition as RawDefinition, trace: input.trace, signature: input.signature, exemptWorkflowId: input.exemptWorkflowId ?? branchOf }).then(async (gate) => {
      if (!gate.ok) return { ok: false, reason: gate.reason, workflowId: gate.workflowId, score: gate.score, threshold: gate.threshold, outcome: gate.outcome, decision: gate.decision };
      const unwrap = (item: Workflow | { workflow: Workflow }): Workflow => ("workflow" in item ? item.workflow : item);
      const fallbackBase = branchOf && !resolve(branchOf) && deps.loadLibraryWorkflows
        ? (await deps.loadLibraryWorkflows({ scope: input.scope, projectId: input.projectId })).map(unwrap).find((w) => w.id === branchOf) ?? null
        : null;
      return save(gate.decision, fallbackBase);
    });
  }

  return { drafts, create, createFrom, patch, grant, get, capabilities, test, publish, summary, rpc };
}

export type WorkflowArchitect = ReturnType<typeof createWorkflowArchitect>;

const draftId = z.string().min(1).max(40);

export function mountWorkflowArchitect(ctx: ServerCore, services: Services, architect?: WorkflowArchitect, options?: { dedupeThreshold?: number | (() => number) }): WorkflowArchitect {
  architect ??= createWorkflowArchitect(ctx, options?.dedupeThreshold !== undefined ? { ...services, dedupeThreshold: options.dedupeThreshold } : services);
  const { bb } = ctx;
  const needChat = (context: { threadId: string; projectId: string }) => {
    if (!context.threadId || !context.projectId) throw new ToolError("workflow tools need a chat in a project", { code: "needs_project_chat", retryable: false, sideEffects: "none" });
    return context;
  };
  const json = (value: unknown) => JSON.stringify(value, null, 2);

  registerObservedTool(bb.agents, {
    name: "lane_pilot_workflow_draft_create",
    description: "Start a draft of a workflow (a chain of agent, action, human and code steps) that you build and test before it is published.",
    instructions: "Use from the Workflow architect chat (or a PM chat when the owner asks for a repeatable chain) after you know the goal. `name` and `description` are one string or {en, ru}; `scope` is project (stored in the project's own .lane-pilot/workflows) or global (the owner's ~/.lane-pilot/workflows, usable in every project). Returns the draftId: pass it to every other lane_pilot_workflow_draft_* tool. The open Workflows tab shows the graph and redraws after each patch.",
    parameters: z.object({ name: bilingual, description: bilingual, scope: z.enum(["global", "project"]).default("global"), workflowId: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,47}$/).optional() }).strict(),
    execute: async (params, context) => { const c = needChat(context); return json(architect.create({ projectId: c.projectId, threadId: c.threadId, ...params })); },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_workflow_draft_patch",
    description: "Change a workflow draft with small operations and get the validator's problems back at once.",
    instructions: "ops (1 to 40, applied in order as one new version): add_node {node:{id,type,...}}, update_node {id,set,unset}, remove_node {id}, add_edge {edge:{from,to,when,with,pass,label}} (`start` and `end` are the ends of the chain), update_edge / remove_edge {edge:{from,to,when?} or {index}}, set_meta {set:{name,description,examples,inputs,outputs,requires,budget,guards,quality_mode,triggers,test,id,...}}. Build in steps the owner can follow: the frame first (inputs, outputs, requires), then a node or two with their edges, validate, continue. An unfinished draft is saved with its problems; only an operation that cannot be applied (unknown node, taken id) refuses the whole patch and changes nothing. Node types, passing modes, conditions and guards: lane_pilot_workflow_capabilities {sections:[\"reference\"]}. `expectedVersion` guards against editing over a newer version.",
    parameters: z.object({ draftId, ops: z.array(draftOpSchema).min(1).max(40), expectedVersion: z.number().int().min(1).optional() }).strict(),
    execute: async (params, context) => { const c = needChat(context); return json(architect.patch({ projectId: c.projectId, threadId: c.threadId, ...params })); },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_workflow_draft_get",
    description: "Read a workflow draft: its definition, the validator's problems, the last test. Without a draftId, list the drafts of this project.",
    instructions: "Call it to re-read the draft after the owner edited it in the Workflows tab or before a long reply. `history: true` adds the version log (what each patch changed).",
    parameters: z.object({ draftId: draftId.optional(), history: z.boolean().default(false) }).strict(),
    execute: async (params, context) => { const c = needChat(context); return json(architect.get({ projectId: c.projectId, ...params })); },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_workflow_capabilities",
    description: "List what a chain can use on the owner's machines: skills, BB plugins, MCP servers, Env Catalog secret names, machines, the browser, specialists, the provider/model pairs the machines offer, and the chain format reference.",
    instructions: "Call before you propose nodes, so every node uses something that exists. `sections` limits the answer (skills, plugins, mcpServers, secrets, hosts, browser, specialists, models, reference); `query` keeps only entries whose name contains it (for example telegram). Secrets are names and kinds only, never values: a node that needs one lists it in requires.secrets, and a missing one is asked from the owner with env_request. A section with status unavailable or error could not be read: say so instead of assuming it is empty.",
    parameters: z.object({ sections: z.array(z.enum(CAPABILITY_SECTIONS)).max(9).optional(), query: z.string().trim().min(1).max(80).optional() }).strict(),
    execute: async (params, context) => { const c = needChat(context); return json(await architect.capabilities({ projectId: c.projectId, threadId: c.threadId, ...params })); },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_workflow_draft_test",
    description: "Run the draft's test cases on stubs (nothing leaves the machine) and report the path, the outputs and what failed.",
    instructions: "Every agent, code task and action node answers with a stub (made from its declared out, or the answer the case gives), human nodes are answered from the case, and the real engine routes the graph, so conditions, loops and guards are tested for real. The case is the draft's `test` (set_meta {test:{id, sim:{input, stubs:{nodeId:{field:value}}, human_answers:{nodeId:'answer_kind'}, expect_path:[...], expect_output:{...}, variant_<name>:{...}}}}); without one a smoke case runs. Stub the nodes that decide a branch, or the run takes the first enum value. `testCaseId` runs one case. A draft is publishable only when every case is green on its current version.",
    parameters: z.object({
      draftId,
      testCaseId: z.string().min(1).max(120).optional(),
      fromRuns: z.object({ limit: z.number().int().min(1).max(200).optional(), runIds: z.array(z.string().min(1)).max(200).optional() }).strict().optional(),
    }).strict(),
    execute: async (params, context) => { const c = needChat(context); return json(await architect.test({ projectId: c.projectId, threadId: c.threadId, ...params })); },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_workflow_draft_publish",
    description: "Publish a tested draft as a workflow file (project or global) so the library and the router can use it.",
    instructions: "Only after the owner agreed to the chain. Refused unless every test case is green on the current version of the draft; the answer says what to fix. Writes <project>/.lane-pilot/workflows/<id>.json (scope project, through the project's machine) or ~/.lane-pilot/workflows/<id>.json (scope global); a file that is not this draft's earlier publication is never overwritten. The answer lists actions that have no executor registered yet (they ran on stubs in the test).",
    parameters: z.object({ draftId, confirm: z.literal(true) }).strict(),
    execute: async (params, context) => {
      const c = needChat(context);
      await grantOwnerFromChatConfirmation(ctx, c.threadId, params.draftId);
      return json(await architect.publish({ projectId: c.projectId, threadId: c.threadId, draftId: params.draftId }));
    },
  });

  return architect;
}
