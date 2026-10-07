import { ARCHITECT_LAUNCH } from "../workflow-architect";

/**
 * «Build with the architect»: the Workflows tab asks for the architect and sends the owner to the new-chat composer of
 * the project; the composer's «Enable Lane Pilot» button, once it mounts for that project, picks the agent and
 * prepares the session exactly as if the owner had chosen it in the popover (one click on «Send» then starts it).
 *
 * The tab's side is two lines:
 *   requestArchitectLaunch(projectId);   // remembers the request
 *   navigate to the project's new chat    // BB's own route; this module does not know it
 * The request is taken once, and only for the project it was made for, so a stale one never starts an agent in
 * another project; it also lapses after a minute.
 */
const LAPSE_MS = 60_000;
let request: { projectId: string; at: number } | null = null;

export function requestArchitectLaunch(projectId: string, now = Date.now()): void {
  request = { projectId, at: now };
}

/** The agent to prepare in this project's composer, once; null when nobody asked or the request lapsed. */
export function takeArchitectLaunch(projectId: string | null, now = Date.now()): typeof ARCHITECT_LAUNCH.agentId | null {
  if (!request || !projectId || request.projectId !== projectId) return null;
  const fresh = now - request.at <= LAPSE_MS;
  request = null;
  return fresh ? ARCHITECT_LAUNCH.agentId : null;
}
