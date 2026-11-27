import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { isSandboxProjectName, type rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { isSandboxProject } from "../../../owner-waiting";
import { invalidateRpcTags } from "../../../platform/server";
import { casUpsertSettings, getSettingVersions, loadProjectSettings } from "../../../storage";
import { parseDocsSettings } from "../../models";
import { DOCS_ENABLED_KEY } from "../../settings";
import { createDocsOverview, type DocsOverviewServices } from "../services/docs-overview";

/** Each folder of the project on each machine: whether it keeps docs, why, how often, and when tasks last read them. */
export function docsRpc(ctx: ServerCore, docs: DocsOverviewServices) {
  const overview = createDocsOverview(ctx, docs);
  return {
    docs_overview: async (input) => overview(input),
    docs_projects: async () => {
      const listed = (await ctx.bb.sdk.projects.list({ includePersonal: true })) ?? [];
      const projects = listed
        .filter((project) =>
          project.id !== GLOBAL_SETTINGS_PROJECT_ID
          && !isSandboxProject(project.id)
          && !isSandboxProjectName(project.name),
        )
        .map((project) => ({
          projectId: project.id,
          name: project.name,
          on: parseDocsSettings(loadProjectSettings(ctx.db, project.id)).enabled,
        }));
      return { projects };
    },
    docs_set: async ({ projectId, on }) => {
      const value = on ? "true" : "false";
      const expectedVersion = getSettingVersions(ctx.db, projectId, [DOCS_ENABLED_KEY])[DOCS_ENABLED_KEY] ?? 0;
      const saved = casUpsertSettings(ctx.db, {
        projectId,
        bindingId: "",
        changes: [{ key: DOCS_ENABLED_KEY, value, expectedVersion }],
      });
      if (!saved.ok) {
        const detail = saved.validation?.code ?? (saved.conflict ? "conflict" : "save_failed");
        throw new Error(`docs_set failed for ${projectId}: ${detail}`);
      }
      ctx.bb.log.info(`docs.switch project=${projectId} enabled=${value}`);
      invalidateRpcTags(ctx.bb, ["docs_projects"]);
      const project = await orMiss(ctx.bb.sdk.projects.get({ projectId }), null, isNotFound).catch(() => null) as { name?: string } | null;
      return {
        projectId,
        name: project?.name?.trim() || projectId,
        on,
      };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "docs_overview" | "docs_projects" | "docs_set">;
}
