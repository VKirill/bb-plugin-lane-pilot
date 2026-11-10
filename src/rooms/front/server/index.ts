import { hostContract } from "../../contracts";
import { scheduleIsolated } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { listQaHosts } from "../../platform/server";
import { getRun, getRunWriterHost, hostActivityToday, loadProjectSettings, saveProjectSetting } from "../../storage";
import { runOnHost } from "@lane-pilot/host-calls";
import { FIRST_RUN_STEPS, HELPER_ROOTS, MUTATING_RPC, answerFirstRun, firstRunNeeded, firstRunSettings, helperDraft, parseHelper, peerLine, type FirstRunDraft, type FirstRunStep, type PeerSnapshot } from "../logic";

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
  // The peers' last snapshots live in memory only: age-labelled, dropped on restart, never stored (SMA m_mc_snapshot).
  const snapshots = new Map<string, PeerSnapshot>();
  const host = () => bb.hosts.experimental_client({ contract: hostContract });
  const runPlace = (runId: string) => {
    const run = getRun(db, runId);
    const hostId = getRunWriterHost(db, runId);
    if (!run?.writer_workspace_path || !hostId) throw new Error(`run ${runId} has no checkout`);
    return { cwd: run.writer_workspace_path, hostId };
  };

  async function firstRun(projectId: string) {
    const draft = ((await kv.get(draftKey(projectId))) as FirstRunDraft | undefined) ?? { projectId, answers: {}, at: Date.now() };
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

  /** Find the project's helpers and parse them: agent and skill definitions of the other tools (SMA m_im_scan). */
  async function helpers(runId: string) {
    const place = runPlace(runId);
    const listed = await host().call("listDocsPages", { requestedHostId: place.hostId, projectCwd: place.cwd, roots: [...HELPER_ROOTS], skipOversized: true }, { hostId: place.hostId, timeoutMs: 30_000 });
    return listed.pages.map((page) => parseHelper(page.path, page.content)).filter((row): row is NonNullable<typeof row> => !!row);
  }
  /** Take the chosen as drafts: each into its kind's forge folder; a draft that exists is never overwritten (the write is CAS on «absent»). */
  async function importHelpers(runId: string, names: readonly string[]) {
    const place = runPlace(runId);
    const chosen = (await helpers(runId)).filter((row) => names.includes(row.name));
    const results: Array<{ name: string; status: string }> = [];
    for (const helper of chosen) {
      const text = helperDraft(helper);
      const name = text.match(/^name: (.+)$/m)![1]!;
      const path = helper.kind === "skill" ? `.agents/forge/skills/${name}/SKILL.md` : `.agents/forge/roles/${name}/${name}.md`;
      const edits = [{ path, expectedSha256: null, content: text }];
      const written = await host().call("writeForgeDraft", { requestedHostId: place.hostId, projectCwd: place.cwd, previewSha256: await sha(JSON.stringify(edits)), edits }, { hostId: place.hostId, timeoutMs: 30_000 }).catch((cause: unknown) => ({ status: `failed: ${cause instanceof Error ? cause.message : String(cause)}` }));
      results.push({ name, status: written.status === "conflict" ? "kept: a draft with this name exists" : written.status });
    }
    return results;
  }

  /** Peers polled with every board: each connected host is asked its ordinary board (its subscription windows); a failure only marks
   * that peer's line and never breaks the rest (SMA m_mc_poll). A host BB no longer lists is forgotten — but an empty list is a failed
   * read and drops nothing (SMA m_sw_machine_row). */
  async function pollPeers(now = Date.now()) {
    const listed = await listQaHosts(bb);
    if (listed.length) for (const id of [...snapshots.keys()]) if (!listed.some((row) => row.id === id)) snapshots.delete(id);
    // All peers at once, each in its own try/catch: a machine that does not answer changes only its own line and delays nobody.
    await Promise.all(listed.map(async (row) => {
      const online = row.connected === true;
      const before = snapshots.get(row.id);
      const next: PeerSnapshot = { hostId: row.id, name: row.name ?? null, online, at: now, lastOnlineAt: online ? now : before?.lastOnlineAt ?? null };
      if (online) {
        try {
          next.windows = await host().call("readUsageWindows", { requestedHostId: row.id }, { hostId: row.id, timeoutMs: 5_000 });
          next.answered = true;
        } catch { next.answered = false; }
      }
      snapshots.set(row.id, next);
    }));
    return [...snapshots.values()];
  }
  async function peers() {
    const since = Date.now() - 86_400_000;
    return [...snapshots.values()].map((peer) => { const today = hostActivityToday(db, peer.hostId, since); return { ...peer, today, line: peerLine({ ...peer, today }) }; });
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
    const lines = ((await kv.get(ACTIONS)) as Array<{ at: number; action: string; keys: string[] }> | undefined) ?? [];
    lines.push({ at: Date.now(), action: name, keys: input && typeof input === "object" ? Object.keys(input as object).slice(0, 12) : [] });
    await kv.set(ACTIONS, lines.slice(-1000) as never);
  }
  const actions = async (limit = 100) => (((await kv.get(ACTIONS)) as unknown[] | undefined) ?? []).slice(-limit);

  return { front: { firstRun, firstRunAnswer, firstRunFinish, helpers, importHelpers, pollPeers, peers, coord, doorAudience, journal, actions } };
}
export type FrontApi = ReturnType<typeof createFront>["front"];

export function mountFront(ctx: ServerCore, api: FrontApi): void {
  // The snapshots live in memory only, so a fresh process asks once at once: the machines list is not empty until the first tick.
  void api.pollPeers().catch((cause: unknown) => ctx.log(`peers poll failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  scheduleIsolated(ctx.bb, "front-peers", "*/5 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.pollPeers().catch((cause: unknown) => ctx.log(`peers poll failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 60_000 });
}
