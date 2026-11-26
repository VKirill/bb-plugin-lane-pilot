import { sha256Hex } from "@lane-pilot/kit";
import type { StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../../contracts/server";
import { postOwnerItem } from "../../../owner-waiting";
import { createDraftStore, upsertProjectArtifact } from "../../../storage";
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
      reason: "decision",
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
    reason: "decision",
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
