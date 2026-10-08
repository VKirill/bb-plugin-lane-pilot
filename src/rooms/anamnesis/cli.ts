import { parseArgs } from "node:util";
import { KINDS, SENSITIVITIES, SOURCES, STATUSES, type AnamnesisRecord, type Kind, type Source, type Status } from "./model";
import type { Hub } from "./hub";
import { profileSchema } from "./profile-import";
import { DETAILS, SECTIONS, type Detail, type Section } from "./whoami";
import { DEFAULT_LOOKBACK_DAYS, formatReport, type LoadOptions, type LoadReport } from "./load";

/**
 * `bb lane-pilot anamnesis …` — how the owner, and a PM that the owner asked, reach the records. There is no agent tool for it
 * (the PM's tool list is full); a PM runs this command in its shell when the owner asks who they are in its eyes.
 * Sensitive records appear only with --include-sensitive, which is passed on purpose (privacy default, not a caller check).
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
  "bb lane-pilot anamnesis config [--authors EMAIL,NAME] [--roots /path,/path] [--max-classify N] [--extract on|off] [--telegram-channels @name,@name]",
  "bb lane-pilot anamnesis load [--run] [--since YYYY-MM-DD] [--sources a,b] [--classify --yes [--max-classify N]] [--json]",
  "bb lane-pilot anamnesis review [--limit N]",
  "bb lane-pilot anamnesis whoami [--sections identity,knowledge,skills,people,hobbies,interests,preferences,timeline,projects,tools] [--detail brief|normal|full] [--locale ru|en] [--confirmed-only] [--include-sensitive] [--public-only] [--year YYYY]",
  "bb lane-pilot anamnesis purge-technical [--dry-run]",
  "bb lane-pilot anamnesis notes [--sync]",
  "bb lane-pilot anamnesis card [--max-chars N]",
  "bb lane-pilot anamnesis import-profile --profile '<JSON of bb memory-profile get --json>'",
].join("\n");

export type CliResult = { exitCode: number; stdout?: string; stderr?: string };
export type CliDeps = {
  hub: Hub;
  /** The first load; absent where Lane Pilot is not mounted (tests of the plain commands). */
  load?: (options: LoadOptions) => Promise<LoadReport>;
  now?: () => number;
};

const OPTIONS = {
  json: { type: "boolean" }, kind: { type: "string" }, status: { type: "string" }, query: { type: "string" }, limit: { type: "string" },
  "include-sensitive": { type: "boolean" }, key: { type: "string" }, title: { type: "string" }, statement: { type: "string" },
  sensitivity: { type: "string" }, reason: { type: "string" }, confidence: { type: "string" }, all: { type: "boolean" }, yes: { type: "boolean" },
  source: { type: "string" }, set: { type: "string" }, help: { type: "boolean" },
  run: { type: "boolean" }, classify: { type: "boolean" }, since: { type: "string" }, sources: { type: "string" }, "max-classify": { type: "string" },
  "dry-run": { type: "boolean" }, sync: { type: "boolean" }, locale: { type: "string" }, sections: { type: "string" }, detail: { type: "string" }, "confirmed-only": { type: "boolean" }, "public-only": { type: "boolean" }, year: { type: "string" }, profile: { type: "string" }, "max-chars": { type: "string" }, authors: { type: "string" }, roots: { type: "string" }, extract: { type: "string" }, "telegram-channels": { type: "string" },
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
    case "config": {
      const csv = (text: string | undefined) => text?.split(",").map((part) => part.trim()).filter(Boolean);
      const authors = csv(values.authors), roots = csv(values.roots), telegramChannels = csv(values["telegram-channels"]);
      const maxClassify = values["max-classify"] ? Number(values["max-classify"]) : undefined;
      if (maxClassify !== undefined && !(Number.isInteger(maxClassify) && maxClassify >= 1)) throw new Error("--max-classify must be a whole number of at least 1");
      if (values.extract !== undefined && values.extract !== "on" && values.extract !== "off") throw new Error("--extract on|off: automatic learning sends masked fragments of your messages to Jev every day and as they come");
      const extract = values.extract === undefined ? undefined : values.extract === "on";
      const next = authors || roots || telegramChannels || maxClassify !== undefined || extract !== undefined
        ? await hub.setConfig({ ...(authors ? { authors } : {}), ...(roots ? { roots } : {}), ...(telegramChannels ? { telegramChannels } : {}), ...(maxClassify !== undefined ? { maxClassify } : {}), ...(extract !== undefined ? { extract } : {}) }) : await hub.config();
      return out(next, true, () => "");
    }
    case "load": {
      if (!deps.load) throw new Error("load is not available here");
      const mode = values.run ? "run" : "plan";
      if (values.classify && mode === "run" && !values.yes) throw new Error("--classify sends masked message fragments to Jev (TypeSafe), the only outside service used; add --yes to allow it. Plan first: without --run it prices the pass and sends nothing.");
      let since: number | undefined;
      if (values.since) { since = Date.parse(`${values.since}T00:00:00Z`); if (!Number.isFinite(since)) throw new Error("--since must be YYYY-MM-DD"); }
      const sources = values.sources ? values.sources.split(",").map((name) => oneOf(name.trim(), SOURCES.filter((source) => source !== "manual"), "source") as Source) : undefined;
      const report = await deps.load({ mode, ...(since !== undefined ? { since } : {}), ...(sources ? { sources } : {}), classify: values.classify === true,
        ...(values["max-classify"] ? { maxClassify: Number(values["max-classify"]) } : {}) });
      return out(report, values.json, () => `${formatReport(report)}
(default window: the last ${DEFAULT_LOOKBACK_DAYS} days)`);
    }
    case "whoami": {
      const sections = values.sections ? values.sections.split(",").map((name) => oneOf(name.trim(), SECTIONS, "section") as Section) : undefined;
      const detail = oneOf(values.detail, DETAILS, "detail") as Detail | undefined;
      const locale = oneOf(values.locale, ["ru", "en"] as const, "locale");
      const year = values.year === undefined ? undefined : Number(values.year);
      if (year !== undefined && !(Number.isInteger(year) && year >= 2000 && year <= 2200)) throw new Error("--year must be a calendar year such as 2026");
      const result = await hub.ask({ op: "whoami", ...(locale ? { locale } : {}), ...(year !== undefined ? { year } : {}), ...(sections ? { sections } : {}), ...(detail ? { detail } : {}), ...(includeSensitive ? { includeSensitive } : {}),
        ...(values["confirmed-only"] ? { includeDrafts: false } : {}), ...(values["public-only"] ? { publicOnly: true } : {}) });
      return out(result, values.json, () => result.text);
    }
    case "purge-technical": {
      const result = await hub.ask({ op: "purge_technical", ...(values["dry-run"] ? { dryRun: true } : {}) });
      return out(result, values.json, () => [
        `${result.dryRun ? "would delete" : "deleted"} ${result.deleted} of ${result.scanned} unconfirmed records that nobody touched`,
        `by reason: ${JSON.stringify(result.byReason)}; by status: ${JSON.stringify(result.byStatus)}; by kind: ${JSON.stringify(result.byKind)}`,
        `kept: ${result.kept.confirmed} confirmed, ${result.kept.ownerTouched} touched by you (never deleted)`,
      ].join("\n"));
    }
    case "notes": {
      const result = await hub.ask({ op: "notes", ...(values.sync ? { sync: true } : {}) });
      return out(result, values.json, () => [
        `folder: ${result.dir ?? "none on this machine"}`,
        ...result.files.map((file) => `${file.exists ? "+" : "-"} ${file.name} (${file.records} records)`),
        ...(values.sync ? [`synced: ${result.applied.created} added, ${result.applied.edited} edited, ${result.applied.confirmed} confirmed, ${result.applied.rejected} rejected from your edits; ${result.written} files written${result.error ? `; ERROR ${result.error}` : ""}`] : []),
      ].join("\n"));
    }
    case "card": {
      const result = await hub.ask({ op: "card", ...(values["max-chars"] ? { maxChars: Number(values["max-chars"]) } : {}) });
      return out(result, values.json, () => result.text);
    }
    case "import-profile": {
      if (!values.profile) throw new Error("import-profile needs --profile '<JSON>': the output of `bb memory-profile get --json` (enable the plugin for a moment if it is off)");
      let profile: unknown;
      try { profile = JSON.parse(values.profile); } catch { throw new Error("--profile is not JSON"); }
      const parsed = profileSchema.safeParse(profile);
      if (!parsed.success) throw new Error(`--profile is not a memory-profile card: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      const result = await hub.ask({ op: "import_profile", profile: parsed.data });
      return out(result, values.json, () => `moved ${result.imported} records from the card${result.skipped.length ? ` (empty fields: ${result.skipped.join(", ")})` : ""}; they are confirmed. Check them in the Anamnesis tab, then the plugin can be switched off.`);
    }
    case "review": {
      const perKind = values.limit ? Number(values.limit) : 8;
      const { records } = await hub.ask({ op: "list", statuses: ["draft", "candidate"], limit: 2000 });
      const groups = new Map<string, AnamnesisRecord[]>();
      for (const record of records) groups.set(record.kind, [...(groups.get(record.kind) ?? []), record]);
      const sensitive = (await hub.ask({ op: "status" })).counts.bySensitivity.sensitive ?? 0;
      const text = [...groups].map(([kind, list]) => `## ${kind} (${list.length} to review)\n${list.slice(0, perKind).map(recordLine).join("\n")}`).join("\n\n");
      return { exitCode: 0, stdout: `${text || "nothing to review"}\n\n${sensitive} sensitive records are hidden; ask for them by name with --include-sensitive.\nConfirm with: confirm <id>; reject with: reject <id>.` };
    }
    default:
      throw new Error(`unknown command "${command}"\n${ANAMNESIS_USAGE}`);
  }
}
export type { Kind };
