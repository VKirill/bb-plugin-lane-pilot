import { basename, resolve } from "node:path";
import { bestEffort } from "@lane-pilot/kit";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { bbServiceTier, providerLimitNotice, writerExecutionSelection } from "@lane-pilot/models";
import { sha256 } from "../../tasks";
import { projectRoleField } from "../../runs/server";
import { loadProjectSettings } from "../../storage";
import { configuredSetting } from "../../contracts/server";
import { modelCatalogOf, resolveSpawnModel, spawnUsageOf, graphStepMetadata } from "../../platform/server";
import { docsRepairPrompt, docsSelection, docsSinceEpoch, flowDocsWritable, nightlyDocsPrompt, nightlyDocsWritable, parseDocsSettings } from "../docs";
import type { DocsUnit } from "../docs";
import { blockingDocsFindings, buildBacklinks, buildDocsIndex, citedFiles, docsCompletenessGaps, isDesignCanon, isDocsIndex, lintCitationClaims, lintDocsPages, oversizedPageFindings, pagesToRefresh, uncataloguedPages, withCitedSources, withVerifiedConfidence } from "../docs-lint";
import { pluginStopped } from "./plugin-stopped";
import { spawnDocsThread } from "./docs-spawn";
import { mergeDocs } from "./docs-worktree";
import { docsUnitRecordKey, readUnitRecord, saveDocsUnitRecord, dropDocsUnitRecord, nightIsOver } from "./docs-unit-records";
import type { NightlyShared, DocsUnitRecord, UnitInputs, UnitPlan, DocsFinding, Checked, Verified } from "./docs-night-state";

  /** What one docs unit may write: a flow its page, the root its docs/ outside docs/flows when flows exist, a workspace its folder. */
  export function unitWritable(unit:DocsUnit):(path:string)=>boolean {
    const own=unit.flow?flowDocsWritable(unit.flow.slug)
      :unit.flows?.length?(path:string)=>nightlyDocsWritable(unit.docsDir)(path)&&!path.startsWith("docs/flows/")
      :nightlyDocsWritable(unit.docsDir);
    // The design canon is the design lead's page, not the docs agent's.
    return (path:string)=>own(path)&&!isDesignCanon(path);
  }

  /** Tooling state that changes during a pass without the docs agent: never reverted, never a violation. */
  const DOCS_TOOLING=/^(\.agents|\.bb|\.claude|\.codex|\.gitnexus)\//;

  export const unitLabelOf=(unit:DocsUnit):string=>unit.flow?`docs/flows/${unit.flow.slug}.md`:unit.docsDir;

  export function docsSettingsOf(n:NightlyShared,projectId:string,scopes:string[]){
    const {ctx,services,bb,db,host,unitExtras,docsUnitsFinishing}=n;

    const settings=loadProjectSettings(db,projectId,scopes);
    const docs=parseDocsSettings(Object.fromEntries(["docs.enabled","docs.maintain","docs.since","docs.page_cap","docs.hour"].map((key)=>[key,configuredSetting(settings,key)])));
    return {settings,docs};
  }

  /** The first half of a unit: its git scope, the pages to refresh, the gaps, what Jev doubted last time. Nothing to do, or saved progress, is said in the state. */
  export async function prepareDocsUnit(n:NightlyShared,i:UnitInputs):Promise<{
state:"skipped";row:Record<string,unknown>}|{state:"resume"}|{state:"ready";plan:UnitPlan}> {
    const {ctx,services,bb,db,host,unitExtras,docsUnitsFinishing}=n;
    const {place,unit}=i;
    const {docs}=docsSettingsOf(n,i.projectId,i.scopes);
    const d=unit.docsDir, flow=unit.flow;
    const label=unitLabelOf(unit);
    const recordKey=docsUnitRecordKey(i.projectId,place.path,label);
    // A unit whose agent an earlier plugin instance started is picked up where it stopped, not started again.
    if(await readUnitRecord(n,recordKey)) return {state:"resume"};
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
      const drafts=(await bestEffort(bb.log, `docs decision drafts ${place.path}`, host.call("listDocsPages",{requestedHostId:place.hostId,projectCwd:place.path,roots:[".agents/decisions"],skipOversized:true},{hostId:place.hostId,timeoutMs:60_000}), null))?.pages??[];
      if(!drafts.length) return [];
      const decisions=(await allPages()).find((page)=>page.path===`${d}/decisions.md`)?.content??"";
      return drafts.map((page)=>page.path).filter((path)=>!decisions.includes(path)).sort();
    })();
    if(hasDocs&&changed.length===0&&!pending&&!decisionDrafts.length&&!i.assignment) return {state:"skipped",row:report("skipped",{reason:"no code changes"})};
    const existing=hasDocs?mine(await allPages()):[];
    // The root README.md and PROJECT.md describe the code too, so they are checked for staleness with the root docs.
    const readRootPages=async()=>unit.workspace||flow?[]:(await Promise.all(["README.md","PROJECT.md"].map(async(path)=>{
      const file=await bestEffort(bb.log, `docs root page ${path}`, bb.sdk.files.read({hostId:place.hostId,rootPath:place.path,path:resolve(place.path,path)}), null);
      return file&&typeof file.content==="string"?{path,content:file.content}:null;
    }))).filter((page):page is {path:string;content:string}=>page!==null);
    const rootPages=hasDocs?await readRootPages():[];
    const pageInput=existing.filter((page)=>!isDocsIndex(page.path)).map((page)=>({path:page.path,content:page.content}));
    // Jev judges which sections the day's diff made wrong; without it, pages whose sources changed.
    const prefetched=flow?undefined:unitExtras.get(recordKey)?.prefetch.get(d) as Promise<Awaited<ReturnType<typeof host.call<"docsAnchors">>>|null>|undefined;
    const anchors=flow?null:prefetched?await prefetched:await bestEffort(bb.log, `docs anchors ${place.path} ${d}`, host.call("docsAnchors",{requestedHostId:place.hostId,projectCwd:place.path,prefix,
      ...(unit.workspace?{}:{exclude:i.exclude,...(i.workspaces.length?{workspaces:i.workspaces}:{})}),
      pages:pageInput.map((page)=>({path:page.path,title:/^title:\s*(.+)$/m.exec(page.content)?.[1]?.trim()??page.path}))},{hostId:place.hostId,timeoutMs:1_800_000}), null);
    const gaps=hasDocs&&!flow?docsCompletenessGaps(existing,{tables:anchors?.tables??[],deploy:anchors?.deploy??false,core:anchors?.core??[],docsDir:d,workspace:Boolean(unit.workspace),
      flows:unit.flows}):{missingPages:[],uncoveredCore:[]};
    // What the depth check holds the pages to: the core code of the folder, or what the flow's entries call.
    const core=anchors?.core??flow?.calls??[];
    let refresh=hasDocs?pagesToRefresh(existing,changed):[];
    if(hasDocs){
      const cited=new Set(existing.flatMap((page)=>citedFiles([page])));
      const product=new Set(anchors?anchors.productFiles:changed);
      const uncovered=changed.filter((file)=>product.has(file)&&!cited.has(file));
      if(!pending&&!decisionDrafts.length&&!i.assignment&&!refresh.length&&!uncovered.length&&!gaps.missingPages.length&&!gaps.uncoveredCore.length) return {state:"skipped",row:report("skipped",{reason:"no page cites a changed file, and no changed product file is undocumented"})};
    }
    // What the checks still doubted after this unit's last pass goes back to the agent to recheck, while the page exists.
    const kvKey=`docs-nightly:${i.projectId}:${sha256(`${place.path}\n${label}`).slice(0,12)}`;
    const last=hasDocs?await bb.storage.kv.get(kvKey) as {warnings?:Array<{path:string;rule:string;detail:string}>}|null:null;
    const pagePaths=new Set(existing.map((page)=>page.path));
    const doubts=(last?.warnings??[]).filter((warning)=>(warning.rule==="evidence-check"||warning.rule==="contradiction")&&pagePaths.has(warning.path));
    return {state:"ready",plan:{label,hasDocs,changed,changedCount:changed.length,refresh,gaps,
      anchors:anchors?{count:anchors.anchors,...(anchors.briefPath?{briefPath:anchors.briefPath}:{}),deploy:anchors.deploy??false}:null,
      core:core.slice(0,2000),kvKey,doubts,decisionDrafts,beforeDirty:before.dirty,localDate:before.localDate,
      // Pages an earlier failed pass left oversized are this unit's work, not the base's.
      oversizedAtStart:oversized.filter((path)=>!before.dirty.includes(path))}};
  }

  /**
   * The second step of a unit: the docs agent. Starts it (once: the unit record names its thread, and its spawn key is the unit's night) and waits
   * until its turn ends. A unit with saved progress does not start a second agent; one in its repair round is waited for in the verify step.
   */
  export async function writeDocsUnit(n:NightlyShared,i:UnitInputs,plan:UnitPlan|null,step:{
runId:string;stepKey:string;nodeId:string},stop:()=>string|null,retry=""):Promise<string> {
    const {ctx,services,bb,db,host,unitExtras,docsUnitsFinishing}=n;
    const {place,unit}=i;
    const label=unitLabelOf(unit);
    const recordKey=docsUnitRecordKey(i.projectId,place.path,label);
    let record=await readUnitRecord(n,recordKey);
    if(!record){
      if(!plan) throw new Error("docs unit has neither a plan nor saved progress");
      const {settings,docs}=docsSettingsOf(n,i.projectId,i.scopes);
      const selection=docsSelection(settings,resolveSpawnModel({role:"docs-maintainer",settings,catalog:modelCatalogOf(ctx).peek(),hostId:place.hostId,usage:spawnUsageOf(ctx)}));
      const [providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:place.hostId}),bb.sdk.providers.models({providerId:selection.providerId,hostId:place.hostId})]);
      const provider=providers.find((item)=>item.id===selection.providerId&&item.available);
      const model=catalog.models.find((item)=>item.id===selection.model||item.model===selection.model);
      if(!provider||!model) throw new Error(`docs provider or model unavailable: ${selection.providerId}/${selection.model}`);
      const effort=selection.reasoningLevel;
      const tier=provider.capabilities.supportsServiceTier?bbServiceTier(selection.serviceTier):null;
      // The long material (changed paths, pages to refresh, gaps, doubts, drafts) goes to a file in the task's folder;
      // the brief names it, so a first-message cap (Antigravity ~12 KB) cannot drop it. Inline stays the fallback.
      let materialPath:string|undefined;
      if(plan.hasDocs&&(plan.changed.length||plan.refresh.length||plan.gaps.missingPages.length||plan.gaps.uncoveredCore.length||plan.doubts.length||plan.decisionDrafts.length)){
        const rel=`.agents/docs-night/${plan.localDate}-${label.replace(/[^A-Za-z0-9_.-]+/g,"-")}.md`;
        const material=["# Docs-night material",`Unit: ${label}`, "",
          ...plan.changed.length?["## Changed paths",...plan.changed.map((p)=>`- ${p}`),""]:[],
          ...plan.refresh.length?["## Pages whose sources changed or that are drafts",...plan.refresh.map((p)=>`- ${p}`),""]:[],
          ...plan.gaps.missingPages.length?["## Pages the method requires that do not exist yet",...plan.gaps.missingPages.map((p)=>`- ${p}`),""]:[],
          ...plan.gaps.uncoveredCore.length?["## Core behaviour and routes no page cites yet",...plan.gaps.uncoveredCore.map((p)=>`- ${p}`),""]:[],
          ...plan.doubts.length?["## Claims the analyzer doubted; recheck each in the code",...plan.doubts.map((d)=>`- ${d.path}: ${d.detail}`),""]:[],
          ...plan.decisionDrafts.length?["## Decision drafts to fold into docs/decisions.md as ADRs",...plan.decisionDrafts.map((p)=>`- ${p}`),""]:[],
        ].join("\n");
        const written=await bestEffort(bb.log, `docs material ${rel}`, bb.sdk.files.write({hostId:place.hostId,rootPath:place.path,path:resolve(place.path,rel),content:material,contentEncoding:"utf8",createParents:true}).then(()=>true), false);
        if(written) materialPath=rel;
      }
      const threadId=await spawnDocsThread(n,{projectId:i.projectId,visibility:"hidden",title:`Lane Pilot docs: ${basename(place.path)}${unit.workspace?` · ${unit.workspace.path}`:unit.flow?` · flow ${unit.flow.slug}`:""}`,
        ...writerExecutionSelection(selection.providerId,selection.model,effort,tier),
        ...projectRoleField(bb,db,i.projectId,selection.providerId,"docs-maintainer"),
        prompt:nightlyDocsPrompt({since:docs.since,hasDocs:plan.hasDocs,changed:plan.changed,refresh:plan.refresh,anchorsPath:plan.anchors?.briefPath,deploy:plan.anchors?.deploy??false,missingPages:plan.gaps.missingPages,uncoveredCore:plan.gaps.uncoveredCore,
          agent:typeof settings["docs.agent"]==="string"?settings["docs.agent"] as string:undefined,unit,doubts:plan.doubts,decisionDrafts:plan.decisionDrafts,assignment:i.assignment||undefined,...(materialPath?{materialPath}:{})}),
        environment:{type:"host",hostId:place.hostId,workspace:{type:"unmanaged",path:place.path}},
        pluginMetadata:{role:"docs-nightly",stageId:"docs-nightly",spawnId:`${i.projectId}:${sha256(`${place.path}\n${label}`).slice(0,12)}:${plan.localDate}${retry}`,...graphStepMetadata(step)}});
      // From here on the unit's progress is saved, so a plugin reload picks the same agent thread up again.
      record={version:1,projectId:i.projectId,place,...(i.basePath&&i.basePath!==place.path?{basePath:i.basePath}:{}),label,unit,threadId,phase:"writing",beforeDirty:plan.beforeDirty,localDate:plan.localDate,
        since:docs.since,roots:i.roots,workspaces:i.workspaces,hasDocs:plan.hasDocs,changedCount:plan.changedCount,refresh:plan.refresh,gaps:plan.gaps,
        anchors:plan.anchors?{count:plan.anchors.count}:null,core:plan.core,kvKey:plan.kvKey,oversizedAtStart:plan.oversizedAtStart,runKey:i.runKey};
      await saveDocsUnitRecord(n,record);
    }
    // A unit of a night long gone is not waited for: the verify step drops it.
    if(record.phase==="writing"&&!nightIsOver(record)){
      try{ await waitThreadIdle(bb,record.threadId,"docs_nightly",undefined,undefined,stop); }
      catch(cause){
        // The agent's thread failed: the unit is done for tonight, its pages stay pending. A reload keeps the progress for the next instance.
        if(!pluginStopped(cause)&&!ctx.isDisposed()) await bestEffort(bb.log, "docs unit record drop", dropDocsUnitRecord(n,record), undefined);
        // The model's plan ran out before the work: the unit goes to the next model at once (the failure took the spent plan off the
        // pick, spawn-model.ts), not to the next night. Once: a second refusal is a real failure.
        const limit=!retry&&plan&&!pluginStopped(cause)&&!ctx.isDisposed()?providerLimitNotice((cause instanceof Error?cause.message:String(cause)).replace(/^.*?provider_error:/,"").slice(0,400)):null;
        if(limit){
          bb.log.warn(`docs unit ${label}: its model hit a provider limit (${limit}); rerunning on the next model`);
          return await writeDocsUnit(n,i,plan,step,stop,":limit");
        }
        throw cause;
      }
    }
    return record.threadId;
  }

  /**
   * The third step of a unit: wait for the repair round if one was in flight, check the pages the way the methodology asks, give the agent one
   * round to fix, and say which findings block and which are only Jev's doubts. What the agent changed outside every docs folder is put back
   * first; other folders' passes may be writing theirs.
   */
  export async function verifyDocsUnit(n:NightlyShared,key:string,stop:()=>string|null):Promise<{
state:"skipped";row:Record<string,unknown>}|{state:"ok";verified:Verified;threadId:string}> {
    const {ctx,services,bb,db,host,unitExtras,docsUnitsFinishing}=n;
    const record=await readUnitRecord(n,key);
    if(!record) throw new Error("docs unit record is gone");
    const {place,unit,threadId,label}=record;
    // A unit from a night long gone is not finished: its list of files dirty before the agent is stale, so what is
    // dirty now would pass for the agent's changes and be reverted. Its pages stay for the next pass.
    if(nightIsOver(record)){
      await dropDocsUnitRecord(n,record);
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
        const file=await bestEffort(bb.log, `docs root page ${path}`, bb.sdk.files.read({hostId:place.hostId,rootPath:place.path,path:resolve(place.path,path)}), null);
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
        // Semantic citation check: the identifier a claim names must sit inside its cited range, not only within the
        // file's bounds. Bounded reads of the cited lines; a file that cannot be read is left to the bounds check.
        const semantic=await lintCitationClaims(mine(pages).filter((page)=>writable(page.path)),(file,start,end)=>host.call("readBoundedFile",
          {requestedHostId:place.hostId,projectCwd:place.path,relativePath:file,offset:Math.max(0,start-1),maxLines:Math.min(end-start+1,2000)},
          {hostId:place.hostId,timeoutMs:60_000}).then((out)=>out.content,()=>null));
        const findings:DocsFinding[]=blockingDocsFindings([...sized.blocking,
          ...lintDocsPages(pages,counts,oversized).filter((finding)=>writable(finding.path)),...semantic],docsDirty);
        // The capabilities catalogue covers every capability the apps document, not only the ones inside a flow.
        const catalogue=unit.flows?.length?pages.find((page)=>page.path===`${d}/capabilities.md`):undefined;
        if(catalogue){
          const features=pages.map((page)=>page.path).filter((path)=>/^apps\/[^/]+\/docs\/features\/[^/]+\.md$/.test(path));
          // A link on an area page the catalogue links (docs/capabilities/<area>.md) counts: the size limit splits it.
          for(const path of uncataloguedPages(catalogue,pages,features)) findings.push({path:catalogue.path,rule:"coverage",detail:`does not link ${path}: add the capability that page describes, with its conditions and where it is available, citing the code that page cites (never the page itself), and link it from ${d}/capabilities.md or an area page it links under ${d}/capabilities/ (operator tools under operator capabilities); keep the links already there`});
        }
        let pageStats:Checked["pageStats"]=[];
        return {touched,docsDirty,pageStats,findings,kept:blockingDocsFindings(sized.kept,docsDirty)};
      };
      let checked=await inspect();
      if(record.phase==="writing"&&checked.findings.length){
        // The repair counts only once its own turn completes, not the turn the agent already finished.
        const sentAt=Date.now()-2_000;
        await saveDocsUnitRecord(n,{...record,phase:"repairing",sentAt});
        await bb.sdk.threads.send({threadId,mode:"queue-if-active",input:[{type:"text",text:docsRepairPrompt(checked.findings),mentions:[]}]});
        await waitThreadIdle(bb,threadId,"docs_nightly_repair",undefined,sentAt,stop);
        checked=await inspect();
      }
      // A judged finding is a signal, not a verdict: once the agent has rechecked it in the repair round, it goes to the report as a warning.
      const judged=(finding:{rule:string})=>finding.rule==="evidence-check"||finding.rule==="contradiction"||finding.rule==="depth"||finding.rule==="links-external";
      const warnings=[...checked.findings.filter(judged),...checked.kept];
      checked={...checked,findings:checked.findings.filter((finding)=>!judged(finding))};
      return {state:"ok",verified:{checked,warnings,reverted},threadId};
    }catch(cause){
      // The agent's thread failed or its work cannot be checked: the unit is done for tonight, its pages stay pending.
      if(!pluginStopped(cause)&&!ctx.isDisposed()) await bestEffort(bb.log, "docs unit record drop", dropDocsUnitRecord(n,record), undefined);
      docsUnitsFinishing.delete(key);
      throw cause;
    }
  }

  /**
   * The last step of a unit: builders own what the model must not write (Referenced by blocks, verified confidence, the index); the pages that passed
   * are committed (code never is) and merged into the project checkout under the writers' merge lock. The report is the unit's row.
   */
  export async function commitDocsUnit(n:NightlyShared,key:string,verified:Verified):Promise<Record<string,unknown>> {
    const {ctx,services,bb,db,host,unitExtras,docsUnitsFinishing}=n;

    const record=await readUnitRecord(n,key);
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
        if(record.basePath) merged=await mergeDocs(n,record.basePath,place,`docs${unit.workspace?`(${unit.workspace.path})`:flow?`(flow ${flow.slug})`:""}: ${record.hasDocs?"nightly refresh":"onboarding"} ${record.localDate}`);
      }
      const failure=checked.findings.length?`${checked.findings.length} docs checks still fail after one repair round`:null;
      const row=report(failure?"failed":"passed",{threadId,onboarding:!record.hasDocs,changedCode:record.changedCount,refreshed:record.refresh,gaps:record.gaps,anchors:record.anchors,
        docsWritten:checked.touched.filter(writable),commit,...(merged?{merged}:{}),...(reverted.length?{reverted}:{}),...(warnings.length?{warnings}:{}),...(failure?{reason:failure,findings:checked.findings.slice(0,30)}:{})});
      await bb.storage.kv.set(record.kvKey,{...row,at:Date.now()});
      await dropDocsUnitRecord(n,record);
      // A failed unit names why, so the line the watcher reads carries the cause; the findings are in the unit's KV row.
      bb.log.info(`Lane Pilot nightly docs ${row.state} for ${record.basePath??place.path} ${label}${merged?` (merge ${merged})`:""}${failure?`: ${failure}`:""}`);
      return row;
    }catch(cause){
      if(!pluginStopped(cause)&&!ctx.isDisposed()) await bestEffort(bb.log, "docs unit record drop", dropDocsUnitRecord(n,record), undefined);
      throw cause;
    }finally{ docsUnitsFinishing.delete(key); }
  }
