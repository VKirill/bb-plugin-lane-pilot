import { listItems, markAnnounced, type Db, type Item } from "./store";

/**
 * «What I learned today» (T5). Once a day, for each project with something new, one report lists what the extractor drew out of the
 * owner's messages: rules now on trial, decisions noted, and what waits for a yes (a global preference, a reminder, a statement that
 * contradicts a rule in force). Since 0.1.458 the report is one row on the owner's list (`announce`), never a message into a PM chat
 * (0.1.443; the Gemini grill of 0.1.456 found the evening send still waking cold chats). Nothing global is written before the owner's
 * «yes» (`op:"accept"`), and any rule can be taken back (`op:"drop"`). An item is announced once.
 */
export const MAX_LISTED = 10;
const WAITING_STATES: Item["state"][] = ["pending_owner", "proposed"];
const SHOWN_STATES: Item["state"][] = ["adopted", "noted", "pending_owner", "proposed"];

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const tool = (op: string) => `lane_pilot_memory {action:"learned", op:"${op}", id}`;

function line(item: Item): string {
  const where = item.audience ? ` (${item.audience})` : "";
  if (item.target === "replace") return `- [${item.id}] the owner said ${item.text} — this contradicts a statement in force${item.note ? ` (${item.note})` : ""}`;
  if (item.target === "bb-memory") return `- [${item.id}] for all his work: ${item.text}`;
  if (item.target === "reminder") return `- [${item.id}] reminder for ${item.dueAt ? day(item.dueAt) : "a date"}: ${item.text}`;
  if (item.state === "proposed") return `- [${item.id}] rule${where}: ${item.text} (no room in the rule pool yet)`;
  return `- [${item.id}] ${item.kind}${where}: ${item.text}`;
}

/** The message for one project, or null when there is nothing to say. */
export function composeDigest(items: readonly Item[], now: number): { text: string; ids: string[]; inForce: number; waiting: number } | null {
  const shown = items.filter((item) => SHOWN_STATES.includes(item.state));
  if (!shown.length) return null;
  const listed = shown.slice(0, MAX_LISTED);
  const waiting = listed.filter((item) => WAITING_STATES.includes(item.state));
  const inForce = listed.filter((item) => !WAITING_STATES.includes(item.state));
  const confirmed = items.filter((item) => item.state === "duplicate").length;
  const text = [
    `Lane Pilot learned from the owner's own messages (report of ${day(now)}). Tell the owner briefly, in his language: what changed, and ask the questions that wait for his answer in the chat. Do not add questions of your own.`,
    ...(inForce.length ? ["", "Now in force (rules are on trial and are confirmed or dropped by what happens next; decisions are notes in project memory):", ...inForce.map(line), `The owner takes one back with ${tool("drop")}.`] : []),
    ...(waiting.length ? ["", "Waiting for the owner's yes or no (nothing is changed before he answers):", ...waiting.map(line), `Yes: ${tool("accept")}. No: ${tool("reject")}. A global preference is saved by running the command accept returns.`] : []),
    ...(shown.length > listed.length ? ["", `${shown.length - listed.length} more are listed by ${tool("items").replace(", id", "")}.`] : []),
    ...(confirmed ? ["", `${confirmed} statement${confirmed === 1 ? " repeated" : "s repeated"} something already in force and confirmed it.`] : []),
  ].join("\n");
  return { text, ids: items.filter((item) => item.state !== "dropped" && item.state !== "rejected").slice(0, 200).map((item) => item.id), inForce: inForce.length, waiting: waiting.length };
}
export type DigestReport = NonNullable<ReturnType<typeof composeDigest>>;

export type DigestDeps = {
  db: Db;
  /** Where a project's report goes: the learning room posts it as one row on the owner's list (`learning-digest:<project>:<day>`). */
  announce(projectId: string, report: DigestReport): Promise<void>;
  now?(): number;
  log?(line: string): void;
};

export function createDigest(deps: DigestDeps) {
  const now = deps.now ?? Date.now;
  /** Announces the day's report of every project that has one; `dryRun` only composes. */
  async function run(options: { dryRun?: boolean; projectId?: string } = {}): Promise<Array<{ projectId: string; sent: boolean; items: number; text: string }>> {
    const unannounced = listItems(deps.db, { unannounced: true, limit: 500, ...(options.projectId ? { projectId: options.projectId } : {}) });
    const byProject = new Map<string, Item[]>();
    for (const item of unannounced) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item]);
    const out: Array<{ projectId: string; sent: boolean; items: number; text: string }> = [];
    for (const [projectId, items] of byProject) {
      const digest = composeDigest(items.reverse(), now());
      if (!digest) { if (!options.dryRun) markAnnounced(deps.db, items.map((item) => item.id), now()); continue; }
      let sent = false;
      if (!options.dryRun) {
        try { await deps.announce(projectId, digest); markAnnounced(deps.db, digest.ids, now()); sent = true; }
        catch (cause) { deps.log?.(`learning: digest for ${projectId} not announced: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      out.push({ projectId, sent, items: digest.ids.length, text: digest.text });
    }
    return out;
  }
  return { run };
}
export type Digest = ReturnType<typeof createDigest>;
