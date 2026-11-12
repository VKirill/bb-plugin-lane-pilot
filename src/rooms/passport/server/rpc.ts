import type { ServerCore } from "../../contracts/server";
import {
  appendVerbatim,
  computePassportMetrics,
  createEmptyPassport,
  decidePendingPassportDelta,
  detectPassportContradictions,
  detectPassportFluff,
  extractFlatPatchClaims,
  getPassport,
  listPendingPassportDeltas,
  listVerbatim,
  mergePassportPatch,
  selectNextPassportQuestions,
  upsertPassport,
} from "../index";
import { syncPassportCoreMemory, writePassportCheckoutArtifacts } from "./executors";
import { closePassportOwnerItem } from "./live-observer";

export function passportRpc(ctx: ServerCore) {
  const { db } = ctx;
  return {
    passport_get: async ({ projectId, scopeKey }: { projectId: string; scopeKey?: string | undefined }) => {
      const scope = scopeKey ?? "";
      const stored = getPassport(db, projectId, scope);
      const passport = stored?.passport ?? createEmptyPassport();
      const metrics = stored?.metrics ?? computePassportMetrics(passport);
      const verbatim = listVerbatim(db, projectId, { scopeKey: scope, limit: 25 });
      const pending = listPendingPassportDeltas(db, projectId, scope);
      const contradictions = detectPassportContradictions(passport);
      const fluffWarnings = detectPassportFluff(passport);
      const nextQuestions = selectNextPassportQuestions(passport, { mode: "deep_grill", maxQuestions: 3 });

      return {
        exists: Boolean(stored && metrics.completeness_score > 0),
        projectId,
        scopeKey: scope,
        version: stored?.version ?? 0,
        updatedAt: stored?.updated_at ?? null,
        updatedBy: stored?.updated_by ?? null,
        passport,
        passportMd: stored?.passport_md ?? "",
        metrics,
        verbatim,
        pending,
        contradictions,
        fluffWarnings,
        nextQuestions,
      };
    },

    passport_save: async ({
      projectId,
      scopeKey,
      patch,
      ownerVerbatim,
      questionAsked,
    }: {
      projectId: string;
      scopeKey?: string | undefined;
      patch: Record<string, unknown>;
      ownerVerbatim?: string | undefined;
      questionAsked?: string | undefined;
    }) => {
      const scope = scopeKey ?? "";
      const base = getPassport(db, projectId, scope)?.passport ?? createEmptyPassport();
      let evRef = "cockpit_ui";
      if (ownerVerbatim && ownerVerbatim.trim()) {
        const preview = mergePassportPatch(base, patch, { evidenceRef: "cockpit_ui" });
        const vrb = appendVerbatim(db, {
          projectId,
          scopeKey: scope,
          source: "cockpit_ui",
          questionAsked: questionAsked ?? "",
          ownerVerbatim: ownerVerbatim.trim(),
          extractedPaths: extractFlatPatchClaims(base, preview),
        });
        evRef = vrb.id;
      }
      const merged = mergePassportPatch(base, patch, { evidenceRef: evRef });
      const saved = upsertPassport(db, { projectId, scopeKey: scope, passport: merged, updatedBy: "cockpit_ui" });
      syncPassportCoreMemory(db, projectId, saved.passport);

      const cfg = await ctx.configForRun(projectId, undefined).catch(() => null);
      const checkout =
        cfg?.hostId && (cfg.pmWorkspacePath || cfg.writerWorkspacePath)
          ? { hostId: cfg.hostId, path: cfg.pmWorkspacePath || cfg.writerWorkspacePath }
          : null;
      await writePassportCheckoutArtifacts(ctx, checkout, projectId, scope);
      ctx.realtime?.notify(projectId, "rules");

      return {
        ok: true,
        version: saved.version,
        metrics: saved.metrics,
        contradictions: detectPassportContradictions(saved.passport),
      };
    },

    passport_decide: async ({
      projectId,
      deltaId,
      decision,
    }: {
      projectId: string;
      deltaId: string;
      decision: "accept" | "reject";
    }) => {
      const res = decidePendingPassportDelta(db, { projectId, deltaId, decision });
      if (res.ok) {
        closePassportOwnerItem(db, deltaId);
        if (res.updated) {
          syncPassportCoreMemory(db, projectId, res.updated.passport);
        }
        const cfg = await ctx.configForRun(projectId, undefined).catch(() => null);
        const checkout =
          cfg?.hostId && (cfg.pmWorkspacePath || cfg.writerWorkspacePath)
            ? { hostId: cfg.hostId, path: cfg.pmWorkspacePath || cfg.writerWorkspacePath }
            : null;
        await writePassportCheckoutArtifacts(ctx, checkout, projectId, res.updated?.scope_key ?? res.scopeKey ?? "");
        ctx.realtime?.notify(projectId, "rules");
      }
      return {
        ok: res.ok,
        decision,
        completeness_score: res.updated?.metrics.completeness_score ?? null,
      };
    },
  };
}
