/**
 * SkillOpt's buffer of refused edits. A retired harness tree is one row: its fingerprint, why it was refused, and a
 * one-line summary. The editor reads the buffer; an identical fingerprint is dropped before it can go on trial again.
 */
export type RejectedEdit = { fingerprint: string; reason: string; summary: string };

export function screenRejected(fingerprint: string, rejected: readonly RejectedEdit[]): { blocked: boolean; reason: string } {
  const hit = rejected.find((row) => row.fingerprint === fingerprint && row.reason.trim());
  if (!hit) return { blocked: false, reason: "" };
  return { blocked: true, reason: hit.reason.trim() };
}

/** The block appended to an editor's mission. Empty when nothing was refused. */
export function rejectedPrompt(rejected: readonly RejectedEdit[]): string {
  const rows = rejected.filter((row) => row.reason.trim());
  if (!rows.length) return "";
  return [
    "# REJECTED EDITS",
    "",
    "Do not re-propose an edit listed here. The same fingerprint is dropped if you do. Propose it again only when the attempts in front of you are new evidence that the reason no longer holds.",
    "",
    ...rows.map((row) => `- \`${row.fingerprint}\` ${row.summary ? `(${row.summary}) ` : ""}${row.reason.trim()}`),
  ].join("\n");
}
