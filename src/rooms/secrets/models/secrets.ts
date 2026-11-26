import { parseSandboxUnsafePatterns } from "../../contracts";
import { SECRETS_ALLOW_KEY } from "../settings";

export { SECRETS_ALLOW_KEY };
export const ENV_CATALOG_PLUGIN = "env-catalog";
export type CredentialKind = "secret" | "ftp" | "ssh" | "login";
export type CatalogEntry = { name: string; kind: CredentialKind };
export type CatalogRecord = { name: string; kind: CredentialKind; value: string | null; access: Record<string, unknown> | null };

/**
 * The names the project's list leaves open; the settings a run sees are passed in. Empty means every name the task contract
 * declares: the list only narrows (owner decision 2026-10-08, no per-name owner form). `*` allows any name.
 */
export const allowedSecretNames = (settings: Record<string, unknown>): string[] => parseSandboxUnsafePatterns(settings[SECRETS_ALLOW_KEY]);
export const isSecretAllowed = (allowed: readonly string[], name: string): boolean => allowed.length === 0 || allowed.includes("*") || allowed.includes(name);

/** Env variables a check gets for one catalog record: a secret under its own name, a login as NAME_USERNAME / NAME_PASSWORD / NAME_URL. */
export function envForRecord(record: CatalogRecord): Record<string, string> | null {
  if (record.kind === "secret") return record.value ? { [record.name]: record.value } : null;
  if (record.kind === "login" && record.access) {
    const field = (key: string) => typeof record.access![key] === "string" ? record.access![key] as string : "";
    const out: Record<string, string> = {};
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
  missing: string[];
  /** Declared names the project's `secrets.allow` list leaves out. */
  denied: string[];
  /** Declared names of a kind a check cannot take (ssh, ftp: those are for a PM's deploy errand). */
  wrongKind: string[];
  /** Env Catalog could not be asked at all (not installed, disabled, or erroring). */
  unavailable: boolean;
};
export type SecretResolution = SecretCheck & {
  /** Variables for the sandbox, by variable name. */
  env: Record<string, string>;
  /** The variables each declared name expands to (a login gives three), so one check gets only its own. */
  byName: Record<string, Record<string, string>>;
};

/** The reason a task carries while it waits for a secret; failure-class.ts reads the same prefix. */
export const WAITING_SECRET_PREFIX = "waiting_secret:";
export const waitingSecretReason = (names: readonly string[]): string => `${WAITING_SECRET_PREFIX}${[...new Set(names)].join(",")}`;

/** What the PM does about each kind of missing access; one message per task while it waits. */
export function secretFixLines(check: SecretCheck): string[] {
  const lines: string[] = [];
  if (check.unavailable) lines.push("Env Catalog is not answering (not installed, disabled or restarting); the task starts by itself once it answers.");
  if (check.denied.length) lines.push(`${check.denied.join(", ")}: the project list «Secrets checks may use» (secrets.allow) is not empty and leaves it out. Add the name to that list (or empty the list: then every name a task contract declares is allowed); the task starts by itself.`);
  if (check.missing.length && !check.unavailable) lines.push(`${check.missing.join(", ")}: not in Env Catalog. Call env_request for it now (name, the kind, a purpose) so the owner gets a form on the phone; do not ask for the value in chat.`);
  if (check.wrongKind.length) lines.push(`${check.wrongKind.join(", ")}: not of a kind this step can take (a check takes a secret or a login, a browser case a login; SSH and FTP access is for lane_pilot_errand).`);
  return lines;
}

export function waitingSecretNote(taskId: string, check: SecretCheck): string {
  return `Lane Pilot: ${taskId} waits for access its checks declare, no attempt is spent, and it starts by itself once that is in place.\n${secretFixLines(check).map((line) => `- ${line}`).join("\n")}`;
}

/** A check's declared secrets cannot be handed out now (the catalog lost one, the allow list leaves it out). */
export class SecretsNotReadyError extends Error {
  constructor(readonly names: string[]) { super(waitingSecretReason(names)); this.name = "SecretsNotReadyError"; }
}

/** What stops a declared name from being handed out, in the order the PM should fix it; empty when nothing does. */
export const secretProblem = (check: SecretCheck): string[] => [...check.denied, ...check.missing, ...check.wrongKind];
