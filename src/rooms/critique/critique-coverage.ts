import { constants } from "node:fs";
import { isFsAbsent, lstatOrNull, orMiss, parseJsonOr, spawnAsync } from "@lane-pilot/kit";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

export type CoverageFinding={code:"plan_path_unowned"|"owns_gap"|"coverage_scan_truncated"|"owns_overlap"|"verify_missing"|"verify_heavy"|"owns_empty"|"plan_missing"|"no_tasks"|"caller_unowned"|"task_placeholder"|"output_unowned"|"output_binary"|"verify_filter_ignored"|"depends_cycle"|"depends_self";path:string;severity:"error"|"warning"|"info";finding:string};
/** The direct callers GitNexus found for one symbol of an owned file: up to 5 as `file:symbol`, and how many there are in all. */
export type CoverageCallers={file:string;symbol:string;callers:string[];total:number};
export type CoverageScan={status:"complete"|"truncated";pathCount:number;findings:CoverageFinding[];callers?:CoverageCallers[]};
const SKIP=new Set([".git",".gitnexus","node_modules",".agents",".bb",".claude",".lane-pilot","dist","build","vendor","__pycache__",".venv",".tox","coverage",".nuxt",".next",".cache"]);
const TEXT=new Set([".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".md",".json",".yaml",".yml",".sh",".go",".rs"]);
const CODE=new Set([".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".go",".rs"]);
const GENERIC=new Set(["index","main","app","utils","util","types","type","const","constants","config","settings","style","styles","test","spec","init"]);
const PLAN_PATH=/(?<![\w./])((?:[\w.-]+\/){1,8}[\w.-]+\.[A-Za-z][\w.-]{0,12})(?=$|[`\s),:])/gm;

export function covered(pattern:string,path:string):boolean {
  const a=pattern.replace(/\\/g,"/").replace(/^\.\//,"").split("/");
  const b=path.split("/");
  for(let i=0;i<a.length;i++) {
    const part=a[i]!;
    if(part==="**")return i===a.length-1;
    const value=b[i]; if(value===undefined)return false;
    const escaped=part.split("*").map((chunk)=>chunk.replace(/[.+^${}()|[\]\\]/g,"\\$&")).join(".*");
    if(!new RegExp(`^${escaped}$`).test(value))return false;
  }
  return a.length===b.length;
}
/** Generated or index output and documentation: a file there that mentions an owned target is not a missing owner (hub 2026-11: index json, .nuxt/types, PROJECT.md, docs/** filled the critic's prompt). */
const GENERATED_DIR=/(^|\/)(\.gitnexus|\.nuxt|\.next|node_modules|dist|build|coverage|\.cache)\//;
const DOC_FILE=/\.(md|mdx)$|(^|\/)docs\//i;
export function noisyCoveragePath(path:string):boolean {const clean=path.replace(/\\/g,"/").replace(/^\.\//,"");return GENERATED_DIR.test(clean)||DOC_FILE.test(clean);}
function noise(path:string):boolean{return /^(?:wiki|TODO|docs)\//.test(path)||path.includes("/docs/");}
function add(findings:CoverageFinding[],code:CoverageFinding["code"],path:string,message:string,severity?:CoverageFinding["severity"]):void {
  if(findings.some((row)=>row.path===path&&row.code===code))return;
  // Reserve the final slot for an explicit partial-coverage diagnostic instead of
  // silently dropping findings after the bounded result reaches its cap.
  if(findings.length>=9&&code!=="coverage_scan_truncated") {
    if(findings.length<10)findings.push({code:"coverage_scan_truncated",path:"findings",severity:"warning",finding:"The finding limit was reached; remaining ownership gaps may not be listed"});
    return;
  }
  if(findings.length>=10)return;
  findings.push({code,path,severity:severity??(noise(path)?"info":"warning"),finding:message});
}
function siblings(path:string):string[] {
  const file=basename(path),stem=file.slice(0,file.length-extname(file).length),parent=path.includes("/")?path.slice(0,path.lastIndexOf("/")):"";
  if(!stem||GENERIC.has(stem.toLowerCase()))return [];
  return [`tests/test_${stem}.py`,`test_${stem}.py`,`${path}.test.ts`,`${path}.spec.ts`,`${parent?`${parent}/`:""}${stem}.test.ts`,`${parent?`${parent}/`:""}${stem}.spec.ts`,`${parent?`${parent}/`:""}__tests__/${stem}.test.ts`,`${parent?`${parent}/`:""}${stem}.test.js`];
}
function callableNames(source:string):string[] {
  const names=new Set<string>();
  const declarations=[
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
  ];
  for(const declaration of declarations)for(const match of source.matchAll(declaration)) {
    const name=match[1];if(name&&!GENERIC.has(name.toLowerCase()))names.add(name);
  }
  return [...names].slice(0,12);
}
function heavyVerification(command:string):boolean {
  const value=command.trim();
  if(!value)return false;
  if(/(?:^|[;&|]\s*)(?:npx\s+)?vitest(?:\s+run)?(?:\s*$|\s+(?:--\S+|\s+)*$)/i.test(value))return true;
  if(/(?:^|[;&|]\s*)jest(?:\s*$|\s+(?:--\S+|\s+)*$)/i.test(value))return true;
  if(/(?:^|[;&|]\s*)pytest(?:\s*$|\s+(?:--\S+|\s+)*$)/i.test(value))return true;
  if(/(?:^|[;&|]\s*)npm\s+run\s+check(?:\s|$)/i.test(value))return true;
  if(!/(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test)(?:\s|$)/i.test(value))return false;
  if(value.includes(" -- ")||/\s--\s+\S/.test(value))return false;
  if(/(?:test:unit|vitest|jest).+\.(?:ts|tsx|js|mjs|cjs|py)\b/i.test(value))return false;
  return true;
}


/** Flags of vitest/jest that take a value: that value is not a test filter. */

/** Positional arguments a vitest/jest run, or an npm/pnpm/yarn script after «--», receives. */

/** Flags that narrow a pytest run without a path: by name, marker or changed files. */
/**
 * Whether one check runs a project's whole test suite: a bare `vitest run` / `npx jest` / `pytest` / `npm test` with
 * nothing that names files, tests or a workspace. A run narrowed by a path, `related`, `-t`, `-k` or `-- <args>` is a focused check.
 */
const BINARY=/\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|mp3|mp4|mov|wasm)$/i;
/** Expected outputs a model cannot author (fonts, images, archives, media, wasm). */
export function binaryOutputs(outputs:readonly string[]):string[] {return outputs.filter((entry)=>BINARY.test(entry.trim()));}
/** `npm -w ws run test -- args` / `pnpm --filter ws test -- args`: the workspace and the script that receives a filter after «--». */
export function filteredScriptRun(command:string):{ws:string;script:string}|null {
  for(const part of command.split(/&&|;|\|\|/)) {
    const tokens=part.trim().split(/\s+/),manager=tokens[0],cut=tokens.indexOf("--");
    if((manager!=="npm"&&manager!=="pnpm")||cut<0||cut===tokens.length-1)continue;
    const flag=manager==="npm"?/^(?:-w|--workspace)$/:/^(?:-F|--filter)$/,words:string[]=[];let ws="";
    for(let i=1;i<cut;i++) {
      const token=tokens[i]!,inline=/^(?:--workspace|--filter)=(.+)$/.exec(token);
      if(inline)ws=inline[1]!;else if(flag.test(token))ws=tokens[++i]??"";else if(!token.startsWith("-"))words.push(token);
    }
    ws=ws.replace(/^["']|["']$/g,"");
    const verb=words[0],script=verb==="run"||verb==="run-script"?words[1]:verb==="t"?"test":manager==="pnpm"||verb==="test"?verb:undefined;
    if(ws&&script)return {ws,script};
  }
  return null;
}
/** A script whose last command is `node --test`: npm appends the filter after «--», and that runner runs every file anyway. */
export function ignoresTrailingFilter(script:string):boolean {
  const last=script.split(/&&|;|\|\|/).pop()!.trim();
  return /(?:^|\s)(?:node|tsx)\s(?:\S+\s)*?--test(?:\s|$)/.test(last);
}
function jsonFromCli(stdout:string):Record<string,unknown>|null {
  const start=stdout.indexOf("{");if(start<0)return null;
  try {const value:unknown=JSON.parse(stdout.slice(start));return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;}
  catch {return null;}
}
export function collectGitNexusCallerPaths(payload:unknown,root:string):string[] {
  if(!payload||typeof payload!=="object")return [];
  const data=payload as Record<string,unknown>,byDepth=data.byDepth;
  if(!byDepth||typeof byDepth!=="object")return [];
  const level=(byDepth as Record<string,unknown>)["1"];
  if(!Array.isArray(level))return [];
  const paths=new Set<string>();
  for(const item of level) {
    if(!item||typeof item!=="object")continue;
    const row=item as Record<string,unknown>;
    const raw=[row.filePath,row.file_path,row.file,row.path].find((value)=>typeof value==="string");
    if(typeof raw!=="string"||!raw.trim())continue;
    const candidate=raw.replace(/\\/g,"/");
    const normalized=(isAbsolute(candidate)?relative(root,candidate):candidate).replace(/^\.\//,"");
    if(!normalized||normalized===".."||normalized.startsWith("../")||isAbsolute(normalized)||normalized.split("/").includes(".."))continue;
    paths.add(normalized);
  }
  return [...paths];
}
/** `file:symbol` of the direct callers (depth 1) of an impact payload, as the graph names them. */
export function callerLabels(payload:unknown,root:string):string[] {
  if(!payload||typeof payload!=="object")return [];
  const level=((payload as Record<string,unknown>).byDepth as Record<string,unknown>|undefined)?.["1"];
  if(!Array.isArray(level))return [];
  const labels=new Set<string>();
  for(const item of level) {
    if(!item||typeof item!=="object")continue;
    const row=item as Record<string,unknown>;
    const raw=[row.filePath,row.file_path,row.file,row.path].find((value)=>typeof value==="string");
    if(typeof raw!=="string"||!raw.trim())continue;
    const candidate=raw.replace(/\\/g,"/"),file=(isAbsolute(candidate)?relative(root,candidate):candidate).replace(/^\.\//,"");
    if(!file||file.startsWith("../")||isAbsolute(file))continue;
    labels.add(typeof row.name==="string"&&row.name?`${file}:${row.name}`:file);
  }
  return [...labels];
}
async function runGitNexusCallers(root:string,targets:readonly {filePath:string;symbol:string}[]):Promise<{paths:string[];complete:boolean;callers:CoverageCallers[]}> {
  if(targets.length===0)return {paths:[],complete:true,callers:[]};
  const info=await lstatOrNull(join(root,".gitnexus"));
  if(!info?.isDirectory()||info.isSymbolicLink())return {paths:[],complete:false,callers:[]};
  const deadline=Date.now()+8_000,paths=new Set<string>(),callers:CoverageCallers[]=[];
  const status=await spawnAsync("gitnexus",["status","--json"],{cwd:root,timeout:1_500,maxBuffer:512*1024});
  const statusJson=jsonFromCli(status.stdout??"");
  if(status.status!==0||status.error||statusJson?.status!=="up-to-date")return {paths:[],complete:false,callers:[]};
  const bounded=targets.slice(0,16);let complete=bounded.length===targets.length;
  for(const target of bounded) {
    const remaining=deadline-Date.now();if(remaining<=0){complete=false;break;}
    if(!/^[A-Za-z_$][\w$]*$/.test(target.symbol)||target.filePath.startsWith("/")||target.filePath.split("/").includes("..")){complete=false;continue;}
    const result=await spawnAsync("gitnexus",["impact",target.symbol,"--direction","upstream","--depth","1","--include-tests","--limit","100","--file",target.filePath],
      {cwd:root,timeout:Math.min(1_500,remaining),maxBuffer:1024*1024});
    const impact=jsonFromCli(result.stdout??"");
    if(result.status!==0||result.error||!impact||impact.error){complete=false;continue;}
    for(const path of collectGitNexusCallerPaths(impact,root))paths.add(path);
    const counts=impact.byDepthCounts;
    const count=counts&&typeof counts==="object"?Number((counts as Record<string,unknown>)["1"]):NaN;
    const labels=callerLabels(impact,root);
    if(labels.length)callers.push({file:target.filePath,symbol:target.symbol,callers:labels.slice(0,5),total:Number.isFinite(count)&&count>=labels.length?count:labels.length});
    const returned=Array.isArray((impact.byDepth as Record<string,unknown>|undefined)?.["1"])?((impact.byDepth as Record<string,unknown>)["1"] as unknown[]).length:0;
    if(Number.isFinite(count)&&count>returned)complete=false;
  }
  return {paths:[...paths],complete,callers};
}
export function findTaskPlaceholderPaths(value:unknown):string[] {
  const found:string[]=[];let visited=0;
  const walk=(item:unknown,path:string,depth:number):void=>{
    if(found.length>=8||visited>=256||depth>8)return;
    visited++;
    if(typeof item==="string"){if(item.includes("REPLACE_ME"))found.push(path||"<root>");return;}
    if(Array.isArray(item)){item.forEach((child,index)=>walk(child,`${path}[${index}]`,depth+1));return;}
    if(item&&typeof item==="object")for(const [key,child]of Object.entries(item))walk(child,path?`${path}.${key}`:key,depth+1);
  };
  walk(value,"",0);return found;
}

/** Bounded, read-only approximation of upstream structural ownership coverage. */
export async function scanCritiqueCoverage(input:{workspacePath:string;plan:string;tasks:readonly {id?:string;lane?:string;owns_paths?:readonly string[]|null;has_verification?:boolean;verification?:readonly {command?:string;timeout_sec?:number|null}[]}[]}):Promise<CoverageScan> {
  const rootInfo=await lstat(input.workspacePath);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error("critique workspace must be a real directory");
  const root=await realpath(input.workspacePath),files:string[]=[];let truncated=false,workspaceTruncated=false;
  const dirs=[root];
  while(dirs.length&&files.length<2_000) {
    const dir=dirs.pop()!;
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      if(entry.isSymbolicLink()||SKIP.has(entry.name))continue;
      const full=join(dir,entry.name),rel=relative(root,full).split(sep).join("/");
      if(rel.startsWith("../")||rel==="..")continue;
      if(entry.isDirectory())dirs.push(full);
      else if(entry.isFile())files.push(rel);
      if(files.length>=2_000){truncated=true;break;}
    }
  }
  if(dirs.length){truncated=true;workspaceTruncated=true;}
  files.sort();
  const existing=new Set(files),findings:CoverageFinding[]=[],unreadable:string[]=[];
  const owns=input.tasks.flatMap((task)=>task.owns_paths??[]).map((path)=>path.replace(/\\/g,"/").replace(/^\.\//,""));
  if(owns.length>8) {
    truncated=true;
    add(findings,"coverage_scan_truncated","owns_paths",`Ownership scan is bounded to 8 paths; ${owns.length-8} additional paths were not inspected`);
  }
  const writers=input.tasks.filter((task)=>!new Set(["verify","review","night","critique"]).has(task.lane?.trim().toLowerCase()??"write"));
  if(!input.plan.trim())add(findings,"plan_missing","PLAN.md","The run has no plan content to critique","error");
  if(input.tasks.length===0)add(findings,"no_tasks","tasks/","The run has no TaskV2 items to dispatch","error");
  for(const task of writers)if(!(task.owns_paths??[]).some((path)=>path.trim()))
    add(findings,"owns_empty",`tasks/${task.id??"unknown"}`,`Write task ${task.id??"unknown"} has no explicit owned paths`,"error");
  for(const task of writers) if(!task.has_verification)
    add(findings,"verify_missing",`tasks/${task.id??"unknown"}`,`Write task ${task.id??"unknown"} has no verification command` ,"error");
  for(const task of input.tasks)for(const [index,verification] of (task.verification??[]).entries()) {
    const command=verification.command??"";
    if((verification.timeout_sec??0)>900||heavyVerification(command))
      add(findings,"verify_heavy",`tasks/${task.id??"unknown"}`,`Task ${task.id??"unknown"} verification[${index}] looks like a full-package check; keep the dispatch check focused and reserve broad validation for the integration gate`,"warning");
  }
  const packageScripts=new Map<string,Record<string,unknown>|null>();
  const workspaceScripts=async(ws:string):Promise<Record<string,unknown>|null>=>{
    if(packageScripts.has(ws))return packageScripts.get(ws)!;
    const dir=ws.replace(/^\.\//,"").replace(/\/$/,"");let found:Record<string,unknown>|null=null;
    for(const file of files.filter((path)=>/^(?:[^/]+\/){0,4}package\.json$/.test(path)).slice(0,40)) {
      const handle=await orMiss(open(join(root,...file.split("/")),constants.O_RDONLY|constants.O_NOFOLLOW),null,isFsAbsent);
      if(!handle)continue;
      try {
        const info=await handle.stat();if(!info.isFile()||info.size>65_536)continue;
        const pkg=JSON.parse(await handle.readFile("utf8")) as {name?:unknown;scripts?:unknown};
        if((pkg.name===ws||file===`${dir}/package.json`)&&pkg.scripts&&typeof pkg.scripts==="object"){found=pkg.scripts as Record<string,unknown>;break;}
      } catch {/* unreadable package.json: no fact, no finding */} finally {await handle.close();}
    }
    packageScripts.set(ws,found);return found;
  };
  for(const task of input.tasks)for(const [index,verification] of (task.verification??[]).entries()) {
    const run=filteredScriptRun(verification.command??"");if(!run)continue;
    const script=(await workspaceScripts(run.ws))?.[run.script];
    if(typeof script==="string"&&ignoresTrailingFilter(script))
      add(findings,"verify_filter_ignored",`tasks/${task.id??"unknown"}`,`Task ${task.id??"unknown"} verification[${index}] passes a filter after «--», but the ${run.ws} ${run.script} script («${script.slice(0,80)}») ignores it and runs the whole suite; call the runner on the file directly (for example «node --test <file>» in that workspace)`,"error");
  }
  for(let left=0;left<writers.length;left++)for(let right=left+1;right<writers.length;right++) {
    const a=writers[left]!,b=writers[right]!;
    const overlap=(a.owns_paths??[]).flatMap((ap)=> (b.owns_paths??[]).map((bp)=>[ap.replace(/^\.\//,""),bp.replace(/^\.\//,"")] as const))
      .find(([ap,bp])=>{const x=ap.replace(/\/$/,""),y=bp.replace(/\/$/,"");return x===y||x.startsWith(`${y.replace(/\/\*\*$/,"")}/`)||y.startsWith(`${x.replace(/\/\*\*$/,"")}/`);});
    // Overlapping tasks are allowed: Lane Pilot runs them one after another (start.ts waits for the earlier one),
    // so this is a note for the critic, not a block.
    if(overlap)add(findings,"owns_overlap","tasks/",`Write tasks ${a.id??"?"} and ${b.id??"?"} overlap owns_paths (${overlap[0]} <> ${overlap[1]}); they will run one after another, not in parallel`,"warning");
  }
  let readFiles=0,readBytes=0;const textCache=new Map<string,string>();
  const mentionedTexts:Array<{source:string;text:string}>=[{source:"Plan",text:input.plan}];
  if(existing.has("SPEC.md")) {
    const handle=await orMiss(open(join(root,"SPEC.md"),constants.O_RDONLY|constants.O_NOFOLLOW),null,isFsAbsent);
    if(handle)try {
      const info=await handle.stat();
      if(info.isFile()&&info.size<=65_536&&readFiles<300&&readBytes+info.size<=4*1024*1024) {
        mentionedTexts.push({source:"SPEC.md",text:await handle.readFile("utf8")});readFiles++;readBytes+=info.size;
      } else {truncated=true;workspaceTruncated=true;}
    } finally {await handle.close();}
  }
  for(const {source,text} of mentionedTexts)for(const match of text.matchAll(PLAN_PATH)) {
    const path=match[1]!.replace(/\/{2,}/g,"/");
    if(!path.split("/").includes("..")&&existing.has(path)&&!owns.some((pattern)=>covered(pattern,path)))
      add(findings,"plan_path_unowned",path,`${source} names existing path ${path}, but no TaskV2 lane owns it`);
  }
  const graphTargets:Array<{filePath:string;symbol:string}>=[];
  for(const own of owns.slice(0,8)) {
    if(findings.length>=10)break;
    const normalized=own.replace(/\/$/,""),stem=basename(normalized).replace(/\.[^.]+$/,"");if(GENERIC.has(stem.toLowerCase()))continue;
    let ownedSource=textCache.get(normalized);
    if(ownedSource===undefined&&existing.has(normalized)&&CODE.has(extname(normalized).toLowerCase())) {
      const handle=await orMiss(open(join(root,...normalized.split("/")),constants.O_RDONLY|constants.O_NOFOLLOW),null,isFsAbsent);
      if(handle)try {
        const info=await handle.stat();
        if(info.isFile()&&info.size<=65_536&&readFiles<300&&readBytes+info.size<=4*1024*1024) {
          ownedSource=await handle.readFile("utf8");textCache.set(normalized,ownedSource);readFiles++;readBytes+=info.size;
        }
      } finally {await handle.close();}
    }
    const callNames=ownedSource?callableNames(ownedSource):[];
    for(const symbol of callNames.slice(0,2))graphTargets.push({filePath:normalized,symbol});
    for(const path of siblings(normalized))if(existing.has(path)&&!owns.some((pattern)=>covered(pattern,path)))
      add(findings,"owns_gap",path,`Sibling test ${path} exists but no TaskV2 lane owns it`);
    const needles=[normalized,basename(normalized),stem];
    for(const path of files) {
      if(findings.length>=10)break;
      if(path===normalized||noisyCoveragePath(path)||owns.some((pattern)=>covered(pattern,path))||!TEXT.has(extname(path).toLowerCase()))continue;
      const absolute=join(root,...path.split("/"));
      // One unreadable file (EACCES, a locked file) is a named skip, not a dead scan: it is listed once in the result.
      let handle;
      try { handle=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW); }
      catch(cause){ if(isFsAbsent(cause))continue; unreadable.push(path); continue; }
      let body=textCache.get(path);
      try {
        const info=await handle.stat();if(!info.isFile())continue;
        if(info.size>65_536||readFiles>=300||readBytes+info.size>4*1024*1024){truncated=true;workspaceTruncated=true;continue;}
        if(body===undefined){body=await handle.readFile("utf8");textCache.set(path,body);readFiles++;readBytes+=info.size;}
      } catch(cause){ if(!isFsAbsent(cause))unreadable.push(path); }
      finally { await handle.close(); }
      if(body===undefined)continue;
      if(CODE.has(extname(path).toLowerCase())&&callNames.some((name)=>new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\s*\\(`).test(body)))
        add(findings,"caller_unowned",path,`Code in ${path} calls an exported function from ${normalized}, but no TaskV2 lane owns this caller`);
      if(needles.some((needle)=>needle.length>=4&&body.includes(needle)))
        add(findings,"owns_gap",path,`File ${path} references owned target ${normalized} but is outside the combined TaskV2 owns_paths`);
    }
  }
  const graph=await runGitNexusCallers(root,graphTargets);
  for(const path of graph.paths)if(path!==""&&!owns.some((pattern)=>covered(pattern,path)))
    add(findings,"caller_unowned",path,`GitNexus reports a direct caller in ${path}, but no TaskV2 lane owns this caller`);
  if(!graph.complete){truncated=true;add(findings,"coverage_scan_truncated",".gitnexus","Full upstream caller traversal was unavailable, stale, or exceeded its bounded query budget; lexical coverage is only an approximation","warning");}
  if(workspaceTruncated)add(findings,"coverage_scan_truncated",".","Workspace path/read limits were reached; structural ownership coverage is partial");
  if(unreadable.length){truncated=true;add(findings,"coverage_scan_truncated",".",`${unreadable.length} file(s) could not be read and were skipped: ${unreadable.slice(0,10).join(", ")}${unreadable.length>10?", …":""}`,"warning");}
  if(findings.some((finding)=>finding.code==="coverage_scan_truncated"))truncated=true;
  return {status:truncated?"truncated":"complete",pathCount:files.length,findings,...(graph.callers.length?{callers:graph.callers}:{})};
}

const GAP_CODES=new Set<CoverageFinding["code"]>(["owns_gap","caller_unowned","plan_path_unowned"]);
/** «Nobody owns X» is no gap when the task forbids X on purpose (never_touch): the critic got these as noise (audit 2026-11-08). */
export function dropIntendedGaps(findings:readonly CoverageFinding[],neverTouch:readonly string[]):CoverageFinding[] {
  return findings.filter((finding)=>!(GAP_CODES.has(finding.code)&&neverTouch.some((pattern)=>covered(pattern,finding.path))));
}
/** A host that scans with older code may still list a generated or documentation file as an unowned referrer: drop those here. A plan's own mention (plan_path_unowned) stays. */
export function dropNoisyGaps(findings:readonly CoverageFinding[]):CoverageFinding[] {
  return findings.filter((finding)=>!((finding.code==="owns_gap"||finding.code==="caller_unowned")&&noisyCoveragePath(finding.path)));
}
