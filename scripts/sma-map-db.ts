/**
 * Dev harness: `bb lane-pilot sma-map …` against a copy of a plugin database (read only), as the hub would run it with
 * --live — for designing and checking node-level traces, reachability and the hollow signs on a snapshot.
 *   npx tsx scripts/sma-map-db.ts <data.db> [--now <ms|ISO>] --states|--gaps|--hollow [--days N] [--json] [--region N]
 * Without --live in the arguments it is added; --now pins the window's end (a snapshot taken earlier).
 */
import Database from "better-sqlite3";
import { runSmaLiveCli } from "../src/rooms/sma-map";

const [dbPath, ...rest] = process.argv.slice(2);
if (!dbPath) { process.stderr.write("usage: npx tsx scripts/sma-map-db.ts <data.db> [--now <ms|ISO>] --states|--gaps|--hollow [--days N] [--json]\n"); process.exit(2); }
const at = rest.indexOf("--now");
const nowArg = at >= 0 ? rest.splice(at, 2)[1] : undefined;
const now = nowArg === undefined ? Date.now() : /^\d+$/.test(nowArg) ? Number(nowArg) : Date.parse(nowArg);
const args = rest.includes("--live") ? rest : ["--live", ...rest];
const result = runSmaLiveCli(new Database(dbPath, { readonly: true, fileMustExist: true }) as never, args, now);
if (result.stdout) process.stdout.write(`${result.stdout}\n`);
if (result.stderr) process.stderr.write(`${result.stderr}\n`);
process.exitCode = result.exitCode;
