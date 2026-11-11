import {
  HarnessValidationError, LANE_PILOT_SURFACE, isBase, parseNotes, validate,
  type Tree,
} from "@lane-pilot/harness-core";
import { graphEditProblems } from "./graph-edit";

export type StageResult = { tree: Tree; keptBase: boolean; notes: string; threadIds: string[]; error: string | null };
export type StageSession = { threadId: string | null; text: string; tree: Tree | null; error: string | null };

/** How long a stage waits before its second session: OpenCode's startup holds its database for a few seconds. */
export const SESSION_RETRY_DELAY_MS = 20_000;

/**
 * A session that ended with BB's own verdict (a refused turn, an agent that did not start) rather than at the deadline.
 * Such an end is usually one-off: on 2026-10-19 the INV editor of BB-сервис feature:shell got «Agent stopped the turn:
 * refusal» from Gemini after reading the evidence, and the DOM editor, spawned two seconds later on the same Mac,
 * died on «Command thread.start failed … database is locked» while the first OpenCode process was starting. A session
 * that ran out of time is not tried again: a second one would cost another full wait.
 */
export function sessionEndedEarly(error: string | null): boolean {
  return !!error && !/:incomplete:/.test(error);
}

/**
 * The stage loop, the way Harness² does it: a rejected tree goes back with the error verbatim (one retry); a session that
 * ended early gets one more session in the same folder; everything else keeps the fallback with the error.
 */
export async function runStage(input: { mission: string; fallback: Tree; title: string; surface?: typeof LANE_PILOT_SURFACE }, run: (mission: string) => Promise<StageSession>,
  log: (line: string) => void, retryDelayMs = SESSION_RETRY_DELAY_MS): Promise<StageResult> {
  const threadIds: string[] = [];
  let mission = input.mission;
  let lastError: string | null = null;
  let rejected = 0, restarted = 0;
  while (true) {
    const result = await run(mission);
    if (result.threadId) threadIds.push(result.threadId);
    if (result.error && sessionEndedEarly(result.error) && restarted === 0) {
      restarted++;
      // «ended early», not «failed»: the watcher reads failure lines of this log as incidents, and this one is handled.
      log(`harness session «${input.title}» ended early, starting one more session: ${result.error}`);
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      mission = `${mission}\n\n# A PREVIOUS SESSION IN THIS FOLDER STOPPED EARLY\n\nIt ended with: ${result.error.slice(0, 300)}\n\n\`context/harness/\` may hold its partial edits: check them before you build on them, then do the whole job and reply.`;
      continue;
    }
    if (result.error || !result.tree) { lastError = result.error ?? "no tree came back"; break; }
    const { notes, keepBase } = parseNotes(result.text);
    const tree = result.tree;
    try {
      validate(tree, input.surface ? { surface: input.surface } : {});
      if (input.surface?.graphFiles) {
        const graphProblems = graphEditProblems(tree);
        if (graphProblems.length) throw new HarnessValidationError(graphProblems);
      }
    } catch (cause) {
      lastError = cause instanceof HarnessValidationError ? cause.message : String(cause);
      if (++rejected >= 2) break;
      mission = `${input.mission}\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${lastError}\n\nFix it in \`context/harness/\` (the files are still there) and reply again.`;
      continue;
    }
    return { tree, keptBase: keepBase || isBase(input.fallback, tree), notes, threadIds, error: null };
  }
  return { tree: input.fallback, keptBase: true, notes: "", threadIds, error: lastError };
}
