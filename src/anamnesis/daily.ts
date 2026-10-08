import { madridDay, madridHour, type ExtractReport, type createExtractConsumer } from "./extract";
import { lpRunRecords, DEFAULT_LOOKBACK_DAYS } from "./load";
import type { Hub } from "./hub";
import type { Source } from "./model";
import { HOST_SOURCES, type CollectResponse, type HostSource, type UpsertSummary } from "./ops";
import { collectOwnerMessages, type OwnerMessage, type OwnerMessageHub, type ThreadsPort } from "./owner-messages";

/**
 * The daily pass (A4), 04:00 Europe/Madrid. It does what the first load does, but only for what is new and only while the owner has
 * switched automatic learning on (`config.extract`): the machine's sources are read again (git, journal, registry, memories and the
 * source the owner turned on), Lane Pilot's runs refresh their projects, and the owner's messages since the last pass go through the
 * shared owner-message hub, where this layer's consumer (src/anamnesis/extract.ts) and any other layer take their share.
 * It keeps a receipt: the report is stored on the owner's machine (`load_report`, mode `daily`) and the tab shows it.
 */
const DAY = 86_400_000;
/** The first pass reads a week back; a pass that was missed catches up, but never more than a month (older messages are the first load's job). */
export const FIRST_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 30;
export const PASS_HOUR = 4;
export const DAILY_KEY = "anamnesis:daily";

export type DailyDeps = {
  hub: Pick<Hub, "ask" | "config" | "kv">;
  threads: ThreadsPort;
  owner: OwnerMessageHub;
  /** The consumer subscribed to `owner`: its last report is what this pass's messages did. */
  consumer: ReturnType<typeof createExtractConsumer>;
  projectNames(): Promise<Map<string, string>>;
  lpRuns(): Array<{ id: string; projectId: string; createdAt: number }>;
  now(): number;
};

export type DailyReport = {
  at: number; ran: boolean; note?: string;
  hostSources: CollectResponse["sources"];
  lpRuns: { runs: number; projects: number; stored: UpsertSummary | null } | null;
  messages: { window: { from: number; to: number }; total: number; delivered: string[]; failed: Array<{ name: string; error: string }>; extract: ExtractReport | null } | null;
  checkpointAdvanced: boolean;
};

export async function dailyPass(deps: DailyDeps, options: { signal?: AbortSignal | undefined } = {}): Promise<DailyReport> {
  const at = deps.now();
  const report: DailyReport = { at, ran: false, hostSources: [], lpRuns: null, messages: null, checkpointAdvanced: false };
  const config = await deps.hub.config();
  if (config.extract !== true) { report.note = "automatic learning is switched off"; return report; }
  report.ran = true;
  const status = await deps.hub.ask({ op: "status" });
  const enabled = new Map(status.sources.map((source) => [source.source as Source, source.enabled]));

  /* ---- the machine's sources, whole window: their records carry counts that a part-window would overwrite ---- */
  const hostWanted = HOST_SOURCES.filter((source): source is HostSource => enabled.get(source) !== false);
  if (hostWanted.length) {
    report.hostSources = (await deps.hub.ask({ op: "collect", mode: "run", sources: hostWanted, ...(config.roots ? { roots: config.roots } : {}), ...(config.authors ? { authors: config.authors } : {}), since: at - DEFAULT_LOOKBACK_DAYS * DAY, until: at }, 600_000)).sources;
  }
  options.signal?.throwIfAborted();

  /* ---- Lane Pilot's runs ---- */
  if (enabled.get("lp-runs") !== false) {
    const names = await deps.projectNames().catch(() => new Map<string, string>());
    const { records, runs, projects } = lpRunRecords(deps.lpRuns(), at - DEFAULT_LOOKBACK_DAYS * DAY, at, (id) => names.get(id) ?? id);
    const stored = records.length ? await deps.hub.ask({ op: "upsert", actor: "auto:lp-runs", reason: "daily pass: Lane Pilot runs", records, checkpoint: { source: "lp-runs", at } }) : null;
    report.lpRuns = { runs, projects, stored };
  }

  /* ---- the owner's messages since the last pass ---- */
  if (enabled.get("bb-message") !== false) {
    const checkpoint = status.sources.find((source) => source.source === "bb-message")?.checkpoint ?? null;
    const from = checkpoint === null ? at - FIRST_WINDOW_DAYS * DAY : Math.max(checkpoint, at - MAX_WINDOW_DAYS * DAY);
    let batch: OwnerMessage[] = [];
    if (from < at) batch = await collectOwnerMessages(deps.threads, from, at, options.signal);
    const delivery = await deps.owner.deliver(batch, { live: false, window: { from, to: at } });
    const extract = delivery.delivered.includes("anamnesis") ? deps.consumer.last() : null;
    report.messages = { window: { from, to: at }, total: batch.length, delivered: delivery.delivered, failed: delivery.failed, extract };
    // The window closes only when every message in it was judged; otherwise the next pass reads it again (judged ones are skipped).
    const ours = delivery.failed.every((failure) => failure.name !== "anamnesis");
    if (!batch.length || (ours && extract?.complete)) {
      await deps.hub.ask({ op: "upsert", actor: "auto:bb-message", reason: "daily pass: window read", records: [], checkpoint: { source: "bb-message", at } });
      report.checkpointAdvanced = true;
    }
  }

  await deps.hub.ask({ op: "load_report", mode: "daily", report: report as unknown as Record<string, unknown> }).catch(() => undefined);
  return report;
}

/** Whether the scheduled tick should run the pass now: it is past 04:00 in Madrid and no pass has run for this Madrid day. */
export async function dailyDue(hub: Pick<Hub, "kv">, now: number): Promise<boolean> {
  if (madridHour(now) < PASS_HOUR) return false;
  const last = await hub.kv.get<{ day?: string }>(DAILY_KEY);
  return last?.day !== madridDay(now);
}

export const markDailyDone = async (hub: Pick<Hub, "kv">, now: number): Promise<void> => { await hub.kv.set(DAILY_KEY, { day: madridDay(now) } as never); };
