// Region 0 (Phase graph), batch a: the discussion and the plan admission cards (n0 … n29). Every test runs the real code of the node through
// tests/sma/r00-world-a.ts (the same observations the scene scripts/lp_drill/scenes/sma_r00_a.py proves) and checks the result the card names.
import { describe, expect, it } from "vitest";
import { observe } from "./r00-world-a";

const NO_DOCS = "no context documents: write the discussion (decisions, FAQ, ADR) to files in the project and name them";
const NO_APPETITE = "no appetite: say how much this phase may take before any solution (time or size)";
const NO_GOS = "no-gos not named: what this phase will not do («none» is an answer)";
const NOT_INDEPENDENT = "the plan check is not proven independent: ";
const SIGNED_CONTEXT = "the plan was not built on the signed context (contextSha differs): read the context documents and plan again";

describe("the discussion (n0 … n16)", () => {
  it("[sma:p1_start] the PM opens a phase for a goal: it starts at discussion, the book says it opened with its title, a second open is a new phase", async () => {
    const seen = await observe.p1_start();
    expect(seen).toEqual({ distinct: true, stage: "discussion", state: "active", goal: "skip blanks", opened: ["phase opened: Sums"] });
  });

  it("[sma:p1_cmd] the discussion's command names the context call and what is still open; an open question is one wait for the PM", async () => {
    const seen = await observe.p1_cmd();
    expect(seen.key).toBe("discussion:none");
    expect(seen.waitsForPm).toBe(true);
    expect(seen.tool && seen.workflow).toBe(true);
    expect(seen.open).toEqual([`Open: ${NO_DOCS}; risks not named: value, usability, feasibility, viability (name each, «none» is an answer); ${NO_APPETITE}; ${NO_GOS}`]);
    expect(seen.doneOpen).toEqual([]);
    expect(seen.question).toEqual({ key: "discussion:questions:q1", waitsForPm: true, text: true });
  });

  it("[sma:p1_card] the discussion card is the signed context: documents with hashes, risks with security, appetite, no-gos, requirements and decisions", async () => {
    const seen = await observe.p1_card();
    expect(seen).toEqual({
      stage: "planning", docs: [["docs/CONTEXT.md", true], ["docs/FAQ.md", true], ["docs/ADR.md", true]], shaIsOfDocs: true,
      risks: ["value", "usability", "feasibility", "viability", "security"], appetite: "one day", noGos: ["no OAuth", "no sync"], decisions: ["D1", "D2"], requirements: ["R1"],
    });
  });

  it("[sma:p1_appetite] the appetite comes before any solution: a context without it is refused and the machine's CONTEXT.md names it before the decisions", async () => {
    const seen = await observe.p1_appetite();
    expect(seen.bare).toEqual([NO_APPETITE]);
    expect(seen.stage).toBe("discussion");
    expect(seen.heads).toEqual(["## Appetite", "## Decisions", "## No-gos", "## Risks", "## Open questions"]);
    expect(seen.appetite).toBe("two days");
  });

  it("[sma:p1_risks] four risk kinds in order, «none» is an answer and silence is not", async () => {
    const seen = await observe.p1_risks();
    expect(seen.kinds).toEqual(["value", "usability", "feasibility", "viability"]);
    expect(seen.missing).toEqual(["risks not named: usability, feasibility, viability (name each, «none» is an answer)"]);
    expect(seen.complete).toBe(true);
    expect(seen.blank).toEqual(["risks not named: feasibility (name each, «none» is an answer)"]);
  });

  it("[sma:p1_validate] each field of the card is checked on its own: documents, risks, appetite, no-gos and the documents' signature", async () => {
    const seen = await observe.p1_validate();
    expect(seen.good).toBe(true);
    expect(seen.noDocs).toBe(1);
    expect(seen.noRisks).toEqual(["risks not named"]);
    expect(seen.oneRisk).toEqual(["risks not named: viability (name each, «none» is an answer)"]);
    expect(seen.noAppetite).toEqual([NO_APPETITE]);
    expect(seen.noGos).toEqual([NO_GOS]);
    expect(seen.blankNoGo).toEqual([NO_GOS]);
    expect(seen.swapped).toEqual(["the context signature does not match its documents"]);
    // A legacy context has no documents: the gate is not the one that admits it.
    expect(seen.legacy).toBe(false);
  });

  it("[sma:p1_pieces] a piece is a task with owned paths and checks, a promise in three words, links to pieces of the plan and acceptance lines that name a command the task runs", async () => {
    const seen = await observe.p1_pieces();
    expect(seen.good).toEqual([]);
    expect(seen.noThen).toEqual(["a: the promise has no «then»"]);
    expect(seen.noOwns).toEqual(["a: no owns_paths — the piece cannot become a work"]);
    expect(seen.command).toEqual(["a: the acceptance line «`npm run lint` is green» names `npm run lint`, which is not a verification command — add it to verification or reword the line"]);
    expect(seen.commandOk).toEqual([]);
    expect(seen.link).toEqual(["a depends on gone, which is not in the plan"]);
    expect(seen.linked).toEqual([]);
  });

  it("[sma:p1_write] the analysis becomes CONTEXT.md in the phase folder and the context is signed over that very file", async () => {
    const seen = await observe.p1_write();
    expect(seen.stage).toBe("planning");
    expect(seen.files).toEqual(["CONTEXT.md"]);
    expect(seen.signedDocs).toEqual([`${seen.folder[0]}/CONTEXT.md`]);
    expect(seen.folder[0]).toMatch(/^\.agents\/phases\/ph_\w+$/);
    expect(seen.onDiskIsSigned).toBe(true);
    expect(seen.text.startsWith("# Context — Sums\n\nGoal: skip blanks\n\n## Appetite\ntwo days\n")).toBe(true);
    expect(seen.text).toContain("## Decisions\n- **D1** (locked): store in JSON\n\n## No-gos\n- no sync\n");
    expect(seen.questions).toEqual(["Which tag syntax?"]);
    expect(seen.book).toEqual(expect.arrayContaining(["auto_started", "question", "signed", "stage", "auto_done"]));
  });

  it("[sma:p1_docs] documents go to disk over the bytes the writer read, are committed by explicit path, and are read again for the signature", async () => {
    const seen = await observe.p1_docs();
    // The earlier CONTEXT.md is written over only under the hash that was read; SECURITY.md was absent (no hash).
    expect(seen.writes).toEqual([["CONTEXT.md", seen.earlierSha, "applied"], ["SECURITY.md", null, "applied"]]);
    expect(seen.commits).toEqual([[["CONTEXT.md", "SECURITY.md"], "phase ph: CONTEXT.md and SECURITY.md from the analysis"]]);
    expect(seen.signedDocs).toEqual(["CONTEXT.md", "SECURITY.md"]);
    expect(seen.kept).toBe(true);
    expect(seen.onDiskIsSigned).toBe(true);
    expect(seen.stage).toBe("planning");
  });

  it("[sma:p1_docs_ready] until every document has bytes there is no signature, the phase stays at discussion and takes no plan", async () => {
    const seen = await observe.p1_docs_ready();
    expect(seen.held).toEqual(["docs/FAQ.md is empty"]);
    expect(seen.stage).toBe("discussion");
    expect(seen.plan).toMatch(/is at discussion: a plan is submitted at planning/);
    expect(seen.whole).toBe("planning");
  });

  it("[sma:p1_scope] the goal is revised only in discussion or planning; the plan's check is void, the revision is counted and booked", async () => {
    const seen = await observe.p1_scope();
    expect(seen.late).toBe("the goal is revised in discussion or planning: return the phase there first");
    expect(seen).toMatchObject({ goal: "sums skip blanks", revisions: 1, admitted: null, critique: null, kept: 1, book: ["sums skip blanks — the owner cut a screen"] });
  });

  it("[sma:p1_files_current] the signed documents are read again at the plan check; one edited after the signature sends the phase back", async () => {
    const seen = await observe.p1_files_current();
    expect(seen.same).toBe("the plan is not admitted");
    expect(seen.sameParts).toBe(0);
    expect(seen.changed).toBe("docs/CONTEXT.md changed after the context was signed: return the phase to discussion and sign it again");
    expect(seen.changedParts).toEqual(["docs/CONTEXT.md changed after the signature"]);
  });

  it("[sma:p1_confirm] the context is signed by a person: owner.words on holds the signature for his word, off it goes on; a card without appetite or no-gos is no card", async () => {
    const seen = await observe.p1_confirm();
    expect(seen.off).toEqual({ stage: "planning", awaits: 0 });
    expect(seen.on).toEqual({ stage: "discussion", awaits: 1, afterYes: "planning" });
    expect(seen.noDecisions).toEqual([NO_APPETITE, NO_GOS]);
  });

  it("[sma:p1_signed] the signed edition is in the book with its signature before the phase moves to planning", async () => {
    const seen = await observe.p1_signed();
    expect(seen.text).toBe(`context signed ${seen.sha.slice(0, 12)}: docs/CONTEXT.md (35 B); appetite — one day; no-gos — no new screens; risks — value: none; usability: none; feasibility: none; viability: none`);
    expect(seen.before).toBe(true);
  });

  it("[sma:p1_book_ready] the book is a numbered, hash-chained list and the signature's basis is in it before the phase is ready for planning", async () => {
    const seen = await observe.p1_book_ready();
    expect(seen.kinds).toEqual(["goal/opened", "verification/live_check", "discussion/signed", "decisions/stage"]);
    expect(seen.seqs).toEqual([1, 2, 3, 4]);
    expect(seen.chained).toBe(true);
    expect(seen.signedBeforeMove).toBe(true);
  });

  it("[sma:p2_start] after the signature the phase goes to planning and the plan is built on the very edition signed; a phase with no signature takes no plan", async () => {
    const seen = await observe.p2_start();
    expect(seen.stage).toBe("planning");
    expect(seen.move).toBe("discussion → planning: the context documents exist, none is empty, and they are signed");
    expect(seen.planContext).toBe(true);
    expect(seen.early).toMatch(/is at discussion: a plan is submitted at planning \(return the phase there first\)$/);
  });

  it("[sma:p2_context] without the context documents no plan is queued: the gate names it, an empty file is named, the phase takes no plan", async () => {
    const seen = await observe.p2_context();
    expect(seen.missing).toBe(1);
    expect(seen.empty).toEqual(["docs/CONTEXT.md is empty"]);
    expect(seen.stage).toBe("discussion");
    expect(seen.plan).toMatch(/is at discussion: a plan is submitted at planning/);
  });
});

describe("the plan and its admission (n17 … n29)", () => {
  it("[sma:p2_admission] a plan is admitted on the signed context with an independent pass; each failure says why", async () => {
    const seen = await observe.p2_admission();
    expect(seen).toEqual({ good: true, stale: 1, noContext: 1, noCheck: 1, asked: ["the plan checker asked for changes: split b"] });
  });

  it("[sma:p2_legacy] a legacy phase has no signed discussion: it is at planning at once, a plan is queued, and handing it in still needs the independent check", async () => {
    const seen = await observe.p2_legacy();
    expect(seen).toMatchObject({ stage: "planning", legacy: true, docs: 0, queued: "planning", admitted: null, normalLegacy: null, normalStage: "discussion" });
    expect(seen.checked).toEqual([`${NOT_INDEPENDENT}it names no workflow run: report the wfRunId of the lp.plan run whose plan critic approved`]);
  });

  it("[sma:p2_cmd] the plan graph runs without a research step unless the phase asks, and the independent critic runs either way", async () => {
    const seen = await observe.p2_cmd();
    expect(seen.bare).toEqual({ skipped: ["research", "patterns", "strategy"], ran: ["plan", "lint", "plan_critic"], status: "succeeded" });
    expect(seen.asked).toEqual({ skipped: ["patterns", "strategy"], ran: ["research", "plan", "lint", "plan_critic"], status: "succeeded" });
  });

  it("[sma:p2_signed_input] the plan is built on the signed edition: a plan that names another edition, or has no context, is refused", async () => {
    const seen = await observe.p2_signed_input();
    expect(seen.ok).toBe(true);
    expect(seen.other).toEqual([SIGNED_CONTEXT]);
    expect(seen.orphan).toEqual([SIGNED_CONTEXT]);
  });

  it("[sma:p2_researcher] the discussion's researcher goes first and comes back while the analysis is unsure; the plan's own research step is a switch", async () => {
    const seen = await observe.p2_researcher();
    expect(seen.sure).toEqual(["gather", "assess", "done"]);
    expect(seen.unsure).toEqual(["gather", "assess", "gather", "assess", "done"]);
  });

  it("[sma:p2_planner] the planner is a step of its own; a critic's rework goes back to it and its revision meets the critic again", async () => {
    const seen = await observe.p2_planner();
    expect(seen.roles).toEqual(["planner", "plan-critic"]);
    expect(seen.path).toEqual(["plan", "lint", "plan_critic", "plan", "lint", "plan_critic", "ok"]);
    expect(seen.planVisits).toEqual([1, 2]);
    expect(seen.criticVisits).toEqual([1, 2]);
    expect(seen.status).toBe("succeeded");
  });

  it("[sma:p2_checker] the checker is a run of its own that approved this plan: its own session, a changes verdict or no run is refused", async () => {
    const seen = await observe.p2_checker();
    expect(seen.same).toEqual([`${NOT_INDEPENDENT}the plan checker went on in the planner's session thr_planner: continuing by message is no independent check`]);
    expect(seen.noRun).toEqual([`${NOT_INDEPENDENT}it names no workflow run: report the wfRunId of the lp.plan run whose plan critic approved`]);
    expect(seen.asked).toEqual(["the plan checker asked for changes: split a"]);
    expect(seen).toMatchObject({ stage: "execution", admitted: true, independence: true, book: 4 });
  });

  it("[sma:p2_order] the order is judged by the journal's times: a critic that started before the planner was done is no check", async () => {
    const seen = await observe.p2_order();
    expect(seen.early).toEqual([false, "the plan checker started before the plan was done: the check must come after the planner"]);
    expect(seen.later).toEqual([true, 30, 20]);
    expect(seen.driver).toEqual([`${NOT_INDEPENDENT}the plan checker started before the plan was done: the check must come after the planner`]);
    expect(seen.stage).toBe("planning");
  });

  it("[sma:p2_session_end] the checker has the last word: a planner that wrote again after the check is refused, a rework that ends in a critic is admitted", async () => {
    const seen = await observe.p2_session_end();
    expect(seen.after).toEqual([`${NOT_INDEPENDENT}the planner wrote again after the check: the checker must have the last word`]);
    expect(seen).toMatchObject({ stage: "execution", checker: "thr_critic2", plannedUntil: 60 });
  });

  it("[sma:p2_record] a plan has its goals and three to five pre-mortem risks: two or six are refused, five pass, blank lines do not count", async () => {
    const seen = await observe.p2_record();
    const risks = (count: number) => [`the plan names ${count} pre-mortem risk(s): name three to five, each a likely cause of failure a week after merge`];
    expect(seen.good).toBe(true);
    expect(seen.noGoal).toEqual(["the plan names no objective: its goals in one line"]);
    expect(seen.two).toEqual(risks(2));
    expect(seen.five).toEqual([]);
    expect(seen.six).toEqual(risks(6));
    expect(seen.blanks).toEqual(risks(2));
    expect(seen.alreadyMet).toBe(true);
  });

  it("[sma:p2_waves] waves come out of depends_on: a cycle gets no wave and is refused, a link to a missing piece or a wave not after its dependency's is refused", async () => {
    const seen = await observe.p2_waves();
    expect(seen.computed).toEqual([["a", 1], ["b", 2], ["c", 3]]);
    expect(seen.cycleWaves).toEqual([["a", 0], ["b", 0], ["c", 1]]);
    expect(seen.cycle[0]).toBe("the pieces depend on each other in a cycle (a → b → a): no w");
    expect(seen.earlier).toEqual(["b (wave 1) depends on a of wave 2: a dependency be"]);
    expect(seen.same).toBe(1);
    expect(seen.missing).toEqual(["a depends on gone, which is not in the plan"]);
    expect(seen.noWave).toEqual(["a has no wave: a piece's wave is computed from its depends_on, submit it without one"]);
    expect(seen.good).toEqual([]);
    expect(seen.gate).toBe(1);
  });

  it("[sma:p2_issue_troubles] each piece must become a work: the task id, owned paths, a check that runs; the plan gate carries the refusal", async () => {
    const seen = await observe.p2_issue_troubles();
    expect(seen.id).toEqual(["a: the task id must equal the piece id"]);
    expect(seen.owns).toEqual(["a: no owns_paths — the piece cannot become a work"]);
    expect(seen.verification).toEqual(["a: no verification command — nothing proves the promise"]);
    expect(seen.none).toEqual([]);
    expect(seen.command).toEqual(["a: a verification item has no command"]);
    expect(seen.ok).toEqual([]);
    expect(seen.gate).toEqual(["a: no owns_paths — the piece cannot become a work"]);
  });

  it("[sma:p2_doc_gate] the plan document gate: no plan, a composition that is not the signed one, repeated ids, a check that is not independent", async () => {
    const seen = await observe.p2_doc_gate();
    expect(seen.good).toBe(true);
    expect(seen.drift).toBe(1);
    expect(seen.twice).toBe(1);
    expect(seen.noPlan).toEqual(["no plan: submit the plan's pieces (each a task-v2 contract with a Given/When/Then promise and its wave)"]);
    expect(seen.session).toEqual([`${NOT_INDEPENDENT}the checker stayed in the planner's session`]);
  });
});
