import { z } from "zod";
import { bestEffort } from "@lane-pilot/kit";
import {
  collectScanResponseSchema, notesReadResponseSchema, notesWriteResponseSchema, responseSchemas,
  type AnamnesisRequest, type HostRequest, type HostSource, type NotesReadResponse, type OpName, type ResponseOf,
} from "./ops";
import type { AnamnesisRpcRequest } from "./contract";
import { executeRequest, writesNotes } from "./host";
import { storeCollectResults, type CollectRequest, type SourceScanResult } from "./collect";
import { planNotes, sha, type Applied } from "./notes";
import type { Store } from "./store";

/**
 * The hub side of anamnesis (M1b). Every store operation runs here against the plugin base's `lane_pilot_owner_*`
 * tables — the same implementation and the same evidence rules as the file store, plus field encryption of sensitive
 * records under `LP_OWNER_MEMORY_KEY` (the wiring hands the store its `OwnerCrypto`). The host is called only for what
 * cannot run on the hub: the raw collection scans of the owner's machine, the portrait files' read and write, and the
 * read-only export of the legacy file for the one-off migration.
 */
export type HostInfo = { id: string; name: string; connected: boolean };

export type HubDeps = {
  /** One request to the host method `anamnesis` on that machine; returns the host's `response`. Since M1b only host-bound requests reach it. */
  hostCall(hostId: string, request: AnamnesisRequest | HostRequest, timeoutMs: number): Promise<unknown>;
  listHosts(): Promise<HostInfo[]>;
  kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
  /** The owner tables of the plugin base (`openOwnerStore` over `data.db`). */
  store: Store;
  /** Where a swallowed best-effort failure lands (the notes sync that must never fail its operation). */
  log?: (message: string) => void;
};

export const CONFIG_KEY = "anamnesis:config";
export const configSchema = z.object({
  /** The machine that holds the store: the owner's Mac mini. */
  hostId: z.string().min(1).optional(),
  /** Git author emails or names that are the owner's own commits (A3). */
  authors: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Folders searched for the owner's repositories and project journals (A3). */
  roots: z.array(z.string().startsWith("/")).max(20).optional(),
  /** The most message fragments one Jev pass may send (a ceiling on cost, F-5); the pass default is `DEFAULT_MAX_CLASSIFY` in load.ts. */
  maxClassify: z.number().int().min(1).max(2000).optional(),
  /** The daily pass and the at-message extraction (A4) send masked fragments of the owner's messages to Jev; they run only while this is on. Off until the owner switches it on. */
  extract: z.boolean().optional(),
  /** The owner's own Telegram channels (`@name` or a t.me link) that the Telegram source reads (A10), when that source is switched on. */
  telegramChannels: z.array(z.string().trim().min(2).max(200)).max(10).optional(),
}).strict();
export type AnamnesisConfig = z.infer<typeof configSchema>;

const CALL_TIMEOUT_MS = 60_000;

export function createHub(deps: HubDeps) {
  const store = deps.store;
  const log = deps.log ?? (() => {});

  async function config(): Promise<AnamnesisConfig> {
    const stored = configSchema.safeParse(await deps.kv.get(CONFIG_KEY));
    return stored.success ? stored.data : {};
  }

  async function setConfig(patch: Partial<AnamnesisConfig>): Promise<AnamnesisConfig> {
    const next = configSchema.parse({ ...(await config()), ...patch });
    await deps.kv.set(CONFIG_KEY, next as never);
    return next;
  }

  /** The configured machine, else the one connected machine called «mini». Never a guess among several. */
  async function resolveHost(): Promise<string> {
    const configured = (await config()).hostId;
    if (configured) return configured;
    const minis = (await deps.listHosts()).filter((host) => host.connected && /\bmini\b/i.test(host.name));
    if (minis.length === 1) return minis[0]!.id;
    throw new Error(minis.length ? "More than one connected machine looks like the Mac mini; set one with: bb lane-pilot anamnesis host <host-id>"
      : "No connected Mac mini found; set the machine with: bb lane-pilot anamnesis host <host-id>");
  }

  async function askHost<T>(request: HostRequest, parse: (raw: unknown) => T, timeoutMs: number): Promise<T> {
    const hostId = await resolveHost();
    return parse(await deps.hostCall(hostId, request, timeoutMs));
  }

  /** `collect`: the host scans its own sources and answers raw records; the hub stores them through the store door. */
  async function collect(request: Extract<AnamnesisRequest, { op: "collect" }>, timeoutMs: number): Promise<ResponseOf<"collect">> {
    // A switched-off source is not even scanned on the host; its answer entry comes from storeCollectResults.
    const wanted = request.sources.filter((source) => store.sourceEnabled(source));
    const hostRequest: HostRequest = {
      op: "collect", mode: request.mode, sources: wanted as HostSource[],
      ...(request.roots ? { roots: request.roots } : {}), ...(request.authors ? { authors: request.authors } : {}),
      ...(request.telegramChannels ? { telegramChannels: request.telegramChannels } : {}), ...(request.bbMemories ? { bbMemories: request.bbMemories } : {}),
      since: request.since, until: request.until,
    };
    const scans = await askHost(hostRequest, (raw) => collectScanResponseSchema.parse(raw).sources, timeoutMs);
    // ponytail: a scan's raw records go over one RPC (hundreds at most); if a source ever outgrows that, page it.
    const sources = storeCollectResults(store, request as CollectRequest, scans as SourceScanResult[]);
    if (request.mode === "run") await bestEffort(log, "anamnesis notes sync after collect", notes({ op: "notes", sync: true }, timeoutMs), undefined);
    return { mode: request.mode, sources } satisfies ResponseOf<"collect">;
  }

  const notesResponse = (listing: NotesReadResponse, applied: Applied, written: number, error?: string): ResponseOf<"notes"> => ({
    dir: listing.dir,
    files: listing.files.map((file) => ({ name: file.name, path: file.path, exists: file.exists, records: file.records })),
    applied, written, ...(error ? { error } : {}),
  });
  const emptyApplied = (): Applied => ({ created: 0, edited: 0, confirmed: 0, rejected: 0, skipped: 0 });

  /** `notes`: the files live on the host; the hub plans against its snapshot and sends only the writes that apply. */
  async function notes(request: Extract<AnamnesisRequest, { op: "notes" }>, timeoutMs: number): Promise<ResponseOf<"notes">> {
    if (!request.sync) {
      const listing = await askHost({ op: "notes_read" }, (raw) => notesReadResponseSchema.parse(raw), timeoutMs);
      return notesResponse(listing, emptyApplied(), 0);
    }
    const listing = await askHost({ op: "notes_read", full: true }, (raw) => notesReadResponseSchema.parse(raw), timeoutMs);
    const snapshot = new Map(listing.files.map((file) => [file.name, file.content ?? null] as const));
    const applied = emptyApplied();
    let written = 0;
    try {
      const plan = planNotes(store, snapshot, Date.now(), applied);
      const writes = plan.files.filter((file) => file.changed).map((file) => ({ name: file.name, content: file.content, base: file.base }));
      const wrote = new Set<string>();
      if (writes.length) {
        const result = await askHost({ op: "notes_write", writes }, (raw) => notesWriteResponseSchema.parse(raw), timeoutMs);
        written = result.written;
        for (const file of result.files) if (file.wrote) wrote.add(file.name);
      }
      store.transaction(() => {
        for (const file of plan.files) if (!file.changed || wrote.has(file.name)) store.saveNotesState(file.name, sha(file.stored), file.lines, Date.now());
      });
      // The answer describes the folder after the writes, not the snapshot the plan ran on.
      const after = await askHost({ op: "notes_read" }, (raw) => notesReadResponseSchema.parse(raw), timeoutMs);
      return notesResponse(after, applied, written);
    } catch (cause) {
      return notesResponse(listing, applied, written, cause instanceof Error ? cause.message.slice(0, 300) : String(cause));
    }
  }

  /** The one-off migration's read side: the legacy file's rows, over the host's read-only `export`. */
  async function exportTables(timeoutMs = CALL_TIMEOUT_MS): Promise<Record<string, Array<Record<string, unknown>>>> {
    return askHost({ op: "export" }, (raw) => {
      const parsed = z.object({ tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }).strict().parse(raw);
      return parsed.tables;
    }, timeoutMs);
  }

  async function ask<O extends OpName>(request: Extract<AnamnesisRequest, { op: O }>, timeoutMs = CALL_TIMEOUT_MS): Promise<ResponseOf<O>> {
    const op = request as AnamnesisRequest;
    if (op.op === "collect") return collect(op, timeoutMs) as Promise<ResponseOf<O>>;
    if (op.op === "notes") return notes(op, timeoutMs) as Promise<ResponseOf<O>>;
    const raw = await executeRequest(op, store);
    // The portrait files live on the host: a write is followed by a notes sync there, like the file store's syncNotes was.
    // It never fails the operation — a problem is logged, lands in the `notes` answer and is retried at the next change.
    if (writesNotes(op)) await bestEffort(log, "anamnesis notes sync after write", notes({ op: "notes", sync: true }, timeoutMs), undefined);
    return responseSchemas[op.op as OpName].parse(raw) as ResponseOf<O>;
  }

  /** The RPC: a store request runs on the hub, `host`/`config`/`pass` are hub-local as before. */
  async function dispatch(request: AnamnesisRpcRequest): Promise<unknown> {
    if (request.op === "host") {
      if (request.hostId) await setConfig({ hostId: request.hostId });
      return { hostId: await resolveHost(), config: await config() };
    }
    if (request.op === "config") {
      if (request.set) await setConfig(request.set);
      return { config: await config() };
    }
    if (request.op === "pass") throw new Error("The daily pass runs from Lane Pilot's server, not from the hub client");
    return await ask(request as Extract<AnamnesisRequest, { op: OpName }>);
  }

  return { config, setConfig, resolveHost, ask, dispatch, kv: deps.kv, store, exportTables };
}
export type Hub = ReturnType<typeof createHub>;
