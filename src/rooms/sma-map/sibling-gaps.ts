// What `--gaps` prints for a node whose proof lives in a sibling repository (siblings.ts): where its code and its tests are,
// whether that sibling is on this machine, and how to get a worktree to write the proof in. A sibling anchor is never
// «nothing to do»: the node needs its four proofs like any other (docs/sma-evidence.md «Proofs in a sibling repository»).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SMA_CONTRACT_TESTS } from "./contracts";
import { siblingAnchorSpan } from "./provenance";
import { absentSibling, SIBLINGS, splitSiblingPath, type SiblingName } from "./siblings";

export type SiblingAnchor = {
  sibling: SiblingName; repo: string; file: string; symbol?: string; lines: number;
  /** The checkout the tools read here, or null when the sibling is absent (`absent` says so). */
  root: string | null; absent?: string;
  /** The card's `[sma:<id>]` tests already in that sibling. */
  tests: string[];
  /** Where a new test goes and how a batch agent gets a worktree for it. */
  next: string;
  /** The hub plugin the node needs enabled (the Telegram plugin), when the sibling is a plugin. */
  hubPlugin?: string;
  flag?: string;
};

/** The sibling anchor of `proof`, or null for a local one. */
export function siblingAnchor(proof: string | undefined, smaId: string, roots: Partial<Record<SiblingName, string>>): SiblingAnchor | null {
  if (!proof) return null;
  const { sibling, path: rest } = splitSiblingPath(proof);
  if (!sibling) return null;
  const spec = SIBLINGS[sibling];
  const [where, symbol] = rest.split("#", 2) as [string, string | undefined];
  const file = where.replace(/:\d+$/, "");
  const root = roots[sibling] ?? null;
  const tests = (SMA_CONTRACT_TESTS[smaId] ?? []).filter((line) => line.startsWith(`${sibling}:`));
  let lines = 0;
  let flag: string | undefined;
  if (root) {
    const full = join(root, file);
    if (!existsSync(full)) flag = "the anchor file does not exist in the sibling";
    else if (statSync(full).isDirectory()) flag = "the anchor is a folder: point it at the component file the card describes";
    else lines = (() => { const span = siblingAnchorSpan(readFileSync(full, "utf8"), symbol || undefined); return span.end - span.start + 1; })();
  }
  const testHome = sibling === "core" ? `${file.split("/").slice(0, 2).join("/")}/…/<name>.test.ts beside the code` : "test/<name>.test.ts";
  return {
    sibling, repo: spec.repo, file: `${sibling}:${file}`, ...(symbol ? { symbol } : {}), lines, root, ...(root ? {} : { absent: absentSibling(sibling) }), tests,
    next: `npm run sma:sibling -- setup ${sibling} --id <batch id>; write the [sma:${smaId}] test in ${spec.repo} (${testHome}), commit it on ${spec.proofBranch}-<batch id>; ${spec.env}=<that worktree> npm run sma:mutate -- --node <id>`,
    ...(spec.hubPlugin ? { hubPlugin: spec.hubPlugin } : {}), ...(flag ? { flag } : {}),
  };
}
