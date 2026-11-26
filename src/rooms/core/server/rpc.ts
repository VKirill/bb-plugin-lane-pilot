import { roomRpcHandlers } from "../../registry";
import { runsRpc } from "../../runs/server";
import { stackRpc } from "../../native-install/server";
import { workspaceProviderRpc } from "../../native-agent/server";
import { chatAgentRpc } from "./rpc-chat-agent";
import { workflowExportRpc, workflowsRpc, workflowOpsRpc, createWorkflowArchitect, architectStartRpc } from "../../workflow/server";
import { schedulesRpc } from "../../schedule/server";
import { memoryProbeRpc } from "./rpc-memory-probe";
import { deferralRpc } from "../../deferral/server";
import { rollbackRpc } from "../../rollback/server";
import { ownerWaitingRpc } from "../../owner-waiting/server";
import { errandsRpc } from "../../errands/server";
import { stageReturnRpc } from "../../stage-return/server";
import { workGraphRpc } from "../../work-graph/server";
import { sessionMemoryRpc } from "../../memory/server";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { Services } from "../../services";

import { handleDirectoryMove } from "../../native-agent/server";
import type { rpcContract } from "./plugin-contracts";
import type { ServerCore } from "../../contracts/server";

import { recordTaskWord, waitingAttemptId } from "../../tasks/server";

import { LP_EVENTS, taskFamily } from "@lane-pilot/contracts";
import { insertInboxEvent } from "@lane-pilot/workflow-engine";

import { budgetSpentSweep } from "../../writer/server";
import { OWNER_ITEM_SWEEPS } from "../../lead/server";

import { tokenCursorRow } from "../../usage/server";

import { postEvent, uiVersion } from "../../relay/server";

import { conveyorState, setConveyor } from "../../runs/server";

import { timeRpcHandlers } from "./rpc-timing";

import { invalidateRpcTags } from "../../platform/server";

/** The sweeps «waiting for the owner» collects over: shared by the RPC read and the five-minute bell (SMA m_ws_notify). */
export const ownerItemSweeps = (services: Services) => [...OWNER_ITEM_SWEEPS, budgetSpentSweep(services)];

type RpcHandlers = PluginRpcHandlers<typeof rpcContract>;

export function registerRpc(ctx: ServerCore, services: Services, contract: typeof rpcContract) {
  const ownerSweeps = ownerItemSweeps(services);
  // Every call is timed (rpc-timing.ts). No caller check: every machine and every caller is the owner's (owner decision 2026-10-08).
  const own = {
    experimental_vk_directory_move: (input) => handleDirectoryMove({ bb: ctx.bb, db: ctx.db, loadParked: services.stability.loadParked }, input),
    ...runsRpc(ctx, services),
    ...stackRpc(ctx),
    ...workspaceProviderRpc(ctx),
    ...chatAgentRpc(ctx),
    ...workflowsRpc(ctx, services),
    ...workflowExportRpc(ctx, services),
    ...workflowOpsRpc(ctx, services),
    ...schedulesRpc(ctx, services),
    ...memoryProbeRpc(services),
    ...deferralRpc(services.deferrals),
    ...rollbackRpc(services.rollback),
    ...ownerWaitingRpc(ctx.db, ownerSweeps, (message) => ctx.log(message), postEvent,
      () => invalidateRpcTags(ctx.bb, ["owner_waiting"])),
    ...errandsRpc(ctx, services),
    ...stageReturnRpc(services.stageReturn),
    ...workGraphRpc(ctx, { tokenCursorRow }),
    task_word: async ({ runId, taskId, decision, text }: { runId: string; taskId: string; decision: "yes" | "no"; text: string }) => {
      const family = taskFamily(taskId);
      // The first press claims the decision (SMA tr_approving): the second presser loses.
      const waiting = waitingAttemptId(ctx.db, runId, family) ?? null;
      const claim = services.taskWords.decide(ctx.db, runId, family, decision, "screen", Date.now(), waiting);
      if (!claim.ok) return { ok: false as const, reason: claim.reason };
      await recordTaskWord(ctx.bb.storage.kv as never, runId, family, decision, text, Date.now(), waiting);
      services.taskWords.answer(ctx.db, runId, family, decision, text, "screen");
      if (waiting) {
        const payload = { kind: "owner_word", decision, text, runId, taskId, attemptId: waiting };
        try { insertInboxEvent(ctx.db, { id: `evt_word_${Date.now()}`, name: LP_EVENTS.WRITER_ANSWERED, key: waiting, payload, createdAt: Date.now() }); } catch { /* ignore */ }
        await services.workflowEngine?.wake(LP_EVENTS.WRITER_ANSWERED, waiting, payload).catch(() => undefined);
      }
      return { ok: true as const };
    },
    ui_version: async () => ({ version: uiVersion() }),
    money_status: async () => services.money.status(),
    conveyor: async ({ set, reason }: { set?: "on" | "off"; reason?: string }) => set ? await setConveyor(ctx.bb.storage.kv as never, set === "on", reason) : await conveyorState(ctx.bb.storage.kv as never),
    ...sessionMemoryRpc(ctx, services),
    ...createWorkflowArchitect(ctx, services).rpc,
    ...architectStartRpc(ctx, services),
  } satisfies Partial<RpcHandlers>;
  const handlers = { ...own, ...roomRpcHandlers(ctx, services) } as Record<string, unknown> as RpcHandlers;
  // The contract type no longer proves every key has a handler once rooms add theirs, so the start does.
  const missing = Object.keys(contract).filter((key) => !(key in handlers));
  if (missing.length) throw new Error(`rpc keys without a handler: ${missing.join(", ")}`);
  ctx.bb.rpc.register(contract, timeRpcHandlers(handlers, (message) => ctx.bb.log.debug(message)));
}
