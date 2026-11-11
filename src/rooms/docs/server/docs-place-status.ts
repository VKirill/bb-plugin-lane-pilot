import { resolve, basename } from "node:path";
import { bestEffort, orMiss, isNotFound } from "@lane-pilot/kit";
import { sha256 } from "../../tasks";
import { latestDocsTaskAt } from "../../storage";
import { codeDocsVerdict, docsCadence, docsFactsKey, docsWorthinessState, DOCS_WORTHINESS_QUESTION, fallbackDocsVerdict } from "../docs-worthiness";
import type { DocsCadence, DocsVerdict, DocsWorthinessFacts } from "../docs-worthiness";
import type { NightlyShared } from "./docs-night-state";

  /** A folder on one machine: the unit docs are judged and written for. */
  export type DocsPlace = { hostId:string; path:string };
  export type StoredDocsVerdict = DocsVerdict & { projectId:string; hostId:string; path:string; factsKey:string; facts:DocsWorthinessFacts; at:number; docsSince:number|null };
  const WORTH_KEY=(place:DocsPlace)=>`docs-worthiness:${place.hostId}:${sha256(resolve(place.path)).slice(0,16)}`;
  /** A verdict older than this is asked again even when the folder looks the same. */
  const VERDICT_TTL_MS=30*24*3_600_000;

  /**
   * Whether docs are worth keeping for this folder on this machine. Facts come from the folder itself; code
   * settles the clear cases, System One the borderline ones. Kept until the facts move or a month passes.
   */
  export async function docsVerdict(n:NightlyShared,projectId:string, place:DocsPlace, opts:{
force?:boolean;now?:number}={}):Promise<StoredDocsVerdict|null> {
    const {bb,db,host,listProjectSections,sectionChain}=n;
    const now=opts.now??Date.now();
    const stored=await bb.storage.kv.get(WORTH_KEY(place)) as StoredDocsVerdict|null;
    const facts=await bestEffort(bb.log, `docs worthiness facts ${place.path}`, host.call("docsWorthinessFacts",{requestedHostId:place.hostId,projectCwd:place.path},{hostId:place.hostId,timeoutMs:60_000}), null);
    if(!facts) return stored;
    const factsKey=docsFactsKey(facts);
    const docsSince=stored?.docsSince??(facts.docsPages>0?now:null);
    if(stored&&!opts.force&&stored.factsKey===factsKey&&now-stored.at<VERDICT_TTL_MS) return {...stored,facts,docsSince};
    let verdict=codeDocsVerdict(facts);
    if(!verdict){
      const judged=await bestEffort(bb.log, `docs worthiness judge ${place.path}`, host.call("councilJudge",{requestedHostId:place.hostId,state:JSON.stringify(docsWorthinessState(facts,place)),
        questions:{worth:{instructions:DOCS_WORTHINESS_QUESTION.instructions,criteria:{...DOCS_WORTHINESS_QUESTION.criteria}}}},{hostId:place.hostId,timeoutMs:10_000}), null);
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
  export function docsLastRead(n:NightlyShared,place:DocsPlace):number|null {
    const {bb,db,host,listProjectSections,sectionChain}=n;

    const root=resolve(place.path);
    return latestDocsTaskAt(db, { root, hostId: place.hostId });
  }

  /** Where a folder in auto mode stands: verdict, and for kept docs how often they are refreshed. */
  export async function docsPlaceStatus(n:NightlyShared,projectId:string, place:DocsPlace, opts:{
force?:boolean;now?:number}={}):Promise<{verdict:StoredDocsVerdict|null;cadence:DocsCadence;lastReadAt:number|null}> {
    const {bb,db,host,listProjectSections,sectionChain}=n;
    const now=opts.now??Date.now();
    const verdict=await docsVerdict(n,projectId,place,opts);
    const lastReadAt=docsLastRead(n,place);
    const cadence=verdict?.need&&verdict.facts.docsPages>0&&verdict.docsSince!==null ? docsCadence({lastReadAt,docsSince:verdict.docsSince,now}) : "nightly";
    return {verdict,cadence,lastReadAt};
  }

  /** Every folder of a project on every machine: its sources and its section folders, as the nightly pass sees them. */
  export async function docsPlaces(n:NightlyShared,projectId:string):Promise<Array<DocsPlace & {
scopes:string[];name:string}>> {
    const {bb,db,host,listProjectSections,sectionChain}=n;
    const places:Array<DocsPlace & {scopes:string[];name:string}>=[];
    const described=await orMiss(bb.sdk.projects.get({projectId}), null, isNotFound) as {name?:string;sources?:Array<{hostId?:string;path?:string}>}|null;
    for(const source of described?.sources??[]){
      if(source.hostId&&source.path&&!places.some((place)=>place.hostId===source.hostId&&place.path===source.path)) places.push({scopes:[],hostId:source.hostId,path:source.path,name:described?.name??basename(source.path)});
    }
    const sections=await listProjectSections(projectId);
    // Every device copy of a section is a place, like every source of the project above.
    for(const section of sections) if(section.kind==="folder") for(const copy of section.paths) if(copy.path&&copy.hostId) places.push({scopes:sectionChain(sections,section.id),hostId:copy.hostId,path:copy.path,name:section.name});
    return places;
  }
