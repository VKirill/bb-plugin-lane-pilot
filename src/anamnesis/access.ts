import { parse } from "./cli";

/**
 * What a request to the owner's anamnesis does, for the caller check (src/server/owner-gate.ts, audit 2026-10-08 round 4 P0-5, P1-18):
 *  - `read`: records the owner has not marked sensitive, counts, the card, the sources' state;
 *  - `sensitive-read`: sensitive records, or a record's history (it quotes what the record said before an edit);
 *  - `write`: adds, edits, forgets, source switches, a load that stores, a change of what is read;
 *  - `write-owner`: a write that widens what agents see or what leaves the machine — a record made public or private, a
 *    record confirmed, sensitive text allowed to go to Jev. Only the owner does these; an agent is never asked about them.
 */
export type AnamnesisAccess = "read" | "sensitive-read" | "write" | "write-owner";

const RANK: Record<AnamnesisAccess, number> = { read: 0, "sensitive-read": 1, write: 2, "write-owner": 3 };
const stricter = (a: AnamnesisAccess, b: AnamnesisAccess): AnamnesisAccess => (RANK[a] >= RANK[b] ? a : b);

/** A change that leaves a record `sensitive` keeps it from agents; any other sensitivity, or a confirmation, is the owner's call. */
const widens = (sensitivity: unknown, status: unknown): boolean =>
  (typeof sensitivity === "string" && sensitivity !== "sensitive") || status === "confirmed";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (typeof value === "object" && value !== null ? value as Obj : {});

/** The RPC `anamnesis` request (a store op, or the hub's own `host`). An op nobody knows is judged as a write. */
export function anamnesisAccessOfRequest(request: unknown): AnamnesisAccess {
  const r = obj(request);
  switch (r.op) {
    case "status": case "host": case "card": return "read";
    case "list": case "get": case "whoami": return r.includeSensitive === true ? "sensitive-read" : "read";
    case "history": return "sensitive-read";
    case "collect": return r.mode === "plan" ? "read" : "write";
    case "sources": return r.set === undefined ? "read" : "write";
    case "add": return obj(r.record).sensitivity === "public" ? "write-owner" : "write";
    case "edit": {
      const patch = obj(r.patch);
      return widens(patch.sensitivity, patch.status) ? "write-owner" : "write";
    }
    case "upsert": case "forget": case "load_report": return "write";
    default: return "write";
  }
}

/** The command line `bb lane-pilot anamnesis <argv>`. A line that does not parse does nothing, so it is a read. */
export function anamnesisAccessOfCli(argv: string[]): AnamnesisAccess {
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(argv); } catch { return "read"; }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (!command || command === "help" || values.help) return "read";
  let access: AnamnesisAccess = "read";
  const raise = (to: AnamnesisAccess) => { access = stricter(access, to); };
  if (values["include-sensitive"]) raise("sensitive-read");
  switch (command) {
    case "history": raise("sensitive-read"); break;
    case "add": if (values.sensitivity === "public") raise("write-owner"); else raise("write"); break;
    case "edit": raise(widens(values.sensitivity, values.status) ? "write-owner" : "write"); break;
    case "confirm": raise("write-owner"); break;
    case "reject": raise("write"); break;
    case "forget": raise("write"); break;
    case "sources": if (values.set) raise("write"); break;
    case "config": if (values.authors || values.roots) raise("write"); break;
    case "load": {
      if (values.run) raise("write");
      if (values["allow-sensitive-to-jev"]) raise("write-owner");
      break;
    }
    case "status": case "host": case "list": case "show": case "whoami": case "card": case "review": break;
    default: raise("write");
  }
  return access;
}
