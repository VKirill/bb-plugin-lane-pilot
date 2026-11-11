import { sha256Hex } from "@lane-pilot/kit";
import { buildsScreens, coverageGaps } from "../stages";
import { candidateOn, type AcceptanceLine, type AcceptanceLineId, type Phase, type PhaseRecord, type PlanItem } from "./record";
import { canonical } from "./signatures";
import { pieceLines, type PieceLineId, type TaskFact } from "./waves";
import { wordOf } from "./words";

/** The key of the package a person decides on (SMA p6_decide): the plan, the verdict's input and the tree it saw. A new verdict or tree is a new key. */
export const acceptanceKey = (record: PhaseRecord) => sha256Hex(canonical({ plan: record.plan?.sha ?? null, verdict: record.verification?.verdict?.inputSha ?? null, tree: record.verification?.verdict?.mainSha ?? null,
  // The drawing bound into the package (SMA p5_design): its hash and contract path — a redrawn drawing is a new package.
  drawing: record.design?.drawing ? { sha256: record.design.drawing.sha256, contract: record.design.drawing.paths.find((path) => /(UI-SPEC|DESIGN)\.md$/i.test(path)) ?? null } : null })).slice(0, 16);

/** The phase acceptance calculation: each line decided by code; the phase is accepted only when every line holds. */
export function acceptanceLines(phase: Phase, facts: ReadonlyMap<string, TaskFact>, now: { mainSha: string | null; openDeferrals: number; noTerm?: ReadonlyArray<{ id: string; what: string }>; bookBroken?: number | null; book?: { lastSeq: number | null; readSha: string | null } }): AcceptanceLine[] {
  const items = phase.record.plan?.items ?? [];
  const verdict = phase.record.verification?.verdict;
  const line = (id: AcceptanceLineId, ok: boolean, detail: string): AcceptanceLine => ({ id, ok, detail });
  const failed = (pick: (fact: TaskFact | undefined) => boolean) => items.filter((item) => pick(facts.get(item.id))).map((item) => item.id);
  // The piece-level lines come from the one function the wave folds (SMA bw_lines): the phase acceptance holds a piece to
  // exactly the lines its wave was held to.
  // SMA k_we_verify: a live check is owed only where the project switched browser_qa on.
  const liveCheckPossible = phase.record.liveCheck === true;
  const pieceLine = (item: PlanItem, id: PieceLineId) => pieceLines(item, facts.get(item.id), phase.record.execution?.issuedSha?.[item.id], liveCheckPossible).find((line) => line.id === id)!.ok;
  const notProved = items.filter((item) => !pieceLine(item, "promises_proved")).map((item) => item.id);
  const notChecked = items.filter((item) => !pieceLine(item, "checks_passed")).map((item) => item.id);
  const blockedByCritic = failed((fact) => fact?.codeCritique === "blocked");
  const notLanded = items.filter((item) => !pieceLine(item, "landed")).map((item) => item.id);
  const qaRed = failed((fact) => fact?.browserQa === "failed");
  // The phase's own live check (k_we_uiqa) must be of the same candidate the acceptance decides on.
  const live = phase.record.verification?.live;
  const verifiedHead = candidateOn(phase.record) ? Object.values(phase.record.candidate!.verified ?? {})[0] ?? null : null;
  const staleLive = !!(live?.head && verifiedHead && live.head !== verifiedHead);
  // What did read the pieces, said as it is: no receipt is no reading (2026-10-29 audit: «no independent checker blocks» and «the
  // browser checks read clean» were printed for pieces no critic and no browser check had seen; the code critic is off by default).
  // SMA p6_l_verdict / p6_evidence: a line is green on a positive verdict only. A piece with no critic receipt is unread, and a piece
  // whose contract plans a browser check (qa_cases) is unread until that check passed; a piece without qa_cases says it has none.
  const uncritiqued = items.filter((item) => !pieceLine(item, "independent_check")).map((item) => item.id);
  const qaOwed = items.filter((item) => { const fact = facts.get(item.id); return (fact?.qaPlanned || (buildsScreens(item) && liveCheckPossible)) && fact?.browserQa !== "passed"; }).map((item) => item.id);
  const qaPassed = failed((fact) => fact?.browserQa === "passed").length;
  const qaNone = failed((fact) => !fact?.qaPlanned).length;
  const noLive = liveCheckPossible ? 0 : items.filter(buildsScreens).length;
  const model = phase.record.verification?.model;
  // The person's two decisions count only under the key of the package now shown (a word on an older candidate is not this one's).
  const latest = wordOf(phase.record, "acceptance");
  const word = latest && latest.key === acceptanceKey(phase.record) ? latest : undefined;
  const asked = !!phase.record.ownerWords;
  const decided = (pick: "useful" | "limits") => !asked || (word?.decision === "yes" && word[pick] === true);
  const wordDetail = (what: string) => !asked ? "the project does not ask for the owner's word (owner.words off)"
    : word ? `${word.by}: ${word.decision}${word.decision === "yes" ? ` — ${what}` : ""} — ${word.text}` : latest ? `the owner's word was given on another package (${latest.key ?? "no key"}): it is asked again` : "awaits the owner's keyed decision";
  return [
    line("contract_current", !!phase.record.plan?.admittedSha && phase.record.plan.admittedSha === phase.record.plan.sha, phase.record.plan?.admittedSha === phase.record.plan?.sha ? "the plan is the admitted one" : "the plan changed after its admission"),
    line("promises_proved", notProved.length === 0, notProved.length ? `not proved by plan-fact: ${notProved.join(", ")}` : `${items.length} promises proved`),
    line("checks_passed", notChecked.length === 0, notChecked.length ? `checks failed: ${notChecked.join(", ")}` : "every piece's checks passed"),
    line("independent_check", blockedByCritic.length === 0 && uncritiqued.length === 0, blockedByCritic.length ? `the code critic blocks: ${blockedByCritic.join(", ")}`
      : uncritiqued.length ? `the code critic has not passed: ${uncritiqued.join(", ")} (no critic receipt is no reading)` : `the code critic passed all ${items.length} piece(s)`),
    line("landed", notLanded.length === 0, notLanded.length ? `not merged: ${notLanded.join(", ")}` : candidateOn(phase.record) ? `every piece is merged into the phase candidate ${phase.record.candidate!.branch}` : "every piece is merged into main"),
    line("composition_verified", verdict?.state === "passed", verdict ? verdict.detail : "no blind verdict yet"),
    line("main_unmoved", !verdict?.mainSha || !now.mainSha || verdict.mainSha === now.mainSha, verdict?.mainSha && now.mainSha && verdict.mainSha !== now.mainSha ? `main moved from ${verdict.mainSha.slice(0, 12)} to ${now.mainSha.slice(0, 12)} since the verdict — verify again` : "main is where the verdict saw it"),
    line("qa_read", qaRed.length === 0 && qaOwed.length === 0 && !staleLive, qaRed.length ? `the browser check failed: ${qaRed.join(", ")}`
      : qaOwed.length ? `the ${qaOwed.every((id) => facts.get(id)?.qaPlanned) ? "planned " : ""}browser check has not passed: ${qaOwed.join(", ")}`
      : staleLive ? `the live check was taken on head ${live!.head!.slice(0, 12)}, the package it decides on is at ${verifiedHead!.slice(0, 12)} — check the same candidate`
      : `${qaPassed} piece(s) passed their browser check${qaNone ? `; ${qaNone} piece(s) plan none (no qa_cases)` : ""}${noLive ? "; visible work, no live check owed (browser_qa.enabled is not on)" : ""}`),
    line("goal_met", model?.state === "met", model ? `${model.by}: ${model.summary}` : "no goal audit yet"),
    // Batch closure (SMA bc_closure): the calculation is run fresh at close — a withdraw can drop the last piece covering a
    // requirement without the plan gate seeing it, and a broken book chain is no closing record.
    line("nothing_missing", !!phase.record.plan?.alreadyMet || coverageGaps(phase.record).length === 0, coverageGaps(phase.record).length && !phase.record.plan?.alreadyMet ? `left uncovered at close: ${coverageGaps(phase.record).join("; ")}` : "every requirement and locked decision is covered"),
    line("book_intact", !now.bookBroken, now.bookBroken ? `the phase book's chain is broken at part ${now.bookBroken}` : "the phase book's chain is intact"),
    // Book closed before «accepted» (SMA ta_book_close): BOOK.md is written up to the last book part and reads back what was written.
    line("book_closed", now.book === undefined || !phase.runId || (!!phase.record.bookWritten && phase.record.bookWritten.seq === now.book.lastSeq && now.book.readSha === phase.record.bookWritten.sha256),
      now.book === undefined ? "the book read-back was not part of this call"
        : !phase.runId ? "the book lives on the hub only (the phase has no run binding)"
        : !phase.record.bookWritten ? "BOOK.md was never written"
        : phase.record.bookWritten.seq !== now.book?.lastSeq ? `BOOK.md is behind the book (written part ${phase.record.bookWritten.seq}, book now at ${now.book?.lastSeq ?? "none"})`
        : now.book?.readSha !== phase.record.bookWritten.sha256 ? "BOOK.md did not read back what was written"
        : `BOOK.md written through part ${phase.record.bookWritten.seq} and read back intact`),
    // A put-off check with no term from the owner is unproven work of this project: it holds the acceptance until an agent closes it with evidence.
    // Limits acknowledged (SMA p6_l_limits): a person's decision on what stays open and how to recover, after every put-off check has its term.
    line("limits_acknowledged", !now.noTerm?.length && decided("limits"), now.noTerm?.length ? `${now.noTerm.length} deferred check(s) of this project are open with no term from the owner, so they count as unproven: ${now.noTerm.slice(0, 5).map((row) => row.id).join(", ")} — close each with evidence (bb lane-pilot defer-close <id> --evidence …)`
      : `${now.openDeferrals ? `${now.openDeferrals} deferred item(s) of this project stay open, named in the book` : "nothing deferred"}; ${wordDetail("the limits are acknowledged")}`),
    // Result clear and useful (SMA p6_l_useful): a person's decision.
    line("result_useful", decided("useful"), wordDetail("the result is clear and useful")),
    // SMA k_wv_design: every point of the confirmed drawing contract is an acceptance line, judged by the goal audit.
    ...(phase.record.designPoints === true ? phase.record.verification?.points ?? [] : []).map((point) => ({ id: point.id as `design_${string}`, ok: point.met === true, detail: point.met === true ? `${point.text} — met${point.evidence ? ` (${point.evidence.slice(0, 160)})` : ""}` : `${point.text} — the goal audit did not prove it` })),
  ];
}
