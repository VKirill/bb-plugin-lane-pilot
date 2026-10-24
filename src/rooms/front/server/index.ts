import { hostContract } from "../../contracts";
import { scheduleIsolated, type ServerCore } from "../../core/server";
import { mapListedQaHosts } from "../../qa";
import { getRun, getRunWriterHost, loadProjectSettings, saveProjectSetting } from "../../storage";
import { runOnHost } from "@lane-pilot/host-calls";
import { FIRST_RUN_STEPS, MUTATING_RPC, answerFirstRun, firstRunNeeded, firstRunSettings, helperDraft, parseHelper, peerLine, type FirstRunDraft, type FirstRunStep, type PeerSnapshot } from "../logic";

const PEERS = "lp.front.peers";
const ACTIONS = "lp.front.actions";
const draftKey = (projectId: string) => `lp.front.first-run:${projectId}`;
const sha = async (text: string) => (await import("node:crypto")).createHash("sha256").update(text).digest("hex");

/**
 * The front's server half: the first-run interview (four steps into a draft, then the one profile writer), the project's own helpers taken
 * as forge drafts (a name never overwrites), the peers' last snapshots (polled with the board every five minutes), terminal coordination
 * and who can see the door, read through the machines; and the action journal — one line per call that changes something.
 */
export function createFront(ctx: ServerCore) {
  const { db, bb } = ctx;
  const kv = bb.storage.kv;
  const host = () => bb.hosts.experimental_client({ contract: hostContract });
  const runPlace = (runId: string) => {
    const run = getRun(db, runId);
    const hostId = getRunWriterHost(db, runId);
    if (!run?.writer_workspace_path || !hostId) throw new Error(`run ${runId} has no checkout`);
    return { cwd: run.writer_workspace_path, hostId };
  };

  async function firstRun(projectId: string) {
    const draft = ((await kv.get(draftKey(projectId)).catch(() => null)) as FirstRunDraft | null) ?? { projectId, answers: {}, at: Date.now() };
    return { needed: firstRunNeeded(loadProjectSettings(db, projectId), draft), steps: FIRST_RUN_STEPS, draft };
  }
  async function firstRunAnswer(projectId: string, step: FirstRunStep, answer: string) {
    const draft = answerFirstRun((await firstRun(projectId)).draft, step, answer);
    await kv.set(draftKey(projectId), draft as never);
    return draft;
  }
  /** The one profile writer: the finished draft becomes the project's settings here and nowhere else. */
  async function firstRunFinish(projectId: string) {
    const { draft } = await firstRun(projectId);
    const settings = firstRunSettings(draft);
    for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, projectId, key, value);
    if (draft.answers.goal) saveProjectSetting(db, projectId, "project.goal", draft.answers.goal);
    await kv.set(draftKey(projectId), { ...draft, done: Date.now() } as never);
    return { written: Object.keys(settings), goal: Boolean(draft.answers.goal) };
  }

  /** Find the project's helpers and parse them (Claude Code and OpenCode agents, Codex agents). */
  async function helpers(runId: string) {
    const place = runPlace(runId);
    const listed = await host().call("listDocsPages", { requestedHostId: place.hostId, projectCwd: place.cwd, roots: [".claude/agents", ".opencode/agent", ".opencode/agents", ".codex/agents"] }, { hostId: place.hostId, timeoutMs: 30_000 });
    return listed.pages.map((page) => parseHelper(page.path, page.content)).filter((row): row is NonNullable<typeof row> => !!row);
  }
  /** Take the chosen as drafts: each into .agents/forge/roles/<name>/; a draft that exists is never overwritten (the write is CAS on «absent»). */
  async function importHelpers(runId: string, names: readonly string[]) {
    const place = runPlace(runId);
    const chosen = (await helpers(runId)).filter((row) => names.includes(row.name));
    const results: Array<{ name: string; status: string }> = [];
    for (const helper of chosen) {
      const text = helperDraft(helper);
      const name = text.match(/^name: (.+)$/m)![1]!;
      const edits = [{ path: `.agents/forge/roles/${name}/${name}.md`, expectedSha256: null, content: text }];
      const written = await host().call("writeForgeDraft", { requestedHostId: place.hostId, projectCwd: place.cwd, previewSha256: await sha(JSON.stringify(edits)), edits }, { hostId: place.hostId, timeoutMs: 30_000 }).catch((cause: unknown) => ({ status: `failed: ${cause instanceof Error ? cause.message : String(cause)}` }));
      results.push({ name, status: written.status === "conflict" ? "kept: a draft with this name exists" : written.status });
    }
    return results;
  }

  /** Peers polled with every board: the hosts BB knows, each with its last snapshot (Last snapshot of a peer). */
  async function pollPeers(now = Date.now()) {
    const listed = mapListedQaHosts(await (bb.sdk as unknown as { hosts: { list: () => Promise<unknown> } }).hosts.list().catch(() => []));
    const before = ((await kv.get(PEERS).catch(() => null)) as Record<string, PeerSnapshot> | null) ?? {};
    const next: Record<string, PeerSnapshot> = { ...before };
    for (const row of listed) {
      const online = row.connected === true;
      next[row.id] = { hostId: row.id, name: row.name ?? null, online, at: now, lastOnlineAt: online ? now : before[row.id]?.lastOnlineAt ?? null };
    }
    await kv.set(PEERS, next as never);
    return Object.values(next);
  }
  async function peers() {
    const known = Object.values(((await kv.get(PEERS).catch(() => null)) as Record<string, PeerSnapshot> | null) ?? {});
    return known.map((peer) => ({ ...peer, line: peerLine(peer) }));
  }

  /** Terminal coordination in the window: the claims of the run's checkout, and clearing one with a reason. */
  async function coord(runId: string, clear?: { session: string; reason: string }) {
    const place = runPlace(runId);
    const command = clear ? `lane-coord force-clear '${clear.session.replace(/[^A-Za-z0-9_.:-]/g, "")}' --reason '${clear.reason.replace(/'/g, "")}'` : "lane-coord status";
    const ran = await runOnHost(host(), { hostId: place.hostId, cwd: place.cwd, command, timeoutSec: 20 });
    return { exitCode: ran.exitCode, output: ran.stdout.slice(0, 20_000) || ran.stderr.slice(0, 2000) };
  }

  /** Who can see the door: the machines enrolled with the hub and how the hub is reached. */
  async function doorAudience() {
    return { door: process.env.BB_PUBLIC_URL ?? "the BB hub", reachedOver: "WireGuard (no public bb connect)", machines: (await peers()).map((peer) => peer.line) };
  }

  /** One action — one line: every RPC call that changes something leaves its name, its argument keys and the time. */
  async function journal(name: string, input: unknown) {
    if (!MUTATING_RPC.test(name)) return;
    const lines = ((await kv.get(ACTIONS).catch(() => null)) as Array<{ at: number; action: string; keys: string[] }> | null) ?? [];
    lines.push({ at: Date.now(), action: name, keys: input && typeof input === "object" ? Object.keys(input as object).slice(0, 12) : [] });
    await kv.set(ACTIONS, lines.slice(-1000) as never);
  }
  const actions = async (limit = 100) => (((await kv.get(ACTIONS).catch(() => null)) as unknown[] | null) ?? []).slice(-limit);

  return { front: { firstRun, firstRunAnswer, firstRunFinish, helpers, importHelpers, pollPeers, peers, coord, doorAudience, journal, actions } };
}
export type FrontApi = ReturnType<typeof createFront>["front"];

export function mountFront(ctx: ServerCore, api: FrontApi): void {
  scheduleIsolated(ctx.bb, "front-peers", "*/5 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.pollPeers().catch((cause: unknown) => ctx.log(`peers poll failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 60_000 });
}
