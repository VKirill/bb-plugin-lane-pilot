import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import { findModel, findProvider, offeredOnHost, resolveRoleModel, roleDefaultModel, roleModelKey, ROLE_MODEL_EFFORTS, ROLE_MODEL_OPTIONS, ROLE_TABLE, type ModelCatalog } from "@lane-pilot/models";
import { getSettingVersions, listSettingRows, sectionBindingId } from "../../../storage";
import { CATALOG_WAIT_MS, modelCatalogOf, within } from "../../../core/server";
import type { ServerCore } from "../../../core/server";

/**
 * `get_role_models`: the table «role -> model» as the settings page shows it for a place (global, a project, a section of it): for each
 * role the model in force, where it comes from, whether a row of this very place holds it (and its version, for `save_setting` /
 * `reset_project_settings` on the key `role_model.<role>`), and which of the table's six models the machines offer. The writer of a task
 * is not in the table.
 */
export function roleModelsRpc(ctx: ServerCore) {
  return {
    get_role_models: async ({ projectId, sectionId }) => {
      const bindingId = sectionId ? sectionBindingId(sectionId) : "";
      const scopes = sectionId ? ctx.sectionChain(await ctx.listProjectSections(projectId), sectionId) : [];
      const settings = (await ctx.effectiveProjectSettings(projectId, scopes)).values;
      const keys = ROLE_TABLE.map((row) => roleModelKey(row.id));
      const versions = getSettingVersions(ctx.db, projectId, keys, bindingId);
      const own = new Set(listSettingRows(ctx.db, projectId, bindingId).map((row) => row.key));
      const read: ModelCatalog | null = await within(modelCatalogOf(ctx).get(), CATALOG_WAIT_MS).catch(() => null);
      const known = Boolean(read?.providers.length);
      const offered = (providerId: string, model: string): boolean | null => (known && read ? Boolean(findModel(findProvider(read, providerId), model)?.hostIds.length) && offeredOnHost(read, providerId, model, read.runHostId) !== false : null);
      return {
        roles: ROLE_TABLE.map((row) => {
          const chosen = resolveRoleModel(row.id, settings);
          const key = roleModelKey(row.id);
          const builtin = roleDefaultModel(row.id);
          return {
            role: row.id, providerId: chosen.providerId, model: chosen.model, effort: chosen.effort, source: chosen.source, sourceKey: chosen.sourceKey,
            own: own.has(key), version: versions[key] ?? 0, defaultModel: builtin.model, defaultEffort: builtin.effort, offered: offered(chosen.providerId, chosen.model),
          };
        }),
        options: ROLE_MODEL_OPTIONS.map((option) => ({
          id: option.id, providerId: option.providerId, label: option.label, family: option.family, offered: offered(option.providerId, option.id),
          efforts: known && read ? (findModel(findProvider(read, option.providerId), option.id)?.efforts.filter((effort) => (ROLE_MODEL_EFFORTS as readonly string[]).includes(effort)) ?? []) : [...ROLE_MODEL_EFFORTS],
        })),
      };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "get_role_models">;
}
