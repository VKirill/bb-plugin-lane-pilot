import { SETTING_INSTALL_LAST_RECEIPT } from "@lane-pilot/settings-catalog";
import { SCHEDULE_ERRAND_DEFAULT_KEY } from "../../../../schedule";
import { HELPER_ROLES, roleAccessKey } from "../../../../contracts/helper-context";
import { detectCompiledMainAgentCapability } from "../../../../native-agent";
import { pickableAgent } from "../../../../contracts/agent-picker";
import type { BuildCliInvocation } from "../../../../platform/server";
import { cliReceiptAttemptKey, cliReceiptRunKey } from "../../../../runs";
import { casResetSettings, casUpsertSetting, casUpsertSettings, getReasoningTrace, countStageReceipts, getSettingVersions, getStageReceiptResult, listOwnSettingLevels, listRunsPage, listSettingRows, listStageReceiptSummaries, loadProjectSettings, loadPrototypeConfig, removeOwnSettings, sectionBindingId } from "../../../../storage";
import { isModelSettingKey, isRoleOverrideKey } from "../../../models/model-keys";
import { isSandboxProjectName } from "../../../../contracts";
import type { RunHistoryRow } from "../../../../storage";
import { writerServiceTier, findModelIn } from "@lane-pilot/models";
import { LP_DEFAULTS_KEY, inheritProjectValues, parseLanePilotDefaults } from "@lane-pilot/settings-catalog";
import { mapListedQaHosts } from "../../../../platform/server";
import { SETTINGS_REGISTRY } from "../../../../settings-registry";
import { NATIVE_WRITER_KEYS } from "../../../../runs/server";
import { asJsonText } from "../../../../contracts";
import { stringAt } from "@lane-pilot/kit";
import { PAIR_ROLE_SPECS, roleAtomicMessage } from "@lane-pilot/models";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../../contracts";
import type { ServerCore } from "../../../../contracts/server";
import { createHelperAccessView } from "../../services/access-view";

import type { WriterHostApi } from "../../../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  buildCliInvocation: BuildCliInvocation;
  listedAgentProfiles: WriterHostApi["listedAgentProfiles"];
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  selectionCatalog: WriterHostApi["selectionCatalog"];
  selectionCatalogHost: WriterHostApi["selectionCatalogHost"];
}


/** Runs the screen carries up front (plus every open one); older history comes page by page from `list_runs`. */
const SCREEN_RUNS_LIMIT = 10;

export function settingsRpc(ctx: ServerCore, services: Services) {
  const { bb, db, listProjectSections, screenWriterBinding, sectionChain, serializedKv, settingsAbove, writerBindingKey } = ctx;
  // Runs as the screen shows them: a stage count only; `list_run_stages` lists the rows and `get_stage_result` loads one body.
  const runViews = async (runs: RunHistoryRow[], values: Record<string, unknown>) => {
    const listed = runs.map((run) => ({
      id: run.id,
      state: run.closed_at ? "closed" : run.state,
      kind: run.kind,
      created_at: run.created_at,
      updated_at: run.updated_at,
      cliReceiptJson: asJsonText(values[cliReceiptRunKey(run.id)]),
      stageCount: countStageReceipts(db, run.id),
      attempts: run.attempts.map((attempt) => ({
        ...attempt,
        cliReceiptJson: asJsonText(values[cliReceiptAttemptKey(attempt.id)]),
      })),
    }));
    // Open runs carry their PM chat's title and status; closed ones are history and are not looked up.
    const pmThreads = new Map(await Promise.all(runs
      .filter((run) => !run.closed_at && run.pm_thread_id)
      .map(async (run) => {
        let thread: unknown = null;
        let status: string | null = null;
        try { thread = await bb.sdk.threads.get({ threadId: run.pm_thread_id! }); status = stringAt(thread, "status"); }
        catch (cause) { if (/\b404\b|not found/i.test(cause instanceof Error ? cause.message : String(cause))) status = "gone"; }
        return [run.id, { id: run.pm_thread_id!, title: stringAt(thread, "title"), status }] as const;
      })));
    return listed.map((run) => ({ ...run, pmThread: pmThreads.get(run.id) ?? null }));
  };
  const helperAccessView = createHelperAccessView(ctx);
  return {
    helper_access_view: helperAccessView,
    get_screen: async ({ projectId, sectionId, runsLimit }) => {
      // A section shows its own values over its parents', its project's and the global ones.
      const scopes = sectionId ? sectionChain(await listProjectSections(projectId), sectionId) : [];
      const bindingId = scopes.at(-1) ?? "";
      const config = loadPrototypeConfig(db, projectId);
      const settings = loadProjectSettings(db, projectId, scopes);
      const rows = listSettingRows(db, projectId, bindingId);
      const values = settingsAbove(projectId, scopes);
      const aboveKeys = Object.keys(values);
      const versions: Record<string, number> = {};
      for (const row of rows) {
        values[row.key] = row.value;
        versions[row.key] = row.version;
      }
      Object.assign(versions, getSettingVersions(db, projectId, SETTINGS_REGISTRY.visible.map((row) => row.storageKey), bindingId));
      const inherited = inheritProjectValues(values, parseLanePilotDefaults(await bb.storage.kv.get(LP_DEFAULTS_KEY)));
      const own = new Set(rows.map((row) => row.key));
      inherited.explicitKeys = [...own];
      inherited.inherited = [...new Set([...inherited.inherited, ...aboveKeys.filter((key) => !own.has(key))])];
      Object.assign(values, inherited.values);
      const writerBinding = await services.resolveProjectWriterHost({ projectId });
      values["plan_critique.enabled"] ??= true;
      values["plan_critique.mode"] ??= "gate";
      values["code_critique.enabled"] ??= false;
      values["code_critique.mode"] ??= "advisory";
      values["code_critique.auto_fix"] ??= true;
      values["code_critique.max_rounds"] ??= 1;
      if (config) {
        values["writer.provider"] ??= settings["writer.provider"] ?? config.writerProviderId;
        values["writer.model"] ??= settings["writer.model"] ?? config.writerModel;
      }
      values["writer.reasoning_effort"] ??= settings["writer.reasoning_effort"] ?? "medium";
      values["writer.service_tier"] ??= writerServiceTier(settings);
      if (config) {
        values["memory.provider"] ??= settings["memory.provider"] ?? values["writer.provider"];
        values["memory.model"] ??= settings["memory.model"] ?? values["writer.model"];
      }
      values["memory.reasoning_effort"] ??= settings["memory.reasoning_effort"] ?? values["writer.reasoning_effort"];
      values["memory.service_tier"] ??= settings["memory.service_tier"] ?? writerServiceTier(settings);
      const invocation = services.buildCliInvocation({
        binary: "run-controller",
        subcommand: "run",
        settings,
      });
      const unapplied = invocation.unapplied.map((item) => ({ key: item.key, reason: item.reason }));
      const runsWindow = runsLimit ?? SCREEN_RUNS_LIMIT;
      const page = listRunsPage(db, projectId, { limit: runsWindow, offset: 0, pinOpen: true });
      const listed = await runViews(page.runs, values);
      const latestReceipt = listed
        .flatMap((run) => [
          ...run.attempts.map((attempt) => attempt.cliReceiptJson),
          run.cliReceiptJson,
        ])
        .find((text) => text != null) ?? null;
      return {
        projectId,
        sectionId: sectionId ?? null,
        hostId: writerBinding.status === "resolved" ? writerBinding.hostId : writerBinding.status === "catalog_unavailable" ? null : config?.hostId ?? null,
        workspacePath: writerBinding.status === "resolved" ? writerBinding.path : writerBinding.status === "catalog_unavailable" ? null : config?.writerWorkspacePath ?? null,
        legacyStack: config !== null,
        inheritedKeys: inherited.inherited,
        explicitKeys: inherited.explicitKeys,
        writerBinding: screenWriterBinding(writerBinding),
        values,
        versions,
        runs: listed,
        runsTotal: page.total,
        runsLimit: runsWindow,
        unapplied,
        cliPreview: {
          argv: invocation.argv,
          env: invocation.env,
          applied: invocation.applied,
          unapplied,
        },
        lastSnapshotPath: typeof values["install.lastSnapshotPath"] === "string" ? values["install.lastSnapshotPath"] as string : null,
        lastReceiptJson: asJsonText(values[SETTING_INSTALL_LAST_RECEIPT]),
        writerResultJson: asJsonText(values["writer.lastResult"]),
        writerResultPatch: asJsonText(values["writer.lastPatch"]),
        cliReceiptJson: latestReceipt,
        qaHosts: await (async () => {
          try {
            const listed = await (bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.();
            return mapListedQaHosts(listed ?? []);
          } catch {
            return [];
          }
        })(),
        compiledMainAgent: detectCompiledMainAgentCapability(
          (bb as { agents?: { experimental_vkCompiledMainAgent?: unknown } }).agents ?? {},
        ),
        mainAgents: (await services.listedAgentProfiles({ pickable: true })).map(pickableAgent),
        lastWriterTrace: (() => {
          for (const run of listed) {
            for (const attempt of [...run.attempts].reverse()) {
              const trace = getReasoningTrace(db, attempt.id);
              if (!trace) continue;
              return {
                providerId: trace.providerId,
                model: trace.model,
                requestedReasoningLevel: trace.requestedReasoningLevel,
                effectiveReasoningLevel: trace.effectiveReasoningLevel,
                serviceTier: trace.serviceTier,
                fallbackReason: trace.fallbackReason,
                ...(trace.selectionSource ? { selectionSource: trace.selectionSource } : {}),
              };
            }
          }
          return null;
        })(),
      };
    },
    list_runs: async ({ projectId, sectionId, offset, limit, pinOpen }) => {
      const scopes = sectionId ? sectionChain(await listProjectSections(projectId), sectionId) : [];
      const page = listRunsPage(db, projectId, { limit, offset, pinOpen });
      return { runs: await runViews(page.runs, loadProjectSettings(db, projectId, scopes)), total: page.total };
    },
    list_run_stages: ({ runId }) => ({ stages: listStageReceiptSummaries(db, runId) }),
    get_stage_result: ({ runId, taskId, stageId }) => getStageReceiptResult(db, runId, taskId, stageId),
    save_setting: ({ projectId, sectionId, key, value, expectedVersion }) => {
      const bindingId = sectionId ? sectionBindingId(sectionId) : "";
      // A role's provider/model/effort/tier group is saved by its own RPC, never key by key (packages/models/role-specs.ts).
      for (const spec of PAIR_ROLE_SPECS) {
        const message = roleAtomicMessage(spec.id);
        if (message && spec.keys.includes(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,message]}};
      }
      if (!NATIVE_WRITER_KEYS.has(key)) {
        const result = casUpsertSettings(db, { projectId, bindingId, changes:[{ key, value, expectedVersion }] });
        const current = { version:result.versions[key] ?? 0, value:result.values[key] ?? null };
        if (!result.ok) {
          if (result.validation) return { ok:false, conflict:false, ...current, validation:result.validation };
          return { ok:false, conflict:true, ...current };
        }
        return { ok:true, conflict:false, version:current.version, value };
      }
      const result = casUpsertSetting(db, { projectId, bindingId, key, value, expectedVersion });
      if (!result.ok) {
        if ("validation" in result) return result;
        return { ok: false, conflict: true, version: result.version, value: result.value };
      }
      return { ok: true, conflict: false, version: result.version, value };
    },
    reset_project_settings: async ({ projectId, sectionId, keys, expectedVersions }) => serializedKv(async () => {
      const bindingId = sectionId ? sectionBindingId(sectionId) : "";
      const reject = (key: string, message: string) => ({ ok: false, conflict: false, values: {}, versions: {}, validation: { code: "incompatible_setting" as const, key, params: [key, message] } });
      const editable = new Set(SETTINGS_REGISTRY.editable.map((row) => row.storageKey));
      // Per-role access rows (helper.access.<role>), the schedule board's errand default and the writer's fallback models are not catalog settings; dropping the row lets the level below show through.
      const roleAccessKeys = new Set(HELPER_ROLES.map(roleAccessKey));
      const invalid = keys.find((key) => !(editable.has(key) || roleAccessKeys.has(key) || key === SCHEDULE_ERRAND_DEFAULT_KEY || isModelSettingKey(key)) || expectedVersions[key] === undefined);
      if (invalid) return reject(invalid, "unknown or noneditable setting / missing CAS version");
      const groups = PAIR_ROLE_SPECS.map((spec) => spec.keys);
      const affected = groups.filter((group) => group.some((key) => keys.includes(key)));
      if (affected.some((group) => group.some((key) => !keys.includes(key)))) return reject(keys[0]!, "reset the complete provider/model/effort/tier group");
      const rows = listSettingRows(db, projectId, bindingId);
      const scopes = sectionId ? sectionChain(await listProjectSections(projectId), sectionId) : [];
      const explicit = { ...settingsAbove(projectId, scopes), ...Object.fromEntries(rows.filter((row) => !keys.includes(row.key)).map((row) => [row.key, row.value])) };
      const effective = inheritProjectValues(explicit, parseLanePilotDefaults(await bb.storage.kv.get(LP_DEFAULTS_KEY))).values;
      if (affected.length) {
        const host = await services.selectionCatalogHost(projectId);
        if (!host.ok) return { ok: false, conflict: false, values: {}, versions: {}, validation: host.validation };
        try {
          for (const group of affected) {
            const providerId = effective[group[0]!] ?? effective["writer.provider"];
            const modelId = effective[group[1]!] ?? effective["writer.model"];
            if (typeof providerId !== "string" || typeof modelId !== "string") return reject(group[0]!, "inherited provider and model are not configured");
            // The catalog the saves judge against (0.1.445): on the global level the merged catalog of every connected machine, not this
            // host's alone, or a reset failed where the save had passed (Gemini F-016).
            const [providers, catalog] = await services.selectionCatalog(projectId, host.hostId, providerId);
            const provider = providers.find((item) => item.id === providerId && item.available);
            const model = findModelIn(catalog.models, modelId);
            if (!provider || !model) return reject(group[0]!, "inherited selection is unavailable in this host catalog");
            const effort = effective[group[2]!];
            if (effort && !model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) return reject(group[2]!, "inherited effort is unsupported");
            const tier = effective[group[3]!];
            if (tier && tier !== "standard" && !provider.serviceTiers?.some((item) => item.id === tier)) return reject(group[3]!, "inherited service tier is unsupported");
          }
        } catch { return reject(keys[0]!, "inherited catalog is unavailable"); }
      }
      return casResetSettings(db, { projectId, bindingId, keys, expectedVersions, validationKeys: [...new Set([...keys, ...affected.flat()])], validatedRows: rows });
    }),
    list_model_overrides: async () => {
      // Names are a courtesy: a project the host no longer lists is shown by its id.
      const projectNames = new Map<string, string>();
      try { for (const project of await bb.sdk.projects.list({ includePersonal: true })) projectNames.set(project.id, project.name); } catch { /* ids only */ }
      // «LP bench …» and the sandboxes pin their models on purpose (the bench compares them): never offered for the reset.
      const levels = listOwnSettingLevels(db, isRoleOverrideKey).filter((level) => !isSandboxProjectName(projectNames.get(level.projectId)));
      const sectionNames = new Map<string, string>();
      for (const projectId of new Set(levels.filter((level) => level.sectionId).map((level) => level.projectId))) {
        for (const section of await listProjectSections(projectId)) sectionNames.set(section.id, section.name);
      }
      return { levels: levels.map((level) => ({ ...level, projectName: projectNames.get(level.projectId) ?? null, sectionName: level.sectionId ? sectionNames.get(level.sectionId) ?? null : null })) };
    },
    reset_model_overrides: async ({ levels }) => {
      const sandbox = new Set<string>();
      try { for (const project of await bb.sdk.projects.list({ includePersonal: true })) if (isSandboxProjectName(project.name)) sandbox.add(project.id); } catch { /* the list was screened already */ }
      const kept = levels.filter((level) => !sandbox.has(level.projectId));
      return { ok: true, levels: kept.length, removed: removeOwnSettings(db, kept, isRoleOverrideKey) };
    },
    save_settings: ({ projectId, sectionId, changes }) => {
      const bindingId = sectionId ? sectionBindingId(sectionId) : "";
      for (const spec of PAIR_ROLE_SPECS) {
        const message = roleAtomicMessage(spec.id);
        if (!message) continue;
        const found = changes.find(({ key }) => spec.keys.includes(key))?.key;
        if (found) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:found,params:[found,message]}};
      }
      return casUpsertSettings(db,{projectId,bindingId,changes});
    },
    save_writer_binding: async ({ projectId, hostId, path }) => {
      const binding = await services.resolveProjectWriterHost({ projectId, selected: { hostId, path } });
      if (binding.status !== "resolved") return { ok: false };
      await bb.storage.kv.set(writerBindingKey(projectId), { hostId, path });
      return { ok: true };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "helper_access_view" | "get_screen" | "list_runs" | "list_run_stages" | "get_stage_result" | "save_setting" | "reset_project_settings" | "list_model_overrides" | "reset_model_overrides" | "save_settings" | "save_writer_binding">;
}
