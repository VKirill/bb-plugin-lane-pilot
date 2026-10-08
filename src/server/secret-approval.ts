import { saveProjectSetting, type LanePilotDatabase } from "../database";
import { parseSandboxUnsafePatterns } from "../stages/critique-coverage";
import type { OwnerAsk } from "./owner-ask";
import { NET_PREFIX, SECRETS_ALLOW_KEY, isNetEntry } from "./secrets";

const ASK_TIMEOUT_MS = 60 * 60_000;
/** After a «no», a dismissed form or silence, the same question is not put again for this long. */
const REASK_AFTER_MS = 60 * 60_000;

export type ApprovalRequest = {
  projectId: string;
  /** The PM chat the form opens in; without one nothing can be asked. */
  pmThreadId: string | undefined;
  /** Env Catalog names and `net:host` entries the owner has not allowed yet. */
  entries: readonly string[];
  /** What wants them, in the owner's words: «check `npm run e2e` of task T-3», «errand», «browser check». */
  use: string;
};
/** asked: a form is open (or just opened); declined: the owner said no a short while ago; unavailable: no form could be shown. */
export type ApprovalState = "asked" | "declined" | "unavailable";

/**
 * Secrets are allowed per project by the owner and never by default (audit 2026-10-08, S1): the first time a check, a
 * browser check or an errand names an Env Catalog entry (or a host a check with secrets wants to reach), the owner is asked
 * once in the PM chat, a form that also reaches the phone. A yes is stored in the project setting `secrets.allow`, which
 * the waiting task sees on its next look; a no or silence keeps it waiting, and the question is put again after an hour.
 */
export function createSecretApproval(deps: { db: LanePilotDatabase; ownerAsk: OwnerAsk | undefined; log: (message: string) => void }) {
  /** Forms shown and not yet settled, with when; one a chat lost without an answer (stopped, reloaded) is forgotten after its timeout. */
  const open = new Map<string, number>();
  const quietUntil = new Map<string, number>();

  /** Adds the entries to the project's own `secrets.allow` (not to a section's or the global one). */
  function allow(projectId: string, entries: readonly string[]): void {
    const row = deps.db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?").get(projectId, SECRETS_ALLOW_KEY) as { value: string } | undefined;
    let stored: unknown = "";
    if (row) { try { stored = JSON.parse(row.value); } catch { stored = row.value; } }
    const next = [...new Set([...parseSandboxUnsafePatterns(stored), ...entries])];
    saveProjectSetting(deps.db, projectId, SECRETS_ALLOW_KEY, next.join(", "));
    deps.log(`Lane Pilot: the owner allowed ${entries.join(", ")} for project ${projectId} (secrets.allow)`);
  }

  async function request(input: ApprovalRequest, now = Date.now()): Promise<ApprovalState> {
    const entries = [...new Set(input.entries)].sort();
    if (!entries.length || !input.pmThreadId || !deps.ownerAsk) return "unavailable";
    const key = `${input.projectId}|${entries.join(",")}`;
    if (now - (open.get(key) ?? -Infinity) < ASK_TIMEOUT_MS + 60_000) return "asked";
    if ((quietUntil.get(key) ?? 0) > now) return "declined";
    const names = entries.filter((entry) => !isNetEntry(entry));
    const hosts = entries.filter(isNetEntry).map((entry) => entry.slice(NET_PREFIX.length));
    const question = `Allow ${input.use} to ${[names.length ? `use the secret ${names.join(", ")}` : "", hosts.length ? `reach ${hosts.join(", ")}` : ""].filter(Boolean).join(" and ")}?`;
    const detail = [
      "The value goes into that check's sandbox as an environment variable only; the writer never sees it and it is masked in every output.",
      "While a check holds a secret its network is limited to localhost and the hosts you approve.",
      "A yes is saved for this project (setting «Secrets checks may use»); the task starts by itself. Without an answer it keeps waiting.",
    ].join("\n");
    open.set(key, now);
    const pmThreadId = input.pmThreadId;
    const shown = await deps.ownerAsk.askInBackground(pmThreadId, { source: "secret", question, detail, options: ["Allow for this project", "Do not allow"], allowText: false }, async (answer) => {
      open.delete(key);
      const yes = answer.outcome === "answered" && answer.choice?.id === "1";
      if (yes) allow(input.projectId, entries);
      else quietUntil.set(key, Date.now() + REASK_AFTER_MS);
      await deps.ownerAsk!.sendToThread(pmThreadId, yes
        ? `Lane Pilot: the owner allowed ${entries.join(", ")} for this project; the tasks waiting for it start by themselves.`
        : `Lane Pilot: the owner did not allow ${entries.join(", ")}; the tasks waiting for it keep waiting (asked again in an hour). Do not try to work around it.`);
    }, { timeoutMs: ASK_TIMEOUT_MS }).catch(() => false);
    if (!shown) { open.delete(key); return "unavailable"; }
    return "asked";
  }

  return { request, allow };
}

export type SecretApproval = ReturnType<typeof createSecretApproval>;
