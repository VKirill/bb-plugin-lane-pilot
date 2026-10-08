import { createHash } from "node:crypto";
import { SENSITIVE_FROM, type FragmentDecision } from "./judgment";
import type { Hub } from "./hub";
import { scrubQuote, sensitiveReason, type Source } from "./model";
import type { CollectResponse, HostSource, UpsertSummary } from "./ops";
import { HOST_SOURCES } from "./ops";
import { messageEvidence, scanOwnerMessages, type OwnerMessage, type ThreadsPort } from "./owner-messages";
import { monthOf, spread } from "./sources/common";

/**
 * The first load (A3). It reads everything the owner's machines and BB already hold, makes a draft anamnesis and shows the owner
 * what it found. Nothing is mixed into any agent's context: records stay `draft` or `candidate` until the owner confirms them.
 *
 * `plan` (the default) changes nothing and sends nothing outside: it counts, and prices the optional Jev pass.
 * `run` stores drafts. Classifying messages with Jev is a separate switch (`classify`), because that is the only step that
 * sends message text to a third party; a message that local word rules call sensitive is held back unless the owner allows it.
 */
export const JEV_TOKENS_PER_MESSAGE = 1_100;
export const MIN_CLASSIFY_CHARS = 30;
export const MAX_CLASSIFY_CHARS = 1_500;
const JEV_BATCH = 20;
const DAY = 86_400_000;
export const DEFAULT_LOOKBACK_DAYS = 365;

export type LoadDeps = {
  hub: Hub;
  threads: ThreadsPort;
  /** BB project id to its name. */
  projectNames(): Promise<Map<string, string>>;
  /** Lane Pilot runs, for a project's activity. */
  lpRuns(): Array<{ id: string; projectId: string; createdAt: number }>;
  /** Asks Jev about masked fragments; null for one it could not judge. Absent: no classification possible. */
  judge?(texts: string[], signal?: AbortSignal): Promise<Array<FragmentDecision | null>>;
  now(): number;
};

export type LoadOptions = {
  mode: "plan" | "run"; since?: number; sources?: readonly Source[];
  classify?: boolean; maxClassify?: number; allowSensitiveToJev?: boolean; signal?: AbortSignal | undefined;
};

export type LoadReport = {
  mode: "plan" | "run";
  window: { from: number; to: number };
  hostSources: CollectResponse["sources"];
  messages: null | {
    enabled: boolean; threads: number; total: number; characters: number; projects: number; byMonth: Record<string, number>;
    tooShort: number; heldBackSensitive: number; eligibleForJev: number;
  };
  lpRuns: null | { enabled: boolean; runs: number; projects: number };
  hubRecords: null | { records: number; stored: UpsertSummary | null };
  classify: null | { requested: boolean; asked: number; kept: number; nothing: number; unavailable: number; stored: UpsertSummary | null; note?: string };
  cost: { jevMessages: number; estimatedTokens: number; perMessage: number; note: string };
  review: string;
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

export async function loadAnamnesis(deps: LoadDeps, options: LoadOptions): Promise<LoadReport> {
  const until = deps.now();
  const from = options.since ?? until - DEFAULT_LOOKBACK_DAYS * DAY;
  const status = await deps.hub.ask({ op: "status" });
  const enabled = new Map(status.sources.map((s) => [s.source as Source, s.enabled]));
  const wanted = (source: Source): boolean => (options.sources ? options.sources.includes(source) : true) && enabled.get(source) !== false;
  const config = await deps.hub.config();

  const hostWanted = HOST_SOURCES.filter((source): source is HostSource => wanted(source));
  const hostSources = hostWanted.length
    ? (await deps.hub.ask({ op: "collect", mode: options.mode, sources: hostWanted, ...(config.roots ? { roots: config.roots } : {}), ...(config.authors ? { authors: config.authors } : {}), since: from, until }, 600_000)).sources
    : [];

  const report: LoadReport = { mode: options.mode, window: { from, to: until }, hostSources, messages: null, lpRuns: null, hubRecords: null, classify: null,
    cost: { jevMessages: 0, estimatedTokens: 0, perMessage: JEV_TOKENS_PER_MESSAGE, note: "" }, review: "" };

  const hubRecords: Array<Record<string, unknown>> = [];
  const names = await deps.projectNames().catch(() => new Map<string, string>());
  const nameOf = (projectId: string): string => names.get(projectId) ?? projectId;

  /* ---- BB messages ---- */
  const candidates: OwnerMessage[] = [];
  if (wanted("bb-message")) {
    const perProject = new Map<string, { at: number[]; ids: string[]; threads: Set<string>; byMonth: Record<string, number> }>();
    const byMonth: Record<string, number> = {};
    let total = 0, characters = 0, tooShort = 0, heldBack = 0;
    const classify = options.classify === true;
    const { threads } = await scanOwnerMessages(deps.threads, { from, to: until, signal: options.signal, onMessage: (message) => {
      total += 1; characters += message.text.length;
      const entry = perProject.get(message.projectId) ?? { at: [], ids: [], threads: new Set<string>(), byMonth: {} };
      entry.at.push(message.at); entry.ids.push(message.id); entry.threads.add(message.threadId);
      entry.byMonth[monthOf(message.at)] = (entry.byMonth[monthOf(message.at)] ?? 0) + 1;
      perProject.set(message.projectId, entry);
      byMonth[monthOf(message.at)] = (byMonth[monthOf(message.at)] ?? 0) + 1;
      const text = message.text.trim();
      if (text.length < MIN_CLASSIFY_CHARS) { tooShort += 1; return; }
      if (!options.allowSensitiveToJev && sensitiveReason(text)) { heldBack += 1; return; }
      if (classify) candidates.push(message);
    } });
    const eligible = total - tooShort - heldBack;
    report.messages = { enabled: true, threads, total, characters, projects: perProject.size, byMonth, tooShort, heldBackSensitive: heldBack, eligibleForJev: eligible };
    for (const [projectId, entry] of perProject) {
      const order = entry.at.map((at, i) => ({ at, id: entry.ids[i]! })).sort((a, b) => a.at - b.at);
      const name = nameOf(projectId);
      hubRecords.push({
        kind: "project", key: name, title: name,
        statement: `${order.length} messages in ${entry.threads.size} threads, ${monthOf(order[0]!.at)} to ${monthOf(order.at(-1)!.at)}`,
        attributes: { bbProjectId: projectId, messages: order.length, threads: entry.threads.size, byMonth: entry.byMonth },
        ...(/клиент|client/i.test(name) ? { sensitivity: "sensitive" } : {}),
        confidence: 0.8, firstSeen: order[0]!.at, lastSeen: order.at(-1)!.at,
        evidence: spread(order, 12).map((m) => ({ source: "bb-message", ref: m.id, at: m.at })),
      });
    }
  }

  /* ---- Lane Pilot runs ---- */
  if (wanted("lp-runs")) {
    const runs = deps.lpRuns().filter((run) => run.createdAt >= from && run.createdAt < until);
    const byProject = new Map<string, typeof runs>();
    for (const run of runs) byProject.set(run.projectId, [...(byProject.get(run.projectId) ?? []), run]);
    report.lpRuns = { enabled: true, runs: runs.length, projects: byProject.size };
    for (const [projectId, list] of byProject) {
      list.sort((a, b) => a.createdAt - b.createdAt);
      const name = nameOf(projectId);
      hubRecords.push({
        kind: "project", key: name, title: name, attributes: { lpRuns: list.length, lpFirstRun: list[0]!.createdAt, lpLastRun: list.at(-1)!.createdAt },
        confidence: 0.8, firstSeen: list[0]!.createdAt, lastSeen: list.at(-1)!.createdAt,
        evidence: spread(list, 8).map((run) => ({ source: "lp-runs", ref: `run:${run.id}`, at: run.createdAt })),
      });
    }
  }

  /* ---- cost of the optional Jev pass ---- */
  const eligibleAll = report.messages?.eligibleForJev ?? 0;
  const cap = options.maxClassify ?? eligibleAll;
  const jevMessages = Math.min(eligibleAll, cap);
  report.cost = { jevMessages, estimatedTokens: jevMessages * JEV_TOKENS_PER_MESSAGE, perMessage: JEV_TOKENS_PER_MESSAGE,
    note: `Classifying ${jevMessages} message fragments with Jev costs about ${(jevMessages * JEV_TOKENS_PER_MESSAGE / 1000).toFixed(0)}k tokens (${JEV_TOKENS_PER_MESSAGE} per message). Nothing is sent unless you pass --classify.` };

  /* ---- classification (the only step that sends message text outside) ---- */
  const candidateRecords: Array<Record<string, unknown>> = [];
  if (options.classify) {
    const cls = { requested: true, asked: 0, kept: 0, nothing: 0, unavailable: 0, stored: null as UpsertSummary | null, note: undefined as string | undefined };
    if (options.mode === "plan") cls.note = "plan mode: no fragment is sent; run with --run --classify to classify";
    else if (!deps.judge) cls.note = "Jev is not available (no key or switched off)";
    else {
      const chosen = [...candidates].sort((a, b) => b.at - a.at).slice(0, cap).sort((a, b) => a.at - b.at);
      for (let i = 0; i < chosen.length; i += JEV_BATCH) {
        options.signal?.throwIfAborted();
        const batch = chosen.slice(i, i + JEV_BATCH);
        const decisions = await deps.judge(batch.map((m) => scrubQuote(m.text, MAX_CLASSIFY_CHARS)), options.signal);
        batch.forEach((message, j) => {
          cls.asked += 1;
          const decision = decisions[j];
          if (!decision) { cls.unavailable += 1; return; }
          if (decision.kind === "nothing") { cls.nothing += 1; return; }
          cls.kept += 1;
          const text = scrubQuote(message.text, 240);
          candidateRecords.push({
            kind: decision.kind, key: `msg-${sha(message.id)}`, title: text.slice(0, 80), statement: text, status: "candidate",
            ...(decision.sensitive >= SENSITIVE_FROM ? { sensitivity: "sensitive" } : {}),
            attributes: { origin: "jev-fragment", kindP: Math.round(decision.kindP * 100) / 100, aboutOwner: Math.round(decision.aboutOwner * 100) / 100, sensitiveP: Math.round(decision.sensitive * 100) / 100 },
            confidence: Math.min(decision.kindP, decision.aboutOwner), evidence: [messageEvidence(message, text)],
          });
        });
      }
    }
    report.classify = cls;
  }

  /* ---- write (run only) ---- */
  report.hubRecords = { records: hubRecords.length, stored: null };
  if (options.mode === "run") {
    const messageRecords = hubRecords.filter((r) => (r.evidence as Array<{ source: string }>)[0]?.source === "bb-message");
    const runRecords = hubRecords.filter((r) => (r.evidence as Array<{ source: string }>)[0]?.source === "lp-runs");
    const stored: UpsertSummary[] = [];
    if (wanted("bb-message")) stored.push(await deps.hub.ask({ op: "upsert", actor: "auto:bb-message", reason: "initial load of BB history", records: messageRecords, checkpoint: { source: "bb-message", at: until } }));
    if (wanted("lp-runs")) stored.push(await deps.hub.ask({ op: "upsert", actor: "auto:lp-runs", reason: "initial load of Lane Pilot runs", records: runRecords, checkpoint: { source: "lp-runs", at: until } }));
    report.hubRecords.stored = merge(stored);
    if (report.classify && candidateRecords.length) report.classify.stored = await deps.hub.ask({ op: "upsert", actor: "auto:jev-fragment", reason: "classified fragments of owner messages", records: candidateRecords });
  }
  report.review = options.mode === "plan"
    ? "Plan only: nothing was stored. Run with --run to store drafts, then review with: bb lane-pilot anamnesis review"
    : "Drafts stored. Nothing reaches any agent until you confirm records; review with: bb lane-pilot anamnesis review";
  // A plan leaves no trace on the machine; only a run keeps its report.
  if (options.mode === "run") await deps.hub.ask({ op: "load_report", mode: "run", report: report as unknown as Record<string, unknown> }).catch(() => undefined);
  return report;
}

function merge(parts: UpsertSummary[]): UpsertSummary {
  const counts: Record<string, number> = {}, reasons: Record<string, number> = {};
  for (const part of parts) {
    for (const [k, v] of Object.entries(part.counts)) counts[k] = (counts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(part.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
  }
  return { counts, reasons, ids: parts.flatMap((part) => part.ids).slice(0, 500) };
}

/** The text a human reads after a load: counts only, no content. */
export function formatReport(report: LoadReport): string {
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const lines = [`Anamnesis load (${report.mode}), window ${day(report.window.from)} to ${day(report.window.to)}`];
  for (const s of report.hostSources) {
    lines.push(`- ${s.source}: ${s.enabled ? `${s.items} items, ${s.records} records (${Object.entries(s.outcome).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})` : "off"}${s.error ? ` ERROR ${s.error}` : ""}${s.note ? ` [${s.note}]` : ""}`);
  }
  if (report.messages) lines.push(`- bb-message: ${report.messages.total} messages in ${report.messages.threads} threads of ${report.messages.projects} projects; ${report.messages.characters} characters; ${report.messages.tooShort} too short, ${report.messages.heldBackSensitive} held back as sensitive, ${report.messages.eligibleForJev} eligible for Jev`);
  if (report.lpRuns) lines.push(`- lp-runs: ${report.lpRuns.runs} runs in ${report.lpRuns.projects} projects`);
  if (report.hubRecords) lines.push(`- project records from BB and runs: ${report.hubRecords.records}${report.hubRecords.stored ? ` (${Object.entries(report.hubRecords.stored.counts).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`);
  if (report.classify) lines.push(`- jev classification: asked ${report.classify.asked}, kept ${report.classify.kept}, nothing ${report.classify.nothing}, unavailable ${report.classify.unavailable}${report.classify.note ? ` [${report.classify.note}]` : ""}`);
  lines.push(`cost: ${report.cost.note}`, report.review);
  return lines.join("\n");
}
