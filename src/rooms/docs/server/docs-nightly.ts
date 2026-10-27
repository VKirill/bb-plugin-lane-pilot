import { projectRoleField } from "../../runs/server";
import { claimDailySchedule, getActivation, getRun, listRunsWithAttempts, listStageReceipts, loadProjectSettings, loadPrototypeConfig } from "../../storage";
import { bbServiceTier, writerExecutionSelection } from "@lane-pilot/models";
import { sha256 } from "../../tasks";
import { docsRepairPrompt, docsSelection, docsScheduleDue, docsSinceEpoch, flowDocsWritable, localDateKey, nightlyDocsPrompt, nightlyDocsWritable, parseDocsSettings } from "../docs";
import type { DocsUnit } from "../docs";
import { cadenceAllowsToday, codeDocsVerdict, docsCadence, docsFactsKey, docsWorthinessState, DOCS_WORTHINESS_QUESTION, fallbackDocsVerdict } from "../docs-worthiness";
import type { DocsCadence, DocsVerdict, DocsWorthinessFacts } from "../docs-worthiness";
import { blockingDocsFindings, buildBacklinks, buildDocsIndex, citedFiles, docsCompletenessGaps, isDesignCanon, isDocsIndex, lintDocsPages, oversizedPageFindings, pagesToRefresh, uncataloguedPages, withCitedSources, withVerifiedConfidence } from "../docs-lint";
import { configuredSetting, graphStepMetadata, modelCatalogOf, resolveSpawnModel } from "../../core/server";
import { fullAccessSpawn } from "../../core/server";
import { withUsage } from "../../usage/server";
import { DOCS_MAINTENANCE, DOCS_NIGHT, builtinWorkflow } from "../../workflow";
import type { StepContext, WorkflowEngine } from "../../workflow";
import { requireGreen } from "../../workflow/server";
import { stringAt, valueAt } from "../../core/server";
import { recordStage } from "../../runs/server";
import { sleepUntilThreadSignal, threadWatchMark, waitThreadIdle } from "@lane-pilot/thread-observe";
import { basename, resolve } from "node:path";
import { abortable, scheduleIsolated } from "../../core/server";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";

/** Runs the work it is given one after another, in the order it was given; a failure does not stop the queue. */
export function createSerialQueue():<T>(work:()=>Promise<T>)=>Promise<T> {
  let tail:Promise<unknown>=Promise.resolve();
  return <T>(work:()=>Promise<T>):Promise<T>=>{
    const turn=tail.then(work);
    tail=turn.catch(()=>undefined);
    return turn;
  };
}

/**
 * The log line of a docs merge, or null when it merged. A conflict while landing an earlier pass's leftover worktree is
 * the expected end of that leftover: main got the same pages meanwhile (treba-sites, 2026-10-07: the owner committed
 * docs a crashed pass had left in the checkout), the leftover is dropped and this pass writes the pages again from main.
 */
export function docsMergeNote(basePath:string,result:{status:string;reason?:string|null;conflicts:string[]},leftover=false):{level:"info"|"warn";message:string}|null {
  if(result.status!=="conflict"&&result.status!=="failed") return null;
  const files=result.conflicts.length?` (${result.conflicts.join(", ")})`:"";
  if(leftover&&result.status==="conflict") return {level:"info",message:`Lane Pilot earlier docs pass for ${basePath} dropped: main changed the same pages${files}; this pass writes them again from main`};
  return {level:"warn",message:`Lane Pilot docs merge into ${basePath} ${result.status}: ${result.reason ?? ""}${files}`};
}

export function createDocsNightly(ctx: ServerCore, services: Services) {
  const { bb, db, host, listProjectSections, sectionChain } = ctx;

  /** A folder on one machine: the unit docs are judged and written for. */
  type DocsPlace = { hostId:string; path:string };
  type StoredDocsVerdict = DocsVerdict & { projectId:string; hostId:string; path:string; factsKey:string; facts:DocsWorthinessFacts; at:number; docsSince:number|null };
  const WORTH_KEY=(place:DocsPlace)=>`docs-worthiness:${place.hostId}:${sha256(resolve(place.path)).slice(0,16)}`;
  /** A verdict older than this is asked again even when the folder looks the same. */
  const VERDICT_TTL_MS=30*24*3_600_000;

  /**
   * Whether docs are worth keeping for this folder on this machine. Facts come from the folder itself; code
   * settles the clear cases, System One the borderline ones. Kept until the facts move or a month passes.
   */
  async function docsVerdict(projectId:string, place:DocsPlace, opts:{force?:boolean;now?:number}={}):Promise<StoredDocsVerdict|null> {
    const now=opts.now??Date.now();
    const stored=await bb.storage.kv.get(WORTH_KEY(place)).catch(()=>null) as StoredDocsVerdict|null;
    const facts=await host.call("docsWorthinessFacts",{requestedHostId:place.hostId,projectCwd:place.path},{hostId:place.hostId,timeoutMs:60_000}).catch(()=>null);
    if(!facts) return stored;
    const factsKey=docsFactsKey(facts);
    const docsSince=stored?.docsSince??(facts.docsPages>0?now:null);
    if(stored&&!opts.force&&stored.factsKey===factsKey&&now-stored.at<VERDICT_TTL_MS) return {...stored,facts,docsSince};
    let verdict=codeDocsVerdict(facts);
    if(!verdict){
      const judged=await host.call("councilJudge",{requestedHostId:place.hostId,state:JSON.stringify(docsWorthinessState(facts,place)),
        questions:{worth:{instructions:DOCS_WORTHINESS_QUESTION.instructions,criteria:{...DOCS_WORTHINESS_QUESTION.criteria}}}},{hostId:place.hostId,timeoutMs:10_000}).catch(()=>null);
      const choice=judged?.status==="ok"?judged.answers.worth:undefined;
      const sure=judged?.confidence?.worth??0.5;
      verdict=choice==="needed"||choice==="not_needed"
        ? {need:(choice==="needed"?sure:1-sure)>=0.5,reason:(choice==="needed"?sure:1-sure)>=0.5?"jev_needed":"jev_not_needed",confidence:sure}
        : fallbackDocsVerdict(facts);
    }
    const next:StoredDocsVerdict={...verdict,projectId,hostId:place.hostId,path:place.path,factsKey,facts,at:now,docsSince};
    await bb.storage.kv.set(WORTH_KEY(place),next);
    return next;
  }

  /** The last time a writer task in this folder was pointed at its docs: read_first or the execution packet named a docs page. */
  function docsLastRead(place:DocsPlace):number|null {
    const root=resolve(place.path);
    const row=db.prepare(`SELECT max(t.created_at) AS at FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id
      LEFT JOIN lane_pilot_attempt a ON a.task_id=t.id LEFT JOIN lane_pilot_attempt_reasoning x ON x.attempt_id=a.id
      WHERE (r.writer_workspace_path=? OR r.writer_workspace_path LIKE ?) AND (r.writer_host_id IS NULL OR r.writer_host_id=?)
        AND (json_extract(t.contract_json,'$.read_first') LIKE '%docs/%' OR json_extract(x.trace_json,'$.dispatchContext.executionPacket') LIKE '%docs/%')`)
      .get(root,`${root}/%`,place.hostId) as {at:number|null}|undefined;
    return row?.at??null;
  }

  /** Where a folder in auto mode stands: verdict, and for kept docs how often they are refreshed. */
  async function docsPlaceStatus(projectId:string, place:DocsPlace, opts:{force?:boolean;now?:number}={}):Promise<{verdict:StoredDocsVerdict|null;cadence:DocsCadence;lastReadAt:number|null}> {
    const now=opts.now??Date.now();
    const verdict=await docsVerdict(projectId,place,opts);
    const lastReadAt=docsLastRead(place);
    const cadence=verdict?.need&&verdict.facts.docsPages>0&&verdict.docsSince!==null ? docsCadence({lastReadAt,docsSince:verdict.docsSince,now}) : "nightly";
    return {verdict,cadence,lastReadAt};
  }

  /** Every folder of a project on every machine: its sources and its section folders, as the nightly pass sees them. */
  async function docsPlaces(projectId:string):Promise<Array<DocsPlace & {scopes:string[];name:string}>> {
    const places:Array<DocsPlace & {scopes:string[];name:string}>=[];
    const described=await bb.sdk.projects.get({projectId}).catch(()=>null) as {name?:string;sources?:Array<{hostId?:string;path?:string}>}|null;
    for(const source of described?.sources??[]){
      if(source.hostId&&source.path&&!places.some((place)=>place.hostId===source.hostId&&place.path===source.path)) places.push({scopes:[],hostId:source.hostId,path:source.path,name:described?.name??basename(source.path)});
    }
    const sections=await listProjectSections(projectId);
    for(const section of sections) if(section.kind==="folder"&&section.path&&section.hostId) places.push({scopes:sectionChain(sections,section.id),hostId:section.hostId,path:section.path,name:section.name});
    return places;
  }

  /** One folder's docs pass at a time across every project: passes queue up instead of running side by side. */
  const inDocsQueue=createSerialQueue();

  /** A workspace with at least this many product code files keeps its own docs folder; smaller ones belong to the root docs. */
  const WORKSPACE_DOCS_MIN_FILES=15;

  /** Docs folders of one monorepo written at once. */
  const DOCS_UNIT_CONCURRENCY=8;

  /**
   * BB refuses to provision a thread on a checkout while another one is being provisioned there, so docs
   * agents are spawned one at a time: the next starts once the last has left "starting".
   */
  let docsSpawnGate:Promise<unknown>=Promise.resolve();

  function spawnDocsThread(args:Parameters<typeof bb.sdk.threads.spawn>[0]):Promise<string>{
    const turn=docsSpawnGate.then(async()=>{
      // BB may still report another thread provisioning this checkout; that clears in seconds.
      let spawned:unknown;
      for(let attempt=0;;attempt++){
        try{ spawned=await fullAccessSpawn(bb, args); break; }
        catch(cause){
          if(attempt>=5||!/another thread is using this workspace/i.test(cause instanceof Error?cause.message:String(cause))) throw cause;
          await new Promise((done)=>setTimeout(done,5_000*(attempt+1)));
        }
      }
      const threadId=stringAt(spawned,"id"); if(!threadId) throw new Error("docs thread id missing");
      for(;;){
        const mark=threadWatchMark(bb);
        if(stringAt(await bb.sdk.threads.get({threadId}).catch(()=>null),"status")!=="starting") break;
        await sleepUntilThreadSignal(bb,threadId,mark,2_000);
      }
      return threadId;
    });
    docsSpawnGate=turn.catch(()=>undefined);
    return turn;
  }

  /** Attempts a night gets: the pass at docs.hour, then catch-ups a few minutes later when it broke off or a unit failed. */
  const DOCS_NIGHT_ATTEMPTS=3;

  /** Places whose pass today is not settled yet, so the catch-up tick reads one key instead of every project. */
  const DOCS_OPEN_KEY="docs-nightly-open";

  type DocsOpenPasses=Record<string,{projectId:string;path:string;date:string}>;

  /** Places whose pass is running in this plugin process; a catch-up never starts beside one. */
  const docsPassesRunning=new Set<string>();

  /** Tooling state that changes during a pass without the docs agent: never reverted, never a violation. */
  const DOCS_TOOLING=/^(\.agents|\.bb|\.claude|\.codex|\.gitnexus)\//;

  /**
   * claude-lane's nightly docs for native projects: once a day at docs.hour of the folder's own
   * machine, every project root and section that is a git repository with docs enabled gets hidden
   * docs agents. A monorepo gets one per workspace big enough to keep its own <workspace>/docs, a few
   * at once, and then one for the root docs/ that describe the system and link to them. Each sees
   * the code changed since its folder's docs; no folder yet means onboarding; nothing changed and
   * docs present means no model call. `force` skips the hour for a manual run.
   */
  /** A docs unit's saved progress after its agent started: everything the second half needs, across a plugin reload. */
  type DocsUnitRecord={version:1;projectId:string;place:{hostId:string;path:string};
    /** The project checkout when the unit works in the docs worktree (place); its commits are merged there. */
    basePath?:string;label:string;unit:DocsUnit;threadId:string;phase:"writing"|"repairing";sentAt?:number;
    beforeDirty:string[];localDate:string;since:ReturnType<typeof parseDocsSettings>["since"];roots:string[];workspaces:Array<{path:string;name:string;docsDir:string|null}>;
    hasDocs:boolean;changedCount:number;refresh:string[];gaps:{missingPages:string[];uncoveredCore:string[]};anchors:{count:number;jev:string}|null;
    core:Array<{name:string;file:string;line:number;endLine:number}>;kvKey:string;
    /** Pages of the place already over the size limit when the agent started (absent in records saved by older versions). */
    oversizedAtStart?:string[];
    /** The idempotency key of the graph run (`lp.docs-night`) that works on the unit; absent in records saved before the unit was a graph. */
    runKey?:string};

  /** What one docs unit may write: a flow its page, the root its docs/ outside docs/flows when flows exist, a workspace its folder. */
  function unitWritable(unit:DocsUnit):(path:string)=>boolean {
    const own=unit.flow?flowDocsWritable(unit.flow.slug)
      :unit.flows?.length?(path:string)=>nightlyDocsWritable(unit.docsDir)(path)&&!path.startsWith("docs/flows/")
      :nightlyDocsWritable(unit.docsDir);
    // The design canon is the design lead's page, not the docs agent's.
    return (path:string)=>own(path)&&!isDesignCanon(path);
  }

  /**
   * The docs worktree of a place: Lane Pilot's own git worktree on lane/docs-<hash>, fresh from main for each pass.
   * The docs agents used to write in the project checkout for hours, so a deploy found it dirty and its git busy, and an
   * agent interrupted mid-command left .git/index.lock behind (SelfyStudio, 2026-10-03). A pass that broke off keeps
   * its worktree while units still have saved progress in it. Without a worktree the pass runs in place, as before.
   */
  async function docsWorktree(place:{hostId:string;path:string}):Promise<{hostId:string;path:string}> {
    const name=`docs-${sha256(place.path).slice(0,12)}`, key=`docs-worktree:${place.hostId}:${name}`;
    const known=await bb.storage.kv.get(key).catch(()=>null) as {path?:string}|null;
    if(known?.path){
      const open=(await bb.storage.kv.get(DOCS_UNITS_OPEN_KEY).catch(()=>null) as Record<string,true>|null)??{};
      for(const unitKey of Object.keys(open)){
        const record=await bb.storage.kv.get(unitKey).catch(()=>null) as DocsUnitRecord|null;
        if(record?.place.path===known.path) return {hostId:place.hostId,path:known.path};
      }
      // Its committed pages reach main before it goes; a busy main waits for the next tick.
      const merged=await mergeDocs(place.path,{hostId:place.hostId,path:known.path},"docs: earlier pass",true);
      if(merged==="busy") throw new Error("docs_worktree_merge_busy: main is merging other work; the pass retries");
      await host.call("gitRemoveWorktree",{requestedHostId:place.hostId,basePath:place.path,worktreePath:known.path},{hostId:place.hostId,timeoutMs:120_000}).catch(()=>null);
      await bb.storage.kv.delete(key).catch(()=>undefined);
    }
    const created=await host.call("gitCreateWorktree",{requestedHostId:place.hostId,basePath:place.path,name},{hostId:place.hostId,timeoutMs:120_000}).catch((cause)=>({status:"failed" as const,path:null,reason:cause instanceof Error?cause.message:String(cause)}));
    if(created.status!=="ready"||!created.path){
      bb.log.warn(`Lane Pilot docs worktree for ${place.path} not created (${created.reason}); the pass works in the checkout`);
      return place;
    }
    await bb.storage.kv.set(key,{path:created.path});
    return {hostId:place.hostId,path:created.path};
  }

  /** Merges the docs worktree's commits into the project checkout under the writers' merge lock; null when there is no worktree. */
  async function mergeDocs(basePath:string,work:{hostId:string;path:string},message:string,leftover=false):Promise<string|null> {
    if(resolve(work.path)===resolve(basePath)) return null;
    const result=await host.call("gitIntegrate",{requestedHostId:work.hostId,basePath,worktreePath:work.path,message,committedOnly:true},{hostId:work.hostId,timeoutMs:300_000})
      .catch((cause)=>({status:"failed" as const,reason:cause instanceof Error?cause.message:String(cause),conflicts:[] as string[]}));
    const note=docsMergeNote(basePath,result,leftover);
    if(note&&!pluginStopped(result.reason??"")) bb.log[note.level](note.message);
    return result.status;
  }

  async function runNightlyDocs(opts:{force?:boolean;projectId?:string;path?:string;base?:string;catchUp?:boolean;signal?:AbortSignal}={}):Promise<Array<Record<string,unknown>>> {
    const results:Array<Record<string,unknown>>=[];
    const projects=opts.projectId?[{id:opts.projectId}]:await bb.sdk.projects.list({includePersonal:true}).catch(()=>[] as Array<{id:string}>);
    for(const project of projects){
      opts.signal?.throwIfAborted();
      const places:Array<{scopes:string[];hostId:string;path:string}>=[];
      const root=await services.resolveProjectWriterHost({projectId:project.id}).catch(()=>null);
      if(root?.status==="resolved"&&root.path) places.push({scopes:[],hostId:root.hostId,path:root.path});
      // Every source of the project is a place too: a project may keep its code repository on another machine.
      const described=await bb.sdk.projects.get({projectId:project.id}).catch(()=>null) as {sources?:Array<{hostId?:string;path?:string}>}|null;
      for(const source of described?.sources??[]){
        if(source.hostId&&source.path&&!places.some((place)=>place.hostId===source.hostId&&place.path===source.path)) places.push({scopes:[],hostId:source.hostId,path:source.path});
      }
      const sections=await listProjectSections(project.id);
      for(const section of sections) if(section.kind==="folder"&&section.path&&section.hostId) places.push({scopes:sectionChain(sections,section.id),hostId:section.hostId,path:section.path});
      for(const place of places){
        opts.signal?.throwIfAborted();
        if(opts.path&&resolve(place.path)!==resolve(opts.path)) continue;
        try{
          const settings=loadProjectSettings(db,project.id,place.scopes);
          const docs=parseDocsSettings(Object.fromEntries(["docs.enabled","docs.maintain","docs.since","docs.page_cap","docs.hour"].map((key)=>[key,configuredSetting(settings,key)])));
          if(!docs.enabled||!docs.maintain) continue;
          const scope=await host.call("gitDocsScope",{requestedHostId:place.hostId,projectCwd:place.path,sinceEpochMs:docsSinceEpoch(docs.since,new Date())},{hostId:place.hostId,timeoutMs:120_000});
          if(scope.status!=="ready"||!scope.isRepoRoot) continue;
          // A pass that broke off (a reload, a crash) or left units failed is picked up at the next hours of the same
          // night; units already done have no changes left and skip at once.
          const stateKey=`docs-nightly-state:${project.id}:${sha256(place.path).slice(0,12)}`;
          const night=await bb.storage.kv.get(stateKey).catch(()=>null) as {date?:string;attempts?:number;finished?:boolean;failed?:number}|null;
          const unsettled=night?.date===scope.localDate&&(!night.finished||(night.failed??0)>0)&&(night.attempts??0)<DOCS_NIGHT_ATTEMPTS;
          const catchUp=Boolean(opts.catchUp)&&!opts.force&&unsettled&&!docsPassesRunning.has(place.path);
          if(opts.catchUp&&!catchUp) continue;
          if(!opts.force&&!catchUp&&scope.localHour!==docs.hour) continue;
          if(docs.mode==="auto"){
            const status=await docsPlaceStatus(project.id,place);
            if(!status.verdict?.need){ results.push({projectId:project.id,path:place.path,hostId:place.hostId,state:"skipped",reason:`docs_not_needed:${status.verdict?.reason??"no_facts"}`}); continue; }
            if(!opts.force&&!cadenceAllowsToday(status.cadence,scope.localDate)){ results.push({projectId:project.id,path:place.path,hostId:place.hostId,state:"skipped",reason:`docs_${status.cadence}`}); continue; }
          }
          const schedule=`docs-nightly-${sha256(place.path).slice(0,12)}`;
          if(!opts.force&&!catchUp&&!claimDailySchedule(db,project.id,schedule,scope.localDate)) continue;
          if(docsPassesRunning.has(place.path)) continue;
          docsPassesRunning.add(place.path);
          // A pass stuck on one await must not keep the serial queue and its place busy: an aborted run ends the wait.
          const inQueue=()=>inDocsQueue(async()=>{
          const firstResult=results.length;
          const attempts=(catchUp?night?.attempts??0:0)+1;
          await bb.storage.kv.set(stateKey,{date:scope.localDate,attempts,finished:false,failed:0});
          const open=(await bb.storage.kv.get(DOCS_OPEN_KEY).catch(()=>null) as DocsOpenPasses|null)??{};
          await bb.storage.kv.set(DOCS_OPEN_KEY,{...open,[stateKey]:{projectId:project.id,path:place.path,date:scope.localDate}});
          try{
          // The agents write, check and commit in the place's docs worktree; main sees only merged commits.
          const work=await docsWorktree(place);
          const own=scope.workspaces.filter((workspace)=>workspace.codeFiles>=WORKSPACE_DOCS_MIN_FILES);
          const workspaces=scope.workspaces.map((workspace)=>({path:workspace.path,name:workspace.name,docsDir:own.includes(workspace)?`${workspace.path}/docs`:null}));
          const units:DocsUnit[]=[...own.map((workspace)=>({docsDir:`${workspace.path}/docs`,workspace:{path:workspace.path,name:workspace.name}})),
            {docsDir:"docs",...(workspaces.length?{workspaces}:{})}];
          // A unit may change only its own pages; what it changes elsewhere is reverted, except the folders of units
          // running beside it (their agents write there now) and pages a failed unit left for its next pass.
          const running=new Set<DocsUnit>(), leftover=new Set<string>();
          const sinceEpochMs=docsSinceEpoch(docs.since,new Date());
          // Scan first: every unit with work gets its code map built now, all at once, and the flows are traced beside
          // them, so each agent starts on a finished map instead of waiting for Jev in turn.
          const prefetch=new Map<string,Promise<unknown>>();
          const titled=(await host.call("listDocsPages",{requestedHostId:work.hostId,projectCwd:work.path,roots:units.map((unit)=>unit.docsDir),skipOversized:true},{hostId:work.hostId,timeoutMs:120_000}).catch(()=>null))?.pages??[];
          await Promise.all(units.map(async(unit)=>{
            const workspace=unit.workspace;
            const unitScope=await host.call("gitDocsScope",{requestedHostId:work.hostId,projectCwd:work.path,sinceEpochMs,docsDir:unit.docsDir,...(opts.base?{base:opts.base}:{})},{hostId:work.hostId,timeoutMs:120_000}).catch(()=>null);
            if(!unitScope||unitScope.status!=="ready") return;
            const changed=unitScope.changed.filter((path)=>workspace?path.startsWith(`${workspace.path}/`):true);
            if(unitScope.hasDocs&&!changed.length&&!unitScope.dirty.some(unitWritable(unit))) return;
            // A unit resuming from saved progress already has its map.
            if(await bb.storage.kv.get(docsUnitRecordKey(project.id,work.path,unit.docsDir)).catch(()=>null)) return;
            const pages=titled.filter((page)=>page.path.startsWith(`${unit.docsDir}/`)&&!isDocsIndex(page.path))
              .map((page)=>({path:page.path,title:/^title:\s*(.+)$/m.exec(page.content)?.[1]?.trim()??page.path}));
            prefetch.set(unit.docsDir,host.call("docsAnchors",{requestedHostId:work.hostId,projectCwd:work.path,prefix:workspace?`${workspace.path}/`:"",
              ...(workspace?{}:{exclude:own.map((item)=>item.path),...(workspaces.length?{workspaces}:{})}),pages:pages.slice(0,500)},{hostId:work.hostId,timeoutMs:1_800_000}).catch(()=>null));
          }));
          const flowPagesAtStart=titled.filter((page)=>page.path.startsWith("docs/flows/"));
          const tracing=host.call("docsFlows",{requestedHostId:work.hostId,projectCwd:work.path,workspaces:workspaces.map((workspace)=>({path:workspace.path,name:workspace.name})),
            keep:[...new Set(flowPagesAtStart.map((page)=>/^docs\/flows\/([^/]+)\.md$/.exec(page.path)?.[1]).filter((slug):slug is string=>Boolean(slug)))]},
            {hostId:work.hostId,timeoutMs:1_800_000}).catch((cause)=>{ bb.log.warn(`Lane Pilot docs flows failed for ${place.path}: ${cause instanceof Error?cause.message:String(cause)}`); return null; });
          const context={projectId:project.id,place:work,basePath:place.path,scopes:place.scopes,localDate:scope.localDate,attempt:opts.force?Date.now():attempts,settings,docs,base:opts.base,roots:units.map((unit)=>unit.docsDir),exclude:own.map((workspace)=>workspace.path),workspaces,prefetch,
            othersWritable:(path:string,self:DocsUnit)=>leftover.has(path)||[...running,...docsUnitsFinishing.values()].some((unit)=>unit!==self&&unitWritable(unit)(path))};
          const run=async(unit:DocsUnit)=>{
            running.add(unit);
            try{
              const row=await runDocsUnit(context,unit);
              results.push(row);
              for(const path of (row.state==="failed"&&Array.isArray(row.docsWritten)?row.docsWritten as string[]:[])) leftover.add(path);
            }
            catch(cause){
              const reason=cause instanceof Error?cause.message:String(cause);
              results.push({projectId:project.id,path:place.path,docsDir:unit.docsDir,state:"failed",reason});
              if(!pluginStopped(cause)) bb.log.warn(`Lane Pilot nightly docs failed for ${place.path} ${unit.docsDir}: ${reason}`);
            }
            finally{ running.delete(unit); }
          };
          const pool=async(queue:DocsUnit[])=>{ await Promise.all(Array.from({length:Math.min(DOCS_UNIT_CONCURRENCY,queue.length)},async()=>{ for(let unit=queue.shift();unit;unit=queue.shift()){ opts.signal?.throwIfAborted(); await run(unit); } })); };
          // Workspaces first, a few at once. Then the business flows, traced once across the repository, each written
          // by its own agent on top of the workspace docs. The root last, so its overview links to docs that exist.
          await pool(units.slice(0,-1));
          const traced=await tracing;
          const flowUnits:DocsUnit[]=(traced?.flows??[]).map((flow)=>({docsDir:"docs",flow}));
          await pool([...flowUnits]);
          const root=units.at(-1)!;
          await run(flowUnits.length?{...root,flows:flowUnits.map((unit)=>unit.flow!.slug)}:root);
          opts.signal?.throwIfAborted();
          // A unit whose merge found main busy is in the worktree's history; this merges what is still missing.
          await mergeDocs(place.path,work,`docs: nightly refresh ${scope.localDate}`);
          await bb.storage.kv.set(stateKey,{date:scope.localDate,attempts,finished:true,failed:results.slice(firstResult).filter((row)=>row.state==="failed").length});
          } finally { docsPassesRunning.delete(place.path); }
          });
          if(opts.signal) await abortable(opts.signal,inQueue()).finally(()=>docsPassesRunning.delete(place.path)); else await inQueue();
        }catch(cause){
          const reason=cause instanceof Error?cause.message:String(cause);
          results.push({projectId:project.id,path:place.path,state:"failed",reason});
          if(!pluginStopped(cause)) bb.log.warn(`Lane Pilot nightly docs failed for ${place.path}: ${reason}`);
        }
      }
    }
    return results;
  }

  /** What one docs unit's graph run is started with: everything its steps need that the unit record does not hold yet. */
  type UnitInputs={projectId:string;place:{hostId:string;path:string};basePath:string;scopes:string[];unit:DocsUnit;roots:string[];exclude:string[];
    workspaces:Array<{path:string;name:string;docsDir:string|null}>;base:string;runKey:string};
  /** What the prepare step found for a unit with work to do, handed to the write step (the unit record is made once the agent has a thread). */
  type UnitPlan={label:string;hasDocs:boolean;changed:string[];changedCount:number;refresh:string[];gaps:{missingPages:string[];uncoveredCore:string[]};
    anchors:{count:number;jev:string;briefPath?:string;deploy:boolean}|null;core:Array<{name:string;file:string;line:number;endLine:number}>;kvKey:string;
    doubts:Array<{path:string;rule:string;detail:string}>;decisionDrafts:string[];beforeDirty:string[];localDate:string;oversizedAtStart:string[]};
  /** What a unit's pass holds in this process only (the code maps fetched ahead, the pages of the units beside it): a step run after a reload does without. */
  const unitExtras=new Map<string,{prefetch:Map<string,Promise<unknown>>;othersWritable:(path:string,self:DocsUnit)=>boolean}>();

  const unitLabelOf=(unit:DocsUnit):string=>unit.flow?`docs/flows/${unit.flow.slug}.md`:unit.docsDir;
  /** The settings of a place as the docs pass reads them. */
  function docsSettingsOf(projectId:string,scopes:string[]){
    const settings=loadProjectSettings(db,projectId,scopes);
    const docs=parseDocsSettings(Object.fromEntries(["docs.enabled","docs.maintain","docs.since","docs.page_cap","docs.hour"].map((key)=>[key,configuredSetting(settings,key)])));
    return {settings,docs};
  }
  async function readUnitRecord(key:string):Promise<DocsUnitRecord|null> {
    return await bb.storage.kv.get(key).catch(()=>null) as DocsUnitRecord|null;
  }

  /** The first half of a unit: its git scope, the pages to refresh, the gaps, what Jev doubted last time. Nothing to do, or saved progress, is said in the state. */
  async function prepareDocsUnit(i:UnitInputs):Promise<{state:"skipped";row:Record<string,unknown>}|{state:"resume"}|{state:"ready";plan:UnitPlan}> {
    const {place,unit}=i;
    const {docs}=docsSettingsOf(i.projectId,i.scopes);
    const d=unit.docsDir, flow=unit.flow;
    const label=unitLabelOf(unit);
    const recordKey=docsUnitRecordKey(i.projectId,place.path,label);
    // A unit whose agent an earlier plugin instance started is picked up where it stopped, not started again.
    if(await readUnitRecord(recordKey)) return {state:"resume"};
    const writable=unitWritable(unit);
    const prefix=unit.workspace?`${unit.workspace.path}/`:"";
    const flowFiles=new Set(flow?.files??[]);
    // The root summarises every workspace (capabilities, role pages, architecture), so any change may concern it;
    // Jev's staleness check picks the root pages a change actually makes wrong.
    const inUnit=(path:string)=>flow?flowFiles.has(path):prefix?path.startsWith(prefix):true;
    const report=(state:string,extra:Record<string,unknown>={}):Record<string,unknown>=>({projectId:i.projectId,path:i.basePath||place.path,docsDir:label,state,...extra});
    const gitScope=(base?:string)=>host.call("gitDocsScope",{requestedHostId:place.hostId,projectCwd:place.path,sinceEpochMs:docsSinceEpoch(docs.since,new Date()),docsDir:label,
      ...(unit.flows?.length?{exclude:["docs/flows"]}:{}),...(base?{base}:{})},{hostId:place.hostId,timeoutMs:120_000});
    const before=await gitScope(i.base||undefined);
    if(before.status!=="ready") throw new Error(`git scope failed: ${before.reason}`);
    const changed=before.changed.filter(inUnit);
    // Every docs folder of the place, so links and contradictions across folders are seen; this unit writes only its own.
    let oversized:string[]=[];
    const allPages=async()=>{
      const listed=await host.call("listDocsPages",{requestedHostId:place.hostId,projectCwd:place.path,roots:i.roots,skipOversized:true},{hostId:place.hostId,timeoutMs:120_000});
      oversized=listed.oversized??[];
      return listed.pages as Array<{path:string;sha256:string;content:string}>;
    };
    const mine=(pages:Array<{path:string;sha256:string;content:string}>)=>pages.filter((page)=>flow?writable(page.path):page.path.startsWith(`${d}/`));
    // A folder has docs when it has pages of its own: the root's docs/ may hold only flow pages other passes wrote.
    const hasDocs=before.hasDocs&&(await allPages()).some((page)=>writable(page.path)&&!isDocsIndex(page.path));
    // Docs an earlier pass left uncommitted still need checking and committing.
    const pending=before.dirty.some(writable);
    // The root turns the decision drafts agents recorded into ADRs; a draft its decisions page does not name is work.
    const decisionDrafts=unit.workspace||flow?[]:await (async()=>{
      const drafts=(await host.call("listDocsPages",{requestedHostId:place.hostId,projectCwd:place.path,roots:[".agents/decisions"],skipOversized:true},{hostId:place.hostId,timeoutMs:60_000}).catch(()=>null))?.pages??[];
      if(!drafts.length) return [];
      const decisions=(await allPages()).find((page)=>page.path===`${d}/decisions.md`)?.content??"";
      return drafts.map((page)=>page.path).filter((path)=>!decisions.includes(path)).sort();
    })();
    if(hasDocs&&changed.length===0&&!pending&&!decisionDrafts.length) return {state:"skipped",row:report("skipped",{reason:"no code changes"})};
    const existing=hasDocs?mine(await allPages()):[];
    // The root README.md and PROJECT.md describe the code too, so they are checked for staleness with the root docs.
    const readRootPages=async()=>unit.workspace||flow?[]:(await Promise.all(["README.md","PROJECT.md"].map(async(path)=>{
      const file=await bb.sdk.files.read({hostId:place.hostId,rootPath:place.path,path:resolve(place.path,path)}).catch(()=>null);
      return file&&typeof file.content==="string"?{path,content:file.content}:null;
    }))).filter((page):page is {path:string;content:string}=>page!==null);
    const rootPages=hasDocs?await readRootPages():[];
    const pageInput=existing.filter((page)=>!isDocsIndex(page.path)).map((page)=>({path:page.path,content:page.content}));
    // Jev judges which sections the day's diff made wrong; without it, pages whose sources changed.
    const prefetched=flow?undefined:unitExtras.get(recordKey)?.prefetch.get(d) as Promise<Awaited<ReturnType<typeof host.call<"docsAnchors">>>|null>|undefined;
    const anchors=flow?null:prefetched?await prefetched:await host.call("docsAnchors",{requestedHostId:place.hostId,projectCwd:place.path,prefix,
      ...(unit.workspace?{}:{exclude:i.exclude,...(i.workspaces.length?{workspaces:i.workspaces}:{})}),
      pages:pageInput.map((page)=>({path:page.path,title:/^title:\s*(.+)$/m.exec(page.content)?.[1]?.trim()??page.path}))},{hostId:place.hostId,timeoutMs:1_800_000}).catch(()=>null);
    const gaps=hasDocs&&!flow?docsCompletenessGaps(existing,{tables:anchors?.tables??[],deploy:anchors?.deploy??false,core:anchors?.core??[],docsDir:d,workspace:Boolean(unit.workspace),
      flows:unit.flows}):{missingPages:[],uncoveredCore:[]};
    // What the depth check holds the pages to: the core code of the folder, or what the flow's entries call.
    const core=anchors?.core??flow?.calls??[];
    let refresh=hasDocs?pagesToRefresh(existing,changed):[];
    if(hasDocs){
      const stale=await host.call("docsStaleness",{requestedHostId:place.hostId,projectCwd:place.path,base:before.base??"HEAD",
        changed,pages:[...pageInput,...rootPages]},{hostId:place.hostId,timeoutMs:600_000}).catch(()=>null);
      if(stale&&stale.jev!=="disabled"){
        const cited=new Set(existing.flatMap((page)=>citedFiles([page])));
        const product=new Set(anchors&&anchors.jev!=="disabled"?anchors.productFiles:changed);
        const uncovered=changed.filter((file)=>product.has(file)&&!cited.has(file));
        if(!pending&&!decisionDrafts.length&&!stale.refresh.length&&!uncovered.length&&!gaps.missingPages.length&&!gaps.uncoveredCore.length) return {state:"skipped",row:report("skipped",{reason:"Jev found no section the changes made wrong, and no changed product file is undocumented"})};
        refresh=stale.refresh;
      }
    }
    // What Jev still doubted after this unit's last pass goes back to the agent to recheck, while the page exists.
    const kvKey=`docs-nightly:${i.projectId}:${sha256(`${place.path}\n${label}`).slice(0,12)}`;
    const last=hasDocs?await bb.storage.kv.get(kvKey).catch(()=>null) as {warnings?:Array<{path:string;rule:string;detail:string}>}|null:null;
    const pagePaths=new Set(existing.map((page)=>page.path));
    const doubts=(last?.warnings??[]).filter((warning)=>(warning.rule==="evidence-check"||warning.rule==="contradiction")&&pagePaths.has(warning.path));
    return {state:"ready",plan:{label,hasDocs,changed,changedCount:changed.length,refresh,gaps,
      anchors:anchors?{count:anchors.anchors,jev:anchors.jev,...(anchors.briefPath?{briefPath:anchors.briefPath}:{}),deploy:anchors.deploy??false}:null,
      core:core.slice(0,2000),kvKey,doubts,decisionDrafts,beforeDirty:before.dirty,localDate:before.localDate,
      // Pages an earlier failed pass left oversized are this unit's work, not the base's.
      oversizedAtStart:oversized.filter((path)=>!before.dirty.includes(path))}};
  }

  /** Whether a unit's night is long gone, so it is not finished from saved progress. */
  function nightIsOver(record:{localDate:string}):boolean { return Date.now()-Date.parse(`${record.localDate}T00:00:00Z`)>DOCS_UNIT_RESUME_MS; }

  /**
   * The second step of a unit: the docs agent. Starts it (once: the unit record names its thread, and its spawn key is the unit's night) and waits
   * until its turn ends. A unit with saved progress does not start a second agent; one in its repair round is waited for in the verify step.
   */
  async function writeDocsUnit(i:UnitInputs,plan:UnitPlan|null,step:{runId:string;stepKey:string;nodeId:string},stop:()=>string|null):Promise<string> {
    const {place,unit}=i;
    const label=unitLabelOf(unit);
    const recordKey=docsUnitRecordKey(i.projectId,place.path,label);
    let record=await readUnitRecord(recordKey);
    if(!record){
      if(!plan) throw new Error("docs unit has neither a plan nor saved progress");
      const {settings,docs}=docsSettingsOf(i.projectId,i.scopes);
      const selection=docsSelection(settings,resolveSpawnModel({role:"docs-maintainer",settings,catalog:modelCatalogOf(ctx).peek(),hostId:place.hostId}));
      const [providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:place.hostId}),bb.sdk.providers.models({providerId:selection.providerId,hostId:place.hostId})]);
      const provider=providers.find((item)=>item.id===selection.providerId&&item.available);
      const model=catalog.models.find((item)=>item.id===selection.model||item.model===selection.model);
      if(!provider||!model) throw new Error(`docs provider or model unavailable: ${selection.providerId}/${selection.model}`);
      const effort=selection.reasoningLevel;
      const tier=provider.capabilities.supportsServiceTier?bbServiceTier(selection.serviceTier):null;
      const threadId=await spawnDocsThread({projectId:i.projectId,visibility:"hidden",title:`Lane Pilot docs: ${basename(place.path)}${unit.workspace?` · ${unit.workspace.path}`:unit.flow?` · flow ${unit.flow.slug}`:""}`,
        ...writerExecutionSelection(selection.providerId,selection.model,effort,tier),
        ...projectRoleField(bb,db,i.projectId,selection.providerId,"docs-maintainer"),
        prompt:nightlyDocsPrompt({since:docs.since,hasDocs:plan.hasDocs,changed:plan.changed,refresh:plan.refresh,anchorsPath:plan.anchors?.briefPath,deploy:plan.anchors?.deploy??false,missingPages:plan.gaps.missingPages,uncoveredCore:plan.gaps.uncoveredCore,
          agent:typeof settings["docs.agent"]==="string"?settings["docs.agent"] as string:undefined,unit,doubts:plan.doubts,decisionDrafts:plan.decisionDrafts}),
        environment:{type:"host",hostId:place.hostId,workspace:{type:"unmanaged",path:place.path}},
        pluginMetadata:{role:"docs-nightly",stageId:"docs-nightly",spawnId:`${i.projectId}:${sha256(`${place.path}\n${label}`).slice(0,12)}:${plan.localDate}`,...graphStepMetadata(step)}});
      // From here on the unit's progress is saved, so a plugin reload picks the same agent thread up again.
      record={version:1,projectId:i.projectId,place,...(i.basePath&&i.basePath!==place.path?{basePath:i.basePath}:{}),label,unit,threadId,phase:"writing",beforeDirty:plan.beforeDirty,localDate:plan.localDate,
        since:docs.since,roots:i.roots,workspaces:i.workspaces,hasDocs:plan.hasDocs,changedCount:plan.changedCount,refresh:plan.refresh,gaps:plan.gaps,
        anchors:plan.anchors?{count:plan.anchors.count,jev:plan.anchors.jev}:null,core:plan.core,kvKey:plan.kvKey,oversizedAtStart:plan.oversizedAtStart,runKey:i.runKey};
      await saveDocsUnitRecord(record);
    }
    // A unit of a night long gone is not waited for: the verify step drops it.
    if(record.phase==="writing"&&!nightIsOver(record)){
      try{ await waitThreadIdle(bb,record.threadId,"docs_nightly",undefined,undefined,stop); }
      catch(cause){
        // The agent's thread failed: the unit is done for tonight, its pages stay pending. A reload keeps the progress for the next instance.
        if(!pluginStopped(cause)&&!ctx.isDisposed()) await dropDocsUnitRecord(record).catch(()=>undefined);
        throw cause;
      }
    }
    return record.threadId;
  }

  /**
   * One docs unit as a graph run (`lp.docs-night`): the same key is the same run, so a retry after a reload or a second tick finds the run that
   * has the unit and waits for it. Returns the unit's report, the row the pass collects; a run that failed throws, as the unit's code did.
   */
  async function runDocsUnit(c:{projectId:string;place:{hostId:string;path:string};basePath?:string;scopes?:string[];localDate?:string;attempt?:number;settings?:Record<string,unknown>;docs?:ReturnType<typeof parseDocsSettings>;base?:string;
    roots:string[];exclude:string[];workspaces:Array<{path:string;name:string;docsDir:string|null}>;prefetch:Map<string,Promise<unknown>>;
    othersWritable:(path:string,self:DocsUnit)=>boolean},unit:DocsUnit):Promise<Record<string,unknown>> {
    const label=unitLabelOf(unit);
    const recordKey=docsUnitRecordKey(c.projectId,c.place.path,label);
    // A unit with saved progress keeps the run that saved it (an older version's record has none: its night is the key).
    const open=await readUnitRecord(recordKey);
    const runKey=open?(open.runKey??`docs-night:${recordKey}:${open.localDate}:0`):`docs-night:${recordKey}:${c.localDate??localDateKey(new Date())}:${c.attempt??1}`;
    unitExtras.set(recordKey,{prefetch:c.prefetch,othersWritable:c.othersWritable});
    try{
      return await startUnitRun({projectId:c.projectId,place:c.place,basePath:c.basePath&&c.basePath!==c.place.path?c.basePath:"",scopes:c.scopes??[],unit,roots:c.roots,exclude:c.exclude,workspaces:c.workspaces,base:c.base??"",runKey},recordKey);
    }finally{ unitExtras.delete(recordKey); }
  }

  async function startUnitRun(i:UnitInputs,recordKey:string):Promise<Record<string,unknown>> {
    const engine=services.workflowEngine;
    const workflow=builtinWorkflow(DOCS_NIGHT);
    if(!workflow) throw new Error(`built-in workflow ${DOCS_NIGHT} is not loaded`);
    const started=engine.start({workflow,key:i.runKey,link:{projectId:i.projectId},inputs:{project_id:i.projectId,host_id:i.place.hostId,path:i.place.path,base_path:i.basePath,scopes:i.scopes,unit:i.unit,
      roots:i.roots,exclude:i.exclude,workspaces:i.workspaces,base:i.base,run_key:i.runKey}});
    let summary:Awaited<typeof started.done>;
    try{ summary=await started.done; }
    finally{ docsUnitsFinishing.delete(recordKey); }
    if(summary.status==="succeeded"){
      const row=(summary.output??{}).row;
      if(row&&typeof row==="object") return row as Record<string,unknown>;
      throw new Error(`docs unit run ${summary.runId} gave no report`);
    }
    // The engine stopped at a step boundary (a reload): the run goes on in the next instance, the unit record keeps its progress.
    if(summary.stopped||ctx.isDisposed()) throw new Error("plugin reloaded: the docs unit run goes on in the next instance");
    throw new Error(summary.error??summary.reason??`docs unit run ${summary.status}`);
  }

  /** The key a unit's saved progress lives under, and the index of units with progress not yet finished. */
  function docsUnitRecordKey(projectId:string,placePath:string,label:string):string {
    return `docs-unit:${projectId}:${sha256(`${placePath}\n${label}`).slice(0,12)}`;
  }

  const DOCS_UNITS_OPEN_KEY="docs-units-open";

  let docsUnitsIndexChain:Promise<unknown>=Promise.resolve();

  /** Index writes go one at a time: units of a pass save their progress side by side. */
  function updateDocsUnitsIndex(change:(open:Record<string,true>)=>void):Promise<void> {
    const next=docsUnitsIndexChain.then(async()=>{
      const open=(await bb.storage.kv.get(DOCS_UNITS_OPEN_KEY).catch(()=>null) as Record<string,true>|null)??{};
      change(open);
      await bb.storage.kv.set(DOCS_UNITS_OPEN_KEY,open);
    });
    docsUnitsIndexChain=next.catch(()=>undefined);
    return next;
  }

  async function saveDocsUnitRecord(record:DocsUnitRecord):Promise<void> {
    const key=docsUnitRecordKey(record.projectId,record.place.path,record.label);
    await bb.storage.kv.set(key,record);
    await updateDocsUnitsIndex((open)=>{ open[key]=true; });
  }

  async function dropDocsUnitRecord(record:DocsUnitRecord):Promise<void> {
    const key=docsUnitRecordKey(record.projectId,record.place.path,record.label);
    await bb.storage.kv.delete(key).catch(()=>undefined);
    await updateDocsUnitsIndex((open)=>{ delete open[key]; });
  }

  /** Units finishing in this plugin process, by record key; resumption never runs one twice. */
  const docsUnitsFinishing=new Map<string,DocsUnit>();

  /** A reload or a retired host generation stops this instance, not the unit: its progress stays for the next one. */
  /** How long after the start of its night a unit may still be finished from saved progress. */
  const DOCS_UNIT_RESUME_MS=48*3_600_000;

  // A reload stops a pass in flight: its API handle goes stale and its database closes. The catch-up resumes it.
  // Its host calls end too: the daemon disposes the retired generation's worker, which exits with 0 and rejects the
  // calls still pending with «host plugin worker exited (0)», and the core aborts the schedule run, whose signal
  // cancels the rest («Host plugin call was cancelled»). A worker that crashes or is killed exits otherwise and stays a failure.
  const pluginStopped=(cause:unknown)=>/stale API handle|generation .* is retired|plugin .* (reloaded|disabled)|database connection is not open|host plugin worker exited \(0\)|^Host plugin call was cancelled$/i.test(cause instanceof Error?cause.message:String(cause));

  /** The checks of a unit's pages: what the agent touched, what is dirty in its docs, per-page citation stats, the findings that block and the ones left as warnings. */
  type DocsFinding={path:string;rule:string;detail:string};
  type Checked={touched:string[];docsDirty:string[];pageStats:Array<{path:string;checked:number;supported:number;partial:number}>;findings:DocsFinding[];kept:DocsFinding[]};
  type Verified={checked:Checked;warnings:DocsFinding[];reverted:string[]};

  /** The units whose graph run a catch-up tick already holds in this process: the next tick does not join it a second time. */
  const activeUnitRuns=new Set<string>();

  /**
   * The third step of a unit: wait for the repair round if one was in flight, check the pages the way the methodology asks, give the agent one
   * round to fix, and say which findings block and which are only Jev's doubts. What the agent changed outside every docs folder is put back
   * first; other folders' passes may be writing theirs.
   */
  async function verifyDocsUnit(key:string,stop:()=>string|null):Promise<{state:"skipped";row:Record<string,unknown>}|{state:"ok";verified:Verified;threadId:string}> {
    const record=await readUnitRecord(key);
    if(!record) throw new Error("docs unit record is gone");
    const {place,unit,threadId,label}=record;
    // A unit from a night long gone is not finished: its list of files dirty before the agent is stale, so what is
    // dirty now would pass for the agent's changes and be reverted. Its pages stay for the next pass.
    if(nightIsOver(record)){
      await dropDocsUnitRecord(record);
      bb.log.info(`Lane Pilot docs unit ${place.path} ${label} of ${record.localDate} dropped: its night is over`);
      return {state:"skipped",row:{projectId:record.projectId,path:place.path,docsDir:label,state:"skipped",reason:"night_over"}};
    }
    docsUnitsFinishing.set(key,unit);
    const othersWritable=unitExtras.get(key)?.othersWritable??((path:string,self:DocsUnit)=>[...docsUnitsFinishing.values()].some((other)=>other!==self&&unitWritable(other)(path)));
    try{
      const d=unit.docsDir, flow=unit.flow, writable=unitWritable(unit);
      const gitScope=()=>host.call("gitDocsScope",{requestedHostId:place.hostId,projectCwd:place.path,sinceEpochMs:docsSinceEpoch(record.since,new Date()),docsDir:label,
        ...(unit.flows?.length?{exclude:["docs/flows"]}:{})},{hostId:place.hostId,timeoutMs:120_000});
      let oversized:string[]=[];
      const allPages=async()=>{
        const listed=await host.call("listDocsPages",{requestedHostId:place.hostId,projectCwd:place.path,roots:record.roots,skipOversized:true},{hostId:place.hostId,timeoutMs:120_000});
        oversized=listed.oversized??[];
        return listed.pages as Array<{path:string;sha256:string;content:string}>;
      };
      const mine=(pages:Array<{path:string;sha256:string;content:string}>)=>pages.filter((page)=>flow?writable(page.path):page.path.startsWith(`${d}/`));
      const readRootPages=async()=>unit.workspace||flow?[]:(await Promise.all(["README.md","PROJECT.md"].map(async(path)=>{
        const file=await bb.sdk.files.read({hostId:place.hostId,rootPath:place.path,path:resolve(place.path,path)}).catch(()=>null);
        return file&&typeof file.content==="string"?{path,content:file.content}:null;
      }))).filter((page):page is {path:string;content:string}=>page!==null);
      const core=record.core;
      const before={dirty:record.beforeDirty};
      if(record.phase==="repairing") await waitThreadIdle(bb,threadId,"docs_nightly_repair",undefined,record.sentAt,stop);
      const reverted:string[]=[];
      // Check the pages the way the methodology asks, give the agent one round to fix, then index and commit.
      const inspect=async():Promise<Checked>=>{
        const after=await gitScope();
        const touched=after.dirty.filter((path)=>!before.dirty.includes(path));
        const outside=touched.filter((path)=>!writable(path)&&!othersWritable(path,unit)&&!DOCS_TOOLING.test(path));
        if(outside.length){
          const undone=await host.call("gitRevertPaths",{requestedHostId:place.hostId,projectCwd:place.path,paths:outside},{hostId:place.hostId,timeoutMs:120_000});
          reverted.push(...undone.reverted);
          if(undone.failed.length) throw new Error(`could not revert files the docs agent changed outside docs: ${undone.failed.join(", ")}`);
        }
        const pages=await allPages();
        const counts=(await host.call("docsLineCounts",{requestedHostId:place.hostId,projectCwd:place.path,files:citedFiles(mine(pages))},{hostId:place.hostId,timeoutMs:60_000})).counts;
        const docsDirty=after.dirty.filter(writable);
        // Pages too large to read still exist: links to them resolve, the size check reports them.
        // Only what this pass wrote, or a link to a page it removed, blocks it: untouched pages are on main as they are.
        // A page already oversized when the agent started is reported, not split now: its unread content would block.
        const sized=oversizedPageFindings(oversized.filter(writable),record.oversizedAtStart??[]);
        const findings:DocsFinding[]=blockingDocsFindings([...sized.blocking,
          ...lintDocsPages(pages,counts,oversized).filter((finding)=>writable(finding.path))],docsDirty);
        // The capabilities catalogue covers every capability the apps document, not only the ones inside a flow.
        const catalogue=unit.flows?.length?pages.find((page)=>page.path===`${d}/capabilities.md`):undefined;
        if(catalogue){
          const features=pages.map((page)=>page.path).filter((path)=>/^apps\/[^/]+\/docs\/features\/[^/]+\.md$/.test(path));
          // A link on an area page the catalogue links (docs/capabilities/<area>.md) counts: the size limit splits it.
          for(const path of uncataloguedPages(catalogue,pages,features)) findings.push({path:catalogue.path,rule:"coverage",detail:`does not link ${path}: add the capability that page describes, with its conditions and where it is available, citing the code that page cites (never the page itself), and link it from ${d}/capabilities.md or an area page it links under ${d}/capabilities/ (operator tools under operator capabilities); keep the links already there`});
        }
        let pageStats:Checked["pageStats"]=[];
        // Structure first; once it holds, Jev checks each claim against its cited lines on the pages written now,
        // and pairs of claims across all the docs that cite the same code for contradictions.
        if(!findings.length){
          const all=[...pages.filter((page)=>!isDocsIndex(page.path)).map((page)=>({path:page.path,content:page.content})),...await readRootPages()];
          const written=all.filter((page)=>docsDirty.includes(page.path));
          const cited=written.length?await host.call("docsVerifyCitations",{requestedHostId:place.hostId,projectCwd:place.path,
            pages:written.slice(0,500),related:all.filter((page)=>!docsDirty.includes(page.path)).slice(0,500)},{hostId:place.hostId,timeoutMs:1_800_000}).catch(()=>null):null;
          findings.push(...(cited?.findings??[]));
          pageStats=cited?.pageStats??[];
          // And whether the written pages explain the core code well enough that nobody has to open it.
          // Only pages meant to explain behaviour are held to it; summaries and references link down instead.
          const explaining=written.filter((page)=>/^type:\s*(component|flow)\s*$/m.test(page.content));
          const depth=explaining.length&&core.length?await host.call("docsDepth",{requestedHostId:place.hostId,projectCwd:place.path,
            pages:explaining.slice(0,500),core:core.slice(0,2000)},{hostId:place.hostId,timeoutMs:900_000}).catch(()=>null):null;
          findings.push(...(depth?.findings??[]));
        }
        return {touched,docsDirty,pageStats,findings,kept:blockingDocsFindings(sized.kept,docsDirty)};
      };
      let checked=await inspect();
      if(record.phase==="writing"&&checked.findings.length){
        // The repair counts only once its own turn completes, not the turn the agent already finished.
        const sentAt=Date.now()-2_000;
        await saveDocsUnitRecord({...record,phase:"repairing",sentAt});
        await bb.sdk.threads.send({threadId,mode:"queue-if-active",input:[{type:"text",text:docsRepairPrompt(checked.findings),mentions:[]}]});
        await waitThreadIdle(bb,threadId,"docs_nightly_repair",undefined,sentAt,stop);
        checked=await inspect();
      }
      // A Jev judgment is a signal, not a verdict: once the agent has rechecked it in the repair round,
      // what Jev alone still doubts goes to the report as a warning; the deterministic checks keep blocking.
      const judged=(finding:{rule:string})=>finding.rule==="evidence-check"||finding.rule==="contradiction"||finding.rule==="depth"||finding.rule==="links-external";
      const warnings=[...checked.findings.filter(judged),...checked.kept];
      checked={...checked,findings:checked.findings.filter((finding)=>!judged(finding))};
      return {state:"ok",verified:{checked,warnings,reverted},threadId};
    }catch(cause){
      // The agent's thread failed or its work cannot be checked: the unit is done for tonight, its pages stay pending.
      if(!pluginStopped(cause)&&!ctx.isDisposed()) await dropDocsUnitRecord(record).catch(()=>undefined);
      docsUnitsFinishing.delete(key);
      throw cause;
    }
  }

  /**
   * The last step of a unit: builders own what the model must not write (Referenced by blocks, verified confidence, the index); the pages that passed
   * are committed (code never is) and merged into the project checkout under the writers' merge lock. The report is the unit's row.
   */
  async function commitDocsUnit(key:string,verified:Verified):Promise<Record<string,unknown>> {
    const record=await readUnitRecord(key);
    if(!record) throw new Error("docs unit record is gone");
    const {place,unit,threadId,label}=record;
    try{
      const d=unit.docsDir, flow=unit.flow, writable=unitWritable(unit);
      const {checked,warnings,reverted}=verified;
      const report=(state:string,extra:Record<string,unknown>={}):Record<string,unknown>=>({projectId:record.projectId,path:record.basePath??place.path,docsDir:label,state,...extra});
      const allPages=async()=>{
        const listed=await host.call("listDocsPages",{requestedHostId:place.hostId,projectCwd:place.path,roots:record.roots,skipOversized:true},{hostId:place.hostId,timeoutMs:120_000});
        return listed.pages as Array<{path:string;sha256:string;content:string}>;
      };
      let commit:string|null=null, merged:string|null=null;
      // Every page this pass wrote passed the checks, pages an earlier pass left uncommitted included, so they go in; code never does.
      if(!checked.findings.length&&checked.docsDirty.length){
        // They work on the pages as they are on disk now, and rebuild once if a page moved under them.
        const stats=new Map(checked.pageStats.map((stat)=>[stat.path,stat]));
        const index=`${d}/index.md`;
        const linked=unit.workspace?[]:record.workspaces.flatMap((workspace)=>workspace.docsDir?[{name:workspace.name,docsDir:workspace.docsDir}]:[]);
        // Pages the builders rewrote (backlinks, confidence, the index) go into the commit with the agent's.
        const rebuilt:string[]=[];
        for(let attempt=0;;attempt++){
          const fresh=await allPages();
          // Builders rewrite only this unit's pages; the index lists every page of the folder.
          const built=buildBacklinks(fresh).filter((page)=>page.path.startsWith(`${d}/`)).map((page)=>{
            const stat=stats.get(page.path);
            const sourced=withCitedSources(page.content);
            return {path:page.path,content:stat?withVerifiedConfidence(sourced,stat):sourced};
          });
          const current=fresh.find((page)=>page.path===index);
          const edits=[
            ...built.filter((page)=>writable(page.path)).flatMap((page)=>{
              const original=fresh.find((row)=>row.path===page.path)!;
              return original.content===page.content?[]:[{path:page.path,expectedSha256:original.sha256,content:page.content}];
            }),
            ...(flow?[]:[{path:index,expectedSha256:current?.sha256??null,content:buildDocsIndex(built,d,linked)}]),
          ].filter((edit)=>edit.path!==index||current?.content!==edit.content);
          if(!edits.length) break;
          const applied=await host.call("writeDocsPages",{requestedHostId:place.hostId,projectCwd:place.path,
            previewSha256:sha256(JSON.stringify(edits)),edits},{hostId:place.hostId,timeoutMs:120_000});
          if(applied.status==="applied"){ rebuilt.push(...edits.map((edit)=>edit.path)); break; }
          if(attempt>=1) throw new Error(`docs builders could not write pages: ${applied.reason??applied.status}`);
        }
        const committed=await host.call("gitCommitDocs",{requestedHostId:place.hostId,projectCwd:place.path,
          paths:[...new Set([...checked.docsDirty,...rebuilt,...(flow?[]:[index])])],message:`docs${unit.workspace?`(${unit.workspace.path})`:flow?`(flow ${flow.slug})`:""}: ${record.hasDocs?"nightly refresh":"onboarding"} ${record.localDate}`},{hostId:place.hostId,timeoutMs:120_000});
        if(committed.status==="failed") throw new Error(`docs commit failed: ${committed.reason}`);
        commit=committed.commit;
        if(record.basePath) merged=await mergeDocs(record.basePath,place,`docs${unit.workspace?`(${unit.workspace.path})`:flow?`(flow ${flow.slug})`:""}: ${record.hasDocs?"nightly refresh":"onboarding"} ${record.localDate}`);
      }
      const failure=checked.findings.length?`${checked.findings.length} docs checks still fail after one repair round`:null;
      const row=report(failure?"failed":"passed",{threadId,onboarding:!record.hasDocs,changedCode:record.changedCount,refreshed:record.refresh,gaps:record.gaps,anchors:record.anchors,
        docsWritten:checked.touched.filter(writable),commit,...(merged?{merged}:{}),...(reverted.length?{reverted}:{}),...(warnings.length?{warnings}:{}),...(failure?{reason:failure,findings:checked.findings.slice(0,30)}:{})});
      await bb.storage.kv.set(record.kvKey,{...row,at:Date.now()});
      await dropDocsUnitRecord(record);
      // A failed unit names why, so the line the watcher reads carries the cause; the findings are in the unit's KV row.
      bb.log.info(`Lane Pilot nightly docs ${row.state} for ${record.basePath??place.path} ${label}${merged?` (merge ${merged})`:""}${failure?`: ${failure}`:""}`);
      return row;
    }catch(cause){
      if(!pluginStopped(cause)&&!ctx.isDisposed()) await dropDocsUnitRecord(record).catch(()=>undefined);
      throw cause;
    }finally{ docsUnitsFinishing.delete(key); }
  }

  /**
   * A unit with saved progress, finished on its own graph run: the run that saved it (or, for a record an older version saved, a run made now) goes on
   * from the record. Safe to call again: the same run is the same run. Returns the unit's report.
   */
  async function finishDocsUnit(record:DocsUnitRecord,othersWritable:(path:string,self:DocsUnit)=>boolean):Promise<Record<string,unknown>> {
    const key=docsUnitRecordKey(record.projectId,record.place.path,record.label);
    const runKey=record.runKey??`docs-night:${key}:${record.localDate}:0`;
    if(activeUnitRuns.has(runKey)) return {projectId:record.projectId,path:record.place.path,docsDir:record.label,state:"skipped",reason:"already finishing"};
    activeUnitRuns.add(runKey);
    unitExtras.set(key,{prefetch:new Map(),othersWritable});
    try{
      return await startUnitRun({projectId:record.projectId,place:record.place,basePath:record.basePath??"",scopes:[],unit:record.unit,roots:record.roots,exclude:[],workspaces:record.workspaces,base:"",runKey},key);
    }finally{ activeUnitRuns.delete(runKey); unitExtras.delete(key); }
  }

  /**
   * The executors of the docs graphs. Registered by server.ts once the workflow engine exists (the services are assembled before it is). Every step is
   * reentrant: the unit record and the git state are the progress, so a step a reload cut off is simply run again, and while the plugin is stopping a
   * step holds instead of failing, so the run is picked up by the next instance.
   */
  function registerDocsGraphs(engine:WorkflowEngine):void {
    const held=async<T>(work:()=>Promise<T>):Promise<T>=>{
      try{ return await work(); }
      catch(cause){ if(ctx.isDisposed()) return await new Promise<T>(()=>undefined); throw cause; }
    };
    const stopOf=(c:StepContext)=>():string|null=>ctx.isDisposed()?"plugin_stopped":c.signal.aborted?"aborted":null;
    const input=(c:StepContext,name:string)=>c.resolve(`$inputs.${name}`);
    const text=(value:unknown)=>typeof value==="string"?value:"";
    const list=(value:unknown):string[]=>Array.isArray(value)?value.map(String):[];
    const inputsOf=(c:StepContext):UnitInputs=>({projectId:text(input(c,"project_id")),place:{hostId:text(input(c,"host_id")),path:text(input(c,"path"))},basePath:text(input(c,"base_path")),
      scopes:list(input(c,"scopes")),unit:input(c,"unit") as DocsUnit,roots:list(input(c,"roots")),exclude:list(input(c,"exclude")),workspaces:(Array.isArray(input(c,"workspaces"))?input(c,"workspaces"):[]) as UnitInputs["workspaces"],
      base:text(input(c,"base")),runKey:text(input(c,"run_key"))});
    const keyOf=(i:UnitInputs)=>docsUnitRecordKey(i.projectId,i.place.path,unitLabelOf(i.unit));
    const earlier=(c:StepContext,ref:string):unknown=>{ try{ return c.resolve(ref); }catch{ return undefined; } };

    engine.register("lp.docs_prepare",{reentrant:true,run:(c)=>held(async()=>{
      const found=await prepareDocsUnit(inputsOf(c));
      return {output:found.state==="skipped"?{state:"skipped",row:found.row}:found.state==="resume"?{state:"resume"}:{state:"ready",plan:found.plan}};
    })});

    engine.register("lp.docs-unit",{reentrant:true,run:(c)=>held(async()=>{
      const i=inputsOf(c);
      const threadId=await writeDocsUnit(i,(earlier(c,"prepare.plan") as UnitPlan|undefined)??null,{runId:c.runId,stepKey:c.stepKey,nodeId:c.nodeId},stopOf(c));
      return {output:{state:"written",thread_id:threadId,handoff:`docs agent ended in ${threadId}`},threadId};
    })});

    engine.register("lp.docs_verify",{reentrant:true,run:(c)=>held(async()=>{
      const i=inputsOf(c);
      const done=await verifyDocsUnit(keyOf(i),stopOf(c));
      if(done.state==="skipped") return {output:{state:"skipped",row:done.row}};
      return {output:{state:"ok",checked:done.verified},...(await withUsage(bb,done.threadId))};
    })});

    engine.register("lp.docs_commit",{reentrant:true,run:(c)=>held(async()=>{
      const i=inputsOf(c);
      const verified=earlier(c,"verify.checked") as Verified|undefined;
      if(!verified) throw new Error("docs unit has no verified pages to commit");
      return {output:{row:await commitDocsUnit(keyOf(i),verified)}};
    })});

    // The docs upkeep of one accepted task: the stage function is called until its receipt is final, as the hourly schedule called it.
    engine.register("lp.docs-maintenance",{reentrant:true,run:(c)=>held(async()=>{
      const runId=text(input(c,"run_id")), taskId=text(input(c,"task_id")), threadId=text(input(c,"pm_thread_id"));
      const projectId=engine.journal.getRun(c.runId)?.project_id??getRun(db,runId)?.project_id??"";
      const since=Date.now();
      let result:Record<string,unknown>={state:"running"};
      try{
        for(let round=0;round<60&&!ctx.isDisposed()&&!c.signal.aborted;round++){
          result=await services.runDocsMaintenance({threadId,projectId,runId,taskId,timeoutSec:60,workflow:{runId:c.runId,stepKey:c.stepKey,nodeId:c.nodeId}});
          if(result.state!=="running") break;
        }
      }catch(cause){
        if(ctx.isDisposed()||pluginStopped(cause)) throw cause;
        const reason=cause instanceof Error?cause.message:String(cause);
        bb.log.warn(`Lane Pilot docs maintenance failed for project ${projectId}: ${reason}`);
        result={state:"failed",reason};
      }
      if(ctx.isDisposed()) return await new Promise<never>(()=>undefined);
      const receipt=listStageReceipts(db,runId,taskId).find((row)=>row.stageId==="docs-maintenance");
      const usage=receipt?.threadId&&receipt.updatedAt>=since?await withUsage(bb,receipt.threadId):{};
      const state=text(result.state), reason=text(result.reason);
      return {output:{state,...(reason?{reason}:{}),handoff:`docs-maintenance ${state}${reason?`: ${reason}`:""}`},...usage};
    })});

    // The verdict of the upkeep: a stage that failed or was blocked fails the graph run (its step above keeps the output and what it spent).
    // `running` is not red: the stage is still observing and the next hour's run picks its receipt up again.
    engine.register("lp.docs-maintenance.verdict",{reentrant:true,run:async(c)=>{
      const state=text(earlier(c,"docs.state")), reason=text(earlier(c,"docs.reason"));
      requireGreen("docs_maintenance",[{stage:"docs-maintenance",state,reason}],new Set(["failed","blocked"]));
      return {output:{state}};
    }});
  }

  /**
   * The docs upkeep of one accepted task as a graph run (`lp.docs-maintenance`). The run of an earlier hour that is still going is joined; one that
   * ended with the receipt still open (the stage was still observing) is followed by a new run, as the hour before called the stage again.
   */
  async function runDocsMaintenanceGraph(args:{threadId:string;projectId:string;runId:string;taskId:string}):Promise<void> {
    const engine=services.workflowEngine;
    const workflow=builtinWorkflow(DOCS_MAINTENANCE);
    if(!workflow) throw new Error(`built-in workflow ${DOCS_MAINTENANCE} is not loaded`);
    const prefix=`docs-maintenance:${args.runId}:${args.taskId}:`;
    const runs=db.prepare("SELECT idem_key, status FROM lane_pilot_wf_run WHERE idem_key LIKE ? ORDER BY created_at DESC").all(`${prefix}%`) as Array<{idem_key:string;status:string}>;
    const live=runs.find((row)=>row.status==="running"||row.status==="waiting");
    const key=live?.idem_key??`${prefix}${runs.length}`;
    const started=engine.start({workflow,key,link:{projectId:args.projectId,runId:args.runId,taskId:args.taskId},inputs:{run_id:args.runId,task_id:args.taskId,pm_thread_id:args.threadId}});
    const summary=await started.done;
    if(summary.stopped||ctx.isDisposed()) throw new Error("plugin reloaded: the docs maintenance run goes on in the next instance");
    if(summary.status!=="succeeded"&&summary.status!=="running"&&summary.status!=="waiting") throw new Error(summary.error??summary.reason??`docs maintenance run ${summary.status}`);
  }

  async function runScheduledDocsMaintenance(signal?:AbortSignal):Promise<void> {
    const projectIds=(db.prepare("SELECT DISTINCT project_id FROM lane_pilot_project_settings WHERE binding_id=''").all() as Array<{project_id:string}>).map((row)=>row.project_id);
    const now=new Date(), today=localDateKey(now);
    for(const projectId of projectIds){
      signal?.throwIfAborted();
      const config=loadPrototypeConfig(db,projectId); if(!config) continue;
      const settings=loadProjectSettings(db,projectId);
      const docsSettings=parseDocsSettings(Object.fromEntries(["docs.enabled","docs.maintain","docs.since","docs.page_cap","docs.hour"].map((key)=>[key,configuredSetting(settings,key)])));
      if(!docsSettings.enabled||!docsSettings.maintain) continue;
      const activation=getActivation(db,projectId); if(!activation) continue;
      const run=getRun(db,activation.run_id); if(!run||run.closed_at||run.pm_thread_id!==activation.pm_thread_id) continue;
      const runHistory=listRunsWithAttempts(db,projectId).find((item)=>item.id===run.id);
      const taskId=runHistory?.attempts.map((item)=>item.task_id).find((candidate)=>{
        const receipts=listStageReceipts(db,run.id,candidate);
        if(!receipts.some((receipt)=>receipt.stageId==="acceptance-receipt"&&receipt.state==="passed")) return false;
        const docs=receipts.find((receipt)=>receipt.stageId==="docs-maintenance");
        return !docs || docs.state==="pending" || docs.state==="running";
      });
      if(!taskId) continue;
      // The PM chat of the run is gone (deleted or archived): maintenance reads it first and would throw "Thread not found"
      // every hour, leaving the receipt running for good (hub, 2026-10-08, layout-A3). The open receipts end canceled.
      const pm=await bb.sdk.threads.get({threadId:activation.pm_thread_id}).then((value)=>value as unknown,(cause:unknown)=>/\b404\b|not.?found/i.test(cause instanceof Error?cause.message:String(cause))?null:undefined);
      if(pm===null||(pm!==undefined&&valueAt(pm,"archivedAt")!=null)){
        for(const candidate of new Set(runHistory?.attempts.map((item)=>item.task_id))){
          const open=listStageReceipts(db,run.id,candidate).find((receipt)=>receipt.stageId==="docs-maintenance"&&(receipt.state==="pending"||receipt.state==="running"));
          if(open) recordStage(db,{runId:run.id,taskId:candidate,stageId:"docs-maintenance",state:"canceled",input:"pm_chat_gone",providerId:open.providerId,model:open.model,threadId:open.threadId,reason:"pm_chat_gone"});
        }
        bb.log.info(`Lane Pilot docs maintenance for project ${projectId} skipped: the PM chat ${activation.pm_thread_id} of run ${run.id} is gone`);
        continue;
      }
      const docs=listStageReceipts(db,run.id,taskId).find((receipt)=>receipt.stageId==="docs-maintenance");
      const resume=docs?.state==="pending"||docs?.state==="running";
      if(!resume) {
        if(!docsScheduleDue(now,docsSettings.hour,null)||!claimDailySchedule(db,projectId,"docs-maintenance",today)) continue;
      }
      // One project's failure must not leave the projects after it unprocessed.
      try{ await runDocsMaintenanceGraph({threadId:activation.pm_thread_id,projectId,runId:run.id,taskId}); }
      catch(cause){
        if(signal?.aborted||pluginStopped(cause)) throw cause;
        bb.log.warn(`Lane Pilot docs maintenance failed for project ${projectId}: ${cause instanceof Error?cause.message:String(cause)}`);
      }
    }
  }

  /**
   * BB runs every plugin's schedules one after another and waits for each, so a docs pass awaited in a schedule (hours)
   * stops all of them - self-repair included. The work runs detached; a tick while it still runs is skipped.
   */
  const schedulesRunning=new Set<string>();
  function guarded(name:string,work:(signal?:AbortSignal)=>Promise<unknown>):(signal?:AbortSignal)=>Promise<void> {
    return async(signal?:AbortSignal)=>{
      if(schedulesRunning.has(name)) return;
      schedulesRunning.add(name);
      try{ await (signal?abortable(signal,Promise.resolve(work(signal))):work()); }
      catch(cause){ if(!pluginStopped(cause)) bb.log.warn(`Lane Pilot schedule ${name} failed: ${cause instanceof Error?cause.message:String(cause)}`); }
      finally{ schedulesRunning.delete(name); }
    };
  }
  /** Without the VK isolated schedules the pass runs beside the schedule, which returns at once. */
  function inBackground(name:string,work:()=>Promise<unknown>):()=>Promise<void> {
    const run=guarded(name,work);
    return async()=>{ void run(); };
  }
  /** With them the core waits for the pass without holding other schedules, and aborts it after the limit. */
  function scheduleDocs(name:string,cron:string,work:(signal?:AbortSignal)=>Promise<unknown>,timeoutMs:number){
    scheduleIsolated(bb,name,cron,guarded(name,work),{timeoutMs,fallback:inBackground(name,work)});
  }

  scheduleIsolated(bb,"docs-maintenance-hourly","0 * * * *",runScheduledDocsMaintenance,{timeoutMs:3*3_600_000});

  scheduleDocs("docs-nightly-hourly","0 * * * *",(signal)=>runNightlyDocs({signal}),6*3_600_000);

  /**
   * Every two minutes: units a stopped plugin instance left mid-way are finished on their own agent thread, and a pass
   * of today that broke off or left units failed runs again - up to DOCS_NIGHT_ATTEMPTS a night. Settled passes leave the index.
   */
  async function runDocsCatchUps(signal?:AbortSignal):Promise<void> {
    // First the units whose agent a stopped plugin instance left running or finished: same thread, from the saved step.
    const units=(await bb.storage.kv.get(DOCS_UNITS_OPEN_KEY).catch(()=>null) as Record<string,true>|null)??{};
    for(const unitKey of Object.keys(units)){
      signal?.throwIfAborted();
      if(docsUnitsFinishing.has(unitKey)) continue;
      const record=await bb.storage.kv.get(unitKey).catch(()=>null) as DocsUnitRecord|null;
      if(!record){ await updateDocsUnitsIndex((index)=>{ delete index[unitKey]; }); continue; }
      void finishDocsUnit(record,(path,self)=>[...docsUnitsFinishing.values()].some((unit)=>unit!==self&&unitWritable(unit)(path)))
        // A reload stopping this instance is not a failure: the next instance resumes the unit.
        .catch((cause)=>pluginStopped(cause)?undefined:bb.log.warn(`Lane Pilot docs resume failed for ${record.place.path} ${record.label}: ${cause instanceof Error?cause.message:String(cause)}`));
    }
    const open=(await bb.storage.kv.get(DOCS_OPEN_KEY).catch(()=>null) as DocsOpenPasses|null)??{};
    const keep:DocsOpenPasses={};
    for(const [key,entry] of Object.entries(open)){
      signal?.throwIfAborted();
      const night=await bb.storage.kv.get(key).catch(()=>null) as {date?:string;attempts?:number;finished?:boolean;failed?:number}|null;
      const unsettled=night?.date===entry.date&&(!night.finished||(night.failed??0)>0)&&(night.attempts??0)<DOCS_NIGHT_ATTEMPTS;
      if(!unsettled) continue;
      keep[key]=entry;
      if(docsPassesRunning.has(entry.path)) continue;
      // Units still finishing from saved progress are waited for inside the pass, not started again.
      await runNightlyDocs({projectId:entry.projectId,path:entry.path,catchUp:true,signal});
    }
    const latest=(await bb.storage.kv.get(DOCS_OPEN_KEY).catch(()=>null) as DocsOpenPasses|null)??{};
    await bb.storage.kv.set(DOCS_OPEN_KEY,Object.fromEntries(Object.entries(latest).filter(([key])=>key in keep||!(key in open))));
  }

  scheduleDocs("docs-nightly-catchup","*/2 * * * *",runDocsCatchUps,6*3_600_000);

  return { registerDocsGraphs, docsPlaces, docsVerdict, docsPlaceStatus, docsLastRead, WORKSPACE_DOCS_MIN_FILES, DOCS_UNIT_CONCURRENCY, docsSpawnGate, spawnDocsThread, DOCS_NIGHT_ATTEMPTS, DOCS_OPEN_KEY, docsPassesRunning, DOCS_TOOLING, unitWritable, runNightlyDocs, runDocsUnit, docsUnitRecordKey, DOCS_UNITS_OPEN_KEY, docsUnitsIndexChain, updateDocsUnitsIndex, saveDocsUnitRecord, dropDocsUnitRecord, docsUnitsFinishing, pluginStopped, finishDocsUnit, runScheduledDocsMaintenance, runDocsCatchUps };
}
