import { parseHelperPlacement, type HelperPlacementMode } from "./lp-defaults";

export type ParentThreadPlacement = {
  id: string;
  projectId: string;
  sectionId?: string | null;
  environmentId?: string | null;
  environmentHostId?: string | null;
  environmentPath?: string | null;
  sourceThreadId?: string | null;
  lifecycleOwnerThreadId?: string | null;
};

export type HelperSpawnPlacement = {
  visibility: "hidden" | "visible";
  projectId: string;
  parentThreadId: string;
  sourceThreadId: string;
  lifecycleOwnerThreadId: string;
  title: string;
  environmentId?: string;
};

const ROLE_TITLES: Record<string, string> = {
  writer: "Lane Pilot writer",
  "emergency-writer": "Lane Pilot emergency writer",
  "plan-critic": "Lane Pilot plan critique",
  "code-critic": "Lane Pilot code critique",
  "specialist-reviewer": "Lane Pilot specialist review",
  "pm-reader": "Lane Pilot large-file reader",
  "docs-maintainer": "Lane Pilot docs",
  onboarder: "Lane Pilot onboarding",
  "memory-maintainer": "Lane Pilot memory",
  "night-reviewer": "Lane Pilot night review",
  "night-fixer": "Lane Pilot night fix",
  "gate-triage": "Lane Pilot gate triage",
};

export function helperThreadTitle(role: string, taskTitle?: string): string {
  const base = ROLE_TITLES[role] ?? `Lane Pilot ${role}`;
  return taskTitle ? `${base}: ${taskTitle}` : base;
}

export function resolveHelperPlacement(input: {
  mode: unknown;
  projectId: string;
  parent: ParentThreadPlacement;
  role: string;
  taskTitle?: string;
}): { ok: true; placement: HelperSpawnPlacement } | { ok: false; reason: string } {
  if (input.parent.projectId !== input.projectId) {
    return { ok: false, reason: "helper_parent_project_mismatch" };
  }
  const sourceThreadId = input.parent.sourceThreadId?.trim() || "";
  const lifecycleOwnerThreadId = input.parent.lifecycleOwnerThreadId?.trim() || "";
  if (!sourceThreadId || !lifecycleOwnerThreadId) {
    return { ok: false, reason: "helper_parent_relation_missing" };
  }
  const mode: HelperPlacementMode = parseHelperPlacement(input.mode);
  const title = helperThreadTitle(input.role, input.taskTitle);
  const base = {
    projectId: input.projectId,
    parentThreadId: input.parent.id,
    sourceThreadId,
    lifecycleOwnerThreadId,
    title,
  };
  if (mode === "plugin") {
    return { ok: true, placement: { ...base, visibility: "hidden" } };
  }
  return {
    ok: true,
    placement: {
      ...base,
      visibility: "visible",
      ...(input.parent.environmentId ? { environmentId: input.parent.environmentId } : {}),
    },
  };
}

export function helperSpawnFields(placement: HelperSpawnPlacement): {
  visibility: "hidden" | "visible";
  projectId: string;
  parentThreadId: string;
  sourceThreadId: string;
  lifecycleOwnerThreadId: string;
  title: string;
} {
  return {
    visibility: placement.visibility,
    projectId: placement.projectId,
    parentThreadId: placement.parentThreadId,
    sourceThreadId: placement.sourceThreadId,
    lifecycleOwnerThreadId: placement.lifecycleOwnerThreadId,
    title: placement.title,
  };
}
