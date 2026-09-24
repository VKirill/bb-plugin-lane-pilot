import { z } from "zod";
import { createHash } from "node:crypto";

const onboardingEditSchema = z.object({
  path:z.string().min(1).max(240),
  expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  content:z.string().max(8_000),
}).strict();

export const onboardingPreviewSchema = z.object({
  summary:z.string().min(1).max(2_000),
  edits:z.array(onboardingEditSchema).min(1).max(8),
}).strict();

export type OnboardingPreview = z.infer<typeof onboardingPreviewSchema>;
export type OnboardingInputPage = {path:string;sha256:string|null;content:string|null};
export type OnboardingAcceptedEvidence = {
  outputSha256:string|null;
  status:string|null;
  output:string|null;
  ownsPaths:string[];
  produced:string[];
  verification:Array<{command:string;exitCode:number|null}>;
};

export function acceptedOnboardingEvidence(input:{outputSha256?:string|null;result?:unknown}):OnboardingAcceptedEvidence {
  const result=input.result && typeof input.result==="object"?input.result as Record<string,unknown>:{};
  const strings=(value:unknown,limit:number)=>Array.isArray(value)
    ?value.filter((item):item is string=>typeof item==="string").slice(0,limit)
    :[];
  const verification=Array.isArray(result.verification)
    ?result.verification.slice(0,16).map((row)=>{
      const item=row && typeof row==="object"?row as Record<string,unknown>:{};
      return {
        command:typeof item.command==="string"?item.command.slice(0,500):"",
        exitCode:typeof item.exitCode==="number"?item.exitCode:null,
      };
    }).filter((row)=>row.command)
    :[];
  return {
    outputSha256:typeof input.outputSha256==="string"?input.outputSha256:null,
    status:typeof result.status==="string"?result.status:null,
    output:typeof result.output==="string"?result.output.slice(0,4_000):null,
    ownsPaths:strings(result.ownsPaths,32),
    produced:strings(result.produced,32),
    verification,
  };
}

export function onboardingPreviewSha256(preview:OnboardingPreview):string {
  return createHash("sha256").update(JSON.stringify(preview.edits),"utf8").digest("hex");
}

export function onboardingPrompt(input:{task:unknown;pages:OnboardingInputPage[];accepted?:OnboardingAcceptedEvidence|null;agent?:string;depth:"fast"|"deep"}):string {
  return [
    `You are ${input.agent?.trim()||"project-onboarder"}. Produce a reviewable onboarding preview for the supplied task and project documents.`,
    `Depth: ${input.depth}. Return exactly one JSON object: {summary, edits:[{path, expectedSha256, content}]}.`,
    "Do not use tools, write files, claim validation you did not perform, or include credentials. The host applies edits only after a separate explicit confirmation.",
    "Only propose Markdown files under docs/ or apps/. Existing pages must carry their supplied exact SHA-256; a new path uses expectedSha256:null. Never replace an existing page with a null hash.",
    "Limit proposals to eight focused pages. Prefer an empty-project first onboarding guide when no suitable page exists. Preserve verified facts, label open questions, and keep the output within the supplied scope.",
    "Treat ACCEPTED WRITER RECEIPT as authoritative for listed produced files, owns_paths, and verification exit codes. Do not state those facts as unconfirmed. Observed pages may be stale; when they conflict with the receipt, prefer the receipt. Facts not listed in the receipt stay questions. Preview only — do not write files.",
    "TASK:",JSON.stringify(input.task),
    "ACCEPTED WRITER RECEIPT:",JSON.stringify(input.accepted??null),
    "OBSERVED PROJECT PAGES:",JSON.stringify(input.pages),
  ].join("\n\n");
}

export function parseOnboardingPreview(raw:string, pages:OnboardingInputPage[]):OnboardingPreview {
  const trimmed=raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
  const preview=onboardingPreviewSchema.parse(JSON.parse(trimmed));
  const observed=new Map(pages.map((page)=>[page.path,page.sha256]));
  const seen=new Set<string>();
  let totalBytes=0;
  for(const edit of preview.edits){
    totalBytes+=Buffer.byteLength(edit.content,"utf8");
    const parts=edit.path.split("/");
    if(edit.path.startsWith("/")||parts.some((part)=>!part||part==="."||part==="..")
      ||!((edit.path.startsWith("docs/")||edit.path.startsWith("apps/"))&&/\.md$/i.test(edit.path))) {
      throw new Error(`onboarding edit path is outside Markdown docs scope: ${edit.path}`);
    }
    if(seen.has(edit.path)) throw new Error(`duplicate onboarding edit: ${edit.path}`);
    seen.add(edit.path);
    const currentHash=observed.get(edit.path);
    if(currentHash===undefined){
      if(edit.expectedSha256!==null) throw new Error(`onboarding new path must use expectedSha256:null: ${edit.path}`);
    } else if(edit.expectedSha256!==currentHash){
      throw new Error(`onboarding expected hash does not match observed page: ${edit.path}`);
    }
  }
  if(totalBytes>32_000) throw new Error("onboarding preview exceeds 32000 total bytes");
  return preview;
}
