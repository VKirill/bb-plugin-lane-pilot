import { randomUUID } from "node:crypto";
import { bestEffort, isNotFound, orMiss, sha256Hex, stringAt } from "@lane-pilot/kit";
import type { ServerCore } from "../../../contracts/server";
import { closeOwnerItem, closeOwnerItemsByPrefix, postOwnerItem, rpcLine } from "../../../owner-waiting";
import { renderArtifactsManifestJson, upsertProjectArtifact, writeCasCheckoutFile } from "../../../storage";
import { noteEngineWrite } from "../../../verification/server";
import { canonicalJson } from "../../models/action-order";
import { getCharter, upsertCharter } from "../repositories/sp-store";
import { charterDraftKey } from "./sp-detail";

export type CharterDomain = "seo" | "marketing" | "specialist_os";

export interface CharterProducer {
  wf?: string | null;
  runId?: string | null;
  pmThreadId?: string | null;
}

export interface SaveCharterInput {
  projectId: string;
  domain: CharterDomain;
  charter: Record<string, unknown>;
  approvedBy?: string | null;
  producer?: CharterProducer;
}

export interface ProposeCharterInput {
  projectId: string;
  domain: string;
  charter: Record<string, unknown>;
}

export interface ApproveCharterInput {
  projectId: string;
  domain: string;
  draftId: string;
}

export type ApproveCharterResult = { ok: true; version: number } | { ok: false; reason: string };

interface StoredCharterDraft {
  draftId: string;
  body: Record<string, unknown>;
  ownerItemKey?: string;
}

function isCharterDomain(domain: string): domain is CharterDomain {
  return domain === "seo" || domain === "marketing" || domain === "specialist_os";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

function compactDiffValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = canonicalJson(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function summarizeCharterDiff(prev: Record<string, unknown>, next: Record<string, unknown>): string {
  const keys = new Set([
    ...Object.keys(prev).filter((k) => k !== "_version" && k !== "_sha256"),
    ...Object.keys(next).filter((k) => k !== "_version" && k !== "_sha256"),
  ]);
  const parts: string[] = [];
  for (const key of [...keys].sort()) {
    const hasPrev = Object.prototype.hasOwnProperty.call(prev, key);
    const hasNext = Object.prototype.hasOwnProperty.call(next, key);
    if (!hasPrev && hasNext) {
      parts.push(`+${key}=${compactDiffValue(next[key])}`);
    } else if (hasPrev && !hasNext) {
      parts.push(`-${key}`);
    } else if (canonicalJson(prev[key]) !== canonicalJson(next[key])) {
      parts.push(`~${key}: ${compactDiffValue(prev[key])} -> ${compactDiffValue(next[key])}`);
    }
  }
  if (parts.length === 0) return "Без изменений в полях устава";
  const summary = parts.join("; ");
  return summary.length > 560 ? `${summary.slice(0, 557)}...` : summary;
}

function parseStoredDraft(raw: unknown): StoredCharterDraft | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const draftId = typeof rec.draftId === "string" && rec.draftId.trim() ? rec.draftId.trim() : null;
  const body = asRecord(rec.body) ?? asRecord(rec.charter);
  if (!draftId || !body) return null;
  const ownerItemKey = typeof rec.ownerItemKey === "string" && rec.ownerItemKey.trim() ? rec.ownerItemKey.trim() : undefined;
  return { draftId, body, ownerItemKey };
}

function charterOwnerItemPrefix(projectId: string, domain: string): string {
  return `sp:charter:${projectId}:${domain}:`;
}

/** Resolves the primary `{ hostId, path }` checkout for a specialist project or PM thread. */
export async function resolveProjectCheckout(
  ctx: ServerCore,
  scope: { projectId: string; pmThreadId?: string | null },
): Promise<{ hostId: string; path: string } | null> {
  return await bestEffort(
    ctx.log,
    "sp checkout resolve",
    (async () => {
      if (scope.pmThreadId) {
        const pm = await orMiss(ctx.bb.sdk.threads.get({ threadId: scope.pmThreadId }), null, isNotFound);
        const envId = stringAt(pm, "environmentId");
        const env = envId ? await orMiss(ctx.bb.sdk.environments.get({ environmentId: envId }), null, isNotFound) : null;
        const path = stringAt(env, "path");
        const hostId = stringAt(env, "hostId");
        if (path && hostId) return { hostId, path };
      }
      const proj = await orMiss(ctx.bb.sdk.projects.get({ projectId: scope.projectId }), null, isNotFound);
      const sources = Array.isArray((proj as { sources?: unknown } | null)?.sources)
        ? ((proj as { sources: Array<{ hostId?: string; path?: string }> }).sources)
        : [];
      const first = sources.find((s) => Boolean(s?.hostId && s?.path));
      return first?.hostId && first?.path ? { hostId: first.hostId, path: first.path } : null;
    })(),
    null,
  );
}

/** Writes a file into the project checkout via CAS after notifying the engine-write guard. */
export async function writeProjectCheckoutFile(
  ctx: ServerCore,
  checkout: { hostId: string; path: string } | null,
  relPath: string,
  content: string,
): Promise<string> {
  const cleanRel = relPath.replace(/^\/+/, "");
  if (!checkout || cleanRel.split("/").includes("..")) return cleanRel;
  noteEngineWrite(checkout.path, cleanRel);
  const cas = await writeCasCheckoutFile(ctx.bb.sdk.files as never, {
    hostId: checkout.hostId,
    rootPath: checkout.path,
    relPath: cleanRel,
    content,
  });
  if (!cas.ok) throw new Error(`sp.writeCheckoutFile: CAS conflict on "${cleanRel}" (${cas.outcome})`);
  return cleanRel;
}

/** Persists an approved specialist charter to SQLite, `.agents/<domain>/charter.json`, and PDAS artifacts. */
export async function saveCharter(
  ctx: ServerCore,
  input: SaveCharterInput,
): Promise<{ version: number; sha256: string }> {
  const approvedBy = input.approvedBy ?? "owner";
  const saved = upsertCharter(ctx.db, {
    projectId: input.projectId,
    domain: input.domain,
    charter: input.charter,
    approvedBy,
  });

  const checkout = await resolveProjectCheckout(ctx, {
    projectId: input.projectId,
    pmThreadId: input.producer?.pmThreadId ?? null,
  });
  const charterRel = `.agents/${input.domain}/charter.json`;
  const charterText = JSON.stringify({ ...input.charter, _version: saved.version, _sha256: saved.sha256 }, null, 2);
  await writeProjectCheckoutFile(ctx, checkout, charterRel, charterText);

  if (input.projectId) {
    upsertProjectArtifact(ctx.db, {
      projectId: input.projectId,
      artifactId: `${input.domain}.charter`,
      domain: input.domain,
      kind: "charter_json",
      relPath: charterRel,
      sha256: sha256Hex(charterText),
      summary: `${input.domain} charter v${saved.version}`,
      producerWf: input.producer?.wf ?? null,
      producerRunId: input.producer?.runId ?? null,
    });
    if (checkout) {
      await writeProjectCheckoutFile(ctx, checkout, ".agents/manifest.json", renderArtifactsManifestJson(ctx.db, input.projectId));
    }
  }
  return { version: saved.version, sha256: saved.sha256 };
}

/** Stores a charter draft in KV and posts an owner-waiting decision item with the diff summary. */
export async function proposeCharter(ctx: ServerCore, input: ProposeCharterInput): Promise<{ draftId: string }> {
  if (!isCharterDomain(input.domain)) {
    throw new Error(`invalid charter domain: ${input.domain}`);
  }
  const draftId = `draft_${randomUUID()}`;
  const key = charterDraftKey(input.projectId, input.domain);
  const ownerItemKey = `${charterOwnerItemPrefix(input.projectId, input.domain)}${draftId}`;

  const current = getCharter(ctx.db, input.projectId, input.domain);
  const diffSummary = summarizeCharterDiff(parseJsonRecord(current?.charter_json), input.charter);

  // Supersede any earlier unapproved draft proposal item so the owner sees only the latest draft.
  closeOwnerItemsByPrefix(ctx.db, charterOwnerItemPrefix(input.projectId, input.domain), "superseded:owner");
  await ctx.bb.storage.kv.set(key, {
    draftId,
    body: input.charter,
    ownerItemKey,
    createdAt: Date.now(),
  });

  postOwnerItem(ctx.db, {
    key: ownerItemKey,
    source: "specialist",
    kind: "charter_proposal",
    reason: "decision",
    projectId: input.projectId,
    wake: false,
    what: `Черновик устава (${input.domain}, ${draftId})`,
    why: diffSummary,
    actions: [
      {
        id: "approve",
        label: "Утвердить устав",
        cli: rpcLine("charter_approve", { projectId: input.projectId, domain: input.domain, draftId }),
        rpc: { method: "charter_approve", input: { projectId: input.projectId, domain: input.domain, draftId } },
      },
    ],
  });

  ctx.bb.log.info(`[specialist] charter proposed project=${input.projectId} domain=${input.domain} draft=${draftId}`);
  return { draftId };
}

/** Approves a pending charter draft, writes the new charter version, closes the owner item, and deletes the draft. */
export async function approveCharter(ctx: ServerCore, input: ApproveCharterInput): Promise<ApproveCharterResult> {
  if (!isCharterDomain(input.domain)) {
    return { ok: false, reason: "draft_not_found" };
  }
  const key = charterDraftKey(input.projectId, input.domain);
  const draft = parseStoredDraft(await ctx.bb.storage.kv.get(key));
  if (!draft || draft.draftId !== input.draftId) {
    return { ok: false, reason: "draft_not_found" };
  }

  const saved = await saveCharter(ctx, {
    projectId: input.projectId,
    domain: input.domain,
    charter: draft.body,
    approvedBy: "owner",
  });

  if (draft.ownerItemKey) {
    closeOwnerItem(ctx.db, draft.ownerItemKey, "approved:owner");
  }
  closeOwnerItemsByPrefix(ctx.db, charterOwnerItemPrefix(input.projectId, input.domain), "approved:owner");
  await ctx.bb.storage.kv.delete(key);

  ctx.bb.log.info(`[specialist] charter approved project=${input.projectId} domain=${input.domain} v=${saved.version}`);
  return { ok: true, version: saved.version };
}
