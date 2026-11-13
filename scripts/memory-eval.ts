// Runs the memory evaluation on an extract file made by `bb lane-pilot memory-eval --export <file>`:
//   npx tsx scripts/memory-eval.ts --source /tmp/memeval-data/hub-extract.db [--sizes 30,300,3000] [--seed 1] [--json]
// The offline suite (cases H1-H7 on synthetic notes, no network, no hub data; exit 1 on a leak or a drop below the baseline):
//   npx tsx scripts/memory-eval.ts --suite [--json]
//   npx tsx scripts/memory-eval.ts --suite --write-baseline src/rooms/memory-eval/server/suite-baseline.json   (record a new baseline on purpose)
// Dry run of the end-to-end mode with a stand-in model; the real one needs the plugin (`bb lane-pilot memory-eval --e2e --project <id> --limit 20`):
//   npx tsx scripts/memory-eval.ts --e2e --stub --limit 12
// Public sets from files you downloaded first (commands in src/rooms/memory-eval/server/public-sets.ts):
//   npx tsx scripts/memory-eval.ts --longmemeval <longmemeval_s_cleaned.json> --factcons <factconsolidation.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { migrations } from "../src/rooms/migrations";
import { runMemoryEvalCommand } from "../src/rooms/memory-eval/server/command";

const result = await runMemoryEvalCommand(null, process.argv.slice(2), migrations, { io: { read: (path) => readFileSync(path, "utf8"), write: (path, text) => writeFileSync(path, text) } });
if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exit(result.exitCode);
