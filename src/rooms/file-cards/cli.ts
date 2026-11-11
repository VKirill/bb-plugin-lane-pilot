/**
 * `bb lane-pilot catalog` (SMA k_v_catalog): one card line per git-tracked file. `--write` stores them in the
 * catalog of the repository (same key, same builder and same limits as the session start's background build);
 * without it nothing leaves the terminal.
 */
import { resolve } from "node:path";

// Plain-source rule: the hook reaches this file through the index.
// @ts-expect-error TS5097
import { buildCatalog, collectCards } from "./build.ts";
// @ts-expect-error TS5097
import { findRepo } from "./store.ts";

export const CATALOG_USAGE = "bb lane-pilot catalog [--path DIR] [--write]";

type Result = { exitCode: number; stdout?: string; stderr?: string };

export function runCatalogCli(argv: readonly string[], cwd = process.cwd()): Result {
  try {
    const at = argv.indexOf("--path");
    const dir = resolve(at >= 0 && argv[at + 1] ? argv[at + 1]! : cwd);
    const warnings: string[] = [];
    let cards;
    if (argv.includes("--write")) {
      const built = buildCatalog(dir);
      if (!built.ok || !built.cards) return { exitCode: 1, stderr: built.message };
      cards = built.cards;
    } else {
      cards = collectCards(findRepo(dir)?.top ?? dir, { warn: (message) => warnings.push(message) }).cards;
    }
    if (!cards.length) return { exitCode: 1, stderr: `no git-tracked files under ${dir}` };
    const lines = cards.map((card) =>
      `${card.path} | ${card.lines} lines | ${card.language} | ${card.lastCommit ? card.lastCommit.slice(0, 8) : "-"} | ${card.headLine}`);
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, ...(warnings.length ? { stderr: `${warnings.join("\n")}\n` } : {}) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
