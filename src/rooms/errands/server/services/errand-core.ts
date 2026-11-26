import { writerExecutionSelection } from "@lane-pilot/models";
import { QA_HOST_KEY } from "@lane-pilot/settings-catalog";
import { isNotFound, orMiss, outputText, redactKnown, stringAt } from "@lane-pilot/kit";
import { checkBrief } from "../../../brief";
import { ROLE_PROFILES, effectiveGroup, parseHelperContextSettings } from "../../../contracts";
import { configuredSetting, type ServerCore } from "../../../contracts/server";
import { placeEmployeeOn } from "../../../native-agent";
import { folderEnvironment, fullAccessSpawn, hiddenPlacement, modelCatalogOf, projectFolder, projectSources, resolveSpawnModel, spawnTextId, spawnUsageOf, warmSpawnUsage } from "../../../platform/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import { errandRoleFor } from "../../../schedule";
import { allowedSecretNames, secretFixLines, secretProblem, waitingSecretReason, type CatalogEntry } from "../../../secrets/server";
import { findOpenNativeRun, getRun, getRunSettingsScopes, latestRunForProjectThread, loadProjectSettings, recordSecretIssuance } from "../../../storage";
import { detectRepoEdits, gitRepoStatus } from "../../../verification/server";
import { errandCheck, errandPrompt, errandVerdict, type ErrandCheck, type ErrandSnapshot, type ErrandStart, type ErrandVerified } from "../../models/errand-prompt";

export type ErrandBlocked = { state: "blocked"; reason: string; next: string; fix: string[] };

/**
 * Work a PM is asked for that is not a code change: a cloud console, a mailbox, a screen recording. Before this a
 * PM had no way to do it — its shell may not drive the browser and its only delegate, the writer, edits code in a
 * worktree — so it sent the owner to click through Google Cloud Console by hand (thr_wb4dsw4usn, 2026-10-03).
 */
export function createErrandCore(ctx: ServerCore) {
  const { bb, db, host } = ctx;

  function browserSetup(projectId: string, runId: string | null) {
    const settings = loadProjectSettings(db, projectId, runId ? getRunSettingsScopes(db, runId) : []);
    const hostId = configuredSetting(settings, QA_HOST_KEY);
    return { hostId: typeof hostId === "string" && hostId.trim() ? hostId.trim() : null };
  }

  // The run gives settings scopes and helper placement; an errand needs a PM chat, not open writer work, so the
  // chat's latest run serves even after it closed (a sandbox PM closes its run right after the accepted writer).
  function openRun(projectId: string, pmThreadId: string): string {
    const open = findOpenNativeRun(db, projectId, pmThreadId);
    const runId = open ?? latestRunForProjectThread(db, projectId, pmThreadId)?.id;
    if (!runId || !getRun(db, runId)) throw new Error("errand_needs_pm_chat: call this from a Lane Pilot PM chat");
    return runId;
  }

  /**
   * The accounts a PM or a schedule hands to an errand (J7): only the names the project list leaves open, only they are named to the helper.
   * Left out or missing: nothing starts and `blocked` says what to do.
   */
  async function resolveAccounts(input: { projectId: string; runId: string | null; pmThreadId: string | null; names: readonly string[]; /** false: only the check, nothing is noted as issued (the graph's own step issues them when it runs). */ record?: boolean }): Promise<{ ok: true; accounts: CatalogEntry[] } | { ok: false; blocked: ErrandBlocked }> {
    if (!input.names.length) return { ok: true, accounts: [] };
    const gate = await ctx.secrets.check({ declared: [...input.names], allowed: allowedSecretNames(loadProjectSettings(db, input.projectId, input.runId ? getRunSettingsScopes(db, input.runId) : [])), kinds: ["secret", "login", "ssh", "ftp"] }, { fresh: true });
    const problem = secretProblem(gate);
    if (problem.length || gate.unavailable) {
      return { ok: false, blocked: { state: "blocked", reason: waitingSecretReason(problem.length ? problem : [...input.names]), next: "No helper was started. Fix the access below, then call lane_pilot_errand again with the same arguments:", fix: secretFixLines(gate) } };
    }
    const accounts = input.names.map((name) => gate.catalog!.find((entry) => entry.name === name)!);
    if (input.record === false) return { ok: true, accounts };
    // Fetched only to be masked: whatever the helper prints of them never reaches the PM's view of its report.
    for (const account of accounts) {
      await ctx.secrets.record(account.name);
      try { recordSecretIssuance(db, { projectId: input.projectId, ...(input.runId ? { runId: input.runId } : {}), consumer: "errand", ...(input.pmThreadId ? { threadId: input.pmThreadId } : {}), secretName: account.name }); } catch (cause) { bb.log.warn(`secret issuance journal: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    return { ok: true, accounts };
  }

  /**
   * Where the helper of an errand works and which checkout it must not change: the PM chat's environment, or, with no PM chat (a scheduled
   * errand, a project that does not use Lane Pilot), the project's own first folder on a machine.
   */
  async function errandPlace(input: { projectId: string; pmThreadId: string | null; agentId?: string | undefined }) {
    const base = await errandPlaceBase(input);
    if (!input.agentId) return base;
    const place = await placeEmployeeOn(bb, input.agentId, await projectSources(bb, input.projectId));
    if (place.mode === "folder") return { environment: folderEnvironment({ hostId: place.hostId, path: place.path }), section: base.section, cwd: place.path, hostId: place.hostId };
    if (place.mode === "fallback") bb.log.warn(`Lane Pilot employee ${input.agentId} stays in the current environment: ${place.reason}`);
    return base;
  }

  async function errandPlaceBase(input: { projectId: string; pmThreadId: string | null }) {
    if (input.pmThreadId) {
      const pm = await bb.sdk.threads.get({ threadId: input.pmThreadId });
      const environmentId = stringAt(pm, "environmentId");
      if (!environmentId) throw new Error("errand_needs_pm_environment");
      const envObj = await orMiss(bb.sdk.environments.get({ environmentId }), null, isNotFound);
      return { environment: { type: "reuse" as const, environmentId }, section: stringAt(pm, "sectionId"), cwd: stringAt(envObj, "path") ?? "", hostId: stringAt(envObj, "hostId") ?? "" };
    }
    const folder = await projectFolder(bb, input.projectId);
    if (!folder) throw new Error("errand_needs_project_folder: the project has no folder on a machine to run the helper in; add one to the project in BB");
    return { environment: folderEnvironment(folder), section: null, cwd: folder.path, hostId: folder.hostId };
  }

  /** The files the checkout has changed before the helper starts: what differs after it ends is the helper's edit. The graph step keeps it in its journal. */
  async function errandSnapshot(input: { projectId: string; pmThreadId: string | null; agentId?: string | undefined }): Promise<ErrandSnapshot | null> {
    const place = await errandPlace(input);
    if (!place.cwd || !place.hostId) return null;
    const before = await gitRepoStatus(host, place.hostId, place.cwd);
    return before ? { hostId: place.hostId, cwd: place.cwd, before: [...before] } : null;
  }

  /** Spawns the helper thread of an errand, under a PM chat or (detached, or with no chat) as a hidden thread of the project. The same `spawnId` repeated returns the same thread. */
  async function startErrand(input: ErrandStart): Promise<{ threadId: string; browserMachine: string | null }> {
    const place = await errandPlace(input);
    const setup = browserSetup(input.projectId, input.runId);
    const helperPolicy = requireHelperSpawn({ bb, db, projectId: input.projectId, runId: input.runId });
    const title = input.title ?? input.task.slice(0, 60);
    const detached = Boolean(input.detached) || !input.runId || !input.pmThreadId;
    const placement = detached
      ? hiddenPlacement(input.projectId, `Lane Pilot errand: ${title}`, place.section)
      : await helperChildPlacement({ bb, db, projectId: input.projectId, runId: input.runId!, role: "errand", taskTitle: title });
    // The one resolver: what the caller named (the schedule's / the tool's resolved model) is a pin, kept as a consistent provider+model pair;
    // nothing named is the row of the role table for the errand's kind (`errand-computer`…, else `errand`). The helper profile stays `errand`.
    const spawnUsage = spawnUsageOf(ctx);
    await warmSpawnUsage(spawnUsage, place.hostId);
    const errandSettings = loadProjectSettings(db, input.projectId);
    const errandRole = resolveSpawnModel({
      role: errandRoleFor(input.kind, errandSettings), settings: errandSettings, catalog: modelCatalogOf(ctx).peek(), usage: spawnUsage, hostId: place.hostId,
      ...(input.model ? { pinned: { provider: input.providerId ?? null, model: input.model, reasoning: input.reasoning ?? null } } : input.reasoning ? { pinned: { reasoning: input.reasoning } } : {}),
    });
    const providerId = errandRole.providerId;
    // The errand's skill line mirrors the writer's: catalog browsing only when the thread really has a broad skill list
    // (helper.context_mode ≠ roles, or the role profile leaves skills unrestricted); picked skills get one naming line.
    const helperSettings = parseHelperContextSettings(loadProjectSettings(db, input.projectId, input.runId ? getRunSettingsScopes(db, input.runId) : []));
    const broadSkills = !helperSettings.ok || helperSettings.settings.mode !== "roles"
      || effectiveGroup("errand", "skills", helperSettings.settings.roleAccess?.errand).names === null;
    const prompt = errandPrompt({
      task: input.task, browserHostId: setup.hostId, authorized: input.authorized, accounts: [...input.accounts],
      broadSkills, skills: [...ROLE_PROFILES.errand.skills, ...(input.access?.skills ?? [])],
    });
    for (const violation of checkBrief("errand", prompt, { skillsPicked: !broadSkills })) bb.log.warn(`Lane Pilot errand brief: ${violation.code} — ${violation.detail}`);
    const spawned = await fullAccessSpawn(bb, {
      ...placement,
      ...requiredPolicyField(bb, helperPolicy, providerId, "errand", input.access),
      ...writerExecutionSelection(providerId, errandRole.model, errandRole.reasoningEffort, input.serviceTier ?? "default"),
      prompt,
      environment: place.environment,
      pluginMetadata: { role: "errand", ...(input.kind ? { errandKind: input.kind } : {}), spawnId: input.spawnId ?? `${input.runId ?? input.projectId}:${spawnTextId(input.task)}`, ...(input.runId ? { lanePilotRunId: input.runId } : {}), ...(detached ? {} : { parentPmThreadId: input.pmThreadId }), helperMode: helperPolicy.mode, ...input.metadata },
    } as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("errand_thread_id_missing");
    return { threadId, browserMachine: setup.hostId };
  }

  /** The report of an errand thread that has ended: the helper's verdict and output, or `blocked` when it edited the repository (the `snapshot` of the checkout from before it started). */
  async function completedReport(threadId: string, projectId = "-", snapshot: ErrandSnapshot | null = null): Promise<{ state: "done" | "blocked"; reason?: string; output: string; files?: string[]; verified: ErrandVerified; checks: ErrandCheck[] }> {
    if (snapshot) {
      const afterStatus = await gitRepoStatus(host, snapshot.hostId, snapshot.cwd);
      const edited = afterStatus ? detectRepoEdits(new Set(snapshot.before), afterStatus, (f) => f.startsWith(".bb/chats/")) : [];
      if (edited.length > 0) return { state: "blocked", reason: "repo_edited", files: edited, output: `Helper edited repository files: ${edited.join(", ")}`, verified: "blocked", checks: [] };
    }
    const raw = (await bb.sdk.threads.output({ threadId })).output;
    const text = typeof raw === "string" ? raw : outputText(raw);
    const output = redactKnown(text);
    const verdict = errandVerdict(output);
    return { ...verdict, output, ...errandCheck(output, verdict.state) };
  }

  return { resolveAccounts, startErrand, errandSnapshot, completedReport, openRun };
}
export type ErrandCore = ReturnType<typeof createErrandCore>;
