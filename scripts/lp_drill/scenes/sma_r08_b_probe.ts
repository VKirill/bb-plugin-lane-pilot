// Probe of scenes/sma_r08_b.py (region 8, batch b): runs the REAL functions of THIS checkout (the commit under drill) in the worlds of
// tests/sma/r08-world-b.ts (a fake plugin host, scratch databases, temp git repositories, a fixture release tree, a stand-in bb) and prints what they
// returned as one JSON line. It judges nothing: the scene compares every value with the card's expected result and prove()s it.
// No model, no hub write, nothing outside the machine. A world that threw is printed as { error } and fails only the nodes that read it.
import * as w from "../../../tests/sma/r08-world-b";

const out: Record<string, unknown> = {};
// LP_DRILL_SMA_PRIMARY_ONLY=1 (the owner's PRIMARY-only rule): a held world is never called — "worktree" (codeTreeWorktree) makes real scratch git worktrees.
const PRIMARY_ONLY_HELD = process.env.LP_DRILL_SMA_PRIMARY_ONLY === "1" ? new Set(["worktree"]) : new Set<string>();
const run = async (name: string, fn: () => unknown) => {
  if (PRIMARY_ONLY_HELD.has(name)) return;
  try { out[name] = await fn(); } catch (cause) { out[name] = { error: cause instanceof Error ? cause.message : String(cause) }; }
};

await run("peers", w.peersView);
await run("pollBoards", w.pollBoards);
await run("snapshotMemory", w.snapshotMemory);
await run("relay", w.relayAsIs);
await run("peerList", w.peerList);
await run("interview", w.interview);
await run("draft", w.draftKept);
await run("secret", w.secretRefused);
await run("needed", w.neededCases);
await run("finish", w.finishRun);
await run("homes", w.planningHomes);
await run("roots", w.planningRoots);
await run("refresh", w.settingRefresh);
await run("worktree", w.codeTreeWorktree);
await run("homeText", w.planningHomeText);
await run("presence", w.boardPresence);
await run("derived", w.boardDerived);
await run("accounts", w.accountsView);
await run("layers", w.settingsLayers);
await run("door", w.doorView);
await run("coord", w.coordRun);
await run("claims", w.claimLedger);
await run("backlog", w.backlogView);
await run("memory", w.memoryQuery);
await run("diag", w.diagnostics);
await run("stream", w.liveStream);
await run("kinds", w.eventKinds);
await run("gate", w.shipGate);
await run("lock", w.drillLock);
await run("verb", w.projectVerb);
await run("receipt", w.shipReceipt);
await run("downgrade", w.guardDowngrade);
await run("installer", w.installerRun);

process.stdout.write(`${JSON.stringify(out)}\n`);
