import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { SCHEDULE_ERRAND_DEFAULT_KEY } from "../../../schedule/errand-model";
import { ACCESS_GROUPS, ACCESS_SWITCHES, CORE_PROVIDER_GROUPS, HELPER_ROLES, MANDATORY_BB_PLUGINS, MANDATORY_MCP_SERVERS, effectiveGroup, effectiveSwitch, parseHelperContextSettings, parseRoleAccess, roleAccessKey } from "../../../native-agent/helper-context";
import { detectCompiledMainAgentCapability } from "../../../native-agent/agent-profile";
import { buildCliInvocation } from "../../../writer/argv-builder";
import { cliReceiptAttemptKey, cliReceiptRunKey } from "../../../runs/constants";
import { casResetSettings, casUpsertSetting, casUpsertSettings, getReasoningTrace, countStageReceipts, getSettingVersions, getStageReceiptResult, listRunsPage, listSettingRows, listStageReceiptSummaries, loadProjectSettings, loadPrototypeConfig, sectionBindingId } from "../../../storage/database";
import type { RunHistoryRow } from "../../../storage/database";
import { writerServiceTier, findModelIn } from "@lane-pilot/models";
import { LP_DEFAULTS_KEY, inheritProjectValues, parseLanePilotDefaults } from "@lane-pilot/settings-catalog";
import { mapListedQaHosts } from "../../../qa/qa-host";
import { VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import { NATIVE_CODE_CRITIQUE_KEYS, NATIVE_DOCS_KEYS, NATIVE_MEMORY_KEYS, NATIVE_NIGHT_REVIEW_KEYS, NATIVE_ONBOARDING_KEYS, NATIVE_PLAN_CRITIQUE_KEYS, NATIVE_PM_READ_KEYS, NATIVE_PROJECT_LIFE_KEYS, NATIVE_SPECIALIST_KEYS, NATIVE_WRITER_KEYS } from "../../../runs/server/run-routing";
import { asJsonText } from "../../../writer/server/writer-task";
import { stringAt } from "../../../core/server/values";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../core/server/core";
import type { Services } from "../../../core/server/services";

/** Runs the screen carries up front (plus every open one); older history comes page by page from `list_runs`. */
const SCREEN_RUNS_LIMIT = 10;

export function settingsRpc(ctx: ServerCore, services: Services) {
  const { bb, cliSettingsFor, db, host, listProjectSections, screenWriterBinding, sectionChain, serializedKv, settingsAbove, writerBindingKey } = ctx;
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
  // The BB plugin list and the skills catalog cost host calls (the skills catalog is ~385 KB) and change rarely: kept per catalog project for a minute.
  const catalogCache = new Map<string, { at: number; value: { pluginRows: Array<{ id?: string; name?: string; displayName?: string }>; skillRows: Array<{ name?: string; description?: string }> } }>();
  const CATALOG_TTL_MS = 60_000;
  const loadCatalog = async (projectId: string, isGlobal: boolean) => {
    const cached = catalogCache.get(projectId);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    const pluginsRequest = (bb.sdk.plugins.list() as Promise<unknown>).catch(() => []);
    // The skills catalog of the project; some BB versions want an environment, so the project's own is tried next.
    // The global scope has no catalog of its own; the first project's stands in for it.
    const listedProjects = isGlobal ? await (bb.sdk.projects.list() as Promise<unknown>).catch(() => []) : [];
    const projectRows = (Array.isArray(listedProjects) ? listedProjects : ((listedProjects as { projects?: unknown[] })?.projects ?? [])) as Array<{ id?: string }>;
    const catalogProject = isGlobal ? projectRows.find((p) => p?.id)?.id ?? projectId : projectId;
    const listSkills = (environmentId: string | null) => bb.sdk.skills.list({ projectId: catalogProject, environmentId } as never) as Promise<unknown>;
    let skills: unknown = await listSkills(null).catch((cause) => { ctx.log(`helper_access_view skills: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
    if (!skills) {
      const envs = await (bb.sdk.environments.list({ projectId: catalogProject } as never) as Promise<unknown>).catch(() => []);
      const env = (Array.isArray(envs) ? envs : ((envs as { environments?: unknown[] })?.environments ?? [])) as Array<{ id?: string }>;
      if (env[0]?.id) skills = await listSkills(env[0].id).catch((cause) => { ctx.log(`helper_access_view skills (env): ${cause instanceof Error ? cause.message : String(cause)}`); return []; });
    }
    const skillRows = (Array.isArray(skills) ? skills : ((skills as { skills?: unknown[] })?.skills ?? [])) as Array<{ name?: string; description?: string }>;
    const plugins = await pluginsRequest;
    const pluginRows = (Array.isArray(plugins) ? plugins : ((plugins as { plugins?: unknown[] })?.plugins ?? [])) as Array<{ id?: string; name?: string; displayName?: string }>;
    const value = { pluginRows, skillRows };
    if (pluginRows.length || skillRows.length) catalogCache.set(projectId, { at: Date.now(), value });
    return value;
  };
  return {
    helper_access_view: async ({ projectId, sectionId }) => {
      const scopes = sectionId ? sectionChain(await listProjectSections(projectId), sectionId) : [];
      const bindingId = scopes.at(-1) ?? "";
      const settings = loadProjectSettings(db, projectId, scopes);
      const own = new Map(listSettingRows(db, projectId, bindingId).map((row) => [row.key, row]));
      const parsed = parseHelperContextSettings(settings);
      const versions = getSettingVersions(db, projectId, HELPER_ROLES.map(roleAccessKey), bindingId);
      // Where a key's value comes from: the deepest scope that holds a row for it.
      const isGlobal = projectId === GLOBAL_SETTINGS_PROJECT_ID;
      const scopeRows: Array<[ "global" | "project" | "section", Set<string>]> = [
        ...(isGlobal ? [] : [["global", new Set(listSettingRows(db, GLOBAL_SETTINGS_PROJECT_ID, "").map((row) => row.key))] as ["global", Set<string>]]),
        [isGlobal ? "global" : "project", new Set(listSettingRows(db, projectId, "").map((row) => row.key))],
        ...scopes.map((binding) => ["section", new Set(listSettingRows(db, projectId, binding).map((row) => row.key))] as ["section", Set<string>]),
      ];
      const originIn = (rows: typeof scopeRows, key: string) => { let found: "global" | "project" | "section" | null = null; for (const [name, keys] of rows) if (keys.has(key)) found = name; return found; };
      const originOf = (key: string) => originIn(scopeRows, key);
      // What the role falls back to when this level's change is removed: the origin one level up (none at the global level).
      const originBelow = (key: string) => isGlobal ? null : originIn(scopeRows.slice(0, -1), key);
      const roles = HELPER_ROLES.map((role) => {
        const key = roleAccessKey(role);
        const access = parseRoleAccess(settings[key]);
        return {
          role, key, version: versions[key] ?? 0, value: own.get(key)?.value ?? null,
          inherited: !own.has(key) && settings[key] !== undefined,
          origin: originOf(key),
          originBelow: originBelow(key),
          groups: Object.fromEntries(ACCESS_GROUPS.map((group) => [group, effectiveGroup(role, group, access)])) as never,
          switches: Object.fromEntries(ACCESS_SWITCHES.map((sw) => [sw, effectiveSwitch(sw, access)])) as never,
        };
      });
      const { pluginRows, skillRows } = await loadCatalog(projectId, isGlobal);
      return {
        mode: parsed.ok ? parsed.settings.mode : "invalid",
        modeOrigin: originOf("helper.context_mode"),
        roles,
        catalog: {
          bbPlugins: pluginRows.filter((p) => typeof p.id === "string").map((p) => ({ id: p.id!, name: p.displayName ?? p.name ?? p.id! })).sort((a, b) => a.id.localeCompare(b.id)),
          skills: [...new Map(skillRows.filter((k) => typeof k.name === "string").map((k) => [k.name!, { name: k.name!, description: (k.description ?? "").slice(0, 200) }])).values()].sort((a, b) => a.name.localeCompare(b.name)),
        },
        mandatory: { bbPlugins: [...MANDATORY_BB_PLUGINS], mcpServers: [...MANDATORY_MCP_SERVERS] },
        providers: Object.fromEntries(Object.entries(CORE_PROVIDER_GROUPS).map(([id, groups]) => [id, [...groups]])),
      };
    },
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
      Object.assign(versions, getSettingVersions(db, projectId, [...new Set(VISIBLE_CATALOG.map((row) => row.storageKey))], bindingId));
      const inherited = inheritProjectValues(values, parseLanePilotDefaults(await bb.storage.kv.get(LP_DEFAULTS_KEY)));
      const own = new Set(rows.map((row) => row.key));
      inherited.explicitKeys = [...own];
      inherited.inherited = [...new Set([...inherited.inherited, ...aboveKeys.filter((key) => !own.has(key))])];
      Object.assign(values, inherited.values);
      const writerBinding = await services.resolveProjectWriterHost({ projectId });
      for (const row of VISIBLE_CATALOG) {
        if (!(row.storageKey in values)) {
          if (row.storageKey === "jev.LANE_JEV_EFFORT" || row.storageKey === "jev.LANE_OPENCODE_JEV") {
            values[row.storageKey] = "1";
          }
        }
      }
      values["plan_critique.enabled"] ??= true;
      values["plan_critique.mode"] ??= "gate";
      values["code_critique.enabled"] ??= false;
      values["code_critique.mode"] ??= "gate";
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
      const completed = values["import.completed"];
      const routing = values["import.routing_profile"];
      const night = values["import.night_shift"];
      const invocation = buildCliInvocation({
        binary: "run-controller",
        subcommand: "run",
        settings: config ? await cliSettingsFor(projectId, config) : settings,
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
        importSource: {
          completed: Boolean(completed),
          at: completed && typeof completed === "object" && completed && "at" in completed
            ? Number((completed as { at?: number }).at ?? null)
            : null,
          routingPath: routing && typeof routing === "object" && routing && "path" in routing
            ? String((routing as { path?: string }).path ?? "") || null
            : null,
          nightPath: night && typeof night === "object" && night && "path" in night
            ? String((night as { path?: string }).path ?? "") || null
            : null,
        },
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
        lastReceiptJson: asJsonText(values["install.lastReceipt"]),
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
        mainAgents: (await services.listedAgentProfiles()).map((row) => ({ id: row.id, description: row.description })),
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
                jevStatus: trace.jevStatus,
                ...(trace.effortMode ? { effortMode: trace.effortMode } : {}),
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
      if (NATIVE_MEMORY_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic memory provider/model selection"]}};
      if (NATIVE_NIGHT_REVIEW_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic night-review provider/model selection"]}};
      if (NATIVE_DOCS_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic docs provider/model selection"]}};
      if (NATIVE_PROJECT_LIFE_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic project-life provider/model selection"]}};
      if (NATIVE_ONBOARDING_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic onboarding provider/model selection"]}};
      if (NATIVE_PM_READ_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic PM-read provider/model selection"]}};
      if (NATIVE_PLAN_CRITIQUE_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic plan-critique provider/model selection"]}};
      if (NATIVE_CODE_CRITIQUE_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic code-critique provider/model selection"]}};
      if (NATIVE_SPECIALIST_KEYS.has(key)) return {ok:false,conflict:false,version:expectedVersion,value,validation:{code:"incompatible_setting" as const,key,params:[key,"use atomic specialist provider/model selection"]}};
      if (!NATIVE_WRITER_KEYS.has(key)) {
        const result = casUpsertSettings(db, { projectId, bindingId, changes:[{ key, value, expectedVersion }] }, { nativeWriterSelection:true });
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
      const editable = new Set(VISIBLE_CATALOG.filter((row) => row.uiStatus === "editable").map((row) => row.storageKey));
      // Per-role access rows (helper.access.<role>) and the schedule board's errand default are not catalog settings; dropping the row lets the level below show through.
      const roleAccessKeys = new Set(HELPER_ROLES.map(roleAccessKey));
      const invalid = keys.find((key) => !(editable.has(key) || roleAccessKeys.has(key) || key === SCHEDULE_ERRAND_DEFAULT_KEY) || expectedVersions[key] === undefined);
      if (invalid) return reject(invalid, "unknown or noneditable setting / missing CAS version");
      const groups = ["writer", "memory", "night_review", "docs", "project_life", "onboarding", "pm_read", "plan_critique", "code_critique", "specialist"].map((prefix) => ["provider", "model", "reasoning_effort", "service_tier"].map((suffix) => `${prefix}.${suffix}`));
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
          const providers = await bb.sdk.providers.list({ hostId: host.hostId });
          for (const group of affected) {
            const providerId = effective[group[0]!] ?? effective["writer.provider"];
            const modelId = effective[group[1]!] ?? effective["writer.model"];
            if (typeof providerId !== "string" || typeof modelId !== "string") return reject(group[0]!, "inherited provider and model are not configured");
            const provider = providers.find((item) => item.id === providerId && item.available);
            const catalog = await bb.sdk.providers.models({ hostId: host.hostId, providerId });
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
    save_settings: ({ projectId, sectionId, changes }) => {
      const bindingId = sectionId ? sectionBindingId(sectionId) : "";
      const memoryKey=changes.find(({key})=>NATIVE_MEMORY_KEYS.has(key))?.key;
      if(memoryKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:memoryKey,params:[memoryKey,"use atomic memory provider/model selection"]}};
      const nightKey=changes.find(({key})=>NATIVE_NIGHT_REVIEW_KEYS.has(key))?.key;
      if(nightKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:nightKey,params:[nightKey,"use atomic night-review provider/model selection"]}};
      const docsKey=changes.find(({key})=>NATIVE_DOCS_KEYS.has(key))?.key;
      if(docsKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:docsKey,params:[docsKey,"use atomic docs provider/model selection"]}};
      const projectLifeKey=changes.find(({key})=>NATIVE_PROJECT_LIFE_KEYS.has(key))?.key;
      if(projectLifeKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:projectLifeKey,params:[projectLifeKey,"use atomic project-life provider/model selection"]}};
      const onboardingKey=changes.find(({key})=>NATIVE_ONBOARDING_KEYS.has(key))?.key;
      if(onboardingKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:onboardingKey,params:[onboardingKey,"use atomic onboarding provider/model selection"]}};
      const pmReadKey=changes.find(({key})=>NATIVE_PM_READ_KEYS.has(key))?.key;
      if(pmReadKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:pmReadKey,params:[pmReadKey,"use atomic PM-read provider/model selection"]}};
      const planKey=changes.find(({key})=>NATIVE_PLAN_CRITIQUE_KEYS.has(key))?.key;
      if(planKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:planKey,params:[planKey,"use atomic plan-critique provider/model selection"]}};
      const codeKey=changes.find(({key})=>NATIVE_CODE_CRITIQUE_KEYS.has(key))?.key;
      if(codeKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:codeKey,params:[codeKey,"use atomic code-critique provider/model selection"]}};
      const specialistKey=changes.find(({key})=>NATIVE_SPECIALIST_KEYS.has(key))?.key;
      if(specialistKey) return {ok:false,conflict:false,values:{},versions:{},validation:{code:"incompatible_setting" as const,key:specialistKey,params:[specialistKey,"use atomic specialist provider/model selection"]}};
      return casUpsertSettings(db,{projectId,bindingId,changes},{nativeWriterSelection:changes.every(({key})=>!NATIVE_WRITER_KEYS.has(key))});
    },
    save_writer_binding: async ({ projectId, hostId, path }) => {
      const binding = await services.resolveProjectWriterHost({ projectId, selected: { hostId, path } });
      if (binding.status !== "resolved") return { ok: false };
      await bb.storage.kv.set(writerBindingKey(projectId), { hostId, path });
      return { ok: true };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "helper_access_view" | "get_screen" | "list_runs" | "list_run_stages" | "get_stage_result" | "save_setting" | "reset_project_settings" | "save_settings" | "save_writer_binding">;
}
