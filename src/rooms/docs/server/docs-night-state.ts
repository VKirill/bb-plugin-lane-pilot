

import type { ServerCore } from "../../contracts/server";
import type { DocsUnit } from "../docs";
import { parseDocsSettings } from "../docs";
import type { DocsStageApi } from "./docs";
import type { WriterHostApi, WorkflowEngineApi } from "../../platform/server";
import { createSerialQueue } from "./serial-queue";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  runDocsMaintenance: DocsStageApi["runDocsMaintenance"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

  /** A docs unit's saved progress after its agent started: everything the second half needs, across a plugin reload. */
  export type DocsUnitRecord={version:1;projectId:string;place:{hostId:string;path:string};
    /** The project checkout when the unit works in the docs worktree (place); its commits are merged there. */
    basePath?:string;label:string;unit:DocsUnit;threadId:string;phase:"writing"|"repairing";sentAt?:number;
    beforeDirty:string[];localDate:string;since:ReturnType<typeof parseDocsSettings>["since"];roots:string[];workspaces:Array<{path:string;name:string;docsDir:string|null}>;
    hasDocs:boolean;changedCount:number;refresh:string[];gaps:{missingPages:string[];uncoveredCore:string[]};anchors:{count:number;jev?:string}|null;
    core:Array<{name:string;file:string;line:number;endLine:number}>;kvKey:string;
    /** Pages of the place already over the size limit when the agent started (absent in records saved by older versions). */
    oversizedAtStart?:string[];
    /** The idempotency key of the graph run (`lp.docs-night`) that works on the unit; absent in records saved before the unit was a graph. */
    runKey?:string};

  /** What one docs unit's graph run is started with: everything its steps need that the unit record does not hold yet. */
  export type UnitInputs={projectId:string;place:{hostId:string;path:string};basePath:string;scopes:string[];unit:DocsUnit;roots:string[];exclude:string[];
    workspaces:Array<{path:string;name:string;docsDir:string|null}>;base:string;runKey:string;assignment?:string};
  /** What the prepare step found for a unit with work to do, handed to the write step (the unit record is made once the agent has a thread). */
  export type UnitPlan={label:string;hasDocs:boolean;changed:string[];changedCount:number;refresh:string[];gaps:{missingPages:string[];uncoveredCore:string[]};
    anchors:{count:number;jev?:string;briefPath?:string;deploy:boolean}|null;core:Array<{name:string;file:string;line:number;endLine:number}>;kvKey:string;
    doubts:Array<{path:string;rule:string;detail:string}>;decisionDrafts:string[];beforeDirty:string[];localDate:string;oversizedAtStart:string[]};

  /** The checks of a unit's pages: what the agent touched, what is dirty in its docs, per-page citation stats, the findings that block and the ones left as warnings. */
  export type DocsFinding={path:string;rule:string;detail:string};
  export type Checked={touched:string[];docsDirty:string[];pageStats:Array<{path:string;checked:number;supported:number;partial:number}>;findings:DocsFinding[];kept:DocsFinding[]};
  export type Verified={checked:Checked;warnings:DocsFinding[];reverted:string[]};

/** Every folder of a place on every machine: sources and section copies, as the nightly pass sees them. */
export type DocsOpenPasses=Record<string,{projectId:string;path:string;date:string}>;

/** The mutable state one createDocsNightly call shares between its moved-out parts. */
export interface NightlyShared {
  ctx:ServerCore;
  services:Services;
  bb:ServerCore["bb"];
  db:ServerCore["db"];
  host:ServerCore["host"];
  listProjectSections:ServerCore["listProjectSections"];
  sectionChain:ServerCore["sectionChain"];
  /** One folder's docs pass at a time across every project: passes queue up instead of running side by side. */
  inDocsQueue:<T>(work:()=>Promise<T>)=>Promise<T>;
  /** Docs agents are spawned one at a time: the next starts once the last has left "starting". */
  docsSpawnGate:Promise<unknown>;
  /** Index writes go one at a time: units of a pass save their progress side by side. */
  docsUnitsIndexChain:Promise<unknown>;
  /** Places whose pass is running in this plugin process; a catch-up never starts beside one. */
  docsPassesRunning:Set<string>;
  /** Units finishing in this plugin process, by record key; resumption never runs one twice. */
  docsUnitsFinishing:Map<string,DocsUnit>;
  /** What a unit's pass holds in this process only (the code maps fetched ahead, the pages of the units beside it): a step run after a reload does without. */
  unitExtras:Map<string,{prefetch:Map<string,Promise<unknown>>;othersWritable:(path:string,self:DocsUnit)=>boolean}>;
  /** The units whose graph run a catch-up tick already holds in this process: the next tick does not join it a second time. */
  activeUnitRuns:Set<string>;
  /** Schedules whose work is still in flight; a tick while it runs is skipped. */
  schedulesRunning:Set<string>;
}

export function createNightlyShared(ctx:ServerCore, services:Services):NightlyShared {
  const { bb, db, host, listProjectSections, sectionChain } = ctx;
  return { ctx, services, bb, db, host, listProjectSections, sectionChain,
    inDocsQueue:createSerialQueue(), docsSpawnGate:Promise.resolve(), docsUnitsIndexChain:Promise.resolve(),
    docsPassesRunning:new Set(), docsUnitsFinishing:new Map(), unitExtras:new Map(), activeUnitRuns:new Set(), schedulesRunning:new Set() };
}
