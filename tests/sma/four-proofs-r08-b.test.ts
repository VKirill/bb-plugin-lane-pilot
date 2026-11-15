// Region 8 · Daemon front outside the graphs, batch b — the behaviour proofs of the map nodes n704–n754 (docs/sma-evidence.md).
// The worlds are in tests/sma/r08-world-b.ts (the region scene prints the same values); each test compares them with what the card names.
import { describe, expect, it } from "vitest";
import {
  backlogView, boardDerived, boardPresence, codeTreeWorktree, coordRun, diagnostics, doorView, draftKept, drillLock, eventKinds, finishRun, installerRun, interview, liveStream, memoryQuery, neededCases,
  peerList, peersView, planningHomeText, planningHomes, planningRoots, projectVerb, relayAsIs, secretRefused, settingRefresh, settingsLayers, shipGate, shipReceipt,
} from "./r08-world-b";

describe("machines: what the hub sees of its peers (n704, n715, n713, n714)", () => {
  it("[sma:m_mc_federation] each machine BB lists becomes one snapshot with its name, whether it answers and when it was last on; a machine that is off keeps its last-seen time; no address or token of a peer is in the view", async () => {
    const v = await peersView();
    const byId = (rows: Array<{ hostId: string }>) => Object.fromEntries(rows.map((row) => [row.hostId, row])) as Record<string, Record<string, unknown>>;
    expect(byId(v.first).h1).toMatchObject({ name: "Big", online: true, lastOnlineAt: v.t0 - 600_000, answered: true });
    expect(byId(v.first).h2).toMatchObject({ name: "Mini", online: false, lastOnlineAt: null });
    expect(byId(v.second).h2).toMatchObject({ online: true, lastOnlineAt: v.t0 - 300_000 });
    expect(byId(v.third).h2).toMatchObject({ online: false, lastOnlineAt: v.t0 - 300_000 });
    expect(byId(v.third).h1).toMatchObject({ online: true, lastOnlineAt: v.t0 });
    expect(v.leaks).toEqual([]);
  });

  it("[sma:m_mc_read] the machines list is presence only: each line names the machine, says on or off, the age of its last sign and its windows; the entries carry no address or token", async () => {
    const v = await peersView();
    const byId = Object.fromEntries(v.listed.map((peer) => [peer.hostId, peer]));
    expect(byId.h1!.line).toBe("Big: на связи · окна: five_hour 40% · проекты: — · сегодня: принято 0, стоит 0, идёт 0");
    expect(byId.h2!.line).toBe("Mini: не отвечает (last seen 5 min ago) · проекты: — · сегодня: принято 0, стоит 0, идёт 0");
    for (const keys of v.keys) for (const key of keys) expect(["answered", "at", "hostId", "lastOnlineAt", "line", "name", "online", "today", "windows"]).toContain(key);
    expect(v.leaks).toEqual([]);
  });

  it("[sma:m_mc_proxy] a request for another machine goes to that machine and its answer comes back as it is: the exit code, the output and the error text are not changed, and a refusal of the peer is not swallowed", async () => {
    const r = await relayAsIs();
    expect(r.answer).toEqual({ hostId: "mac-2", exitCode: 7, stdout: "out\n", stderr: "warn: x\n" });
    expect(r.target).toBe("mac-2");
    expect(r.route).toEqual({ hostId: "mac-2", timeoutMs: 8000 });
    expect(r.thrown).toBe("peer door refused");
  });

  it("[sma:m_mc_proxy_list] what the hub can send to a machine is a closed list of named methods (jobs, commands, worktrees...), and none of the owner's word calls is on it", () => {
    const list = peerList();
    expect(list.count).toBe(75);
    expect(list.hasJobs).toBe(true);
    expect(list.hasRun).toBe(true);
    expect(list.hasOwnsBarrier).toBe(true);
    expect(list.wordsOnPeers).toEqual([]);
    expect(list.sample).toEqual(["answerPermit", "applyOnboardingPages", "closeBacklogItem"]);
  });
});

describe("the first-run interview (n716–n721)", () => {
  it("[sma:m_ob_engine] a house with no profile gets the interview: the four questions in order, an empty draft with no stored step number, and the next question is the first one not yet answered", async () => {
    const r = await interview();
    expect(r.neededFresh).toBe(true);
    expect(r.stepIds).toEqual(["goal", "writer", "quality", "words"]);
    expect(r.draftKeys).toEqual(["answers", "at", "projectId"]);
    expect(r.answersFresh).toEqual({});
    expect(r.answersLater).toEqual({ goal: "Track parcels for the shop", writer: "codex / gpt-6-luna" });
    expect(r.next).toBe("quality");
  });

  it("[sma:m_ob_steps] the four steps ask about the project, who writes, how strict the checks are and how the owner takes part; each is tied to the setting its answer fills", async () => {
    const r = await interview();
    expect(r.stepSettings).toEqual([null, "writer", "quality_mode", "owner.words"]);
    expect(r.questions).toHaveLength(4);
    expect(r.questions[0]).toBe("What is this project and what should Lane Pilot do in it first?");
    expect(r.questions[2]).toBe("How strict should the checks be: quick, standard or full?");
    expect(r.questions[3]).toContain("(sensitive, the default)");
  });

  it("[sma:m_ob_draft] each answer goes into the draft at once, trimmed and capped at 2000 characters, the earlier answers stay, and a restarted front finds them", async () => {
    const r = await draftKept();
    expect(r.goal).toBe("Ship the parcel tracker");
    expect(r.writer).toBe("codex / gpt-6-luna");
    expect(r.longLength).toBe(2000);
    expect(r.qualityLength).toBe(2000);
    expect(r.stored).toEqual(["goal", "quality", "writer"]);
  });

  it("[sma:m_ob_secret] an answer shaped like a key is refused with the reason before anything is stored, the draft stays as it was, and a plain answer naming the secret goes in", async () => {
    const r = await secretRefused();
    expect(r.refused).toBe("this answer looks like a key or a password: it is not kept; save secrets in Env Catalog and answer with their name");
    expect(r.storedAfterRefusal).toBeNull();
    expect(r.answersAfterRefusal).toEqual({});
    expect(r.plain).toEqual({ goal: "Key lives in Env Catalog as STRIPE_KEY" });
  });

  it("[sma:m_ob_needed] the interview is needed while no writer is chosen and it was never finished, and not after either", () => {
    expect(neededCases()).toEqual({ fresh: true, emptyDraft: true, writerSet: false, legacyWriter: false, finished: false });
  });

  it("[sma:m_ob_complete] finishing writes the profile through the one writer: the writer, the strictness, the owner's word mode (money, database and production deploy by default) and the goal; the house is then no longer in need of the interview", async () => {
    const r = await finishRun();
    expect(r.neededBefore).toBe(true);
    expect(r.finished).toEqual({ written: ["writer.provider", "writer.model", "quality_mode", "owner.words"], goal: true });
    expect(r.settings).toEqual({ provider: "codex", model: "gpt-6-luna", quality: "full", words: "sensitive", goal: "Track parcels for the shop" });
    expect(r.neededAfter).toBe(false);
    expect(r.doneStamped).toBe(true);
    expect(r.words).toEqual({ yes: "on", risky: "risky", money: "sensitive", no: "off" });
  });
});

describe("the project's two addresses (n722, n726, n727, n729, n730)", () => {
  it("[sma:m_pj_register] a project's second address is taken only when it is an absolute folder that is not the root, the user's home, a «..» path or inside another project; an unfit stored value reads as unset and is said once", () => {
    const r = planningHomes();
    expect(r.good).toBe("/plans/a/b");
    expect(r.bad).toEqual([null, null, null, null, null]);
    expect(r.warnedOnce).toBe(5);
    expect(r.again).toBe(5);
    expect(r.unset).toEqual([null, null, null]);
  });

  it("[sma:m_pj_planning] the planning files are read and written under the second address when there is a valid one, else under the code tree; with neither there is no root", () => {
    expect(planningRoots()).toEqual({ set: "/plans/p", unset: "/w/p", invalid: "/w/p", none: null, homeOnly: "/plans/p" });
  });

  it("[sma:m_pj_refresh] a saved setting is the value every next read sees at once, with the version moved on at each write", () => {
    const r = settingRefresh();
    expect(r.one).toEqual(["quick", 1]);
    expect(r.two).toEqual(["full", 2]);
    expect(r.read).toBe("full");
    expect(r.cas).toEqual({ ok: true, version: 3 });
    expect(r.three).toEqual(["standard", 3]);
    expect(r.generation).toBe(3);
  });

  it("[sma:m_pj_code_tree] the worker's copy is cut from the project's code tree at its head (or at the commit named) under the one worktree root, and its work is merged back into the code tree, which then loses the copy and its branch", { timeout: 120_000 }, async () => {
    const r = await codeTreeWorktree();
    expect(r.path).toBe(true);
    expect(r.branch).toBe("lane/lpattempt_c1");
    expect(r.cutIsHead).toBe(true);
    expect(r.olderIsOld).toBe(true);
    expect(r.merged).toBe("merged");
    expect(r.landedInTree).toBe("export const f = 1;");
    expect(r.worktreeGone).toBe(true);
    expect(r.branchGone).toBe(true);
  });

  it("[sma:m_pj_planning_home] the roadmap and the requirements the discussion reads are under .agents/planning, the phase's own files under .agents/phases; with a second address set the same paths point into it, without one they stay byte for byte, and a task's folder never moves", () => {
    const r = planningHomeText();
    expect(r.unset).toEqual([".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", ".agents/phases/ph_1/DISCUSSION.md"]);
    expect(r.inHome).toEqual(["/plans/g5/.agents/planning/ROADMAP.md", "/plans/g5/.agents/planning/REQUIREMENTS.md", "/plans/g5/.agents/phases/ph_1/DISCUSSION.md"]);
    expect(r.byteForByte).toBe(true);
    expect(r.items).toBe(".agents/plans/items/t1/PLAN.md");
    expect(r.plans).toBe("read /plans/g5/.agents/plans/2026-11-01-x.md and /plans/g5/.agents/todos/items/t1");
    expect(r.allUnderAgents).toBe(true);
  });
});

describe("the board, the rules, the door, coordination, backlog, diagnostics and the stream (n731–n743)", () => {
  it("[sma:m_rd_presence] each task is said in words the window prints as it is: free in the queue, waiting for named tasks, writing, checking", () => {
    expect(boardPresence()).toEqual({
      free: { column: "queued", phase: "queued", waitingFor: [] },
      waits: { column: "queued", phase: "waiting", waitingFor: ["ck-1", "ck-2"] },
      works: { column: "running", phase: "writing", waitingFor: [] },
      checks: { column: "checking", phase: "checking", waitingFor: [] },
    });
  });

  it("[sma:m_rd_state] the board is derived afresh from the attempts, their stage receipts and the clock each time it is asked: done, canceled, blocked, stuck and retrying are told apart, a change shows at the next read, and no board is stored", () => {
    const r = boardDerived();
    expect(r.first).toEqual({ move: "queued/queued", fresh: "running/retrying", blk: "blocked/blocked", can: "done/canceled", acc: "done/accepted", stuck: "blocked/stuck" });
    expect(r.second).toEqual({ ...r.first, move: "running/writing" });
    expect(r.boardTables).toEqual([]);
  });

  it("[sma:m_rd_rules] the rules are the settings as written: the hub's value for a project that wrote none, the project's over the hub's, a section's over the project's, and the hub's own list is only its own", () => {
    const r = settingsLayers();
    expect(r.project).toEqual({ quality_mode: "full", "writer.provider": "global-writer" });
    expect(r.inSection).toEqual({ quality_mode: "quick", "writer.provider": "global-writer", "owner.words": "on" });
    expect(r.other).toEqual({ quality_mode: "standard", "writer.provider": "global-writer" });
    expect(r.global).toEqual({ quality_mode: "standard", "writer.provider": "global-writer" });
  });

  it("[sma:m_rd_remote] who can see the door: the public address when one is set, else the hub itself, how the hub is reached, and the machines as the lines of the machines list, with no address or token", async () => {
    const r = await doorView();
    expect(r.bare).toBe("the BB hub");
    expect(r.named).toBe("https://hub.example.org");
    expect(r.reachedOver).toBe("WireGuard (no public bb connect)");
    expect(r.sameAsPeers).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.lines.some((line) => line.startsWith("Big: на связи"))).toBe(true);
    expect(r.leaks).toEqual([]);
  });

  it("[sma:m_rd_coord] the window asks the terminal coordination in the run's own checkout on the run's machine, gets its answer capped at 20000 characters (or its error text, capped at 2000, when it said nothing), and a run without a checkout is refused", async () => {
    const r = await coordRun();
    expect(r.statusCall).toEqual({ method: "runCommand", input: { requestedHostId: "h1", command: "lane-coord status", cwd: "/ws/p", timeoutSec: 20 }, options: { hostId: "h1", timeoutMs: 25_000 } });
    expect(r.statusOutputLength).toBe(20_000);
    expect(r.quietOutput).toBe(2000);
    expect(r.quietIsStderr).toBe(true);
    expect(r.noCheckout).toBe("run nope has no checkout");
  });

  it("[sma:m_rd_clear_claim] a claim is cleared only with a reason: a call without one, an empty one, two letters or blanks is refused; with one the command carries the session and the reason, stripped of anything that could break out of the quotes", async () => {
    const r = await coordRun();
    expect(r.refused).toEqual({ missing: true, empty: true, short: true, spaces: true, good: true });
    expect(r.clearCall).toEqual({ method: "runCommand", input: { requestedHostId: "h1", command: "lane-coord force-clear 'sessAxy' --reason 'stale claim of a gone session'", cwd: "/ws/p", timeoutSec: 20 }, options: { hostId: "h1", timeoutMs: 25_000 } });
    expect(r.cleared).toEqual({ exitCode: 0, output: "cleared" });
  });

  it("[sma:m_rd_backlog] the ready items are sorted into what can be issued (urgency, then size), what needs an estimate, what is above 13 and must be split, and what waits for an item that is not done; an item with one done and one open dependency still waits", () => {
    expect(backlogView()).toEqual({ issuable: ["b", "a", "h", "c"], needsEstimate: ["d"], decompose: ["e"], blocked: ["f", "g"] });
  });

  it("[sma:m_rd_search] one query returns the project's notes, the cold notes an idle spell put aside, the past tasks like it with how they ended, and says plainly when there is nothing (and records the miss); a memory that is off answers skipped, and a run that is not this PM's is refused", async () => {
    const r = await memoryQuery();
    expect(r.active).toEqual({ state: "passed", context: expect.stringContaining("Greeting cards render their share button through components/cards/share.ts"), recordIds: [expect.any(String)], noteStored: true, nothing: false });
    expect(r.active.context).not.toContain("Memory has nothing relevant");
    expect(r.episode.context).toBe("Memory has nothing relevant to this query. Do not assume or invent project facts; read the code or ask the owner.\n\nPast tasks like this one (what happened):\n- refund-flow «Refund approval screen» (" + r.episode.context.match(/\((\d{4}-\d{2}-\d{2})\)/)![1] + "): validation_failed — verification failed (npm test): refund total wrong");
    expect(r.episode.episodes).toBe(1);
    expect(r.cold.context).toContain("Notes from the cold tier (still expired; a write decides whether they come back):\n- Kubernetes ingress certificates live in deploy/ingress.yaml");
    expect(r.cold.promotedFromCold).toBe(1);
    expect(r.nothing).toEqual({ state: "passed", nothingRelevant: true, misses: ["quantum teleportation licensing"] });
    expect(r.off).toEqual({ runId: "run1", state: "skipped", reason: "memory_disabled" });
    expect(r.foreign).toBe("runId does not belong to this Lane Pilot PM thread");
  });

  it("[sma:m_rd_diag] the manifest carries the version, the platform, the OS release, the node version and the number of unknown codes of the last 14 days (an older one is left out), and nothing of the machine's environment or paths", () => {
    const r = diagnostics();
    expect(r.keys).toEqual(["builtAt", "name", "node", "osRelease", "platform", "tables", "unknownCodes", "version"]);
    expect(r.unknownCodes).toBe(3);
    expect(r.platform).toBe(true);
    expect(r.node).toBe(true);
    expect(r.leaks).toEqual([]);
  });

  it("[sma:m_rd_hub] a burst of changes reaches the open screens as one signal per thing within the window, naming only what to re-read (a kind, a thread, a run or a draft), nothing is sent without a project, a bus that fails is logged once", { timeout: 30_000 }, async () => {
    const r = await liveStream();
    expect(r.inWindow).toBe(0);
    expect(r.burst).toEqual([
      { channel: "lp:p1", payload: { kind: "council", threadId: "thr1" } },
      { channel: "lp:p1", payload: { kind: "rules", threadId: "thr1" } },
      { channel: "lp:p2", payload: { kind: "council" } },
      { channel: "lp:p1", payload: { kind: "workflow", threadId: "thr2", runId: "run-9" } },
      { channel: "lp:p1", payload: { kind: "workflow-draft", draftId: "draft-3" } },
    ]);
    expect(r.logged).toEqual(["Lane Pilot realtime publish failed: bus down"]);
  });

  it("[sma:m_rd_event_types] the signal kinds are a closed list (helpers, council, rules, workflow, workflow-draft, schedule, harness); a signal of another kind or without one is not taken, and only the known fields of a good one are kept", () => {
    const r = eventKinds();
    expect(r.kinds).toEqual(["helpers", "council", "rules", "workflow", "workflow-draft", "schedule", "harness"]);
    expect(r.parsed).toEqual(r.kinds);
    expect([r.unknown, r.noKind, r.nothing]).toEqual([null, null, null]);
    expect(r.carried).toEqual({ kind: "workflow", threadId: "t1", runId: "r1" });
    expect(r.notStrings).toEqual({ kind: "workflow" });
  });
});

describe("ship and update (n747–n750, n754)", () => {
  it("[sma:m_sh_gate] the gate runs the build, freshness, the package check, the licenses, the doc audit and the prediction lint in that order: a clean tree passes all six, and a promise in the changelog stops it at the last step with the earlier ones printed", { timeout: 300_000 }, () => {
    const r = shipGate();
    expect(r.cleanStatus).toBe(0);
    expect(r.cleanLast).toBe("gate: build, freshness, publishable, licenses, doc-audit and predict-lint all clean");
    expect(r.promiseStatus).toBe(1);
    const lines = r.promiseOut.trim().split("\n");
    expect(lines.slice(1)).toEqual([
      "publishable: 0.1.1", "license ledger: 0 production dependencies, all named", "doc honesty: 1 documents agree with the code",
      "CHANGELOG 0.1.1: «- everything is faster now» promises an effect without saying how it is measured", "gate: predict-lint failed",
    ]);
  });

  it("[sma:m_sh_receipt] publishing needs the receipt of a green full run kept on disk for this exact tree and this node version: without it, with one of another node version, and after the tree changed, the package is not publishable; with it it is", { timeout: 300_000 }, () => {
    const r = shipReceipt();
    expect(r.withReceipt).toEqual([0, "publishable: 0.1.1"]);
    expect(r.without).toEqual([1, true]);
    expect(r.otherNode).toEqual([1, true]);
    expect(r.changedTree).toEqual([1, true]);
    expect(r.restamped).toEqual([0, "publishable: 0.1.1"]);
    expect(r.onDisk).toBe(true);
  });

  it("[sma:m_sh_busy] a drill lock held by a live process is not taken by a second run; a lock left by a process that is gone, an empty lock and a free place are taken", { timeout: 60_000 }, async () => {
    const r = await drillLock();
    expect(r.live).toBe("False");
    expect(r.liveStillHeldBy).toBe(true);
    expect(r.dead).toBe("True");
    expect(r.noPid).toBe("True");
    expect(r.fresh).toBe("True");
    expect(r.freshHasPid).toBe(true);
  });

  it("[sma:m_sh_verbs] the project's command runs as a process of its own in the project's folder: its output, its error text and its exit code come back, a command that outlives its limit is killed and reported with exit 1, and setup or --apply are refused", { timeout: 60_000 }, async () => {
    const r = await projectVerb();
    expect(r.hostId).toBe("h9");
    expect(r.exitCode).toBe(3);
    expect(r.ownTree).toBe(true);
    expect(r.separate).toBe(true);
    expect(r.stderr).toBe("oops");
    expect(r.slowExit).toBe(1);
    expect(r.slowStderr).toContain("killed by SIGTERM");
    expect(r.refused).toBe("refusing host command: --apply/setup are forbidden in Mode 2");
  });

  it("[sma:m_up_apply] the window's installer runs only on the owner's explicit yes, on the project's own machine; the receipt is kept, and a machine that refuses leaves the last good receipt as it was", async () => {
    const r = await installerRun();
    expect(r.blockedStatus).toBe("blocked");
    expect(r.receiptBlocked).toBeNull();
    expect(r.installsAfterBlock).toBe(0);
    expect(r.ok).toEqual({ schemaVersion: 1, action: "install", status: "ok", native: { status: "enabled", hostId: "host-i" } });
    expect(r.saved).toEqual(r.ok);
    expect(r.installs).toEqual(["host-i", "host-i"]);
    expect(r.failed).toBe("machine refused the install");
    expect(r.keptSame).toBe(true);
    expect(r.unbound).toBe("Lane Pilot prototype is not configured for this project");
  });
});
