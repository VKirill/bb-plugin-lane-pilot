import { builtinWorkflows } from "../../src/rooms/workflow/builtin";
import type { Workflow } from "../../src/rooms/workflow/schema";

/** The real catalog with every non-internal workflow published: the chains are drafts until the engine author flips them. */
export const publishedCatalog = (): Workflow[] => builtinWorkflows().map((workflow) => (workflow.internal ? workflow : { ...workflow, status: "published" as const }));

/** The catalog as it ships: the statuses the files say (six own chains are `tested`: they passed their stub tests and never ran for real). */
export const realCatalog = (): Workflow[] => builtinWorkflows();
