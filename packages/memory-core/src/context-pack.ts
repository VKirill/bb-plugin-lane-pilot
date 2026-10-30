import { estimateTokens, memoryEntrySalience } from "./candidates";
import { roleContextBudget } from "./context";
import { memoryContextLine } from "./context";
import { sha256Hex } from "@lane-pilot/kit";
import type { MemoryRecord } from "./settings";

/** One thing the pack may carry. `required` is a mandatory rule/policy: it is never silently cut. */
export type PackCandidate = { id: string; kind: "rule" | "note" | "preference" | "owner-fact"; content: string;
  concepts?: readonly string[]; required?: boolean; relevance?: number; scope?: readonly string[]; stale?: boolean };

export type PackSource = PackCandidate & { packed: boolean; reason?: string };

/** One context pack for one (project, repo, section chain, role) — the single memory injection of a session. */
export type ContextPack = {
  projectId: string; repoId: string; sectionChain: string[]; role: string; audience: string; bot: string;
  sourceRevision: string; sources: PackSource[]; packedBytes: number; estimatedTokens: number; packId: string; text: string;
};

/**
 * M4: budget = the role cap (`roleContextBudget` — the project may only narrow it). Required sources pack first;
 * when they alone do not fit, the build fails naming the oversized source instead of silently cutting a rule.
 * Optional candidates go in by relevance and are cut first. A stale note (its named files drifted) is excluded
 * for re-verification, never delivered silently. Without a chain only explicitly root-whitelisted candidates pack.
 */
export function buildContextPack(input: {
  projectId: string; repoId?: string; sectionChain?: readonly string[]; role: string; audience?: string; bot?: string;
  sourceRevision?: string; budget: number; candidates: readonly PackCandidate[]; rootWhitelist?: ReadonlySet<string>;
}): ContextPack {
  const budget = roleContextBudget(input.role, input.budget);
  const chain = [...(input.sectionChain ?? [])];
  const scoped = input.candidates.map((candidate) => {
    if (candidate.stale) return { ...candidate, packed: false, reason: "stale:needs_review" } as PackSource;
    const scope = candidate.scope;
    // No chain: only an explicitly root-whitelisted candidate packs; project-wide is never assumed.
    const allowed = !chain.length ? (input.rootWhitelist?.has(candidate.id) ?? false)
      : scope === undefined || !scope.length ? true
      : chain.slice(0, scope.length).join("\0") === scope.join("\0");
    return { ...candidate, packed: false, ...(allowed ? {} : { reason: "scope:not-deliverable" }) } as PackSource;
  });
  const required = scoped.filter((source) => source.required && !source.reason);
  const requiredBytes = required.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0);
  if (estimateTokensSize(requiredBytes) > budget) {
    const biggest = required.reduce((a, b) => (Buffer.byteLength(a.content) >= Buffer.byteLength(b.content) ? a : b));
    throw new Error(`context_pack_oversized:${biggest.kind}:${biggest.id}`);
  }
  let text = "";
  const pack = (source: PackSource) => { source.packed = true; text = text ? `${text}\n${source.content}` : source.content; };
  for (const source of required) pack(source);
  for (const source of scoped.filter((s) => !s.required && !s.reason).sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || a.id.localeCompare(b.id))) {
    const next = text ? `${text}\n${source.content}` : source.content;
    if (estimateTokens(next) > budget) { source.reason = "cut:over-budget"; continue; }
    source.packed = true; text = next;
  }
  const sources = [...scoped];
  const packedIds = sources.filter((source) => source.packed).map((source) => source.id).sort();
  return {
    projectId: input.projectId, repoId: input.repoId ?? "", sectionChain: chain, role: input.role,
    audience: input.audience ?? "subagent", bot: input.bot ?? "", sourceRevision: input.sourceRevision ?? "",
    sources, packedBytes: Buffer.byteLength(text), estimatedTokens: estimateTokens(text),
    packId: sha256Hex(`${input.projectId}:${input.role}:${packedIds.join(",")}`).slice(0, 24), text,
  };
}

function estimateTokensSize(bytes: number): number { return Math.ceil(bytes / 4); }

/** Shadow run: the new pack against what the old path delivered — ids, exclusion reasons, byte/token delta. */
export function shadowPackCompare(oldDeliveredIds: readonly string[], oldBytes: number, pack: ContextPack): {
  kept: string[]; added: string[]; dropped: string[]; excludedReasons: Record<string, string>;
  oldBytes: number; packedBytes: number; estimatedTokens: number;
} {
  const packed = new Set(pack.sources.filter((source) => source.packed).map((source) => source.id));
  const old = new Set(oldDeliveredIds);
  const excludedReasons: Record<string, string> = {};
  for (const source of pack.sources) if (source.reason) excludedReasons[source.id] = source.reason;
  return {
    kept: [...old].filter((id) => packed.has(id)), added: [...packed].filter((id) => !old.has(id)),
    dropped: [...old].filter((id) => !packed.has(id)), excludedReasons,
    oldBytes, packedBytes: pack.packedBytes, estimatedTokens: pack.estimatedTokens,
  };
}

/** The candidates an LP memory search contributes: one note per record, relevance from the same ranking terms. */
export function memoryCandidates(records: readonly MemoryRecord[], staleIds?: ReadonlySet<string>): PackCandidate[] {
  return records.map((record) => ({ id: record.id, kind: "note" as const, content: memoryContextLine(record), concepts: record.concepts,
    stale: staleIds?.has(record.id) ?? false,
    relevance: 0.5 + (record.acceptedCount ?? 0) }));
}
