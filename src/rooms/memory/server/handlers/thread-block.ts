import type { ServerCore } from "../../../contracts/server";
import { threadMemoryBlock } from "../services/thread-block";

/**
 * The memory rule every BB thread on every machine gets (M2), so work started anywhere in the pilot writes to one memory:
 * an ordinary thread gets the project's L1 core facts plus the two lines naming the one memory (`bb lane-pilot memory`
 * over the session RPCs) and the places it must not go; a thread the pilot spawned for work (writer, errand helper,
 * repair) gets the two lines alone — its brief already carries the facts. A PM thread keeps its own memory block and
 * tool (learning room), and a hidden analyzer must not run tools at all, so both get nothing.
 */

/** The second contributeInstructions contributor: the memory rule (and for an ordinary thread the facts) on every machine. */
export function mountThreadBlock(ctx: ServerCore): void {
  const { bb, db } = ctx;
  try {
    bb.agents.contributeInstructions(({ threadId, projectId }) => threadMemoryBlock(db, { projectId, threadId }));
  } catch (cause) { bb.log.info(`Lane Pilot memory cannot contribute instructions: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
