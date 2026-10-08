import { createHash } from "node:crypto";
import type { NotesPort, RulesPort } from "./extract";
import { getItem, setItemState, type Db, type Item } from "./store";

/**
 * What the owner decides about a learned item (T3, T5): `accept` the ones that wait for a yes, `reject` them, `drop` one already in force.
 * There is no form: the PM asks in the chat, as it asks anything, and calls this with the answer.
 *
 *  - a global preference becomes a BB memory, but BB offers an agent only `bb memory add`, so the accepted item returns the exact
 *    command and the PM runs it;
 *  - a date becomes a reminder in the thread it was said in;
 *  - a statement that contradicts one in force retires the old rule and puts the new one on trial.
 */
export type DecideDeps = {
  db: Db;
  rules: RulesPort;
  notes: NotesPort;
  remind(item: Item): Promise<string>;
  now?(): number;
};

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** `bb memory add …` for a global preference, as argv. */
export function bbMemoryAddArgs(item: Pick<Item, "id" | "text" | "evidence">): string[] {
  const slug = item.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  const name = `owner-${slug.length >= 6 ? slug : "pref"}-${createHash("sha256").update(item.id).digest("hex").slice(0, 6)}`;
  return ["bb", "memory", "add", "--scope", "global", "--kind", "preference", "--name", name, "--summary", item.text.slice(0, 400),
    "--details", `${item.text}\n\nSource: ${item.evidence}`, "--reason", "The owner said this to an agent and confirmed it when Lane Pilot asked.", "--tag", "learned", "--importance", "60"];
}
export const bbMemoryAddLine = (item: Pick<Item, "id" | "text" | "evidence">): string => bbMemoryAddArgs(item).map((part, index) => (index < 3 || part.startsWith("--") ? part : shellQuote(part))).join(" ");

export type Decision = { item: Item; run?: string; reminder?: string; note?: string };

export function createDecisions(deps: DecideDeps) {
  const now = deps.now ?? Date.now;
  const need = (id: string, states: readonly Item["state"][]): Item => {
    const item = getItem(deps.db, id);
    if (!item) throw new Error(`learned item ${id} not found`);
    if (!states.includes(item.state)) throw new Error(`item ${id} is ${item.state}; this works on an item that is ${states.join(" or ")}`);
    return item;
  };
  const refOf = (ref: string | null): { sort: string; id: string } | null => (ref && ref.includes(":") ? { sort: ref.slice(0, ref.indexOf(":")), id: ref.slice(ref.indexOf(":") + 1) } : null);

  async function accept(id: string): Promise<Decision> {
    const item = need(id, ["pending_owner", "proposed"]);
    const at = now();
    if (item.target === "reminder") {
      const reminder = await deps.remind(item);
      setItemState(deps.db, id, { state: "accepted", target: `reminder:${reminder}` }, at);
      return { item: getItem(deps.db, id)!, reminder };
    }
    if (item.target === "bb-memory") {
      setItemState(deps.db, id, { state: "accepted" }, at);
      return { item: getItem(deps.db, id)!, run: bbMemoryAddLine(item), note: "Run this command to save it as a global preference." };
    }
    if (item.target === "replace") {
      const old = refOf(item.duplicateOf);
      if (old?.sort === "rule") deps.rules.retire(item.projectId, old.id, `replaced by the owner's newer statement (${item.id})`);
      else if (old?.sort === "item") { const was = getItem(deps.db, old.id); if (was) await drop(old.id, true); }
      const proposal = deps.rules.propose(item.projectId, { rule: item.text, evidence: item.evidence, audience: (item.audience as "pm" | "writer" | "both" | null) ?? "both" });
      const adopted = deps.rules.adopt(item.projectId, proposal.id);
      setItemState(deps.db, id, { state: adopted ? "adopted" : "proposed", target: `rule:${proposal.id}` }, at);
      return { item: getItem(deps.db, id)!, ...(old?.sort === "bb-memory" ? { note: `The statement it replaces is the global memory ${old.id}: update or forget it with bb memory.` } : {}) };
    }
    // A rule that waited for a free place in its pool.
    const ruleRef = refOf(item.target);
    if (ruleRef?.sort === "rule") {
      const adopted = deps.rules.adopt(item.projectId, ruleRef.id);
      setItemState(deps.db, id, { state: adopted ? "adopted" : "proposed" }, at);
      return { item: getItem(deps.db, id)!, ...(adopted ? {} : { note: "The rule pool is full and nothing on trial is old enough to give way yet." }) };
    }
    throw new Error(`item ${id} has nothing to accept`);
  }

  async function reject(id: string): Promise<Decision> {
    const item = need(id, ["pending_owner", "proposed"]);
    const ruleRef = refOf(item.target);
    if (ruleRef?.sort === "rule" && item.state === "proposed") deps.rules.reject(item.projectId, ruleRef.id);
    setItemState(deps.db, id, { state: "rejected" }, now());
    return { item: getItem(deps.db, id)! };
  }

  /** Takes back something already in force. `quiet` is for an item replaced by a newer one. */
  async function drop(id: string, quiet = false): Promise<Decision> {
    const item = need(id, ["adopted", "noted", "accepted"]);
    const target = refOf(item.target);
    if (target?.sort === "rule") deps.rules.retire(item.projectId, target.id, quiet ? "replaced" : "the owner took it back");
    else if (target?.sort === "memory") deps.notes.forget(item.projectId, target.id);
    setItemState(deps.db, id, { state: "dropped" }, now());
    return { item: getItem(deps.db, id)!, ...(item.target === "bb-memory" || item.state === "accepted" && item.reach === "owner" ? { note: "A global memory is forgotten with bb memory forget." } : {}) };
  }

  return { accept, reject, drop };
}
export type Decisions = ReturnType<typeof createDecisions>;
