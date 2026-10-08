/**
 * Read-only dry run of the anamnesis loader against the real data of THIS machine (the Mac mini). It uses the same code as
 * `bb lane-pilot anamnesis load` in plan mode: the host sources are read by `collectSources` (plan: counts only, in-memory store,
 * no file is created), BB's history by the same collector over the `bb thread` CLI. It never calls Jev and never prints content:
 * only counts.
 *
 *   npx esbuild scripts/anamnesis-dry-run.ts --bundle --platform=node --format=esm --outfile=/tmp/anamnesis-dry-run.mjs \
 *     && LANE_PILOT_ANAMNESIS_DIR=/tmp/anamnesis-dry-run-nothing node /tmp/anamnesis-dry-run.mjs [--since YYYY-MM-DD]
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { anamnesisHandler } from "../src/rooms/anamnesis/host";
import { createHub } from "../src/rooms/anamnesis/hub";
import { formatReport, loadAnamnesis } from "../src/rooms/anamnesis/load";
import { TURN_REQUESTED, isOwnerThread, type EventLike, type ThreadLike, type ThreadsPort } from "../src/rooms/anamnesis/owner-messages";
import { anamnesisDbPath } from "../src/rooms/anamnesis/store";

const bb = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile("bb", args, { maxBuffer: 512 * 1024 * 1024, timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) await work(items[next++]!); }));
}

async function cliPort(): Promise<ThreadsPort> {
  const listed = [...JSON.parse(await bb(["thread", "list", "--json"])) as ThreadLike[], ...JSON.parse(await bb(["thread", "list", "--json", "--archived"])) as ThreadLike[]];
  const unique = [...new Map(listed.map((thread) => [thread.id, thread])).values()];
  const owner = unique.filter(isOwnerThread);
  const events = new Map<string, EventLike[]>();
  await pool(owner, 6, async (thread) => {
    try {
      const all = JSON.parse(await bb(["thread", "log", thread.id, "--json", "--all"])) as EventLike[];
      events.set(thread.id, all.filter((event) => event.type === TURN_REQUESTED));
    } catch { events.set(thread.id, []); }
  });
  console.error(`dry run: ${unique.length} threads listed, ${owner.length} are the owner's top-level threads`);
  return {
    listThreads: async ({ offset, limit }) => unique.slice(offset, offset + limit),
    listEvents: async ({ threadId, beforeSeq, limit }) => (events.get(threadId) ?? []).filter((event) => beforeSeq === undefined || event.seq < beforeSeq).sort((a, b) => b.seq - a.seq).slice(0, limit),
  };
}

async function main() {
  if (existsSync(anamnesisDbPath())) throw new Error(`a store already exists at ${anamnesisDbPath()}; point LANE_PILOT_ANAMNESIS_DIR at an empty place for a clean dry run`);
  const sinceArg = process.argv.indexOf("--since");
  const since = sinceArg > 0 ? Date.parse(`${process.argv[sinceArg + 1]}T00:00:00Z`) : undefined;
  const hub = createHub({
    hostCall: async (hostId, request) => (await anamnesisHandler({ requestedHostId: hostId, request })).response,
    listHosts: async () => [{ id: "this-machine", name: "Mac mini", connected: true }],
    kv: { get: async () => null, set: async () => undefined },
  });
  const report = await loadAnamnesis({
    hub, threads: await cliPort(), now: Date.now,
    projectNames: async () => new Map(),
    lpRuns: () => [],
  }, { mode: "plan", ...(since !== undefined ? { since } : {}), classify: false });
  console.log(formatReport(report));
  console.log(JSON.stringify({ hostSources: report.hostSources.map((s) => ({ source: s.source, items: s.items, records: s.records, byKind: s.byKind, bySensitivity: s.bySensitivity, reasons: s.reasons, note: s.note, error: s.error })), messages: report.messages && { ...report.messages, byMonth: report.messages.byMonth }, cost: report.cost }, null, 1));
  console.log(`store file created: ${existsSync(anamnesisDbPath())}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
