import { getActivation, listSettingRows, type LanePilotDatabase } from "../database";
import { validateSettingValue } from "../setting-validation";
import type { OwnerAsk } from "./owner-ask";

/**
 * Settings that decide what a Lane Pilot agent may reach or run: which secrets a check may take, how the check sandbox is
 * built, and the command the integration gate runs on the host. Only the owner changes them (audit 2026-10-08 r2, N3). The
 * per-role access rows (`helper.access.*`) and the helper plugin/MCP lists are not here: the access tab saves on every
 * toggle, and a form per toggle would make it unusable; the guard keeps agents' shell from the RPC instead. The RPC cannot tell the
 * settings screen from `bb plugin rpc call` run by an agent's shell, so a change to one of them needs the owner's yes in a
 * form in the PM chat, and then lasts for that one value only.
 */
export const PROTECTED_SETTING_KEYS: ReadonlySet<string> = new Set([
  "secrets.allow", "verification.sandbox_unsafe", "sandbox.backend", "integration.gate_command",
]);
const PROTECTED_PREFIXES = ["secrets."] as const;

export const isProtectedSetting = (key: string): boolean => PROTECTED_SETTING_KEYS.has(key) || PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix));

/** How long the owner's yes lasts for the value it was given to. */
export const APPROVAL_TTL_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 60 * 60_000;
const REASK_AFTER_MS = 60 * 60_000;

/** The chat a form to the owner opens in: the project's PM chat, or for the global page the most recent one. */
export function pmThreadFor(db: LanePilotDatabase, projectId: string): string | undefined {
  const own = getActivation(db, projectId)?.pm_thread_id;
  if (own) return own;
  return (db.prepare("SELECT pm_thread_id FROM lane_pilot_activation ORDER BY rowid DESC LIMIT 1").get() as { pm_thread_id: string } | undefined)?.pm_thread_id;
}

export type ProtectedChange = { key: string; /** undefined: the key is reset (its row dropped). */ value?: unknown; reset?: boolean };
export type ProtectedVerdict = { ok: true } | { ok: false; key: string; message: string };

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export function createProtectedSettings(deps: { db: LanePilotDatabase; ownerAsk: OwnerAsk | undefined; log: (message: string) => void }) {
  const approved = new Map<string, number>();
  const open = new Map<string, number>();
  const quietUntil = new Map<string, number>();

  const threadFor = (projectId: string) => pmThreadFor(deps.db, projectId);

  const idOf = (projectId: string, bindingId: string, change: ProtectedChange) =>
    `${projectId}|${bindingId}|${change.key}|${change.reset ? "<reset>" : JSON.stringify(change.value ?? null)}`;

  /**
   * Passes unprotected keys, unchanged values and values the owner just approved (each approval is spent by the change it
   * covers). A protected change without an approval is refused and, once an hour per value, put to the owner.
   */
  function check(input: { projectId: string; bindingId: string; changes: readonly ProtectedChange[] }, now = Date.now()): ProtectedVerdict {
    const rows = new Map(listSettingRows(deps.db, input.projectId, input.bindingId).map((row) => [row.key, row.value]));
    // A value the setting would refuse anyway is not put to the owner: the save answers with its own validation.
    const pending = input.changes.filter((change) => isProtectedSetting(change.key)
      && !(change.reset ? !rows.has(change.key) : same(rows.get(change.key), change.value) || validateSettingValue(change.key, change.value)));
    const waiting: ProtectedChange[] = [];
    const spend: string[] = [];
    for (const change of pending) {
      const id = idOf(input.projectId, input.bindingId, change);
      if ((approved.get(id) ?? 0) > now) spend.push(id);
      else waiting.push(change);
    }
    if (!waiting.length) { for (const id of spend) approved.delete(id); return { ok: true }; }
    const first = waiting[0]!;
    const id = idOf(input.projectId, input.bindingId, first);
    const message = ask(input.projectId, input.bindingId, waiting, id, now);
    return { ok: false, key: first.key, message };
  }

  function ask(projectId: string, bindingId: string, changes: readonly ProtectedChange[], id: string, now: number): string {
    const keys = changes.map((change) => change.key).join(", ");
    const head = `Changing ${keys} needs the owner's confirmation (it decides what agents may reach).`;
    if ((open.get(id) ?? -Infinity) + ASK_TIMEOUT_MS + 60_000 > now) return `${head} A question is open in the PM chat; answer it there, then save again.`;
    if ((quietUntil.get(id) ?? 0) > now) return `${head} The owner declined this value a short while ago; do not try to work around it.`;
    const threadId = threadFor(projectId);
    if (!threadId || !deps.ownerAsk) return `${head} No PM chat is open to ask in: open the project's PM chat in BB, then save again.`;
    const shown = changes.map((change) => change.reset ? `${change.key}: reset` : `${change.key} = ${JSON.stringify(change.value ?? null).slice(0, 300)}`).join("\n");
    open.set(id, now);
    void deps.ownerAsk.askInBackground(threadId, {
      source: "secret",
      question: `Allow this change to ${projectId === "*" ? "the global" : "the project"} settings${bindingId ? " (a section)" : ""}?`,
      detail: [shown, "", "These settings decide what agents may reach or run. If you did not make this change yourself (an agent asked through the command line), say no.",
        `A yes is for this value only and lasts ${APPROVAL_TTL_MS / 60_000} minutes: save it again in the settings.`].join("\n"),
      options: ["Allow this change", "Do not allow"],
      allowText: false,
    }, (answer) => {
      open.delete(id);
      const yes = answer.outcome === "answered" && answer.choice?.id === "1";
      if (yes) {
        for (const change of changes) approved.set(idOf(projectId, bindingId, change), Date.now() + APPROVAL_TTL_MS);
        deps.log(`Lane Pilot: the owner allowed a change of ${keys} (project ${projectId})`);
      } else quietUntil.set(id, Date.now() + REASK_AFTER_MS);
    }, { timeoutMs: ASK_TIMEOUT_MS }).then((shownForm) => {
      if (!shownForm) open.delete(id);
    }).catch(() => open.delete(id));
    return `${head} The owner was asked in the PM chat; once they allow it, save again.`;
  }

  return { check };
}

export type ProtectedSettings = ReturnType<typeof createProtectedSettings>;
