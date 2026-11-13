import { z } from "zod";

const bilingualSchema = z.object({ en: z.string(), ru: z.string() }).strict();
const nodeType = z.enum(["agent", "lp-task", "action", "decision", "human", "parallel", "join", "subworkflow", "note"]);

/** The «Карта графов» read: every workflow of the library, its steps and edges, and which graph calls which (subworkflow nodes). */
export const rpcWorkflowMap = {
  workflow_map: {
    input: z.object({ projectId: z.string().min(1).optional(), locale: z.enum(["en", "ru"]).optional() }).strict(),
    output: z.object({
      /** The plugin build this map came from (package version; the plugin exposes no git sha). */
      commit: z.string().nullable(),
      generatedAt: z.number().int(),
      graphs: z.array(z.object({
        id: z.string(), name: bilingualSchema, category: z.string(), tags: z.array(z.string()),
        scope: z.enum(["builtin", "global", "project"]), status: z.enum(["draft", "tested", "published", "deprecated"]),
        runs30d: z.number().int(), successRate: z.number().nullable(),
      }).strict()),
      steps: z.array(z.object({
        graph: z.string(), id: z.string(), type: nodeType, title: bilingualSchema.nullable(),
        role: z.string().nullable(), skills: z.array(z.string()), prompt: z.string().nullable(),
        /** The step described in full (task, inputs, outputs, next steps, limits) in the asked locale: the card prints it. */
        facts: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
      }).strict()),
      /** The graph's own edges, including the `start`/`end` ends. */
      edges: z.array(z.object({ graph: z.string(), from: z.string(), to: z.string() }).strict()),
      /** Every subworkflow call: a `subworkflow` node, or a `parallel` node whose branch is one. */
      calls: z.array(z.object({ fromGraph: z.string(), fromStep: z.string(), toGraph: z.string() }).strict()),
      project: z.enum(["not_requested", "ok", "no_machine", "unavailable"]),
    }).strict(),
  },
};
