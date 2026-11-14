// Proof 2 of sma-parity-tz.md §4: the node's contract test is not hollow — a shape-preserving mutation of the node's
// code makes it fail by an assertion. scripts/sma-mutate.mjs runs the mutation and writes an attestation into
// attest/rNN.json (one file per region, merge-friendly); this module lints specs and reads attestations. A node is
// `mutated` only with a kill attestation whose spec hash matches its current spec and whose `find` still applies;
// an attestation whose file or test files changed since is `stale` (still counted, listed for a `--stale` rerun).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import a00 from "./attest/r00.json";
import a01 from "./attest/r01.json";
import a02 from "./attest/r02.json";
import a03 from "./attest/r03.json";
import a04 from "./attest/r04.json";
import a05 from "./attest/r05.json";
import a06 from "./attest/r06.json";
import a07 from "./attest/r07.json";
import a08 from "./attest/r08.json";
import a09 from "./attest/r09.json";
import a10 from "./attest/r10.json";
import a11 from "./attest/r11.json";
import a12 from "./attest/r12.json";
import a13 from "./attest/r13.json";
import a14 from "./attest/r14.json";
import a15 from "./attest/r15.json";
import a16 from "./attest/r16.json";
import a17 from "./attest/r17.json";
import a18 from "./attest/r18.json";
import a19 from "./attest/r19.json";
import a20 from "./attest/r20.json";
import a21 from "./attest/r21.json";
import a22 from "./attest/r22.json";
import a23 from "./attest/r23.json";
import a24 from "./attest/r24.json";
import a25 from "./attest/r25.json";
import a26 from "./attest/r26.json";
import a27 from "./attest/r27.json";
import a28 from "./attest/r28.json";
import { MUTATION_KINDS, type MutationSpec } from "./evidence/types";

export type MutationResult = "killed" | "survived" | "crash" | "baseline-red" | "no-tests" | "error";
/** What the runner recorded for one node. `file`/`tests` are sha256 (12) of the file's and the test files' content
 * before the mutation; `spec` is specHash of the spec it ran. */
export type Attestation = { spec: string; kind: string; file: string; tests: Readonly<Record<string, string>>; commit: string; result: MutationResult; at: string; detail?: string };

export const SMA_ATTEST_BY_REGION = [a00, a01, a02, a03, a04, a05, a06, a07, a08, a09, a10, a11, a12, a13, a14, a15, a16, a17, a18, a19, a20, a21, a22, a23, a24, a25, a26, a27, a28] as unknown as ReadonlyArray<Readonly<Record<string, Attestation>>>;
export const SMA_ATTEST: Readonly<Record<string, Attestation>> = Object.assign({}, ...SMA_ATTEST_BY_REGION);

const sha12 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex").slice(0, 12);
/** The hash an attestation names its spec by: file, find, replace and kind. */
export const specHash = (spec: MutationSpec) => sha12(JSON.stringify([spec.file, spec.find, spec.replace, spec.kind]));
export const contentHash = sha12;

const occurrences = (text: string, find: string) => { let n = 0; for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) n++; return n; };

/** Why a spec cannot be run as a shape-preserving mutation: [] when it is fine. Static: the replacement may not be or
 * introduce null/undefined/throw/an empty return/a deleted body; `skipped-write` may drop one statement (empty or a
 * comment); with `root`, `find` must occur exactly once in the file. */
export function lintMutation(spec: MutationSpec, root?: string): string[] {
  const problems: string[] = [];
  if (!MUTATION_KINDS.includes(spec.kind)) problems.push(`kind «${spec.kind}» is not one of ${MUTATION_KINDS.join(", ")}`);
  if (!spec.file || /^\/|\.\.(?:\/|$)/.test(spec.file) || /^tests\/|\.test\.tsx?$/.test(spec.file)) problems.push(`file «${spec.file}» must be a source file of this repository, not a test`);
  if (!spec.find.trim()) problems.push("find is empty");
  if (spec.find === spec.replace) problems.push("replace equals find");
  const added = (word: RegExp) => word.test(spec.replace) && !word.test(spec.find);
  if (added(/\bnull\b/)) problems.push("replace introduces null — keep the result's shape (a wrong value, not no value)");
  if (added(/\bundefined\b/)) problems.push("replace introduces undefined — keep the result's shape");
  if (added(/\bthrow\b/)) problems.push("replace introduces throw — a crash is not a kill");
  if (added(/\breturn\s*(?:;|\}|$)/m)) problems.push("replace introduces an empty return");
  if (added(/\bvoid\s+0\b/)) problems.push("replace introduces void 0 (undefined)");
  const blank = spec.replace.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
  if (!blank) {
    if (spec.kind !== "skipped-write") problems.push("an empty replace only fits skipped-write");
    else if (spec.find.trim().split("\n").length > 3 || /\breturn\b|\bfunction\b|=>\s*\{/.test(spec.find)) problems.push("skipped-write drops one write statement, not a return, a function or a block");
  }
  if (/\{[\s\S]{40,}\}/.test(spec.find) && /^\s*\{\s*\}\s*$/.test(blank)) problems.push("replace deletes the whole body");
  if (spec.find.split("\n").length >= 4 && blank.length < spec.find.trim().length * 0.25) problems.push("replace drops most of the code it finds — mutate one branch, field, write or target");
  if (root) {
    let text: string | null = null;
    try { text = readFileSync(join(root, spec.file), "utf8"); } catch { problems.push(`no file ${spec.file}`); }
    if (text !== null) { const n = occurrences(text, spec.find); if (n !== 1) problems.push(`find occurs ${n} times in ${spec.file} (must be exactly once)`); }
  }
  return problems;
}

export type MutationState = { mutated: boolean; stale: boolean | null; result: MutationResult | null; why: string };

/** Whether a node counts as mutated: a kill attestation of its current spec whose `find` still applies (judged with
 * `root`, a source checkout; on the hub the attestation's spec hash is all there is). `stale`: the file or a test file
 * changed since the attestation (null when not judged). */
export function mutationState(spec: MutationSpec | undefined, attestation: Attestation | undefined, root: string, testFiles: readonly string[] = []): MutationState {
  if (!spec) return { mutated: false, stale: null, result: null, why: "no mutation spec" };
  if (!attestation) return { mutated: false, stale: null, result: null, why: "no attestation: run npm run sma:mutate -- --node <id>" };
  if (attestation.spec !== specHash(spec)) return { mutated: false, stale: true, result: attestation.result, why: "the spec changed since the attestation" };
  if (attestation.result !== "killed") return { mutated: false, stale: null, result: attestation.result, why: `the mutation was not killed: ${attestation.result}${attestation.detail ? ` — ${attestation.detail}` : ""}` };
  if (!root) return { mutated: true, stale: null, result: "killed", why: "killed (not re-judged: no sources here)" };
  let text: string;
  try { text = readFileSync(join(root, spec.file), "utf8"); } catch { return { mutated: false, stale: true, result: "killed", why: `no file ${spec.file}` }; }
  if (occurrences(text, spec.find) !== 1) return { mutated: false, stale: true, result: "killed", why: "find no longer applies exactly once" };
  const changedFile = contentHash(text) !== attestation.file;
  const changedTests = testFiles.filter((file) => { try { return contentHash(readFileSync(join(root, file), "utf8")) !== attestation.tests[file]; } catch { return true; } });
  return { mutated: true, stale: changedFile || changedTests.length > 0, result: "killed", why: changedFile || changedTests.length ? `killed, stale: ${[changedFile ? spec.file : "", ...changedTests].filter(Boolean).join(", ")} changed since` : "killed" };
}
