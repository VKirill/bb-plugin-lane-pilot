import { z } from "zod";

/**
 * «Выгрузить графы»: the library's workflow definitions as files to take away. `ids` picks chosen ones, `category` one shelf,
 * neither means all. `redact` blanks paths, host ids and secret names; `includeProjectGraphs` adds project-scope files.
 */
export const rpcWorkflowExport = {
  workflow_export: {
    input: z.object({
      projectId: z.string().min(1).optional(),
      ids: z.array(z.string().min(1)).max(200).optional(),
      category: z.string().min(1).max(40).optional(),
      redact: z.boolean().default(true),
      includeProjectGraphs: z.boolean().default(false),
    }).strict(),
    output: z.object({
      manifest: z.object({
        lanePilotVersion: z.string(),
        commit: z.string().nullable(),
        exportedAt: z.string(),
        redacted: z.boolean(),
        graphs: z.array(z.object({ id: z.string(), version: z.number().int(), category: z.string(), scope: z.enum(["builtin", "global", "project"]) }).strict()),
      }).strict(),
      files: z.array(z.object({ path: z.string(), text: z.string() }).strict()),
      markdown: z.string(),
    }).strict(),
  },
};
