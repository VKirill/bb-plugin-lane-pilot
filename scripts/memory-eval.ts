// Runs the memory evaluation on an extract file made by `bb lane-pilot memory-eval --export <file>`:
//   npx tsx scripts/memory-eval.ts --source /tmp/memeval-data/hub-extract.db [--sizes 30,300,3000] [--seed 1] [--json]
import { migrations } from "../src/rooms/migrations";
import { runMemoryEvalCommand } from "../src/rooms/memory-eval/server/command";

const result = await runMemoryEvalCommand(null, process.argv.slice(2), migrations);
if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exit(result.exitCode);
