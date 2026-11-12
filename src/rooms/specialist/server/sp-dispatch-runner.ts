import { sha256Hex } from "@lane-pilot/kit";
import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { postOwnerItem, rpcLine } from "../../owner-waiting";
import { upsertProjectArtifact, writeCasCheckoutFile } from "../../storage";
import { noteEngineWrite } from "../../verification/server";
import { executeDirectApiOrder } from "./sp-dispatch-direct";
import { executeContentBatchOrder, executeCreateExtensionOrder } from "./sp-dispatch-extensions";
import type { MutationExecutorFn } from "./sp-mutation";

type Row = Record<string, unknown>;

export type OrderDisposition = "executed" | "proposed" | "waiting_owner" | "blocked";

export interface OrderExecutionResult {
  ok: boolean;
  disposition: OrderDisposition;
  targetRef: string;
  receipt: Row;
  blockReason?: string;
}

export interface SpSchedulePort {
  list?: (projectId?: string) => unknown;
  save: (
    raw: {
      id?: string;
      projectId: string;
      name: string;
      description?: string;
      task: { kind: "workflow"; workflowId: string; inputs?: Record<string, unknown>; liveTrial?: boolean };
      when: { type: "cron"; cron: string; timezone?: string };
    },
    by: string,
  ) => unknown;
}

export interface SpBacklogPort {
  scan: (now?: number) => Promise<unknown>;
}

export interface SpServicesDeps {
  engine?: WorkflowEngine;
  schedules?: SpSchedulePort;
  backlog?: SpBacklogPort;
  phaseIntake?: unknown;
  planHome?: (projectId: string, checkout: { hostId: string; path: string }) => Promise<string | null>;
  executeMutation?: MutationExecutorFn;
  allowScriptFixtureFallback?: boolean;
}

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

export async function executeSpecialistOrder(input: {
  ctx: ServerCore;
  deps: SpServicesDeps;
  c: StepContext<ChainRuntime>;
  rt: ChainRuntime;
  domain: "seo" | "marketing" | "specialist_os";
  sourceGraph: string;
  intentRow: {
    intent_id: string;
    idem_key: string;
    order_kind: string;
    order_json: string;
  };
  orderObj: Row;
  checkout: { hostId: string; path: string } | null;
  writeCheckoutFile: (
    ctx: ServerCore,
    checkout: { hostId: string; path: string } | null,
    relPath: string,
    content: string,
  ) => Promise<string>;
}): Promise<OrderExecutionResult> {
  const { ctx, deps, c, rt, domain, sourceGraph, intentRow, orderObj, checkout, writeCheckoutFile } = input;
  const { db } = ctx;
  const logicalKind = asStr(orderObj.kind, intentRow.order_kind);
  const shortHash = sha256Hex(`${intentRow.intent_id}:${intentRow.idem_key}`).slice(0, 8);

  // 1. `schedule`: create/update real recurring schedule in ScheduleService (`G-01` + `ASTRA-F-010`).
  if (logicalKind === "schedule") {
    const workflowId = asStr(orderObj.workflow || orderObj.workflow_id || orderObj.targetWorkflowId, "sp-specialist-tick");
    const cron = asStr(orderObj.cron, "0 9 * * *");
    const wfInputs =
      (orderObj.inputs && typeof orderObj.inputs === "object"
        ? (orderObj.inputs as Row)
        : orderObj.workflow_inputs && typeof orderObj.workflow_inputs === "object"
          ? (orderObj.workflow_inputs as Row)
          : {}) ?? {};
    const scheduleName = asStr(orderObj.schedule_name || `sp:${domain}:${workflowId}`).slice(0, 120);
    if (deps.schedules) {
      let existingId: string | undefined;
      if (typeof deps.schedules.list === "function") {
        const listed = await Promise.resolve(deps.schedules.list(rt.projectId));
        if (Array.isArray(listed)) {
          const found = listed.find(
            (item) => item && typeof item === "object" && (item as Row).projectId === rt.projectId && (item as Row).name === scheduleName,
          ) as { id?: string } | undefined;
          if (typeof found?.id === "string" && found.id) existingId = found.id;
        }
      }
      const saved = (await Promise.resolve(
        deps.schedules.save(
          {
            ...(existingId ? { id: existingId } : {}),
            projectId: rt.projectId,
            name: scheduleName,
            description: asStr(orderObj.title, `Specialist schedule (${domain})`),
            task: { kind: "workflow", workflowId, inputs: wfInputs, liveTrial: true },
            when: { type: "cron", cron },
          },
          `specialist:${intentRow.idem_key.slice(0, 16)}`,
        ),
      )) as { ok?: boolean; id?: string; error?: unknown; problems?: unknown; schedule?: { id?: string } } | undefined;
      if (!saved || saved.ok === false || Boolean(saved.error)) {
        return {
          ok: false,
          disposition: "blocked",
          targetRef: scheduleName,
          receipt: { kind: "schedule", scheduleName, workflowId, cron, response: saved ?? null },
          blockReason: "schedule_save_failed",
        };
      }
      const schedId = asStr(saved.schedule?.id ?? saved.id, scheduleName);
      return {
        ok: true,
        disposition: "executed",
        targetRef: schedId,
        receipt: { kind: "schedule", scheduleId: schedId, workflowId, cron },
      };
    }
    postOwnerItem(db, {
      key: `sp:intent:${intentRow.intent_id}`,
      source: "specialist",
      kind: "question",
      projectId: rt.projectId,
      what: `Расписание специалиста (${scheduleName}: ${cron}) требует подключения ScheduleService`,
      why: asStr(orderObj.title),
      wake: false,
    });
    return {
      ok: true,
      disposition: "waiting_owner",
      targetRef: scheduleName,
      receipt: { kind: "schedule", mode: "owner_fallback", workflowId, cron },
    };
  }

  // 2. `sub_graph`: start child workflow via `engine.resolveWorkflow` + `engine.start` (`ASTRA-F-010`).
  if (logicalKind === "sub_graph") {
    const workflowId = asStr(orderObj.workflow || orderObj.workflow_id || orderObj.targetWorkflowId);
    const providedInputs =
      (orderObj.inputs && typeof orderObj.inputs === "object"
        ? (orderObj.inputs as Row)
        : orderObj.workflow_inputs && typeof orderObj.workflow_inputs === "object"
          ? (orderObj.workflow_inputs as Row)
          : {}) ?? {};
    if (!workflowId || !deps.engine) {
      return {
        ok: false,
        disposition: "blocked",
        targetRef: workflowId || "sub_graph",
        receipt: { kind: "sub_graph", workflowId, status: "unresolved_workflow" },
        blockReason: "unresolved_workflow",
      };
    }
    const wf = deps.engine.resolveWorkflow(workflowId);
    if (!wf) {
      return {
        ok: false,
        disposition: "blocked",
        targetRef: workflowId,
        receipt: { kind: "sub_graph", workflowId, status: "unresolved_workflow" },
        blockReason: "unresolved_workflow",
      };
    }
    const missingRequired = wf.inputs
      .filter((f) => f.required && f.default === undefined && (providedInputs[f.name] === undefined || providedInputs[f.name] === ""))
      .map((f) => f.name);
    if (missingRequired.length > 0) {
      postOwnerItem(db, {
        key: `sp:intent:${intentRow.intent_id}`,
        source: "specialist",
        kind: "question",
        projectId: rt.projectId,
        what: `Запуск подграфа ${workflowId}: укажите входные параметры (${missingRequired.join(", ")})`,
        why: asStr(orderObj.title),
        wake: false,
      });
      return {
        ok: true,
        disposition: "waiting_owner",
        targetRef: workflowId,
        receipt: { kind: "sub_graph", workflowId, status: "queued_missing_inputs", missingInputs: missingRequired },
      };
    }
    const started = deps.engine.start({
      workflow: wf,
      inputs: providedInputs,
      key: `sp-sub:${intentRow.idem_key}`,
      runtime: rt,
      mode: c.mode,
      parent: { runId: c.runId, stepKey: c.stepKey },
      link: { projectId: rt.projectId, ...(rt.runId ? { runId: rt.runId } : {}) },
    });
    return {
      ok: true,
      disposition: "executed",
      targetRef: started.runId,
      receipt: { kind: "sub_graph", workflowId, childRunId: started.runId, reused: !started.created },
    };
  }

  // 3. `direct_api`: dedicated API execution via tool-tier & mutation guard (`ASTRA-F-010`).
  if (logicalKind === "direct_api") {
    return executeDirectApiOrder({ ctx, deps, c, rt, domain, sourceGraph, intentRow, orderObj });
  }

  // 4. `code_task`: write `.agents/todos/items/<slug>/{meta.yaml,README.md}` via CAS + trigger `backlog.scan()`.
  if (logicalKind === "code_task") {
    const title = asStr(orderObj.title, "Specialist code task");
    const slug = asStr(orderObj.slug) || slugifyOrder(title, shortHash);
    if (checkout) {
      const home = deps.planHome ? await deps.planHome(rt.projectId, checkout) : null;
      const rootPath = home ?? checkout.path;
      const itemDir = `.agents/todos/items/${slug}`;
      const ownsPaths = Array.isArray(orderObj.owns_paths)
        ? orderObj.owns_paths.map(String)
        : Array.isArray(orderObj.target_paths)
          ? orderObj.target_paths.map(String)
          : [];
      const acceptance = Array.isArray(orderObj.acceptance)
        ? orderObj.acceptance.map(String)
        : Array.isArray(orderObj.acceptance_criteria)
          ? orderObj.acceptance_criteria.map(String)
          : [];
      const metaYaml =
        [
          "status: ready",
          "priority: normal",
          "estimate: 2",
          `source: specialist-${domain}`,
          `created_at: "${new Date().toISOString()}"`,
          ...(ownsPaths.length ? ["owns_paths:", ...ownsPaths.map((p) => `  - "${p.replace(/"/g, '\\"')}"`)] : []),
        ].join("\n") + "\n";
      const readmeMd = [
        `# ${title}`,
        "",
        `- **Domain**: \`${domain}\``,
        `- **Source workflow**: \`${sourceGraph}\``,
        `- **Reason code**: \`${asStr(orderObj.reason_code, "general")}\``,
        "",
        asStr(orderObj.description || orderObj.rationale || orderObj.summary || title),
        ...(acceptance.length ? ["", "## Acceptance Criteria", ...acceptance.map((a) => `- ${a}`)] : []),
        "",
      ].join("\n");

      for (const [relFile, content] of [
        [`${itemDir}/meta.yaml`, metaYaml],
        [`${itemDir}/README.md`, readmeMd],
      ] as const) {
        if (!home) noteEngineWrite(checkout.path, relFile);
        const casRes = await writeCasCheckoutFile(ctx.bb.sdk.files as never, {
          hostId: checkout.hostId,
          rootPath,
          relPath: relFile,
          content,
        });
        if (!casRes.ok) {
          return {
            ok: false,
            disposition: "blocked",
            targetRef: relFile,
            receipt: { kind: "code_task", slug, outcome: casRes.outcome },
            blockReason: `code_task_write_${casRes.outcome}`,
          };
        }
      }
      if (!home) {
        upsertProjectArtifact(db, {
          projectId: rt.projectId,
          artifactId: `todos.item.${slug}`,
          domain: "todos",
          kind: "backlog_item",
          relPath: `${itemDir}/README.md`,
          sha256: sha256Hex(readmeMd),
          summary: title.slice(0, 180),
          producerWf: c.workflow.id,
          producerRunId: c.runId,
        });
      }
      await deps.backlog?.scan();
      return {
        ok: true,
        disposition: "executed",
        targetRef: `${itemDir}/README.md`,
        receipt: { kind: "code_task", slug, path: itemDir, scanned: Boolean(deps.backlog) },
      };
    }
    postOwnerItem(db, {
      key: `sp:intent:${intentRow.intent_id}`,
      source: "specialist",
      kind: "question",
      projectId: rt.projectId,
      what: `Задача на код от специалиста (${domain}): ${title}`,
      why: "В проекте не привязан checkout для автоматической записи в .agents/todos/items",
      wake: false,
    });
    return { ok: true, disposition: "waiting_owner", targetRef: slug, receipt: { kind: "code_task", slug, mode: "owner_fallback" } };
  }

  // 5. `specialist_handoff`: start `"agent-routine"` via `engine.start` (or write handoff brief on checkout if isolated).
  if (logicalKind === "specialist_handoff") {
    const rawRole = asStr(orderObj.to_role || orderObj.agent_id, "copy-lead");
    const agentId = rawRole.replace(/^specialist:/, "");
    const task = asStr(orderObj.task || orderObj.brief || orderObj.description || orderObj.title);
    const scheduleName = asStr(orderObj.schedule_name, `sp-handoff:${domain}->${agentId}`);
    const runKey = `sp-handoff:${intentRow.idem_key}`;
    const wf = deps.engine?.resolveWorkflow("agent-routine");
    if (wf && deps.engine) {
      try {
        const started = deps.engine.start({
          workflow: wf,
          inputs: { agentId, task, scheduleName, runKey },
          key: runKey,
          runtime: rt,
          mode: c.mode,
          parent: { runId: c.runId, stepKey: c.stepKey },
          link: { projectId: rt.projectId, ...(rt.runId ? { runId: rt.runId } : {}) },
        });
        return {
          ok: true,
          disposition: "executed",
          targetRef: started.runId,
          receipt: { kind: "specialist_handoff", agentId, childRunId: started.runId },
        };
      } catch {
        // Degrade cleanly to owner waiting card when isolated test engine lacks `lp.agent_brief` executor.
      }
    }
    postOwnerItem(db, {
      key: `sp:intent:${intentRow.intent_id}`,
      source: "specialist",
      kind: "question",
      projectId: rt.projectId,
      what: `Передача задачи специалисту ${agentId}: ${asStr(orderObj.title)}`,
      why: task.slice(0, 300),
      wake: false,
    });
    return {
      ok: true,
      disposition: "waiting_owner",
      targetRef: agentId,
      receipt: { kind: "specialist_handoff", agentId, mode: "owner_fallback" },
    };
  }

  // 6. `create_extension`: creates a draft workflow or extension specification proposal (`disposition: "proposed"`).
  if (logicalKind === "create_extension") {
    return executeCreateExtensionOrder({ ctx, c, rt, domain, shortHash, orderObj, checkout, writeCheckoutFile });
  }

  // 7. `content_batch`: Content Factory preflight gates + `cf` CLI when installed (`executed` vs `proposed`).
  if (logicalKind === "content_batch") {
    return executeContentBatchOrder({ ctx, c, rt, domain, orderObj, checkout, writeCheckoutFile });
  }

  // 8. `owner_gate` / `owner_escalate` / fallback: post actionable card (`disposition: "waiting_owner"`).
  const itemKey = `sp:intent:${intentRow.intent_id}`;
  const what = asStr(orderObj.question || orderObj.title, "Решение для специалиста");
  const why = asStr(orderObj.why || orderObj.description || `Граф ${sourceGraph} (${domain}), причина: ${asStr(orderObj.reason_code)}`);
  postOwnerItem(db, {
    key: itemKey,
    source: "specialist",
    kind: "question",
    projectId: rt.projectId,
    what,
    why,
    wake: true,
    actions: [
      {
        id: "read",
        label: "Принято",
        cli: rpcLine("owner_waiting_close", { key: itemKey }),
        rpc: { method: "owner_waiting_close", input: { key: itemKey } },
      },
    ],
  });
  return {
    ok: true,
    disposition: "waiting_owner",
    targetRef: itemKey,
    receipt: { kind: logicalKind, ownerItemKey: itemKey, wake: true },
  };
}
