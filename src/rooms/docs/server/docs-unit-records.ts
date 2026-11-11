import { bestEffort } from "@lane-pilot/kit";
import { sha256 } from "../../tasks";
import type { NightlyShared, DocsUnitRecord } from "./docs-night-state";

  export async function readUnitRecord(n:NightlyShared,key:string):Promise<DocsUnitRecord|null> {
    const {bb}=n;

    return await bb.storage.kv.get(key) as DocsUnitRecord|null;
  }

  /** Whether a unit's night is long gone, so it is not finished from saved progress. */
  export function nightIsOver(record:{localDate:string}):boolean { return Date.now()-Date.parse(`${record.localDate}T00:00:00Z`)>DOCS_UNIT_RESUME_MS; }

  /** The key a unit's saved progress lives under, and the index of units with progress not yet finished. */
  export function docsUnitRecordKey(projectId:string,placePath:string,label:string):string {
    return `docs-unit:${projectId}:${sha256(`${placePath}\n${label}`).slice(0,12)}`;
  }

  export const DOCS_UNITS_OPEN_KEY="docs-units-open";


  /** Index writes go one at a time: units of a pass save their progress side by side. */
  export function updateDocsUnitsIndex(n:NightlyShared,change:(open:Record<string,true>)=>void):Promise<void> {
    const {bb}=n;

    const next=n.docsUnitsIndexChain.then(async()=>{
      const open=(await bb.storage.kv.get(DOCS_UNITS_OPEN_KEY) as Record<string,true>|null)??{};
      change(open);
      await bb.storage.kv.set(DOCS_UNITS_OPEN_KEY,open);
    });
    n.docsUnitsIndexChain=bestEffort(bb.log, "docs units index", next, undefined);
    return next;
  }

  export async function saveDocsUnitRecord(n:NightlyShared,record:DocsUnitRecord):Promise<void> {
    const {bb}=n;

    const key=docsUnitRecordKey(record.projectId,record.place.path,record.label);
    await bb.storage.kv.set(key,record);
    await updateDocsUnitsIndex(n,(open)=>{ open[key]=true; });
  }

  export async function dropDocsUnitRecord(n:NightlyShared,record:DocsUnitRecord):Promise<void> {
    const {bb}=n;

    const key=docsUnitRecordKey(record.projectId,record.place.path,record.label);
    await bestEffort(bb.log, `docs unit record ${key}`, bb.storage.kv.delete(key), undefined);
    await updateDocsUnitsIndex(n,(open)=>{ delete open[key]; });
  }

  /** A reload or a retired host generation stops this instance, not the unit: its progress stays for the next one. */
  /** How long after the start of its night a unit may still be finished from saved progress. */
  export const DOCS_UNIT_RESUME_MS=48*3_600_000;
