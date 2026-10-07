import { builtinWorkflows } from "../../src/workflow/builtin";
import type { Workflow } from "../../src/workflow/schema";

/** The real catalog with every non-internal workflow published: the chains are drafts until the engine author flips them. */
export const publishedCatalog = (): Workflow[] => builtinWorkflows().map((workflow) => (workflow.internal ? workflow : { ...workflow, status: "published" as const }));
