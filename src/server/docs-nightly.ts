import { projectRoleField } from "./run-routing";
import { claimDailySchedule, getActivation, getRun, listRunsWithAttempts, listStageReceipts, loadProjectSettings, loadPrototypeConfig } from "../database";
import { bbServiceTier, writerExecutionSelection } from "../jev-reasoning";
import { sha256 } from "../stages/contract";
import { docsRepairPrompt, docsSelection, docsScheduleDue, docsSinceEpoch, flowDocsWritable, localDateKey, nightlyDocsPrompt, nightlyDocsWritable, parseDocsSettings } from "../stages/docs";
import type { DocsUnit } from "../stages/docs";
import { cadenceAllowsToday, codeDocsVerdict, docsCadence, docsFactsKey, docsWorthinessState, DOCS_WORTHINESS_QUESTION, fallbackDocsVerdict } from "../stages/docs-worthiness";
import type { DocsCadence, DocsVerdict, DocsWorthinessFacts } from "../stages/docs-worthiness";
import { buildBacklinks, buildDocsIndex, citedFiles, docsCompletenessGaps, isDesignCanon, isDocsIndex, lintDocsPages, pagesToRefresh, unlinkedPages, withCitedSources, withVerifiedConfidence } from "../stages/docs-lint";
import { configuredSetting } from "./context";
import { fullAccessSpawn } from "./pm-spawn";
import { stringAt } from "./values";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { basename, resolve } from "node:path";
import type { ServerCore } from "./core";
import type { Services } from "./services";

/** Runs the work it is given one after another, in the order it was given; a failure does not stop the queue. */
export function createSerialQueue():<T>(work:()=>Promise<T>)=>Promise<T> {
  let tail:Promise<unknown>=Promise.resolve();
  return <T>(work:()=>Promise<T>):Promise<T>=>{
    const turn=tail.then(work);
    tail=turn.catch(()=>undefined);
    return turn;
  };
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
      while(stringAt(await bb.sdk.threads.get({threadId}).catch(()=>null),"status")==="starting") await new Promise((done)=>setTimeout(done,2_000));
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
  type DocsUnitRecord={version:1;projectId:string;place:{hostId:string;path:string};label:string;unit:DocsUnit;threadId:string;phase:"writing"|"repairing";sentAt?:number;
    beforeDirty:string[];localDate:string;since:ReturnType<typeof parseDocsSettings>["since"];roots:string[];workspaces:Array<{path:string;name:string;docsDir:string|null}>;
    hasDocs:boolean;changedCount:number;refresh:string[];gaps:{missingPages:string[];uncoveredCore:string[]};anchors:{count:number;jev:string}|null;
    core:Array<{name:string;file:string;line:number;endLine:number}>;kvKey:string};

  /** What one docs unit may write: a flow its page, the root its docs/ outside docs/flows when flows exist, a workspace its folder. */
  function unitWritable(unit:DocsUnit):(path:string)=>boolean {
    const own=unit.flow?flowDocsWritable(unit.flow.slug)
      :unit.flows?.length?(path:string)=>nightlyDocsWritable(unit.docsDir)(path)&&!path.startsWith("docs/flows/")
      :nightlyDocsWritable(unit.docsDir);
    // The design canon is the design lead's page, not the docs agent's.
    return (path:string)=>own(path)&&!isDesignCanon(path);
  }

  async function runNightlyDocs(opts:{force?:boolean;projectId?:string;path?:string;base?:string;catchUp?:boolean}={}):Promise<Array<Record<string,unknown>>> {
    const results:Array<Record<string,unknown>>=[];
    const projects=opts.projectId?[{id:opts.projectId}]:await bb.sdk.projects.list({includePersonal:true}).catch(()=>[] as Array<{id:string}>);
    for(const project of projects){
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
          await inDocsQueue(async()=>{
          const firstResult=results.length;
          const attempts=(catchUp?night?.attempts??0:0)+1;
          await bb.storage.kv.set(stateKey,{date:scope.localDate,attempts,finished:false,failed:0});
          const open=(await bb.storage.kv.get(DOCS_OPEN_KEY).catch(()=>null) as DocsOpenPasses|null)??{};
          await bb.storage.kv.set(DOCS_OPEN_KEY,{...open,[stateKey]:{projectId:project.id,path:place.path,date:scope.localDate}});
          try{
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
          const titled=(await host.call("listDocsPages",{requestedHostId:place.hostId,projectCwd:place.path,roots:units.map((unit)=>unit.docsDir),skipOversized:true},{hostId:place.hostId,timeoutMs:120_000}).catch(()=>null))?.pages??[];
          await Promise.all(units.map(async(unit)=>{
            const workspace=unit.workspace;
            const unitScope=await host.call("gitDocsScope",{requestedHostId:place.hostId,projectCwd:place.path,sinceEpochMs,docsDir:unit.docsDir,...(opts.base?{base:opts.base}:{})},{hostId:place.hostId,timeoutMs:120_000}).catch(()=>null);
            if(!unitScope||unitScope.status!=="ready") return;
            const changed=unitScope.changed.filter((path)=>workspace?path.startsWith(`${workspace.path}/`):true);
            if(unitScope.hasDocs&&!changed.length&&!unitScope.dirty.some(unitWritable(unit))) return;
            // A unit resuming from saved progress already has its map.
            if(await bb.storage.kv.get(docsUnitRecordKey(project.id,place.path,unit.docsDir)).catch(()=>null)) return;
            const pages=titled.filter((page)=>page.path.startsWith(`${unit.docsDir}/`)&&!isDocsIndex(page.path))
              .map((page)=>({path:page.path,title:/^title:\s*(.+)$/m.exec(page.content)?.[1]?.trim()??page.path}));
            prefetch.set(unit.docsDir,host.call("docsAnchors",{requestedHostId:place.hostId,projectCwd:place.path,prefix:workspace?`${workspace.path}/`:"",
              ...(workspace?{}:{exclude:own.map((item)=>item.path),...(workspaces.length?{workspaces}:{})}),pages:pages.slice(0,500)},{hostId:place.hostId,timeoutMs:1_800_000}).catch(()=>null));
          }));
          const flowPagesAtStart=titled.filter((page)=>page.path.startsWith("docs/flows/"));
          const tracing=host.call("docsFlows",{requestedHostId:place.hostId,projectCwd:place.path,workspaces:workspaces.map((workspace)=>({path:workspace.path,name:workspace.name})),
            keep:[...new Set(flowPagesAtStart.map((page)=>/^docs\/flows\/([^/]+)\.md$/.exec(page.path)?.[1]).filter((slug):slug is string=>Boolean(slug)))]},
            {hostId:place.hostId,timeoutMs:1_800_000}).catch((cause)=>{ bb.log.warn(`Lane Pilot docs flows failed for ${place.path}: ${cause instanceof Error?cause.message:String(cause)}`); return null; });
          const context={projectId:project.id,place,settings,docs,base:opts.base,roots:units.map((unit)=>unit.docsDir),exclude:own.map((workspace)=>workspace.path),workspaces,prefetch,
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
              bb.log.warn(`Lane Pilot nightly docs failed for ${place.path} ${unit.docsDir}: ${reason}`);
            }
            finally{ running.delete(unit); }
          };
          const pool=async(queue:DocsUnit[])=>{ await Promise.all(Array.from({length:Math.min(DOCS_UNIT_CONCURRENCY,queue.length)},async()=>{ for(let unit=queue.shift();unit;unit=queue.shift()) await run(unit); })); };
          // Workspaces first, a few at once. Then the business flows, traced once across the repository, each written
          // by its own agent on top of the workspace docs. The root last, so its overview links to docs that exist.
          await pool(units.slice(0,-1));
          const traced=await tracing;
          const flowUnits:DocsUnit[]=(traced?.flows??[]).map((flow)=>({docsDir:"docs",flow}));
          await pool([...flowUnits]);
          const root=units.at(-1)!;
          await run(flowUnits.length?{...root,flows:flowUnits.map((unit)=>unit.flow!.slug)}:root);
          await bb.storage.kv.set(stateKey,{date:scope.localDate,attempts,finished:true,failed:results.slice(firstResult).filter((row)=>row.state==="failed").length});
          } finally { docsPassesRunning.delete(place.path); }
          });
        }catch(cause){
          const reason=cause instanceof Error?cause.message:String(cause);
          results.push({projectId:project.id,path:place.path,state:"failed",reason});
          bb.log.warn(`Lane Pilot nightly docs failed for ${place.path}: ${reason}`);
        }
      }
    }
    return results;
  }

  /** One docs folder of a place: its own git scope, code map, agent, checks, builders and commit. */
  async function runDocsUnit(ctx:{projectId:string;place:{hostId:string;path:string};settings:Record<string,unknown>;docs:ReturnType<typeof parseDocsSettings>;base?:string;
    roots:string[];exclude:string[];workspaces:Array<{path:string;name:string;docsDir:string|null}>;prefetch:Map<string,Promise<unknown>>;
    othersWritable:(path:string,self:DocsUnit)=>boolean},unit:DocsUnit):Promise<Record<string,unknown>> {
    const {place,settings,docs}=ctx;
    const d=unit.docsDir, flow=unit.flow;
    // A unit whose agent an earlier plugin instance started is picked up where it stopped, not started again.
    const label0=flow?`docs/flows/${flow.slug}.md`:d;
    const open=await bb.storage.kv.get(docsUnitRecordKey(ctx.projectId,place.path,label0)).catch(()=>null) as DocsUnitRecord|null;
    if(open) return finishDocsUnit(open,ctx.othersWritable);
    const writable=unitWritable(unit);
    const prefix=unit.workspace?`${unit.workspace.path}/`:"";
    const flowFiles=new Set(flow?.files??[]);
    // The root summarises every workspace (capabilities, role pages, architecture), so any change may concern it;
    // Jev's staleness check picks the root pages a change actually makes wrong.
    const inUnit=(path:string)=>flow?flowFiles.has(path):prefix?path.startsWith(prefix):true;
    const label=flow?`docs/flows/${flow.slug}.md`:d;
    const report=(state:string,extra:Record<string,unknown>={}):Record<string,unknown>=>({projectId:ctx.projectId,path:place.path,docsDir:label,state,...extra});
    const gitScope=(base?:string)=>host.call("gitDocsScope",{requestedHostId:place.hostId,projectCwd:place.path,sinceEpochMs:docsSinceEpoch(docs.since,new Date()),docsDir:label,
      ...(unit.flows?.length?{exclude:["docs/flows"]}:{}),...(base?{base}:{})},{hostId:place.hostId,timeoutMs:120_000});
    const before=await gitScope(ctx.base);
    if(before.status!=="ready") throw new Error(`git scope failed: ${before.reason}`);
    const changed=before.changed.filter(inUnit);
    // Every docs folder of the place, so links and contradictions across folders are seen; this unit writes only its own.
    let oversized:string[]=[];
    const allPages=async()=>{
      const listed=await host.call("listDocsPages",{requestedHostId:place.hostId,projectCwd:place.path,roots:ctx.roots,skipOversized:true},{hostId:place.hostId,timeoutMs:120_000});
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
    if(hasDocs&&changed.length===0&&!pending&&!decisionDrafts.length) return report("skipped",{reason:"no code changes"});
    const existing=hasDocs?mine(await allPages()):[];
    // The root README.md and PROJECT.md describe the code too, so they are checked for staleness with the root docs.
    const readRootPages=async()=>unit.workspace||flow?[]:(await Promise.all(["README.md","PROJECT.md"].map(async(path)=>{
      const file=await bb.sdk.files.read({hostId:place.hostId,rootPath:place.path,path:resolve(place.path,path)}).catch(()=>null);
      return file&&typeof file.content==="string"?{path,content:file.content}:null;
    }))).filter((page):page is {path:string;content:string}=>page!==null);
    const rootPages=hasDocs?await readRootPages():[];
    const pageInput=existing.filter((page)=>!isDocsIndex(page.path)).map((page)=>({path:page.path,content:page.content}));
    // Jev judges which sections the day's diff made wrong; without it, pages whose sources changed.
    const prefetched=flow?undefined:ctx.prefetch.get(d) as Promise<Awaited<ReturnType<typeof host.call<"docsAnchors">>>|null>|undefined;
    const anchors=flow?null:prefetched?await prefetched:await host.call("docsAnchors",{requestedHostId:place.hostId,projectCwd:place.path,prefix,
      ...(unit.workspace?{}:{exclude:ctx.exclude,...(ctx.workspaces.length?{workspaces:ctx.workspaces}:{})}),
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
        if(!pending&&!decisionDrafts.length&&!stale.refresh.length&&!uncovered.length&&!gaps.missingPages.length&&!gaps.uncoveredCore.length) return report("skipped",{reason:"Jev found no section the changes made wrong, and no changed product file is undocumented"});
        refresh=stale.refresh;
      }
    }
    // What Jev still doubted after this unit's last pass goes back to the agent to recheck, while the page exists.
    const kvKey=`docs-nightly:${ctx.projectId}:${sha256(`${place.path}\n${label}`).slice(0,12)}`;
    const last=hasDocs?await bb.storage.kv.get(kvKey).catch(()=>null) as {warnings?:Array<{path:string;rule:string;detail:string}>}|null:null;
    const pagePaths=new Set(existing.map((page)=>page.path));
    const doubts=(last?.warnings??[]).filter((warning)=>(warning.rule==="evidence-check"||warning.rule==="contradiction")&&pagePaths.has(warning.path));
    const selection=docsSelection(settings);
    const [providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:place.hostId}),bb.sdk.providers.models({providerId:selection.providerId,hostId:place.hostId})]);
    const provider=providers.find((item)=>item.id===selection.providerId&&item.available);
    const model=catalog.models.find((item)=>item.id===selection.model||item.model===selection.model);
    if(!provider||!model) throw new Error(`docs provider or model unavailable: ${selection.providerId}/${selection.model}`);
    const effort=selection.reasoningLevel;
    const tier=provider.capabilities.supportsServiceTier?bbServiceTier(selection.serviceTier):null;
    const threadId=await spawnDocsThread({projectId:ctx.projectId,visibility:"hidden",title:`Lane Pilot docs: ${basename(place.path)}${unit.workspace?` · ${unit.workspace.path}`:flow?` · flow ${flow.slug}`:""}`,
      ...writerExecutionSelection(selection.providerId,selection.model,effort,tier),
      ...projectRoleField(bb,db,ctx.projectId,selection.providerId,"docs-maintainer"),
      prompt:nightlyDocsPrompt({since:docs.since,hasDocs,changed,refresh,anchorsPath:anchors?.briefPath,deploy:anchors?.deploy??false,missingPages:gaps.missingPages,uncoveredCore:gaps.uncoveredCore,
        agent:typeof settings["docs.agent"]==="string"?settings["docs.agent"] as string:undefined,unit,doubts,decisionDrafts}),
      environment:{type:"host",hostId:place.hostId,workspace:{type:"unmanaged",path:place.path}},
      pluginMetadata:{role:"docs-nightly",stageId:"docs-nightly"}});
    // From here on the unit's progress is saved, so a plugin reload picks the same agent thread up again.
    const record:DocsUnitRecord={version:1,projectId:ctx.projectId,place,label,unit,threadId,phase:"writing",beforeDirty:before.dirty,localDate:before.localDate,
      since:docs.since,roots:ctx.roots,workspaces:ctx.workspaces,hasDocs,changedCount:changed.length,refresh,gaps,
      anchors:anchors?{count:anchors.anchors,jev:anchors.jev}:null,core:core.slice(0,2000),kvKey};
    await saveDocsUnitRecord(record);
    return finishDocsUnit(record,ctx.othersWritable);
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

  const pluginStopped=(cause:unknown)=>/stale API handle|generation .* is retired|plugin .* (reloaded|disabled)/i.test(cause instanceof Error?cause.message:String(cause));

  /**
   * The second half of a docs unit, from saved progress: wait for the agent's thread, check the pages, send one repair
   * round to the same thread, build backlinks, confidence and the index, commit, and report. Safe to run again after a
   * reload: it waits for the same thread and repeats only what did not finish.
   */
  async function finishDocsUnit(record:DocsUnitRecord,othersWritable:(path:string,self:DocsUnit)=>boolean):Promise<Record<string,unknown>> {
    const key=docsUnitRecordKey(record.projectId,record.place.path,record.label);
    const {place,unit,threadId,label}=record;
    if(docsUnitsFinishing.has(key)) return {projectId:record.projectId,path:place.path,docsDir:label,state:"skipped",reason:"already finishing"};
    // A unit from a night long gone is not finished: its list of files dirty before the agent is stale, so what is
    // dirty now would pass for the agent's changes and be reverted. Its pages stay for the next pass.
    if(Date.now()-Date.parse(`${record.localDate}T00:00:00Z`)>DOCS_UNIT_RESUME_MS){
      await dropDocsUnitRecord(record);
      bb.log.info(`Lane Pilot docs unit ${place.path} ${label} of ${record.localDate} dropped: its night is over`);
      return {projectId:record.projectId,path:place.path,docsDir:label,state:"skipped",reason:"night_over"};
    }
    docsUnitsFinishing.set(key,unit);
    try{
      const d=unit.docsDir, flow=unit.flow, writable=unitWritable(unit);
      const report=(state:string,extra:Record<string,unknown>={}):Record<string,unknown>=>({projectId:record.projectId,path:place.path,docsDir:label,state,...extra});
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
      if(record.phase==="writing") await waitThreadIdle(bb,threadId,"docs_nightly");
      else await waitThreadIdle(bb,threadId,"docs_nightly_repair",undefined,record.sentAt);
      const reverted:string[]=[];
      // Check the pages the way the methodology asks, give the agent one round to fix, then index and commit.
      // What the agent changed outside every docs folder is put back first; other folders' passes may be writing theirs.
      const inspect=async()=>{
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
        const findings=[...oversized.filter(writable).map((path)=>({path,rule:"size",detail:"page is over 40000 bytes; split it into pages under 30000 bytes (a large data model into data-model/<area>.md pages) and link them"})),
          ...lintDocsPages(pages,counts).filter((finding)=>writable(finding.path))];
        // The capabilities catalogue covers every capability the apps document, not only the ones inside a flow.
        const catalogue=unit.flows?.length?pages.find((page)=>page.path===`${d}/capabilities.md`):undefined;
        if(catalogue){
          const features=pages.map((page)=>page.path).filter((path)=>/^apps\/[^/]+\/docs\/features\/[^/]+\.md$/.test(path));
          for(const path of unlinkedPages(catalogue,features)) findings.push({path:catalogue.path,rule:"coverage",detail:`does not link ${path}: add the capability that page describes, with its conditions and where it is available, and link it (operator tools under operator capabilities)`});
        }
        let pageStats:Array<{path:string;checked:number;supported:number;partial:number}>=[];
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
        return {touched,docsDirty,pageStats,findings};
      };
      let checked=await inspect();
      if(record.phase==="writing"&&checked.findings.length){
        // The repair counts only once its own turn completes, not the turn the agent already finished.
        const sentAt=Date.now()-2_000;
        await saveDocsUnitRecord({...record,phase:"repairing",sentAt});
        await bb.sdk.threads.send({threadId,mode:"queue-if-active",input:[{type:"text",text:docsRepairPrompt(checked.findings),mentions:[]}]});
        await waitThreadIdle(bb,threadId,"docs_nightly_repair",undefined,sentAt);
        checked=await inspect();
      }
      // A Jev judgment is a signal, not a verdict: once the agent has rechecked it in the repair round,
      // what Jev alone still doubts goes to the report as a warning; the deterministic checks keep blocking.
      const judged=(finding:{rule:string})=>finding.rule==="evidence-check"||finding.rule==="contradiction"||finding.rule==="depth"||finding.rule==="links-external";
      const warnings=checked.findings.filter(judged);
      checked={...checked,findings:checked.findings.filter((finding)=>!judged(finding))};
      let commit:string|null=null;
      // Every page of this folder passed the checks, so pages an earlier pass left uncommitted go in too; code never does.
      if(!checked.findings.length&&checked.docsDirty.length){
        // Builders own what the model must not write: Referenced by blocks, verified confidence, the index.
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
      }
      const failure=checked.findings.length?`${checked.findings.length} docs checks still fail after one repair round`:null;
      const row=report(failure?"failed":"passed",{threadId,onboarding:!record.hasDocs,changedCode:record.changedCount,refreshed:record.refresh,gaps:record.gaps,anchors:record.anchors,
        docsWritten:checked.touched.filter(writable),commit,...(reverted.length?{reverted}:{}),...(warnings.length?{warnings}:{}),...(failure?{reason:failure,findings:checked.findings.slice(0,30)}:{})});
      await bb.storage.kv.set(record.kvKey,{...row,at:Date.now()});
      await dropDocsUnitRecord(record);
      bb.log.info(`Lane Pilot nightly docs ${row.state} for ${place.path} ${label}`);
      return row;
    }catch(cause){
      // The agent's thread failed or its work cannot be checked: the unit is done for tonight, its pages stay pending.
      if(!pluginStopped(cause)) await dropDocsUnitRecord(record).catch(()=>undefined);
      throw cause;
    }finally{ docsUnitsFinishing.delete(key); }
  }

  async function runScheduledDocsMaintenance():Promise<void> {
    const projectIds=(db.prepare("SELECT DISTINCT project_id FROM lane_pilot_project_settings WHERE binding_id=''").all() as Array<{project_id:string}>).map((row)=>row.project_id);
    const now=new Date(), today=localDateKey(now);
    for(const projectId of projectIds){
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
      const docs=listStageReceipts(db,run.id,taskId).find((receipt)=>receipt.stageId==="docs-maintenance");
      const resume=docs?.state==="pending"||docs?.state==="running";
      if(!resume) {
        if(!docsScheduleDue(now,docsSettings.hour,null)||!claimDailySchedule(db,projectId,"docs-maintenance",today)) continue;
      }
      await services.runDocsMaintenance({threadId:activation.pm_thread_id,projectId,runId:run.id,taskId});
    }
  }

  /**
   * BB runs every plugin's schedules one after another and waits for each, so a docs pass awaited in a schedule (hours)
   * stops all of them - self-repair included. The work runs detached; a tick while it still runs is skipped.
   */
  const schedulesRunning=new Set<string>();
  function inBackground(name:string,work:()=>Promise<unknown>):()=>Promise<void> {
    return async()=>{
      if(schedulesRunning.has(name)) return;
      schedulesRunning.add(name);
      void work()
        .catch((cause)=>pluginStopped(cause)?undefined:bb.log.warn(`Lane Pilot schedule ${name} failed: ${cause instanceof Error?cause.message:String(cause)}`))
        .finally(()=>schedulesRunning.delete(name));
    };
  }

  bb.background.schedule("docs-maintenance-hourly","0 * * * *",runScheduledDocsMaintenance);

  bb.background.schedule("docs-nightly-hourly","0 * * * *",inBackground("docs-nightly-hourly",()=>runNightlyDocs()));

  /**
   * Every two minutes: units a stopped plugin instance left mid-way are finished on their own agent thread, and a pass
   * of today that broke off or left units failed runs again - up to DOCS_NIGHT_ATTEMPTS a night. Settled passes leave the index.
   */
  async function runDocsCatchUps():Promise<void> {
    // First the units whose agent a stopped plugin instance left running or finished: same thread, from the saved step.
    const units=(await bb.storage.kv.get(DOCS_UNITS_OPEN_KEY).catch(()=>null) as Record<string,true>|null)??{};
    for(const unitKey of Object.keys(units)){
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
      const night=await bb.storage.kv.get(key).catch(()=>null) as {date?:string;attempts?:number;finished?:boolean;failed?:number}|null;
      const unsettled=night?.date===entry.date&&(!night.finished||(night.failed??0)>0)&&(night.attempts??0)<DOCS_NIGHT_ATTEMPTS;
      if(!unsettled) continue;
      keep[key]=entry;
      if(docsPassesRunning.has(entry.path)) continue;
      // Units still finishing from saved progress are waited for inside the pass, not started again.
      await runNightlyDocs({projectId:entry.projectId,path:entry.path,catchUp:true});
    }
    const latest=(await bb.storage.kv.get(DOCS_OPEN_KEY).catch(()=>null) as DocsOpenPasses|null)??{};
    await bb.storage.kv.set(DOCS_OPEN_KEY,Object.fromEntries(Object.entries(latest).filter(([key])=>key in keep||!(key in open))));
  }

  bb.background.schedule("docs-nightly-catchup","*/2 * * * *",inBackground("docs-nightly-catchup",runDocsCatchUps));

  return { docsPlaces, docsVerdict, docsPlaceStatus, docsLastRead, WORKSPACE_DOCS_MIN_FILES, DOCS_UNIT_CONCURRENCY, docsSpawnGate, spawnDocsThread, DOCS_NIGHT_ATTEMPTS, DOCS_OPEN_KEY, docsPassesRunning, DOCS_TOOLING, unitWritable, runNightlyDocs, runDocsUnit, docsUnitRecordKey, DOCS_UNITS_OPEN_KEY, docsUnitsIndexChain, updateDocsUnitsIndex, saveDocsUnitRecord, dropDocsUnitRecord, docsUnitsFinishing, pluginStopped, finishDocsUnit, runScheduledDocsMaintenance, runDocsCatchUps };
}
