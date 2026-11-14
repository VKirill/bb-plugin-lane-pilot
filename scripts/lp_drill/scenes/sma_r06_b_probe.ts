// Probe of scenes/sma_r06_b.py (region 6, batch b: the conversation engine, the backlog, the questions, the task words): runs the REAL code of THIS
// checkout (the commit under drill) on the scratch worlds of tests/sma/r06-world-b.ts (fake host, scratch database, temp folders, stand-in tools)
// and prints what it saw as one JSON line. It judges nothing: the scene compares every value with the node card's expected result and prove()s it.
// No model, no hub write, nothing outside the machine.
import {
  observeActivation, observeAskKinds, observeBacklogRules, observeBoardBlock, observeBoardScope, observeBook, observeBoundary, observeCadence, observeClarify, observeClose, observeHandOver,
  observeParkedQa, observeParse, observePlan, observePlanningHome, observeRead, observeScan, observeSecret, observeSpendBooked, observeSpendModel, observeTurnWatch,
  observeValidate, observeWords,
} from "../../../tests/sma/r06-world-b";

const out: Record<string, unknown> = {};
out.rules = observeBacklogRules();
out.parse = observeParse();
out.scan = await observeScan();
out.cadence = await observeCadence();
out.home = await observePlanningHome();
out.close = await observeClose();
out.handOver = await observeHandOver();
out.validate = observeValidate();
out.spendBooked = await observeSpendBooked();
out.spendModel = await observeSpendModel();
out.activation = await observeActivation();
out.turnWatch = await observeTurnWatch();
out.boardBlock = await observeBoardBlock();
out.read = await observeRead();
out.boardScope = await observeBoardScope();
out.askKinds = observeAskKinds();
out.secret = await observeSecret();
out.book = await observeBook();
out.parkedQa = await observeParkedQa();
out.plan = await observePlan();
out.words = observeWords();
out.boundary = observeBoundary();
out.clarify = await observeClarify();
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
