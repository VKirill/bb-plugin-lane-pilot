// The per-node evidence a batch agent authors for the four proofs of sma-parity-tz.md §4 (docs/sma-evidence.md):
//   mutation       — the shape-preserving mutation scripts/sma-mutate.mjs applies to prove the contract test is not hollow;
//   reach          — the class of normal input event that enters the node and the settings it needs (TZ 4.3);
//   trace          — where the hub's database (or a drill receipt) shows the node fired with the right result;
//   hollowAttested — a stage that never refused in 30 days CAN refuse: its mutation test on that commit (TZ §4а sign 6);
//   voidReview     — the recorded review of a `void` node: still void, or it is `have` after all.
// Everything is optional; tests/sma-evidence.test.ts validates node ids, setting keys and specs.
import type { TraceSource } from "../traces";

export type MutationKind = "flipped-branch" | "distorted-field" | "skipped-write" | "wrong-target";
export const MUTATION_KINDS: readonly MutationKind[] = ["flipped-branch", "distorted-field", "skipped-write", "wrong-target"];
/** `find` must occur exactly once in `file`; the runner replaces it with `replace` and the node's contract tests must fail. */
export type MutationSpec = { readonly file: string; readonly find: string; readonly replace: string; readonly kind: MutationKind };

/** A value a setting must have: the word (on/off folded), one of several words, anything but these, or any value at
 * all (a limit that does nothing while it is empty). */
export type NeedValue = string | readonly string[] | { readonly not: string | readonly string[] } | { readonly set: true };
export type ReachSpec = {
  /** The class of normal input event that enters this node (a task of size M, a failed check, the nightly schedule, …). */
  readonly entry?: string;
  /** Settings the node needs; checked against the hub's effective settings. */
  readonly needs?: Readonly<Record<string, NeedValue>>;
  /** Settings the node's function reads that do NOT gate it (silences an `undeclared gate`), with the reason. */
  readonly notGatedBy?: Readonly<Record<string, string>>;
  /** The entry was derived mechanically from the node's kind (a command, a door, a hook), not authored. */
  readonly seeded?: true;
};
export type HollowAttest = { readonly commit: string; readonly test: string };
export type VoidReview = { readonly verdict: "void" | "have"; readonly reason: string };

export type NodeEvidence = {
  readonly mutation?: MutationSpec;
  readonly reach?: ReachSpec;
  readonly trace?: TraceSource | readonly TraceSource[];
  readonly hollowAttested?: HollowAttest;
  readonly voidReview?: VoidReview;
};
/** One region's evidence, keyed by our node id (`nNNN`). */
export type RegionEvidence = Readonly<Record<string, NodeEvidence>>;

// ---- mutation constructors ----
/** The branch's condition turned the other way (`>=` → `<`, `&&` → `||`, `!x` → `x`). */
export const flip = (file: string, find: string, replace: string): MutationSpec => ({ file, find, replace, kind: "flipped-branch" });
/** A successful result with one field distorted (a wrong count, a wrong id, a wrong word). */
export const distort = (file: string, find: string, replace: string): MutationSpec => ({ file, find, replace, kind: "distorted-field" });
/** The write left out (the statement removed or commented); the caller still sees success. */
export const skipWrite = (file: string, find: string, replace = ""): MutationSpec => ({ file, find, replace, kind: "skipped-write" });
/** The right action on the wrong target (another row, another task, another file). */
export const wrongTarget = (file: string, find: string, replace: string): MutationSpec => ({ file, find, replace, kind: "wrong-target" });

// ---- reach constructors ----
/** Entered by this class of normal input event, needing these settings. */
export const entry = (inputClass: string, needs?: Readonly<Record<string, NeedValue>>): ReachSpec => ({ entry: inputClass, ...(needs ? { needs } : {}) });
/** Reached only through its control predecessors, needing these settings. */
export const via = (needs: Readonly<Record<string, NeedValue>>): ReachSpec => ({ needs });
/** A mechanically derived entry (scripts/sma-seed-evidence.ts): the node's kind is itself an input (a command, a door, a hook). */
export const seedEntry = (inputClass: string): ReachSpec => ({ entry: inputClass, seeded: true });
/** Anything but these words. */
export const not = (words: string | readonly string[]): NeedValue => ({ not: words });
/** Any value at all: the setting does nothing while it is empty (a limit, a target). */
export const isSet = (): NeedValue => ({ set: true });

// ---- review constructors ----
export const attested = (commit: string, test: string): HollowAttest => ({ commit, test });
/** The review found nothing for the card to guard here: void stays, with the reason. */
export const voidStays = (reason: string): VoidReview => ({ verdict: "void", reason });
/** The review found the card's purpose served elsewhere: the node becomes `have` in entries.ts, with the reason. */
export const voidIsHave = (reason: string): VoidReview => ({ verdict: "have", reason });

export { drill, gate, kv, outside, part, receipt, rows, rpc, schedule, settingRow, stage, taskField, transition, wfRun, wfStep } from "../traces";
export type { TraceSource } from "../traces";
