import { bestEffort, isNotFound, orMiss, sha256Hex, stringAt } from "@lane-pilot/kit";
import { dropMemoryIndexes, hideRecord, listMemoryByOrigin, storeMemoryRecords } from "@lane-pilot/memory-core";
import type { GraphNode, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { postOwnerItem } from "../../owner-waiting";
import {
  getRun,
  renderArtifactsManifestJson,
  upsertProjectArtifact,
  writeCasCheckoutFile,
  type LanePilotDatabase,
} from "../../storage";
import { noteEngineWrite } from "../../verification/server";
import {
  appendVerbatim,
  computePassportMetrics,
  createEmptyPassport,
  detectPassportContradictions,
  detectPassportFluff,
  extractFlatPatchClaims,
  formatClaimValue,
  getPassport,
  isClaimFilled,
  listVerbatim,
  mergePassportPatch,
  patchPassportHypothesis,
  passportV1Schema,
  reconcileDiskPassportWithDb,
  renderBrandcoreProjection,
  renderCharterDefaults,
  selectNextPassportQuestions,
  upsertPassport,
  type ClaimStatus,
  type PassportV1,
} from "../index";

type Row = Record<string, unknown>;
type ActionReg = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;

const asStr = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v);

function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "object") return val as T;
  if (typeof val === "string" && val.trim()) {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export async function resolvePassportCheckout(
  ctx: ServerCore,
  rt: ChainRuntime,
): Promise<{ hostId: string; path: string } | null> {
  if (rt.pmThreadId) {
    const pm = await orMiss(ctx.bb.sdk.threads.get({ threadId: rt.pmThreadId }), null, isNotFound);
    const envId = stringAt(pm, "environmentId");
    if (envId) {
      const env = await orMiss(ctx.bb.sdk.environments.get({ environmentId: envId }), null, isNotFound);
      const hostId = stringAt(env, "hostId");
      const path = stringAt(env, "path");
      if (hostId && path) return { hostId, path };
    }
  }
  const run = rt.runId ? getRun(ctx.db, rt.runId) : undefined;
  const cfg = await bestEffort(ctx.log, "passport checkout config", ctx.configForRun(rt.projectId, run), null);
  if (cfg?.hostId && cfg.pmWorkspacePath) return { hostId: cfg.hostId, path: cfg.pmWorkspacePath };
  if (cfg?.hostId && cfg.writerWorkspacePath) return { hostId: cfg.hostId, path: cfg.writerWorkspacePath };
  return null;
}

async function readCheckoutText(
  ctx: ServerCore,
  checkout: { hostId: string; path: string } | null,
  relPath: string,
): Promise<string | null> {
  if (!checkout) return null;
  const clean = relPath.replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return null;
  const res = await bestEffort(
    ctx.log,
    `passport read ${clean}`,
    ctx.bb.sdk.files.read({
      hostId: checkout.hostId,
      rootPath: checkout.path,
      path: `${checkout.path}/${clean}`,
      maxBytes: 256_000,
    } as never),
    null,
  );
  if (!res || typeof res !== "object") return null;
  const content = (res as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

export async function writePassportCheckoutArtifacts(
  ctx: ServerCore,
  checkout: { hostId: string; path: string } | null,
  projectId: string,
  scopeKey = "",
): Promise<{
  passport_path: string;
  passport_md_path: string;
  verbatim_path: string;
  brandcore_path: string;
  brandcore_projection_path: string;
}> {
  const paths = {
    passport_path: ".agents/passport/PASSPORT.json",
    passport_md_path: ".agents/passport/PASSPORT.md",
    verbatim_path: ".agents/passport/VERBATIM.jsonl",
    brandcore_path: ".agents/passport/BRANDCORE.md",
    brandcore_projection_path: ".agents/passport/BRANDCORE.projection.md",
  };
  const stored = getPassport(ctx.db, projectId, scopeKey);
  if (!stored) return paths;
  const verbatim = listVerbatim(ctx.db, projectId, { scopeKey, limit: 200 });
  const brandcore = renderBrandcoreProjection(stored.passport);
  const passportJsonText = JSON.stringify(stored.passport, null, 2);

  const upsertMainArtifact = () =>
    upsertProjectArtifact(ctx.db, {
      projectId,
      artifactId: scopeKey ? `passport.main:${scopeKey}` : "passport.main",
      domain: "passport",
      kind: "passport_json",
      relPath: paths.passport_path,
      sha256: sha256Hex(passportJsonText),
      summary: `Project Passport v1 (completeness=${stored.metrics.completeness_score}, confirmed=${stored.metrics.confirmed_count})`,
      producerWf: "project-passport",
    });
  const upsertBrandcoreArtifact = () =>
    upsertProjectArtifact(ctx.db, {
      projectId,
      artifactId: scopeKey ? `passport.brandcore:${scopeKey}` : "passport.brandcore",
      domain: "passport",
      kind: "brandcore_md",
      relPath: paths.brandcore_path,
      sha256: sha256Hex(brandcore.markdown),
      summary: `BrandCore projection (${stored.metrics.confirmed_count} confirmed claims)`,
      producerWf: "project-passport",
    });

  if (!checkout) {
    upsertMainArtifact();
    upsertBrandcoreArtifact();
    return paths;
  }

  const writeVerified = async (rel: string, content: string): Promise<boolean> => {
    noteEngineWrite(checkout.path, rel);
    const res = await bestEffort(
      ctx.log,
      `passport write ${rel}`,
      writeCasCheckoutFile(ctx.bb.sdk.files as never, {
        hostId: checkout.hostId,
        rootPath: checkout.path,
        relPath: rel,
        content,
      }),
      { ok: false, relPath: rel, sha256: "", outcome: "error" },
    );
    return res.ok;
  };

  const mainOk = await writeVerified(paths.passport_path, passportJsonText);
  await writeVerified(paths.passport_md_path, stored.passport_md);
  await writeVerified(paths.verbatim_path, `${verbatim.map((v) => JSON.stringify(v)).join("\n")}${verbatim.length ? "\n" : ""}`);
  const brandcoreOk = await writeVerified(paths.brandcore_path, brandcore.markdown);
  await writeVerified(paths.brandcore_projection_path, brandcore.markdown);

  if (mainOk) upsertMainArtifact();
  if (brandcoreOk) upsertBrandcoreArtifact();
  if (mainOk || brandcoreOk) {
    const manifestJson = renderArtifactsManifestJson(ctx.db, projectId);
    await writeVerified(".agents/manifest.json", manifestJson);
  }
  return paths;
}

/**
 * Syncs a concise 1-line L1 `core` summary into `lane_pilot_memory` (`origin: "passport"`) so ordinary BB threads (`l1Facts`)
 * and `coreShelf` readers carry the project's primary market/ICP truth alongside `projectPassportBlock`.
 */
export function syncPassportCoreMemory(db: LanePilotDatabase, projectId: string, passport: PassportV1): void {
  try {
    const name = formatClaimValue(passport.identity.project_name.value);
    const oneLiner = formatClaimValue(passport.identity.one_liner.value);
    const countries = passport.market_rails.primary_countries.value.join(",");
    const locales = passport.market_rails.content_locales.value.join(",") || passport.market_rails.ui_locales.value.join(",");
    const icp = formatClaimValue(passport.positioning.best_fit_icp.value);
    const parts = [
      name ? `Project ${name}` : "",
      oneLiner ? oneLiner.slice(0, 90) : "",
      countries || locales ? `market=${countries || "?"}/${locales || "?"}` : "",
      icp ? `ICP=${icp.slice(0, 70)}` : "",
    ].filter(Boolean);
    if (!parts.length) return;
    const line = `Project Passport: ${parts.join(" · ")}.`.slice(0, 220);

    // Retire previous passport core records so we never bloat the core shelf
    const prev = listMemoryByOrigin(db as never, "passport").filter((r) => r.projectId === projectId);
    for (const old of prev) {
      if (old.content === line) return;
      hideRecord(db as never, projectId, old.id, "superseded", null, (p, id) => dropMemoryIndexes(db as never, p, id), "owner");
    }

    storeMemoryRecords(db as never, {
      projectId,
      audience: "subagent",
      sourceSha256: sha256Hex(line),
      entries: [{ kind: "core", content: line, concepts: ["passport", "architecture"] }],
      coreBudget: 600,
      noteBudget: 1200,
      indexBudget: 500,
      trust: "confirmed",
      origin: "passport",
    });
  } catch {
    // Non-fatal if memory tables are not initialized in an isolated unit test
  }
}

function shapeActionOut(node: Extract<GraphNode, { type: "action" }>, baseOut: Row): Row {
  const out: Row = {};
  for (const f of node.out) {
    out[f.name] =
      baseOut[f.name] !== undefined
        ? baseOut[f.name]
        : f.type === "boolean"
          ? false
          : f.type === "number"
            ? 0
            : f.type === "array"
              ? []
              : "";
  }
  return out;
}

export function registerPassportExecutors(_engine: WorkflowEngine, ctx: ServerCore, deps: { action: ActionReg }): void {
  const { db } = ctx;
  const { action } = deps;

  action("passport.probe", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const scopeKey = asStr(params.scopeKey, "");
    const mode = asStr(params.mode, "express");
    const targetDomain = asStr(params.targetDomain, "");
    const checkout = await resolvePassportCheckout(ctx, rt);

    let stored = getPassport(db, rt.projectId, scopeKey);
    if (checkout) {
      const diskJson = await readCheckoutText(ctx, checkout, ".agents/passport/PASSPORT.json");
      let diskCanonical = "";
      let hasDiskConflicts = false;
      if (diskJson) {
        const parsed = passportV1Schema.safeParse(parseJsonSafe(diskJson, {}));
        if (parsed.success) {
          diskCanonical = JSON.stringify(parsed.data);
          const syncRes = reconcileDiskPassportWithDb(db, {
            projectId: rt.projectId,
            scopeKey,
            diskPassport: parsed.data,
          });
          stored = syncRes.record;
          if (syncRes.updatedPaths.length > 0) {
            syncPassportCoreMemory(db, rt.projectId, stored.passport);
          }
          if (syncRes.queuedDeltas.length > 0) {
            hasDiskConflicts = true;
            for (const delta of syncRes.queuedDeltas) {
              bestEffort(ctx.log, "post passport disk conflict", Promise.resolve().then(() => {
                postOwnerItem(db, {
                  key: `passport_delta:${delta.id}`,
                  source: "workflow",
                  kind: "question",
                  projectId: rt.projectId,
                  wake: false,
                  what: `Принять правку поля «${delta.field_path}» из PASSPORT.json?`,
                  why: delta.reason,
                  evidence: [{ kind: "file", ref: ".agents/passport/PASSPORT.json", label: delta.field_path }],
                  actions: [
                    { id: "accept", label: "Принять с диска", cli: `bb lane-pilot project-passport decide --project ${rt.projectId} --id ${delta.id} --decision accept`, rpc: { method: "passport_decide", input: { projectId: rt.projectId, deltaId: delta.id, decision: "accept" } } },
                    { id: "reject", label: "Оставить как в БД", cli: `bb lane-pilot project-passport decide --project ${rt.projectId} --id ${delta.id} --decision reject`, rpc: { method: "passport_decide", input: { projectId: rt.projectId, deltaId: delta.id, decision: "reject" } } },
                  ],
                });
              }), undefined);
            }
          }
        }
      }
      if (
        stored &&
        stored.metrics.completeness_score > 0 &&
        !hasDiskConflicts &&
        (!diskJson || diskCanonical !== JSON.stringify(stored.passport))
      ) {
        await writePassportCheckoutArtifacts(ctx, checkout, rt.projectId, scopeKey);
      }
    }

    const passport = stored?.passport ?? createEmptyPassport();
    const reconSnippets: string[] = [];
    if (checkout) {
      for (const candidate of [
        "README.md",
        "PROJECT.md",
        ".agents/planning/VALUE-MAP.md",
        ".agents/passport/BRANDCORE.md",
        ".agents/seo/BRANDCORE.md",
        ".agents/seo/charter.json",
        ".agents/marketing/charter.json",
        "DESIGN.md",
      ]) {
        const txt = await readCheckoutText(ctx, checkout, candidate);
        if (txt && txt.trim()) {
          reconSnippets.push(`### ${candidate}\n${txt.trim().slice(0, 1_200)}`);
        }
      }
    }

    const metrics = computePassportMetrics(passport);
    const contradictions = detectPassportContradictions(passport);
    const fluffWarnings = detectPassportFluff(passport);
    const nextQuestions = selectNextPassportQuestions(passport, { mode, targetDomain, maxQuestions: 3 });
    const brandcore = renderBrandcoreProjection(passport);
    const charterDefaults = renderCharterDefaults(passport);

    const baseOut: Row = {
      has_passport: Boolean(stored && metrics.completeness_score > 0),
      completeness_score: metrics.completeness_score,
      confirmed_count: metrics.confirmed_count,
      hypothesis_count: metrics.hypothesis_count,
      unknown_count: metrics.unknown_count,
      taboo_count: metrics.taboo_count,
      missing_critical_count: nextQuestions.length,
      passport_json: JSON.stringify(passport),
      passport_md: stored?.passport_md ?? "",
      recon_summary: reconSnippets.join("\n\n").slice(0, 6_000),
      contradictions_json: JSON.stringify(contradictions),
      fluff_warnings_json: JSON.stringify(fluffWarnings),
      next_questions_json: JSON.stringify(nextQuestions),
      brandcore_json: JSON.stringify(brandcore.json),
      charter_defaults_json: JSON.stringify(charterDefaults),
      should_continue: nextQuestions.length > 0 && metrics.completeness_score < (mode === "express" ? 55 : 82),
    };

    return shapeActionOut(node, baseOut);
  });

  action("passport.commit", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const scopeKey = asStr(params.scopeKey, "");
    const source = asStr(params.source, c.workflow.id);
    const ownerVerbatim = asStr(params.ownerVerbatim).trim();
    const questionAsked = asStr(params.questionAsked).trim();
    const rawPatch = parseJsonSafe<Row>(params.patch, {});

    const current = getPassport(db, rt.projectId, scopeKey)?.passport ?? createEmptyPassport();
    let evidenceRef = `wf:${c.workflow.id}:${c.runId.slice(0, 10)}`;

    let verbatimId = "";
    if (ownerVerbatim && ownerVerbatim !== "skip" && ownerVerbatim !== "stop") {
      const preMerged = mergePassportPatch(current, rawPatch, { evidenceRef: "preview" });
      const changedPreview = extractFlatPatchClaims(current, preMerged);
      const entry = appendVerbatim(db, {
        projectId: rt.projectId,
        scopeKey,
        source,
        threadId: rt.pmThreadId,
        runId: c.runId,
        questionAsked,
        ownerVerbatim,
        extractedPaths: changedPreview,
      });
      verbatimId = entry.id;
      evidenceRef = entry.id;
    }

    const merged = Object.keys(rawPatch).length > 0
      ? mergePassportPatch(current, rawPatch, { evidenceRef })
      : current;
    const changedPaths = extractFlatPatchClaims(current, merged);
    const saved = upsertPassport(db, {
      projectId: rt.projectId,
      scopeKey,
      passport: merged,
      updatedBy: source,
    });

    syncPassportCoreMemory(db, rt.projectId, saved.passport);

    const checkout = await resolvePassportCheckout(ctx, rt);
    const paths = await writePassportCheckoutArtifacts(ctx, checkout, rt.projectId, scopeKey);
    const contradictions = detectPassportContradictions(saved.passport);
    const fluffWarnings = detectPassportFluff(saved.passport);
    const nextQuestions = selectNextPassportQuestions(saved.passport, {
      mode: asStr(params.mode, "express"),
      targetDomain: asStr(params.targetDomain, ""),
    });

    const stopRequested =
      params.stopRequested === true ||
      /^(stop|enough|хватит|стоп|сохранить как есть)/i.test(ownerVerbatim);

    const baseOut: Row = {
      ok: true,
      version: saved.version,
      verbatim_id: verbatimId,
      changed_count: changedPaths.length,
      changed_paths: changedPaths,
      completeness_score: saved.metrics.completeness_score,
      confirmed_count: saved.metrics.confirmed_count,
      hypothesis_count: saved.metrics.hypothesis_count,
      unknown_count: saved.metrics.unknown_count,
      taboo_count: saved.metrics.taboo_count,
      contradictions_count: contradictions.length,
      contradictions_json: JSON.stringify(contradictions),
      fluff_warnings_json: JSON.stringify(fluffWarnings),
      next_questions_json: JSON.stringify(nextQuestions),
      passport_json: JSON.stringify(saved.passport),
      passport_path: paths.passport_path,
      passport_md_path: paths.passport_md_path,
      verbatim_path: paths.verbatim_path,
      brandcore_projection_path: paths.brandcore_projection_path,
      ready_to_finish:
        stopRequested ||
        nextQuestions.length === 0 ||
        saved.metrics.completeness_score >= (asStr(params.mode, "express") === "express" ? 55 : 82),
    };

    return shapeActionOut(node, baseOut);
  });

  action("passport.patch_hypothesis", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const scopeKey = asStr(params.scopeKey, "");
    const fieldPath = asStr(params.fieldPath, "positioning.core_value");
    const rawStatus = asStr(params.status, "confirmed") as ClaimStatus;
    const status: ClaimStatus = ["confirmed", "hypothesis", "unknown", "taboo"].includes(rawStatus) ? rawStatus : "confirmed";
    const value = params.value;
    const evidenceRef = asStr(params.evidenceRef, `wf:${c.workflow.id}:${c.runId.slice(0, 10)}`);
    const note = asStr(params.note, "");

    if (!isClaimFilled(value)) {
      const existing = getPassport(db, rt.projectId, scopeKey);
      return {
        applied: false,
        pending_id: "",
        completeness_score: existing?.metrics.completeness_score ?? 0,
      };
    }

    const res = patchPassportHypothesis(db, {
      projectId: rt.projectId,
      scopeKey,
      fieldPath,
      nextStatus: status,
      value,
      evidenceRef,
      note,
      allowOverrideConfirmed: params.allowOverrideConfirmed === true,
      updatedBy: c.workflow.id,
    });

    if (res.applied) {
      syncPassportCoreMemory(db, rt.projectId, res.record.passport);
      const checkout = await resolvePassportCheckout(ctx, rt);
      await writePassportCheckoutArtifacts(ctx, checkout, rt.projectId, scopeKey);
    }

    const baseOut: Row = {
      applied: res.applied,
      pending_id: res.queuedPending?.id ?? "",
      completeness_score: res.record.metrics.completeness_score,
      version: res.record.version,
    };

    return shapeActionOut(node, baseOut);
  });
}
