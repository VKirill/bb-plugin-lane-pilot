import type { DocsPage } from "../stages/docs";
import type { MemorySettings } from "../stages/memory";
import { acceptedOnboardingEvidence } from "../stages/onboarding";
import type { OnboardingAcceptedEvidence, OnboardingInputPage } from "../stages/onboarding";
import type { ProjectLifeTaskSummary } from "../stages/project-life";
export type DocsChildSnapshot = { pages:DocsPage[]; since:string; truncated:boolean; inputSha256:string; pageCap?:number; dispatchInput?:unknown };

export function docsResultObject(result:unknown): Record<string, unknown> {
  return result && typeof result === "object" ? { ...result as Record<string, unknown> } : {};
}

export function docsPageCapValue(value:unknown): number|null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function docsPageCapFromDispatchInput(value:unknown): number|null {
  if (!value || typeof value !== "object") return null;
  const settings = (value as { settings?:unknown }).settings;
  if (!settings || typeof settings !== "object") return null;
  return docsPageCapValue((settings as { pageCap?:unknown }).pageCap);
}

export function docsChildSnapshot(result:unknown): DocsChildSnapshot|null {
  const snapshot = docsResultObject(result).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const row = snapshot as Record<string, unknown>;
  if (!Array.isArray(row.pages) || typeof row.since !== "string" || typeof row.truncated !== "boolean" || typeof row.inputSha256 !== "string") return null;
  const pageCap = docsPageCapValue(row.pageCap);
  return {
    pages:row.pages as DocsPage[], since:row.since, truncated:row.truncated, inputSha256:row.inputSha256,
    ...(pageCap !== null ? { pageCap } : {}),
    ...(row.dispatchInput !== undefined ? { dispatchInput:row.dispatchInput } : {}),
  };
}

export function resolveDocsSnapshotPageCap(snapshot:DocsChildSnapshot, result:unknown): number|null {
  return docsPageCapValue(snapshot.pageCap)
    ?? docsPageCapFromDispatchInput(snapshot.dispatchInput)
    ?? docsPageCapFromDispatchInput(docsResultObject(result).dispatchInput);
}

export function childResultObject(result:unknown): Record<string, unknown> {
  return result && typeof result === "object" ? { ...result as Record<string, unknown> } : {};
}

export type OnboardingChildSnapshot = {
  pages:OnboardingInputPage[]; inputBytes:number; inputPageCount:number; availablePageCount:number;
  acceptanceSha256:string; agent:string; depth:"fast"|"deep"; dispatchInput?:unknown;
  acceptedEvidence?:OnboardingAcceptedEvidence;
};

export function onboardingAcceptedEvidenceFromUnknown(value:unknown): OnboardingAcceptedEvidence|undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.ownsPaths) || !Array.isArray(row.produced) || !Array.isArray(row.verification)) return undefined;
  return acceptedOnboardingEvidence({
    outputSha256:typeof row.outputSha256 === "string" ? row.outputSha256 : null,
    result:row,
  });
}

export function onboardingChildSnapshot(result:unknown): OnboardingChildSnapshot|null {
  const snapshot = childResultObject(result).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const row = snapshot as Record<string, unknown>;
  if (!Array.isArray(row.pages) || typeof row.inputBytes !== "number" || typeof row.inputPageCount !== "number"
    || typeof row.availablePageCount !== "number" || typeof row.acceptanceSha256 !== "string"
    || typeof row.agent !== "string" || (row.depth !== "fast" && row.depth !== "deep")) return null;
  const acceptedEvidence=onboardingAcceptedEvidenceFromUnknown(row.acceptedEvidence);
  return {
    pages:row.pages as OnboardingInputPage[], inputBytes:row.inputBytes, inputPageCount:row.inputPageCount,
    availablePageCount:row.availablePageCount, acceptanceSha256:row.acceptanceSha256, agent:row.agent, depth:row.depth,
    ...(row.dispatchInput !== undefined ? { dispatchInput:row.dispatchInput } : {}),
    ...(acceptedEvidence ? { acceptedEvidence } : {}),
  };
}

export type MemoryChildSnapshot = { acceptanceSha256:string; settings:MemorySettings; agent:string; dispatchInput?:unknown };

export function memoryChildSnapshot(result:unknown): MemoryChildSnapshot|null {
  const snapshot = childResultObject(result).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const row = snapshot as Record<string, unknown>;
  if (typeof row.acceptanceSha256 !== "string" || typeof row.agent !== "string" || !row.settings || typeof row.settings !== "object") return null;
  const settings = row.settings as MemorySettings;
  if (typeof settings.enabled !== "boolean" || typeof settings.coreBudget !== "number") return null;
  return {
    acceptanceSha256:row.acceptanceSha256, settings, agent:row.agent,
    ...(row.dispatchInput !== undefined ? { dispatchInput:row.dispatchInput } : {}),
  };
}

export type ProjectLifeChildSnapshot = { coveredTaskIds:string[]; tasks:ProjectLifeTaskSummary[]; baseHeadSha:string|null; agent:string; dispatchInput?:unknown };

export function projectLifeChildSnapshot(result:unknown): ProjectLifeChildSnapshot|null {
  const snapshot = childResultObject(result).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const row = snapshot as Record<string, unknown>;
  if (!Array.isArray(row.coveredTaskIds) || row.coveredTaskIds.some((id) => typeof id !== "string")) return null;
  if (!Array.isArray(row.tasks) || typeof row.agent !== "string") return null;
  return {
    coveredTaskIds:row.coveredTaskIds as string[], tasks:row.tasks as ProjectLifeTaskSummary[],
    baseHeadSha:typeof row.baseHeadSha === "string" ? row.baseHeadSha : null, agent:row.agent,
    ...(row.dispatchInput !== undefined ? { dispatchInput:row.dispatchInput } : {}),
  };
}

export type NightChildSnapshot = { acceptanceSha256:string; agent:string; dispatchInput?:unknown };

export function nightChildSnapshot(result:unknown): NightChildSnapshot|null {
  const snapshot = childResultObject(result).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const row = snapshot as Record<string, unknown>;
  if (typeof row.acceptanceSha256 !== "string" || typeof row.agent !== "string") return null;
  return {
    acceptanceSha256:row.acceptanceSha256, agent:row.agent,
    ...(row.dispatchInput !== undefined ? { dispatchInput:row.dispatchInput } : {}),
  };
}
