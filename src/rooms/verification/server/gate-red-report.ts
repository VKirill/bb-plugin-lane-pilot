import { join } from "node:path";
import { finishGateRun } from "../../storage";
import { bestEffort } from "@lane-pilot/kit";
import type { GateAttributeResult } from "../integration-gate-host";
import { unhandledErrorBlock } from "../gate-output";
import { attributeFailures } from "./gate-attribution";
import { bisectCulprit, findCulpritByFiles, type MergedTaskInfo, type ProjectFileReader } from "./gate-culprit";
import { formatFixTurnPrompt } from "./gate-fix-prompt";
import { dispatchRepair } from "./gate-repair";

import type { ServerCore } from "../../contracts/server";
import type { LeadRoadApi } from "../../contracts";
import { postOwnerItem } from "../../owner-waiting";
import { stripAnsi } from "@lane-pilot/kit";
import { testLabel } from "./gate-attribution";
import { continuesEpisode, type GateEpisode } from "./gate-episode";
import type { FailingTest } from "../gate-output";
import type { Services } from "./integration-gate";

/**
 * A red the batch did not cause (every failing test is red on the base) becomes a branch of the lead's road tree, class
 * next_step: «fix the pre-existing red test X in project P». A decides tier of the next tick acts on it without the owner;
 * a proposes tier still puts it to him as a proposal, which is the right place for it — not a bare «nobody is guilty» row.
 * One branch per (project, first failing tests): an open, proposed or already-deciding twin is enough.
 */
export function fileWithLead(ctx: ServerCore, services: Services, input: { runId: string; projectId: string }, tests: FailingTest[], logPath?: string): void {
  try {
    const db = ctx.db as never as Parameters<LeadRoadApi["listRoad"]>[0];
    const names = tests.map(testLabel).slice(0, 3).join(", ");
    const title = `Починить ранее красный тест: ${names} (проект ${input.projectId})`.slice(0, 300);
    const alive = services.leadRoad.listRoad(db, { projectId: input.projectId, state: ["open", "later", "proposed"], limit: 500 });
    if (alive.some((row) => row.title === title)) return;
    const rootId = `dir:${input.projectId}`;
    const root = services.leadRoad.getRoad(db, rootId) ?? services.leadRoad.addRoad(db, { id: rootId, projectId: input.projectId, title: `${input.projectId}: directions`, kind: "direction", source: "lead", why: "the root the lead files a project's branches under when a proposal names no parent" });
    services.leadRoad.addRoad(db, {
      parentId: root.id, projectId: input.projectId, title, kind: "option", source: "lead", class: "next_step",
      why: `Общая проверка после слияния красная, но все упавшие тесты падают и на базе до этой партии: ни одна слитая задача не виновата. Это работа, а не решение владельца: починить тест, который был сломан раньше.`,
      evidence: [
        { kind: "run", ref: input.runId, label: "красная проверка" },
        ...(logPath ? [{ kind: "file" as const, ref: logPath, label: "полный лог" }] : []),
        ...tests.slice(0, 5).map((test) => ({ kind: "note" as const, ref: testLabel(test).slice(0, 500), label: "упавший тест" })),
      ],
      costEstimate: "one fix",
    });
  } catch (cause) {
    ctx.log(`integration-gate: the pre-existing red was not filed to the lead's road: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * A red gate with no writer to fix it is a fact for the log and the owner's list, never a message into the PM chat: the gate runs
 * after the batch's last merge, when the run is often accepted and its PM done (2026-10-31: a gate note woke a finished PM two
 * hours later; the owner wants no event of the plugin's own in that chat, and since 2026-10-09 no question «what should the PM
 * do?» either). One row per red-gate episode: the same red again changes nothing.
 */
export function noteRed(ctx: ServerCore, input: { runId: string; projectId: string }, episode: GateEpisode, kind: string, what: string, why: string, logPath?: string): void {
  ctx.log(`integration-gate: ${stripAnsi(what)} ${stripAnsi(why)}`);
  postOwnerItem(ctx.db as never, {
    key: `gate-red:${input.runId}:${episode.startedAt}`, source: "integration-gate", kind, projectId: input.projectId, wake: false,
    what: stripAnsi(what), why: stripAnsi(why),
    evidence: [{ kind: "run", ref: input.runId }, ...(logPath ? [{ kind: "file" as const, ref: logPath }] : [])],
  });
}
/** A red run belongs to the run's current episode, or starts a new one (the owner's list has one row per episode). */
export function enterEpisode(episodes: Map<string, GateEpisode>, runId: string, command: string, files: string[]): GateEpisode {
  const known = episodes.get(runId);
  if (known && continuesEpisode(known, command, files)) {
    known.files = [...new Set([...known.files, ...files])];
    return known;
  }
  const episode: GateEpisode = { command, files: [...files], startedAt: Date.now() };
  episodes.set(runId, episode);
  return episode;
}

/** Finds the culprit of a red gate, writes its log, dispatches the repair or files the red with the owner / the lead. */
export async function reportRed(deps: {
  ctx: ServerCore;
  services: Services;
  episodes: Map<string, GateEpisode>;
  consumePending: (key: string, count: number) => void;
}, args: {
  input: {
    runId: string;
    projectId: string;
    pmThreadId: string;
    basePath: string;
    configHostId: string;
    live?: boolean;
  };
  key: string;
  gateCommand: string;
  label: string;
  readProjectFile: ProjectFileReader;
  batch: MergedTaskInfo[];
  lastGreenCommit: string | null;
  gateRunId: number;
  ran: { head: string | null };
  failingTests: FailingTest[];
  activeExitCode: number;
  activeStdout: string;
  activeStderr: string;
  activeHead: string | null;
  repeatedTimeouts: boolean;
  cacheNote: string;
}): Promise<{ ran: boolean; passed?: boolean; culpritTaskId?: string | null }> {
  const { ctx, services, episodes, consumePending } = deps;
  const { input, key, gateCommand, label, readProjectFile, batch, lastGreenCommit, gateRunId, ran, failingTests, activeExitCode, activeStdout, activeStderr, activeHead, repeatedTimeouts, cacheNote } = args;
  const { runId, projectId, basePath, configHostId } = input;
  const db = ctx.db;
  const bb = ctx.bb;
  const host = ctx.host;

  // Gate failed. Find culprit.
  const failingFiles = [...new Set(failingTests.map((test) => test.file))];
  const tasksToCheck = batch;

  // The host knows what each merged commit changed and which failing tests also fail on the base the batch started from.
  let info: GateAttributeResult | null = null;
  if (!input.live && failingTests.length) {
    const commits = tasksToCheck.map((task) => task.commitSha).filter((sha) => /^[a-f0-9]{7,64}$/.test(sha));
    const baseSha = lastGreenCommit ?? (commits[0] ? `${commits[0]}^1` : null);
    const ATTRIBUTE_TIMEOUT_SEC = 20 * 60;
    info = await host.call("gateAttribute", { requestedHostId: configHostId, basePath, baseSha, commits, failing: failingTests.slice(0, 300), timeoutSec: ATTRIBUTE_TIMEOUT_SEC },
      { hostId: configHostId, timeoutMs: (ATTRIBUTE_TIMEOUT_SEC + 60) * 1000 }).catch((cause: unknown) => {
      ctx.log(`integration-gate: could not attribute the failing tests on host ${configHostId}, the older file search is used: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    });
  }
  const attribution = attributeFailures(failingTests, tasksToCheck, info);

  let culprit: MergedTaskInfo | null = null;
  if (input.live) {
    // A folder without git has no commits to bisect and no merges to blame: the PM and the owner get the red result.
  } else if (attribution.strict) {
    // Only a task whose diff touches a failing test (or its workspace) and that was green on the base can be the culprit.
    const { candidates, remaining } = attribution;
    if (candidates.length === 1) culprit = candidates[0]!;
    else if (candidates.length > 1) {
      culprit = await findCulpritByFiles(remaining.map((test) => test.file), candidates, readProjectFile);
      if (!culprit && lastGreenCommit && ran.head && ran.head !== lastGreenCommit) {
        const found = await bisectCulprit(host, configHostId, gateCommand, lastGreenCommit, ran.head, basePath, tasksToCheck);
        culprit = found && candidates.includes(found) ? found : null;
      }
    }
  } else {
    culprit = await findCulpritByFiles(failingFiles, tasksToCheck, readProjectFile);
  }

  // Fallback (the host could not attribute): git bisect with a proven green base works even for one task — the only
  // evidence a lone merge broke the gate. F-009: headcount alone is no proof, so no «only task → culprit» shortcut.
  if (input.live || attribution.strict) {
    // reported below
  } else if (!culprit && lastGreenCommit && tasksToCheck.length >= 1) {
    const currentHead = ran.head;
    if (currentHead && currentHead !== lastGreenCommit) {
      culprit = await bisectCulprit(host, configHostId, gateCommand, lastGreenCommit, currentHead, basePath, tasksToCheck);
    }
  }

  const preexistingNote = attribution.preexisting.length
    ? ` Были сломаны и раньше, не этой партией (падают и на базовом коммите): ${attribution.preexisting.map(testLabel).join(", ")}.`
    : "";

  // Reset this scope's counts for the next cycle; merges that landed during the run stay queued.
  consumePending(key, batch.length);
  finishGateRun(db, gateRunId, "failed", { head: activeHead ?? ran.head ?? null,
    reason: (failingTests.length ? failingTests.slice(0, 3).map(testLabel).join(", ") : `exit ${activeExitCode}`).slice(0, 300) });

  // An unhandled error outside any test fails the run with every test green; its block sits above the summary the log tail ends with.
  const unhandled = unhandledErrorBlock(`${activeStderr}\n${activeStdout}`);

  // Write log file
  const logRelativePath = `.agents/plans/items/${culprit ? culprit.taskId : "integration-gate"}/logs/integration-gate.log`;
  const logFullPath = join(basePath, logRelativePath);
  const logContent = `$ ${gateCommand}\nexit ${activeExitCode}\n\n${activeStdout}\n${activeStderr}`.trim() + "\n";

  await bestEffort(ctx.log, `gate log write ${logRelativePath}`, bb.sdk.files.write({
    hostId: configHostId,
    rootPath: basePath,
    path: logFullPath,
    content: logContent,
    contentEncoding: "utf8",
    createParents: true,
    expectedSha256: null,
  }), undefined);

  if (culprit) {
    // The culprit's attempt is accepted and its worktree gone: a message into its old writer thread had no loop waiting for the turn, so
    // nobody verified or merged the fix (Gemini F-013). The repair is a task of its own, dispatched to the run's PM queue like a post-merge
    // mainfix (finish.ts postMergeRepair); a sticky writer of the area may still take it in the same thread. One that cannot be dispatched
    // (the run closed, a repair of a repair) is a row on the owner's list, never a lost message.
    const prompt = formatFixTurnPrompt({
      taskId: culprit.taskId,
      gateCommand,
      exitCode: activeExitCode,
      stdout: activeStdout,
      stderr: activeStderr,
      logPath: logRelativePath,
      ...(attribution.strict ? { failingTests: attribution.remaining.map(testLabel), preexistingTests: attribution.preexisting.map(testLabel) } : {}),
      unhandled,
    });
    const dispatched = await dispatchRepair(ctx, services, input, culprit.taskId, gateCommand, prompt, logRelativePath);
    if (dispatched) {
      ctx.log(`integration-gate: ${label} failed, traced to ${culprit.taskId}; repair task ${dispatched} dispatched.${preexistingNote} Full log: ${logRelativePath}`);
    } else {
      noteRed(ctx, { runId, projectId }, enterEpisode(episodes, runId, gateCommand, [culprit.taskId]), "gate_red", `После слияния задачи ${culprit.taskId} общая проверка проекта красная`,
        `Проверка «${gateCommand}» упала после слияния партии, и виновата задача ${culprit.taskId}.${preexistingNote} Задачу починки создать не удалось (запуск закрыт или это уже починка починки): поручите исправление в чате проекта.`, logRelativePath);
    }
    return { ran: true, passed: false, culpritTaskId: culprit.taskId };
  }

  // No culprit: a fact for the log and the owner's list, once per red-gate episode; nobody is asked anything.
  const tasks = tasksToCheck.map((task) => task.taskId).join(", ");
  const allPreexisting = attribution.strict && failingTests.length > 0 && attribution.remaining.length === 0;
  const why = !failingTests.length && unhandled
    ? `Проверка завершилась с кодом ${activeExitCode}, но ни один тест не назван упавшим: ошибка случилась вне тестов (сами тесты могут быть зелёными): ${unhandled}.${preexistingNote}`
    : input.live
    ? `В этой папке нет git, поэтому виноватого искать негде${tasks ? ` (задачи с прошлой проверки: ${tasks})` : ""}.`
    : allPreexisting
      ? `Все ${failingTests.length} упавших тестов падают и на базе до этой партии (были сломаны раньше), поэтому ни одна слитая задача не виновата.`
      : attribution.strict && attribution.candidates.length === 0
        ? `Ни одна задача этой партии не трогала упавшие тесты или их папки, поэтому виноватых среди них нет.${preexistingNote}`
        : `Виноватого однозначно не определить.${preexistingNote}`;
  const timeoutNote = repeatedTimeouts ? " (дважды не уложились во время, в том числе при перепроверке)" : "";
  const failingList = failingTests.length ? ` Упавшие тесты${timeoutNote}: ${failingTests.map(testLabel).join(", ")}.` : "";
  const cacheSuffix = cacheNote ? ` ${cacheNote}` : "";
  if (allPreexisting) {
    // Every failing test is red on the base too, so no merged task is guilty: this is not the owner's decision, it is work a
    // decides lead can pick up itself. One branch on the lead's road tree (class next_step), the log keeps the rest; no owner row.
    ctx.log(`integration-gate: ${label} red, all ${failingTests.length} failing tests fail on the base too; filed to the lead's road for ${projectId}. Full log: ${logRelativePath}`);
    fileWithLead(ctx, services, { runId, projectId }, failingTests, logRelativePath);
  } else {
    noteRed(ctx, { runId, projectId }, enterEpisode(episodes, runId, gateCommand, failingFiles), "gate_red",
      `Проверка после слияния (${label}) не прошла (код ${activeExitCode}).${failingList}`, `${why}${cacheSuffix} Полный лог: ${logRelativePath}`, logRelativePath);
  }

  return { ran: true, passed: false, culpritTaskId: null };
}
