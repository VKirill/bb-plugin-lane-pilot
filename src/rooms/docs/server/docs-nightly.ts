import type { ServerCore } from "../../contracts/server";
import type { WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { Services } from "./docs-night-state";
import { createNightlyShared } from "./docs-night-state";
import { registerDocsSchedules } from "./docs-schedules";
import { registerDocsGraphs } from "./docs-graphs";
import { docsPlaces, docsVerdict, docsPlaceStatus, docsLastRead } from "./docs-place-status";
import type { DocsPlace } from "./docs-place-status";
import { runNightlyDocs } from "./docs-nightly-pass";

export { createSerialQueue } from "./serial-queue";
export { docsMergeNote } from "./docs-merge-note";
export { pluginStopped } from "./plugin-stopped";

export function createDocsNightly(ctx: ServerCore, services: Services) {
  const n = createNightlyShared(ctx, services);
  registerDocsSchedules(n);
  return {
    registerDocsGraphs: (engine:WorkflowEngine)=>registerDocsGraphs(n,engine),
    docsPlaces: (projectId:string)=>docsPlaces(n,projectId),
    docsVerdict: (projectId:string, place:DocsPlace, opts:{force?:boolean;now?:number}={})=>docsVerdict(n,projectId,place,opts),
    docsPlaceStatus: (projectId:string, place:DocsPlace, opts:{force?:boolean;now?:number}={})=>docsPlaceStatus(n,projectId,place,opts),
    docsLastRead: (place:DocsPlace)=>docsLastRead(n,place),
    runNightlyDocs: (opts:{force?:boolean;projectId?:string;path?:string;base?:string;catchUp?:boolean;signal?:AbortSignal;
      /** The owner's assignment (SMA k_ag_docwriter): handed to every unit's graph run of this pass. */ assignment?:string}={})=>runNightlyDocs(n,opts),
  };
}

export type DocsNightlyApi = ReturnType<typeof createDocsNightly>;
