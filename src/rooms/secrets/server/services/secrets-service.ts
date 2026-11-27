import { z } from "zod";
import { registerSecrets, secretStrings } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SANDBOX_OWN_ENV } from "../../../contracts";
import {
  ENV_CATALOG_PLUGIN,
  envForRecord,
  isSecretAllowed,
  type CatalogEntry,
  type CatalogRecord,
  type CredentialKind,
  type SecretCheck,
  type SecretResolution,
} from "../../models";

type CallRpc = (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown> }) => Promise<unknown>;

const listSchema = z.object({ variables: z.array(z.object({ name: z.string(), kind: z.enum(["secret", "ftp", "ssh", "login"]).catch("secret") }).passthrough()) }).passthrough();
const saveSchema = z.object({ success: z.boolean() }).passthrough();
const recordSchema = z.object({
  name: z.string(), kind: z.enum(["secret", "ftp", "ssh", "login"]).catch("secret"),
  value: z.string().nullable(), access: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();

/**
 * Lane Pilot's one door to Env Catalog (J2/J4). Values are fetched per use and never kept; each value handed out is also
 * registered with the masking in redact.ts, so nothing a run prints with it reaches a log, a receipt or the PM.
 */
export function createSecrets(deps: { bb: BbPluginApi; now?: () => number }) {
  const now = deps.now ?? (() => Date.now());
  const callRpc = (): CallRpc | undefined => {
    const plugins = (deps.bb.sdk as { plugins?: { callRpc?: CallRpc } }).plugins;
    return plugins?.callRpc ? (args) => plugins.callRpc!(args) : undefined;
  };
  let cached: { at: number; entries: CatalogEntry[] | null } | null = null;
  let pending: Promise<CatalogEntry[] | null> | null = null;

  /** The catalog's names and kinds, or null when Env Catalog cannot be asked (feature test: not installed, disabled, erroring). */
  async function list(options: { fresh?: boolean } = {}): Promise<CatalogEntry[] | null> {
    if (!options.fresh && cached && now() - cached.at < 5_000) return cached.entries;
    if (pending) return await pending;
    const call = callRpc();
    pending = (async () => {
      let entries: CatalogEntry[] | null = null;
      if (call) {
        try {
          const reply = listSchema.parse(await call({ pluginId: ENV_CATALOG_PLUGIN, method: "env_list", input: {}, outputSchema: listSchema }));
          entries = reply.variables.map((row) => ({ name: row.name, kind: row.kind }));
        } catch { entries = null; }
      }
      cached = { at: now(), entries };
      return entries;
    })().finally(() => { pending = null; });
    return await pending;
  }

  async function record(name: string): Promise<CatalogRecord | null> {
    const call = callRpc();
    if (!call) return null;
    try {
      const reply = recordSchema.parse(await call({ pluginId: ENV_CATALOG_PLUGIN, method: "env_get_value", input: { name }, outputSchema: recordSchema }));
      const out: CatalogRecord = { name: reply.name, kind: reply.kind, value: reply.value, access: reply.access ?? null };
      registerSecrets(secretStrings(out));
      return out;
    } catch { return null; }
  }

  /** Names only, no value read: what a declared list lacks. Used by the lint and by a waiting task's poll. */
  async function check(input: { declared: readonly string[]; allowed: readonly string[]; kinds?: readonly CredentialKind[] }, options: { fresh?: boolean } = {}): Promise<SecretCheck & { catalog: CatalogEntry[] | null }> {
    const declared = [...new Set(input.declared)];
    const result: SecretCheck & { catalog: CatalogEntry[] | null } = { missing: [], denied: [], wrongKind: [], unavailable: false, catalog: null };
    if (!declared.length) return result;
    const catalog = await list(options);
    if (!catalog) return { ...result, unavailable: true, missing: declared.filter((name) => isSecretAllowed(input.allowed, name)), denied: declared.filter((name) => !isSecretAllowed(input.allowed, name)) };
    result.catalog = catalog;
    for (const name of declared) {
      if (!isSecretAllowed(input.allowed, name)) { result.denied.push(name); continue; }
      const entry = catalog.find((row) => row.name === name);
      if (!entry) result.missing.push(name);
      else if (!(input.kinds ?? ["secret", "login"]).includes(entry.kind)) result.wrongKind.push(name);
    }
    return result;
  }

  /** Only what the contract declares and the list leaves open is fetched; a name outside both is never read. */
  async function resolve(input: { declared: readonly string[]; allowed: readonly string[] }): Promise<SecretResolution> {
    const checked = await check(input, { fresh: true });
    const result: SecretResolution = { env: {}, byName: {}, missing: checked.missing, denied: checked.denied, wrongKind: checked.wrongKind, unavailable: checked.unavailable };
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

  /** Saves one secret under its name (Env Catalog `env_save`); the value is registered for masking and never returned. Throws when the catalog refuses or cannot be asked. */
  async function save(name: string, value: string, note: { service?: string; description?: string } = {}): Promise<void> {
    const call = callRpc();
    if (!call) throw new Error("Env Catalog is not available (not installed or disabled)");
    registerSecrets([value]);
    const reply = saveSchema.parse(await call({ pluginId: ENV_CATALOG_PLUGIN, method: "env_save", input: { name, kind: "secret", value, ...note }, outputSchema: saveSchema }));
    if (!reply.success) throw new Error("Env Catalog did not save the key");
    cached = null;
  }

  return { list, record, check, resolve, save };
}
