import { parseArgs } from "node:util";
import { KINDS, SENSITIVITIES, SOURCES, STATUSES, type AnamnesisRecord, type Kind, type Source, type Status } from "./model";
import type { Hub } from "./hub";

/**
 * `bb lane-pilot anamnesis …` — how the owner, and a PM that the owner asked, reach the records. There is no agent tool for it
 * (the PM's tool list is full); a PM runs this command in its shell when the owner asks who they are in its eyes.
 * Sensitive records appear only with --include-sensitive, which a PM may pass only when the owner asked for them by name.
 */
export const ANAMNESIS_USAGE = [
  "bb lane-pilot anamnesis status [--json]",
  "bb lane-pilot anamnesis host [<host-id>]",
  "bb lane-pilot anamnesis list [--kind K,K] [--status S] [--query TEXT] [--limit N] [--include-sensitive] [--json]",
  "bb lane-pilot anamnesis show <id> [--include-sensitive] [--json]",
  "bb lane-pilot anamnesis history <id> [--json]",
  "bb lane-pilot anamnesis add --kind K --key NAME --title TEXT [--statement TEXT] [--sensitivity public|private|sensitive] --reason TEXT",
  "bb lane-pilot anamnesis edit <id> [--title T] [--statement S] [--sensitivity X] [--status S] [--confidence 0..1] --reason TEXT",
  "bb lane-pilot anamnesis confirm|reject <id> [--reason TEXT]",
  "bb lane-pilot anamnesis forget <id> | --all --yes | --source SOURCE --yes",
  "bb lane-pilot anamnesis sources [--set SOURCE=on|off]",
].join("\n");

export type CliResult = { exitCode: number; stdout?: string; stderr?: string };
export type CliDeps = {
  hub: Hub;
  /** Null when the caller may read the records; otherwise why not. Lane Pilot's writers and helpers never may. */
  deny(threadId: string | undefined): Promise<string | null>;
  threadId?: string | undefined;
  now?: () => number;
};

const OPTIONS = {
  json: { type: "boolean" }, kind: { type: "string" }, status: { type: "string" }, query: { type: "string" }, limit: { type: "string" },
  "include-sensitive": { type: "boolean" }, key: { type: "string" }, title: { type: "string" }, statement: { type: "string" },
  sensitivity: { type: "string" }, reason: { type: "string" }, confidence: { type: "string" }, all: { type: "boolean" }, yes: { type: "boolean" },
  source: { type: "string" }, set: { type: "string" }, help: { type: "boolean" },
} as const;

const day = (at: number | null): string => (at ? new Date(at).toISOString().slice(0, 10) : "—");
export const recordLine = (r: AnamnesisRecord): string =>
  `${r.id} [${r.kind}/${r.status}/${r.sensitivity}] ${r.title}${r.statement && r.statement !== r.title ? ` — ${r.statement}` : ""} (${r.evidenceCount} evidence, ${day(r.firstSeen)}…${day(r.lastSeen)})`;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${what} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

export async function runAnamnesisCli(argv: string[], deps: CliDeps, extra: Record<string, (args: ReturnType<typeof parse>) => Promise<CliResult>> = {}): Promise<CliResult> {
  try {
    const parsed = parse(argv);
    const command = parsed.positionals[0];
    if (parsed.values.help || !command || command === "help") return { exitCode: 0, stdout: ANAMNESIS_USAGE };
    const denied = await deps.deny(deps.threadId);
    if (denied) return { exitCode: 1, stderr: denied };
    const handler = extra[command];
    if (handler) return await handler(parsed);
    return await core(command, parsed, deps);
  } catch (error) {
    return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

export function parse(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS });
}
export type Parsed = ReturnType<typeof parse>;

const out = (value: unknown, json: boolean | undefined, text: () => string): CliResult => ({ exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : text() });

async function core(command: string, { values, positionals }: Parsed, deps: CliDeps): Promise<CliResult> {
  const { hub } = deps;
  const includeSensitive = values["include-sensitive"] === true;
  const reason = (fallback?: string): string => values.reason?.trim() || fallback || (() => { throw new Error("--reason is required: say why, it goes into the history"); })();
  const id = (): string => { const value = positionals[1]; if (!value) throw new Error(`${command} needs a record id`); return value; };
  switch (command) {
    case "status": {
      const status = await hub.ask({ op: "status" });
      return out(status, values.json, () => [
        `store: ${status.path}`,
        `records: ${status.counts.records} (evidence ${status.counts.evidence}); by status ${JSON.stringify(status.counts.byStatus)}; by sensitivity ${JSON.stringify(status.counts.bySensitivity)}`,
        `by kind: ${JSON.stringify(status.counts.byKind)}`,
        `sources: ${status.sources.map((s) => `${s.source}=${s.enabled ? "on" : "off"}${s.checkpoint ? `@${day(s.checkpoint)}` : ""}`).join(" ")}`,
        status.cutoff ? `forget cutoff: ${day(status.cutoff)}` : "forget cutoff: none",
      ].join("\n"));
    }
    case "host": {
      const result = await hub.dispatch({ op: "host", ...(positionals[1] ? { hostId: positionals[1] } : {}) });
      return out(result, true, () => "");
    }
    case "list": {
      const kinds = values.kind ? values.kind.split(",").map((kind) => oneOf(kind.trim(), KINDS, "kind")!) : undefined;
      const status = oneOf(values.status, STATUSES, "status");
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      const result = await hub.ask({ op: "list", ...(kinds ? { kinds } : {}), ...(status ? { statuses: [status] } : {}), ...(values.query ? { query: values.query } : {}), ...(includeSensitive ? { includeSensitive } : {}), ...(limit ? { limit } : {}) });
      return out(result, values.json, () => result.records.length ? result.records.map(recordLine).join("\n") : "no records");
    }
    case "show": {
      const { record } = await hub.ask({ op: "get", id: id(), includeSensitive });
      if (!record) return { exitCode: 1, stderr: includeSensitive ? "no such record" : "no such record (a sensitive one needs --include-sensitive)" };
      return out(record, values.json, () => [recordLine(record), ...record.evidence.map((e) => `  - ${day(e.at)} ${e.source} ${e.ref}${e.quote ? ` “${e.quote}”` : ""}`)].join("\n"));
    }
    case "history": {
      const { history } = await hub.ask({ op: "history", id: id() });
      return out(history, values.json, () => history.map((h) => `${new Date(h.at).toISOString()} ${h.actor} ${h.action}: ${h.reason} ${JSON.stringify(h.changes)}`).join("\n") || "no history");
    }
    case "add": {
      if (!values.kind || !values.key || !values.title) throw new Error("add needs --kind, --key and --title");
      const record = { kind: oneOf(values.kind, KINDS, "kind"), key: values.key, title: values.title, ...(values.statement ? { statement: values.statement } : {}),
        ...(values.sensitivity ? { sensitivity: oneOf(values.sensitivity, SENSITIVITIES, "sensitivity") } : {}) };
      const result = await hub.ask({ op: "add", record, reason: reason() });
      return out(result, true, () => "");
    }
    case "edit": case "confirm": case "reject": {
      const patch: Record<string, unknown> = {};
      if (command === "confirm") patch.status = "confirmed";
      if (command === "reject") patch.status = "rejected";
      if (values.title) patch.title = values.title;
      if (values.statement !== undefined) patch.statement = values.statement;
      if (values.sensitivity) patch.sensitivity = oneOf(values.sensitivity, SENSITIVITIES, "sensitivity");
      if (values.status) patch.status = oneOf(values.status, STATUSES, "status") as Status;
      if (values.confidence !== undefined) patch.confidence = Number(values.confidence);
      const result = await hub.ask({ op: "edit", id: id(), patch: patch as never, reason: reason(command === "edit" ? undefined : `owner ${command}ed it`) });
      return out(result.record, values.json, () => recordLine(result.record));
    }
    case "forget": {
      if (values.all) {
        if (!values.yes) throw new Error("forgetting everything needs --yes; it also clears the history and sets a cutoff");
        return out(await hub.ask({ op: "forget", all: true }), true, () => "");
      }
      if (values.source) {
        if (!values.yes) throw new Error("forgetting a source needs --yes; it drops what only that source supported and switches it off");
        return out(await hub.ask({ op: "forget", source: oneOf(values.source, SOURCES.filter((s) => s !== "manual"), "source") as Exclude<Source, "manual"> }), true, () => "");
      }
      return out(await hub.ask({ op: "forget", id: id() }), true, () => "");
    }
    case "sources": {
      let set: { source: Exclude<Source, "manual">; enabled: boolean } | undefined;
      if (values.set) {
        const [name, state] = values.set.split("=");
        if (state !== "on" && state !== "off") throw new Error("--set SOURCE=on|off");
        set = { source: oneOf(name, SOURCES.filter((s) => s !== "manual"), "source") as Exclude<Source, "manual">, enabled: state === "on" };
      }
      const result = await hub.ask({ op: "sources", ...(set ? { set } : {}) });
      return out(result, values.json, () => result.sources.map((s) => `${s.source}: ${s.enabled ? "on" : "off"}${s.checkpoint ? ` (read up to ${day(s.checkpoint)})` : ""}`).join("\n"));
    }
    default:
      throw new Error(`unknown command "${command}"\n${ANAMNESIS_USAGE}`);
  }
}
export type { Kind };
