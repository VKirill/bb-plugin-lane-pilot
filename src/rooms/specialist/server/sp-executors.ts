import { bestEffort, isNotFound, orMiss, sha256Hex, stringAt } from "@lane-pilot/kit";
import type { GraphNode, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { postOwnerItem } from "../../owner-waiting";
import { getPassport, patchPassportHypothesis } from "../../passport";
import { syncPassportCoreMemory } from "../../passport/server";
import { renderArtifactsManifestJson, upsertProjectArtifact, writeCasCheckoutFile } from "../../storage";
import { noteEngineWrite } from "../../verification/server";
import type { ToolTier } from "../tool-tiers";
import { registerSpCommitAndDispatchExecutors } from "./sp-commit-dispatch";
import type { SpServicesDeps } from "./sp-dispatch-runner";
import { loadSpecialistMemory } from "./sp-memory-loader";
import { applyMutationsBatch, mintApprovalNonce, type MutationItem } from "./sp-mutation";
import { triageQuestions } from "./sp-questions";
import { mapScriptOutputToDeclaredFields, runVerifiedSkillScript } from "./sp-script-runner";
import { upsertBreakerState, upsertCharter } from "./sp-store";

type Row = Record<string, unknown>;
type ActionReg = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;

const asStr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v));
const asDomain = (v: unknown): "seo" | "marketing" | "specialist_os" =>
  v === "seo" || v === "specialist_os" ? v : "marketing";

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

async function resolveCheckout(ctx: ServerCore, rt: ChainRuntime): Promise<{ hostId: string; path: string } | null> {
  return await bestEffort(
    ctx.log,
    "sp checkout resolve",
    (async () => {
      if (rt.pmThreadId) {
        const pm = await orMiss(ctx.bb.sdk.threads.get({ threadId: rt.pmThreadId }), null, isNotFound);
        const envId = stringAt(pm, "environmentId");
        const env = envId ? await orMiss(ctx.bb.sdk.environments.get({ environmentId: envId }), null, isNotFound) : null;
        const path = stringAt(env, "path");
        const hostId = stringAt(env, "hostId");
        if (path && hostId) return { hostId, path };
      }
      const proj = await orMiss(ctx.bb.sdk.projects.get({ projectId: rt.projectId }), null, isNotFound);
      const sources = Array.isArray((proj as { sources?: unknown } | null)?.sources)
        ? ((proj as { sources: Array<{ hostId?: string; path?: string }> }).sources)
        : [];
      const first = sources.find((s) => Boolean(s?.hostId && s?.path));
      return first?.hostId && first?.path ? { hostId: first.hostId, path: first.path } : null;
    })(),
    null,
  );
}

async function readCheckoutFileText(
  ctx: ServerCore,
  checkout: { hostId: string; path: string } | null,
  relOrAbs: unknown,
): Promise<string | null> {
  if (!checkout || typeof relOrAbs !== "string" || !relOrAbs.trim()) return null;
  const raw = relOrAbs.trim();
  const cleanRel = raw.startsWith(checkout.path) ? raw.slice(checkout.path.length).replace(/^\/+/, "") : raw.replace(/^\/+/, "");
  if (!cleanRel || cleanRel.includes("..") || cleanRel.includes("\0")) return null;
  return await bestEffort(
    ctx.log,
    "sp checkout read",
    (async () => {
      const file = await orMiss(
        ctx.bb.sdk.files.read({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${cleanRel}` }),
        null,
        isNotFound,
      );
      const content = file && typeof file === "object" ? (file as { content?: unknown }).content : null;
      return typeof content === "string" ? content : null;
    })(),
    null,
  );
}

async function collectScriptCheckoutFiles(
  ctx: ServerCore,
  checkout: { hostId: string; path: string } | null,
  args: Row,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!checkout) return out;
  const candidates: unknown[] = [
    args.ads,
    args.clusters,
    args.paid,
    args.organic,
    args.inventory,
    args.redirects,
    args.atoms,
    args.questions,
    args.dir,
    args.file,
    args.passport,
    args.passport_json,
    ...(Array.isArray(args.answers) ? args.answers : args.answers ? [args.answers] : []),
  ];
  for (const cand of candidates) {
    if (typeof cand !== "string" || !cand.trim()) continue;
    const key = cand.trim();
    const content = await readCheckoutFileText(ctx, checkout, key);
    if (content !== null) {
      out[key] = content;
      out[key.replace(/^\/+/, "")] = content;
    }
  }
  return out;
}

async function writeCheckoutFile(
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

/**
 * Registers all 10 deterministic Specialist OS (`sp.*`) action executors onto a `WorkflowEngine`.
 * `resolveServices` is evaluated lazily at step execution time so `server.ts` services attached later in startup (`schedules`, `backlog`) are visible.
 */
export function registerSpExecutors(
  engine: WorkflowEngine,
  ctx: ServerCore,
  deps: { action: ActionReg; resolveServices?: () => SpServicesDeps } & SpServicesDeps,
): void {
  const { db } = ctx;
  const { action, resolveServices } = deps;
  const getSpDeps = (): SpServicesDeps => {
    const live = resolveServices ? resolveServices() : {};
    return {
      ...deps,
      ...live,
      engine: live.engine ?? deps.engine ?? engine,
    };
  };

  action("sp.load_memory", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const role = asStr(params.role);
    const domain = asDomain(params.domain || (role === "seo-specialist" ? "seo" : "marketing"));
    const checkout = await resolveCheckout(ctx, rt);
    return await loadSpecialistMemory({
      ctx,
      projectId: rt.projectId,
      runId: c.runId,
      domain,
      params,
      outFields: node.out,
      checkout,
      readCheckoutFileText,
    });
  });

  action("sp.run_script", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const skill = asStr(params.skill);
    const script = asStr(params.script);
    const args = (params.args && typeof params.args === "object" ? params.args : {}) as Row;
    const timeoutSec = typeof node.timeoutSec === "number" ? node.timeoutSec : typeof params.timeoutSec === "number" ? params.timeoutSec : 90;
    const checkout = await resolveCheckout(ctx, rt);
    const domain = skill === "project-discovery-grill" ? "passport" : skill.startsWith("seo-") ? "seo" : "marketing";
    const checkoutFiles = await collectScriptCheckoutFiles(ctx, checkout, args);
    const spDeps = getSpDeps();

    const res = await runVerifiedSkillScript({
      skill,
      script,
      args,
      timeoutSec,
      mode: String(c.mode) === "sim" ? "sim" : "live",
      ...(spDeps.allowScriptFixtureFallback !== undefined ? { allowFixtureFallback: spDeps.allowScriptFixtureFallback } : {}),
      checkoutFiles,
    });
    const reportRel = `.agents/${domain}/reports/${c.workflow.id}-${node.id}.json`;
    const reportText = JSON.stringify(res.raw, null, 2);
    await writeCheckoutFile(ctx, checkout, reportRel, reportText);
    if (checkout && rt.projectId) {
      upsertProjectArtifact(db, {
        projectId: rt.projectId,
        artifactId: `${domain}.report.${c.workflow.id}.${node.id}`,
        domain,
        kind: "script_report",
        relPath: reportRel,
        sha256: sha256Hex(reportText),
        summary: `${skill}/${script} report`,
        producerWf: c.workflow.id,
        producerRunId: c.runId,
      });
      await writeCheckoutFile(ctx, checkout, ".agents/manifest.json", renderArtifactsManifestJson(db, rt.projectId));
    }
    return mapScriptOutputToDeclaredFields(script, res.raw, node.out, reportRel);
  });

  action("sp.jev_question_triage", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const domain = asDomain(params.domain);
    const checkout = await resolveCheckout(ctx, rt);
    const shadowRawJson = await readCheckoutFileText(ctx, checkout, `.agents/${domain}/questions.ext.json`);
    const triaged = triageQuestions(db, {
      projectId: rt.projectId,
      domain,
      mode: asStr(params.mode, "every_tick"),
      ...(typeof params.graphFilter === "string" ? { graphFilter: params.graphFilter } : {}),
      deltas: params.deltas,
      ...(params.context && typeof params.context === "object" ? { context: params.context as Row } : {}),
      shadowRawJson,
      ...(typeof params.maxPerJudgment === "number" ? { maxPerJudgment: params.maxPerJudgment } : {}),
      ...(typeof params.top === "number" ? { top: params.top } : {}),
      ...(typeof params.realP === "number" ? { realP: params.realP } : {}),
    });
    const out: Row = {};
    for (const f of node.out) {
      out[f.name] = (triaged as unknown as Row)[f.name] ?? (f.type === "number" ? 0 : f.type === "array" ? [] : "");
    }
    return out;
  });

  action("sp.breaker_eval", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const domain = asDomain(params.domain);
    const emergency = Boolean(params.emergencyInput === true || params.emergencyInput === "true");
    const rawSignals = Array.isArray(params.signals) ? params.signals : [params.signals];
    const triggerCodes: string[] = [];

    if (emergency) triggerCodes.push("owner_emergency_override");
    for (const sig of rawSignals) {
      const parsed = parseJsonSafe<Row>(sig, {});
      if (parsed.critical === true || parsed.verdict === "critical" || parsed.breaker_trip === true) {
        triggerCodes.push(asStr(parsed.code, "critical_telemetry_trip"));
      }
    }

    const fired = triggerCodes.length > 0;
    const row = upsertBreakerState(db, { projectId: rt.projectId, domain, fired, triggerCodes });
    if (fired) {
      postOwnerItem(db, {
        key: `sp:breaker:${rt.projectId}:${domain}`,
        source: "specialist",
        kind: "question",
        projectId: rt.projectId,
        what: `Сработал предохранитель (${domain}): ${triggerCodes.join(", ")}`,
        why: `failure_count=${row.failure_count}, новые мутации заблокированы до проверки владельцем`,
        wake: true,
      });
    }

    const stopPlan = fired ? [{ entity_id: `${domain}_active_spend`, mutation_kind: "emergency_pause", exempt_auto_cutoff: true }] : [];
    return {
      fired,
      trigger_codes: triggerCodes,
      reason: fired ? `Circuit breaker tripped: ${triggerCodes.join(", ")}` : "nominal",
      stop_plan_json: JSON.stringify(stopPlan),
    };
  });

  action("sp.charter_set", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const domain = asDomain(params.domain);
    const charterObj = parseJsonSafe<Row>(params.charter, { domain, goal: "growth" });
    const approvedBy = asStr(params.approvedBy, "owner");
    const saved = upsertCharter(db, { projectId: rt.projectId, domain, charter: charterObj, approvedBy });

    if (rt.projectId) {
      let touchedPassport = false;
      const guardrails = (charterObj.guardrails && typeof charterObj.guardrails === "object" ? charterObj.guardrails : {}) as Row;
      const ownerApproved = Boolean(approvedBy && approvedBy !== "draft");
      const maxCac = guardrails.max_cac ?? charterObj.max_cac ?? charterObj.max_cac_usd ?? charterObj.max_cac_eur;
      if (maxCac !== undefined && String(maxCac).trim() !== "") {
        patchPassportHypothesis(db, {
          projectId: rt.projectId,
          fieldPath: "economics_funnel.max_cac",
          nextStatus: ownerApproved ? "confirmed" : "hypothesis",
          value: String(maxCac),
          evidenceRef: `sp.charter_set:${domain}:v${saved.version}`,
          allowOverrideConfirmed: ownerApproved,
        });
        touchedPassport = true;
      }
      const matDays = guardrails.maturity_window_days ?? charterObj.maturity_window_days;
      if (typeof matDays === "number" && matDays > 0) {
        patchPassportHypothesis(db, {
          projectId: rt.projectId,
          fieldPath: "economics_funnel.maturity_window_days",
          nextStatus: ownerApproved ? "confirmed" : "hypothesis",
          value: matDays,
          evidenceRef: `sp.charter_set:${domain}:v${saved.version}`,
          allowOverrideConfirmed: ownerApproved,
        });
        touchedPassport = true;
      }
      const countriesRaw = Array.isArray(charterObj.primary_countries)
        ? charterObj.primary_countries
        : Array.isArray(charterObj.markets)
          ? charterObj.markets
          : [];
      if (countriesRaw.length > 0) {
        patchPassportHypothesis(db, {
          projectId: rt.projectId,
          fieldPath: "market_rails.primary_countries",
          nextStatus: ownerApproved ? "confirmed" : "hypothesis",
          value: countriesRaw.map((country) => String(country).toUpperCase()),
          evidenceRef: `sp.charter_set:${domain}:v${saved.version}`,
          allowOverrideConfirmed: ownerApproved,
        });
        touchedPassport = true;
      }
      if (touchedPassport) {
        const latest = getPassport(db, rt.projectId);
        if (latest) syncPassportCoreMemory(db, rt.projectId, latest.passport);
      }
    }

    const checkout = await resolveCheckout(ctx, rt);
    const charterRel = `.agents/${domain}/charter.json`;
    const charterText = JSON.stringify({ ...charterObj, _version: saved.version, _sha256: saved.sha256 }, null, 2);
    await writeCheckoutFile(ctx, checkout, charterRel, charterText);
    if (rt.projectId) {
      upsertProjectArtifact(db, {
        projectId: rt.projectId,
        artifactId: `${domain}.charter`,
        domain,
        kind: "charter_json",
        relPath: charterRel,
        sha256: sha256Hex(charterText),
        summary: `${domain} charter v${saved.version}`,
        producerWf: c.workflow.id,
        producerRunId: c.runId,
      });
      if (checkout) {
        await writeCheckoutFile(ctx, checkout, ".agents/manifest.json", renderArtifactsManifestJson(db, rt.projectId));
      }
    }
    return { version: saved.version, sha256: saved.sha256 };
  });

  action("sp.message_match", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const checkout = await resolveCheckout(ctx, rt);
    const threshold = typeof params.minLemmaOverlap === "number" ? params.minLemmaOverlap : 0.5;
    const mmArgs: Row = {
      ads: params.ads,
      landing: params.capture || { url: asStr(params.target), h1: asStr(params.target), title: asStr(params.target), first_screen: asStr(params.target) },
      threshold,
    };
    const checkoutFiles = await collectScriptCheckoutFiles(ctx, checkout, mmArgs);
    const spDeps = getSpDeps();
    const res = await runVerifiedSkillScript({
      skill: "mkt-landing-cro",
      script: "message_match.py",
      args: mmArgs,
      timeoutSec: 60,
      mode: String(c.mode) === "sim" ? "sim" : "live",
      ...(spDeps.allowScriptFixtureFallback !== undefined ? { allowFixtureFallback: spDeps.allowScriptFixtureFallback } : {}),
      checkoutFiles,
    });
    const reportRel = `.agents/marketing/reports/${c.workflow.id}-${node.id}.json`;
    await writeCheckoutFile(ctx, checkout, reportRel, JSON.stringify(res.raw, null, 2));
    return {
      min_score: typeof res.raw.min_score === "number" ? res.raw.min_score : 1,
      mismatches: typeof res.raw.mismatches === "number" ? res.raw.mismatches : 0,
      price_mismatch: Boolean(res.raw.price_mismatch ?? false),
      report_path: reportRel,
    };
  });

  action("sp.apply_mutation", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const tier = (params.tier === "R" || params.tier === "D" || params.tier === "S" ? params.tier : "L") as ToolTier;
    const domain = asDomain(params.domain || "marketing");
    const parsedPlan = parseJsonSafe<unknown>(params.plan, []);
    const items: MutationItem[] = Array.isArray(parsedPlan)
      ? (parsedPlan as MutationItem[])
      : parsedPlan && typeof parsedPlan === "object"
        ? [parsedPlan as MutationItem]
        : [{ entity_id: `${c.workflow.id}_entity`, mutation_kind: "live_change" }];

    let nonceToken = typeof params.nonceToken === "string" ? params.nonceToken : undefined;
    const approvalStep = asStr(params.approvalStep);
    if (!nonceToken && tier === "L" && approvalStep) {
      const stepOut = c.resolve(approvalStep) as Row | undefined;
      if (stepOut && (stepOut.answer_kind === "approve" || stepOut.approved === true)) {
        const minted = mintApprovalNonce(db, { projectId: rt.projectId, actionId: `${c.workflow.id}:${node.id}`, payload: items });
        nonceToken = minted.token;
      }
    }

    const spDeps = getSpDeps();
    const emergencyAuthorised = tier === "S" && asStr(params.authorisation) === "charter.emergency_actions";
    const sg = (params.strategyGuard && typeof params.strategyGuard === "object" ? params.strategyGuard : {}) as Row;
    const batchRes = applyMutationsBatch(db, {
      projectId: rt.projectId,
      domain,
      tier,
      items,
      ...(nonceToken ? { nonceToken, actionId: `${c.workflow.id}:${node.id}` } : {}),
      emergencyAuthorised,
      ...(typeof sg.max_step === "number" ? { maxStep: sg.max_step } : {}),
      ...(typeof sg.min_hours_between_edits === "number" ? { minHoursBetweenEdits: sg.min_hours_between_edits } : {}),
      ...(spDeps.executeMutation ? { executeMutation: spDeps.executeMutation } : {}),
      runId: c.runId,
    });

    const checkout = await resolveCheckout(ctx, rt);
    const receiptRel = `.agents/${domain}/receipts/${c.workflow.id}-${node.id}.json`;
    const receiptText = JSON.stringify(batchRes, null, 2);
    await writeCheckoutFile(ctx, checkout, receiptRel, receiptText);

    if (batchRes.mode === "staged_manual" && batchRes.staged > 0) {
      const manualRel = `.agents/${domain}/manual-mutations/${c.runId}-${node.id}.json`;
      const manualText = JSON.stringify({ workflow: c.workflow.id, runId: c.runId, domain, tier, items, mutationIds: batchRes.mutationIds }, null, 2);
      await writeCheckoutFile(ctx, checkout, manualRel, manualText);
      if (checkout && rt.projectId) {
        upsertProjectArtifact(db, {
          projectId: rt.projectId,
          artifactId: `${domain}.manual_mutation.${c.runId}.${node.id}`,
          domain,
          kind: "manual_mutation_plan",
          relPath: manualRel,
          sha256: sha256Hex(manualText),
          summary: `Staged manual mutations (${batchRes.staged} item(s))`,
          producerWf: c.workflow.id,
          producerRunId: c.runId,
        });
        await writeCheckoutFile(ctx, checkout, ".agents/manifest.json", renderArtifactsManifestJson(db, rt.projectId));
      }
      postOwnerItem(db, {
        key: `sp:mut:${c.runId}:${node.id}`,
        source: "specialist",
        kind: "question",
        projectId: rt.projectId,
        what: `План мутаций (${domain}, tier=${tier}) подготовлен вручную (${batchRes.staged} шт.)`,
        why: `Прямой внешний адаптер не подключён; проверьте и примените план из ${manualRel}`,
        wake: tier === "S",
      });
    }

    return {
      applied: batchRes.applied,
      staged: batchRes.staged,
      failed: batchRes.failed,
      mode: batchRes.mode,
      receipt_path: receiptRel,
      mutation_ids: batchRes.mutationIds,
    };
  });

  const proxyDeps: SpServicesDeps = new Proxy({} as SpServicesDeps, {
    get(_target, prop: keyof SpServicesDeps) {
      return getSpDeps()[prop];
    },
  });

  registerSpCommitAndDispatchExecutors(ctx, {
    action,
    spDeps: proxyDeps,
    resolveCheckout,
    readCheckoutFileText,
    writeCheckoutFile,
  });
}
