/**
 * `bb lane-pilot catalog` (SMA k_v_catalog): one card line per git-tracked file. `--write` stores
 * them in the catalog; without it nothing leaves the terminal.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildFileCard, type FileCard } from "./card";
import { collectGitFacts, trackedFiles } from "./git";
import { writeCatalog } from "./store";

export const CATALOG_USAGE = "bb lane-pilot catalog [--path DIR] [--write]";

type Result = { exitCode: number; stdout?: string; stderr?: string };

export function runCatalogCli(argv: readonly string[], cwd = process.cwd()): Result {
  try {
    const at = argv.indexOf("--path");
    const dir = resolve(at >= 0 && argv[at + 1] ? argv[at + 1]! : cwd);
    const paths = trackedFiles(dir);
    if (!paths.length) return { exitCode: 1, stderr: `no git-tracked files under ${dir}` };
    const facts = collectGitFacts(dir, paths);
    const cards: FileCard[] = [];
    for (const path of paths) {
      let bytes: Buffer;
      try { bytes = readFileSync(resolve(dir, path)); } catch { continue; }
      cards.push(buildFileCard({ path, bytes, git: facts.get(path) }));
    }
    if (argv.includes("--write")) writeCatalog(dir, cards);
    const lines = cards.map((card) =>
      `${card.path} | ${card.lines} lines | ${card.language} | ${card.lastCommit ? card.lastCommit.slice(0, 8) : "-"} | ${card.headLine}`);
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
