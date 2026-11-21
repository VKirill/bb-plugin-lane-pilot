import { join } from "node:path";
import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import {
  WORKFLOW_FILE_ID,
  casWriteSkillBundle,
  casWriteWorkflowFile,
  listSkillBundleIds,
  nodeFileSource,
  readSkillBundle,
  removeWorkflowFile,
  restoreSkillBundleSnapshot,
  type SkillBundleReadResult,
  type SkillBundleWriteResult,
  type StoredSkillBundleFile,
} from "@lane-pilot/workflow-engine";
import {
  appendSkillEvolutionEvent,
  type LanePilotDatabase,
  type SupersededWorkflowSnapshot,
} from "../../storage";
import { builtinWorkflow } from "../../workflow";
import type { DeprojectizeContext } from "../deprojectize";
import { lintAndVerifyCompanionSkill, type CompanionSkillCandidate } from "./companion-skill-merge";

const ARCHETYPE_FILE_RE = /^references\/archetype-([a-z0-9][a-z0-9-]{0,47})\.md$/;

export type ExistingCompanionSkillInfo = { skillId: string; archetypes: string[]; sectionCount: number };

export type PendingPublishedSkillEvent = {
  draftId: string; draftVersion: number; workflowId: string; skillId: string;
  operator: string; mergeMode: string;
  candidateFiles: StoredSkillBundleFile[]; beforeFiles: StoredSkillBundleFile[];
  beforeBundleSha256: string | null; afterBundleSha256: string | null;
};

/** Scans `skillsRoot` best-effort for existing companion skill bundles and metadata. */
export async function readExistingCompanionSkills(skillsRoot: string): Promise<{
  existingCompanionSkills: ExistingCompanionSkillInfo[];
  existingSkillBundles: Map<string, StoredSkillBundleFile[]>;
}> {
  const existingCompanionSkills: ExistingCompanionSkillInfo[] = [];
  const existingSkillBundles = new Map<string, StoredSkillBundleFile[]>();
  for (const skillId of await listSkillBundleIds(skillsRoot)) {
    const bundle = await readSkillBundle(skillsRoot, skillId).catch(() => null);
    if (!bundle?.exists) continue;
    existingSkillBundles.set(skillId, bundle.files);
    const archetypes = bundle.files.flatMap((f) => { const m = ARCHETYPE_FILE_RE.exec(f.path); return m ? [m[1]!] : []; });
    const skeletonText = bundle.files.find((f) => f.path === "references/golden-skeleton.md")?.text ?? "";
    existingCompanionSkills.push({ skillId, archetypes, sectionCount: (skeletonText.match(/^##\s+/gm) ?? []).length });
  }
  return { existingCompanionSkills, existingSkillBundles };
}

/** Validates companion skill candidates against existing disk bundles, lint rules, and deprojectization. */
export async function validateCompanionSkillCandidates(
  skillsRoot: string,
  candidates: readonly CompanionSkillCandidate[],
  options?: { deprojectize?: DeprojectizeContext; log?: (m: string) => void },
): Promise<string[]> {
  const errors: string[] = [];
  for (const skill of candidates) {
    let beforeFiles: StoredSkillBundleFile[] = [];
    try {
      beforeFiles = (await readSkillBundle(skillsRoot, skill.skillId, { log: options?.log })).files;
    } catch (cause) {
      errors.push(`${skill.skillId}: read_error:${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    const verdict = lintAndVerifyCompanionSkill(skill, beforeFiles, { deprojectize: options?.deprojectize, log: options?.log });
    if (!verdict.ok) for (const f of verdict.findings) errors.push(`${skill.skillId}: ${f.code}:${f.detail}`);
  }
  return errors;
}

/** Matches companion skills to workflows in `orderedIds` (unmatched skills attach to the last ordered workflow). */
export function mapCompanionSkillsToWorkflows(
  orderedIds: readonly string[],
  allCandidateIds: ReadonlySet<string>,
  companionSkills: readonly CompanionSkillCandidate[],
): Map<string, CompanionSkillCandidate[]> {
  const byWf = new Map<string, CompanionSkillCandidate[]>();
  if (!orderedIds.length || !companionSkills.length) return byWf;
  const fallbackId = orderedIds[orderedIds.length - 1]!;
  for (const skill of companionSkills) {
    const matched = orderedIds.filter((id) => skill.workflowIds.includes(id));
    const targets = matched.length > 0 ? matched : !skill.workflowIds.some((id) => allCandidateIds.has(id)) ? [fallbackId] : [];
    for (const targetId of targets) {
      const list = byWf.get(targetId) ?? [];
      list.push(skill);
      byWf.set(targetId, list);
    }
  }
  return byWf;
}

/** Captures initial on-disk snapshots for a batch of companion skills before suite writes begin. */
export async function snapshotSkillBundles(
  skillsRoot: string,
  skills: readonly CompanionSkillCandidate[],
  log?: (m: string) => void,
): Promise<Map<string, SkillBundleReadResult>> {
  const map = new Map<string, SkillBundleReadResult>();
  for (const skill of skills) {
    if (map.has(skill.skillId)) continue;
    const bundle = await readSkillBundle(skillsRoot, skill.skillId, { log }).catch(() => null);
    if (bundle) map.set(skill.skillId, bundle);
  }
  return map;
}

/** Stages matched companion skill bundles (or retirement intent) in `lane_pilot_skill_evolution` for a tested draft. */
export async function stageCompanionSkillsForDraft(input: {
  db: LanePilotDatabase; skillsRoot: string; draftId: string; draftVersion: number; workflowId: string; operator: string;
  skills: readonly CompanionSkillCandidate[]; initialReads?: ReadonlyMap<string, SkillBundleReadResult>;
  supersededWorkflowIds?: readonly string[]; deprojectize?: DeprojectizeContext; log?: (m: string) => void;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const superseded = input.supersededWorkflowIds ?? [];
  if (input.skills.length === 0 && superseded.length > 0) {
    appendSkillEvolutionEvent(input.db, {
      draftId: input.draftId, draftVersion: input.draftVersion, workflowId: input.workflowId,
      skillId: "suite-workflow-retirement", operator: input.operator, mergeMode: "retire_only", status: "staged",
      candidateFiles: [], beforeFiles: [], beforeBundleSha256: null, afterBundleSha256: null, supersededWorkflowIds: superseded,
    }, { log: input.log });
    return { ok: true };
  }
  for (const skill of input.skills) {
    let before: SkillBundleReadResult;
    try {
      before = input.initialReads?.get(skill.skillId) ?? await readSkillBundle(input.skillsRoot, skill.skillId, { log: input.log });
    } catch (cause) {
      return { ok: false, reason: `${skill.skillId}: read_error:${cause instanceof Error ? cause.message : String(cause)}` };
    }
    const verdict = lintAndVerifyCompanionSkill(skill, before.files, { deprojectize: input.deprojectize, log: input.log });
    if (!verdict.ok) return { ok: false, reason: verdict.findings.map((f) => `${skill.skillId}: ${f.code}:${f.detail}`).join("; ") };
    appendSkillEvolutionEvent(input.db, {
      draftId: input.draftId, draftVersion: input.draftVersion, workflowId: input.workflowId,
      skillId: skill.skillId, operator: input.operator, mergeMode: skill.mergeMode, status: "staged",
      candidateFiles: skill.files, beforeFiles: before.files, beforeBundleSha256: before.bundleSha256,
      afterBundleSha256: null, supersededWorkflowIds: superseded,
    }, { log: input.log });
    input.log?.(`INFO [nightGraphs.companionSkill] staged ${redactKnown(JSON.stringify({
      workflowId: input.workflowId, draftId: input.draftId, draftVersion: input.draftVersion, skillId: skill.skillId, mergeMode: skill.mergeMode,
    }))}`);
  }
  return { ok: true };
}

/** Retires obsolete narrow global workflows on disk while protecting builtins and newly published suite IDs. */
export async function retireSupersededWorkflows(
  workflowDir: string,
  supersededIds: readonly string[],
  protectedIds: ReadonlySet<string>,
  log?: (m: string) => void,
): Promise<SupersededWorkflowSnapshot[]> {
  const snapshots: SupersededWorkflowSnapshot[] = [];
  const seen = new Set<string>();
  for (const raw of supersededIds) {
    const oldId = raw.trim();
    if (!oldId || seen.has(oldId)) continue;
    seen.add(oldId);
    if (!WORKFLOW_FILE_ID.test(oldId) || builtinWorkflow(oldId) || protectedIds.has(oldId)) continue;
    const path = join(workflowDir, `${oldId}.json`);
    let content: string;
    try { content = await nodeFileSource.read(path); } catch { continue; }
    const sha256 = sha256Hex(content);
    await removeWorkflowFile(workflowDir, oldId);
    snapshots.push({ workflowId: oldId, path, content, sha256 });
  }
  if (snapshots.length > 0) {
    log?.(`INFO [nightGraphs.companionSkill] superseded_retired ${redactKnown(JSON.stringify({
      count: snapshots.length, workflowIds: snapshots.map((s) => s.workflowId),
    }))}`);
  }
  return snapshots;
}

/** Atomically restores or removes a workflow JSON file when paired companion-skill CAS publishing fails. */
export async function rollbackWorkflowFileOnDisk(
  workflowDir: string,
  workflowId: string,
  diskBase: { path: string; raw: string } | null,
  afterSha256: string | null,
  log?: (m: string) => void,
): Promise<void> {
  const path = diskBase?.path ?? join(workflowDir, `${workflowId}.json`);
  try {
    if (diskBase) {
      const expected = afterSha256 ?? await nodeFileSource.read(path).then(sha256Hex, () => null);
      await casWriteWorkflowFile(workflowDir, workflowId, diskBase.raw, expected);
    } else await removeWorkflowFile(workflowDir, workflowId);
  } catch (cause) {
    log?.(`WARN [nightGraphs.companionSkill] rollback_workflow_failed ${redactKnown(JSON.stringify({
      workflowId, reason: cause instanceof Error ? cause.message : String(cause),
    }))}`);
  }
}

/** Atomically writes all matched companion skills for a workflow, rolling back prior writes on any conflict. */
export async function publishCompanionSkillsForWorkflow(input: {
  skillsRoot: string; draftId: string; draftVersion: number; workflowId: string; operator: string;
  skills: readonly CompanionSkillCandidate[];
  publishedInRun: Map<string, { beforeFiles: StoredSkillBundleFile[]; beforeBundleSha256: string | null; afterBundleSha256: string | null }>;
  deprojectize?: DeprojectizeContext; log?: (m: string) => void;
}): Promise<{ ok: true; events: PendingPublishedSkillEvent[] } | { ok: false; reason: string }> {
  const pendingReads = new Map<string, SkillBundleReadResult>();
  for (const skill of input.skills) {
    if (input.publishedInRun.has(skill.skillId)) continue;
    let before: SkillBundleReadResult;
    try { before = await readSkillBundle(input.skillsRoot, skill.skillId, { log: input.log }); } catch (cause) {
      return { ok: false, reason: `${skill.skillId}: read_error:${cause instanceof Error ? cause.message : String(cause)}` };
    }
    const verdict = lintAndVerifyCompanionSkill(skill, before.files, { deprojectize: input.deprojectize, log: input.log });
    if (!verdict.ok) return { ok: false, reason: verdict.findings.map((f) => `${skill.skillId}: ${f.code}:${f.detail}`).join("; ") };
    pendingReads.set(skill.skillId, before);
  }

  const writtenInCall: Array<{ skillId: string; beforeFiles: StoredSkillBundleFile[] }> = [];
  const events: PendingPublishedSkillEvent[] = [];
  const rollbackCall = async (skillId: string, reason: string) => {
    for (const prev of [...writtenInCall].reverse()) {
      await restoreSkillBundleSnapshot(input.skillsRoot, prev.skillId, prev.beforeFiles, { log: input.log }).catch(() => undefined);
      input.publishedInRun.delete(prev.skillId);
    }
    input.log?.(`WARN [nightGraphs.companionSkill] rollback_on_conflict ${redactKnown(JSON.stringify({
      workflowId: input.workflowId, skillId, reason, rolledBackCount: writtenInCall.length,
    }))}`);
  };

  for (const skill of input.skills) {
    const reused = input.publishedInRun.get(skill.skillId);
    if (reused) {
      events.push({
        draftId: input.draftId, draftVersion: input.draftVersion, workflowId: input.workflowId,
        skillId: skill.skillId, operator: input.operator, mergeMode: skill.mergeMode,
        candidateFiles: skill.files.map((f) => ({ path: f.path, text: f.text, sha256: sha256Hex(f.text) })),
        beforeFiles: reused.beforeFiles, beforeBundleSha256: reused.beforeBundleSha256, afterBundleSha256: reused.afterBundleSha256,
      });
      continue;
    }
    const before = pendingReads.get(skill.skillId)!;
    let write: SkillBundleWriteResult;
    try {
      write = await casWriteSkillBundle(input.skillsRoot, skill.skillId, skill.files, before.bundleSha256, { log: input.log });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      await rollbackCall(skill.skillId, reason);
      return { ok: false, reason };
    }
    if (write.status !== "applied") {
      const reason = write.reason ?? write.status;
      await rollbackCall(skill.skillId, reason);
      return { ok: false, reason };
    }
    writtenInCall.push({ skillId: skill.skillId, beforeFiles: before.files });
    input.publishedInRun.set(skill.skillId, { beforeFiles: before.files, beforeBundleSha256: before.bundleSha256, afterBundleSha256: write.afterSha256 });
    events.push({
      draftId: input.draftId, draftVersion: input.draftVersion, workflowId: input.workflowId,
      skillId: skill.skillId, operator: input.operator, mergeMode: skill.mergeMode,
      candidateFiles: write.afterFiles, beforeFiles: before.files, beforeBundleSha256: before.bundleSha256, afterBundleSha256: write.afterSha256,
    });
  }
  return { ok: true, events };
}

/** Publishes matched companion skills after workflow write; rolls back the workflow file on skill conflict. */
export async function publishMatchedSkillsOrRollbackWf(input: {
  workflowDir: string; skillsRoot: string; draftId: string; draftVersion: number; workflowId: string;
  operator: string; skills: readonly CompanionSkillCandidate[];
  publishedInRun: Map<string, { beforeFiles: StoredSkillBundleFile[]; beforeBundleSha256: string | null; afterBundleSha256: string | null }>;
  diskBase: { path: string; raw: string } | null; writeAfterSha: string | null;
  deprojectize?: DeprojectizeContext; log?: (m: string) => void;
}): Promise<{ ok: true; events: PendingPublishedSkillEvent[] } | { ok: false; reason: string }> {
  if (input.skills.length === 0) return { ok: true, events: [] };
  const res = await publishCompanionSkillsForWorkflow(input);
  if (!res.ok) await rollbackWorkflowFileOnDisk(input.workflowDir, input.workflowId, input.diskBase, input.writeAfterSha, input.log);
  return res;
}

/** Flushes published companion-skill ledger events and attaches retired superseded workflow snapshots. */
export function recordPublishedSkillEvolutionEvents(input: {
  db: LanePilotDatabase;
  events: readonly PendingPublishedSkillEvent[];
  supersededWorkflowIds: readonly string[];
  supersededSnapshots: readonly SupersededWorkflowSnapshot[];
  fallbackTarget: { draftId: string; draftVersion: number; workflowId: string; operator: string } | null;
  log?: (m: string) => void;
}): void {
  const { events, supersededWorkflowIds, supersededSnapshots, fallbackTarget } = input;
  if (events.length === 0) {
    if (fallbackTarget && (supersededWorkflowIds.length > 0 || supersededSnapshots.length > 0)) {
      appendSkillEvolutionEvent(input.db, {
        draftId: fallbackTarget.draftId, draftVersion: fallbackTarget.draftVersion, workflowId: fallbackTarget.workflowId,
        skillId: "suite-workflow-retirement", operator: fallbackTarget.operator, mergeMode: "retire_only", status: "published",
        candidateFiles: [], beforeFiles: [], beforeBundleSha256: null, afterBundleSha256: null, supersededWorkflowIds, supersededSnapshots,
      }, { log: input.log });
      input.log?.(`INFO [nightGraphs.companionSkill] published ${redactKnown(JSON.stringify({
        workflowId: fallbackTarget.workflowId, skillId: "suite-workflow-retirement", bundleSha256: null, supersededCount: supersededSnapshots.length,
      }))}`);
    }
    return;
  }
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    const isLast = i === events.length - 1;
    appendSkillEvolutionEvent(input.db, {
      ...ev, status: "published",
      supersededWorkflowIds: isLast ? supersededWorkflowIds : [],
      supersededSnapshots: isLast ? supersededSnapshots : [],
    }, { log: input.log });
    input.log?.(`INFO [nightGraphs.companionSkill] published ${redactKnown(JSON.stringify({
      workflowId: ev.workflowId, skillId: ev.skillId, bundleSha256: ev.afterBundleSha256, supersededCount: isLast ? supersededSnapshots.length : 0,
    }))}`);
  }
}
