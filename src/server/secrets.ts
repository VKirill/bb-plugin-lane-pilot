import { z } from "zod";
import { registerSecrets, secretStrings } from "@lane-pilot/kit";
import { parseSandboxUnsafePatterns } from "../stages/critique-coverage";
import { SANDBOX_OWN_ENV } from "../verification/sandbox";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const ENV_CATALOG_PLUGIN = "env-catalog";
/** The project setting that narrows the Env Catalog names a check may be given (J4). Unset or empty: every name the task contract declares. */
export const SECRETS_ALLOW_KEY = "secrets.allow";
export type CredentialKind = "secret" | "ftp" | "ssh" | "login";
export type CatalogEntry = { name:string; kind:CredentialKind };
export type CatalogRecord = { name:string; kind:CredentialKind; value:string | null; access:Record<string, unknown> | null };

type CallRpc = (args:{ pluginId:string; method:string; input?:unknown; outputSchema:z.ZodType<unknown> }) => Promise<unknown>;

const listSchema = z.object({ variables:z.array(z.object({ name:z.string(), kind:z.enum(["secret", "ftp", "ssh", "login"]).catch("secret") }).passthrough()) }).passthrough();
const recordSchema = z.object({
  name:z.string(), kind:z.enum(["secret", "ftp", "ssh", "login"]).catch("secret"),
  value:z.string().nullable(), access:z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();

/**
 * The names the project's list leaves open; the settings a run sees are passed in. Empty means every name the task contract
 * declares: the list only narrows (owner decision 2026-10-08, no per-name owner form). `*` allows any name.
 */
export const allowedSecretNames = (settings:Record<string, unknown>):string[] => parseSandboxUnsafePatterns(settings[SECRETS_ALLOW_KEY]);
const isAllowed = (allowed:readonly string[], name:string):boolean => allowed.length === 0 || allowed.includes("*") || allowed.includes(name);


/** Env variables a check gets for one catalog record: a secret under its own name, a login as NAME_USERNAME / NAME_PASSWORD / NAME_URL. */
export function envForRecord(record:CatalogRecord):Record<string, string> | null {
  if (record.kind === "secret") return record.value ? { [record.name]:record.value } : null;
  if (record.kind === "login" && record.access) {
    const field = (key:string) => typeof record.access![key] === "string" ? record.access![key] as string : "";
    const out:Record<string, string> = {};
    if (field("username")) out[`${record.name}_USERNAME`] = field("username");
    if (field("password")) out[`${record.name}_PASSWORD`] = field("password");
    const url = field("url") || field("host");
    if (url) out[`${record.name}_URL`] = url;
    return out[`${record.name}_PASSWORD`] ? out : null;
  }
  return null;
}

export type SecretCheck = {
  /** Declared names the catalog has no record of. */
  missing:string[];
  /** Declared names the project's `secrets.allow` list leaves out. */
  denied:string[];
  /** Declared names of a kind a check cannot take (ssh, ftp: those are for a PM's deploy errand). */
  wrongKind:string[];
  /** Env Catalog could not be asked at all (not installed, disabled, or erroring). */
  unavailable:boolean;
};
export type SecretResolution = SecretCheck & {
  /** Variables for the sandbox, by variable name. */
  env:Record<string, string>;
  /** The variables each declared name expands to (a login gives three), so one check gets only its own. */
  byName:Record<string, Record<string, string>>;
};

/** The reason a task carries while it waits for a secret; failure-class.ts reads the same prefix. */
export const WAITING_SECRET_PREFIX = "waiting_secret:";
export const waitingSecretReason = (names:readonly string[]):string => `${WAITING_SECRET_PREFIX}${[...new Set(names)].join(",")}`;

/** What the PM does about each kind of missing access; one message per task while it waits. */
export function secretFixLines(check:SecretCheck):string[] {
  const lines:string[] = [];
  if (check.unavailable) lines.push("Env Catalog is not answering (not installed, disabled or restarting); the task starts by itself once it answers.");
  if (check.denied.length) lines.push(`${check.denied.join(", ")}: the project list «Secrets checks may use» (secrets.allow) is not empty and leaves it out. Add the name to that list (or empty the list: then every name a task contract declares is allowed); the task starts by itself.`);
  if (check.missing.length && !check.unavailable) lines.push(`${check.missing.join(", ")}: not in Env Catalog. Call env_request for it now (name, the kind, a purpose) so the owner gets a form on the phone; do not ask for the value in chat.`);
  if (check.wrongKind.length) lines.push(`${check.wrongKind.join(", ")}: not of a kind this step can take (a check takes a secret or a login, a browser case a login; SSH and FTP access is for lane_pilot_errand).`);
  return lines;
}

export function waitingSecretNote(taskId:string, check:SecretCheck):string {
  return `Lane Pilot: ${taskId} waits for access its checks declare, no attempt is spent, and it starts by itself once that is in place.\n${secretFixLines(check).map((line) => `- ${line}`).join("\n")}`;
}

/** A check's declared secrets cannot be handed out now (the catalog lost one, the allow list leaves it out). */
export class SecretsNotReadyError extends Error {
  constructor(readonly names:string[]) { super(waitingSecretReason(names)); this.name = "SecretsNotReadyError"; }
}

/** What stops a declared name from being handed out, in the order the PM should fix it; empty when nothing does. */
export const secretProblem = (check:SecretCheck):string[] => [...check.denied, ...check.missing, ...check.wrongKind];

/**
 * Lane Pilot's one door to Env Catalog (J2/J4). Values are fetched per use and never kept; each value handed out is also
 * registered with the masking in redact.ts, so nothing a run prints with it reaches a log, a receipt or the PM.
 */
export function createSecrets(deps:{ bb:BbPluginApi; now?:() => number }) {
  const now = deps.now ?? (() => Date.now());
  const callRpc = ():CallRpc | undefined => {
    const plugins = (deps.bb.sdk as { plugins?:{ callRpc?:CallRpc } }).plugins;
    return plugins?.callRpc ? (args) => plugins.callRpc!(args) : undefined;
  };
  let cached:{ at:number; entries:CatalogEntry[] | null } | null = null;

  /** The catalog's names and kinds, or null when Env Catalog cannot be asked (feature test: not installed, disabled, erroring). */
  async function list(options:{ fresh?:boolean } = {}):Promise<CatalogEntry[] | null> {
    if (!options.fresh && cached && now() - cached.at < 5_000) return cached.entries;
    const call = callRpc();
    let entries:CatalogEntry[] | null = null;
    if (call) {
      try {
        const reply = listSchema.parse(await call({ pluginId:ENV_CATALOG_PLUGIN, method:"env_list", input:{}, outputSchema:listSchema }));
        entries = reply.variables.map((row) => ({ name:row.name, kind:row.kind }));
      } catch { entries = null; }
    }
    cached = { at:now(), entries };
    return entries;
  }

  async function record(name:string):Promise<CatalogRecord | null> {
    const call = callRpc();
    if (!call) return null;
    try {
      const reply = recordSchema.parse(await call({ pluginId:ENV_CATALOG_PLUGIN, method:"env_get_value", input:{ name }, outputSchema:recordSchema }));
      const out:CatalogRecord = { name:reply.name, kind:reply.kind, value:reply.value, access:reply.access ?? null };
      registerSecrets(secretStrings(out));
      return out;
    } catch { return null; }
  }

  /** Names only, no value read: what a declared list lacks. Used by the lint and by a waiting task's poll. */
  async function check(input:{ declared:readonly string[]; allowed:readonly string[]; kinds?:readonly CredentialKind[] }, options:{ fresh?:boolean } = {}):Promise<SecretCheck & { catalog:CatalogEntry[] | null }> {
    const declared = [...new Set(input.declared)];
    const result:SecretCheck & { catalog:CatalogEntry[] | null } = { missing:[], denied:[], wrongKind:[], unavailable:false, catalog:null };
    if (!declared.length) return result;
    const catalog = await list(options);
    if (!catalog) return { ...result, unavailable:true, missing:declared.filter((name) => isAllowed(input.allowed, name)), denied:declared.filter((name) => !isAllowed(input.allowed, name)) };
    result.catalog = catalog;
    for (const name of declared) {
      if (!isAllowed(input.allowed, name)) { result.denied.push(name); continue; }
      const entry = catalog.find((row) => row.name === name);
      if (!entry) result.missing.push(name);
      else if (!(input.kinds ?? ["secret", "login"]).includes(entry.kind)) result.wrongKind.push(name);
    }
    return result;
  }

  /** Only what the contract declares and the list leaves open is fetched; a name outside both is never read. */
  async function resolve(input:{ declared:readonly string[]; allowed:readonly string[] }):Promise<SecretResolution> {
    const checked = await check(input, { fresh:true });
    const result:SecretResolution = { env:{}, byName:{}, missing:checked.missing, denied:checked.denied, wrongKind:checked.wrongKind, unavailable:checked.unavailable };
    for (const name of [...new Set(input.declared)]) {
      if (result.denied.includes(name) || result.missing.includes(name) || result.wrongKind.includes(name)) continue;
      const found = await record(name);
      const env = found ? envForRecord(found) : null;
      if (!env) { result.missing.push(name); continue; }
      result.byName[name] = Object.fromEntries(Object.entries(env).filter(([key]) => !SANDBOX_OWN_ENV.has(key)));
      Object.assign(result.env, result.byName[name]);
    }
    return result;
  }

  return { list, record, check, resolve };
}

export type Secrets = ReturnType<typeof createSecrets>;
