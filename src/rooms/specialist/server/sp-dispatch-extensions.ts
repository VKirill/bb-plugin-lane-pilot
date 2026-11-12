import { sha256Hex } from "@lane-pilot/kit";
import { runOnHost } from "@lane-pilot/host-calls";
import type { StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { postOwnerItem } from "../../owner-waiting";
import { createDraftStore, upsertProjectArtifact } from "../../storage";
import { stageAndDispatchCfBatch } from "./sp-cf-adapter";
import type { OrderExecutionResult } from "./sp-dispatch-runner";

type Row = Record<string, unknown>;

const asStr = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v);

function slugifyOrder(raw: string, fallbackSuffix: string): string {
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return ascii.length >= 3 ? `${ascii}-${fallbackSuffix}` : `sp-task-${fallbackSuffix}`;
}

export async function executeCreateExtensionOrder(input: {
  ctx: ServerCore;
  c: StepContext<ChainRuntime>;
  rt: ChainRuntime;
  domain: "seo" | "marketing" | "specialist_os";
  shortHash: string;
  orderObj: Row;
  checkout: { hostId: string; path: string } | null;
  writeCheckoutFile: (
    ctx: ServerCore,
    checkout: { hostId: string; path: string } | null,
    relPath: string,
    content: string,
  ) => Promise<string>;
}): Promise<OrderExecutionResult> {
  const { ctx, c, rt, domain, shortHash, orderObj, checkout, writeCheckoutFile } = input;
  const { db } = ctx;
  const extKind = asStr(orderObj.ext_kind || orderObj.kind_of, "skill");
  const title = asStr(orderObj.title, `Extension ${extKind}`);
  const slug = asStr(orderObj.slug) || slugifyOrder(title, shortHash);

  if (extKind === "workflow") {
    const draft = createDraftStore(db).create({
      projectId: rt.projectId,
      threadId: rt.pmThreadId ?? "specialist",
      scope: "project",
      name: title.slice(0, 120),
      description: asStr(orderObj.description || orderObj.rationale || orderObj.why || title),
      workflowId: slug,
    });
    postOwnerItem(db, {
      key: `sp:ext:${draft.id}`,
      source: "specialist",
      kind: "proposal",
      projectId: rt.projectId,
      what: `Черновик нового графа от специалиста (${domain}): ${title}`,
      why: `Создан черновик ${draft.id} (${slug}) для проверки архитектором / владельцем.`,
      wake: false,
    });
    return {
      ok: true,
      disposition: "proposed",
      targetRef: draft.id,
      receipt: { kind: "create_extension", extKind, draftId: draft.id, slug },
    };
  }

  const extRel = `.agents/${domain}/extensions/${extKind}-${slug}.json`;
  const extPayload = JSON.stringify(
    {
      schema: "lp.sp-extension/1",
      ext_kind: extKind,
      domain,
      slug,
      title,
      spec: orderObj.spec ?? {},
      created_at: new Date().toISOString(),
    },
    null,
    2,
  );
  await writeCheckoutFile(ctx, checkout, extRel, extPayload);
  if (checkout) {
    upsertProjectArtifact(db, {
      projectId: rt.projectId,
      artifactId: `${domain}.ext.${extKind}.${slug}`,
      domain,
      kind: `extension_${extKind}`,
      relPath: extRel,
      sha256: sha256Hex(extPayload),
      summary: title.slice(0, 180),
      producerWf: c.workflow.id,
      producerRunId: c.runId,
    });
  }
  postOwnerItem(db, {
    key: `sp:ext:${domain}:${extKind}:${slug}`,
    source: "specialist",
    kind: "proposal",
    projectId: rt.projectId,
    what: `Предложение расширения (${extKind}): ${title}`,
    why: `Спецификация сохранена в ${extRel}`,
    wake: false,
  });
  return {
    ok: true,
    disposition: "proposed",
    targetRef: extRel,
    receipt: { kind: "create_extension", extKind, slug, path: extRel },
  };
}

export async function executeContentBatchOrder(input: {
  ctx: ServerCore;
  c: StepContext<ChainRuntime>;
  rt: ChainRuntime;
  domain: "seo" | "marketing" | "specialist_os";
  orderObj: Row;
  checkout: { hostId: string; path: string } | null;
  writeCheckoutFile: (
    ctx: ServerCore,
    checkout: { hostId: string; path: string } | null,
    relPath: string,
    content: string,
  ) => Promise<string>;
}): Promise<OrderExecutionResult> {
  const { ctx, c, rt, domain, orderObj, checkout, writeCheckoutFile } = input;
  const { db } = ctx;

  if (!orderObj.cf_batch || typeof orderObj.cf_batch !== "object") {
    return {
      ok: false,
      disposition: "blocked",
      targetRef: "missing_cf_batch",
      receipt: { kind: "content_batch" },
      blockReason: "cf_blocked:missing_cf_batch",
    };
  }
  const cfRes = stageAndDispatchCfBatch(db, { projectId: rt.projectId, rawBatch: orderObj.cf_batch });
  if (!cfRes.ok) {
    return {
      ok: false,
      disposition: "blocked",
      targetRef: cfRes.batchId,
      receipt: { kind: "content_batch", cf: cfRes },
      blockReason: `cf_blocked:${cfRes.failedGates.map((g) => g.gate).join(",")}`,
    };
  }
  const cfDomain = domain === "seo" ? "seo" : "marketing";
  const batchKey = `${cfRes.batchId}-${cfRes.batchSha256.slice(0, 8)}`;
  const manifestRel = `.agents/${cfDomain}/cf-staging/${batchKey}.json`;
  const manifestJson = JSON.stringify(orderObj.cf_batch, null, 2);
  await writeCheckoutFile(ctx, checkout, manifestRel, manifestJson);
  if (checkout) {
    upsertProjectArtifact(db, {
      projectId: rt.projectId,
      artifactId: `${cfDomain}.cf_staging.${cfRes.batchId}`,
      domain: cfDomain,
      kind: "cf_batch_manifest",
      relPath: manifestRel,
      sha256: sha256Hex(manifestJson),
      summary: `Content Factory staged batch ${cfRes.batchId}`,
      producerWf: c.workflow.id,
      producerRunId: c.runId,
    });
  }

  let cfMode: "dispatched" | "dry_run" = "dry_run";
  let cliExitCode = 127;
  if (checkout && ctx.host) {
    try {
      const quotedPath = `'${manifestRel.replace(/'/g, "'\\''")}'`;
      const hostRun = await runOnHost(ctx.host, {
        hostId: checkout.hostId,
        cwd: checkout.path,
        command: `if command -v cf >/dev/null 2>&1; then cf batch apply --manifest ${quotedPath}; else exit 127; fi`,
        timeoutSec: 30,
        timeoutMs: 35_000,
      });
      cliExitCode = hostRun.exitCode;
      if (hostRun.exitCode === 0) cfMode = "dispatched";
    } catch {
      cfMode = "dry_run";
    }
  }
  if (cfMode === "dry_run") {
    postOwnerItem(db, {
      key: `sp:cf:${cfRes.batchId}`,
      source: "specialist",
      kind: "proposal",
      projectId: rt.projectId,
      what: `Content Factory пакет подготовлен (${cfRes.batchId})`,
      why: `CLI cf не установлен на хосте (exit=${cliExitCode}); манифест сохранён в ${manifestRel}`,
      wake: false,
    });
  }
  return {
    ok: true,
    disposition: cfMode === "dispatched" ? "executed" : "proposed",
    targetRef: cfRes.batchId,
    receipt: { kind: "content_batch", mode: cfMode, manifestPath: manifestRel, cliExitCode, cf: cfRes },
  };
}
