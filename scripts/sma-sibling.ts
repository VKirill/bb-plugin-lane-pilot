/**
 * Sibling repositories of the SMA proof (src/rooms/sma-map/siblings.ts, docs/sma-evidence.md «Proofs in a sibling repository»).
 *   npx tsx scripts/sma-sibling.ts status      where each sibling resolves, its HEAD and branch, the pins, and whether the
 *                                              mutation runner may write there
 * There is no setup: the proofs live in each sibling's PRIMARY checkout (owner, 2026-11-15), so nothing is created here.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SMA_SIBLING_TESTS_AT } from "../src/rooms/sma-map/contracts";
import SMA_PROVENANCE from "../src/rooms/sma-map/provenance.json";
import { headOf, isDirty } from "../src/rooms/sma-map/sibling-git";
import { refuseMutation, resolveSibling, SIBLING_NAMES, SIBLINGS, type SiblingName } from "../src/rooms/sma-map/siblings";

const root = join(import.meta.dirname, "..");
const say = (line: string) => process.stdout.write(`${line}\n`);
const tryGit = (cwd: string, ...args: string[]) => { try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };

function status(): number {
  for (const name of SIBLING_NAMES) {
    const at = resolveSibling(name, root);
    const pins = `contracts pin ${SMA_SIBLING_TESTS_AT[name] ?? "none"}, provenance pin ${(SMA_PROVENANCE as { siblingsAt?: Partial<Record<SiblingName, string>> }).siblingsAt?.[name] ?? "none"}`;
    if (at.root === null) { say(`${name.padEnd(9)} ${at.why}; ${pins}`); continue; }
    const mutation = refuseMutation(name, at.root, ".", root) ?? `may mutate here (on ${SIBLINGS[name].branch}, inside the coordinator's window)`;
    say(`${name.padEnd(9)} ${SIBLINGS[name].repo} at ${at.root} (${at.from}); HEAD ${headOf(at.root)}${isDirty(at.root) ? "+dirty" : ""} on ${tryGit(at.root, "branch", "--show-current") || "(detached)"}; ${pins}; ${mutation}`);
  }
  return 0;
}

if (process.argv[2] === "status") process.exit(status());
say("usage: npx tsx scripts/sma-sibling.ts status");
process.exit(2);
