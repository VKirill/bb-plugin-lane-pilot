/**
 * Records the shapes (keys and types, never values) of real BB answers the tests fake, into tests/fixtures/real-shapes/<name>.json.
 *   npx tsx scripts/record-real-shapes.ts
 * Needs the bb CLI reaching the hub. tests/twins.test.ts compares the tests' doubles with these records (SMA Q13).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shapeOf } from "../src/rooms/twins";

const env = { ...process.env };
delete env.BB_CLI;
const bb = (...args: string[]) => JSON.parse(execFileSync("bb", args, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 })) as unknown;
const first = (value: unknown, key: string) => (Array.isArray(value) ? value : ((value as Record<string, unknown>)?.[key] as unknown[] | undefined) ?? []);
const SANDBOX = "proj_3tb652jpsi";

const threads = first(bb("thread", "list", "--project", SANDBOX, "--json"), "threads");
const threadId = (threads[0] as { id?: string } | undefined)?.id;
const records: Record<string, unknown> = {
  "providers.list": bb("provider", "list", "--json"),
  "plugins.list": first(bb("plugin", "list", "--json"), "plugins"),
  // The CLI wraps the thread ({thread, environment, …}); the SDK's threads.get answers the thread itself.
  ...(threadId ? { "threads.get": (bb("thread", "show", threadId, "--json") as { thread?: unknown }).thread } : {}),
};
const dir = join(import.meta.dirname, "../tests/fixtures/real-shapes");
mkdirSync(dir, { recursive: true });
for (const [name, value] of Object.entries(records)) {
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ name, recordedAt: new Date().toISOString(), shape: shapeOf(value) }, null, 2)}\n`);
  console.log(`recorded ${name}`);
}
