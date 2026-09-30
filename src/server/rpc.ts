import { t } from "../../i18n";
import { agentPickerLabel } from "../agent-display";
import { applyResourceMode, collectAgentInventory } from "../agent-inventory";
import { MAIN_AGENT_PROFILE_IDS, compileEffectiveMainAgent, compileMainAgentProfile, detectCompiledMainAgentCapability } from "../agent-profile";
import { buildCliInvocation } from "../argv-builder";
import { cliReceiptAttemptKey, cliReceiptRunKey } from "../constants";
import { rpcContract } from "../contracts";
import { casResetSettings, casUpsertSetting, casUpsertSettings, countAttempts, createAttempt, getActivation, getAttempt, getReasoningTrace, getSettingVersions, getTask, getTaskPlan, listRunsWithAttempts, listSettingRows, listStageReceipts, loadProjectSettings, loadPrototypeConfig, saveProjectSetting, sectionBindingId, transitionAttempt } from "../database";
import { detectRequiredSessionPolicyCapability } from "../helper-context";
import { writerServiceTier } from "../jev-reasoning";
import { LP_AGENT_OVERRIDES_KEY, LP_DEFAULTS_KEY, inheritProjectValues, packStoredDefaults, parseDefaultsRevision, parseLanePilotDefaults } from "../lp-defaults";
import { sessionOverrideAgentsJson } from "../native-agent-definition";
import { prepareNativeSessionRecord } from "../native-dispatch";
import { DEFAULT_NATIVE_AGENT, nativeAgentCliId, nativeSelectionSchema } from "../native-session";
import { compatibleReasoningLevel, compatibleServiceTier } from "../picker-compat";
import { userVisibleProjects } from "../project-scope";
import { mapListedQaHosts } from "../qa-host";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../state-machine";
import type { AttemptState } from "../state-machine";
import { VISIBLE_CATALOG } from "../ui-catalog";
import { cancelRejection, finishRunSafely } from "./run-finish";
import { NATIVE_CODE_CRITIQUE_KEYS, NATIVE_DOCS_KEYS, NATIVE_MEMORY_KEYS, NATIVE_NIGHT_REVIEW_KEYS, NATIVE_ONBOARDING_KEYS, NATIVE_PLAN_CRITIQUE_KEYS, NATIVE_PM_READ_KEYS, NATIVE_PROJECT_LIFE_KEYS, NATIVE_SPECIALIST_KEYS, NATIVE_WRITER_KEYS } from "./run-routing";
import { recordStage } from "./stage-records";
import { id, stringAt, valueAt } from "./values";
import { asJsonText } from "./writer-task";
import type { ServerCore } from "./core";
import type { Services } from "./services";

export function registerRpc(ctx: ServerCore, services: Services) {
  const { bb, cancelQueuedAttempt, cliSettingsFor, coexistenceInventory, coexistenceOperation, db, effectiveProjectSettings, host, listProjectSections, nativeInstaller, ownedAgents, screenWriterBinding, sectionChain, serializedKv, settingsAbove, writerBindingKey } = ctx;

  bb.rpc.register(rpcContract, {
    get_preferences: async ({ suggestedLocale }) => {
      const storedLocale = await bb.storage.kv.get<string>("preferences:locale");
      const lastProjectId = await bb.storage.kv.get<string>("preferences:lastProjectId");
      const preference: "auto" | "en" | "ru" = storedLocale === "ru" || storedLocale === "en" ? storedLocale : "auto";
      const resolvedLocale: "en" | "ru" = preference === "auto" ? suggestedLocale : preference;
      if (storedLocale !== preference) await bb.storage.kv.set("preferences:locale", preference);
      return { locale: resolvedLocale, preference, lastProjectId: lastProjectId ?? null };
    },
    set_locale: async ({ locale: preference, suggestedLocale }) => {
      await bb.storage.kv.set("preferences:locale", preference);
      const locale = preference === "auto" ? suggestedLocale : preference;
      return { locale, preference };
    },
    remember_project: async ({ projectId }) => {
      await bb.storage.kv.set("preferences:lastProjectId", projectId);
      return { ok: true as const };
    },
    list_sections: async ({ projectId }) => ({
      sections: (await listProjectSections(projectId)).map((row) => ({ id:row.id, parentId:row.parentId, name:row.name, path:row.path, kind:row.kind })),
    }),
    list_projects: async () => {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind === "personal" || row.kind === "standard" ? row.kind : undefined,
        })),
        lastProjectId: await bb.storage.kv.get<string>("preferences:lastProjectId") ?? null,
      };
    },
    get_globals: async () => {
      const raw = await bb.storage.kv.get(LP_DEFAULTS_KEY);
      let hosts: Array<{ id: string; name: string; status: string; connected: boolean }> = [];
      try {
        const listed = await (bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.();
        hosts = mapListedQaHosts(listed ?? []);
      } catch {
        hosts = [];
      }
      return {
        defaults: parseLanePilotDefaults(raw),
        revision: parseDefaultsRevision(raw),
        agents: await services.listedAgentProfiles(),
        hosts,
        requiredSessionPolicy: detectRequiredSessionPolicyCapability((bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {}) ? "required" : "none",
      };
    },
    get_agent_inventory: async ({ projectId, hostId }) => {
      let resolvedProject = projectId ?? await bb.storage.kv.get<string>("preferences:lastProjectId") ?? null;
      if (!resolvedProject) {
        try {
          const listed = await bb.sdk.projects.list({ includePersonal: true });
          resolvedProject = userVisibleProjects(listed.map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind === "personal" || row.kind === "standard" ? row.kind : undefined,
          })))[0]?.id ?? null;
        } catch {
          resolvedProject = null;
        }
      }
      let resolvedHost = hostId;
      if (!resolvedHost) {
        try {
          const listed = await (bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.();
          const hosts = mapListedQaHosts(listed ?? []);
          resolvedHost = hosts.find((row) => row.connected)?.id ?? hosts[0]?.id ?? null;
        } catch {
          resolvedHost = null;
        }
      }
      return collectAgentInventory({
        projectId: resolvedProject,
        listSkills: resolvedProject
          ? async (id) => {
            const listed = await bb.sdk.skills.list({ projectId: id, environmentId: null });
            return listed.skills.map((skill) => ({ name: skill.name, pluginId: skill.pluginId }));
          }
          : undefined,
        listMcp: resolvedHost
          ? async () => {
            const machine = await host.call("session_inventory", { cwd: null }, { hostId: resolvedHost });
            return machine.mcpServers;
          }
          : undefined,
      });
    },
    save_globals: async ({ defaults, expectedRevision }) => serializedKv(async () => {
      const raw = await bb.storage.kv.get(LP_DEFAULTS_KEY);
      const revision = parseDefaultsRevision(raw);
      if (revision !== expectedRevision) {
        return { ok: false, revision, defaults: parseLanePilotDefaults(raw) };
      }
      const next = parseLanePilotDefaults(defaults);
      const nextRevision = revision + 1;
      await bb.storage.kv.set(LP_DEFAULTS_KEY, packStoredDefaults(next, nextRevision));
      return { ok: true, revision: nextRevision, defaults: next };
    }),
    save_agent_profile: async ({ id, prompt, description, expectedSourceHash, tools, disallowedTools, skills, mcpServers, resourceModes }) => serializedKv(async () => {
      const owned = await ownedAgents();
      if (owned[id]?.compiledCorrupt) return { ok: false, id, sourceHash: "" };
      const previous = owned[id]?.compiled;
      let currentHash = "";
      try { currentHash = compileEffectiveMainAgent(id, owned[id]).sourceHash; } catch { currentHash = previous?.sourceHash ?? ""; }
      if (expectedSourceHash !== currentHash && expectedSourceHash !== (previous?.sourceHash ?? "")) {
        return { ok: false, id, sourceHash: currentHash };
      }
      let compiled;
      try {
        const nextTools = applyResourceMode(resourceModes?.tools, tools, previous?.tools);
        const nextDisallowed = applyResourceMode(resourceModes?.disallowedTools, disallowedTools, previous?.disallowedTools);
        const nextSkills = applyResourceMode(resourceModes?.skills, skills, previous?.skills);
        const nextMcp = applyResourceMode(resourceModes?.mcpServers, mcpServers, previous?.mcpServers);
        compiled = compileMainAgentProfile(id, {
          prompt,
          description: description ?? previous?.description,
          ...(nextTools !== undefined ? { tools: nextTools } : {}),
          ...(nextDisallowed !== undefined ? { disallowedTools: nextDisallowed } : {}),
          ...(nextSkills !== undefined ? { skills: nextSkills } : {}),
          ...(nextMcp !== undefined ? { mcpServers: nextMcp } : {}),
        });
      } catch {
        return { ok: false, id, sourceHash: currentHash };
      }
      owned[id] = { prompt, ...(description ? { description } : {}), compiled };
      await bb.storage.kv.set(LP_AGENT_OVERRIDES_KEY, owned);
      return { ok: true, id, sourceHash: compiled.sourceHash };
    }),
    finish_run: async ({ projectId, runId }) => {
      await finishRunSafely(bb, db, projectId, runId, "rpc");
      return { projectId, finishedRunIds: [runId], closed: true };
    },
    activate_pm: ({ projectId, sourceThreadId, agentId, snapshot }) => {
      return services.activate(projectId, sourceThreadId, "bb", agentId, snapshot);
    },
    native_install_start: async ({ hostId }) => {
      await nativeInstaller.start(hostId);
      return { started: true };
    },
    prepare_native_session: async ({ projectId, agentId }) => {
      const shortId = nativeAgentCliId(agentId || DEFAULT_NATIVE_AGENT);
      const owned = await ownedAgents();
      const stored = owned[shortId];
      if (stored?.compiledCorrupt) throw new Error(`compiled_main_agent_corrupt:${shortId}`);
      let compiled = null;
      try { compiled = compileEffectiveMainAgent(shortId, stored); } catch { compiled = null; }
      const stock = (MAIN_AGENT_PROFILE_IDS as readonly string[]).includes(shortId) ? compileMainAgentProfile(shortId) : null;
      const edited = compiled && stock ? compiled.sourceHash !== stock.sourceHash : Boolean(compiled && !stock);
      if (!compiled && !stock) throw new Error(`Unknown Lane Pilot profile ${shortId}.`);
      const profileMode = edited ? "session-override" as const : "installed" as const;
      const agentsJson = sessionOverrideAgentsJson({ agentId: shortId, edited: true, compiled: compiled ?? stock });
      const record = await prepareNativeSessionRecord({
        projectId,
        agentId: shortId,
        profileMode,
        agentsJson,
        sourceHash: compiled?.sourceHash ?? null,
      });
      await bb.storage.kv.set(`native-selection:${record.token}`, record);
      const label = agentPickerLabel({
        id: shortId,
        description: compiled?.description ?? shortId,
      }, t);
      return { token: record.token, label, agentId: shortId, profileMode, cliAgentsCollision: null };
    },
    native_thread: async ({ threadId }) => {
      const selected = await bb.storage.kv.get(`native-thread:${threadId}`);
      if (!selected) return null;
      const parsed = nativeSelectionSchema.parse(selected);
      const agentType = await bb.storage.kv.get<string>(`native-agent-type:${threadId}`) ?? parsed.agentId;
      let shortId = parsed.agentId;
      try { shortId = nativeAgentCliId(agentType); } catch { shortId = parsed.agentId; }
      const stored = (await ownedAgents())[shortId];
      let compiled = null;
      try { compiled = compileEffectiveMainAgent(shortId, stored); } catch { compiled = null; }
      return {
        token: parsed.token,
        agentId: parsed.agentId,
        agentType,
        projectId: parsed.projectId,
        description: compiled?.description ?? shortId,
      };
    },
    activation_context: async ({ projectId, threadId }) => {
      const listed = await bb.sdk.projects.list({ includePersonal: true });
      const projects = userVisibleProjects(listed.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind === "personal" || row.kind === "standard" ? row.kind : undefined,
      }))).map((row) => ({ id: row.id, name: row.name }));
      let bindingStatus: "resolved" | "ambiguous" | "setup_required" | "offline" | "catalog_unavailable" | null = null;
      let writer = { providerId: null as string | null, model: null as string | null, reasoningEffort: null as string | null };
      let liveRun: { threadId: string; runId: string } | null = null;
      if (projectId) {
        const binding = await services.resolveProjectWriterHost({ projectId });
        bindingStatus = binding.status;
        const settings = (await effectiveProjectSettings(projectId)).values;
        writer = {
          providerId: typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : null,
          model: typeof settings["writer.model"] === "string" ? settings["writer.model"] as string : null,
          reasoningEffort: typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : null,
        };
        const activation = getActivation(db, projectId);
        if (activation && !activation.pm_thread_id.startsWith("pending:")) {
          liveRun = { threadId: activation.pm_thread_id, runId: activation.run_id };
        }
      }
      let pluginRole: string | null = null;
      let threadStatus: string | null = null;
      if (threadId) {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null);
        const role = valueAt(metadata, "role");
        pluginRole = typeof role === "string" ? role : null;
        const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
        threadStatus = stringAt(thread, "status");
      }
      return {
        projectId,
        projects,
        bindingStatus,
        compiledMainAgent: detectCompiledMainAgentCapability(
          (bb as { agents?: { experimental_vkCompiledMainAgent?: unknown } }).agents ?? {},
        ),
        mainAgents: (await services.listedAgentProfiles()).map((row) => ({ id: row.id, description: row.description })),
        writer,
        liveRun,
        pluginRole,
        threadStatus,
        requiredSessionPolicy: detectRequiredSessionPolicyCapability((bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {}) ? "required" : "none",
      };
    },
    get_screen: async ({ projectId, sectionId }) => {
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
      const listed = listRunsWithAttempts(db, projectId).map((run) => {
        const runReceipt = asJsonText(values[cliReceiptRunKey(run.id)]);
        return {
          id:run.id,
          state: run.closed_at ? "closed" : run.state,
          kind:run.kind,
          created_at:run.created_at,
          updated_at:run.updated_at,
          cliReceiptJson: runReceipt,
          stages:listStageReceipts(db, run.id),
          attempts: run.attempts.map((attempt) => ({
            ...attempt,
            cliReceiptJson: asJsonText(values[cliReceiptAttemptKey(attempt.id)]),
          })),
        };
      });
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
      const invalid = keys.find((key) => !editable.has(key) || expectedVersions[key] === undefined);
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
            const model = catalog.models.find((item) => item.id === modelId || item.model === modelId);
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
    save_writer_selection: async ({ projectId, sectionId, threadId, selectedBinding, providerId, model: modelId, reasoningLevel, serviceTier, expectedVersions }) => {
      const reject = (code:"invalid_choice"|"incompatible_setting"|"setup_required"|"writer_binding_ambiguous"|"writer_host_offline"|"catalog_unavailable", key:string, message:string) => ({
        ok:false, conflict:false, values:{}, versions:{}, validation:{ code, key, params:[key, message] },
      });
      const catalogHost = await services.selectionCatalogHost(projectId, threadId, selectedBinding);
      if (!catalogHost.ok) return { ok:false, conflict:false, values:{}, versions:{}, validation:catalogHost.validation };
      const catalogHostId = catalogHost.hostId;
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>;
      let catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {
        [providers, catalog] = await Promise.all([
          bb.sdk.providers.list({ hostId:catalogHostId }),
          bb.sdk.providers.models({ providerId, hostId:catalogHostId }),
        ]);
      } catch {
        return reject("catalog_unavailable", "writer.provider", catalogHostId);
      }
      const provider = providers.find((item) => item.id === providerId && item.available);
      if (!provider) return reject("invalid_choice", "writer.provider", `provider ${providerId} is unavailable on this host`);
      const selectedModel = catalog.models.find((item) => item.id === modelId || item.model === modelId);
      if (!selectedModel) return reject("invalid_choice", "writer.model", `model ${modelId} is not in the live catalog for ${providerId}`);
      const supportedEfforts = selectedModel.supportedReasoningEfforts.map((item) => item.reasoningEffort);
      const catalogDefault = typeof selectedModel.defaultReasoningEffort === "string"
        ? selectedModel.defaultReasoningEffort
        : undefined;
      const selectedEffort = compatibleReasoningLevel(reasoningLevel, supportedEfforts, catalogDefault);
      if (!selectedEffort) {
        const reason = catalogDefault && !supportedEfforts.includes(catalogDefault)
          ? `malformed_catalog_defaultReasoningEffort:${catalogDefault}`
          : `model supports: ${supportedEfforts.join(", ") || "none"}`;
        return reject("incompatible_setting", "writer.reasoning_effort", reason);
      }
      const supportedTiers = provider.serviceTiers?.map((tier) => tier.id) ?? [];
      const selectedTier = compatibleServiceTier(serviceTier, supportedTiers);
      if (serviceTier && supportedTiers.length > 0 && !selectedTier) {
        return reject("invalid_choice", "writer.service_tier", `provider supports: ${supportedTiers.join(", ") || "no service tiers"}`);
      }
      return casUpsertSettings(db, {
        projectId,
        bindingId: sectionId ? sectionBindingId(sectionId) : "",
        changes:[
          { key:"writer.provider", value:providerId, expectedVersion:expectedVersions["writer.provider"] },
          { key:"writer.model", value:modelId, expectedVersion:expectedVersions["writer.model"] },
          { key:"writer.reasoning_effort", value:selectedEffort, expectedVersion:expectedVersions["writer.reasoning_effort"] },
          { key:"writer.service_tier", value:selectedTier === "fast" ? "fast" : "standard", expectedVersion:expectedVersions["writer.service_tier"] },
        ],
      }, { nativeWriterSelection:true });
    },
    save_memory_selection: async ({projectId,sectionId, providerId, model: modelId, reasoningLevel, serviceTier, expectedVersions }) => {
      const reject = (code:"invalid_choice"|"incompatible_setting"|"setup_required"|"writer_binding_ambiguous"|"writer_host_offline"|"catalog_unavailable", key:string, message:string) => ({
        ok:false, conflict:false, values:{}, versions:{}, validation:{code,key,params:[key,message]},
      });
      const binding=await services.resolveProjectWriterHost({projectId});
      if(binding.status==="catalog_unavailable") return reject("catalog_unavailable","project.sources",binding.reason);
      if(binding.status==="setup_required") return reject("setup_required","project.sources","project_folders_source_required");
      if(binding.status==="ambiguous") return reject("writer_binding_ambiguous","project.sources","select_existing_project_binding");
      if(binding.status==="offline") return reject("writer_host_offline","project.sources",binding.hostId);
      const catalogHostId=binding.hostId;
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>;
      let catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {
        [providers,catalog]=await Promise.all([
          bb.sdk.providers.list({hostId:catalogHostId}),
          bb.sdk.providers.models({providerId,hostId:catalogHostId}),
        ]);
      } catch {
        return reject("catalog_unavailable","memory.provider",catalogHostId);
      }
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","memory.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","memory.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const supportedEfforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!supportedEfforts.includes(reasoningLevel)) return reject("incompatible_setting","memory.reasoning_effort",`model supports: ${supportedEfforts.join(", ")}`);
      const supportedTiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&supportedTiers.includes("default")?"default":null);
      if(selectedTier&&!supportedTiers.includes(selectedTier)) return reject("invalid_choice","memory.service_tier",`provider supports: ${supportedTiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"memory.provider",value:providerId,expectedVersion:expectedVersions["memory.provider"]},
        {key:"memory.model",value:modelId,expectedVersion:expectedVersions["memory.model"]},
        {key:"memory.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["memory.reasoning_effort"]},
        {key:"memory.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["memory.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_night_review_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","night_review.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","night_review.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","night_review.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","night_review.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","night_review.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"night_review.provider",value:providerId,expectedVersion:expectedVersions["night_review.provider"]},
        {key:"night_review.model",value:modelId,expectedVersion:expectedVersions["night_review.model"]},
        {key:"night_review.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["night_review.reasoning_effort"]},
        {key:"night_review.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["night_review.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_docs_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","docs.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","docs.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","docs.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","docs.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","docs.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"docs.provider",value:providerId,expectedVersion:expectedVersions["docs.provider"]},
        {key:"docs.model",value:modelId,expectedVersion:expectedVersions["docs.model"]},
        {key:"docs.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["docs.reasoning_effort"]},
        {key:"docs.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["docs.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_project_life_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","project_life.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","project_life.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","project_life.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","project_life.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","project_life.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"project_life.provider",value:providerId,expectedVersion:expectedVersions["project_life.provider"]},
        {key:"project_life.model",value:modelId,expectedVersion:expectedVersions["project_life.model"]},
        {key:"project_life.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["project_life.reasoning_effort"]},
        {key:"project_life.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["project_life.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_pm_read_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","pm_read.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","pm_read.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","pm_read.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","pm_read.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","pm_read.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"pm_read.provider",value:providerId,expectedVersion:expectedVersions["pm_read.provider"]},
        {key:"pm_read.model",value:modelId,expectedVersion:expectedVersions["pm_read.model"]},
        {key:"pm_read.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["pm_read.reasoning_effort"]},
        {key:"pm_read.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["pm_read.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_onboarding_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","onboarding.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","onboarding.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","onboarding.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","onboarding.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","onboarding.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"onboarding.provider",value:providerId,expectedVersion:expectedVersions["onboarding.provider"]},
        {key:"onboarding.model",value:modelId,expectedVersion:expectedVersions["onboarding.model"]},
        {key:"onboarding.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["onboarding.reasoning_effort"]},
        {key:"onboarding.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["onboarding.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_plan_critique_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","plan_critique.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","plan_critique.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","plan_critique.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","plan_critique.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","plan_critique.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"plan_critique.provider",value:providerId,expectedVersion:expectedVersions["plan_critique.provider"]},
        {key:"plan_critique.model",value:modelId,expectedVersion:expectedVersions["plan_critique.model"]},
        {key:"plan_critique.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["plan_critique.reasoning_effort"]},
        {key:"plan_critique.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["plan_critique.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_code_critique_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","code_critique.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","code_critique.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","code_critique.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","code_critique.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","code_critique.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"code_critique.provider",value:providerId,expectedVersion:expectedVersions["code_critique.provider"]},
        {key:"code_critique.model",value:modelId,expectedVersion:expectedVersions["code_critique.model"]},
        {key:"code_critique.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["code_critique.reasoning_effort"]},
        {key:"code_critique.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["code_critique.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_specialist_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","specialist.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","specialist.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","specialist.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","specialist.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","specialist.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"specialist.provider",value:providerId,expectedVersion:expectedVersions["specialist.provider"]},
        {key:"specialist.model",value:modelId,expectedVersion:expectedVersions["specialist.model"]},
        {key:"specialist.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["specialist.reasoning_effort"]},
        {key:"specialist.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["specialist.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    cancel_attempt: async ({ attemptId }) => {
      const attempt = getAttempt(db, attemptId);
      if (!attempt) return { ok: false, state: "missing", reason: "attempt does not exist" };
      if (!attempt.thread_id) return cancelQueuedAttempt(attempt);
      const rejection = cancelRejection(db, attempt);
      if (rejection) return { ok:false, state:attempt.state, reason:rejection };
      transitionAttempt(db, attempt.id, "cancel_requested", { threadId: attempt.thread_id });
      await bb.sdk.threads.stop({ threadId: attempt.thread_id });
      const observed = await bb.sdk.threads.get({ threadId: attempt.thread_id });
      const status = stringAt(observed, "status");
      const listRunning = (bb.sdk.threads as { listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>> }).listRunning;
      const running = listRunning ? await listRunning({}) : [];
      const stillRunning = running.some((thread) => thread.id === attempt.thread_id)
        || status === "active" || status === "running";
      if (stillRunning) return { ok: false, state: "cancel_requested", reason: `writer stop was not independently observed (status=${status ?? "unknown"})` };
      transitionAttempt(db, attempt.id, "canceled", { threadId: attempt.thread_id });
      const task = getTask(db, attempt.task_id);
      const plan = getTaskPlan(db, attempt.task_id) ?? (task?.kind === "bb" ? valueAt(task.contract, "objective") : "") as string;
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, attempt.run_id, attempt.task_id).find((row) => row.stageId === stageId);
        if (current && (current.state === "pending" || current.state === "running")) {
          recordStage(db, { runId:attempt.run_id, taskId:attempt.task_id, stageId, state:"canceled", input:plan,
            attempt:attempt.attempt_no, threadId:attempt.thread_id, reason:"writer stop observed" });
        }
      }
      return { ok: true, state: "canceled", reason: null };
    },
    retry_attempt: ({ attemptId }) => {
      const attempt = getAttempt(db, attemptId);
      if (!attempt) return { ok: false, state: "missing", attemptId, reason: "attempt does not exist" };
      const used = countAttempts(db, attempt.run_id, attempt.task_id);
      if (!RETRY_ELIGIBLE.includes(attempt.state as AttemptState)) {
        return { ok: false, state: attempt.state, attemptId, reason: `retry is not legal from ${attempt.state}` };
      }
      if (used >= MAIN_ATTEMPT_LIMIT) {
        const exhausted = `retry limit 2 exhausted${attempt.reason ? `: ${attempt.reason}` : ""}`;
        transitionAttempt(db, attempt.id, "blocked", { reason: exhausted });
        return { ok: false, state: "blocked", attemptId, reason: exhausted };
      }
      const nextId = id("lpattempt");
      createAttempt(db, { id: nextId, runId: attempt.run_id, taskId: attempt.task_id });
      return { ok: true, state: "queued", attemptId: nextId, reason: null };
    },
    resume_runs: ({ projectId }) => services.resumeOrphans(projectId),
    stack_detect: async ({ projectId }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      const [stack, coexistence] = await Promise.all([
        host.call("detect", { requestedHostId: config.hostId, workspacePath: config.writerWorkspacePath }, { hostId: config.hostId }),
        host.call("coexistenceInventory", { requestedHostId: config.hostId, projectId }, { hostId: config.hostId }),
      ]);
      return { ...stack, coexistence };
    },
    stack_install: async ({ projectId, confirmExternalOps }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      if (!confirmExternalOps) return { schemaVersion:1, action:"install", status:"blocked", reason:"Explicit installation confirmation is required; no operation was run." };
      const result = await nativeInstaller.install(config.hostId);
      const receipt = { schemaVersion: 1, action: "install", status: "ok", native: result };
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
    stack_connect: async ({ projectId, confirmExternalOps }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      if (!confirmExternalOps) return { schemaVersion:1, action:"connect", status:"blocked", reason:"Explicit OpenCode connection confirmation is required; no operation was run." };
      const initial = await coexistenceInventory(projectId, config.hostId);
      const plugin = initial.managers.find((row) => row.manager === "opencode-plugin");
      const configRow = initial.managers.find((row) => row.manager === "opencode-config");
      if (!plugin || !configRow) throw new Error("Read-only inventory did not return the OpenCode plugin and config managers");
      const operations = [];
      const installed = await coexistenceOperation({
        projectId, hostId:config.hostId, operation:"install", manager:"opencode-plugin", path:plugin.path,
        expectedSha256:plugin.sha256, targetSha:initial.targetSha,
      });
      operations.push(installed);
      if (!(installed.status === "ok" || installed.status === "skipped")) {
        const receipt = { schemaVersion:1, action:"connect", status:installed.status, coexistenceOperations:operations };
        saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
        return receipt;
      }
      const current = await coexistenceInventory(projectId, config.hostId);
      const currentConfig = current.managers.find((row) => row.manager === "opencode-config" && row.path === configRow.path);
      if (!currentConfig) throw new Error("OpenCode configuration disappeared after plugin installation; no connection write was attempted");
      const connected = await coexistenceOperation({
        projectId, hostId:config.hostId, operation:"connect", manager:"opencode-config", path:currentConfig.path,
        expectedSha256:currentConfig.sha256, targetSha:current.targetSha,
      });
      operations.push(connected);
      const receipt = { schemaVersion:1, action:"connect", status:connected.status, coexistenceOperations:operations };
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
    stack_rollback: async ({ projectId, snapshotPath }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      const saved = loadProjectSettings(db, projectId)["install.lastReceipt"];
      let parsed: Record<string, unknown> | null = null;
      try {
        const value: unknown = JSON.parse(typeof saved === "string" ? saved : "");
        if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch { /* older installation receipt */ }
      const operations = Array.isArray(parsed?.coexistenceOperations)
        ? parsed.coexistenceOperations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : parsed && typeof parsed.manager === "string" && typeof parsed.path === "string" && typeof parsed.snapshotId === "string" ? [parsed] : [];
      if (operations.length) {
        const rolledBack: unknown[] = [];
        for (const previous of [...operations].reverse()) {
          if (typeof previous.manager !== "string" || typeof previous.path !== "string" || typeof previous.snapshotId !== "string") continue;
          const inventory = await coexistenceInventory(projectId, config.hostId);
          const row = inventory.managers.find((manager) => manager.manager === previous.manager && manager.path === previous.path);
          if (!row) {
            rolledBack.push({ manager:previous.manager, path:previous.path, status:"conflict", reason:"Owned manager/path is no longer in the current inventory; no arbitrary path rollback was attempted." });
            break;
          }
          const receipt = await coexistenceOperation({
            projectId, hostId:config.hostId, operation:"rollback", manager:previous.manager as "agents-marker"|"managed-checkout"|"claude-cache"|"claude-settings"|"opencode-config"|"opencode-plugin",
            path:previous.path, expectedSha256:row.sha256, snapshotId:previous.snapshotId, targetSha:inventory.targetSha,
          });
          rolledBack.push(receipt);
          if (!(receipt.status === "ok" || receipt.status === "rolled_back" || receipt.status === "skipped")) break;
        }
        const receipt = { schemaVersion:1, action:"rollback", status:rolledBack.every((item) => Boolean(item && typeof item === "object" && "status" in item && ["ok", "rolled_back", "skipped"].includes(String(item.status)))) ? "rolled_back" : "conflict", results:rolledBack };
        if (receipt.status === "rolled_back") saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
        else saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify({ ...parsed, lastRollbackAttempt:receipt }));
        return receipt;
      }
      if (!snapshotPath) throw new Error("No Lane Pilot coexistence snapshot is available and no legacy snapshot path was supplied.");
      const receipt = await host.call("rollback", {
        requestedHostId: config.hostId,
        snapshotPath,
      }, { hostId: config.hostId, timeoutMs: 180_000 });
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
  });
}
