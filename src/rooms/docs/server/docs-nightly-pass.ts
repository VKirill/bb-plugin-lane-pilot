import { resolve } from "node:path";
import { bestEffort, orMiss, isNotFound } from "@lane-pilot/kit";
import { sha256 } from "../../tasks";
import { claimDailySchedule, loadProjectSettings } from "../../storage";
import { configuredSetting } from "../../contracts/server";
import { switchOn } from "@lane-pilot/models";
import { parseDocsSettings, docsSinceEpoch } from "../docs";
import { cadenceAllowsToday } from "../docs-worthiness";
import { isDocsIndex } from "../docs-lint";
import type { DocsUnit } from "../docs";
import { codeFactsOnHost, CODE_FACTS_REFRESH } from "../../platform";
import { runOnHost } from "@lane-pilot/host-calls";
import { effectiveGroup, parseHelperContextSettings, docsWorktreeKey } from "../../contracts";
import { abortable } from "../../platform/server";
import { pluginStopped } from "./plugin-stopped";
import { docsPlaceStatus } from "./docs-place-status";
import { docsWorktree, mergeDocs } from "./docs-worktree";
import { docsUnitRecordKey, updateDocsUnitsIndex, DOCS_UNITS_OPEN_KEY } from "./docs-unit-records";
import { unitWritable } from "./docs-unit-steps";
import { runDocsUnit, finishDocsUnit } from "./docs-unit-run";
import type { NightlyShared, DocsUnitRecord, DocsOpenPasses } from "./docs-night-state";

  /** A workspace with at least this many product code files keeps its own docs folder; smaller ones belong to the root docs. */
  const WORKSPACE_DOCS_MIN_FILES=15;

  /** Docs folders of one monorepo written at once. */
  const DOCS_UNIT_CONCURRENCY=8;

  /** Attempts a night gets: the pass at docs.hour, then catch-ups a few minutes later when it broke off or a unit failed. */
  const DOCS_NIGHT_ATTEMPTS=3;

  /** Places whose pass today is not settled yet, so the catch-up tick reads one key instead of every project. */
  const DOCS_OPEN_KEY="docs-nightly-open";


  /**
   * claude-lane's nightly docs for native projects: once a day at docs.hour of the folder's own
   * machine, every project root and section that is a git repository with docs enabled gets hidden
   * docs agents. A monorepo gets one per workspace big enough to keep its own <workspace>/docs, a few
   * at once, and then one for the root docs/ that describe the system and link to them. Each sees
   * the code changed since its folder's docs; no folder yet means onboarding; nothing changed and
   * docs present means no model call. `force` skips the hour for a manual run.
   */

  export async function runNightlyDocs(n:NightlyShared,opts:{
force?:boolean;projectId?:string;path?:string;base?:string;catchUp?:boolean;signal?:AbortSignal;
    /** The owner's assignment (SMA k_ag_docwriter): handed to every unit's graph run of this pass. */ assignment?:string}={}):Promise<Array<Record<string,unknown>>> {
    const {ctx,services,bb,db,host,listProjectSections,sectionChain,inDocsQueue,docsPassesRunning,docsUnitsFinishing,activeUnitRuns}=n;
    const results:Array<Record<string,unknown>>=[];
    const projects=opts.projectId?[{id:opts.projectId}]:await bestEffort(bb.log, "docs projects", bb.sdk.projects.list({includePersonal:true}), [] as Array<{id:string}>);
    for(const project of projects){
      opts.signal?.throwIfAborted();
      const places:Array<{scopes:string[];hostId:string;path:string}>=[];
      const root=await bestEffort(bb.log, `docs writer host ${project.id}`, services.resolveProjectWriterHost({projectId:project.id}), null);
      if(root?.status==="resolved"&&root.path) places.push({scopes:[],hostId:root.hostId,path:root.path});
      // Every source of the project is a place too: a project may keep its code repository on another machine.
      const described=await orMiss(bb.sdk.projects.get({projectId:project.id}), null, isNotFound) as {sources?:Array<{hostId?:string;path?:string}>}|null;
      for(const source of described?.sources??[]){
        if(source.hostId&&source.path&&!places.some((place)=>place.hostId===source.hostId&&place.path===source.path)) places.push({scopes:[],hostId:source.hostId,path:source.path});
      }
      const sections=await listProjectSections(project.id);
      for(const section of sections) if(section.kind==="folder") for(const copy of section.paths) if(copy.path&&copy.hostId) places.push({scopes:sectionChain(sections,section.id),hostId:copy.hostId,path:copy.path});
      for(const place of places){
        opts.signal?.throwIfAborted();
        if(opts.path&&resolve(place.path)!==resolve(opts.path)) continue;
        try{
          const settings=loadProjectSettings(db,project.id,place.scopes);
          const docs=parseDocsSettings(Object.fromEntries(["docs.enabled","docs.maintain","docs.since","docs.page_cap","docs.hour"].map((key)=>[key,configuredSetting(settings,key)])));
          if(!docs.enabled||!docs.maintain) continue;
          // Project sources and section copies can be Windows paths; the docs host RPCs accept POSIX workspaces only.
          if(!place.path.startsWith("/")){
            results.push({projectId:project.id,path:place.path,hostId:place.hostId,state:"skipped",reason:"unsupported_workspace_path"});
            continue;
          }
          // docs.gitnexus_refresh=on: the night's pass also keeps the project's GitNexus code index warm — a checkout
          // without one or behind HEAD gets one `gitnexus analyze` on its own machine. Only where the project's
          // writer role may use gitnexus tools at all; unset: nothing runs.
          if(switchOn({"docs.gitnexus_refresh":configuredSetting(settings,"docs.gitnexus_refresh")},"docs.gitnexus_refresh")){
            const helperCtx=parseHelperContextSettings(settings);
            const gitnexusAllowed=!helperCtx.ok?false:helperCtx.settings.mode!=="roles"
              ||(effectiveGroup("writer","mcpServers",helperCtx.settings.roleAccess?.writer).names??["gitnexus"]).includes("gitnexus");
            if(gitnexusAllowed){
              const facts=await bestEffort(bb.log,`docs gitnexus facts ${place.path}`,codeFactsOnHost(host,place.hostId,place.path),null);
              if(facts&&facts.state!=="fresh"){
                await bestEffort(bb.log,`docs gitnexus refresh ${place.path}`,runOnHost(host,{hostId:place.hostId,cwd:place.path,command:CODE_FACTS_REFRESH,timeoutSec:1800,timeoutMs:1_900_000}),null);
              }
            }
          }
          const baseKey=`docs-base:${place.hostId}:${sha256(place.path).slice(0,12)}`;
          const storedBase=await bb.storage.kv.get(baseKey) as {head?:string}|null;
          const scope=await host.call("gitDocsScope",{requestedHostId:place.hostId,projectCwd:place.path,sinceEpochMs:docsSinceEpoch(docs.since,new Date()),...(storedBase?.head?{base:storedBase.head}:{})},{hostId:place.hostId,timeoutMs:120_000});
          if(scope.status!=="ready"||!scope.isRepoRoot) continue;
          // A pass that broke off (a reload, a crash) or left units failed is picked up at the next hours of the same
          // night; units already done have no changes left and skip at once.
          const stateKey=`docs-nightly-state:${project.id}:${sha256(place.path).slice(0,12)}`;
          const night=await bb.storage.kv.get(stateKey) as {date?:string;attempts?:number;finished?:boolean;failed?:number}|null;
          const unsettled=night?.date===scope.localDate&&(!night.finished||(night.failed??0)>0)&&(night.attempts??0)<DOCS_NIGHT_ATTEMPTS;
          const catchUp=Boolean(opts.catchUp)&&!opts.force&&unsettled&&!docsPassesRunning.has(place.path);
          if(opts.catchUp&&!catchUp) continue;
          if(!opts.force&&!catchUp&&scope.localHour!==docs.hour) continue;
          if(docs.mode==="auto"){
            const status=await docsPlaceStatus(n,project.id,place);
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
          const open=(await bb.storage.kv.get(DOCS_OPEN_KEY) as DocsOpenPasses|null)??{};
          await bb.storage.kv.set(DOCS_OPEN_KEY,{...open,[stateKey]:{projectId:project.id,path:place.path,date:scope.localDate}});
          try{
          // The agents write, check and commit in the place's docs worktree; main sees only merged commits.
          const work=await docsWorktree(n,place);
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
          const titled=(await bestEffort(bb.log, `docs pages ${work.path}`, host.call("listDocsPages",{requestedHostId:work.hostId,projectCwd:work.path,roots:units.map((unit)=>unit.docsDir),skipOversized:true},{hostId:work.hostId,timeoutMs:120_000}), null))?.pages??[];
          await Promise.all(units.map(async(unit)=>{
            const workspace=unit.workspace;
            const unitScope=await bestEffort(bb.log, `docs scope ${work.path} ${unit.docsDir}`, host.call("gitDocsScope",{requestedHostId:work.hostId,projectCwd:work.path,sinceEpochMs,docsDir:unit.docsDir,...(opts.base?{base:opts.base}:{})},{hostId:work.hostId,timeoutMs:120_000}), null);
            if(!unitScope||unitScope.status!=="ready") return;
            const changed=unitScope.changed.filter((path)=>workspace?path.startsWith(`${workspace.path}/`):true);
            if(unitScope.hasDocs&&!changed.length&&!unitScope.dirty.some(unitWritable(unit))) return;
            // A unit resuming from saved progress already has its map.
            if(await bb.storage.kv.get(docsUnitRecordKey(project.id,work.path,unit.docsDir))) return;
            const pages=titled.filter((page)=>page.path.startsWith(`${unit.docsDir}/`)&&!isDocsIndex(page.path))
              .map((page)=>({path:page.path,title:/^title:\s*(.+)$/m.exec(page.content)?.[1]?.trim()??page.path}));
            prefetch.set(unit.docsDir,bestEffort(bb.log, `docs anchors ${work.path} ${unit.docsDir}`, host.call("docsAnchors",{requestedHostId:work.hostId,projectCwd:work.path,prefix:workspace?`${workspace.path}/`:"",
              ...(workspace?{}:{exclude:own.map((item)=>item.path),...(workspaces.length?{workspaces}:{})}),pages:pages.slice(0,500)},{hostId:work.hostId,timeoutMs:1_800_000}), null));
          }));
          const flowPagesAtStart=titled.filter((page)=>page.path.startsWith("docs/flows/"));
          const tracing=host.call("docsFlows",{requestedHostId:work.hostId,projectCwd:work.path,workspaces:workspaces.map((workspace)=>({path:workspace.path,name:workspace.name})),
            keep:[...new Set(flowPagesAtStart.map((page)=>/^docs\/flows\/([^/]+)\.md$/.exec(page.path)?.[1]).filter((slug):slug is string=>Boolean(slug)))]},
            {hostId:work.hostId,timeoutMs:1_800_000}).catch((cause)=>{ bb.log.warn(`Lane Pilot docs flows failed for ${place.path}: ${cause instanceof Error?cause.message:String(cause)}`); return null; });
          const context={projectId:project.id,place:work,basePath:place.path,scopes:place.scopes,localDate:scope.localDate,attempt:opts.force?Date.now():attempts,settings,docs,base:opts.base,roots:units.map((unit)=>unit.docsDir),exclude:own.map((workspace)=>workspace.path),workspaces,prefetch,assignment:opts.assignment?.trim().slice(0,2000)||undefined,
            othersWritable:(path:string,self:DocsUnit)=>leftover.has(path)||[...running,...docsUnitsFinishing.values()].some((unit)=>unit!==self&&unitWritable(unit)(path))};
          const run=async(unit:DocsUnit)=>{
            running.add(unit);
            try{
              const row=await runDocsUnit(n,context,unit);
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
          await mergeDocs(n,place.path,work,`docs: nightly refresh ${scope.localDate}`);
          await bb.storage.kv.set(stateKey,{date:scope.localDate,attempts,finished:true,failed:results.slice(firstResult).filter((row)=>row.state==="failed").length});
          // The place's next pass diffs from where this one ended, not from the last docs-touching commit: a commit
          // carrying both code and a docs line used to hide all of its code changes (bb-plugin-project-folders 0.7.10).
          const headNow=(await bestEffort(bb.log, `docs head ${place.path}`, host.call("gateRun",{requestedHostId:place.hostId,basePath:place.path,command:"git rev-parse HEAD",timeoutSec:15},{hostId:place.hostId,timeoutMs:30_000}), null));
          if(headNow?.exitCode===0&&/^[a-f0-9]{40}$/.test(headNow.stdout.trim())) await bestEffort(bb.log, `docs base ${place.path}`, bb.storage.kv.set(baseKey,{head:headNow.stdout.trim()}), undefined);
          // The pass is done: its worktree goes now, unless a unit left open progress in it (WT2: create → merge → remove).
          if(resolve(work.path)!==resolve(place.path)){
            const openUnits=(await bb.storage.kv.get(DOCS_UNITS_OPEN_KEY) as Record<string,true>|null)??{};
            let progress=false;
            for(const unitKey of Object.keys(openUnits)){
              const record=await bb.storage.kv.get(unitKey) as DocsUnitRecord|null;
              if(record?.place.path===work.path){ progress=true; break; }
            }
            if(!progress){
              await bestEffort(bb.log, `docs worktree cleanup ${work.path}`, host.call("gitRemoveWorktree",{requestedHostId:place.hostId,basePath:place.path,worktreePath:work.path},{hostId:place.hostId,timeoutMs:120_000}), null);
              await bestEffort(bb.log, `docs worktree record ${place.path}`, bb.storage.kv.delete(docsWorktreeKey(place.hostId, `docs-${sha256(place.path).slice(0,12)}`)), undefined);
            }
          }
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

  /**
   * Every two minutes: units a stopped plugin instance left mid-way are finished on their own agent thread, and a pass
   * of today that broke off or left units failed runs again - up to DOCS_NIGHT_ATTEMPTS a night. Settled passes leave the index.
   */
  export async function runDocsCatchUps(n:NightlyShared,signal?:AbortSignal):Promise<void> {
    const {ctx,services,bb,db,host,listProjectSections,sectionChain,inDocsQueue,docsPassesRunning,docsUnitsFinishing,activeUnitRuns}=n;

    // First the units whose agent a stopped plugin instance left running or finished: same thread, from the saved step.
    const units=(await bb.storage.kv.get(DOCS_UNITS_OPEN_KEY) as Record<string,true>|null)??{};
    for(const unitKey of Object.keys(units)){
      signal?.throwIfAborted();
      if(docsUnitsFinishing.has(unitKey)) continue;
      let record:DocsUnitRecord|null;
      try { record=await bb.storage.kv.get(unitKey) as DocsUnitRecord|null; }
      catch(cause){ bb.log.warn(`Lane Pilot docs unit ${unitKey} unreadable, skipped: ${cause instanceof Error?cause.message:String(cause)}`); continue; }
      if(!record){ await updateDocsUnitsIndex(n,(index)=>{ delete index[unitKey]; }); continue; }
      void finishDocsUnit(n,record,(path,self)=>[...docsUnitsFinishing.values()].some((unit)=>unit!==self&&unitWritable(unit)(path)))
        // A reload stopping this instance is not a failure: the next instance resumes the unit.
        .catch((cause)=>pluginStopped(cause)?undefined:bb.log.warn(`Lane Pilot docs resume failed for ${record.place.path} ${record.label}: ${cause instanceof Error?cause.message:String(cause)}`));
    }
    const open=(await bb.storage.kv.get(DOCS_OPEN_KEY) as DocsOpenPasses|null)??{};
    const keep:DocsOpenPasses={};
    for(const [key,entry] of Object.entries(open)){
      signal?.throwIfAborted();
      let night:{date?:string;attempts?:number;finished?:boolean;failed?:number}|null;
      try { night=await bb.storage.kv.get(key) as typeof night; }
      catch(cause){ bb.log.warn(`Lane Pilot docs night ${key} unreadable, kept for the next pass: ${cause instanceof Error?cause.message:String(cause)}`); keep[key]=entry; continue; }
      const unsettled=night?.date===entry.date&&(!night.finished||(night.failed??0)>0)&&(night.attempts??0)<DOCS_NIGHT_ATTEMPTS;
      if(!unsettled) continue;
      keep[key]=entry;
      if(docsPassesRunning.has(entry.path)) continue;
      // Units still finishing from saved progress are waited for inside the pass, not started again.
      await runNightlyDocs(n,{projectId:entry.projectId,path:entry.path,catchUp:true,signal});
    }
    const latest=(await bb.storage.kv.get(DOCS_OPEN_KEY) as DocsOpenPasses|null)??{};
    await bb.storage.kv.set(DOCS_OPEN_KEY,Object.fromEntries(Object.entries(latest).filter(([key])=>key in keep||!(key in open))));
  }
